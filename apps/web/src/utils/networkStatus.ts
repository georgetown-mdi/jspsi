/**
 * The browser's own connectivity signal, as a subscribable store.
 *
 * Only ONE direction of `navigator.onLine` is trustworthy. `false` means the
 * browser has no network interface it could reach anything through, so a request
 * cannot succeed; `true` means only that an interface exists, not that the
 * origin, the peer-coordination server, or the partner is reachable. Everything
 * built on this store therefore states the offline case and stays silent
 * otherwise -- it is never used to claim an exchange will work.
 */

/** Whether the browser reports a usable network interface. `true` outside a
 * browser (server rendering), where there is no signal to read. */
export function isOnline(): boolean {
  if (typeof navigator === "undefined") return true;
  return navigator.onLine;
}

/** Subscribe to connectivity changes; returns the unsubscribe. Safe to call
 * outside a browser, where it subscribes to nothing. */
export function subscribeOnlineStatus(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
}
