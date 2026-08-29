/**
 * The reasons both managed hand-off confirmations give when they will not spend this
 * browser's copy of the shared secret.
 *
 * The device migration's "I saved the file" and the command-line export's "I saved
 * both files" each hand that copy to a new owner. A run rotates the secret at its
 * handshake, before any data is exchanged (see `managedRunDriver.ts`), so a copy
 * handed over across a run is one the rotation supersedes: its first run meets a
 * partner that has moved on, and nothing short of a re-invite recovers the pair.
 * There are two ways to be on the wrong side of that rotation, and they call for
 * different remedies -- wait, or download again -- so they say different things.
 *
 * Both hand-offs state each of them in the same words -- as the surfaces that start
 * an exchange share one offline reason (`offlineExchangeGate.ts`) -- so an operator
 * held back at either hand-off meets one explanation rather than a sentence per
 * screen. Neither names a file, since the migration downloads one and the
 * command-line export two, and what goes out of date is the copy whichever shape it
 * took.
 */

/** The heading the run-in-flight reason is shown under, at both hand-offs. */
export const RUN_IN_FLIGHT_HANDOFF_TITLE = "Wait for this run to finish";

/**
 * A run of this exchange is under way, so there is no point starting or finishing a
 * hand-off: the secret it would hand over is about to change. Names the contexts a
 * run can be under way in, because the operator looking at this screen may not be
 * the one who started it.
 */
export const RUN_IN_FLIGHT_HANDOFF_REASON =
  "This exchange is running right now -- in this browser, in another tab, or on " +
  "its schedule. A run changes its shared secret as soon as it connects to your " +
  "partner, so a copy handed over now can already be out of date. Hand this " +
  "exchange over once the run finishes.";

/** The heading the superseded reason is shown under, at both hand-offs. */
export const SUPERSEDED_HANDOFF_TITLE = "Download this exchange again";

/**
 * The confirmation was refused: the exchange's secret moved between the download and
 * the attestation, so what was downloaded is no longer this exchange's. Leads with
 * what happened and closes on the remedy, since the operator's files are already on
 * disk and the useless ones must be replaced rather than kept. It names both things
 * that move the secret rather than only the run, so the sentence is not false to an
 * operator who knows nothing ran.
 */
export const SUPERSEDED_HANDOFF_REASON =
  "This exchange's secret has changed since you downloaded it -- a run changes " +
  "it, and so does creating a fresh invitation -- so what you downloaded would " +
  "not work for whoever received it. Nothing was handed over. Download this " +
  "exchange again, then confirm.";
