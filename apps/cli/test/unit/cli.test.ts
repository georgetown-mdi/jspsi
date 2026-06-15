import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";

import { expect, test, vi } from "vitest";
import type { Arguments } from "yargs";
import { loadCSVFile, UsageError } from "@psilink/core";

import {
  durationFlagSeconds,
  exitWithError,
  openInputSource,
  parseOrExit,
  singleValue,
  writeOutput,
} from "../../src/util/cli";
import { streamOf, ttyStream, withStdin } from "../stdinStream";

function argv(extra: Record<string, unknown>): Arguments {
  return { _: [], $0: "psilink", ...extra } as unknown as Arguments;
}

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
      writeOutput(path.join(dir, "results.csv"), ["a"], [["1"]]),
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
    await writeOutput(undefined, ["a", "b"], [["1", "2"]]);
  } finally {
    stdoutSpy.mockRestore();
  }
  expect(chunks.join("")).toBe("a,b\n1,2\n");
});
