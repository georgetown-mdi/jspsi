/**
 * What the re-take offers and what it says when it writes nothing: the copy of the
 * action a spent record's surface carries to bring a command-line hand-off back to
 * this browser ({@link ../psi/managed/managedRetake.ts}).
 *
 * The action is attested, because the operator is the only one who knows the two
 * things the browser cannot see: whether the scheduled run on the other machine has
 * been stopped, and whether it has run since the hand-off. So the confirmation
 * states what taking it back does, what must already be true, which files answer
 * the second question, and what choosing the wrong ones costs -- and declining
 * writes nothing.
 *
 * The refusals are held apart on what the operator does next, as the hand-off's own
 * are ({@link ./managedHandoffGate.ts}): wait out a run, nothing at all, or look
 * again at what this browser holds.
 */

import { RUN_IN_FLIGHT_HANDOFF_TITLE } from "./managedHandoffGate";

import type { ManagedRetakeResult } from "@psi/managed/managedRetake";

/** The label of the control that opens the confirmation, and of the confirmation
 * itself: one name for the action, so what the operator pressed and what they are
 * being asked about read as the same thing. */
export const RETAKE_ACTION_LABEL = "Take this exchange back";

/** What taking it back does, and the one thing that must already be true. Two
 * copies running the same exchange each rotate the secret, and the one that rotates
 * second leaves the other unable to connect. */
export const RETAKE_LEAD =
  "Taking this exchange back makes this browser the one that runs it. Stop " +
  "the scheduled run on the machine you handed it to first: if both keep " +
  "running it, each run changes the shared secret and the other one stops " +
  "being able to connect to your partner.";

/** Which files to choose, why, and what the wrong ones cost. Every command-line
 * run writes the secret it rotated to back into `.alcove.key`, so that file is
 * where the partnership's current secret is after a run there. The key file names
 * no exchange, so the `alcove.yaml` beside it is chosen too, and a pair on other
 * terms or the other side is refused. Nothing here tells a stale key file from
 * the current one, or this exchange's from another on the same terms and side,
 * and whichever is chosen replaces the only secret this browser holds. The
 * confirmation states that cost and where the right files are. */
export const RETAKE_KEY_FILE_NOTE =
  "If that machine has run this exchange since you handed it off, choose the " +
  "alcove.yaml and the .alcove.key beside it, both at once, from the folder " +
  "you saved them to there -- each run changes the shared secret and writes it " +
  "to the .alcove.key, so it holds the one your partner expects. Files for " +
  "other terms or the other side are refused. The key file you choose " +
  "replaces the only copy of the secret this browser has for this exchange, " +
  "so an older copy of it, or another exchange's on the same terms, leaves " +
  "this exchange unable to connect to your partner, and the way back is a " +
  "fresh invitation they have to accept again.";

/** The case needing no file, and the way out when the file cannot be produced. The
 * fresh invitation is the recovery a secret this browser cannot match always has. */
export const RETAKE_NO_KEY_FILE_NOTE =
  "If it has not run since you handed it off, you do not need the files. If " +
  "you cannot get them, take the exchange back without them and create a " +
  "fresh invitation for your partner from this page.";

/** The files the confirmation was given are not an `alcove.yaml` and the
 * `.alcove.key` beside it: one file, more than two, or two that are not one of
 * each. Refused before either is read. */
export const RETAKE_NOT_A_PAIR: ManagedRetakeRefusal = {
  title: "Choose both files",
  reason:
    "Choose the alcove.yaml and the .alcove.key beside it, both in the same " +
    "file chooser. The .alcove.key alone cannot show which exchange it " +
    "belongs to. Nothing changed here.",
};

/** The confirmation's own button: what pressing it does, in the words of the
 * action. */
export const RETAKE_CONFIRM_LABEL = "Take it back";

/** What a re-take that wrote nothing shows: the heading it is shown under and the
 * reason below it. */
export interface ManagedRetakeRefusal {
  title: string;
  reason: string;
}

/** What a pair on other agreed terms, or on the other side, is refused with. The
 * other side's files are what the partner holds: the same terms and, after the
 * same run, the same secret. */
const RETAKE_MISMATCH_REASON: Record<"terms" | "side", string> = {
  terms:
    "The alcove.yaml you chose states different terms from this exchange, so " +
    "these are another exchange's files and nothing was taken back. Choose " +
    "the two files from the folder this exchange was handed off to.",
  side:
    "The alcove.yaml you chose is for the other side of this exchange -- your " +
    "partner's files state the same terms from their side -- so nothing was " +
    "taken back. Choose the two files you saved when you handed it off.",
};

/** The refusal each non-writing result of a take-back is shown as. Exhaustive over
 * those results, so one added without copy of its own fails to compile rather than
 * reaching the operator under another's heading.
 *
 * Unreadable files are named with what to check about them, never anything the
 * parser read: the key file's bytes are the secret. */
const RETAKE_REFUSALS: Record<
  Exclude<ManagedRetakeResult["kind"], "retaken" | "mismatch">,
  ManagedRetakeRefusal
> = {
  "unreadable-files": {
    title: "Those files could not be read",
    reason:
      "These are not an alcove.yaml and .alcove.key this app can take back. " +
      "Check that you chose the two files from the machine running this " +
      "exchange, and that neither was modified. Nothing changed here.",
  },
  "run-in-flight": {
    title: RUN_IN_FLIGHT_HANDOFF_TITLE,
    reason:
      "This exchange is running right now -- in this browser, in another tab, " +
      "or on its schedule. That run changes the shared secret, so nothing was " +
      "taken back. When it finishes, choose take it back again.",
  },
  gone: {
    title: "This exchange is no longer here",
    reason:
      "This exchange is no longer in this browser -- it was deleted, or " +
      "cleared along with the browser's storage -- so there is nothing here to " +
      "take back. It still runs from the alcove.yaml and .alcove.key you " +
      "saved; set the exchange up again with your partner if you do not have " +
      "them.",
  },
  "not-handed-off": {
    title: "This exchange is not handed off",
    reason:
      "This browser's copy of this exchange is not waiting on a command-line " +
      "hand-off -- another tab may have taken it back already. Nothing " +
      "changed. Reload this page to see where it stands.",
  },
};

/** The refusal for a result that wrote nothing. */
export function managedRetakeRefusal(
  result: Exclude<ManagedRetakeResult, { kind: "retaken" }>,
): ManagedRetakeRefusal {
  if (result.kind === "mismatch")
    return {
      title: "Those are not this exchange's files",
      reason: RETAKE_MISMATCH_REASON[result.on],
    };
  return RETAKE_REFUSALS[result.kind];
}

/** What a take-back the store could not complete shows. The store raises only where
 * this browser's own stored state is at fault -- a record it cannot read, a database
 * that would not write -- so this names neither the file nor the hand-off, and the
 * record is still spent. */
export const RETAKE_STORE_FAILED: ManagedRetakeRefusal = {
  title: "This exchange was not taken back",
  reason:
    "This browser could not take the exchange back. Nothing changed here, and " +
    "it still runs from the files you saved. Try again.",
};
