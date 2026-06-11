import { expect, test } from "vitest";
import type { Arguments } from "yargs";
import { UsageError } from "@psilink/core";

import { singleValue } from "../../src/util/cli";

function argv(extra: Record<string, unknown>): Arguments {
  return { _: [], $0: "psilink", ...extra } as unknown as Arguments;
}

// --- singleValue -------------------------------------------------------------

test("singleValue: returns a single scalar value unchanged", () => {
  // The caller casts to the option's declared type; the helper only rejects the
  // array case, so a lone number or string passes through untouched.
  expect(singleValue(argv({ "server-port": 2222 }), "server-port")).toBe(2222);
  expect(singleValue(argv({ "log-level": "debug" }), "log-level")).toBe("debug");
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
