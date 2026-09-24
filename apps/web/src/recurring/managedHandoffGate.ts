/**
 * The reasons the managed hand-offs give when they will not move this browser's copy
 * of the shared secret: the one that holds a confirmation back before it spends the
 * copy, the two an attempted confirmation is refused with, and the two an import
 * meets afterwards -- when the copy is already gone, and when this browser cannot
 * read whether it is.
 *
 * The device migration's "I saved the file" and the command-line export's "I saved
 * both files" each hand that copy to a new owner. A run rotates the secret at its
 * handshake, before any data is exchanged (see `managedRunDriver.ts`), so a copy
 * handed over across a run is one the rotation supersedes: its first run meets a
 * partner that has moved on, and nothing short of a re-invite recovers the pair.
 * There are two ways to be on the wrong side of that rotation, and they call for
 * different remedies -- wait, or download again -- so they say different things.
 *
 * What happened is stated in the same words at both hand-offs, as the surfaces
 * that start an exchange share one offline reason (`offlineExchangeGate.ts`).
 * Neither names a file, since the migration downloads one and the command-line
 * export two, and what goes out of date is the copy whichever shape it took.
 *
 * What to DO about it differs per hand-off, since a refusal is only useful where
 * the operator is standing: the command-line panel's own download button sits
 * beside its confirmation, while the migration's confirmation is a whole screen
 * that replaces the one stating "Move to another device". The remedy is per
 * hand-off ({@link supersededHandoffReason}), naming a control on the screen
 * showing it. A record that is gone from this browser has no remedy of that shape
 * at either hand-off -- there is nothing left here to download -- so that refusal
 * says so instead.
 */

import type { ManagedSpentHandoff } from "@psi/managed/managedLocalState";

/** Which hand-off a refusal is being shown at, which decides the way out it names.
 * `"command-line"` is the export panel on the detail surface, whose download button
 * stands beside its confirmation; `"migration"` is the "Confirm the move" screen,
 * which replaces the screen its own download control lives on. */
type ManagedHandoffKind = "command-line" | "migration";

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
  "partner, so a copy handed over now can already be out of date. When it " +
  "finishes, choose hand off again.";

/** The heading the superseded reason is shown under, at both hand-offs. It names
 * the state rather than the remedy, which differs by hand-off. */
export const SUPERSEDED_HANDOFF_TITLE = "That copy is out of date";

/**
 * What happened when a confirmation is refused as superseded: the exchange's secret
 * moved between the download and the attestation, so what was downloaded is no
 * longer this exchange's. It names both things that move the secret rather than
 * only the run, so the sentence is not false to an operator who knows nothing ran.
 * Shown with the hand-off's own remedy after it ({@link supersededHandoffReason}).
 */
const SUPERSEDED_HANDOFF_EXPLANATION =
  "This exchange's secret has changed since you downloaded it -- a run changes " +
  "it, and so does creating a fresh invitation -- so what you downloaded would " +
  "not work for whoever received it. Nothing was handed over.";

/** Taking a fresh copy, from where each hand-off's refusal is shown. The operator's
 * files are already on disk and the useless ones must be replaced rather than kept,
 * so each names the control that replaces them on the screen in front of them. */
const SUPERSEDED_HANDOFF_REMEDY: Record<ManagedHandoffKind, string> = {
  "command-line":
    "Download the two files again, then confirm the hand-off with those.",
  migration:
    'Choose "Keep it on this device", then move it again to download a copy ' +
    "that works.",
};

/**
 * The superseded refusal for a hand-off: what happened, then the way out from where
 * the operator is standing.
 */
export function supersededHandoffReason(handoff: ManagedHandoffKind): string {
  return `${SUPERSEDED_HANDOFF_EXPLANATION} ${SUPERSEDED_HANDOFF_REMEDY[handoff]}`;
}

/** The heading the record-gone reason is shown under, at both hand-offs. */
export const RECORD_GONE_HANDOFF_TITLE = "This exchange is no longer here";

/**
 * The other way a confirmation is refused: the record is no longer in this browser
 * at all -- deleted, or cleared with the browser's storage -- while the downloaded
 * files sat waiting for the attestation. Shared by both hand-offs, because neither
 * has a download to offer for a record that is not there: the superseded refusal's
 * "download it again" is exactly the sentence this case must not state.
 */
export const RECORD_GONE_HANDOFF_REASON =
  "This exchange is no longer in this browser -- it was deleted, or cleared " +
  "along with the browser's storage -- so there was no copy here to hand over " +
  "and nothing was written. What you already downloaded is all that is left of " +
  "it: keep those files if you still need this exchange, and set it up again " +
  "with your partner if you do not have them.";

/** The heading the refused-import reason is shown under, at the import affordance. */
export const HANDED_OFF_IMPORT_TITLE = "That exchange was handed off";

/**
 * The refusal an import meets when the backup file it was given belongs to an
 * exchange this browser has already handed off: the copy the file would bring back is
 * one the hand-off gave away, so the import is refused rather than reviving it or
 * installing a second live copy beside the handed-off one. Keyed by the hand-off,
 * because what the operator has instead is whatever that hand-off saved -- a route
 * added later must say its own recovery here rather than inherit this one.
 *
 * The command-line route's recovery is the re-take on the handed-off exchange's own
 * surface ({@link ./managedRetakeModel.ts}), named by the words of its control: the
 * import is on the list, so an operator meeting this refusal is not on the screen
 * that offers the re-take.
 */
const HANDED_OFF_IMPORT_REASON: Record<
  ManagedSpentHandoff,
  (named: string) => string
> = {
  "command-line": (named) =>
    `${named} is still here, handed off to the command line: it runs from the ` +
    "alcove.yaml and .alcove.key you saved, on the machine you saved them to, " +
    "and that machine is its one owner. A backup file taken before the hand-off " +
    "would run a copy you gave away, so nothing was imported. To run this " +
    'exchange in this browser again, open it from the list and choose "Take ' +
    'this exchange back".',
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

/** The heading the unreadable-custody refusal is shown under, at the import
 * affordance. It names this browser's stored copy, the thing that could not be read,
 * in the words the run's own unreadable-custody refusal uses
 * (`managedRunLaunchModel.ts`): the backup file is fine, so a heading about the file
 * would send the operator after the wrong fault. */
export const CUSTODY_UNREADABLE_IMPORT_TITLE =
  "Part of that exchange's stored copy could not be read";

/**
 * The refusal an import meets when this browser still holds the exchange but cannot
 * read the note it keeps beside it, which is where a hand-off is recorded: a
 * hand-off can be neither confirmed nor ruled out, so the import is refused and no
 * route is named, none having been read. Only the operator knows whether they handed
 * the exchange off, so the reason gives them what to do either way -- and the delete
 * it offers is the one the read-failed listing on that page already provides.
 */
export function custodyUnreadableImportReason(label: string): string {
  const named = label === "" ? "that exchange" : `"${label}"`;
  return (
    `This browser could not read the note it keeps beside ${named} -- the one ` +
    "recording whether this copy was handed off somewhere else -- so nothing " +
    "was imported. If you handed this exchange off, it runs from the files you " +
    "saved then and there is nothing here to import. If you did not, delete " +
    "that exchange from the list on this page, then import the backup file " +
    "again."
  );
}

/**
 * The refusal a command-line `alcove.yaml` and `.alcove.key` meet when the key
 * file's secret matches an exchange this browser handed off to the command line.
 * Those files are what the hand-off saved, and the route that brings them back is
 * the re-take on that exchange's own surface: it asks the operator to stop the
 * command-line run first, which an import has no place to ask. Keyed by the
 * hand-off, as {@link handedOffImportReason} is.
 */
const HANDED_OFF_PAIR_IMPORT_REASON: Record<
  ManagedSpentHandoff,
  (named: string) => string
> = {
  "command-line": (named) =>
    `${named} is still here, handed off to the command line, and these are ` +
    "the files it runs from there, so nothing was imported. To run it in " +
    'this browser again, open it from the list, choose "Take this exchange ' +
    'back", and choose this .alcove.key there.',
};

/** {@link handedOffImportReason} for a command-line pair's import. */
export function handedOffPairImportReason(
  handoff: ManagedSpentHandoff,
  label: string,
): string {
  return HANDED_OFF_PAIR_IMPORT_REASON[handoff](
    label === "" ? "That exchange" : `"${label}"`,
  );
}

/** {@link custodyUnreadableImportReason} for a command-line pair's import: the
 * same fault, with the files to import again named as the pair, and the
 * command-line run to stop before this browser runs the exchange too. */
export function custodyUnreadablePairImportReason(label: string): string {
  const named = label === "" ? "that exchange" : `"${label}"`;
  return (
    `This browser could not read the note it keeps beside ${named} -- the one ` +
    "recording whether this copy was handed off somewhere else -- so nothing " +
    "was imported. Delete that exchange from the list on this page, then " +
    "import the alcove.yaml and .alcove.key again. If you handed it off to " +
    "the command line, stop the scheduled run there first."
  );
}
