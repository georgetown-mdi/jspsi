import { expect, test } from "vitest";

import {
  MAX_FRAME_SIZE_BYTES,
  MAX_PSI_DECODE_ELEMENTS,
  MAX_RECORD_COUNT,
  psiElementBounds,
} from "../src/connection/frameSize";
import { MAX_LINKAGE_ENTRIES } from "../src/config/linkageTerms";
import {
  MAX_EFFECTIVE_KEY_COUNT,
  MAX_KEY_CANDIDATE_WIDTH,
} from "../src/fanOutFunctions";
import { recordCountField } from "../src/protocolSetup";

// --- MAX_RECORD_COUNT: the slot-count gate's exact-product dependency -------
// The slot-count gate (singlePassDatasetExceedsCap) decides effectiveKeyCount
// * recordCount > MAX_SINGLE_PASS_CELLS, and its precision argument holds
// only while that product is exact -- below 2^53. That once rested
// implicitly on the recordCount schema's `.int()` safe-integer ceiling;
// MAX_RECORD_COUNT makes it explicit. The check is against the EFFECTIVE key
// count (a declared width multiplies it), so a future raise of
// MAX_EFFECTIVE_KEY_COUNT or MAX_RECORD_COUNT that would cost the product
// precision fails here instead of silently corrupting the gate.

test("effectiveKeyCount * recordCount stays an exact integer at the schema maxima", () => {
  const productAtMaxima = MAX_EFFECTIVE_KEY_COUNT * MAX_RECORD_COUNT;
  expect(productAtMaxima).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
  expect(Number.isSafeInteger(productAtMaxima)).toBe(true);
});

// The critical half of the same assumption: what keeps the product exact is
// that the ceiling binds the SUM of the per-key widths. Bounding each key at
// MAX_KEY_CANDIDATE_WIDTH and letting MAX_LINKAGE_ENTRIES of them stand would put
// the product past 2^53, so a change that re-keyed the ceiling onto the per-key
// width fails here rather than corrupting the gate silently.
test("bounding the per-key width alone would lose the exact product", () => {
  const perKeyCeilingSum = MAX_LINKAGE_ENTRIES * MAX_KEY_CANDIDATE_WIDTH;
  expect(perKeyCeilingSum).toBeGreaterThan(MAX_EFFECTIVE_KEY_COUNT);
  expect(Number.isSafeInteger(perKeyCeilingSum * MAX_RECORD_COUNT)).toBe(false);
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

// --- psiElementBounds: authenticated per-message decode-boundary caps --------
// Both parties derive identical bounds from the two exchanged record counts and
// the two declared effective key counts. The setup holds the sender's set; the
// request and the response (which re-encrypts that request) hold the
// receiver's.

test("psiElementBounds maps each message kind to the relevant party's value slots", () => {
  const bounds = psiElementBounds(
    { effectiveKeyCount: 3, recordCount: 10 },
    { effectiveKeyCount: 3, recordCount: 7 },
  );
  expect(bounds.setup).toBe(3 * 10); // sender's set
  expect(bounds.request).toBe(3 * 7); // receiver's set
  expect(bounds.response).toBe(3 * 7); // re-encrypted receiver's set
});

test("psiElementBounds widens with the fanning-out party alone", () => {
  // A fan-out multiplies only its own party's slots, so a sender that fans out
  // does not loosen the bound on the receiver's request -- the bound each party
  // enforces stays derived from the OTHER party's own declaration.
  const bounds = psiElementBounds(
    { effectiveKeyCount: 22, recordCount: 10 },
    { effectiveKeyCount: 3, recordCount: 7 },
  );
  expect(bounds.setup).toBe(22 * 10);
  expect(bounds.request).toBe(3 * 7);
  expect(bounds.response).toBe(3 * 7);
});

// --- MAX_PSI_DECODE_ELEMENTS: the pre-deserialize ceiling's two security props --
// The absolute element ceiling (connection/psiElementScan.ts is the enforcer) rests
// on two numeric properties. Both are derived from MAX_FRAME_SIZE_BYTES and the
// per-element sizes, so a future edit to either input could silently break one --
// pin them here.

test("MAX_PSI_DECODE_ELEMENTS admits every legitimate frame yet bounds deserialize memory", () => {
  // (a) Never rejects a legitimate frame: the ceiling is at least the most real
  // elements a max-size frame can hold (a real element is a ~33-byte curve
  // point plus protobuf framing, ~35 bytes on the wire), so any frame the byte
  // cap admits clears the element ceiling too.
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
