/**
 * The pure model behind the managed re-run's launch surface: classifies a launch
 * outcome into the state the surface shows -- title, message, and recovery
 * affordance -- except the hand-off state, which renders as the stored spent
 * state instead. No React, no I/O.
 *
 * The benign states ({@link benignRerunOutcome}) read from the launch error
 * directly; the RECORDED tiers ({@link deriveManagedFailureTier}) derive from
 * the record's own bookkeeping. No tier's copy echoes a partner-influenced
 * value except the record's own local `expires`.
 */

import {
  ManagedExchangeExpiredError,
  benignRerunOutcome,
} from "@psi/managed/managedRun";
import {
  deriveManagedFailureTier,
  importedSinceLastSuccess,
} from "@psi/managed/managedFailureTiers";
import { canReinviteFromRecord } from "@psi/managed/managedReinvite";

import { dateTimeLabel } from "@psi/formatting";

import type { ManagedExchangeRecord } from "@psi/managed/managedExchangeRecord";
import type { ManagedFailureTier } from "@psi/managed/managedFailureTiers";
import type { ManagedLocalState } from "@psi/managed/managedLocalState";

/** The recovery affordance a surface state offers: drives what the host renders
 * below the alert, and through {@link managedRunRetryable} whether the
 * saved-exchanges footer stands beside it. The state's copy is a sibling field
 * authored alongside it, not derived from it. It does not gate the run control,
 * which the surface enables from the input source and the device's connectivity
 * alone.
 *
 * - `"reinvite"` -- fast re-invite (a lapsed, desynced, restored, or
 *   persist-failed exchange). The inviter side re-mints from the stored document;
 *   the acceptor side asks the partner to re-invite (the surface names which).
 * - `"retry"` -- retryable in place (fix the input, or retry a transport drop).
 * - `"wait"` -- not this run's to act on (a run in progress elsewhere).
 * - `"confirm"` -- the Tier-2 out-of-band confirmation and the two-outcome gate.
 * - `"reconfirm"` -- what this exchange sends must be decided again: the run's
 *   own input decides the set, so retrying the connection or re-minting the
 *   secret does not change the outcome. Not `"retry"`.
 * - `"restate"` -- what this exchange matches on must be decided again, or the
 *   input replaced: the file cannot supply every agreed linkage key, and the
 *   same file refuses identically every time. Not `"retry"`.
 * - `"none"` -- nothing to recover (informational; e.g. a missed window). */
export type ManagedRunRecovery =
  "reinvite" | "retry" | "wait" | "confirm" | "reconfirm" | "restate" | "none";

/** The two readings of a record a live launch failure is classified against. They
 * differ because a failed run stamps its own `lastRun` before the host reloads, and
 * that stamp REPLACES the entry rather than merging into it: a no-show's stamp has
 * no `failureKind` at all, so a kind standing before the run is not in the
 * reloaded record to read. */
export interface ManagedRunRecordReadings {
  /** The record as the STORE held it at the run's launch: the standing evidence
   * this run's own bookkeeping stamp cannot have erased. The no-show state is read
   * against it ({@link missedFailure}). */
  atLaunch: ManagedExchangeRecord;
  /** The record reloaded after the failure, holding whatever `lastRun` this run
   * just stamped -- the evidence every derived tier reads. The host falls back to
   * the at-launch record when the reload rejects, so the two can be the same
   * record. */
  afterRun: ManagedExchangeRecord;
}

/** A classified launch state the host renders as an alert: the state's kind (the
 * pre-connection benign states plus the derived tiers), its plain copy, and the
 * recovery affordance beneath it. */
export interface ManagedRunFailureAlert {
  /** The state's kind. The benign states read from the error, plus the recorded
   * tiers derived from the record's bookkeeping. */
  kind:
    | "expired"
    | "input"
    | "terms-shortfall"
    | "consent"
    | "custody-unreadable"
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

/** The classified hand-off state, which has no copy: the surface consumes this
 * kind by settling onto the stored spent state ({@link ./ManagedRunSurface.tsx}),
 * which names the hand-off that spent the copy, what it left behind, and what the
 * refused run did. Copy authored here would be prose no surface can reach, and the
 * absent `title` and `message` keep it that way -- a host that renders this state
 * as an alert instead does not typecheck. */
export interface ManagedRunHandedOffFailure {
  /** The state's kind, the discriminant the host branches on. */
  kind: "handed-off";
  /** Nothing here is retried and nothing here is decided again. */
  recovery: "none";
}

/** A classified launch state: an alert with its copy, or the hand-off state the
 * surface branches on. */
export type ManagedRunFailure =
  ManagedRunFailureAlert | ManagedRunHandedOffFailure;

/** The benign expiry state's copy: a lapsed stored secret, plain re-invite
 * framing (see docs/MANAGED_EXCHANGE.md, "Expiry is its own state"), naming the
 * lapsed instant the error has so the operator sees when the bound passed. */
function expiredFailure(expires: string): ManagedRunFailureAlert {
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

/** The benign hand-off state: an export gave this browser's copy of the exchange
 * away, so the run refused before reading the input file and before connecting --
 * the single-owner invariant holding, not a failure to recover from.
 *
 * It holds no copy and offers nothing to take the exchange back with. Taking a
 * handed-off exchange back happens on that exchange's own surface, not through a
 * refused run; reaching this state fixes the run surface onto the stored spent
 * state, which tells the operator where the exchange runs and what the refused
 * run did. */
const HANDED_OFF_FAILURE: ManagedRunHandedOffFailure = {
  kind: "handed-off",
  recovery: "none",
};

/** The unreadable-custody state: the run could not read the local entry recording
 * whether this device's copy was handed off, so it refused before reading the
 * input file and before connecting rather than rotating on custody it could not
 * establish. Not the storage state beside it: nothing rotated here, so there is
 * no desync to recover from. Recovery is `"none"` -- no affordance on this
 * surface makes the entry readable. */
const CUSTODY_UNREADABLE_FAILURE: ManagedRunFailureAlert = {
  kind: "custody-unreadable",
  title: "Part of this exchange's stored copy could not be read",
  message:
    "This browser could not read the note it keeps beside this exchange - the " +
    "one recording whether this copy was handed off somewhere else - so the " +
    "run stopped before reading your file and before connecting. Nothing left " +
    "this device, nothing here changed, and your partner was not contacted. A " +
    "run does not go ahead without that note, so running this exchange again " +
    "stops the same way until this browser can read it.",
  recovery: "none",
};

/** The benign "already running elsewhere" state: another tab or a scheduled run holds
 * the single-writer lock. Not a failure of this run. */
const ALREADY_RUNNING_FAILURE: ManagedRunFailureAlert = {
  kind: "already-running",
  title: "This exchange is already running",
  message:
    "A run for this exchange is already in progress in another tab or a " +
    "scheduled run on this device. Wait for it to finish, then try again.",
  recovery: "wait",
};

/** The benign no-show state: the run spent its whole wait on the partner's runner
 * and never connected, so no handshake ran and nothing left this device. Not the
 * transport copy, which would send the operator to check their own connection.
 * Recovery is `"none"`: nothing here is decided again, and the run control is
 * not gated by a classified state, so the operator runs it again once their
 * partner is ready.
 *
 * The copy names re-invite for a partner who was at their machine at an agreed
 * time and still never arrived (see docs/MANAGED_EXCHANGE.md, "A missed window
 * is neither desync nor attack"), but stays out of the recovery affordance.
 *
 * Issued from THIS run's own no-show error ({@link classifyManagedRunFailure}),
 * never from a record's recorded outcome, which belongs to whichever run
 * stamped it. */
const MISSED_FAILURE: ManagedRunFailureAlert = {
  kind: "missed",
  title: "Your partner did not arrive",
  message:
    "This run waited for your partner and they never connected, so nothing was " +
    "exchanged and nothing left this device. That is not a fault on this " +
    "device: agree a time with your partner over your usual channel, and run " +
    "this exchange again when they are ready. If they were running their side " +
    "at a time you agreed and this keeps happening, re-invite your partner to " +
    "reconnect; the exchange keeps your terms and only replaces the secret.",
  recovery: "none",
};

/** The benign input state's copy. Fixed and non-oracular: an input rejection's
 * partner-influenced detail (the unsatisfied field names) is never echoed. */
const INPUT_FAILURE: ManagedRunFailureAlert = {
  kind: "input",
  title: "Your input file could not be used",
  message:
    "The input file for this run is missing, could not be read, or does not " +
    "have the columns this exchange needs. Check that the file is in place " +
    "and matches the agreed terms, then try again.",
  recovery: "retry",
};

/** The benign linkage-shortfall state: the file was read and cannot supply
 * every linkage key the standing terms declare, so the run stopped before
 * connecting. Fixed and non-oracular like the input state's: the shortfall
 * names partner-authored keys and fields, and the copy states the condition
 * instead. Not the retry state -- the same file refuses identically, so the
 * only ways forward are a conforming file or terms agreed with the partner.
 * The recorded tier reaches it too, so an unattended run's shortfall is
 * classified here rather than through the input state's re-pick. */
const TERMS_SHORTFALL_FAILURE: ManagedRunFailureAlert = {
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
 * send. Fixed and non-oracular, like the input state's: the refusal names the
 * drifted columns, and those are this party's own, but the copy states the
 * condition rather than echoing a list the operator reads faster from their own
 * file. It names re-confirming the disclosure, since the same input refuses
 * identically. */
const CONSENT_FAILURE: ManagedRunFailureAlert = {
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
 * specific copy naming re-invite -- the record's own bookkeeping explains the
 * failure. This is the one-sided persist alone: the other local-storage refusal a
 * run can meet rotates nothing and is treated as {@link CUSTODY_UNREADABLE_FAILURE}. */
const STORAGE_FAILURE: ManagedRunFailureAlert = {
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
const IMPORTED_FAILURE: ManagedRunFailureAlert = {
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
 * failed-closed handshake. Fixed, friendly copy: the raw error can embed
 * partner- or server-controlled bytes and displays as an internal message, so
 * it stays in the dev-gated console. A temporary connection problem, retried
 * in place. */
const TRANSPORT_FAILURE: ManagedRunFailureAlert = {
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
const UNEXPLAINED_FAILURE: ManagedRunFailureAlert = {
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
 * `record.expires` to name the lapsed instant; the transport, missed, and none
 * tiers map to the generic transport copy.
 *
 * The missed tier does not use the no-show copy: that copy attests nothing left
 * this device for THIS failure, while a recorded `"missed"` outcome belongs to
 * whichever run stamped it (the bookkeeping write is best-effort, see {@link
 * ../psi/managedRun.ts}). The list and history surfaces (`savedExchangesModel`,
 * `managedDetailModel`) phrase a next-visit read of that outcome informationally.
 *
 * `"none"` and `"missed"` are handled explicitly even though {@link
 * managedRunFailureFromRecord} filters both before a record reaches this
 * function; {@link classifyManagedRunFailure} can still route either tier here. */
function tierFailure(
  tier: ManagedFailureTier,
  record: ManagedExchangeRecord,
): ManagedRunFailure {
  switch (tier) {
    case "expired":
      // The expired tier only derives from a defined `expires` (the lapse check
      // requires it); an absent value here is a derivation bug, so this falls
      // back to the generic tier rather than fabricate an instant for the date
      // formatter.
      return record.expires !== undefined
        ? expiredFailure(record.expires)
        : TRANSPORT_FAILURE;
    case "input":
      return INPUT_FAILURE;
    case "terms-shortfall":
      return TERMS_SHORTFALL_FAILURE;
    case "consent":
      return CONSENT_FAILURE;
    case "handed-off":
      return HANDED_OFF_FAILURE;
    case "custody-unreadable":
      return CUSTODY_UNREADABLE_FAILURE;
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

/** The tiers whose framing outranks the benign no-show reading: Tier-1 desync
 * signals the record already holds as the run launches, each recovered by
 * re-invite (see docs/MANAGED_EXCHANGE.md, "A missed window is neither desync
 * nor attack"). The Tier-2 unexplained framing is not here: no handshake ran,
 * so nothing failed closed. */
const MISSED_OUTRANKED_BY: ReadonlyArray<ManagedFailureTier> = [
  "expired",
  "storage",
  "imported",
];

/** The no-show state, read against the desync evidence the record holds
 * ({@link MISSED_OUTRANKED_BY}) as of the launch
 * ({@link ManagedRunRecordReadings.atLaunch}) -- the reading this run's own
 * `"missed"` stamp cannot have erased, since that stamp replaces `lastRun` and
 * has no `failureKind`.
 *
 * The import marker is read directly as well as through the derived tier,
 * because the derivation short-circuits on a `"missed"` outcome before reaching
 * the marker: a record whose last run was itself a no-show tiers as `"missed"`
 * while still holding a standing restore. The tier is checked first since it
 * also includes the lapse check and the recorded persist failure, which the
 * marker alone does not. */
function missedFailure(
  atLaunch: ManagedExchangeRecord,
  local: ManagedLocalState | undefined,
  now: number,
): ManagedRunFailure {
  const tier = deriveManagedFailureTier(atLaunch, local, now);
  if (MISSED_OUTRANKED_BY.includes(tier)) return tierFailure(tier, atLaunch);
  if (importedSinceLastSuccess(local)) return IMPORTED_FAILURE;
  return MISSED_FAILURE;
}

/** The record-derived tiers that attest THIS run's non-disclosure -- that it
 * stopped before reading the input file and before connecting, so nothing left
 * this device -- and so give way to the generic tier once this run's data
 * exchange has started ({@link classifyManagedRunFailure}'s `dataExchangeStarted`
 * boundary). The hand-off tier is included for the same claim the surface reads
 * to settle onto the stored spent state ({@link ./ManagedRunSurface.tsx}).
 * `"missed"` is absent: its no-show copy is issued from the live error, not this
 * boundary ({@link missedFailure}). The re-invite, input, and unexplained tiers
 * are absent because none of their copy asserts non-disclosure. */
const NON_DISCLOSURE_ATTESTING_TIERS: ReadonlyArray<ManagedFailureTier> = [
  "handed-off",
  "custody-unreadable",
  "consent",
  "terms-shortfall",
];

/**
 * Classify a launch failure into the surface's {@link ManagedRunFailure}. The
 * benign states are read through {@link benignRerunOutcome}, each with its own
 * plain copy -- the expiry state names the lapsed instant the error has, the
 * one non-fixed value, and it is the record's own local `expires`, never
 * partner-influenced. Any other failure is tiered from the record's own
 * bookkeeping: {@link deriveManagedFailureTier} reads the tier and {@link
 * tierFailure} maps it to copy. `now` and `local` feed that derivation (expiry
 * and the import marker).
 *
 * A derived tier reads the record reloaded after the run (`records.afterRun`),
 * since it rests on what THIS run stamped. The no-show rests on what stood
 * BEFORE it -- a no-show's `"missed"` stamp replaces `lastRun` and has no
 * `failureKind` -- so it reads `records.atLaunch` instead ({@link
 * missedFailure}).
 *
 * `dataExchangeStarted` is THIS run's phase boundary (the run's own
 * `onDataExchangeStart` option, passed to {@link benignRerunOutcome}): a benign
 * state whose copy claims nothing left this device is read off the error only
 * from before it, and a derived tier making the same claim is gated by it too
 * ({@link NON_DISCLOSURE_ATTESTING_TIERS}).
 */
export function classifyManagedRunFailure(
  error: unknown,
  records: ManagedRunRecordReadings,
  local: ManagedLocalState | undefined,
  now: number,
  dataExchangeStarted: boolean,
): ManagedRunFailure {
  const benign = benignRerunOutcome(error, dataExchangeStarted);
  if (benign === "expired" && error instanceof ManagedExchangeExpiredError)
    return expiredFailure(error.expires);
  if (benign === "already-running") return ALREADY_RUNNING_FAILURE;
  if (benign === "handed-off") return HANDED_OFF_FAILURE;
  if (benign === "custody-unreadable") return CUSTODY_UNREADABLE_FAILURE;
  if (benign === "input") return INPUT_FAILURE;
  if (benign === "terms-shortfall") return TERMS_SHORTFALL_FAILURE;
  if (benign === "missed") return missedFailure(records.atLaunch, local, now);
  const { afterRun } = records;
  const tier = deriveManagedFailureTier(afterRun, local, now);
  return tierFailure(
    dataExchangeStarted && NON_DISCLOSURE_ATTESTING_TIERS.includes(tier)
      ? "transport"
      : tier,
    afterRun,
  );
}

/**
 * The surface state for a stored record read at the next visit (no live launch),
 * derived purely from the record's bookkeeping and its local sibling state, so an
 * unattended run's failure is classified through the same tiers. Returns
 * `undefined` when the record holds no failure to show: never run, last run
 * succeeded, or a missed window (the list shows that informationally rather than
 * as a launch failure).
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

/** Whether a classified failure is retryable in place: the input and transport
 * states put the file back or retry the connection; every other state's own
 * recovery is documented on its constant above. */
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
 * The acceptor's copy has a cleanup step the inviter's does not need: an accept
 * deposits a NEW managed record beside the superseded one, which still offers a
 * run that fails closed as the unexplained tier (see docs/MANAGED_EXCHANGE.md,
 * "Recovery: fast re-invite").
 */
export function managedReinviteRecoveryCopy(
  record: ManagedExchangeRecord,
): ManagedReinviteRecoveryCopy {
  return canReinviteFromRecord(record)
    ? INVITER_REINVITE_RECOVERY
    : ACCEPTOR_REINVITE_RECOVERY;
}
