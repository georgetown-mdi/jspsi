import { expect, test } from "vitest";
import { UsageError } from "@psilink/core";

import {
  parseDuration,
  parseDurationFlag,
  parseFineDuration,
  parseFineDurationFlag,
} from "../../src/util/duration";

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
});

test("parseDurationFlag: the bare-integer hint echoes a huge value verbatim, not a rounded one", () => {
  // A digit string past 2^53 must not be suggested back through Number() (which
  // would round it or yield Infinity); the hint echoes exactly what was typed,
  // even though parseDuration would itself reject that suffixed value as too large.
  const huge = "99999999999999999";
  let message = "";
  try {
    parseDurationFlag("--peer-timeout", huge);
  } catch (err) {
    message = (err as UsageError).message;
  }
  expect(message).toContain(`${huge}s`);
  expect(message).not.toContain("Infinity");
});

test("parseDurationFlag: the bare-integer hint strips leading zeros from its suggestion", () => {
  // parseDuration reads 007s as 7s, so the migration hint must suggest 7s, not a
  // 007s the phrase "007 seconds" would misdescribe -- done with a string op, so
  // it does not reintroduce the Number() rounding the huge-value case avoids.
  let message = "";
  try {
    parseDurationFlag("--peer-timeout", "007");
  } catch (err) {
    message = (err as UsageError).message;
  }
  expect(message).toContain("use 7s for 7 seconds");
  expect(message).not.toContain("007");
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

// --- parseFineDuration (the sub-second grammar for --polling-frequency) -------

test("parseFineDuration: accepts a millisecond unit", () => {
  expect(parseFineDuration("100ms")).toBe(100);
  expect(parseFineDuration("1ms")).toBe(1);
  // The `ms` alternative wins over `m`, so `100ms` is not read as 100 minutes.
  expect(parseFineDuration("100ms")).not.toBe(100 * 60_000);
});

test("parseFineDuration: still accepts the coarse units, unchanged", () => {
  // Extending the grammar with `ms` does not change how the existing units parse.
  expect(parseFineDuration("5s")).toBe(5_000);
  expect(parseFineDuration("2m")).toBe(120_000);
  expect(parseFineDuration("1h")).toBe(3_600_000);
  expect(parseFineDuration("1d")).toBe(86_400_000);
});

test("parseFineDuration: tolerates surrounding whitespace", () => {
  expect(parseFineDuration("  250ms ")).toBe(250);
});

test.each([
  "", // empty
  "100", // no unit (bare integer still rejected)
  "ms", // no magnitude
  "1.5ms", // non-integer magnitude
  "-5ms", // negative magnitude
  "100 ms", // internal whitespace
  "100MS", // units are lowercase
  "1w", // unsupported unit
])("parseFineDuration: rejects malformed value %j", (input) => {
  expect(() => parseFineDuration(input)).toThrow(UsageError);
});

test("parseFineDuration: rejects a zero millisecond duration", () => {
  expect(() => parseFineDuration("0ms")).toThrow(UsageError);
});

test("the sub-second grammar is scoped: coarse parseDuration still rejects ms", () => {
  // The `ms` extension lives only in parseFineDuration, so --peer-timeout and the
  // other coarse flags (which use parseDuration) do not silently gain it.
  expect(() => parseDuration("100ms")).toThrow(UsageError);
});

// --- parseFineDurationFlag ---------------------------------------------------

test("parseFineDurationFlag: a valid value parses to the same ms offset as parseFineDuration", () => {
  expect(parseFineDurationFlag("--polling-frequency", "100ms")).toBe(100);
  expect(parseFineDurationFlag("--polling-frequency", "2s")).toBe(2_000);
});

test("parseFineDurationFlag: a bare integer is rejected with the same migration hint", () => {
  // The bare-integer rejection is identical to the coarse flag's: it names the
  // flag, the required-suffix rule, and the suffixed value to use.
  let message = "";
  try {
    parseFineDurationFlag("--polling-frequency", "100");
  } catch (err) {
    expect(err).toBeInstanceOf(UsageError);
    message = (err as UsageError).message;
  }
  expect(message).toContain("--polling-frequency");
  expect(message).toContain("100s");
  expect(message).toContain("unit suffix");
});

test("parseFineDurationFlag: a malformed value yields a flag-named usage error naming the ms unit", () => {
  let message = "";
  try {
    parseFineDurationFlag("--polling-frequency", "1w");
  } catch (err) {
    message = (err as UsageError).message;
  }
  expect(message).toContain("--polling-frequency");
  // The error names the sub-second unit set, so the ms option is discoverable.
  expect(message).toContain("ms");
});
