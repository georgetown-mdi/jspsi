import type { DataConnection } from "peerjs";

/**
 * Default ceiling for a data channel to finish opening. Matches the order of
 * magnitude of the PAKE handshake timeout: a channel that has not opened within
 * this window is almost certainly never going to.
 */
const DEFAULT_OPEN_TIMEOUT_MS = 30_000;

/**
 * Resolves when `conn` emits `"open"`, or rejects with the first `"error"` or
 * `"close"` that fires before `"open"`, or with a timeout error if none of
 * those occurs within `timeoutMs`. Returns immediately if `conn.open` is
 * already `true`. The timer and all three event listeners are torn down
 * whichever branch runs so nothing outlives the handshake.
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
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      conn.off("open", onOpen);
      conn.off("error", onError);
      conn.off("close", onClose);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("connection closed before open"));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("connection open timed out"));
    }, timeoutMs);
    conn.once("open", onOpen);
    conn.once("error", onError);
    conn.once("close", onClose);
  });
}
