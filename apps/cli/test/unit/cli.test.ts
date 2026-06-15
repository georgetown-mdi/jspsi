import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test, vi } from "vitest";
import type { Arguments } from "yargs";
import { loadCSVFile, UsageError } from "@psilink/core";

import {
  durationFlagSeconds,
  exitWithError,
  openInputSource,
  parseOrExit,
  singleValue,
} from "../../src/util/cli";
import { streamOf, withStdin } from "../stdinStream";

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

test("openInputSource: `-` returns process.stdin when stdin is allowed", async () => {
  const stub = streamOf("");
  await withStdin(stub, () => {
    expect(openInputSource("-", { allowStdin: true })).toBe(stub);
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
