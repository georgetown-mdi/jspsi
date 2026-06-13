import { expect, test, vi } from "vitest";
import type { Arguments } from "yargs";
import { UsageError } from "@psilink/core";

import {
  durationFlagSeconds,
  exitWithError,
  parseOrExit,
  singleValue,
} from "../../src/util/cli";

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
