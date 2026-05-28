import type { DataConnection } from "peerjs";

/**
 * Resolves when `conn` emits `"open"`, or rejects with the first `"error"`
 * that fires before `"open"`. Both event listeners are removed whichever
 * branch runs so neither outlives the handshake.
 */
export function waitForConnectionOpen(conn: DataConnection): Promise<void> {
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
