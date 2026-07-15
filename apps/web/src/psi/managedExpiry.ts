/**
 * The pure, platform-free lapsed-`expires` check the managed re-run applies
 * BEFORE any connection: a record whose `expires` instant is in the past must
 * not run, and the check happens before rendezvous so the lapse is unambiguous
 * -- it surfaces as its own benign expiry state with plain re-invite copy, never
 * routed through the desync/attack framing (see docs/MANAGED_EXCHANGE.md,
 * "Expiry is its own state"). `now` is injected so the decision is pure and the
 * moment of evaluation is the caller's, matching the run+rotate module's clock
 * discipline.
 *
 * The age bound is optional and off by default (an absent `expires` is no bound
 * in force); a record with no bound never lapses. A malformed `expires` reaching
 * here is impossible for a stored record (the schema validates it as an ISO
 * datetime on every read), but an unparseable value is treated as not lapsed
 * rather than silently blocking, so the check can only refuse a genuinely-past
 * bound.
 */

import type { ManagedExchangeRecord } from "./managedExchangeRecord";

/**
 * Whether the record's stored secret has lapsed as of `now`: `true` when the
 * record carries an `expires` bound whose instant is at or before `now`. A
 * record with no bound (`expires` absent) never lapses. The comparison is
 * at-or-before, matching the spec's "the instant after which `sharedSecret` must
 * not be used" -- the boundary instant itself is already lapsed.
 */
export function managedExchangeLapsed(
  record: Pick<ManagedExchangeRecord, "expires">,
  now: number,
): boolean {
  if (record.expires === undefined) return false;
  const expiresAt = Date.parse(record.expires);
  if (Number.isNaN(expiresAt)) return false;
  return expiresAt <= now;
}

/**
 * Raised when a managed re-run is launched against a record whose stored secret
 * has lapsed, detected before any connection. Distinct from a handshake or
 * input failure so the run driver records the benign expiry bookkeeping and the
 * surface shows the plain re-invite copy, never the desync/attack framing. The
 * lapsed instant rides the error so the surface can name it.
 */
export class ManagedExchangeExpiredError extends Error {
  /** The lapsed `expires` instant (ISO 8601 UTC) the record carried. */
  readonly expires: string;
  constructor(expires: string) {
    super("managed exchange stored secret has lapsed; re-invite to run again");
    this.name = "ManagedExchangeExpiredError";
    this.expires = expires;
  }
}
