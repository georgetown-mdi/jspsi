import type { DataConnection } from "peerjs";

/**
 * Resolves when `conn` emits `"open"`, or rejects with the first `"error"`
 * that fires before `"open"`. Returns immediately if `conn.open` is already
 * `true`. Both event listeners are removed whichever branch runs so neither
 * outlives the handshake.
 */
export function waitForConnectionOpen(conn: DataConnection): Promise<void> {
  if (conn.open) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onOpen = () => {
      conn.off("error", onError);
      resolve();
    };
    const onError = (err: Error) => {
      conn.off("open", onOpen);
      reject(err);
    };
    conn.once("open", onOpen);
    conn.once("error", onError);
  });
}
