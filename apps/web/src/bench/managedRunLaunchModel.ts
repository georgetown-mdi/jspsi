/**
 * The pure model behind the managed re-run's launch surface: the classification of a
 * launch outcome into what the surface shows -- the copy and the recovery affordance
 * for each state. No React, no I/O -- the run driver and the store live in the
 * component; this decides which state, its copy, and its recovery, so the surface
 * stays thin and the classification is unit-testable.
 *
 * Two layers feed a surface state:
 *
 * - The benign states read from the launch error: a lapsed `expires`, an input
 *   problem, a run already in progress elsewhere, or a partner who never arrived.
 *   These are unambiguous (no handshake ran), so they surface as their own plain,
 *   non-alarming copy directly from the error.
 * - The RECORDED tiers, derived from the record's own structured bookkeeping (see
 *   {@link deriveManagedFailureTier}): a recorded persist failure, a restore/import
 *   since the last success, a pre-connection disclosure refusal or linkage
 *   shortfall, a transport drop, or -- only when nothing else explains a
 *   failed-closed handshake -- the unexplained
 *   tier that carries the full out-of-band confirmation. The tier is derived from the
 *   record's evidence, never the live error, so a failure from an unattended run
 *   surfaces through the same tiers at the next visit.
 *
 * The recovery affordance the classification names then has copy of its own: the
 * re-invite callout reads differently for each side, so {@link
 * managedReinviteRecoveryCopy} composes it from the record's own `side`.
 *
 * Copy discipline: every benign tier gets plain, specific, non-alarming copy naming
 * one recovery action; only the unexplained tier follows the doc's attack framing
 * (out-of-band confirmation, then the two-outcome gate). No tier's copy echoes a
 * partner-influenced value -- the only interpolated value is the record's own local
 * `expires`.
 */

import {
  ManagedExchangeExpiredError,
  benignRerunOutcome,
} from "@psi/managedRun";
import { canReinviteFromRecord } from "@psi/managedReinvite";
import { deriveManagedFailureTier } from "@psi/managedFailureTiers";

import { dateTimeLabel } from "./inviterModel";

import type { ManagedExchangeRecord } from "@psi/managedExchangeRecord";
import type { ManagedFailureTier } from "@psi/managedFailureTiers";
import type { ManagedLocalState } from "@psi/managedLocalState";

/** The recovery affordance a surface state offers. It drives what the host renders
 * below the alert -- the recovery block, and through {@link managedRunRetryable}
 * whether the saved-exchanges footer stands beside it. The state's copy is a sibling
 * field authored alongside it, not derived from it. It is not a gate on the run
 * control, which the surface enables from the input source and the device's
 * connectivity alone.
 *
 * - `"reinvite"` -- fast re-invite is the recovery (a lapsed, desynced, restored, or
 *   persist-failed exchange). The inviter side re-mints from the stored document; the
 *   acceptor side asks the partner to re-invite (the surface names which).
 * - `"retry"` -- retryable in place (fix the input, or retry a transport drop).
 * - `"wait"` -- not this run's to act on (a run in progress elsewhere).
 * - `"confirm"` -- the Tier-2 out-of-band confirmation and the two-outcome gate.
 * - `"reconfirm"` -- what this exchange sends must be settled again before it can
 *   run: the run's own input decides the set, so neither retrying the connection nor
 *   re-minting the secret changes the outcome. Deliberately not `"retry"`, so the
 *   state's copy and the affordances beside it point at settling the disclosure
 *   rather than at repeating the run.
 * - `"restate"` -- what this exchange matches on must be settled again, or the
 *   input replaced: the file cannot supply every agreed linkage key, and the same
 *   file refuses identically however many times it runs. Deliberately not
 *   `"retry"`, for the reason `"reconfirm"` is not.
 * - `"none"` -- nothing to recover (informational; e.g. a missed window). */
export type ManagedRunRecovery =
  "reinvite" | "retry" | "wait" | "confirm" | "reconfirm" | "restate" | "none";

/** A classified launch state, ready to render: the state's kind (the pre-connection
 * benign states plus the derived tiers), its plain copy, and the recovery affordance
 * the host renders. */
export interface ManagedRunFailure {
  /** The state's kind. The benign states read from the error, plus the recorded
   * tiers derived from the record's bookkeeping. */
  kind:
    | "expired"
    | "input"
    | "terms-shortfall"
    | "consent"
    | "already-running"
    | "missed"
    | "storage"
    | "imported"
    | "transport"
    | "unexplained";
  /** The surface title. */
  title: string;
  /** The operator-facing message. */
  message: string;
  /** The recovery affordance the host renders. */
  recovery: ManagedRunRecovery;
}

/** The benign expiry state's copy: a lapsed stored secret, plain re-invite framing
 * (see docs/MANAGED_EXCHANGE.md, "Expiry is its own state"), naming the lapsed instant
 * the error carries so the operator sees when the bound passed. */
function expiredFailure(expires: string): ManagedRunFailure {
  return {
    kind: "expired",
    title: "This exchange's stored secret has lapsed",
    message:
      `The stored secret reached its maximum age ${dateTimeLabel(new Date(expires))} ` +
      "and can no longer be used, so this exchange cannot run again until you " +
      "re-invite your partner. Set up a fresh invitation with the same partner " +
      "to continue.",
    recovery: "reinvite",
  };
}

/** The benign "already running elsewhere" state: another tab or a scheduled run holds
 * the single-writer lock. Not a failure of this run. */
const ALREADY_RUNNING_FAILURE: ManagedRunFailure = {
  kind: "already-running",
  title: "This exchange is already running",
  message:
    "A run for this exchange is already in progress in another tab or a " +
    "scheduled run on this device. Wait for it to finish, then try again.",
  recovery: "wait",
};

/** The benign no-show state: the run spent its whole wait on the partner's runner
 * and it never connected, so no handshake ran and nothing left this device.
 * Deliberately not the transport copy, which would send the operator to check their
 * own connection for a partner who was simply not there. Recovery is `"none"`:
 * nothing on this device is broken and nothing here is re-settled, and the run
 * control is not gated by a classified state, so the operator runs it again
 * whenever their partner is ready.
 *
 * Its disclosure claim is this run's, so it is issued from THIS run's no-show error
 * alone (see {@link classifyManagedRunFailure}) and never from a record's recorded
 * outcome, which belongs to whichever run stamped it. */
const MISSED_FAILURE: ManagedRunFailure = {
  kind: "missed",
  title: "Your partner did not arrive",
  message:
    "This run waited for your partner and they never connected, so nothing was " +
    "exchanged and nothing left this device. That is not a fault on this " +
    "device: agree a time with your partner over your usual channel, and run " +
    "this exchange again when they are ready.",
  recovery: "none",
};

/** The benign input state's copy. Fixed and non-oracular: an input rejection's
 * partner-influenced detail (the unsatisfied field names) is never echoed. */
const INPUT_FAILURE: ManagedRunFailure = {
  kind: "input",
  title: "Your input file could not be used",
  message:
    "The input file for this run is missing, could not be read, or does not " +
    "have the columns this exchange needs. Check that the file is in place " +
    "and matches the agreed terms, then try again.",
  recovery: "retry",
};

/** The benign linkage-shortfall state: the file was read, and it cannot supply
 * every linkage key the standing terms declare, so the run stopped before
 * connecting. Fixed and non-oracular like the input state's -- the shortfall names
 * partner-authored keys and fields, and the copy states the condition instead. It
 * is deliberately not the retry state: the same file refuses identically, so the
 * only ways forward are a conforming file or terms settled with the partner. Its
 * own recorded tier reaches it too, so an unattended run's shortfall reads here at
 * the next visit rather than through the input state's re-pick. */
const TERMS_SHORTFALL_FAILURE: ManagedRunFailure = {
  kind: "terms-shortfall",
  title: "Your input file cannot match on everything this exchange agreed to",
  message:
    "The run stopped before connecting because your input file cannot supply " +
    "every linkage key this exchange agreed to match on, and nothing left this " +
    "device. Running it again with the same file stops the same way - this is " +
    "not a connection problem. Run it with a file that covers every agreed key, " +
    "or set the exchange up again with your partner over the keys both your " +
    "files can supply.",
  recovery: "restate",
};

/** The benign disclosure-refusal state: a send-side gate refused before connecting
 * because what this run would send is not the set the exchange recorded agreeing to
 * send. Fixed and non-oracular, like the input state's: the refusal names the drifted
 * columns, and those are this party's own, but the copy states the condition rather
 * than echoing a list the operator reads faster from their own file. It names
 * re-confirming the disclosure and says the run is not worth repeating as-is, because
 * the same input refuses identically. */
const CONSENT_FAILURE: ManagedRunFailure = {
  kind: "consent",
  title: "What this run would send is not what this exchange agreed to send",
  message:
    "The columns your input file would send to your partner for matched " +
    "records are not the ones this exchange agreed to send, so it stopped " +
    "before connecting and nothing left this device. Running it again with the " +
    "same file stops the same way - this is not a connection problem. Run it " +
    "with the input file whose columns match what was agreed, or set the " +
    "exchange up again with your partner to settle what it sends now.",
  recovery: "reconfirm",
};

/** The Tier-1 recorded persist-failure state: the last run rotated the secret but
 * could not save it, which can leave the two parties on different secrets. Plain,
 * specific copy naming re-invite -- no attack checklist (the record's own bookkeeping
 * explains the failure). */
const STORAGE_FAILURE: ManagedRunFailure = {
  kind: "storage",
  title: "The last run could not be saved",
  message:
    "The last run connected but could not save its updated secret on this " +
    "device, so you and your partner may now hold different secrets. Re-invite " +
    "your partner to reconnect; the exchange keeps your terms and only replaces " +
    "the secret.",
  recovery: "reinvite",
};

/** The Tier-1 restore/import state: this exchange was restored from a backup (or
 * imported) and has not successfully run since, so its secret may be one the
 * partnership has already moved past. Plain, specific copy naming re-invite -- no
 * attack checklist. */
const IMPORTED_FAILURE: ManagedRunFailure = {
  kind: "imported",
  title: "This exchange was restored from a backup",
  message:
    "This exchange was brought back from a backup and has not run successfully " +
    "since, so its secret may be one you and your partner have already moved " +
    "past. Re-invite your partner to reconnect; the exchange keeps your terms " +
    "and only replaces the secret.",
  recovery: "reinvite",
};

/** The recorded transport state: a connection or data-exchange drop, not a
 * failed-closed handshake. Fixed, friendly copy -- the raw error can embed partner- or
 * server-controlled bytes and reads as an internal message, so it stays in the
 * dev-gated console. A temporary connection problem, retried in place. */
const TRANSPORT_FAILURE: ManagedRunFailure = {
  kind: "transport",
  title: "The run could not be completed",
  message:
    "This run could not be completed - usually a temporary connection problem " +
    "rather than an issue with your data. Try again; if it keeps failing, " +
    "re-invite your partner.",
  recovery: "retry",
};

/** The Tier-2 unexplained state: a handshake failed closed with no recorded benign
 * cause. This is the one failure that needs the operator's out-of-band confirmation
 * work, so the copy directs to the confirmation flow -- it names no benign cause and
 * invents no new security guidance. The forwardable message and the two-outcome gate
 * are composed in {@link ../psi/managedFailureConfirmation.ts}; this copy is the lead
 * the surface shows above them. */
const UNEXPLAINED_FAILURE: ManagedRunFailure = {
  kind: "unexplained",
  title: "This run failed and needs you to check with your partner",
  message:
    "This run connected but could not verify your partner, and nothing on this " +
    "device explains why. This can be an ordinary problem on your partner's " +
    "side - or a sign someone is interfering. Do not just re-invite: confirm " +
    "with your partner on your usual trusted channel first, using the message " +
    "below.",
  recovery: "confirm",
};

/** The surface state for a derived failure tier. The expired tier reads
 * `record.expires` to name the real lapsed instant; the transport, missed, and none
 * tiers map to the generic transport copy.
 *
 * The missed tier deliberately does NOT carry the no-show copy: that copy attests
 * that nothing left this device, which is a claim about the failure being
 * classified, while a recorded `"missed"` outcome belongs to whichever run stamped
 * it -- and a failed run's bookkeeping write is best-effort (see
 * {@link ../psi/managedRun.ts}) and the host falls back to its pre-run record when
 * the post-failure reload rejects, so a failure from mid-data-exchange can meet a
 * standing missed outcome. A next-visit read of that outcome is informational and
 * phrased by the list and history surfaces (`savedExchangesModel`,
 * `managedDetailModel`), which name the no-show without claiming anything about
 * what this run disclosed.
 *
 * A success does not surface as a launch failure
 * ({@link managedRunFailureFromRecord} filters it, along with the missed tier the
 * list surfaces informationally), but {@link classifyManagedRunFailure} can route
 * any tier here, so both are handled explicitly rather than left to fabricate an
 * instant or fall off the end. */
function tierFailure(
  tier: ManagedFailureTier,
  record: ManagedExchangeRecord,
): ManagedRunFailure {
  switch (tier) {
    case "expired":
      // A defined `expires` names the lapsed instant; the expired tier is derived from
      // the lapse check, which only fires on a defined bound, so an absent value here
      // would be a derivation bug -- route it to the generic tier rather than fabricate
      // an instant, so no `undefined` reaches the date formatter.
      return record.expires !== undefined
        ? expiredFailure(record.expires)
        : TRANSPORT_FAILURE;
    case "input":
      return INPUT_FAILURE;
    case "terms-shortfall":
      return TERMS_SHORTFALL_FAILURE;
    case "consent":
      return CONSENT_FAILURE;
    case "storage":
      return STORAGE_FAILURE;
    case "imported":
      return IMPORTED_FAILURE;
    case "unexplained":
      return UNEXPLAINED_FAILURE;
    case "transport":
    case "missed":
    case "none":
      return TRANSPORT_FAILURE;
  }
}

/**
 * Classify a launch failure into the surface's {@link ManagedRunFailure}. The
 * benign states are read through {@link benignRerunOutcome} (the single place the
 * benign checks live), each with its own plain copy -- the expiry state names the
 * lapsed instant the error carries, the one non-fixed value, which is the record's
 * own local `expires`, never partner-influenced. Any other failure -- a
 * handshake failed closed, a persist failure, a transport drop -- is tiered from the
 * record's own bookkeeping (which the runner and the critical section already stamped
 * before this classification runs): {@link deriveManagedFailureTier} reads the tier,
 * and {@link tierFailure} maps it to copy. `now` and `local` are passed so the tier
 * derivation reads expiry and the import marker; the record is the freshly-reloaded
 * one carrying the just-stamped `lastRun`.
 *
 * `dataExchangeStarted` is THIS run's phase boundary, reported by the run through
 * its `onDataExchangeStart` option and passed through to
 * {@link benignRerunOutcome}: a benign state whose copy says nothing left this
 * device is read off the error only from before the boundary. The record cannot
 * stand in for it -- its `lastRun` is whatever the last write managed to stamp,
 * which is why the no-show copy is issued from the live error rather than from the
 * derived missed tier.
 */
export function classifyManagedRunFailure(
  error: unknown,
  record: ManagedExchangeRecord,
  local: ManagedLocalState | undefined,
  now: number,
  dataExchangeStarted: boolean,
): ManagedRunFailure {
  const benign = benignRerunOutcome(error, dataExchangeStarted);
  if (benign === "expired" && error instanceof ManagedExchangeExpiredError)
    return expiredFailure(error.expires);
  if (benign === "already-running") return ALREADY_RUNNING_FAILURE;
  if (benign === "input") return INPUT_FAILURE;
  if (benign === "terms-shortfall") return TERMS_SHORTFALL_FAILURE;
  if (benign === "missed") return MISSED_FAILURE;
  return tierFailure(deriveManagedFailureTier(record, local, now), record);
}

/**
 * The surface state for a stored record read at the next visit (no live launch),
 * derived purely from the record's bookkeeping and its local sibling state -- the
 * unattended run's failure surfacing through the same tiers. Returns `undefined` when
 * the record records no failure to surface (never run, last run succeeded, or a missed
 * window, which the list surfaces informationally rather than as a launch failure).
 */
export function managedRunFailureFromRecord(
  record: ManagedExchangeRecord,
  local: ManagedLocalState | undefined,
  now: number,
): ManagedRunFailure | undefined {
  const tier = deriveManagedFailureTier(record, local, now);
  if (tier === "none" || tier === "missed") return undefined;
  return tierFailure(tier, record);
}

/** Whether a classified failure is retryable in place (the input-acquisition and
 * transport states -- put the file back or retry the connection). The expired,
 * storage, imported, and unexplained states are not retried in place: their recovery
 * is re-invite (directly, or through the confirmation gate); a consent refusal and a
 * linkage shortfall are not retried either, because the same input settles the same
 * disclosure and falls the same way short of the same keys however many times it
 * runs; an in-progress run elsewhere is not this run's to retry until it
 * finishes; and a no-show is not retried on the spot, because what it waits on is
 * the partner being at their own machine. */
export function managedRunRetryable(failure: ManagedRunFailure): boolean {
  return failure.recovery === "retry";
}

/** Whether a classified failure's recovery is fast re-invite directly, so the surface
 * offers the re-invite affordance. The unexplained state reaches re-invite only through
 * the confirmation gate (`recovery === "confirm"`), so it is NOT a direct re-invite
 * state here. */
export function managedRunReinvites(failure: ManagedRunFailure): boolean {
  return failure.recovery === "reinvite";
}

/** The re-invite recovery callout's copy: a lead line and the paragraphs below it,
 * in order. */
export interface ManagedReinviteRecoveryCopy {
  /** The callout's lead line. */
  lead: string;
  /** The paragraphs below the lead, in order. */
  body: Array<string>;
}

/** The inviter's recovery: it re-mints from its own stored document, so the copy is
 * about the fresh invitation it is about to send. Re-minting rotates the record in
 * place, leaving one record for the partnership, so there is no cleanup step. */
const INVITER_REINVITE_RECOVERY: ManagedReinviteRecoveryCopy = {
  lead: "Re-invite your partner.",
  body: [
    "This keeps your agreed terms and only replaces the secret. The fresh " +
      "invitation carries a new one-time secret, so send it over your usual " +
      "trusted channel, exactly as you did the first time.",
  ],
};

/** The acceptor's recovery: it cannot mint an inviter-namespace invitation from its
 * mirrored document, so it asks the partner for a fresh one -- and that accept saves
 * a second recurring exchange beside this one, which the operator deletes. */
const ACCEPTOR_REINVITE_RECOVERY: ManagedReinviteRecoveryCopy = {
  lead: "Ask your partner to re-invite.",
  body: [
    "Ask your partner to send you a fresh invitation for this exchange over " +
      "your usual trusted channel, then open its link to accept it. That " +
      "re-establishes the connection with a new secret; your terms are " +
      "unchanged.",
    "Saving the accepted invitation as a recurring exchange adds a second one " +
      "rather than updating this one, and nothing here reconciles the two. " +
      "Once you have saved it, delete this superseded exchange with the " +
      "Delete button below, or the one beside it in your recurring exchanges " +
      "list. Left in place, it still offers a run that fails, because its " +
      "secret is the one the fresh invitation replaces.",
  ],
};

/**
 * The re-invite recovery copy for a record, chosen from the record's OWN `side`
 * through {@link canReinviteFromRecord} -- never an ambient flag, so a surface
 * holding a record cannot show the other side's recovery.
 *
 * The acceptor's copy carries a cleanup step the inviter's does not need. An accept
 * deposits a NEW managed record: the accept route carries no record id, and nothing
 * compares a fresh invitation against a stored partnership, so the superseded record
 * survives beside it and the operator holds two for one partnership. That is worth
 * the operator's attention because the superseded record still offers a run, which
 * fails closed and surfaces as the unexplained tier -- the very symptom this recovery
 * exists to clear. The copy names the delete affordance and stops there: this is the
 * operator's own record store, so nothing is deleted for them and nothing is blocked
 * (see docs/MANAGED_EXCHANGE.md, "Recovery: fast re-invite").
 */
export function managedReinviteRecoveryCopy(
  record: ManagedExchangeRecord,
): ManagedReinviteRecoveryCopy {
  return canReinviteFromRecord(record)
    ? INVITER_REINVITE_RECOVERY
    : ACCEPTOR_REINVITE_RECOVERY;
}
