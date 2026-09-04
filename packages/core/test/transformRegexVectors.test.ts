import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import { runPipeline } from "../src/standardization";
import type { FieldValue } from "../src/standardization";

// These vectors hold each step's JavaScript RegExp output
// (generate-transform-regex-vectors.mjs); runPipeline must reproduce them
// exactly on the linear-time engine (re2js). Inputs where re2js diverges
// from RegExp (e.g. `.` over a non-BMP code point, `\s` ASCII-only) are
// excluded here and covered by the divergent vector set below. The browser
// suite replays both files, so both build targets stay in agreement.

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

// A second set covering inputs where re2js diverges from `new RegExp`
// (code-point/class differences: `.` over a code point, `\s` ASCII-only,
// `.` excluding only `\n`). Expected values come from re2js itself
// (generate-transform-regex-divergent-vectors.mjs), pinning its behavior on
// the inputs where an ESM/CJS build or version change would first diverge.
// The browser suite replays the same file, so both builds agree here too.
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
