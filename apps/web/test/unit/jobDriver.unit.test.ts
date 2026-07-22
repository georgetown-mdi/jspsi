import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  JOB_CLI_BINARY_ENV,
  classifyExit,
  resolveCliBinaryPath,
  spawnZeroSetupJob,
  validateAndSanitizeEvent,
} from "@jobs/cliDriver";

import { STUB_CLI_PATH, tempDataRoot } from "../utils/jobFixtures";

import type { JobTerminalState } from "@jobs/cliDriver";

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

  test("64 / 69 / 1 -> failed with the code recorded", () => {
    for (const code of [64, 69, 1]) {
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
  test("an event key carrying a control byte is escaped", () => {
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

  /** Spawn the stub through spawnZeroSetupJob, capturing the exact argv it was
   * invoked with (via the stub's STUB_ARGV_FILE), and resolve once it exits. */
  async function captureArgv(args: {
    connectionArgs: Array<string>;
    eventStream: boolean;
    identity?: string;
    linkageStrategy?: "cascade" | "single-pass";
  }): Promise<Array<string>> {
    const workdir = tempDataRoot("zs-driver");
    fs.mkdirSync(workdir, { recursive: true });
    dirs.push(workdir);
    const argvFile = path.join(workdir, "argv.json");
    // A wrapper object, not a bare local: the terminal is set from the driver's
    // callback, which TypeScript's control-flow analysis would otherwise narrow a
    // local `null` past, making the poll condition read as always-true.
    const terminalRef: { current: JobTerminalState | null } = { current: null };
    spawnZeroSetupJob({
      binaryPath: STUB_CLI_PATH,
      connectionArgs: args.connectionArgs,
      inputPath: path.join(workdir, "input.csv"),
      outputPath: path.join(workdir, "output.csv"),
      recordPath: path.join(workdir, "record.json"),
      workdir,
      eventStream: args.eventStream,
      ...(args.identity !== undefined ? { identity: args.identity } : {}),
      ...(args.linkageStrategy !== undefined
        ? { linkageStrategy: args.linkageStrategy }
        : {}),
      extraEnv: { STUB_ARGV_FILE: argvFile, STUB_EXIT_CODE: "0" },
      handlers: {
        onEvent: () => undefined,
        onDegraded: () => undefined,
        onTerminal: (state) => {
          terminalRef.current = state;
        },
      },
    });
    const deadline = Date.now() + 5000;
    while (terminalRef.current === null) {
      if (Date.now() > deadline) throw new Error("stub did not exit");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // argv[0] is node, argv[1] the CLI entry; the driven arguments follow.
    return (
      JSON.parse(fs.readFileSync(argvFile, "utf8")) as Array<string>
    ).slice(2);
  }

  test("sftp: URL first positional, --server-* flags, record, input, output", async () => {
    const argv = await captureArgv({
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
    const argv = await captureArgv({
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
    const argv = await captureArgv({
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
    const argv = await captureArgv({
      connectionArgs: ["file:///srv/jobs/abc/rendezvous"],
      eventStream: false,
      identity: "--save",
    });
    expect(argv).toContain("--identity=--save");
    expect(argv).not.toContain("--save");
    expect(argv).not.toContain("--identity");
  });
});
