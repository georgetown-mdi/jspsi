import { describe, expect, test } from "vitest";

import { deriveEditedExpiry } from "@psi/managedTokenAgeEdit";

// The conservative edit-time re-derivation of `expires` when the operator edits the
// max-token-age policy in place. The security invariant: an edit never pushes
// `expires` later than the spec's derivation from the existing advance anchor, and
// never later than the current bound -- so an edit cannot stretch a stored
// credential's life without a rotation (docs/spec/MANAGED_EXCHANGE_RECORD.md, the
// `expires` and `tokenMaxAgeDays` rows). The clock is injected.

const MS_PER_DAY = 86_400_000;
// The anchor (last secret advance) in these cases: a policy of 90 days stamped
// `expires` 90 days after this instant.
const ANCHOR = Date.parse("2026-01-01T00:00:00.000Z");
const EXPIRES_90 = new Date(ANCHOR + 90 * MS_PER_DAY).toISOString();
// A "now" well after the anchor, so an add-where-none stamp is distinguishable from
// an anchor-derived one.
const NOW = ANCHOR + 200 * MS_PER_DAY;

describe("deriveEditedExpiry", () => {
  test("shorten: recomputes from the reconstructed anchor, earlier than the current bound", () => {
    // 90-day policy -> 30-day policy. The anchor is expires - 90d, so the new bound
    // is anchor + 30d = the current bound minus 60 days.
    const result = deriveEditedExpiry(
      { expires: EXPIRES_90, tokenMaxAgeDays: 90 },
      30,
      NOW,
    );
    expect(result).toBe(new Date(ANCHOR + 30 * MS_PER_DAY).toISOString());
    // Strictly earlier than the current bound.
    expect(Date.parse(result as string)).toBeLessThan(Date.parse(EXPIRES_90));
  });

  test("keep: an unchanged policy leaves the bound at the current instant", () => {
    const result = deriveEditedExpiry(
      { expires: EXPIRES_90, tokenMaxAgeDays: 90 },
      90,
      NOW,
    );
    expect(result).toBe(EXPIRES_90);
  });

  test("lengthen: keeps the current bound; a longer policy never moves expiry later", () => {
    // 90-day policy -> 365-day policy. The anchor derivation would land later than
    // the current bound, so the edit refuses to move it later and keeps the current
    // `expires`. The longer policy takes effect only at the next rotation.
    const result = deriveEditedExpiry(
      { expires: EXPIRES_90, tokenMaxAgeDays: 90 },
      365,
      NOW,
    );
    expect(result).toBe(EXPIRES_90);
    expect(Date.parse(result as string)).toBeLessThanOrEqual(
      Date.parse(EXPIRES_90),
    );
  });

  test("add where none: stamps now + days when no prior policy or bound existed", () => {
    const result = deriveEditedExpiry(
      { expires: undefined, tokenMaxAgeDays: undefined },
      30,
      NOW,
    );
    expect(result).toBe(new Date(NOW + 30 * MS_PER_DAY).toISOString());
  });

  test("clear: dropping the policy clears the bound", () => {
    expect(
      deriveEditedExpiry(
        { expires: EXPIRES_90, tokenMaxAgeDays: 90 },
        null,
        NOW,
      ),
    ).toBeNull();
  });

  test("clear on a record that had no bound is still a cleared bound", () => {
    expect(
      deriveEditedExpiry(
        { expires: undefined, tokenMaxAgeDays: undefined },
        null,
        NOW,
      ),
    ).toBeNull();
  });

  test("policy present but bound absent stamps now + days, not an anchor-derived value", () => {
    // The import-reachable {tokenMaxAgeDays present, expires absent} state: there is
    // a policy but no reconstructable bound, so the arm discriminates on bound-
    // existence and anchors on now (the edit instant), exactly as an add-where-none
    // does -- never an anchor derived from a non-existent bound.
    const result = deriveEditedExpiry(
      { expires: undefined, tokenMaxAgeDays: 90 },
      30,
      NOW,
    );
    expect(result).toBe(new Date(NOW + 30 * MS_PER_DAY).toISOString());
  });

  test("an unparseable stored bound falls back to now as the anchor rather than extending", () => {
    // A corrupted or unparseable `expires` gives no anchor to reconstruct, so the
    // stamp anchors on now; with no parseable current bound to floor against, it is
    // the plain now + days, never a value derived from the bad bound.
    const result = deriveEditedExpiry(
      { expires: "not-a-date", tokenMaxAgeDays: 90 },
      30,
      NOW,
    );
    expect(result).toBe(new Date(NOW + 30 * MS_PER_DAY).toISOString());
  });

  test("an over-large add clears rather than hardens into an unbounded credential", () => {
    // A day count whose stamp overflows the representable range clears the bound
    // (the conservative outcome) rather than throwing or leaving it unbounded.
    const result = deriveEditedExpiry(
      { expires: undefined, tokenMaxAgeDays: undefined },
      100_000_000,
      NOW,
    );
    expect(result).toBeNull();
  });
});
