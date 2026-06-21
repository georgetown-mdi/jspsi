import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import { runPipeline } from "../src/standardization";
import type { FieldValue } from "../src/standardization";

// The Node half of the transform-regex cross-build contract. The vectors in
// transform-regex-vectors.json carry the output each step produced on the
// JavaScript `RegExp` engine (computed by generate-transform-regex-vectors.mjs);
// runPipeline now runs those steps on the linear-time engine (re2js). Asserting
// the engine reproduces every vector pins that in-dialect patterns are
// byte-identical to the previous engine for the patterns and inputs these vectors
// cover -- including every bundled default-template pattern. The one known
// divergence from `new RegExp` is outside that domain and not exercised here: `.`
// matches a code point under RE2 but a UTF-16 code unit under JS, so the two
// engines differ on a non-BMP input (documented in PROTOCOL.md); all vector
// inputs are BMP. apps/web/test/browser/transformRegex.test.ts asserts the
// BROWSER build reproduces the same vectors, so the two build targets agree
// byte-for-byte.

interface Vector {
  name: string;
  steps: Array<{ function: string; params?: Record<string, unknown> }>;
  input: string;
  expected: string | null | string[];
}

const { vectors } = JSON.parse(
  readFileSync(
    new URL("./vectors/transform-regex-vectors.json", import.meta.url),
    { encoding: "utf8" },
  ),
) as { vectors: Vector[] };

// A FieldValue's stable JSON form, matching the generator's `serialize`: a
// fan-out Set becomes an array in insertion order, a string/null pass through.
function serialize(value: FieldValue): string | null | string[] {
  if (value === null) return null;
  if (value instanceof Set) return [...value];
  return value;
}

describe("transform-regex-vectors.json", () => {
  test("the vector file is non-empty", () => {
    expect(vectors.length).toBeGreaterThan(0);
  });

  test.each(vectors)(
    "$name: the linear-time engine reproduces the JS-RegExp reference output",
    (vector) => {
      expect(serialize(runPipeline(vector.input, vector.steps))).toEqual(
        vector.expected,
      );
    },
  );
});
