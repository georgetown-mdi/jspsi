/**
 * The pure model behind the attended re-run's launch surface: the run's phase, and
 * the classification of a launch outcome into what the surface shows. No React, no
 * I/O -- the run driver and the store live in the component; this decides the copy
 * and the recovery each state gets, so the surface stays thin and the state machine
 * is unit-testable.
 *
 * The three benign pre-connection states get their own plain, honest copy (a
 * lapsed `expires`, an input problem, a run already in progress elsewhere) -- none
 * routed through desync/attack framing (a later item's scope). Every other failure
 * -- a handshake failure, a storage failure, a data-exchange drop -- gets the
 * existing generic message: this item keeps handshake-failure messaging on the
 * generic path and invents no desync or attack copy.
 */

import { sanitizeForDisplay } from "@psilink/core";

import { benignRerunOutcome } from "@psi/managedRun";

/** The launch's phase: before the operator runs, while a run is in flight, and the
 * two terminal states. `needs-input` is the re-selection wait on a browser without
 * a persisted handle (the operator must pick the file before the run can start). */
export type ManagedRunPhase =
  "idle" | "needs-input" | "running" | "done" | "failed";

/** A classified launch failure, ready to render: the benign pre-connection states
 * each carry their own honest copy; a generic failure carries the existing
 * fixed message. */
export interface ManagedRunFailure {
  /** The failure's kind, deciding the surface's recovery affordance. */
  kind: "expired" | "input" | "already-running" | "generic";
  /** The surface title. */
  title: string;
  /** The operator-facing message. */
  message: string;
}

/** The benign expiry state: a lapsed stored secret, detected before any
 * connection. Plain re-invite copy, never attack framing (see
 * docs/MANAGED_EXCHANGE.md, "Expiry is its own state"). */
const EXPIRED_FAILURE: ManagedRunFailure = {
  kind: "expired",
  title: "This exchange's stored secret has lapsed",
  message:
    "The stored secret is past its maximum age, so this exchange cannot run " +
    "again until you re-invite your partner. Set up a fresh invitation with the " +
    "same partner to continue.",
};

/** The benign "already running elsewhere" state: another tab or a scheduled run
 * holds the single-writer lock. Not a failure of this run. */
const ALREADY_RUNNING_FAILURE: ManagedRunFailure = {
  kind: "already-running",
  title: "This exchange is already running",
  message:
    "A run for this exchange is already in progress in another tab or a " +
    "scheduled run on this device. Wait for it to finish, then try again.",
};

/** The generic, retryable failure: a handshake failure, a storage failure, or a
 * transport drop. Fixed, friendly copy -- the raw error can embed partner- or
 * server-controlled bytes and reads as an internal message, so it stays in the
 * dev-gated console, exactly as the one-shot flows' generic alert does. This item
 * invents no desync or attack copy; handshake-failure messaging stays here. */
const GENERIC_FAILURE: ManagedRunFailure = {
  kind: "generic",
  title: "The run could not be completed",
  message:
    "This run could not be completed - usually a temporary connection problem " +
    "rather than an issue with your data. Try again; if it keeps failing, " +
    "re-invite your partner.",
};

/**
 * Classify a launch failure into the surface's {@link ManagedRunFailure}. The
 * benign pre-connection states are read through {@link benignRerunOutcome} (the
 * single place the three benign checks live), each with its own honest copy; an
 * input problem's partner-influenced detail (the unsatisfied field names) is never
 * echoed, so the input message is the fixed, non-oracular summary sanitized at this
 * boundary. Every other failure is the generic message.
 */
export function classifyManagedRunFailure(error: unknown): ManagedRunFailure {
  const benign = benignRerunOutcome(error);
  if (benign === "expired") return EXPIRED_FAILURE;
  if (benign === "already-running") return ALREADY_RUNNING_FAILURE;
  if (benign === "input")
    return {
      kind: "input",
      title: "Your input file could not be used",
      message: sanitizeForDisplay(
        "The input file for this run is missing, could not be read, or does not " +
          "have the columns this exchange needs. Check that the file is in place " +
          "and matches the agreed terms, then try again.",
      ),
    };
  return GENERIC_FAILURE;
}

/** Whether a classified failure is retryable in place (the input and generic
 * states -- fix the file or retry the connection). The expired and
 * already-running states are not: expiry needs a re-invite, and an in-progress run
 * elsewhere is not this run's to retry until it finishes. */
export function managedRunRetryable(failure: ManagedRunFailure): boolean {
  return failure.kind === "input" || failure.kind === "generic";
}
