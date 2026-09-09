import { expect, test } from "vitest";

import { BIDI_CONTROL_PATTERN, TEXT_CONTROL_CHAR_PATTERN } from "@psilink/core";

import {
  IDENTITY_CONTROL_CHAR_PATTERN,
  IDENTITY_DIRECTION_CHAR_PATTERN,
} from "@jobs/intentSchemas";

// The two character rules the identity label passes through, held equal here so
// neither side can drift from the other under a cross-reference alone. An
// operator's `--identity` label is checked against IDENTITY_CONTROL_CHAR_PATTERN and
// IDENTITY_DIRECTION_CHAR_PATTERN at the browser guard, the intent schema, and
// the signing-fingerprint route, then against TEXT_CONTROL_CHAR_PATTERN and
// BIDI_CONTROL_PATTERN as a linkage-terms `identity`; the pairs must agree or a
// label valid at one route could fail at the other, or a certificate could bind
// a label the terms can never hold.

/**
 * Bound for the plane sweep below: 65536 synchronous pattern verdicts with no
 * wait in them. It runs 0.6s alone against vitest's 5s default, and 6.9s with
 * the rest of the unit suite competing for the same cores, which is the
 * contention that reddened it. Sized well past that worst measurement, this
 * stays a hang safety check rather than a claim about how fast the sweep runs.
 */
const PLANE_SWEEP_TIMEOUT_MS = 60_000;

test("the label rule and the terms free-text rule are the same pattern", () => {
  expect(IDENTITY_CONTROL_CHAR_PATTERN.source).toBe(
    TEXT_CONTROL_CHAR_PATTERN.source,
  );
  expect(IDENTITY_CONTROL_CHAR_PATTERN.flags).toBe(
    TEXT_CONTROL_CHAR_PATTERN.flags,
  );
});

test("the label direction rule and the terms direction rule are the same pattern", () => {
  expect(IDENTITY_DIRECTION_CHAR_PATTERN.source).toBe(
    BIDI_CONTROL_PATTERN.source,
  );
  expect(IDENTITY_DIRECTION_CHAR_PATTERN.flags).toBe(
    BIDI_CONTROL_PATTERN.flags,
  );
});

test(
  "the label contract and the terms rules agree on every code point in the plane",
  () => {
    // Source equality alone would pass two patterns written differently apart; this
    // sweeps every code point of the basic multilingual plane -- the ranges both
    // rules are drawn over, and the letters, marks and punctuation between them --
    // and compares the verdict a label holding each single character gets from the
    // two rules together, which is what each boundary applies.
    for (let codePoint = 0; codePoint <= 0xffff; codePoint++) {
      const label = `Agency${String.fromCodePoint(codePoint)}A`;
      expect({
        codePoint,
        refused:
          IDENTITY_CONTROL_CHAR_PATTERN.test(label) ||
          IDENTITY_DIRECTION_CHAR_PATTERN.test(label),
      }).toStrictEqual({
        codePoint,
        refused:
          TEXT_CONTROL_CHAR_PATTERN.test(label) ||
          BIDI_CONTROL_PATTERN.test(label),
      });
    }
  },
  PLANE_SWEEP_TIMEOUT_MS,
);

test("the direction marks are admitted and the nine formatting characters are not", () => {
  // The verdict sweep above holds the two sides equal; this pins WHICH verdict
  // each side gives, so a rule that came to refuse a right-to-left party name --
  // or to admit an override -- fails here rather than passing as agreement.
  for (const mark of ["\u200e", "\u200f", "\u061c"])
    expect(IDENTITY_DIRECTION_CHAR_PATTERN.test(`Agency${mark}A`)).toBe(false);
  for (const codePoint of [
    0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
  ])
    expect(
      IDENTITY_DIRECTION_CHAR_PATTERN.test(
        `Agency${String.fromCodePoint(codePoint)}A`,
      ),
    ).toBe(true);
});
