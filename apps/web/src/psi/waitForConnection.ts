import type { DataConnection } from "peerjs";
import type Peer from "peerjs";

/**
 * Provisional ceiling for the invited party to dial in. The proper value (and
 * the surrounding UX) belongs to the web connection-lifecycle consolidation;
 * this exists so a peer that never connects surfaces an error rather than
 * hanging the page indefinitely.
 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Resolves with the first incoming {@link DataConnection} on `peer`, or rejects
 * if none arrives within `timeoutMs`. The `connection` listener and the timer
 * are torn down on whichever branch runs, so nothing outlives the wait.
 */
export function waitForIncomingConnection(
  peer: Peer,
  timeoutMs: number = DEFAULT_CONNECT_TIMEOUT_MS,
): Promise<DataConnection> {
  return new Promise<DataConnection>((resolve, reject) => {
    const onConnection = (conn: DataConnection) => {
      clearTimeout(timer);
      resolve(conn);
    };
    const timer = setTimeout(() => {
      peer.off("connection", onConnection);
      reject(new Error("timed out waiting for the other party to connect"));
    }, timeoutMs);
    peer.once("connection", onConnection);
  });
}
