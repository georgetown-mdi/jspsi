/**
 * The platform boundary for the between-visit notification: the operator's own
 * opt-in, the browser's notification permission, and the one call that shows a
 * notice ({@link ./betweenVisitNotice.ts} decides what it says).
 *
 * OPT-IN ONLY. Nothing here asks the browser for permission until the operator
 * takes the affirmative step {@link enableBetweenVisitNotifications} is wired to,
 * so no visit meets a permission prompt it did not ask for -- a prompt at first
 * load is refused once and cannot be asked again. A refusal, a dismissal, an
 * engine without the API, and an operator who never opts in all leave the same
 * behaviour: nothing is shown between visits, and every state reaches the next
 * in-app visit exactly as it does today.
 *
 * The opt-in is remembered in `localStorage` under {@link OPT_IN_STORAGE_KEY},
 * this device's own choice rather than anything about a run: the run bookkeeping
 * is untouched, and an exchange exported to another device carries no opt-in with
 * it. A browser that refuses storage leaves the choice unremembered, which reads
 * as not opted in.
 *
 * The notification itself is shown through the app-shell service worker's
 * registration where there is one, and constructed directly otherwise: an engine
 * that only permits the worker route (Android Chrome) throws on the constructor,
 * and an installed runtime without a worker registration has only the
 * constructor.
 */

import { getLogger } from "@alcove/core";

import type { BetweenVisitNotice } from "./betweenVisitNotice";

const log = getLogger("betweenVisitNotifier");

/** The localStorage key holding this device's opt-in. */
const OPT_IN_STORAGE_KEY = "alcove-between-visit-notifications";

/** The stored value that means opted in. Any other stored value, and a key that
 * is absent or unreadable, reads as not opted in. */
const OPT_IN_STORAGE_VALUE = "on";

/**
 * What the operator's control shows, and what the runner reads:
 *
 * - `"unsupported"` -- this engine has no notification API, so nothing can be
 *   shown between visits and there is nothing to offer.
 * - `"blocked"` -- the browser refuses notifications for this app. It cannot be
 *   asked again from here; the operator's own browser settings are the only way
 *   back.
 * - `"off"` -- notifications can be asked for and the operator has not opted in
 *   (or asked and dismissed the prompt without answering).
 * - `"on"` -- the operator opted in and the browser permits it.
 */
export type BetweenVisitNotificationState =
  "unsupported" | "blocked" | "off" | "on";

/** The notification API as this engine holds it, or `undefined` where it holds
 * none -- a server render, an engine without the API, or a browsing mode that
 * withholds it. */
function notificationApi(): typeof Notification | undefined {
  const api = (globalThis as { Notification?: typeof Notification })
    .Notification;
  return typeof api === "function" ? api : undefined;
}

/** Where the opt-in and the browser's permission leave this app right now. */
export function betweenVisitNotificationState(): BetweenVisitNotificationState {
  const api = notificationApi();
  if (api === undefined) return "unsupported";
  if (api.permission === "denied") return "blocked";
  if (!optedIn()) return "off";
  return api.permission === "granted" ? "on" : "off";
}

/** Whether a notice raised right now would be shown: the operator opted in and
 * the browser still permits it. The runner reads this at every wake, so a
 * permission the operator revoked in their browser settings stops the notices
 * without anything else having to notice. */
export function betweenVisitNotificationsArmed(): boolean {
  return betweenVisitNotificationState() === "on";
}

/**
 * Ask for notification permission on the operator's own affirmative step and
 * remember the opt-in where it is granted, reporting where that left things.
 *
 * The permission request is made HERE and nowhere else, so it always follows an
 * action the operator took. A dismissed prompt leaves `"off"`: the browser was
 * not answered, the opt-in is not remembered, and the same control asks again.
 */
export async function enableBetweenVisitNotifications(): Promise<BetweenVisitNotificationState> {
  const api = notificationApi();
  if (api === undefined) return "unsupported";
  if (api.permission === "denied") return "blocked";
  if (api.permission !== "granted") {
    let permission: NotificationPermission;
    try {
      permission = await api.requestPermission();
    } catch (error) {
      log.warn("between-visit notification permission request failed:", error);
      return "off";
    }
    if (permission === "denied") return "blocked";
    if (permission !== "granted") return "off";
  }
  rememberOptIn(true);
  return betweenVisitNotificationState();
}

/** Drop the opt-in. The browser's permission is the browser's to hold; this is
 * the app's own half, and the same control turns it back on. */
export function disableBetweenVisitNotifications(): void {
  rememberOptIn(false);
}

/**
 * Show one notice, best-effort: a platform that refuses it leaves the state for
 * the operator's next in-app visit, which holds it either way, so nothing here
 * rejects or retries.
 */
export async function showBetweenVisitNotice(
  notice: BetweenVisitNotice,
): Promise<void> {
  const api = notificationApi();
  if (api === undefined) return;
  const options: NotificationOptions = { body: notice.body, tag: notice.tag };
  const registration = await appShellRegistration();
  try {
    if (registration !== undefined) {
      await registration.showNotification(notice.title, options);
      return;
    }
    new api(notice.title, options);
  } catch (error) {
    log.warn("between-visit notification was not shown:", error);
  }
}

/** The app-shell worker's registration, where this engine has one to show a
 * notification through. */
async function appShellRegistration(): Promise<
  ServiceWorkerRegistration | undefined
> {
  const container = (globalThis as { navigator?: Navigator }).navigator
    ?.serviceWorker;
  if (container === undefined) return undefined;
  try {
    const registration = await container.getRegistration();
    return typeof registration?.showNotification === "function"
      ? registration
      : undefined;
  } catch (error) {
    log.warn("between-visit notification could not reach a worker:", error);
    return undefined;
  }
}

/** Whether this device holds the operator's opt-in. */
function optedIn(): boolean {
  try {
    return (
      globalThis.localStorage.getItem(OPT_IN_STORAGE_KEY) ===
      OPT_IN_STORAGE_VALUE
    );
  } catch {
    return false;
  }
}

/** Write or clear the opt-in, best-effort: a browser that will not keep it
 * leaves the operator opted out, which is the quiet direction. */
function rememberOptIn(on: boolean): void {
  try {
    if (on)
      globalThis.localStorage.setItem(OPT_IN_STORAGE_KEY, OPT_IN_STORAGE_VALUE);
    else globalThis.localStorage.removeItem(OPT_IN_STORAGE_KEY);
  } catch (error) {
    log.warn("between-visit notification choice was not stored:", error);
  }
}
