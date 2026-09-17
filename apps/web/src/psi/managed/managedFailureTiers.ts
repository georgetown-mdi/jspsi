/**
 * The pure derivation of a managed exchange's failure tier from the record's own
 * evidence -- `lastRun.failureKind`, the standing condition beside it, a lapsed
 * `expires`, and the local `imported` marker -- never the live error, so an
 * unattended run's failure tiers the same way at the next visit as it would at
 * the moment it failed.
 * Design rationale for the desync-versus-attack tiering: docs/MANAGED_EXCHANGE.md,
 * "Telling a desync from an attack".
 *
 * Pure and platform-free: it reads a record and its import marker and returns a
 * tier. The confirmation MESSAGE and the two-outcome GATE are composed in the
 * sibling modules {@link ./managedFailureConfirmation.ts} and the display copy
 * in {@link ../recurring/managedRunLaunchModel.ts}; this module decides only which
 * tier.
 */

import { managedExchangeLapsed } from "./managedExpiry";
import { raisedStandingCondition } from "./managedExchangeRecord";

import type {
  ManagedExchangeRecord,
  ManagedStandingCondition,
} from "./managedExchangeRecord";
import type { ManagedLocalState } from "./managedLocalStateShape";

/**
 * The failure tier a record's bookkeeping resolves to. Each benign tier names a
 * specific recovery; only `"unexplained"` has the out-of-band confirmation.
 *
 * - `"expired"` -- the stored secret's age bound has lapsed (its own benign state;
 *   recovery: re-invite). Detected before any connection, so a live launch reaches it
 *   through the pre-connection check; kept here for a next-visit read of a record
 *   whose bound lapsed while dormant.
 * - `"input"` -- a benign pre-run input problem the last run recorded: the file was
 *   missing, unreadable, or gone from under its handle (recovery: put the file back
 *   and retry).
 * - `"terms-shortfall"` -- the last run read its input and refused before connecting
 *   because the file cannot supply every linkage key the standing terms declare
 *   (recovery: a file covering every agreed key, or terms re-agreed with the
 *   partner; never a retry or a bare re-pick, since the same file refuses
 *   identically at the next window).
 * - `"consent"` -- a benign pre-run refusal by one of the send-side disclosure gates:
 *   what this run would send is not the set the exchange recorded agreeing to send
 *   (recovery: re-confirm the disclosure; never a retry, since the same input refuses
 *   identically at the next window).
 * - `"handed-off"` -- the last run met a copy an export had handed off and refused
 *   before reading the input or connecting (recovery: none here; the exchange runs
 *   wherever the hand-off took it, and every later run on this device refuses the
 *   same way).
 * - `"missed"` -- the wait for the partner spent its whole budget with nobody
 *   arriving: an attended run's own wait expiring, or an agreed window passing without
 *   a completed handshake (recovery: the next window's automatic retry, or running the
 *   exchange again once the partner is ready).
 * - `"custody-unreadable"` -- the last run could not read the local entry recording
 *   whether this device's copy was handed off, and refused before reading the input
 *   or connecting (recovery: none here; nothing rotated and nothing desynced, and
 *   every later run refuses the same way while that entry cannot be read).
 * - `"storage"` -- a rotation the last run could not persist (recovery: re-invite; a
 *   one-sided persist failure may have desynced the two parties).
 * - `"imported"` -- a restore-from-backup, migration import, or key-file take-back
 *   since the last successful run (recovery: re-invite; a restored copy can hold a
 *   secret the partnership has rotated past).
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
  | "terms-shortfall"
  | "consent"
  | "handed-off"
  | "custody-unreadable"
  | "missed"
  | "storage"
  | "imported"
  | "transport"
  | "unexplained"
  | "none";

/**
 * Whether a record was restored from a backup and has not successfully run since --
 * the `imported` sibling marker's meaning. The marker is stamped at install/revive
 * and by a take-back that installs a secret from a command-line key file, and cleared
 * on the first rotation after one (a completed handshake proves the parties held the
 * same secret), so its mere presence is the "import since the last success" evidence
 * the desync tiering reads -- no timestamp comparison is needed, because a success
 * would have consumed it.
 */
export function importedSinceLastSuccess(
  local: ManagedLocalState | undefined,
): boolean {
  return local?.imported !== undefined;
}

/** A record's failure tier and where the evidence for it came from: the run
 * bookkeeping the record currently holds, or the standing condition beside it.
 * Surfaces read `standing` to phrase the state accurately -- a condition raised
 * by an earlier run is not a statement about the last one, which may have been a
 * no-show or a success. */
export interface ManagedFailureReading {
  /** The tier the record's evidence resolves to. */
  tier: ManagedFailureTier;
  /** Whether the standing condition supplied the tier rather than the record's
   * current run bookkeeping. */
  standing: boolean;
}

/** The tiers a standing condition can resolve to -- the three whose recovery is
 * re-invite or the out-of-band confirmation. A narrower union than
 * {@link ManagedFailureTier} so a surface phrasing a standing condition is
 * exhaustive over what one can actually say. */
export type ManagedStandingTier = "storage" | "imported" | "unexplained";

/** The tier a standing condition resolves to: a persist failure is the benign
 * Tier-1 storage state, and a failed-closed handshake is the benign import state
 * while a restore since the last success explains it and the Tier-2 unexplained
 * state otherwise -- the same reading {@link deriveManagedFailureTier} makes of
 * the equivalent `lastRun` entry, so a condition tiers identically whether it was
 * raised by the last run or five no-shows ago.
 *
 * Exported for the surface that shows the condition on its own, which must name
 * the state whether or not the record's current bookkeeping happens to be
 * showing it (see {@link ../../recurring/managedStandingConditionModel.ts}). */
export function managedStandingConditionTier(
  condition: ManagedStandingCondition,
  local: ManagedLocalState | undefined,
): ManagedStandingTier {
  if (condition.kind === "storage") return "storage";
  return importedSinceLastSuccess(local) ? "imported" : "unexplained";
}

/**
 * Read a record's failure tier and its source from the structured bookkeeping and
 * the local sibling state as of `now`. The recorded reading is
 * {@link recordedFailureTier}; the standing condition supplies the tier in two
 * places:
 *
 * - where the recorded reading has no failure to show (`"none"` from a success or
 *   a record never run, and `"missed"` from a no-show), which is what keeps a
 *   condition visible across the stamps that would otherwise consume it;
 * - where the recorded reading is `"unexplained"` and a standing persist failure
 *   explains it, which is Tier 1's "the record holds a benign explanation" made
 *   durable (docs/MANAGED_EXCHANGE.md, "Telling a desync from an attack").
 *
 * It does not displace a recorded benign cause: an input problem or a consent
 * refusal is this run's own actionable state, and the condition stands until
 * something clears it, so nothing is lost by showing that state first.
 */
export function readManagedFailure(
  record: ManagedExchangeRecord,
  local: ManagedLocalState | undefined,
  now: number,
): ManagedFailureReading {
  // Checked first: never routed through attack framing, matching the
  // pre-connection check.
  if (managedExchangeLapsed(record, now))
    return { tier: "expired", standing: false };
  const recorded = recordedFailureTier(record, local);
  const condition = raisedStandingCondition(record);
  if (condition === undefined) return { tier: recorded, standing: false };
  if (recorded === "none" || recorded === "missed")
    return {
      tier: managedStandingConditionTier(condition, local),
      standing: true,
    };
  if (recorded === "unexplained" && condition.kind === "storage")
    return { tier: "storage", standing: true };
  return { tier: recorded, standing: false };
}

/**
 * Derive the failure tier for a record from its structured bookkeeping and its
 * local sibling state as of `now` -- {@link readManagedFailure} without the
 * source, for a caller that only maps a tier to copy.
 */
export function deriveManagedFailureTier(
  record: ManagedExchangeRecord,
  local: ManagedLocalState | undefined,
  now: number,
): ManagedFailureTier {
  return readManagedFailure(record, local, now).tier;
}

/**
 * The tier the record's CURRENT run bookkeeping resolves to, in precedence
 * order: a recorded benign `lastRun` cause, then a restore since the last
 * success, and only then `"unexplained"` for a failed-closed (`auth`) handshake
 * with none of those. The lapse check is its caller's, mirroring the
 * pre-connection check's own position. Rationale for the ordering and the
 * secret-farming caveat: docs/MANAGED_EXCHANGE.md, "Telling a desync from an
 * attack".
 */
function recordedFailureTier(
  record: ManagedExchangeRecord,
  local: ManagedLocalState | undefined,
): ManagedFailureTier {
  const lastRun = record.lastRun;
  if (lastRun === undefined || lastRun.outcome === "succeeded") return "none";
  if (lastRun.outcome === "missed") return "missed";

  // A recorded benign pre-run input problem: its own tier, never desync/attack.
  if (lastRun.failureKind === "input") return "input";
  // A recorded pre-run linkage shortfall: benign like the input tier and equally
  // far from desync/attack, but held apart from it because re-picking the file the
  // input tier offers is not its remedy -- the same file refuses identically, so
  // this tier's copy names a conforming file or terms re-agreed with the partner.
  if (lastRun.failureKind === "terms-shortfall") return "terms-shortfall";
  // A recorded pre-run disclosure refusal: likewise its own benign tier, and kept
  // out of the retryable transport bucket -- its remedy is re-confirming what this
  // exchange sends, which no amount of reconnecting supplies.
  if (lastRun.failureKind === "consent") return "consent";
  // A recorded hand-off refusal: the copy this device held was given away, so the
  // failure is the single-owner invariant holding rather than anything to recover
  // from here -- and nothing about it is a desync or an attack.
  if (lastRun.failureKind === "handed-off") return "handed-off";
  // A recorded custody reading that did not complete: the run refused before the
  // handshake, so nothing rotated and nothing here is a desync signal. Held apart
  // from the storage tier below, whose copy and re-invite recovery both rest on a
  // rotation this device failed to save.
  if (lastRun.failureKind === "custody-unreadable") return "custody-unreadable";
  // A recorded persist failure on the last run: the rotation did not land, so a
  // one-sided persist may have desynced the parties and the recovery is re-invite
  // -- Tier 1, no attack checklist.
  if (lastRun.failureKind === "storage") return "storage";

  // A restore since the last success benignly explains only a failed-CLOSED
  // `auth` handshake -- a stale-secret restore does not bear on a transport
  // drop, which stays the retryable transport tier regardless of the marker.
  // Rationale and the secret-farming caveat: docs/MANAGED_EXCHANGE.md, "Telling
  // a desync from an attack".
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
