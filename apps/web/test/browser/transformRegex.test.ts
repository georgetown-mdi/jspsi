/// <reference types="@vitest/browser-playwright/context" />
/// <reference types="vite/client" />

import { describe, expect, test } from "vitest";

import { runPipeline } from "@psilink/core";

// The companion to packages/core/test/transformRegexVectors.test.ts: it runs
// the same checked-in transform-regex vectors through the browser build of
// @psilink/core in real Chromium, proving the CLI (Node) and web (browser)
// builds derive byte-identical values for every partner transform pattern.
// re2js is pure JS, so the same engine runs on both targets.
//
// Imported as raw text and parsed with the browser's own JSON.parse (mirroring the
// Node suite's readFileSync + JSON.parse) rather than via the bundler's JSON
// import, matching canonical.test.ts.
import vectorsRaw from "../../../../packages/core/test/vectors/transform-regex-vectors.json?raw";
// The divergent set: inputs where re2js differs from `new RegExp` (code-point `.`,
// ASCII-only `\s`), with expected values pinned from re2js itself. Replaying it in
// the browser is the cross-build check that matters most -- it exercises exactly
// the inputs on which an ESM/CJS build or version divergence would appear first.
import divergentVectorsRaw from "../../../../packages/core/test/vectors/transform-regex-divergent-vectors.json?raw";

interface Vector {
  name: string;
  steps: Array<{ function: string; params?: Record<string, unknown> }>;
  input: string;
  expected: string | null | Array<string>;
}

const vectors = (JSON.parse(vectorsRaw) as { vectors: Array<Vector> }).vectors;
const divergentVectors = (
  JSON.parse(divergentVectorsRaw) as { vectors: Array<Vector> }
).vectors;

function serialize(
  value: ReturnType<typeof runPipeline>,
): string | null | Array<string> {
  if (value === null) return null;
  if (value instanceof Set) return [...value];
  return value;
}

describe("transform-regex dialect in the browser", () => {
  test.each(vectors)(
    "$name: browser output matches the checked-in vector",
    (vector) => {
      expect(serialize(runPipeline(vector.input, vector.steps))).toEqual(
        vector.expected,
      );
    },
  );

  test.each(divergentVectors)(
    "$name: browser output matches the pinned re2js divergent vector",
    (vector) => {
      expect(serialize(runPipeline(vector.input, vector.steps))).toEqual(
        vector.expected,
      );
    },
  );
});
