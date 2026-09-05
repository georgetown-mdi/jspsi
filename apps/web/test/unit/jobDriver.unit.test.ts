import fs from "node:fs";

import { afterEach, describe, expect, test } from "vitest";

import {
  DEFAULT_MAX_DISPLAY_LENGTH,
  DISPLAY_TRUNCATION_MARKER,
  WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
} from "@psilink/core";

import {
  JOB_CLI_BINARY_ENV,
  PERSISTENCE_LOSS_EXIT_CODE,
  classifyExit,
  resolveCliBinaryPath,
  validateAndSanitizeEvent,
} from "@jobs/cliDriver";

import {
  STUB_CLI_PATH,
  captureZeroSetupArgv,
  tempDataRoot,
} from "../utils/jobFixtures";

describe("classifyExit maps CLI exit codes to terminal states", () => {
  test("0 -> succeeded", () => {
    expect(classifyExit(0, null)).toEqual({
      outcome: "succeeded",
      exitCode: 0,
      signal: null,
    });
  });

  test("130 -> cancelled (SIGINT), reported distinctly", () => {
    expect(classifyExit(130, null)).toEqual({
      outcome: "cancelled",
      exitCode: 130,
      signal: null,
    });
  });

  test("143 -> cancelled (SIGTERM), reported distinctly", () => {
    expect(classifyExit(143, null)).toEqual({
      outcome: "cancelled",
      exitCode: 143,
      signal: null,
    });
  });

  test("64 / 69 / 70 / 1 -> failed with the code recorded", () => {
    for (const code of [64, 69, 70, 1]) {
      expect(classifyExit(code, null)).toEqual({
        outcome: "failed",
        exitCode: code,
        signal: null,
      });
    }
  });

  test("73 -> completedWithPersistenceLoss, not failed", () => {
    expect(PERSISTENCE_LOSS_EXIT_CODE).toBe(73);
    expect(classifyExit(PERSISTENCE_LOSS_EXIT_CODE, null)).toEqual({
      outcome: "completedWithPersistenceLoss",
      exitCode: 73,
      signal: null,
    });
  });

  // The persistence-loss code is one value, not a range: the sysexits codes on
  // either side of 73 are ordinary failures, and widening the branch would tell
  // an operator not to re-run a run that never completed its exchange.
  test("every other non-zero exit stays failed", () => {
    for (const code of [2, 70, 71, 72, 74, 75, 76, 77, 78, 126, 127, 255]) {
      expect(classifyExit(code, null)).toEqual({
        outcome: "failed",
        exitCode: code,
        signal: null,
      });
    }
  });

  test("a death to SIGINT/SIGTERM signal is cancelled", () => {
    expect(classifyExit(null, "SIGINT").outcome).toBe("cancelled");
    expect(classifyExit(null, "SIGTERM").outcome).toBe("cancelled");
  });

  test("a death to SIGKILL is failed", () => {
    expect(classifyExit(null, "SIGKILL")).toEqual({
      outcome: "failed",
      exitCode: null,
      signal: "SIGKILL",
    });
  });
});

describe("validateAndSanitizeEvent enforces the v1 vocabulary and sanitizes", () => {
  test("accepts a well-formed result event", () => {
    const event = validateAndSanitizeEvent({
      v: 1,
      type: "result",
      resultWritten: true,
    });
    expect(event).not.toBeNull();
    expect(event?.type).toBe("result");
  });

  test("accepts a stageEnd event (recognized, not degraded)", () => {
    const event = validateAndSanitizeEvent({
      v: 1,
      type: "stageEnd",
      id: "stage 1 / 2",
      durationMs: 1234,
    });
    expect(event).not.toBeNull();
    expect(event?.type).toBe("stageEnd");
    expect(event?.durationMs).toBe(1234);
  });

  test("accepts a metrics event (recognized, not degraded)", () => {
    const event = validateAndSanitizeEvent({
      v: 1,
      type: "metrics",
      recordsProcessed: 1000,
      transportRetries: 0,
      reconnects: 1,
    });
    expect(event).not.toBeNull();
    expect(event?.type).toBe("metrics");
    expect(event?.recordsProcessed).toBe(1000);
    expect(event?.reconnects).toBe(1);
  });

  test("rejects a wrong schema version", () => {
    expect(
      validateAndSanitizeEvent({ v: 2, type: "result", resultWritten: true }),
    ).toBeNull();
  });

  test("rejects an unknown event type", () => {
    expect(validateAndSanitizeEvent({ v: 1, type: "boom" })).toBeNull();
  });

  test("rejects non-object inputs", () => {
    expect(validateAndSanitizeEvent(null)).toBeNull();
    expect(validateAndSanitizeEvent([1, 2, 3])).toBeNull();
    expect(validateAndSanitizeEvent("string")).toBeNull();
  });

  test("sanitizes string fields at the trust boundary (defense in depth)", () => {
    const event = validateAndSanitizeEvent({
      v: 1,
      type: "warning",
      message: "danger[31mred[0m\nsecond line",
    });
    expect(event).not.toBeNull();
    const message = event?.message as string;
    expect(message).not.toContain("");
    expect(message).not.toContain("\n");
  });

  test("a warning message takes the composition budget, every other string the default", () => {
    const flood = "x".repeat(WARNING_MESSAGE_MAX_DISPLAY_LENGTH + 100);
    const perValueCap =
      DEFAULT_MAX_DISPLAY_LENGTH + DISPLAY_TRUNCATION_MARKER.length;

    // The warning's own message is a whole composition; a sibling field on the
    // same event, a nested one, a stage label, and a terminal error's message
    // each hold one value and keep the per-value cap.
    const warning = validateAndSanitizeEvent({
      v: 1,
      type: "warning",
      message: flood,
      detail: flood,
      nested: { message: flood },
    });
    expect((warning?.message as string).length).toBe(
      WARNING_MESSAGE_MAX_DISPLAY_LENGTH + DISPLAY_TRUNCATION_MARKER.length,
    );
    expect((warning?.detail as string).length).toBe(perValueCap);
    expect((warning?.nested as { message: string }).message.length).toBe(
      perValueCap,
    );

    const stage = validateAndSanitizeEvent({
      v: 1,
      type: "stage",
      id: "s1",
      label: flood,
    });
    expect((stage?.label as string).length).toBe(perValueCap);

    const failure = validateAndSanitizeEvent({
      v: 1,
      type: "error",
      category: "exchange",
      message: flood,
    });
    expect((failure?.message as string).length).toBe(perValueCap);
  });

  test("sanitizes nested string fields (stages array)", () => {
    const event = validateAndSanitizeEvent({
      v: 1,
      type: "stages",
      stages: [{ id: "s1", label: "hithere" }],
    });
    const stages = event?.stages as Array<{ label: string }>;
    expect(stages[0].label).not.toContain("");
  });
});

describe("validateAndSanitizeEvent sanitizes object keys", () => {
  test("an event key holding a control byte is escaped", () => {
    const esc = String.fromCharCode(0x1b);
    const controlKey = `danger${esc}[31mkey`;
    const event = validateAndSanitizeEvent({
      v: 1,
      type: "warning",
      message: "ok",
      [controlKey]: "value",
    });
    expect(event).not.toBeNull();
    for (const key of Object.keys(event as object))
      expect(key).not.toContain(esc);
  });
});
describe("resolveCliBinaryPath", () => {
  test("uses the JOB_CLI_BINARY override when set", () => {
    expect(resolveCliBinaryPath({ [JOB_CLI_BINARY_ENV]: STUB_CLI_PATH })).toBe(
      STUB_CLI_PATH,
    );
  });

  test("falls back to the workspace-relative built entry when unset", () => {
    const resolved = resolveCliBinaryPath({});
    expect(resolved.endsWith("apps/cli/dist/index.js")).toBe(true);
  });
});

describe("spawnZeroSetupJob drives the literal $0 form", () => {
  const dirs: Array<string> = [];
  afterEach(() => {
    for (const dir of dirs.splice(0))
      fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A scratch directory for one spawn, removed after the test. */
  function scratchDir(label: string): string {
    const dir = tempDataRoot(label);
    fs.mkdirSync(dir, { recursive: true });
    dirs.push(dir);
    return dir;
  }

  test("sftp: URL first positional, --server-* flags, record, input, output", async () => {
    const argv = await captureZeroSetupArgv({
      workdir: scratchDir("zs-driver"),
      connectionArgs: [
        "sftp://sftp.example.org:2222/exchange",
        "--server-username=linkage",
        "--server-password=@/etc/psilink/pw",
        `--server-host-key-fingerprint=SHA256:${"A".repeat(43)}`,
      ],
      eventStream: true,
    });
    expect(argv[0]).toBe("sftp://sftp.example.org:2222/exchange");
    expect(argv).toContain("--event-stream");
    // The record path rides a single `--flag=value` token, never a two-token pair.
    expect(argv.some((token) => token.startsWith("--record-file="))).toBe(true);
    expect(argv).not.toContain("--record-file");
    // The two trailing positionals are input then output.
    expect(argv[argv.length - 2].endsWith("input.csv")).toBe(true);
    expect(argv[argv.length - 1].endsWith("output.csv")).toBe(true);
  });

  test("never a subcommand token, --config-file, --key-file, or --save", async () => {
    const argv = await captureZeroSetupArgv({
      workdir: scratchDir("zs-driver"),
      connectionArgs: ["file:///srv/jobs/abc/rendezvous"],
      eventStream: false,
    });
    expect(argv[0]).toBe("file:///srv/jobs/abc/rendezvous");
    expect(argv).not.toContain("exchange");
    expect(argv).not.toContain("--config-file");
    expect(argv).not.toContain("--key-file");
    expect(argv).not.toContain("--save");
    // --event-stream is omitted when not requested.
    expect(argv).not.toContain("--event-stream");
  });

  test("forwards --identity and --linkage-strategy as single =value tokens", async () => {
    const argv = await captureZeroSetupArgv({
      workdir: scratchDir("zs-driver"),
      connectionArgs: ["file:///srv/jobs/abc/rendezvous"],
      eventStream: false,
      identity: "county-health",
      linkageStrategy: "single-pass",
    });
    expect(argv).toContain("--identity=county-health");
    expect(argv).toContain("--linkage-strategy=single-pass");
    // Never a two-token pair: a bare flag would let a value be parsed separately.
    expect(argv).not.toContain("--identity");
    expect(argv).not.toContain("--linkage-strategy");
  });

  test("a flag-shaped identity rides its =value token, never steering the run", async () => {
    // Defense in depth over the schema's leading-dash refusal: even a `-`-leading
    // identity reaching the driver is one `--identity=<value>` token, so yargs
    // parses it verbatim and no standalone `--save` (or any lone flag) appears.
    const argv = await captureZeroSetupArgv({
      workdir: scratchDir("zs-driver"),
      connectionArgs: ["file:///srv/jobs/abc/rendezvous"],
      eventStream: false,
      identity: "--save",
    });
    expect(argv).toContain("--identity=--save");
    expect(argv).not.toContain("--save");
    expect(argv).not.toContain("--identity");
  });
});
