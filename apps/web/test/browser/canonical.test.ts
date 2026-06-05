/// <reference types="@vitest/browser-playwright/context" />

import { describe, expect, test } from "vitest";

import { canonicalBytes, canonicalString } from "@psilink/core";

// The companion to packages/core/test/canonical.test.ts: it runs the SAME
// checked-in vectors through the browser build of @psilink/core in real
// Chromium. The Node suite proves Node matches the vectors and this suite
// proves the browser matches the same vectors, so the two platforms produce
// byte-identical canonical output. The canonicalizer uses only platform-neutral
// primitives (TextEncoder, JSON, and the pure-JS `canonicalize` package), so
// this holds by construction; the test guards against a regression that
// introduces a platform dependency.
import vectorsFile from "../../../../packages/core/test/vectors/canonical-vectors.json";

interface Vector {
  name: string;
  description: string;
  value: unknown;
  canonical: string;
  bytesHex: string;
  sha256Hex: string;
}

const vectors = vectorsFile.vectors as Array<Vector>;

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

describe("canonical encoding in the browser", () => {
  test.each(vectors)(
    "$name: browser output matches the checked-in vector",
    (vector) => {
      expect(canonicalString(vector.value)).toBe(vector.canonical);
      expect(toHex(canonicalBytes(vector.value))).toBe(vector.bytesHex);
    },
  );

  test("the browser SHA-256 of the canonical bytes matches the vector", async () => {
    const vector = vectors.find((v) => v.name === "agreement-fragment");
    if (!vector) throw new Error("agreement-fragment vector missing");
    const digest = await crypto.subtle.digest(
      "SHA-256",
      canonicalBytes(vector.value),
    );
    expect(toHex(new Uint8Array(digest))).toBe(vector.sha256Hex);
  });
});
