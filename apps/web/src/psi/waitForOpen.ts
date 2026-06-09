import { withTimeout } from "@psilink/core";

import type { DataConnection } from "peerjs";

/**
 * Default ceiling for a data channel to finish opening. Matches the order of
 * magnitude of the key exchange timeout: a channel that has not opened within
 * this window is almost certainly never going to.
 */
const DEFAULT_OPEN_TIMEOUT_MS = 30_000;

/**
 * Resolves when `conn` emits `"open"`, or rejects with the first `"error"` or
 * `"close"` that fires before `"open"`, or with a timeout error if none of
 * those occurs within `timeoutMs`. Returns immediately if `conn.open` is
 * already `true`. The three event listeners are torn down whichever branch
 * runs - including the timeout - so nothing outlives the handshake.
 *
 * The timeout bounds connection setup: WebRTC negotiation does not always
 * surface a stall as an `"error"` or `"close"`, so without it a peer stuck in
 * ICE negotiation would hang this promise (and the exchange) indefinitely.
 */
export function waitForConnectionOpen(
  conn: DataConnection,
  timeoutMs: number = DEFAULT_OPEN_TIMEOUT_MS,
): Promise<void> {
  if (conn.open) return Promise.resolve();
  let detach = () => {};
  const opened = new Promise<void>((resolve, reject) => {
    const onOpen = () => resolve();
    const onError = (err: Error) => reject(err);
    const onClose = () => reject(new Error("connection closed before open"));
    conn.once("open", onOpen);
    conn.once("error", onError);
    conn.once("close", onClose);
    detach = () => {
      conn.off("open", onOpen);
      conn.off("error", onError);
      conn.off("close", onClose);
    };
  });
  // withTimeout owns the deadline timer; detach() runs on every settle path
  // (open, pre-open error/close, or timeout) so no listener is left attached.
  return withTimeout(opened, timeoutMs, "connection open timed out").finally(
    detach,
  );
}
