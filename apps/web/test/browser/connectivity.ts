/**
 * Control of the browser's connectivity signal for a test.
 *
 * `navigator.onLine` is a read-only accessor on the prototype, so it is pinned
 * with an own property on the instance rather than set. The event goes with it:
 * the app subscribes to `online`/`offline` and would otherwise never re-read the
 * pinned value.
 */

/** Pin `navigator.onLine` and fire the event the platform fires with it. */
export function setConnectivity(online: boolean): void {
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    get: () => online,
  });
  window.dispatchEvent(new Event(online ? "online" : "offline"));
}

/** Drop the pin so the platform's own signal shows through again. Safe to call
 * when nothing was pinned, so it composes into an unconditional teardown. */
export function restoreConnectivity(): void {
  delete (window.navigator as unknown as { onLine?: boolean }).onLine;
  window.dispatchEvent(new Event("online"));
}
