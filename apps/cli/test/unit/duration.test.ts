import { expect, test } from "vitest";
import { UsageError } from "@psilink/core";

import { parseDuration } from "../../src/util/duration";

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
