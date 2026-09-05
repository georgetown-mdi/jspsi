/**
 * Registration of the app-shell service worker (`apps/web/public/serviceWorker.js`)
 * and the store behind the "an update is ready" surface.
 *
 * The worker never calls `skipWaiting()` on install, so a new deployment's code
 * sits in the `waiting` state behind the worker running this page rather than
 * swapping under it mid-exchange (the reasoning is in the worker's own header).
 * This module is the other half of that: it notices the waiting worker, publishes
 * it so the shell can say so, and applies it -- with a reload -- only when the
 * operator asks. A waiting worker that is never applied still takes over at the
 * next cold start; the prompt shortens that wait, it is not what bounds it.
 *
 * Applying is ordered so that the reload leads and the takeover follows it: the
 * message that ends the wait is posted as the page unloads, which is the first
 * moment the reload is known to be happening. A reload the operator declines at
 * the browser's own confirmation therefore costs nothing -- the page keeps its
 * code, the update keeps waiting, and the banner's Reload applies it whenever
 * the operator is ready.
 */

import { isInstalledRuntime as installedRuntime } from "./installedRuntime";

/** The worker's URL. It is served from `public/`, so its scope is the origin
 * root -- which is what lets it handle navigations to every route. */
export const SERVICE_WORKER_URL = "/serviceWorker.js";

/** The message that makes a waiting worker take over now. Mirrored by
 * `SKIP_WAITING_MESSAGE` in `apps/web/public/serviceWorker.js`. */
export const SKIP_WAITING_MESSAGE = "psilink-skip-waiting";

/** The message that has the worker cache every route's code, not just the
 * shell's. Mirrored by `WARM_ROUTES_MESSAGE` in
 * `apps/web/public/serviceWorker.js`. */
export const WARM_ROUTES_MESSAGE = "psilink-warm-routes";

/** The subset of `ServiceWorker` this module drives. Structural, so a test can
 * supply a plain object in place of a real worker. */
export interface ShellWorker {
  readonly state: string;
  readonly postMessage: (message: unknown) => void;
  readonly addEventListener: (
    type: "statechange",
    listener: () => void,
  ) => void;
}

/** The subset of `ServiceWorkerRegistration` this module drives. */
export interface ShellRegistration {
  readonly installing: ShellWorker | null;
  readonly waiting: ShellWorker | null;
  readonly addEventListener: (
    type: "updatefound",
    listener: () => void,
  ) => void;
}

/** The subset of `ServiceWorkerContainer` this module drives. */
export interface ShellContainer {
  readonly controller: ShellWorker | null;
  readonly register: (
    scriptUrl: string,
    options: { scope: string; updateViaCache: "none" },
  ) => Promise<ShellRegistration>;
  readonly addEventListener: (
    type: "controllerchange",
    listener: () => void,
  ) => void;
}

let updateReady = false;
let registration: ShellRegistration | undefined;
let takeoverArmed = false;
let applyUpdate: (() => void) | undefined;
const listeners = new Set<() => void>();

function publish(value: boolean): void {
  if (updateReady === value) return;
  updateReady = value;
  for (const listener of listeners) listener();
}

/** Whether a newer app version is installed and waiting to take over. */
export function appShellUpdateReady(): boolean {
  return updateReady;
}

/** Subscribe to {@link appShellUpdateReady} changes; returns the unsubscribe. */
export function subscribeAppShellUpdate(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The environment `registerAppShell` reads through, injectable so a test can
 * drive both without a browser. */
export interface RegisterAppShellOptions {
  /** Reload onto newly activated code. Defaults to the page's own reload. */
  reload?: () => void;
  /** Whether this page is running as an INSTALLED app rather than a browser
   * tab. Defaults to the display-mode media query the manifest's `standalone`
   * display produces. */
  isInstalledRuntime?: () => boolean;
  /** Call `listener` when this page is going away for good. Defaults to a
   * `pagehide` listener that ignores a persisted one: that is the back/forward
   * cache freezing the page, which can be restored still running this code. */
  onPageUnloading?: (listener: () => void) => void;
}

/**
 * Register the worker, watch for a newer one, and -- in an installed app --
 * have it cache every route's code. Resolves whether or not the registration
 * succeeded, so the call site can fire it and move on.
 *
 * `updateViaCache: "none"` keeps the browser's HTTP cache out of the worker
 * script's own update check, so a redeployed worker is seen on the next check.
 *
 * A newly `installed` worker is only an UPDATE when a controller is already
 * running this page; without one it is the first install.
 *
 * The route warm runs from an installed app alone, and again on a controller
 * change so a first install is not missed. Cost and rationale: the worker's
 * `SHELL_ROUTES`.
 */
export async function registerAppShell(
  container: ShellContainer,
  options: RegisterAppShellOptions = {},
): Promise<void> {
  const reload =
    options.reload ??
    (() => {
      window.location.reload();
    });
  const isInstalledRuntime = options.isInstalledRuntime ?? installedRuntime;
  const onPageUnloading =
    options.onPageUnloading ??
    ((listener: () => void) => {
      window.addEventListener("pagehide", (event) => {
        if (!event.persisted) listener();
      });
    });
  function warmRoutes(): void {
    if (!isInstalledRuntime()) return;
    container.controller?.postMessage(WARM_ROUTES_MESSAGE);
  }
  container.addEventListener("controllerchange", () => {
    // A page whose operator has asked for a takeover is on its way out, on this
    // reload or a later one, so it is the wrong place to start the several
    // megabytes a warm costs; the page that replaces it warms at its own
    // registration.
    if (takeoverArmed) return;
    warmRoutes();
  });
  applyUpdate = () => {
    const waiting = registration?.waiting;
    if (waiting === null || waiting === undefined) {
      if (updateReady) reload();
      return;
    }
    if (!takeoverArmed) {
      takeoverArmed = true;
      // Read the waiting worker again at unload rather than closing over the one
      // above: an update declined once can be superseded by a newer one before
      // the page finally goes.
      onPageUnloading(() => {
        registration?.waiting?.postMessage(SKIP_WAITING_MESSAGE);
      });
    }
    reload();
  };
  try {
    registration = await container.register(SERVICE_WORKER_URL, {
      scope: "/",
      updateViaCache: "none",
    });
  } catch {
    // register() rejects on a network failure -- a first load that is already
    // offline, the case this feature exists for -- and on a script or security
    // error. What is lost is the offline shell, not a capability: an
    // uncontrolled page fetches everything from the network and works. This
    // degrades in silence, the way the worker's own precache does.
    return;
  }
  warmRoutes();
  // A worker installed on an earlier visit and never applied is already waiting
  // by the time this runs, so there is no `updatefound` left to hear.
  if (registration.waiting !== null && container.controller !== null)
    publish(true);
  registration.addEventListener("updatefound", () => {
    const installing = registration?.installing;
    if (installing === null || installing === undefined) return;
    installing.addEventListener("statechange", () => {
      if (installing.state === "installed" && container.controller !== null)
        publish(true);
    });
  });
}

/**
 * Apply the waiting update: reload the page, and tell the waiting worker to
 * take over as that page unloads. The order is what makes the apply
 * recoverable -- the reload can still be stopped, by the confirmation a live
 * exchange arms (`apps/web/src/exchange/useUnloadGuard.ts`), and a stopped one
 * leaves the update waiting and this function ready to run again.
 *
 * The takeover is armed once and stays armed: an operator who declines the
 * reload and later closes the page has still asked for the update.
 *
 * When an update was announced but no worker is waiting -- another tab applied
 * it, and its takeover claimed this page -- the apply is a plain reload onto
 * the activated code.
 *
 * Does nothing before `registerAppShell` has a registration, or when no update
 * has been announced and no worker is waiting.
 */
export function applyAppShellUpdate(): void {
  applyUpdate?.();
}

/** @internal */
export function resetAppShellUpdate(): void {
  updateReady = false;
  registration = undefined;
  takeoverArmed = false;
  applyUpdate = undefined;
  listeners.clear();
}
