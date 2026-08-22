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
 */

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
let applyRequested = false;
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

/** The seams `registerAppShell` reads the environment through, so a test can
 * drive both without a browser. */
export interface RegisterAppShellOptions {
  /** Reload onto newly activated code. Defaults to the page's own reload. */
  reload?: () => void;
  /** Whether this page is running as an INSTALLED app rather than a browser
   * tab. Defaults to the display-mode media query the manifest's `standalone`
   * display produces. */
  isInstalledRuntime?: () => boolean;
}

/**
 * Register the worker, watch for a newer one, and -- in an installed app -- have
 * it cache every route's code. Resolves whether or not the registration
 * succeeded, so the call site can fire it and move on.
 *
 * `updateViaCache: "none"` keeps the browser's HTTP cache out of the worker
 * script's own update check, so a redeployed worker is seen on the next check
 * rather than after an intermediary's freshness lifetime.
 *
 * A newly `installed` worker is only an UPDATE when a controller is already
 * running this page; without one it is the first install, which activates by
 * itself and has nothing to prompt about.
 *
 * The route warm is asked for from an installed app alone, and asked for again
 * on a controller change so a first install (which claims this page after
 * registration returns) is not missed. What it costs, and why an ordinary tab is
 * left to fill its cache in by use, is in the worker's `SHELL_ROUTES`.
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
  const isInstalledRuntime =
    options.isInstalledRuntime ??
    (() =>
      typeof window !== "undefined" &&
      window.matchMedia("(display-mode: standalone)").matches);
  function warmRoutes(): void {
    if (!isInstalledRuntime()) return;
    container.controller?.postMessage(WARM_ROUTES_MESSAGE);
  }
  container.addEventListener("controllerchange", () => {
    // A controller change also happens on the first install, when the worker
    // claims this page: reload only the change this module asked for, or every
    // first visit would reload itself.
    if (applyRequested) {
      reload();
      return;
    }
    warmRoutes();
  });
  try {
    registration = await container.register(SERVICE_WORKER_URL, {
      scope: "/",
      updateViaCache: "none",
    });
  } catch {
    // register() rejects on a network failure -- a first load that is already
    // offline, the case this feature exists for -- and on a script or security
    // error. What is lost is the offline shell, not a capability: an
    // uncontrolled page fetches everything from the network and works. So this
    // degrades in silence, the way the worker's own precache does, rather than
    // rejecting into a caller that has nothing to do about it.
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
 * Apply the waiting update: tell it to take over, which fires the controller
 * change that reloads the page onto the new code. Does nothing when no worker is
 * waiting, which is also the state right after this already ran once: posting
 * the message clears `registration.waiting`, so a declined reload leaves the
 * banner's Reload inert and a manual browser reload is the operator's only way
 * to pick the update back up.
 */
export function applyAppShellUpdate(): void {
  const waiting = registration?.waiting;
  if (waiting === null || waiting === undefined) return;
  applyRequested = true;
  waiting.postMessage(SKIP_WAITING_MESSAGE);
}

/** @internal */
export function resetAppShellUpdate(): void {
  updateReady = false;
  registration = undefined;
  applyRequested = false;
  listeners.clear();
}
