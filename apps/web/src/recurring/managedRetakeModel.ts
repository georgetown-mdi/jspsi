/**
 * What the re-take offers and what it says when it writes nothing: the copy of the
 * action a spent record's surface carries to bring a command-line hand-off back to
 * this browser ({@link ../psi/managed/managedRetake.ts}).
 *
 * The action is attested, because the operator is the only one who knows the two
 * things the browser cannot see: whether the scheduled run on the other machine has
 * been stopped, and whether it has run since the hand-off. So the confirmation
 * states what taking it back does, what must already be true, which file answers
 * the second question, and what choosing the wrong one costs -- and declining
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

/** Which file to choose, why, and what the wrong one costs. Every command-line run
 * writes the secret it rotated to back into `.psilink.key`, so that file is where
 * the partnership's current secret is after a run there. The file holds nothing
 * naming the exchange it belongs to, so nothing here can tell this exchange's key
 * file from another exchange's or from a stale copy of it, and whichever is chosen
 * replaces the only secret this browser holds. The confirmation states that cost
 * and where the right file is; it does not refuse the operator's choice. */
export const RETAKE_KEY_FILE_NOTE =
  "If that machine has run this exchange since you handed it off, choose the " +
  ".psilink.key file you saved there -- each run changes the shared secret and " +
  "writes it to that file, so it holds the one your partner expects. Take it " +
  "from the folder holding this exchange's psilink.yaml: every exchange's key " +
  "file has that same name, and the one you choose replaces the only copy of " +
  "the secret this browser has for this exchange. Another exchange's file, or " +
  "an older copy of this one, leaves this exchange unable to connect to your " +
  "partner, and the way back is a fresh invitation they have to accept again.";

/** The case needing no file, and the way out when the file cannot be produced. The
 * fresh invitation is the recovery a secret this browser cannot match always has. */
export const RETAKE_NO_KEY_FILE_NOTE =
  "If it has not run since you handed it off, you do not need the file. If you " +
  "cannot get the file, take the exchange back without it and create a fresh " +
  "invitation for your partner from this page.";

/** The confirmation's own button: what pressing it does, in the words of the
 * action. */
export const RETAKE_CONFIRM_LABEL = "Take it back";

/** What a re-take that wrote nothing shows: the heading it is shown under and the
 * reason below it. */
export interface ManagedRetakeRefusal {
  title: string;
  reason: string;
}

/** The refusal each non-writing result of a take-back is shown as. Exhaustive over
 * those results, so one added without copy of its own fails to compile rather than
 * reaching the operator under another's heading.
 *
 * An unreadable key file names the file and what to check about it, never anything
 * the parser read: the file's bytes are the secret. */
const RETAKE_REFUSALS: Record<
  Exclude<ManagedRetakeResult["kind"], "retaken">,
  ManagedRetakeRefusal
> = {
  "unreadable-key-file": {
    title: "That file could not be read",
    reason:
      "This is not a .psilink.key file this app can read. Check that you chose " +
      "the .psilink.key from the machine running this exchange, and that it " +
      "was not modified. Nothing changed here.",
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
      "take back. It still runs from the psilink.yaml and .psilink.key you " +
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
  kind: Exclude<ManagedRetakeResult["kind"], "retaken">,
): ManagedRetakeRefusal {
  return RETAKE_REFUSALS[kind];
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
