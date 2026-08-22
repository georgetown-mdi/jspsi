/**
 * The pure model behind the console's "Diagnostics and recovery" card: the two
 * PER-RUN controls an operator reaches for when a run misbehaves -- capture a
 * detailed log, and sweep a rendezvous directory a crashed prior run left
 * protocol files in -- plus what the card refuses before the run starts and what
 * the seat says when the CLI refuses the sweep.
 *
 * No React and no I/O, so the emitted intent fields, the acknowledgement gate,
 * and the refusal guidance are the tested boundary.
 *
 * Both controls are per-run and nothing about either survives the run: the
 * console authors and runs ONE exchange and then graduates to the command line,
 * so a console-wide diagnostics setting would be state this appliance has no
 * business keeping.
 */

/** The operator's per-run diagnostic and recovery choices for one exchange. */
export interface RunDiagnosticsDraft {
  /** Run at debug verbosity and capture the CLI's log on the appliance. */
  diagnosticRun: boolean;
  /** Sweep the rendezvous directory's leftover protocol files before the run. */
  sweepExchangeFiles: boolean;
  /** The operator's confirmation that no other session is using the directory,
   * required before a sweep may run (see {@link SWEEP_CONFIRMATION_NOTICE}). */
  sweepConfirmed: boolean;
}

/** The card's starting state: neither control on, which is the behaviour a
 * console exchange has without the card. */
export const RUN_DIAGNOSTICS_DEFAULT: RunDiagnosticsDraft = {
  diagnosticRun: false,
  sweepExchangeFiles: false,
  sweepConfirmed: false,
};

/**
 * What the card states before a sweep runs, saying what the CLI's own reference
 * says: the sweep is safe about WHICH files it deletes (psilink's own protocol
 * files, never anything else in the folder) and unsafe about WHEN, because it is
 * a scan followed by deletes with nothing holding the directory still. A sweep
 * run against a directory a live exchange is using destroys that exchange, and
 * only the operator can rule that out.
 */
export const SWEEP_CONFIRMATION_NOTICE =
  "This deletes the exchange's own leftover files -- the hellos, locks, " +
  "acknowledgements, and messages a crashed or mismatched run left behind. " +
  "Anything else in the folder is left alone. Confirm no other session is " +
  "using this directory first: sweeping while an exchange is running there " +
  "destroys it.";

/** The acknowledgement the operator ticks to confirm the notice above. Stated as
 * the fact they are asserting, not as agreement to a warning. */
export const SWEEP_CONFIRMATION_LABEL =
  "No other session is using this directory";

/** The problem shown while the sweep is on and unconfirmed. */
export const SWEEP_UNCONFIRMED_PROBLEM =
  "Confirm that no other session is using this directory before sweeping it.";

/**
 * What the console says about a debug-level log before the operator asks for
 * one. The CLI creates the file owner-only for the same reason (see
 * `configureLogFile`), and the appliance serves it only through the job's own
 * endpoint, but the operator still ends up with a copy in their downloads.
 */
export const DIAGNOSTIC_LOG_NOTICE =
  "A detailed log records what the exchange did step by step, including your " +
  "partner's identity, the linkage keys in play, and the columns involved. " +
  "It stays with this run's files on the appliance until you discard the " +
  "run; treat a copy you download like the results themselves.";

/** The subset of a job intent this card contributes: each control present only
 * when it is on, and only ever `true`. */
export interface RunDiagnosticsIntentFields {
  diagnosticRun?: true;
  sweepExchangeFiles?: true;
}

/**
 * The per-run fields a draft contributes to a job intent. Only an enabled
 * control is emitted, so a run that changed nothing sends the same intent it
 * sent before the card existed.
 *
 * The sweep is emitted only once confirmed, so the acknowledgement is not merely
 * a form gate the caller could forget to check: an unconfirmed draft cannot
 * produce a sweeping intent at all.
 */
export function runDiagnosticsIntentFields(
  draft: RunDiagnosticsDraft,
): RunDiagnosticsIntentFields {
  return {
    ...(draft.diagnosticRun ? { diagnosticRun: true } : {}),
    ...(draft.sweepExchangeFiles && draft.sweepConfirmed
      ? { sweepExchangeFiles: true }
      : {}),
  };
}

/** Everything wrong with the draft, as messages to show beside the card -- empty
 * when it is admissible. The run is blocked while this is non-empty. */
export function runDiagnosticsProblems(
  draft: RunDiagnosticsDraft,
): Array<string> {
  return draft.sweepExchangeFiles && !draft.sweepConfirmed
    ? [SWEEP_UNCONFIRMED_PROBLEM]
    : [];
}

/**
 * The fragment of the CLI's refusal this seat keys its guidance on. Core
 * composes it when a sweep meets a retain-mode signal, and it names the very
 * flag the console put on the argv, so a match is a match on this console's own
 * request rather than on partner text that happens to read like one.
 *
 * A best-effort enrichment by construction: a reworded refusal stops the match
 * firing and the operator reads the CLI's own message, which already carries the
 * escalation. That is the behaviour of a match that never fires, not a wrong
 * answer.
 */
const SWEEP_RETAIN_REFUSAL_FRAGMENT =
  "--sweep-exchange-files refuses to delete";

/** Whether a rendered terminal-failure message is the CLI refusing the sweep
 * over a retain-mode signal. */
export function isSweepRetainRefusal(message: string): boolean {
  return message.includes(SWEEP_RETAIN_REFUSAL_FRAGMENT);
}

/** The alert title for that refusal: the run stopped, and it stopped on the
 * recovery step rather than on the exchange. */
export const SWEEP_RETAIN_REFUSAL_TITLE = "The sweep was refused";

/**
 * What the console tells an operator whose sweep the retain guard refused. It
 * explains the escalation rather than offering it: the console deliberately
 * carries no one-click way to delete an audit transcript, and the command line
 * -- where the flag is spelled out and the run is the operator's own -- stays
 * open. Not offering the affordance is not a block; the operator's own path is
 * intact.
 *
 * The CLI's own refusal follows, naming the concrete retain signal it found.
 */
export function sweepRetainRefusalMessage(cliMessage: string): string {
  return (
    "This directory holds a retain-mode transcript, or its peer is running " +
    "in retain mode, so psilink stopped rather than delete files that may be " +
    "somebody's audit record. The console offers no way to overrule that. If " +
    "the transcript really is expendable, run the exchange from the command " +
    "line with --sweep-exchange-files --force-retain-sweep, which deletes it " +
    "permanently -- after confirming no other session is using the " +
    "directory.\n\n" +
    cliMessage
  );
}
