import { expect, test } from "vitest";
import { UsageError } from "@psilink/core";

import { parseDuration, parseDurationFlag } from "../../src/util/duration";

test("parses each unit suffix into milliseconds", () => {
  expect(parseDuration("45s")).toBe(45_000);
  expect(parseDuration("30m")).toBe(1_800_000);
  expect(parseDuration("2h")).toBe(7_200_000);
  expect(parseDuration("1d")).toBe(86_400_000);
});

test("tolerates surrounding whitespace", () => {
  expect(parseDuration("  10m  ")).toBe(600_000);
});

test.each([
  "", // empty
  "  ", // whitespace only
  "30", // no unit
  "h", // no magnitude
  "2hours", // unit must be a single character
  "1.5h", // non-integer magnitude
  "-5m", // negative magnitude
  "30 m", // internal whitespace
  "1w", // unsupported unit
  "10M", // units are lowercase
])("rejects malformed duration %j", (input) => {
  expect(() => parseDuration(input)).toThrow(UsageError);
});

test.each(["0s", "0m", "0h", "0d"])("rejects a zero duration %j", (input) => {
  expect(() => parseDuration(input)).toThrow(UsageError);
});

test("rejects a magnitude that overflows a safe integer", () => {
  expect(() => parseDuration("99999999999999999d")).toThrow(UsageError);
});

// --- parseDurationFlag (the flag-aware wrapper) ------------------------------

test("parseDurationFlag: a valid value parses to the same ms offset as parseDuration", () => {
  expect(parseDurationFlag("--peer-timeout", "30s")).toBe(30_000);
  expect(parseDurationFlag("--accept-timeout", "5m")).toBe(300_000);
  // Surrounding whitespace is tolerated, exactly as parseDuration does.
  expect(parseDurationFlag("--connection-timeout", "  2h ")).toBe(7_200_000);
});

test("parseDurationFlag: a bare integer is rejected naming the flag and the suffixed value", () => {
  // The pre-migration seconds-only form: the message must name the flag, the
  // required-suffix rule, and the exact suffixed value to use (the acceptance
  // criterion's `use 30s`), so migrating an old invocation is mechanical.
  let message = "";
  try {
    parseDurationFlag("--peer-timeout", "30");
  } catch (err) {
    expect(err).toBeInstanceOf(UsageError);
    message = (err as UsageError).message;
  }
  expect(message).toContain("--peer-timeout");
  expect(message).toContain("30s");
  expect(message).toContain("unit suffix");
  // A leading-zero / non-canonical integer is normalized in the suggestion.
  expect(parseDurationFlag.bind(null, "--peer-timeout", "030")).toThrow("30s");
});

test("parseDurationFlag: a malformed value yields parseDuration's message prefixed with the flag", () => {
  expect(() => parseDurationFlag("--connection-timeout", "2hours")).toThrow(
    UsageError,
  );
  expect(() => parseDurationFlag("--connection-timeout", "2hours")).toThrow(
    "--connection-timeout",
  );
  // A bare 0 is not steered to "0s" (itself invalid); it falls through to the
  // generic rejection, still flag-named.
  expect(() => parseDurationFlag("--peer-timeout", "0")).toThrow(
    "--peer-timeout",
  );
});
