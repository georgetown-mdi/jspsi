/// <reference types="@vitest/browser-playwright/context" />
/// <reference types="vite/client" />

import { describe, expect, test } from "vitest";

import {
  buildExchangeRecord,
  parseExchangeRecord,
  parseOpeningData,
  serializeExchangeRecord,
  serializeOpeningData,
  verifyRecordCommitments,
} from "@psilink/core";

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

// The acceptance-criteria coverage for "bring the exchange record to the web
// app": the two facets the vector replay above does not exercise on its own --
// the serialize -> parse round-trip of a record the web app produces, and an
// explicit web <-> CLI cross-verification -- both run here in the real browser
// runtime so they prove the WEB build's behavior, not Node's.
describe("web-produced record: round-trip and cross-verification", () => {
  // A record the web app produces survives the on-disk/download form. Built with
  // real CSPRNG randomness (no injected `randomness`) so it is a genuine web
  // record rather than a vector replay, then serialized, parsed back, and its
  // commitments re-verified through that boundary -- the serialize -> parse
  // round-trip the acceptance criteria call for. Iterating the vector inputs runs
  // it across every governance/commitment shape (with and without an association
  // table, legal agreement, or retention pointer).
  test.each(vectors)(
    "$name: a web-built record round-trips through serialize -> parse and re-verifies",
    async (vector) => {
      const { record, opening } = await buildExchangeRecord(vector.inputs);
      const parsedRecord = parseExchangeRecord(
        JSON.parse(serializeExchangeRecord(record)),
      );
      const parsedOpening = parseOpeningData(
        JSON.parse(serializeOpeningData(opening)),
      );
      expect(parsedRecord).toEqual(record);
      expect(parsedOpening).toEqual(opening);

      const { allValid } = await verifyRecordCommitments(
        parsedRecord,
        parsedOpening,
      );
      expect(allValid).toBe(true);
    },
  );

  // Cross-verification across runtimes. The checked-in vectors are the CLI/Node
  // side of the contract -- the Node suite in
  // packages/core/test/exchangeRecord.test.ts builds and verifies them -- so
  // parsing a vector's record/opening here and verifying its commitments proves
  // the web build verifies a CLI-produced record. The reverse direction (the CLI
  // verifies a web-produced record) follows from byte-identity: the vector-replay
  // suite above asserts the web build reproduces this exact record and opening,
  // and the Node suite verifies that same pair, so the CLI verifies the
  // byte-identical web record.
  test.each(vectors)(
    "$name: the web build verifies a CLI-produced record",
    async (vector) => {
      const record = parseExchangeRecord(vector.record);
      const opening = parseOpeningData(vector.opening);

      const { allValid } = await verifyRecordCommitments(record, opening);
      expect(allValid).toBe(true);
    },
  );
});
