import { expect, test } from "vitest";

import {
  MAX_FRAME_SIZE_BYTES,
  MAX_PSI_DECODE_ELEMENTS,
  MAX_RECORD_COUNT,
  psiElementBounds,
} from "../src/connection/frameSize";
import { MAX_LINKAGE_ENTRIES } from "../src/config/linkageTerms";
import { recordCountField } from "../src/protocolSetup";

// --- MAX_RECORD_COUNT: the cell-count gate's exact-product dependency, as a check -
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

test("recordCountField rejects a record count above the explicit bound at decode", () => {
  // The field rides the terms-exchange envelope (recordCount on termsMessage /
  // termsWithDecisionMessage); its bound is what keeps the cell-count gate exact.
  // At the bound: accepted.
  expect(recordCountField.safeParse(MAX_RECORD_COUNT).success).toBe(true);
  // One above the bound: a clean parse failure (a `too_big` issue), not a
  // silent pass that would feed the gate an inexact product. Over the wire this
  // is a `protocol` ConnectionError via receiveParsed.
  expect(recordCountField.safeParse(MAX_RECORD_COUNT + 1).success).toBe(false);
  // The prior `.int().nonnegative()` bounds still hold.
  expect(recordCountField.safeParse(-1).success).toBe(false);
  expect(recordCountField.safeParse(1.5).success).toBe(false);
});

// --- psiElementBounds: authenticated per-message decode-seam caps --------------
// Both parties derive identical bounds from the agreed key count and the two
// exchanged record counts. The setup carries the sender's set; the request and the
// response (which re-encrypts that request) carry the receiver's.

test("psiElementBounds maps each message kind to keyCount * the relevant party's count", () => {
  const bounds = psiElementBounds(3, 10, 7);
  expect(bounds.setup).toBe(3 * 10); // sender's set
  expect(bounds.request).toBe(3 * 7); // receiver's set
  expect(bounds.response).toBe(3 * 7); // re-encrypted receiver's set
});

// --- MAX_PSI_DECODE_ELEMENTS: the pre-deserialize ceiling's two security props --
// The absolute element ceiling (connection/psiElementScan.ts is the enforcer) rests
// on two numeric properties. Both are derived from MAX_FRAME_SIZE_BYTES and the
// per-element sizes, so a future edit to either input could silently break one --
// pin them here.

test("MAX_PSI_DECODE_ELEMENTS admits every legitimate frame yet bounds deserialize memory", () => {
  // (a) Never rejects a legitimate frame: the ceiling is at least the most real
  // elements a max-size frame can carry (a real element is a ~33-byte curve point
  // plus protobuf framing, ~35 bytes on the wire), so any frame the byte cap admits
  // clears the element ceiling too.
  const REAL_ELEMENT_WIRE_BYTES = 35;
  const maxLegitimateElements = Math.floor(
    MAX_FRAME_SIZE_BYTES / REAL_ELEMENT_WIRE_BYTES,
  );
  expect(MAX_PSI_DECODE_ELEMENTS).toBeGreaterThanOrEqual(maxLegitimateElements);

  // (b) Bounds the deserialize allocation: at the measured ~211 bytes the protobuf
  // deserializer allocates per declared element, the worst ceiling-passing frame
  // stays well under the 16 GiB target (a 4 GiB guard here), so it cannot OOM.
  const DESERIALIZE_BYTES_PER_ELEMENT = 211;
  expect(MAX_PSI_DECODE_ELEMENTS * DESERIALIZE_BYTES_PER_ELEMENT).toBeLessThan(
    4 * 1024 ** 3,
  );
});
