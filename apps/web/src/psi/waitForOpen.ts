import type { DataConnection } from "peerjs";

/**
 * Resolves when `conn` emits `"open"`, or rejects with the first `"error"` or
 * `"close"` that fires before `"open"`. Returns immediately if `conn.open` is
 * already `true`. All three event listeners are removed whichever branch runs
 * so none outlive the handshake.
 */
export function waitForConnectionOpen(conn: DataConnection): Promise<void> {
  if (conn.open) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onOpen = () => {
      conn.off("error", onError);
      conn.off("close", onClose);
      resolve();
    };
    const onError = (err: Error) => {
      conn.off("open", onOpen);
      conn.off("close", onClose);
      reject(err);
    };
    const onClose = () => {
      conn.off("open", onOpen);
      conn.off("error", onError);
      reject(new Error("connection closed before open"));
    };
    conn.once("open", onOpen);
    conn.once("error", onError);
    conn.once("close", onClose);
  });
}
