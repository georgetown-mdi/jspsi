/**
 * The pure model behind the console's "Diagnostics and recovery" card: the two
 * PER-RUN controls an operator reaches for when a run misbehaves -- capture a
 * detailed log, and sweep a rendezvous directory a crashed prior run left
 * protocol files in -- plus what the card states and refuses before the run
 * starts.
 *
 * No React and no I/O, so the emitted intent fields, the acknowledgement gate,
 * and the card's copy are the tested boundary.
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
 * The sweep control's visible label. Named here because the rendezvous
 * preflight's not-empty warning sends the operator to this control, and a
 * warning quoting a label the card no longer carries sends them nowhere.
 */
export const SWEEP_CONTROL_LABEL =
  "Clear leftover exchange files before starting";

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

/**
 * What the card says about the CLI's retain guard while the operator is still
 * choosing, rather than leaving it to be discovered from a run that stopped: a
 * directory holding an audit transcript refuses the sweep, and the way past that
 * is the command line's.
 *
 * The escalation is named, not offered: the console deliberately carries no
 * one-click way to delete an audit transcript, and the command line -- where the
 * flag is spelled out and the run is the operator's own -- stays open. It is
 * stated from the operator's own draft, so no run output decides whether they
 * see it.
 */
export const SWEEP_RETAIN_ESCALATION_NOTICE =
  "If this directory holds a retain-mode transcript -- yours, or your " +
  "partner's -- the sweep is refused, and only the command line can overrule " +
  "that: run the exchange with --sweep-exchange-files --force-retain-sweep, " +
  "which loses the prior transcript permanently.";

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
  "It stays with this run's files on the console until you discard the " +
  "run; treat a copy you download like the results themselves.";

/**
 * The draft with one control set to a new value, which is the only way a surface
 * changes it: the confirmation belongs to a sweep that is ON, so a draft whose
 * sweep is off carries no confirmation.
 *
 * The draft outlives any one visit to the card -- it is the whole form's, and
 * the directory the sweep would run against can be re-targeted between visits --
 * so without that rule an operator who confirmed a sweep once, turned it off,
 * and later turned it back on would emit the destructive `--sweep-exchange-files`
 * on an attestation they last made about something else. Keeping it here rather
 * than in the card is what makes it hold for every surface the draft reaches.
 */
export function runDiagnosticsWithControl<
  TField extends keyof RunDiagnosticsDraft,
>(
  draft: RunDiagnosticsDraft,
  field: TField,
  value: RunDiagnosticsDraft[TField],
): RunDiagnosticsDraft {
  const changed = { ...draft, [field]: value };
  return changed.sweepExchangeFiles
    ? changed
    : { ...changed, sweepConfirmed: false };
}

/**
 * The draft carried across a RE-TARGET of the directory a sweep would run
 * against -- a transport switch, or an SFTP connection authored afresh. The
 * confirmation attests ONE directory, so it does not survive that directory
 * changing; the operator's other choices are about the run rather than the
 * place, and are left alone.
 *
 * Held here rather than in each seat's handler for the reason
 * {@link runDiagnosticsWithControl} is: the draft outlives the surface that
 * re-targets it.
 */
export function runDiagnosticsAfterRetarget(
  draft: RunDiagnosticsDraft,
): RunDiagnosticsDraft {
  return { ...draft, sweepConfirmed: false };
}

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
