import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";

import { expect, test, vi } from "vitest";
import type { Arguments } from "yargs";
import { loadCSVFile, MAX_RECONNECT_ATTEMPTS, UsageError } from "@psilink/core";

import {
  assertNoUnknownOptions,
  durationFlagMs,
  durationFlagSeconds,
  exitWithError,
  MAX_TIMEOUT_SECONDS,
  nonNegativeIntFlag,
  openInputSource,
  parseOrExit,
  singleValue,
  writeOutput,
} from "../../src/util/cli";
import { streamOf, ttyStream, withStdin } from "../stdinStream";

function argv(extra: Record<string, unknown>): Arguments {
  return { _: [], $0: "psilink", ...extra } as unknown as Arguments;
}

// --- assertNoUnknownOptions --------------------------------------------------

test("assertNoUnknownOptions: a --prefixed token is a usage error naming it", () => {
  // The commands that set unknown-options-as-args capture a mistyped --flag in
  // their positionals; this is where it is rejected, in yargs' own wording.
  expect(() =>
    assertNoUnknownOptions(["--server-usernam", "u", "input.csv"]),
  ).toThrow(UsageError);
  expect(() =>
    assertNoUnknownOptions(["--server-usernam", "u", "input.csv"]),
  ).toThrow("Unknown argument: --server-usernam");
});

test("assertNoUnknownOptions: several --prefixed tokens are all named", () => {
  expect(() =>
    assertNoUnknownOptions(["--retain-file", "--identit", "x"]),
  ).toThrow("Unknown arguments: --retain-file, --identit");
});

test("assertNoUnknownOptions: a --flag=value token is rejected whole", () => {
  expect(() => assertNoUnknownOptions(["--server-usernam=x", "ABC"])).toThrow(
    "Unknown argument: --server-usernam=x",
  );
});

test("assertNoUnknownOptions: single-`-` and plain positionals pass", () => {
  // A `-`-leading invitation string, a bare `-` stdin token, a URL, and a plain
  // file path are all legitimate positionals: only a `--`-prefixed token is an
  // option-shaped mistype.
  expect(() =>
    assertNoUnknownOptions([
      "-eyJ2ZXJzaW9uIjoiMSJ9abcDEF",
      "-",
      "sftp://h/p",
      "input.csv",
    ]),
  ).not.toThrow();
  expect(() => assertNoUnknownOptions([])).not.toThrow();
});

// --- singleValue -------------------------------------------------------------

test("singleValue: returns a single scalar value unchanged", () => {
  // The caller casts to the option's declared type; the helper only rejects the
  // array case, so a lone number or string passes through untouched.
  expect(singleValue(argv({ "server-port": 2222 }), "server-port")).toBe(2222);
  expect(singleValue(argv({ "log-level": "debug" }), "log-level")).toBe(
    "debug",
  );
});

test("singleValue: an absent flag is undefined", () => {
  expect(singleValue(argv({}), "server-port")).toBeUndefined();
});

test("singleValue: a repeated flag (array) is a usage error naming the flag", () => {
  // yargs collects `--server-port 2222 --server-port 2223` into [2222, 2223] and
  // `--log-level info --log-level debug` into ["info", "debug"]; both are
  // rejected before the array can reach a scalar cast (arithmetic / comparison
  // for a number, .toLowerCase() for a string).
  expect(() =>
    singleValue(argv({ "server-port": [2222, 2223] }), "server-port"),
  ).toThrow(UsageError);
  expect(() =>
    singleValue(argv({ "server-port": [2222, 2223] }), "server-port"),
  ).toThrow("--server-port may be given only once");
  expect(() =>
    singleValue(argv({ "log-level": ["info", "debug"] }), "log-level"),
  ).toThrow("--log-level may be given only once");
});

// --- durationFlagSeconds -----------------------------------------------------

test("durationFlagSeconds: a valid duration is returned as whole seconds", () => {
  // parseDurationFlag yields ms; the helper divides to the seconds the timeout
  // flags' downstream consumers expect. The smallest unit is seconds, so the
  // conversion is exact for every unit.
  expect(
    durationFlagSeconds(argv({ "peer-timeout": "30s" }), "peer-timeout"),
  ).toBe(30);
  expect(
    durationFlagSeconds(
      argv({ "connection-timeout": "2m" }),
      "connection-timeout",
    ),
  ).toBe(120);
});

test("durationFlagSeconds: an absent flag is undefined", () => {
  expect(durationFlagSeconds(argv({}), "peer-timeout")).toBeUndefined();
});

test("durationFlagSeconds: a bare integer is rejected naming the flag and suffixed value", () => {
  expect(() =>
    durationFlagSeconds(argv({ "peer-timeout": "30" }), "peer-timeout"),
  ).toThrow(UsageError);
  expect(() =>
    durationFlagSeconds(argv({ "peer-timeout": "30" }), "peer-timeout"),
  ).toThrow("30s");
});

test("durationFlagSeconds: a malformed value is a flag-named usage error", () => {
  expect(() =>
    durationFlagSeconds(argv({ "peer-timeout": "1w" }), "peer-timeout"),
  ).toThrow("--peer-timeout");
});

test("durationFlagSeconds: a repeated flag is rejected before parsing", () => {
  expect(() =>
    durationFlagSeconds(
      argv({ "peer-timeout": ["30s", "60s"] }),
      "peer-timeout",
    ),
  ).toThrow("--peer-timeout may be given only once");
});

test("durationFlagSeconds: a non-string value yields a UsageError, not a TypeError", () => {
  // The flags routed here are type:"string", so yargs always yields a string; a
  // contract violation (a number slipping through, a test bypassing yargs) is
  // coerced so it still fails as a clean flag-named usage error rather than a raw
  // .trim() TypeError.
  expect(() =>
    durationFlagSeconds(argv({ "peer-timeout": 30 }), "peer-timeout"),
  ).toThrow(UsageError);
  expect(() =>
    durationFlagSeconds(argv({ "peer-timeout": 30 }), "peer-timeout"),
  ).toThrow("30s");
});

// --- durationFlagSeconds: sanity ceiling -------------------------------------

test("durationFlagSeconds: a value at the ceiling is accepted", () => {
  // The boundary is inclusive: exactly MAX_TIMEOUT_SECONDS (7d) parses to its
  // seconds value unchanged, so an at-cap value behaves exactly as it does today.
  const atCeiling = `${MAX_TIMEOUT_SECONDS / 86_400}d`;
  expect(
    durationFlagSeconds(
      argv({ "peer-timeout": atCeiling }),
      "peer-timeout",
      MAX_TIMEOUT_SECONDS,
    ),
  ).toBe(MAX_TIMEOUT_SECONDS);
});

test("durationFlagSeconds: a value just above the ceiling is rejected naming the flag and the max", () => {
  // One minute past 7d (7d is a whole number of minutes): rejected with a
  // flag-named usage error that states the maximum in days and echoes the
  // offending value, the shape the --expires-in ceiling error uses.
  const justOver = `${MAX_TIMEOUT_SECONDS / 60 + 1}m`;
  expect(() =>
    durationFlagSeconds(
      argv({ "peer-timeout": justOver }),
      "peer-timeout",
      MAX_TIMEOUT_SECONDS,
    ),
  ).toThrow(UsageError);
  let message = "";
  try {
    durationFlagSeconds(
      argv({ "connection-timeout": justOver }),
      "connection-timeout",
      MAX_TIMEOUT_SECONDS,
    );
  } catch (err) {
    message = (err as UsageError).message;
  }
  expect(message).toContain("--connection-timeout");
  expect(message).toContain("must not exceed");
  expect(message).toContain("7d");
  expect(message).toContain(justOver);
});

test("durationFlagSeconds: the ceiling is opt-in; without a max a large value still parses", () => {
  // The cap is a per-call ceiling, not a global one: a call that passes no
  // maxSeconds is unbounded below the safe-integer overflow guard, exactly as
  // before the cap existed, so a non-timeout duration flag is unaffected.
  expect(
    durationFlagSeconds(argv({ "peer-timeout": "30d" }), "peer-timeout"),
  ).toBe(30 * 86_400);
});

test("durationFlagSeconds: the existing rejections precede the ceiling check", () => {
  // The cap layers on top of parsing rather than replacing it: a bare integer
  // still yields the migration hint (not the cap error) even when a max is
  // supplied, since parseDurationFlag runs first...
  expect(() =>
    durationFlagSeconds(
      argv({ "peer-timeout": "30" }),
      "peer-timeout",
      MAX_TIMEOUT_SECONDS,
    ),
  ).toThrow("30s");
  // ...and a zero is still rejected as a zero duration, never as over-ceiling.
  expect(() =>
    durationFlagSeconds(
      argv({ "peer-timeout": "0s" }),
      "peer-timeout",
      MAX_TIMEOUT_SECONDS,
    ),
  ).toThrow(/greater than zero/);
});

// --- durationFlagMs (sub-second, milliseconds) -------------------------------

test("durationFlagMs: a sub-second value is returned in milliseconds", () => {
  // Unlike durationFlagSeconds (which divides to whole seconds), this preserves
  // the millisecond magnitude a sub-second poll interval needs.
  expect(
    durationFlagMs(argv({ "polling-frequency": "100ms" }), "polling-frequency"),
  ).toBe(100);
  expect(
    durationFlagMs(argv({ "polling-frequency": "2s" }), "polling-frequency"),
  ).toBe(2_000);
});

test("durationFlagMs: an absent flag is undefined", () => {
  expect(durationFlagMs(argv({}), "polling-frequency")).toBeUndefined();
});

test("durationFlagMs: a bare integer is rejected naming the flag and suffixed value", () => {
  expect(() =>
    durationFlagMs(argv({ "polling-frequency": "100" }), "polling-frequency"),
  ).toThrow(UsageError);
  expect(() =>
    durationFlagMs(argv({ "polling-frequency": "100" }), "polling-frequency"),
  ).toThrow("100s");
});

test("durationFlagMs: a repeated flag is rejected before parsing", () => {
  expect(() =>
    durationFlagMs(
      argv({ "polling-frequency": ["100ms", "200ms"] }),
      "polling-frequency",
    ),
  ).toThrow("--polling-frequency may be given only once");
});

// --- nonNegativeIntFlag ------------------------------------------------------

test("nonNegativeIntFlag: a nonnegative integer is returned unchanged", () => {
  // The schema floor on maxReconnectAttempts is nonnegative (not positive), so 0
  // ("connect once, do not reconnect") is valid and must pass through.
  expect(
    nonNegativeIntFlag(
      argv({ "max-reconnect-attempts": 3 }),
      "max-reconnect-attempts",
    ),
  ).toBe(3);
  expect(
    nonNegativeIntFlag(
      argv({ "max-reconnect-attempts": 0 }),
      "max-reconnect-attempts",
    ),
  ).toBe(0);
  // With no ceiling argument the only upper bound is the safe-integer range, so
  // MAX_SAFE_INTEGER (the inclusive boundary z.int() accepts) passes through. A
  // product ceiling is opt-in via the third argument, exercised separately below.
  expect(
    nonNegativeIntFlag(
      argv({ "max-reconnect-attempts": Number.MAX_SAFE_INTEGER }),
      "max-reconnect-attempts",
    ),
  ).toBe(Number.MAX_SAFE_INTEGER);
});

test("nonNegativeIntFlag: a value at or below the ceiling passes through", () => {
  // The ceiling is inclusive: exactly MAX_RECONNECT_ATTEMPTS is accepted, the
  // largest in-range value, so it behaves exactly as a smaller value does.
  expect(
    nonNegativeIntFlag(
      argv({ "max-reconnect-attempts": 3 }),
      "max-reconnect-attempts",
      MAX_RECONNECT_ATTEMPTS,
    ),
  ).toBe(3);
  expect(
    nonNegativeIntFlag(
      argv({ "max-reconnect-attempts": MAX_RECONNECT_ATTEMPTS }),
      "max-reconnect-attempts",
      MAX_RECONNECT_ATTEMPTS,
    ),
  ).toBe(MAX_RECONNECT_ATTEMPTS);
});

test("nonNegativeIntFlag: a value above the ceiling is a flag-named usage error stating the maximum", () => {
  // The footgun this closes: a fat-fingered count near MAX_SAFE_INTEGER would
  // otherwise be accepted and turn into a linear self-inflicted connect hang. One
  // past the ceiling is rejected at parse (exit 64) with the flag named, the bare
  // count maximum stated (no time unit), and the offending value echoed.
  const justOver = MAX_RECONNECT_ATTEMPTS + 1;
  // One invocation covers both the type and the message: capture the thrown
  // error, assert it is the flag-named UsageError, then assert its wording.
  let caught: unknown;
  try {
    nonNegativeIntFlag(
      argv({ "max-reconnect-attempts": justOver }),
      "max-reconnect-attempts",
      MAX_RECONNECT_ATTEMPTS,
    );
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(UsageError);
  const message = (caught as UsageError).message;
  expect(message).toContain("--max-reconnect-attempts");
  expect(message).toContain("must not exceed");
  expect(message).toContain(String(MAX_RECONNECT_ATTEMPTS));
  expect(message).toContain(String(justOver));
});

test("nonNegativeIntFlag: an absent flag is undefined", () => {
  expect(
    nonNegativeIntFlag(argv({}), "max-reconnect-attempts"),
  ).toBeUndefined();
});

test("nonNegativeIntFlag: a negative, a fraction, NaN, or an unsafe magnitude are flag-named usage errors", () => {
  // yargs type:"number" coerces a non-numeric token to NaN and applies no
  // integer, sign, or range constraint; each of these reaches here as a number
  // z.int().nonnegative() would reject, so the flag-named UsageError catches it
  // at the CLI boundary (exit 64) rather than deep in connection setup (exit 69).
  // MAX_SAFE_INTEGER + 1 is the boundary z.int() rejects: the CLI guard must
  // reject it too (Number.isSafeInteger, not isInteger) to stay aligned rather
  // than defer the rejection to the raw, un-flag-named schema error.
  for (const bad of [-1, 2.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() =>
      nonNegativeIntFlag(
        argv({ "max-reconnect-attempts": bad }),
        "max-reconnect-attempts",
      ),
    ).toThrow(UsageError);
    expect(() =>
      nonNegativeIntFlag(
        argv({ "max-reconnect-attempts": bad }),
        "max-reconnect-attempts",
      ),
    ).toThrow("--max-reconnect-attempts");
  }
});

test("nonNegativeIntFlag: the rejection states the constraint and echoes the value", () => {
  // Pin the value-rejection message so it cannot silently collapse into the
  // repeat-flag message (which also names the flag): assert the distinguishing
  // "non-negative whole number" wording and the echoed offending value.
  let message = "";
  try {
    nonNegativeIntFlag(
      argv({ "max-reconnect-attempts": -1 }),
      "max-reconnect-attempts",
    );
  } catch (err) {
    message = (err as UsageError).message;
  }
  expect(message).toContain("--max-reconnect-attempts");
  expect(message).toContain("non-negative whole number");
  expect(message).toContain("-1");
});

test("nonNegativeIntFlag: a repeated flag is rejected before the value check", () => {
  expect(() =>
    nonNegativeIntFlag(
      argv({ "max-reconnect-attempts": [1, 2] }),
      "max-reconnect-attempts",
    ),
  ).toThrow("--max-reconnect-attempts may be given only once");
});

// --- parseOrExit -------------------------------------------------------------

test("parseOrExit: returns the parsed value on success", () => {
  expect(parseOrExit(() => 42)).toBe(42);
});

test("parseOrExit: a UsageError is reported on stderr and exits 64", () => {
  // The pre-logger boundary the bootstrap-style handlers wrap parseArgs in: a
  // repeated flag or an unrecognized log-level is a UsageError, reported on
  // stderr (the logger does not exist yet) and mapped to exit 64.
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
    code?: number,
  ) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as never);
  try {
    expect(() =>
      parseOrExit(() => {
        throw new UsageError("bad flag");
      }),
    ).toThrow("exit:64");
    expect(errSpy).toHaveBeenCalledWith("bad flag");
  } finally {
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
});

test("parseOrExit: a non-UsageError propagates unchanged without exiting", () => {
  // An unexpected error keeps its stack and reaches the top-level handler rather
  // than being flattened to a bare exit.
  const exitSpy = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  try {
    expect(() =>
      parseOrExit(() => {
        throw new Error("unexpected");
      }),
    ).toThrow("unexpected");
    expect(exitSpy).not.toHaveBeenCalled();
  } finally {
    exitSpy.mockRestore();
  }
});

// --- exitWithError -----------------------------------------------------------

test("exitWithError: logs the sanitized error and exits with the given code", () => {
  // The single log-and-exit boundary the handlers route a caught error through;
  // the caller supplies the (site-specific) exit code.
  const messages: string[] = [];
  const log = {
    error: (message: string) => {
      messages.push(message);
    },
  };
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
    code?: number,
  ) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as never);
  try {
    expect(() => exitWithError(log, new UsageError("nope"), 64)).toThrow(
      "exit:64",
    );
    expect(messages).toEqual(["nope"]);
    expect(() => exitWithError(log, new Error("transport"), 69)).toThrow(
      "exit:69",
    );
    expect(messages).toEqual(["nope", "transport"]);
  } finally {
    exitSpy.mockRestore();
  }
});

// --- openInputSource ---------------------------------------------------------

test("openInputSource: a file path opens a readable stream of its contents", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-cli-input-"));
  try {
    const file = path.join(dir, "in.csv");
    fs.writeFileSync(file, "a,b\n1,2\n");
    const result = await loadCSVFile(openInputSource(file));
    expect(result.data).toEqual([{ a: "1", b: "2" }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("openInputSource: a missing file throws exit 69 (not a stdin error)", () => {
  let caught: unknown;
  try {
    openInputSource("/nonexistent/psilink-input.csv");
  } catch (err) {
    caught = err;
  }
  expect((caught as Error).message).toMatch("does not exist");
  expect((caught as { exitCode?: number }).exitCode).toBe(69);
});

test("openInputSource: `-` returns process.stdin when stdin is allowed (non-interactive)", async () => {
  // streamOf leaves isTTY undefined, modelling a pipe/redirect -- the TTY guard
  // must not fire, so the piped stdin is returned for the loader to consume.
  const stub = streamOf("");
  await withStdin(stub, () => {
    expect(openInputSource("-", { allowStdin: true })).toBe(stub);
  });
});

test("openInputSource: `-` at an interactive terminal (nothing piped) is rejected as a usage error", async () => {
  // An interactive stdin (isTTY === true) with `-` would block on an EOF that
  // never comes; reject up front naming both escape hatches rather than hang.
  await withStdin(ttyStream(), () => {
    let caught: unknown;
    try {
      openInputSource("-", { allowStdin: true });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UsageError);
    expect((caught as Error).message).toMatch(/pipe/);
    expect((caught as Error).message).toMatch(/file path/);
  });
});

test("openInputSource: a piped CSV via `-` parses to the same rows as the file", async () => {
  // The exchange and zero-setup loaders are exactly
  // loadCSVFile(openInputSource(input, { allowStdin: true })); a CSV piped through
  // stdin must yield the same parsed rows as the equivalent file.
  const csv = "first_name,last_name\nAlice,Smith\nBob,Jones\n";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-cli-stdin-"));
  try {
    const file = path.join(dir, "in.csv");
    fs.writeFileSync(file, csv);
    const fromFile = await loadCSVFile(
      openInputSource(file, { allowStdin: true }),
    );
    const fromStdin = await withStdin(streamOf(csv), () =>
      loadCSVFile(openInputSource("-", { allowStdin: true })),
    );
    expect(fromStdin.data).toEqual(fromFile.data);
    expect(fromStdin.data).toEqual([
      { first_name: "Alice", last_name: "Smith" },
      { first_name: "Bob", last_name: "Jones" },
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("openInputSource: empty stdin parses like an empty file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-cli-empty-"));
  try {
    const empty = path.join(dir, "empty.csv");
    fs.writeFileSync(empty, "");
    const fromFile = await loadCSVFile(
      openInputSource(empty, { allowStdin: true }),
    );
    const fromStdin = await withStdin(streamOf(""), () =>
      loadCSVFile(openInputSource("-", { allowStdin: true })),
    );
    expect(fromStdin.data).toEqual(fromFile.data);
    expect(fromStdin.data).toEqual([]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("openInputSource: `-` is rejected as a usage error when stdin is not allowed", () => {
  // accept's gate: stdin is reserved for the confirmation prompt, so `-` is an
  // actionable usage error naming the file-path alternative, never a silent
  // stream. A usage violation (UsageError -> exit 64), distinct from the
  // missing-file case (exit 69). The message is command-agnostic so a future
  // caller does not see itself blamed as `accept`.
  let caught: unknown;
  try {
    openInputSource("-", { allowStdin: false });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(UsageError);
  expect((caught as Error).message).toMatch(/stdin/);
  expect((caught as Error).message).toMatch(/file path/);
  expect((caught as Error).message).not.toMatch(/accept/);
});

test("openInputSource: stdin is disabled by default", () => {
  // A new caller does not silently inherit stdin support: the gate defaults off,
  // so `-` is rejected unless the caller opts in.
  expect(() => openInputSource("-")).toThrow(/stdin/);
});

// --- writeOutput -------------------------------------------------------------

// A logger stub recording the error and warn channels separately. writeOutput
// emits its redirect notice at ERROR level (so a routine `--log-level error`,
// which suppresses warn, cannot hide a sensitive-data exposure), so `errors` is
// where the notice lands and `warns` must stay empty -- asserting both is the
// executable form of "emitted at error level, not warn". An all-empty pair means
// no notice fired at all.
function logCollector(): {
  errors: string[];
  warns: string[];
  error: (m: string) => void;
  warn: (m: string) => void;
} {
  const errors: string[] = [];
  const warns: string[] = [];
  return {
    errors,
    warns,
    error: (m: string) => errors.push(m),
    warn: (m: string) => warns.push(m),
  };
}

test("writeOutput: writes the result CSV owner-only (0600) on POSIX", async () => {
  // The result CSV is the most sensitive artifact the tool produces, so a file
  // path must be created owner-only rather than inherit a world/group-readable
  // umask default (the prior unprotected createWriteStream left it 0644 here).
  // Awaiting the returned promise guarantees the rows are flushed, so the read
  // and stat are deterministic with no polling.
  if (process.platform === "win32") return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-writeoutput-"));
  // 0o022 is the umask under which the old write produced a world-readable 0644.
  const prevUmask = process.umask(0o022);
  try {
    const out = path.join(dir, "results.csv");
    await writeOutput(
      out,
      ["a", "b"],
      [
        ["1", "2"],
        ["3", "4"],
      ],
      logCollector(),
    );
    expect(fs.readFileSync(out, "utf8")).toBe("a,b\n1,2\n3,4\n");
    expect(fs.statSync(out).mode & 0o777).toBe(0o600);
  } finally {
    process.umask(prevUmask);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeOutput: a mid-write stream error rejects rather than crashing", async () => {
  // A write that fails after the stream opens (here a Writable whose first write
  // errors) must surface as a rejected promise the caller's error boundary can
  // map to an exit code -- not an unhandled 'error' event that crashes the
  // process. Asserting the rejection is itself the proof it was handled: an
  // unguarded 'error' would tear the worker down instead.
  if (process.platform === "win32") return;
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "psilink-writeoutput-err-"),
  );
  try {
    vi.spyOn(fs, "createWriteStream").mockImplementation((...args) => {
      // createOwnerOnlyWriteStream has already opened a real fd and handed it in;
      // close it so the substitute stream does not leak it.
      const fd = (args[1] as { fd?: number } | undefined)?.fd;
      if (typeof fd === "number") fs.closeSync(fd);
      return new Writable({
        write(_chunk, _enc, cb) {
          cb(new Error("disk full"));
        },
      }) as unknown as fs.WriteStream;
    });
    await expect(
      writeOutput(
        path.join(dir, "results.csv"),
        ["a"],
        [["1"]],
        logCollector(),
      ),
    ).rejects.toThrow("disk full");
  } finally {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeOutput: the stdout branch writes to process.stdout unchanged", async () => {
  // No output path: the rows go to process.stdout with no file and no permission
  // handling, exactly as before.
  const chunks: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
    chunk: string | Uint8Array,
  ): boolean => {
    chunks.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
    );
    return true;
  }) as typeof process.stdout.write);
  try {
    await writeOutput(undefined, ["a", "b"], [["1", "2"]], logCollector());
  } finally {
    stdoutSpy.mockRestore();
  }
  expect(chunks.join("")).toBe("a,b\n1,2\n");
});

// --- writeOutput: redirected-stdout permission notice ------------------------

// The distinct fd-1 kinds writeOutput's redirect detection must tell apart. Each
// models a real fstat verdict: a `> file` redirect is the only regular file; a
// pipe is a FIFO; a TTY and /dev/null are character devices. `stdoutIsRedirectedFile`
// keys solely on isFile(), so only `regular-file` should fire -- but building each
// Stats with its own true predicate (not just isFile() flipped) keeps the fixtures
// honest models of the real fd shapes rather than three copies of one stub.
const STDOUT_KINDS = {
  "regular-file": { isFile: true },
  pipe: { isFIFO: true },
  tty: { isCharacterDevice: true },
  "/dev/null": { isCharacterDevice: true },
} as const;

// Drive writeOutput's stdout branch with fd 1's stat forced to one of the kinds
// above, so the redirect detection is exercised deterministically regardless of
// what the test runner's real stdout is. Returns the stdout the rows were written
// to and both logger channels; the stdout spy also proves no notice ever reaches
// the result stream.
async function runStdoutBranch(kind: keyof typeof STDOUT_KINDS): Promise<{
  stdout: string;
  errors: string[];
  warns: string[];
}> {
  const shape: {
    isFile?: boolean;
    isFIFO?: boolean;
    isCharacterDevice?: boolean;
  } = STDOUT_KINDS[kind];
  const chunks: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
    chunk: string | Uint8Array,
  ): boolean => {
    chunks.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
    );
    return true;
  }) as typeof process.stdout.write);
  // Force only fd 1's stat; a real Stats with the kind's predicate set avoids
  // reconstructing the class. Other fds fall through to the real fstatSync.
  const realFstat = fs.fstatSync.bind(fs);
  const fstatSpy = vi.spyOn(fs, "fstatSync").mockImplementation(((
    fd: number,
    ...rest: unknown[]
  ) => {
    if (fd === 1) {
      const stats = Object.create(fs.Stats.prototype) as fs.Stats;
      stats.isFile = () => shape.isFile === true;
      stats.isFIFO = () => shape.isFIFO === true;
      stats.isCharacterDevice = () => shape.isCharacterDevice === true;
      return stats;
    }
    return (realFstat as (...a: unknown[]) => fs.Stats)(fd, ...rest);
  }) as typeof fs.fstatSync);
  const log = logCollector();
  try {
    await writeOutput(undefined, ["a", "b"], [["1", "2"]], log);
  } finally {
    stdoutSpy.mockRestore();
    fstatSpy.mockRestore();
  }
  return { stdout: chunks.join(""), errors: log.errors, warns: log.warns };
}

test("writeOutput: a redirected regular-file stdout warns at error level about umask exposure", async () => {
  // `psilink exchange data.csv > results.csv`: fd 1 is a regular file the shell
  // created under its umask, not the owner-only permissions an OUTPUT_FILE path
  // gets, so the operator is warned about the exposure and pointed at the
  // alternative.
  const { stdout, errors, warns } = await runStdoutBranch("regular-file");
  expect(errors).toHaveLength(1);
  // Emitted at error level, not warn, so a routine `--log-level error` (which
  // suppresses warn) cannot hide this sensitive-data exposure.
  expect(warns).toHaveLength(0);
  // Names the exposure (umask, not owner-only) and the OUTPUT_FILE-path fix.
  expect(errors[0]).toMatch(/umask/);
  expect(errors[0]).toMatch(/owner-only/);
  expect(errors[0]).toMatch(/OUTPUT_FILE/);
  // The notice never rides the result stream, so the CSV on stdout is intact.
  expect(stdout).toBe("a,b\n1,2\n");
});

test("writeOutput: a pipe, a TTY, or /dev/null stdout does not warn", async () => {
  // Every non-file stdout (`| cat`, an interactive terminal, `> /dev/null`)
  // reports isFile() false and leaves no under-permissioned file behind, so none
  // fire -- including the pipe and TTY a bare `process.stdout.isTTY` check could
  // not distinguish from a `> file` redirect. Each kind is a distinct fstat shape
  // (a FIFO, a character device) rather than the same stub, so the assertion is
  // that isFile()-false is what suppresses the notice regardless of the concrete
  // non-file kind.
  for (const kind of ["pipe", "tty", "/dev/null"] as const) {
    const { stdout, errors, warns } = await runStdoutBranch(kind);
    expect(errors, kind).toHaveLength(0);
    expect(warns, kind).toHaveLength(0);
    expect(stdout, kind).toBe("a,b\n1,2\n");
  }
});

test("writeOutput: a stat failure on fd 1 suppresses the warning rather than throwing", async () => {
  // Detection is best-effort: if fstatSync(1) throws (a closed or exotic fd 1),
  // writeOutput must still write the result and simply not fire, never abort the
  // output over a failed permission probe.
  const chunks: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
    chunk: string | Uint8Array,
  ): boolean => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  const realFstat = fs.fstatSync.bind(fs);
  const fstatSpy = vi.spyOn(fs, "fstatSync").mockImplementation(((
    fd: number,
    ...rest: unknown[]
  ) => {
    if (fd === 1) throw new Error("EBADF");
    return (realFstat as (...a: unknown[]) => fs.Stats)(fd, ...rest);
  }) as typeof fs.fstatSync);
  const log = logCollector();
  try {
    await writeOutput(undefined, ["a"], [["1"]], log);
  } finally {
    stdoutSpy.mockRestore();
    fstatSpy.mockRestore();
  }
  expect(log.errors).toHaveLength(0);
  expect(log.warns).toHaveLength(0);
  expect(chunks.join("")).toBe("a\n1\n");
});
