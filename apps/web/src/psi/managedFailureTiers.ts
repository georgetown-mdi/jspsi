/**
 * The pure derivation of a managed exchange's FAILURE TIER from what the record
 * already knows -- the desync-versus-attack tiering (see docs/MANAGED_EXCHANGE.md,
 * "Telling a desync from an attack"). The web handshake wrapper collapses every
 * trust failure into one `security`-kind error, so the tool cannot cryptographically
 * tell a rotation desync from an attack. What it CAN do is read the record's
 * structured bookkeeping and surface the failure through the tier that bookkeeping
 * explains, reserving the full out-of-band confirmation for a failure nothing else
 * explains.
 *
 * The tier is DERIVED from the record's evidence, never guessed, and never read from
 * the live error -- a failure from an unattended run surfaces through the same tiers
 * at the next visit. The evidence is:
 *
 * - `lastRun.failureKind` -- the structured enum the runner and the critical section
 *   stamp (`auth` \| `transport` \| `storage` \| `input` \| `cancelled`);
 * - a lapsed `expires` (its own state, detected before any connection; handled by the
 *   pre-connection check, mirrored here for a next-visit read);
 * - an import/restore since the last successful run -- the local `imported` sibling
 *   marker, cleared on the first rotation after an import (a completed handshake
 *   proves the parties were in sync), so its presence alone means "restored and not
 *   yet successfully run since" (see {@link ./managedExchangeStore.ts}).
 *
 * Benign tiers get plain, specific copy naming their specific recovery; only the
 * unexplained tier gets the attack checklist. The secret-farming caveat is load-
 * bearing: an active impersonator wants the operator to reach a benign reading, so a
 * benign tier is surfaced ONLY when the record's own structured evidence explains the
 * failure, never as the default reading of an unexplained one.
 *
 * Pure and platform-free: it reads a record and its import marker and returns a tier.
 * The confirmation MESSAGE and the two-outcome GATE are composed in the sibling
 * modules {@link ./managedFailureConfirmation.ts} and the display copy in
 * {@link ../bench/managedRunLaunchModel.ts}; this module decides only which tier.
 */

import { managedExchangeLapsed } from "./managedExpiry";

import type { ManagedExchangeRecord } from "./managedExchangeRecord";
import type { ManagedLocalState } from "./managedLocalStateShape";

/**
 * The failure tier a record's bookkeeping resolves to. Each benign tier names a
 * specific recovery; only `"unexplained"` carries the out-of-band confirmation.
 *
 * - `"expired"` -- the stored secret's age bound has lapsed (its own benign state;
 *   recovery: re-invite). Detected before any connection, so a live launch reaches it
 *   through the pre-connection check; carried here for a next-visit read of a record
 *   whose bound lapsed while dormant.
 * - `"input"` -- a benign pre-run input problem the last run recorded (a missing file
 *   or a rejected column shape; recovery: fix the input and retry).
 * - `"missed"` -- an agreed window passed without a completed handshake (recovery:
 *   automatic retry at the next window; no action). Never a live-launch tier.
 * - `"storage"` -- a recorded persist failure on the last run (recovery: re-invite;
 *   a one-sided persist failure may have desynced the two parties).
 * - `"imported"` -- a restore-from-backup or migration import since the last
 *   successful run (recovery: re-invite; a restored copy can hold a secret the
 *   partnership has rotated past).
 * - `"transport"` -- a connection or data-exchange drop that is not a failed-closed
 *   handshake (recovery: retry; a temporary connection problem, not a trust failure).
 * - `"unexplained"` -- a handshake that failed closed (`auth`) with no recorded
 *   benign explanation: the full out-of-band confirmation and the two-outcome gate.
 * - `"none"` -- the record records no failure to tier (never run, or last run
 *   succeeded).
 */
export type ManagedFailureTier =
  | "expired"
  | "input"
  | "missed"
  | "storage"
  | "imported"
  | "transport"
  | "unexplained"
  | "none";

/**
 * Whether a record was restored from a backup and has not successfully run since --
 * the `imported` sibling marker's meaning. The marker is stamped at install/revive
 * and cleared on the first rotation after an import (a completed handshake proves the
 * parties held the same secret), so its mere presence is the "import since the last
 * success" evidence the desync tiering reads -- no timestamp comparison is needed,
 * because a success would have consumed it.
 */
export function importedSinceLastSuccess(
  local: ManagedLocalState | undefined,
): boolean {
  return local?.imported !== undefined;
}

/**
 * Derive the failure tier for a record from its structured bookkeeping and its local
 * sibling state as of `now`. The order encodes the tiering's precedence: a lapsed
 * bound is its own state (checked first, mirroring the pre-connection check that never
 * lets expiry reach attack framing); a recorded benign `lastRun` cause surfaces as its
 * specific tier; a restore since the last success explains an otherwise-unexplained
 * handshake failure; and only a failed-closed handshake (`auth`) with none of those
 * explanations reaches `"unexplained"`.
 *
 * The evidence is the record's own -- `lastRun.failureKind`, `expires`, and the local
 * import marker -- never the live error, so an unattended run's failure surfaces
 * through the same tier at the next visit as an attended one does at the moment it
 * fails. A benign tier is never the DEFAULT reading of an unexplained failure: it is
 * returned only when the record's structured evidence explains the failure, so an
 * active impersonator cannot farm a benign reading (the secret-farming caveat).
 */
export function deriveManagedFailureTier(
  record: ManagedExchangeRecord,
  local: ManagedLocalState | undefined,
  now: number,
): ManagedFailureTier {
  // A lapsed bound is its own state and never routed through attack framing, exactly
  // as the pre-connection check keeps it: checked first so a record that lapsed while
  // dormant reads as expiry at the next visit, whatever its last recorded run was.
  if (managedExchangeLapsed(record, now)) return "expired";

  const lastRun = record.lastRun;
  if (lastRun === undefined || lastRun.outcome === "succeeded") return "none";
  if (lastRun.outcome === "missed") return "missed";

  // A recorded benign pre-run input problem: its own tier, never desync/attack.
  if (lastRun.failureKind === "input") return "input";
  // A recorded persist failure on the last run: a one-sided persist may have
  // desynced the parties, so the recovery is re-invite -- Tier 1, no attack checklist.
  if (lastRun.failureKind === "storage") return "storage";

  // A restore since the last success explains a failed-CLOSED handshake benignly: the
  // restored copy can hold a secret the partnership rotated past, so the handshake
  // fails to authenticate and a re-invite recovers it. Only an `auth` failure is what
  // a stale-secret restore explains -- a transport drop is a connection problem the
  // marker does not bear on, so it stays the retryable transport tier regardless of a
  // standing marker (see docs/MANAGED_EXCHANGE.md, "Telling a desync from an attack").
  // This precedes the unexplained reading precisely because naming a benign cause is
  // only honest when the record's own evidence supplies it -- the marker is consumed by
  // any successful run, so its presence is real evidence, not a guess.
  if (lastRun.failureKind === "auth" && importedSinceLastSuccess(local))
    return "imported";

  // A connection or data-exchange drop that is not a failed-closed handshake: a
  // temporary transport problem, retried, never attack framing.
  if (lastRun.failureKind === "transport") return "transport";

  // A cancelled run is the operator's own doing, not a failure to tier: retry.
  if (lastRun.failureKind === "cancelled") return "transport";

  // A handshake that failed closed (`auth`) with no recorded benign explanation: the
  // one failure that needs the operator's out-of-band confirmation work.
  return "unexplained";
}
