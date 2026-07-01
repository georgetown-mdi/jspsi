import { expect, test } from "vitest";

import {
  MAX_RECORD_COUNT,
  psiElementBounds,
} from "../src/connection/frameSize";
import { MAX_LINKAGE_ENTRIES } from "../src/config/linkageTerms";
import { recordCountMessage } from "../src/protocolSetup";

// ─── MAX_RECORD_COUNT: the cell-count gate's exact-product dependency, as a check ─
// The cell-count gate (singlePassDatasetExceedsCap) decides keyCount * recordCount
// > MAX_SINGLE_PASS_CELLS, and its precision argument holds only while that product
// is exact -- below 2^53. That once rested implicitly on the recordCount schema's
// `.int()` safe-integer ceiling; MAX_RECORD_COUNT makes it an explicit bound. This
// pins the guarantee so a future raise of MAX_LINKAGE_ENTRIES or MAX_RECORD_COUNT
// that would let the product lose precision fails here rather than silently
// corrupting the gate.

test("keyCount * recordCount stays an exact integer at the schema maxima", () => {
  const productAtMaxima = MAX_LINKAGE_ENTRIES * MAX_RECORD_COUNT;
  expect(productAtMaxima).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
  expect(Number.isSafeInteger(productAtMaxima)).toBe(true);
});

test("recordCountMessage rejects a record count above the explicit bound at decode", () => {
  // At the bound: accepted.
  expect(
    recordCountMessage.safeParse({ recordCount: MAX_RECORD_COUNT }).success,
  ).toBe(true);
  // One above the bound: a clean parse failure (a `too_big` issue), not a
  // silent pass that would feed the gate an inexact product. Over the wire this
  // is a `protocol` ConnectionError via receiveParsed.
  const overBound = recordCountMessage.safeParse({
    recordCount: MAX_RECORD_COUNT + 1,
  });
  expect(overBound.success).toBe(false);
  // The prior `.int().nonnegative()` bounds still hold.
  expect(recordCountMessage.safeParse({ recordCount: -1 }).success).toBe(false);
  expect(recordCountMessage.safeParse({ recordCount: 1.5 }).success).toBe(
    false,
  );
});

// ─── psiElementBounds: authenticated per-message decode-seam caps ──────────────
// Both parties derive identical bounds from the agreed key count and the two
// exchanged record counts. The setup carries the sender's set; the request and the
// response (which re-encrypts that request) carry the receiver's.

test("psiElementBounds maps each message kind to keyCount * the relevant party's count", () => {
  const bounds = psiElementBounds(3, 10, 7);
  expect(bounds.setup).toBe(3 * 10); // sender's set
  expect(bounds.request).toBe(3 * 7); // receiver's set
  expect(bounds.response).toBe(3 * 7); // re-encrypted receiver's set
});
