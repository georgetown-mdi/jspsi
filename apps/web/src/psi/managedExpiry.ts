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
 * in force); a record with no bound never lapses. The instant comparison itself
 * is core's, shared with the invitation acceptors so a bound cannot mean one
 * thing on one surface and another elsewhere.
 */

import { hasExpiryInstantPassed } from "@psilink/core";

import type { ManagedExchangeRecord } from "./managedExchangeRecord";

/**
 * Whether the record's stored secret has lapsed as of `now`: `true` when the
 * record carries an `expires` bound whose instant is at or before `now`. A
 * record with no bound (`expires` absent) never lapses. The comparison is
 * at-or-before, matching the spec's "the instant after which `sharedSecret` must
 * not be used" -- the boundary instant itself is already lapsed.
 *
 * Fails closed on a value the comparison cannot parse: the bound governs a
 * stored secret's usable lifetime, so an `expires` whose instant is unreadable
 * stops the secret being used rather than letting it run unbounded. A stored
 * record cannot carry one -- the schema validates `expires` as an ISO datetime
 * on every read -- so the direction only decides what an unreachable value
 * would do.
 */
export function managedExchangeLapsed(
  record: Pick<ManagedExchangeRecord, "expires">,
  now: number,
): boolean {
  return hasExpiryInstantPassed(record.expires, new Date(now), {
    onUnparseable: "fail-closed",
  });
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
