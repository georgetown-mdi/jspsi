import { expect, test } from "vitest";

import { TEXT_CONTROL_CHAR_PATTERN } from "@psilink/core";

import { IDENTITY_CONTROL_CHAR_PATTERN } from "@psi/identityLabel";

// The two control-character rules the identity label passes through, held equal
// here rather than by the cross-reference each file used to hold. An operator's
// `--identity` label is checked against IDENTITY_CONTROL_CHAR_PATTERN at the
// browser guard, the intent schema, and the signing-fingerprint route, then
// against TEXT_CONTROL_CHAR_PATTERN as a linkage-terms `identity`; the two
// patterns must agree or a label valid at one route could fail at the other.

test("the label rule and the terms free-text rule are the same pattern", () => {
  expect(IDENTITY_CONTROL_CHAR_PATTERN.source).toBe(
    TEXT_CONTROL_CHAR_PATTERN.source,
  );
  expect(IDENTITY_CONTROL_CHAR_PATTERN.flags).toBe(
    TEXT_CONTROL_CHAR_PATTERN.flags,
  );
});

test("the two rules return the same verdict on every code point up to U+00FF", () => {
  // Source equality alone would pass two patterns written differently apart; this
  // sweeps the range the rules are drawn over (C0, DEL, C1, and the printable and
  // Latin-1 characters on either side of them) and compares the verdicts a label
  // holding each single character gets.
  for (let codePoint = 0; codePoint <= 0xff; codePoint++) {
    const label = `Agency${String.fromCodePoint(codePoint)}A`;
    expect({
      codePoint,
      refused: IDENTITY_CONTROL_CHAR_PATTERN.test(label),
    }).toStrictEqual({
      codePoint,
      refused: TEXT_CONTROL_CHAR_PATTERN.test(label),
    });
  }
});
