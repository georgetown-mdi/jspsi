import { expect, test } from "vitest";

import {
  parseBoundedJson,
  JsonStructureBoundError,
  MAX_JSON_OBJECT_KEYS,
  MAX_JSON_NESTING_DEPTH,
} from "../src/utils/boundedJson";

test("parses a valid object from a string", () => {
  expect(parseBoundedJson('{"a":1,"b":[1,2,3],"c":{"d":true}}')).toEqual({
    a: 1,
    b: [1, 2, 3],
    c: { d: true },
  });
});

test("parses a valid object from UTF-8 bytes", () => {
  const bytes = new TextEncoder().encode('{"hello":"world","n":42}');
  expect(parseBoundedJson(bytes)).toEqual({ hello: "world", n: 42 });
});

test("parses a large array-bearing body unchanged (no false reject)", () => {
  // The shape a per-byte or total-count budget would wrongly reject: a long
  // array of small objects. Far under the element bound, so it parses intact.
  const message = Array.from({ length: 10_000 }, (_, i) => ({
    theirIndex: i,
    iteration: i % 7,
  }));
  expect(parseBoundedJson(JSON.stringify(message))).toEqual(message);
});

test("rejects an object past the key bound with JsonStructureBoundError", () => {
  // One key past the bound. Exercised at the configured value, not the raw
  // engine ceiling -- the assertion is that the chokepoint refuses it.
  const parts: string[] = [];
  for (let i = 0; i <= MAX_JSON_OBJECT_KEYS; i++) parts.push(`"${i}":0`);
  const wide = `{${parts.join(",")}}`;
  expect(() => parseBoundedJson(wide)).toThrow(JsonStructureBoundError);
});

test("rejects nesting past the depth bound with JsonStructureBoundError", () => {
  const deep = "[".repeat(MAX_JSON_NESTING_DEPTH + 1);
  expect(() => parseBoundedJson(deep)).toThrow(JsonStructureBoundError);
});

test("a malformed (in-bounds) body throws a parse error, not a bound error", () => {
  let thrown: unknown;
  try {
    parseBoundedJson("{not valid json");
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect(thrown).not.toBeInstanceOf(JsonStructureBoundError);
});

test("invalid UTF-8 bytes throw (fatal decode), not a bound error", () => {
  // {"a":<0xff>} -- structurally tiny, so the bound passes; the fatal decoder
  // then rejects the invalid byte rather than substituting U+FFFD.
  const bad = new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0xff, 0x7d]);
  let thrown: unknown;
  try {
    parseBoundedJson(bad);
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect(thrown).not.toBeInstanceOf(JsonStructureBoundError);
});

test("the structural-bound error carries no input bytes", () => {
  // Fixed text only -- the rejection must never echo attacker-controlled bytes.
  const err = new JsonStructureBoundError();
  expect(err.message).toBe(
    "JSON payload structure exceeds the permitted bound",
  );
});
