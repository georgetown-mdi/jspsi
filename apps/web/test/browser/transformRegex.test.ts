/// <reference types="@vitest/browser-playwright/context" />
/// <reference types="vite/client" />

import { describe, expect, test } from "vitest";

import { runPipeline, safeParseLinkageTerms } from "@psilink/core";

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
// The divergent set: inputs where re2js differs from `new RegExp` (code-point `.`,
// ASCII-only `\s`), with expected values pinned from re2js itself. Replaying it in
// the browser is the cross-build check that matters most -- it exercises exactly
// the inputs on which an ESM/CJS build or version divergence would first surface.
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

// The program-size dialect gate reads re2js's compiled program size
// (re2Input.prog.inst.length) to accept or reject partner terms at validation. That
// read happens in the browser's ESM re2js build here, and in Node's CJS build in
// packages/core/test/linearRegex.test.ts; if the two computed different sizes, two
// parties on different build targets would disagree on whether terms are valid (a
// fail-closed abort divergence on partner-controlled input). The Node suite exercises
// the gate but only on Node; this pins the SAME accept/reject verdict on the real
// browser build, via the public parseLinkageTerms surface (the gate is internal).
function termsWithRegexSteps(
  steps: Array<{ pattern: string }>,
): Record<string, unknown> {
  return {
    version: "1.0.0",
    identity: "t",
    date: "2025-01-01",
    algorithm: "psi",
    output: { expectsOutput: true, shareWithPartner: false },
    deduplicate: false,
    linkageFields: [{ name: "ssn", type: "ssn" }],
    linkageKeys: [
      {
        name: "k",
        elements: [
          {
            field: "ssn",
            transform: steps.map((s) => ({
              function: "replace_regex",
              params: { pattern: s.pattern, replacement: "" },
            })),
          },
        ],
      },
    ],
  };
}

describe("program-size gate verdict in the browser", () => {
  test("agrees with Node at the exact per-pattern boundary", () => {
    // (.*){63} = 254 instructions (at the 256 cap, accept); (.*){64} = 258 (reject).
    expect(
      safeParseLinkageTerms(termsWithRegexSteps([{ pattern: "(.*){63}" }]))
        .success,
    ).toBe(true);
    expect(
      safeParseLinkageTerms(termsWithRegexSteps([{ pattern: "(.*){64}" }]))
        .success,
    ).toBe(false);
  });

  test("agrees with Node on the aggregate program-size cap", () => {
    // 8 x (b*b*){42} (~254 each, 2032 total) is under the 2048 aggregate cap; 16 is
    // over. Same metric summed, so the browser must reach the same verdict as Node.
    const step = { pattern: "(b*b*){42}" };
    expect(
      safeParseLinkageTerms(
        termsWithRegexSteps(Array<{ pattern: string }>(8).fill(step)),
      ).success,
    ).toBe(true);
    expect(
      safeParseLinkageTerms(
        termsWithRegexSteps(Array<{ pattern: string }>(16).fill(step)),
      ).success,
    ).toBe(false);
  });
});
