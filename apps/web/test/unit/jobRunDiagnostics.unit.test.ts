import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { JOB_FILE_NAMES, jobCreateIntentSchema } from "@jobs/intent";
import {
  RUN_DIAGNOSTICS_DEFAULT,
  SWEEP_CONFIRMATION_NOTICE,
  SWEEP_UNCONFIRMED_PROBLEM,
  isSweepRetainRefusal,
  runDiagnosticsIntentFields,
  runDiagnosticsProblems,
  sweepRetainRefusalMessage,
} from "@bench/runDiagnosticsModel";
import { resolveWorkdirFile } from "@jobs/workdir";

import {
  captureExchangeArgv,
  captureZeroSetupArgv,
  tempDataRoot,
  validIntent,
} from "../utils/jobFixtures";

const dirs: Array<string> = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

function scratchDir(label: string): string {
  const dir = tempDataRoot(label);
  fs.mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

// The two per-run controls are the whole channel from the console into a CLI
// diagnostic or recovery run, so what they emit -- and what they refuse to emit
// -- is pinned here rather than left to the card's rendering.
describe("the run-diagnostics draft's intent fields", () => {
  test("a default draft contributes nothing, so an ordinary run's intent is unchanged", () => {
    expect(runDiagnosticsIntentFields(RUN_DIAGNOSTICS_DEFAULT)).toEqual({});
  });

  test("a diagnostic run contributes only its own flag", () => {
    expect(
      runDiagnosticsIntentFields({
        ...RUN_DIAGNOSTICS_DEFAULT,
        diagnosticRun: true,
      }),
    ).toEqual({ diagnosticRun: true });
  });

  test("an unconfirmed sweep contributes no sweep at all, not merely a form problem", () => {
    const draft = {
      ...RUN_DIAGNOSTICS_DEFAULT,
      sweepExchangeFiles: true,
      sweepConfirmed: false,
    };
    expect(runDiagnosticsIntentFields(draft)).toEqual({});
    expect(runDiagnosticsProblems(draft)).toEqual([SWEEP_UNCONFIRMED_PROBLEM]);
  });

  test("a confirmed sweep contributes the sweep and clears the problem", () => {
    const draft = {
      ...RUN_DIAGNOSTICS_DEFAULT,
      sweepExchangeFiles: true,
      sweepConfirmed: true,
    };
    expect(runDiagnosticsIntentFields(draft)).toEqual({
      sweepExchangeFiles: true,
    });
    expect(runDiagnosticsProblems(draft)).toEqual([]);
  });

  test("the confirmation states the concurrent-session condition the CLI reference states", () => {
    expect(SWEEP_CONFIRMATION_NOTICE).toContain("no other session is using");
  });

  test("both fields are admitted by the create intent's own schema", () => {
    const parsed = jobCreateIntentSchema.safeParse({
      ...validIntent(),
      diagnosticRun: true,
      sweepExchangeFiles: true,
    });
    expect(parsed.success).toBe(true);
  });

  test("the escalation past the retain guard is not representable on the intent", () => {
    const parsed = jobCreateIntentSchema.safeParse({
      ...validIntent(),
      sweepExchangeFiles: true,
      forceRetainSweep: true,
    });
    expect(parsed.success).toBe(false);
  });
});

// The argv is captured off a real spawned child rather than compared with a
// hand-written list, so what is asserted is what the driver actually invoked.
describe("the argv a diagnostic or sweeping run drives", () => {
  test("an ordinary exchange run carries no log or sweep token", async () => {
    const dir = scratchDir("diag-plain");
    const argv = await captureExchangeArgv({ workdir: dir, eventStream: true });
    expect(argv.some((token) => token.startsWith("--log-"))).toBe(false);
    expect(argv).not.toContain("--verbose");
    expect(argv).not.toContain("--sweep-exchange-files");
  });

  test("a diagnostic exchange run raises the level, adds the sub-library verbosity, and names the log file", async () => {
    const dir = scratchDir("diag-exchange");
    const logFilePath = path.join(dir, JOB_FILE_NAMES.log);
    const argv = await captureExchangeArgv({
      workdir: dir,
      eventStream: true,
      runControls: { sweepExchangeFiles: false, logFilePath },
    });
    expect(argv).toContain("--log-level=debug");
    expect(argv).toContain("--verbose");
    expect(argv).toContain(`--log-file=${logFilePath}`);
    // The controls land before the trailing positionals, so the input and output
    // paths stay where the CLI reads them.
    expect(argv[argv.length - 2].endsWith("input.csv")).toBe(true);
    expect(argv[argv.length - 1].endsWith("output.csv")).toBe(true);
  });

  test("a sweeping exchange run passes the CLI's flag and never its escalation", async () => {
    const dir = scratchDir("diag-sweep");
    const argv = await captureExchangeArgv({
      workdir: dir,
      eventStream: true,
      runControls: { sweepExchangeFiles: true, logFilePath: undefined },
    });
    expect(argv).toContain("--sweep-exchange-files");
    expect(argv).not.toContain("--force-retain-sweep");
  });

  test("a zero-setup run carries the same controls", async () => {
    const dir = scratchDir("diag-zero");
    const logFilePath = path.join(dir, JOB_FILE_NAMES.log);
    const argv = await captureZeroSetupArgv({
      workdir: dir,
      connectionArgs: ["file:///srv/jobs/abc/rendezvous"],
      eventStream: true,
      runControls: { sweepExchangeFiles: true, logFilePath },
    });
    expect(argv).toContain("--sweep-exchange-files");
    expect(argv).toContain(`--log-file=${logFilePath}`);
    expect(argv).not.toContain("--force-retain-sweep");
  });
});

// The log is the one artifact whose name reaches a serving route, so its
// resolution is held to the same containment rule the workdir itself is.
describe("the diagnostic log's path stays inside the job workdir", () => {
  test("the fixed log name resolves to a file directly under the workdir", () => {
    const workdir = "/srv/jobs/93b1c0d6";
    expect(resolveWorkdirFile(workdir, JOB_FILE_NAMES.log)).toBe(
      path.resolve(workdir, JOB_FILE_NAMES.log),
    );
  });

  test("the log name is a single segment, so it cannot resolve anywhere else", () => {
    expect(JOB_FILE_NAMES.log).toBe(path.basename(JOB_FILE_NAMES.log));
    expect(JOB_FILE_NAMES.log.includes("/")).toBe(false);
    expect(JOB_FILE_NAMES.log.includes("\\")).toBe(false);
  });

  test("a name that escapes the workdir is refused rather than resolved", () => {
    const workdir = "/srv/jobs/93b1c0d6";
    for (const escape of [
      "../run.log",
      "../../etc/passwd",
      "sub/../../run.log",
      "/etc/passwd",
    ])
      expect(resolveWorkdirFile(workdir, escape)).toBeNull();
  });

  test("a sibling directory sharing the workdir's prefix is not inside it", () => {
    expect(
      resolveWorkdirFile("/srv/jobs/abc", "../abc-evil/run.log"),
    ).toBeNull();
  });
});

// The console offers the safe sweep and explains the escalation; it never
// performs one. The guidance is what carries that explanation, so it is pinned
// against the CLI's own refusal text.
describe("the retain-guard refusal surfaces as guidance", () => {
  // The wording core composes when a sweep meets a retain-mode signal. Held here
  // as the text the seat must recognize; a core rewording turns the match off,
  // which leaves the CLI's own message standing on its own.
  const cliRefusal =
    "path /srv/rendezvous shows a retain-mode signal (this party is in " +
    "retain mode), so --sweep-exchange-files refuses to delete what may be a " +
    "durable audit transcript. Re-run with --force-retain-sweep to wipe the " +
    "prior transcript and start a fresh exchange, after confirming no " +
    "concurrent session is using this path.";

  test("the refusal is recognized", () => {
    expect(isSweepRetainRefusal(cliRefusal)).toBe(true);
  });

  test("an ordinary transport failure is not", () => {
    expect(
      isSweepRetainRefusal("the partner never appeared in the shared folder"),
    ).toBe(false);
  });

  test("the guidance names the command-line escalation and keeps the CLI's own message", () => {
    const message = sweepRetainRefusalMessage(cliRefusal);
    expect(message).toContain("--force-retain-sweep");
    expect(message).toContain("command line");
    expect(message).toContain(cliRefusal);
  });

  test("the guidance states the same concurrent-session condition the confirmation does", () => {
    expect(sweepRetainRefusalMessage(cliRefusal)).toContain(
      "no other session is using",
    );
  });
});
