/**
 * The pure model behind the managed re-run's launch surface: the classification of a
 * launch outcome into what the surface shows -- the copy and the recovery affordance
 * for each state. No React, no I/O -- the run driver and the store live in the
 * component; this decides which state, its copy, and its recovery, so the surface
 * stays thin and the classification is unit-testable.
 *
 * Two layers feed a surface state:
 *
 * - The PRE-CONNECTION benign states, read from the launch error: a lapsed `expires`,
 *   an input problem, or a run already in progress elsewhere. These are unambiguous
 *   (no handshake ran), so they surface as their own plain, non-alarming copy directly
 *   from the error.
 * - The RECORDED tiers, derived from the record's own structured bookkeeping (see
 *   {@link deriveManagedFailureTier}): a recorded persist failure, a restore/import
 *   since the last success, a transport drop, or -- only when nothing else explains a
 *   failed-closed handshake -- the unexplained tier that carries the full out-of-band
 *   confirmation. The tier is derived from the record's evidence, never the live error,
 *   so a failure from an unattended run surfaces through the same tiers at the next
 *   visit.
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
import { deriveManagedFailureTier } from "@psi/managedFailureTiers";

import { dateTimeLabel } from "./inviterModel";

import type { ManagedExchangeRecord } from "@psi/managedExchangeRecord";
import type { ManagedFailureTier } from "@psi/managedFailureTiers";
import type { ManagedLocalState } from "@psi/managedLocalState";

/** The recovery affordance a surface state offers, deciding what the host renders:
 *
 * - `"reinvite"` -- fast re-invite is the recovery (a lapsed, desynced, restored, or
 *   persist-failed exchange). The inviter side re-mints from the stored document; the
 *   acceptor side asks the partner to re-invite (the surface names which).
 * - `"retry"` -- retryable in place (fix the input, or retry a transport drop).
 * - `"wait"` -- not this run's to act on (a run in progress elsewhere).
 * - `"confirm"` -- the Tier-2 out-of-band confirmation and the two-outcome gate.
 * - `"none"` -- nothing to recover (informational; e.g. a missed window). */
export type ManagedRunRecovery =
  "reinvite" | "retry" | "wait" | "confirm" | "none";

/** A classified launch state, ready to render: the state's kind (the pre-connection
 * benign states plus the derived tiers), its plain copy, and the recovery affordance
 * the host renders. */
export interface ManagedRunFailure {
  /** The state's kind. The three pre-connection benign states, plus the recorded
   * tiers derived from the record's bookkeeping. */
  kind:
    | "expired"
    | "input"
    | "already-running"
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

/** The surface state for a derived failure tier, reading `record.expires` for the
 * expired tier so no instant is fabricated. `"none"` and `"missed"` do not surface as
 * a launch failure (a success records nothing; a missed window is informational), so
 * they fall back to the transport copy as a safe generic -- the callers below never
 * pass them here. */
function tierFailure(
  tier: ManagedFailureTier,
  record: ManagedExchangeRecord,
): ManagedRunFailure {
  switch (tier) {
    case "expired":
      // `record.expires` is defined when the tier is expired (the lapse check reads
      // it), so the benign expiry copy names the real lapsed instant.
      return expiredFailure(record.expires as string);
    case "input":
      return INPUT_FAILURE;
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
 * pre-connection benign states are read through {@link benignRerunOutcome} (the single
 * place the three benign checks live), each with its own plain copy -- the expiry state
 * names the lapsed instant the error carries, the one non-fixed value, which is the
 * record's own local `expires`, never partner-influenced. Any other failure -- a
 * handshake failed closed, a persist failure, a transport drop -- is tiered from the
 * record's own bookkeeping (which the runner and the critical section already stamped
 * before this classification runs): {@link deriveManagedFailureTier} reads the tier,
 * and {@link tierFailure} maps it to copy. `now` and `local` are passed so the tier
 * derivation reads expiry and the import marker; the record is the freshly-reloaded
 * one carrying the just-stamped `lastRun`.
 */
export function classifyManagedRunFailure(
  error: unknown,
  record: ManagedExchangeRecord,
  local: ManagedLocalState | undefined,
  now: number,
): ManagedRunFailure {
  const benign = benignRerunOutcome(error);
  if (benign === "expired" && error instanceof ManagedExchangeExpiredError)
    return expiredFailure(error.expires);
  if (benign === "already-running") return ALREADY_RUNNING_FAILURE;
  if (benign === "input") return INPUT_FAILURE;
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

/** Whether a classified failure is retryable in place (the input and transport states
 * -- fix the file or retry the connection). The expired, storage, imported, and
 * unexplained states are not retried in place: their recovery is re-invite (directly,
 * or through the confirmation gate), and an in-progress run elsewhere is not this run's
 * to retry until it finishes. */
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
