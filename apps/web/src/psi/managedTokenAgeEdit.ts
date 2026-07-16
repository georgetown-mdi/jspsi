/**
 * The conservative edit-time re-derivation of a managed record's `expires` bound
 * when the operator edits its `tokenMaxAgeDays` policy in place (a local-fields
 * edit, distinct from a run rotation or a re-invite). The normative rule -- an edit
 * never moves `expires` later, the anchor reconstruction, the four cases, and the
 * decoupling consequence -- is in docs/spec/MANAGED_EXCHANGE_RECORD.md,
 * "Edit-time re-derivation of `expires`". This module implements it; the checks
 * below carry only the constraints the code shows.
 *
 * `now` is injected so the derivation is pure and the moment of evaluation is the
 * caller's, matching the run+rotate module's clock discipline.
 */

import type { ManagedExchangeRecord } from "./managedExchangeRecord";

/** Milliseconds in a day, matching {@link ./managedRunRotate.ts}'s `MS_PER_DAY`
 * (the anchor derivation must use the same day length the stamp did). */
const MS_PER_DAY = 86_400_000;

/**
 * Derive the `expires` bound a local edit of `tokenMaxAgeDays` should write,
 * conservatively (never later than the current bound; see the spec section the
 * module header cites). Returns the ISO 8601 UTC instant to set, or `null` to clear
 * any standing bound (a cleared policy, or an add-where-none whose stamp is somehow
 * unrepresentable).
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
