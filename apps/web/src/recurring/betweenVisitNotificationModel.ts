/**
 * What the operator reads and can act on about between-visit notifications: one
 * note per state and the control that changes it, if any.
 *
 * Opt-in only, and the copy states what the app does rather than urging: the
 * browser's permission prompt follows the operator's press of the control
 * ({@link ../psi/managed/betweenVisitNotifier.ts}). Every state names the same
 * standing fact -- what a scheduled run leaves is at the next visit either way --
 * so a refusal costs the head start and not the result.
 */

import type { BetweenVisitNotificationState } from "@psi/managed/betweenVisitNotifier";

/** The control the note offers, absent where there is nothing to press: a
 * browser refusing notifications cannot be asked again from here. */
export interface BetweenVisitNotificationAction {
  /** The control's label. */
  label: string;
  /** Whether pressing it asks for notifications or stops them. */
  turnsOn: boolean;
}

/** The note and its control for one state. */
export interface BetweenVisitNotificationDisplay {
  /** Where notifications stand, and what pressing the control does. */
  note: string;
  /** The control, absent where the state offers none. */
  action?: BetweenVisitNotificationAction;
}

/**
 * The note and control for a state, or `undefined` where nothing is shown at all
 * -- an engine with no notification API has nothing to offer and no limit worth
 * raising, since not showing one is what it already does.
 */
export function betweenVisitNotificationDisplay(
  state: BetweenVisitNotificationState,
): BetweenVisitNotificationDisplay | undefined {
  if (state === "unsupported") return undefined;
  if (state === "blocked")
    return {
      note:
        "This browser is blocking notifications for this app, so nothing is " +
        "shown between visits. What each scheduled run leaves is still here " +
        "the next time you open the app. To turn notifications on, allow them " +
        "for this site in your browser's settings.",
    };
  if (state === "on")
    return {
      note:
        "Notifications are on: this app tells you when a scheduled run " +
        "finishes, needs you, or does not happen.",
      action: { label: "Stop notifying me between visits", turnsOn: false },
    };
  return {
    note:
      "Scheduled runs happen while you are away, and what each one leaves is " +
      "here the next time you open this app. Turn on notifications to hear " +
      "sooner about a run that finished, needs you, or did not happen.",
    action: { label: "Notify me between visits", turnsOn: true },
  };
}
