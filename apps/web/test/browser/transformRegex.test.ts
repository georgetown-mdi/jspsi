/// <reference types="@vitest/browser-playwright/context" />
/// <reference types="vite/client" />

import { describe, expect, test } from "vitest";

import { runPipeline } from "@psilink/core";

// The companion to packages/core/test/transformRegexVectors.test.ts: it runs the
// SAME checked-in transform-regex vectors through the browser build of
// @psilink/core in real Chromium. The Node suite proves Node's re2js reproduces
// the JS-RegExp reference outputs, and this suite proves the browser's re2js
// reproduces the same outputs -- so the CLI (Node) and web (browser) builds derive
// byte-identical values for every partner transform pattern. re2js is pure JS, so
// the same engine runs on both targets and this holds by construction; the test
// guards against a regression that introduces a build- or platform-dependent
// divergence.
//
// Imported as raw text and parsed with the browser's own JSON.parse (mirroring the
// Node suite's readFileSync + JSON.parse) rather than via the bundler's JSON
// import, matching canonical.test.ts.
import vectorsRaw from "../../../../packages/core/test/vectors/transform-regex-vectors.json?raw";

interface Vector {
  name: string;
  steps: Array<{ function: string; params?: Record<string, unknown> }>;
  input: string;
  expected: string | null | Array<string>;
}

const vectors = (JSON.parse(vectorsRaw) as { vectors: Array<Vector> }).vectors;

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
});
