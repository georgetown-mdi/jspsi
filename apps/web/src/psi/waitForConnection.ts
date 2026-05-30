import type { DataConnection } from "peerjs";
import type Peer from "peerjs";

/**
 * Human-timescale ceiling for one operator to wait for the other party to show
 * up. Shared by both roles' browsers: the client role's
 * {@link waitForIncomingConnection} and the server role's browser-side bound on
 * its SSE wait (`waitForPeerId`). It exists so an abandoned wait surfaces an
 * error instead of hanging the page.
 *
 * It sits *under* the rendezvous session TTL (15 min by default), which is the
 * true outer bound on a wait, so this is a secondary cap. It is distinct from
 * the 30s channel-open bound in `waitForOpen.ts`, which times the WebRTC
 * handshake once both peers are already dialing.
 */
export const DEFAULT_PEER_WAIT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Resolves with the first incoming {@link DataConnection} on `peer`, or rejects
 * if none arrives within `timeoutMs`, or if `signal` aborts first.
 *
 * A settle-once guard makes the first of {connection, timeout, abort} win: it
 * runs the helper-local cleanup (drop the `connection` listener, clear the
 * timer, detach the abort listener) exactly once and settles the promise; the
 * rest are no-ops. The guard is the helper's own, independent of any caller's
 * teardown latch, so cleanup still runs exactly once even when the timer and an
 * abort fire in the same tick.
 *
 * @param peer     The local PeerJS peer awaiting an inbound connection.
 * @param options  `timeoutMs` overrides the {@link DEFAULT_PEER_WAIT_TIMEOUT_MS}
 *                 bound; `signal` lets the owner cancel the wait (on unmount or
 *                 a sibling teardown) and settle it promptly rather than leaving
 *                 the promise pending until the timer fires.
 */
export function waitForIncomingConnection(
  peer: Peer,
  options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<DataConnection> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_PEER_WAIT_TIMEOUT_MS;
  const signal = options?.signal;
  return new Promise<DataConnection>((resolve, reject) => {
    let settled = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      peer.off("connection", onConnection);
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      action();
    };
    const onConnection = (conn: DataConnection) => settle(() => resolve(conn));
    const onAbort = () =>
      settle(() =>
        reject(new Error("waiting for the other party to connect was aborted")),
      );
    const timer = setTimeout(
      () =>
        settle(() =>
          reject(new Error("timed out waiting for the other party to connect")),
        ),
      timeoutMs,
    );
    if (signal?.aborted) {
      onAbort();
      return;
    }
    peer.once("connection", onConnection);
    signal?.addEventListener("abort", onAbort);
  });
}
