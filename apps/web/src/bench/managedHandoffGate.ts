/**
 * The reasons the managed hand-offs give when they will not move this browser's copy
 * of the shared secret: the two that hold a confirmation back before it spends the
 * copy, and the one an import meets afterwards, when the copy is already gone.
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

import type { ManagedSpentHandoff } from "@psi/managedLocalState";

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

/** The heading the refused-import reason is shown under, at the import affordance. */
export const HANDED_OFF_IMPORT_TITLE = "That exchange was handed off";

/**
 * The refusal an import meets when the backup file it was given belongs to an
 * exchange this browser has already handed off: the copy the file would bring back is
 * one the hand-off gave away, so the import is refused rather than reviving it or
 * installing a second live copy beside the handed-off one. Keyed by the hand-off,
 * because what the operator has instead is whatever that hand-off saved -- a route
 * added later must say its own recovery here rather than inherit this one.
 */
const HANDED_OFF_IMPORT_REASON: Record<
  ManagedSpentHandoff,
  (named: string) => string
> = {
  "command-line": (named) =>
    `${named} is still here, handed off to the command line: it runs from the ` +
    "psilink.yaml and .psilink.key you saved, on the machine you saved them to, " +
    "and that machine is its one owner. A backup file taken before the hand-off " +
    "would run a copy you gave away, so nothing was imported. To run this " +
    "exchange in this browser again, create a fresh invitation for your partner.",
};

/**
 * The refused-import reason for the hand-off that spent the stored copy, naming the
 * exchange as the operator knows it. An unlabeled exchange is named neutrally rather
 * than by an empty pair of quotes.
 */
export function handedOffImportReason(
  handoff: ManagedSpentHandoff,
  label: string,
): string {
  return HANDED_OFF_IMPORT_REASON[handoff](
    label === "" ? "That exchange" : `"${label}"`,
  );
}
