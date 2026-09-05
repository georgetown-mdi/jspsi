import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  DIAGNOSTIC_LOG_UNANSWERED_LEAD,
  DIAGNOSTIC_LOG_UNANSWERED_NOTICE,
} from "@bench/DiagnosticLogPanel";
import { JOB_FILE_NAMES, jobCreateIntentSchema } from "@jobs/intent";
import {
  LOG_AVAILABILITY_UNANSWERED_LIMIT,
  watchJobDiagnosticLog,
} from "@psi/jobDiagnosticLog";
import {
  RUN_DIAGNOSTICS_DEFAULT,
  SWEEP_CONFIRMATION_NOTICE,
  SWEEP_RETAIN_ESCALATION_NOTICE,
  SWEEP_UNCONFIRMED_PROBLEM,
  runDiagnosticsAfterRetarget,
  runDiagnosticsIntentFields,
  runDiagnosticsProblems,
  runDiagnosticsWithControl,
} from "@psi/runDiagnosticsModel";
import { RelayedTerminalError } from "@psi/serverJobExchangeDriver";
import { failureFor } from "@bench/useInviterExchange";
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

// The draft belongs to the whole form and outlives any one visit to the card,
// and the directory a sweep would run against can be re-targeted between those
// visits -- so how long a confirmation lasts is pinned here rather than left to
// the card's rendering.
describe("the sweep confirmation's lifetime", () => {
  test("check, confirm, uncheck, re-check leaves the sweep unattested and blocked", () => {
    const checked = runDiagnosticsWithControl(
      RUN_DIAGNOSTICS_DEFAULT,
      "sweepExchangeFiles",
      true,
    );
    const confirmed = runDiagnosticsWithControl(
      checked,
      "sweepConfirmed",
      true,
    );
    expect(runDiagnosticsIntentFields(confirmed)).toEqual({
      sweepExchangeFiles: true,
    });

    const unchecked = runDiagnosticsWithControl(
      confirmed,
      "sweepExchangeFiles",
      false,
    );
    expect(unchecked.sweepConfirmed).toBe(false);

    // Turning it back on is a fresh request for a destructive action, not a
    // return to the confirmed state: it emits no sweep and the run is gated
    // until the operator attests to this directory.
    const rechecked = runDiagnosticsWithControl(
      unchecked,
      "sweepExchangeFiles",
      true,
    );
    expect(rechecked.sweepConfirmed).toBe(false);
    expect(runDiagnosticsIntentFields(rechecked)).toEqual({});
    expect(runDiagnosticsProblems(rechecked)).toEqual([
      SWEEP_UNCONFIRMED_PROBLEM,
    ]);
  });

  test("a re-target of the directory it attested un-confirms it", () => {
    // The confirmation is about ONE directory. Switching transport, or authoring
    // the SFTP connection afresh, points the run somewhere else, and the sweep
    // is destructive in the folder it lands in -- so it is gated until the
    // operator attests to the new one.
    const confirmed = {
      ...RUN_DIAGNOSTICS_DEFAULT,
      diagnosticRun: true,
      sweepExchangeFiles: true,
      sweepConfirmed: true,
    };
    const retargeted = runDiagnosticsAfterRetarget(confirmed);

    expect(runDiagnosticsIntentFields(retargeted)).toEqual({
      diagnosticRun: true,
    });
    expect(runDiagnosticsProblems(retargeted)).toEqual([
      SWEEP_UNCONFIRMED_PROBLEM,
    ]);
    // Only the attestation lapses: the run's own choices are about the run, not
    // the place, and the operator does not re-make them.
    expect(retargeted.diagnosticRun).toBe(true);
    expect(retargeted.sweepExchangeFiles).toBe(true);

    // Re-attesting arms it again, so the reset is a gate rather than a dead end.
    expect(
      runDiagnosticsIntentFields(
        runDiagnosticsWithControl(retargeted, "sweepConfirmed", true),
      ),
    ).toEqual({ diagnosticRun: true, sweepExchangeFiles: true });
  });

  test("a confirmed sweep is undisturbed by the other control", () => {
    const confirmed = {
      ...RUN_DIAGNOSTICS_DEFAULT,
      sweepExchangeFiles: true,
      sweepConfirmed: true,
    };
    expect(runDiagnosticsWithControl(confirmed, "diagnosticRun", true)).toEqual(
      {
        diagnosticRun: true,
        sweepExchangeFiles: true,
        sweepConfirmed: true,
      },
    );
  });
});

// The argv is captured off a real spawned child rather than compared with a
// hand-written list, so what is asserted is what the driver actually invoked.
describe("the argv a diagnostic or sweeping run drives", () => {
  test("an ordinary exchange run has no log or sweep token", async () => {
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

  test("a zero-setup run includes the same controls", async () => {
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

// The console yields a job id as soon as the CLI child spawns and the child
// opens its log after that, so what a seat can offer during a run rests on
// asking the console again rather than on the answer the first ask raced --
// and on what it does when those asks stop being answered at all, which is the
// state the operator watching a stalled run is left in.
describe("the diagnostic log's availability during a run", () => {
  /** The console's own status body, for a run that asked for a log unless the
   * caller says otherwise. */
  const answered =
    (logAvailable: boolean, logRequested = true) =>
    () =>
      new Response(
        JSON.stringify({ status: "running", logRequested, logAvailable }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

  /** An ask that returns no answer about the log: the route erroring, which is
   * also how a job the console forgot across a restart reads. */
  const unanswerable = () => new Response("", { status: 503 });

  /** A 200 that is not this endpoint's status body -- a proxy's interstitial, or
   * a console answering for something else -- which says no more about the
   * log than an error does. */
  const notTheStatusBody = () =>
    new Response(JSON.stringify({ status: "running" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  /** A status endpoint answering each successive ask with the next entry of the
   * script, holding the last once it runs out, and counting what it was asked. */
  function scriptedFetch(script: Array<() => Response>): {
    fetchImpl: typeof fetch;
    asks: () => number;
  } {
    let asked = 0;
    const fetchImpl: typeof fetch = () => {
      const answer = script[Math.min(asked, script.length - 1)];
      asked += 1;
      return Promise.resolve(answer());
    };
    return { fetchImpl, asks: () => asked };
  }

  /** The watch's gap between asks, recorded and not waited through, so a test
   * still sees that the watch paced itself. */
  const recordWaits =
    (waits: Array<number>) =>
    (ms: number): Promise<void> => {
      waits.push(ms);
      return Promise.resolve();
    };

  const noWait = () => Promise.resolve();

  test("a log that appears mid-run is readable without waiting for the run to settle", async () => {
    // The stalled run the log exists for reaches no terminal at all, so a seat
    // that only re-asked at settle would stay empty for the whole stall.
    const { fetchImpl, asks } = scriptedFetch([
      answered(false),
      answered(false),
      answered(true),
    ]);
    const waits: Array<number> = [];

    await expect(
      watchJobDiagnosticLog("job-1", new AbortController().signal, {
        fetchImpl,
        delay: recordWaits(waits),
      }),
    ).resolves.toBe("available");

    expect(asks()).toBe(3);
    // One wait between successive asks, and a real one: a watch with no gap
    // would poll the console as fast as it can answer.
    expect(waits).toHaveLength(2);
    expect(waits.every((ms) => ms > 0)).toBe(true);
  });

  test("a watch the caller stops answers no rather than asking on", async () => {
    const { fetchImpl, asks } = scriptedFetch([answered(false)]);
    const controller = new AbortController();

    await expect(
      watchJobDiagnosticLog("job-1", controller.signal, {
        fetchImpl,
        delay: () => {
          // The run settles, or the seat unmounts, while the watch is waiting.
          controller.abort();
          return Promise.resolve();
        },
      }),
    ).resolves.toBe("unavailable");

    expect(asks()).toBe(1);
  });

  test("a run that asked for no log is answered once rather than asked all run", async () => {
    // The ordinary run is the common one and its answer cannot change, so a
    // watch that kept asking would poll the console for the whole exchange to
    // be told the same thing.
    const { fetchImpl, asks } = scriptedFetch([answered(false, false)]);
    const waits: Array<number> = [];

    await expect(
      watchJobDiagnosticLog("job-1", new AbortController().signal, {
        fetchImpl,
        delay: recordWaits(waits),
      }),
    ).resolves.toBe("unavailable");

    expect(asks()).toBe(1);
    expect(waits).toEqual([]);
  });

  test("a settled run whose file never appeared is asked once, not forever", async () => {
    // Nothing about this answer will change once the child is gone, so the seat
    // stops rather than re-asking a run that ended without opening its log.
    const { fetchImpl, asks } = scriptedFetch([answered(false)]);

    await expect(
      watchJobDiagnosticLog("job-1", new AbortController().signal, {
        settled: true,
        fetchImpl,
        delay: noWait,
      }),
    ).resolves.toBe("unavailable");

    expect(asks()).toBe(1);
  });

  test("an ask the console could not answer keeps the watch going", async () => {
    // A rejected status ask says nothing about what the run requested, so
    // reading it as "no log" would end the watch on a transient failure and
    // leave the panel missing for the rest of the run.
    const { fetchImpl, asks } = scriptedFetch([unanswerable, answered(true)]);

    await expect(
      watchJobDiagnosticLog("job-1", new AbortController().signal, {
        fetchImpl,
        delay: noWait,
      }),
    ).resolves.toBe("available");

    expect(asks()).toBe(2);
  });

  test("a route that never answers stops the watch instead of asking all run", async () => {
    // A console that restarted and forgot the job answers this way for as
    // long as the seat is open, so an unbounded watch would ask until the
    // operator closed the tab and tell them nothing while it did.
    const { fetchImpl, asks } = scriptedFetch([unanswerable]);
    const waits: Array<number> = [];

    await expect(
      watchJobDiagnosticLog("job-1", new AbortController().signal, {
        fetchImpl,
        delay: recordWaits(waits),
      }),
    ).resolves.toBe("unanswered");

    expect(asks()).toBe(LOG_AVAILABILITY_UNANSWERED_LIMIT);
    expect(waits).toHaveLength(LOG_AVAILABILITY_UNANSWERED_LIMIT - 1);
    // The operator waits through the bound before the seat says anything, so it
    // is a handful of asks rather than a patient retry budget.
    expect(LOG_AVAILABILITY_UNANSWERED_LIMIT).toBeLessThanOrEqual(10);
  });

  test("a 200 that is not the status body counts against the bound like an error", async () => {
    const { fetchImpl, asks } = scriptedFetch([notTheStatusBody]);

    await expect(
      watchJobDiagnosticLog("job-1", new AbortController().signal, {
        fetchImpl,
        delay: noWait,
      }),
    ).resolves.toBe("unanswered");

    expect(asks()).toBe(LOG_AVAILABILITY_UNANSWERED_LIMIT);
  });

  test("a settled run's asks are bounded the same way", async () => {
    const { fetchImpl, asks } = scriptedFetch([unanswerable]);

    await expect(
      watchJobDiagnosticLog("job-1", new AbortController().signal, {
        settled: true,
        fetchImpl,
        delay: noWait,
      }),
    ).resolves.toBe("unanswered");

    expect(asks()).toBe(LOG_AVAILABILITY_UNANSWERED_LIMIT);
  });

  test("failures the console recovers from never accumulate into the bound", async () => {
    // The bound is on asks that fail in a row: a flaky route that keeps coming
    // back is a run the watch should still be watching, however many single
    // failures it has cost by the time the log lands.
    const nearMiss = Array.from(
      { length: LOG_AVAILABILITY_UNANSWERED_LIMIT - 1 },
      () => unanswerable,
    );
    const { fetchImpl, asks } = scriptedFetch([
      ...nearMiss,
      answered(false),
      ...nearMiss,
      answered(true),
    ]);

    await expect(
      watchJobDiagnosticLog("job-1", new AbortController().signal, {
        fetchImpl,
        delay: noWait,
      }),
    ).resolves.toBe("available");

    expect(asks()).toBe(LOG_AVAILABILITY_UNANSWERED_LIMIT * 2);
  });

  test("an already-stopped watch asks nothing at all", async () => {
    const { fetchImpl, asks } = scriptedFetch([answered(true)]);
    const controller = new AbortController();
    controller.abort();

    await expect(
      watchJobDiagnosticLog("job-1", controller.signal, {
        fetchImpl,
        delay: noWait,
      }),
    ).resolves.toBe("unavailable");

    expect(asks()).toBe(0);
  });

  test("the seat states the silence rather than promising a log", () => {
    // What the operator is owed at the bound is the fact that asking stopped --
    // an unanswered ask never said whether this run captured a log, so the seat
    // cannot claim one and must not imply the panel is still coming.
    expect(DIAGNOSTIC_LOG_UNANSWERED_LEAD).toContain("stopped answering");
    expect(DIAGNOSTIC_LOG_UNANSWERED_NOTICE).toContain("stopped asking");
    expect(DIAGNOSTIC_LOG_UNANSWERED_NOTICE).toContain("reload");
    expect(DIAGNOSTIC_LOG_UNANSWERED_NOTICE).toContain("may still be");
    expect(DIAGNOSTIC_LOG_UNANSWERED_NOTICE).not.toContain("This run recorded");
  });
});

// The console offers the safe sweep and names the escalation past the CLI's
// retain guard in fixed copy the operator's own draft brings up, so nothing a
// run says decides what the console tells them about it.
describe("the escalation is stated before the run, not composed from its failure", () => {
  test("the card names the command-line escalation and what it costs", () => {
    expect(SWEEP_RETAIN_ESCALATION_NOTICE).toContain(
      "--sweep-exchange-files --force-retain-sweep",
    );
    expect(SWEEP_RETAIN_ESCALATION_NOTICE).toContain("command line");
    expect(SWEEP_RETAIN_ESCALATION_NOTICE).toContain("permanently");
  });
});

// A rendezvous directory is partner-writable and core's foreign-file terminal
// names the offending files verbatim, so text an operator would read as
// first-party can reach a seat inside a message this console composed no part
// of. What keeps that inert is that a failure's alert is composed from the
// lifecycle's category alone: no relayed byte selects a title, and no per-run
// choice changes what a failure says.
//
// These pins exercise failureFor, the one composition point all three seats
// share, and say nothing about what a seat does with the result afterward --
// that half is covered by scripts/bench-failure-passthrough.test.mjs, which
// walks the bench tree and fails any call site that does something with the
// result besides handing it to setFailure.
describe("relayed terminal text never retitles a failure", () => {
  /** The CLI's own refusal wording, planted inside a filename an untrusted party
   * chose -- the shape no text test can tell from the real refusal. */
  const plantedTerminal =
    "the shared folder holds files this exchange does not own: " +
    "--sweep-exchange-files refuses to delete.csv";

  const sweepingDraft = {
    ...RUN_DIAGNOSTICS_DEFAULT,
    sweepExchangeFiles: true,
    sweepConfirmed: true,
  };

  test("a run that requested the sweep shows what a run that did not shows", () => {
    // The two runs differ in what they asked the CLI to do...
    expect(runDiagnosticsIntentFields(sweepingDraft)).toEqual({
      sweepExchangeFiles: true,
    });
    expect(runDiagnosticsIntentFields(RUN_DIAGNOSTICS_DEFAULT)).toEqual({});

    // ...and neither reaches the failure, so the planted fragment cannot become
    // the console's own words on either run.
    const surfaced = failureFor(
      "exchange",
      new RelayedTerminalError(plantedTerminal),
      undefined,
      "filedrop",
    );
    expect(surfaced.title).toBe("Exchange failed");
    expect(surfaced.message).not.toContain("--force-retain-sweep");
    expect(surfaced.message).not.toContain("refuses to delete");
  });

  test("every category keeps the title it gives an ordinary terminal", () => {
    const categories = ["exchange", "config", "security", "output"] as const;
    for (const category of categories) {
      const planted = failureFor(
        category,
        new RelayedTerminalError(plantedTerminal),
        undefined,
        "filedrop",
      );
      const ordinary = failureFor(
        category,
        new RelayedTerminalError("the partner never appeared"),
        undefined,
        "filedrop",
      );
      expect(planted.title).toBe(ordinary.title);
      expect(planted.message).not.toContain("--force-retain-sweep");
    }
  });
});
