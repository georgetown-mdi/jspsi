/// <reference types="@vitest/browser-playwright/context" />
/// <reference types="vite/client" />

import { describe, expect, test } from "vitest";

import { buildExchangeRecord, verifyRecordCommitments } from "@psilink/core";

import vectorsRaw from "../../../../packages/core/test/vectors/exchange-record-vectors.json?raw";

// Derive the input/randomness types from the function under test rather than
// importing them, so this file carries no type-only import competing with the
// `?raw` import for import ordering; it also stays in step with
// buildExchangeRecord's signature automatically.
type ExchangeRecordInputs = Parameters<typeof buildExchangeRecord>[0];
type ExchangeRecordRandomness = NonNullable<
  Parameters<typeof buildExchangeRecord>[1]
>;

// The companion to packages/core/test/exchangeRecord.test.ts's vector suite: it
// runs the SAME checked-in record vectors through the browser build of
// @psilink/core in real Chromium. The Node suite proves Node reproduces the
// vectors and this suite proves the browser reproduces the same vectors, so a
// record built by the CLI (Node) and one built by the web app (browser) are
// byte-identical for the same inputs and randomness. The commitment scheme uses
// only platform-neutral primitives (crypto.subtle, TextEncoder, the pure-JS
// canonicalizer), so this holds by construction; the test guards against a
// regression that introduces a platform dependency.

interface RecordVector {
  name: string;
  description: string;
  inputs: ExchangeRecordInputs;
  randomness: { bindingNonce: string; salts: Record<string, string> };
  record: unknown;
  opening: unknown;
}

const vectors = (JSON.parse(vectorsRaw) as { vectors: Array<RecordVector> })
  .vectors;

// Local base64url decode so the browser suite does not depend on a core export
// beyond the record API under test.
function b64uToBytes(s: string): Uint8Array<ArrayBuffer> {
  const padded =
    s.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (s.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function randomnessFromVector(v: RecordVector): ExchangeRecordRandomness {
  const salts: ExchangeRecordRandomness["salts"] = {};
  for (const [name, value] of Object.entries(v.randomness.salts))
    salts[name as keyof typeof salts] = b64uToBytes(value);
  return { bindingNonce: b64uToBytes(v.randomness.bindingNonce), salts };
}

describe("exchange record in the browser", () => {
  test.each(vectors)(
    "$name: browser build matches the checked-in record vector",
    async (vector) => {
      const { record, opening } = await buildExchangeRecord(
        vector.inputs,
        randomnessFromVector(vector),
      );
      expect(record).toEqual(vector.record);
      expect(opening).toEqual(vector.opening);

      const { allValid } = await verifyRecordCommitments(record, opening);
      expect(allValid).toBe(true);
    },
  );
});
