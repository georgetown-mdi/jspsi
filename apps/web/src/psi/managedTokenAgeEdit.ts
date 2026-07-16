/**
 * The conservative edit-time re-derivation of a managed record's `expires` bound
 * when the operator edits its `tokenMaxAgeDays` policy in place (a local-fields
 * edit, distinct from a run rotation or a re-invite). It is a security control:
 * an edit must never extend a stored credential's usable life without a rotation.
 *
 * What the spec anchors expiry to. The record's `expires` is stamped
 * `advance-instant + tokenMaxAgeDays` -- the anchor is the last secret advance
 * (a creation-time deposit, a run rotation, or a re-invite), NOT the setup (see
 * docs/spec/MANAGED_EXCHANGE_RECORD.md, the `expires` and `tokenMaxAgeDays` rows,
 * and the rotation write-back in {@link ./managedRunRotate.ts}). That anchor
 * instant is deliberately NOT persisted -- the record holds only the resulting
 * `expires` and the policy `tokenMaxAgeDays` -- so an editor cannot read it back
 * directly. When a policy was already in force it is reconstructable, since
 * `expires === anchor + oldDays` gives `anchor === expires - oldDays`.
 *
 * INTERPRETATION (flagged: the spec pins run/rotation/re-invite stamping but does
 * NOT address edit-time re-derivation). The rule here is the conservative reading:
 * a local edit may shorten or keep `expires`, and may add a bound where none
 * existed, but must NEVER push it later than the spec's derivation from the
 * existing anchor -- and, stricter still, never later than the current `expires`.
 * A longer policy set by an edit therefore does NOT lengthen a live credential; it
 * takes effect only at the next actual rotation, which restamps from the real
 * advance instant. The four cases:
 *
 * - Clear the policy (`null`): drop `expires` -- a dropped bound must not leave a
 *   stale instant armed, matching the rotation write-back's `null` clear.
 * - Add where none (no prior policy): stamp `now + newDays`. There is no anchor to
 *   reconstruct and no prior bound, so `now` is the only anchor; introducing a
 *   bound only tightens (unbounded -> bounded), never extends.
 * - Shorten (`newDays <= oldDays`): recompute strictly from the reconstructed
 *   anchor, `expires - oldDays + newDays`, which is at or before the current
 *   `expires`.
 * - Lengthen (`newDays > oldDays`): the anchor derivation would land later than
 *   the current `expires`, so keep the current `expires` -- the edit refuses to
 *   move it later. The longer policy applies at the next rotation.
 *
 * Uniformly: the new bound is `min(anchor + newDays, currentExpires)`, with `now`
 * as the anchor when no prior policy existed. `expires` never moves later on an
 * edit. `now` is injected so the derivation is pure and the moment of evaluation
 * is the caller's, matching the run+rotate module's clock discipline.
 */

import type { ManagedExchangeRecord } from "./managedExchangeRecord";

/** Milliseconds in a day, matching {@link ./managedRunRotate.ts}'s `MS_PER_DAY`
 * (the anchor derivation must use the same day length the stamp did). */
const MS_PER_DAY = 86_400_000;

/**
 * Derive the `expires` bound a local edit of `tokenMaxAgeDays` should write,
 * conservatively (never later than the current bound; see the module header).
 * Returns the ISO 8601 UTC instant to set, or `null` to clear any standing bound
 * (a cleared policy, or an add-where-none whose stamp is somehow unrepresentable).
 *
 * @param record The record before the edit; its current `expires` and
 *   `tokenMaxAgeDays` are the anchor inputs.
 * @param nextTokenMaxAgeDays The edited policy: a positive integer of days, or
 *   `null` to clear the policy.
 * @param now The instant an add-where-none stamp counts from.
 */
export function deriveEditedExpiry(
  record: Pick<ManagedExchangeRecord, "expires" | "tokenMaxAgeDays">,
  nextTokenMaxAgeDays: number | null,
  now: number,
): string | null {
  // A cleared policy drops the bound: a dropped policy must not leave a stale
  // instant armed (the same clear the rotation write-back applies for `null`).
  if (nextTokenMaxAgeDays === null) return null;

  const currentExpiresMs =
    record.expires === undefined ? undefined : Date.parse(record.expires);

  // Reconstruct the last-advance anchor. With a prior policy AND a parseable
  // current bound, `expires === anchor + oldDays`, so `anchor === expires -
  // oldDays`. Otherwise there is no anchor to reconstruct (add-where-none, or a
  // record whose `expires` is unparseable), and `now` is the only anchor.
  const anchorMs =
    record.tokenMaxAgeDays !== undefined &&
    currentExpiresMs !== undefined &&
    !Number.isNaN(currentExpiresMs)
      ? currentExpiresMs - record.tokenMaxAgeDays * MS_PER_DAY
      : now;

  const candidateMs = anchorMs + nextTokenMaxAgeDays * MS_PER_DAY;

  // Never move the bound later than the current one: a longer policy set by an
  // edit does not lengthen a live credential, it takes effect at the next
  // rotation. An add-where-none has no current bound to floor against.
  const boundedMs =
    currentExpiresMs !== undefined && !Number.isNaN(currentExpiresMs)
      ? Math.min(candidateMs, currentExpiresMs)
      : candidateMs;

  const bound = new Date(boundedMs);
  // A computed instant outside the representable range clears rather than throws:
  // an edit refusing to extend a credential must never harden into an unbounded
  // one on a bad stamp, and clearing is the conservative outcome (re-invite
  // recovers a mistaken clear).
  if (Number.isNaN(bound.getTime()) || bound.getUTCFullYear() > 9999)
    return null;
  return bound.toISOString();
}
