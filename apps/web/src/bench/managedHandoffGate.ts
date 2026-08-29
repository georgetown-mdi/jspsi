/**
 * The one reason both managed hand-off confirmations give while a run for that
 * exchange is in flight.
 *
 * The device migration's "I saved the file" and the command-line export's "I
 * saved both files" each spend this browser's copy of the shared secret. A run
 * rotates that secret at its handshake, before any data is exchanged (see
 * `managedRunDriver.ts`), so a spend confirmed mid-run hands the new owner a copy
 * the rotation supersedes: its first run meets a partner that has moved on, and
 * nothing short of a re-invite recovers the pair.
 *
 * Both confirmations state it in the same words -- as the surfaces that start an
 * exchange share one offline reason (`offlineExchangeGate.ts`) -- so an operator
 * held back at either hand-off meets one explanation rather than a sentence per
 * screen. It names no file, since the migration downloads one and the
 * command-line export two, and what goes out of date is the copy whichever shape
 * it took.
 */
export const RUN_IN_FLIGHT_HANDOFF_REASON =
  "This exchange is running right now. A run changes its shared secret as soon " +
  "as it connects to your partner, so what you downloaded can already be out " +
  "of date -- confirming now would hand over a copy that no longer works. " +
  "Download again once the run finishes.";

/** The heading the reason above is shown under, at both hand-offs. */
export const RUN_IN_FLIGHT_HANDOFF_TITLE = "Wait for this run to finish";
