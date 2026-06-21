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
// cover -- including every bundled default-template pattern. That corpus
// deliberately excludes the inputs where re2js and `new RegExp` differ (e.g. `.`
// over a non-BMP code point, `\s` being ASCII-only); those are exercised
// separately by the divergent vector set below, whose expected values come from
// re2js itself rather than `new RegExp`. apps/web/test/browser/transformRegex.test.ts
// replays both files in the BROWSER build, so the two build targets are checked to
// agree byte-for-byte on both the agree-domain and the divergent inputs.

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

// A second set covering the inputs where re2js DIVERGES from `new RegExp` (the
// documented code-point / class differences: `.` over a code point, `\s`
// ASCII-only, `.` excluding only `\n`). Their expected values come from re2js
// itself (generate-transform-regex-divergent-vectors.mjs), not `new RegExp`, so
// they pin re2js's own behavior on exactly the inputs where an ESM/CJS build or a
// re2js version change would first diverge -- the cases the agree-domain corpus
// above cannot reach. The browser suite replays the same file, so the two build
// targets are checked to agree here too.
const { vectors: divergentVectors } = JSON.parse(
  readFileSync(
    new URL(
      "./vectors/transform-regex-divergent-vectors.json",
      import.meta.url,
    ),
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

describe("transform-regex-divergent-vectors.json", () => {
  test("the divergent vector file is non-empty", () => {
    expect(divergentVectors.length).toBeGreaterThan(0);
  });

  test.each(divergentVectors)(
    "$name: the linear-time engine reproduces the pinned re2js output",
    (vector) => {
      expect(serialize(runPipeline(vector.input, vector.steps))).toEqual(
        vector.expected,
      );
    },
  );
});
