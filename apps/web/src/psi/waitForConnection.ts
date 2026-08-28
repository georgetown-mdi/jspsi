import type { DataConnection } from "peerjs";
import type Peer from "peerjs";

/**
 * Human-timescale ceiling for one operator to wait for the other party to show
 * up. Shared by both roles' browsers: the inviter's inbound wait
 * ({@link waitForIncomingConnection}) and the acceptor's dial-retry budget (the
 * `dialAsAcceptor` rendezvous), so neither side hangs the page waiting on the
 * other. It exists so an abandoned wait surfaces an error instead of hanging.
 *
 * It is distinct from the 30s channel-open bound in `waitForOpen.ts`, which times
 * the WebRTC handshake once both peers are already dialing.
 */
export const DEFAULT_PEER_WAIT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Raised when the wait for the other party spent its whole budget without them
 * arriving -- the no-show condition. Both roles raise it from their half of the
 * shared {@link DEFAULT_PEER_WAIT_TIMEOUT_MS} budget: the inviter's inbound wait
 * ({@link waitForIncomingConnection}) expiring with no connection, and the
 * acceptor's dial-retry budget (`dialAsAcceptor`) expiring while the broker still
 * reported the inviter's derived id unregistered.
 *
 * It is deliberately NOT raised for a partner who was reached: an inviter whose id
 * IS registered but whose channel will not open, a fatal broker error, and an
 * operator abort each reject with a plain error, because each is a transport fault
 * or a cancellation rather than an absent partner. That separation is what lets a
 * managed re-run record the benign `"missed"` outcome for this condition alone (see
 * {@link ./managedRun.ts}, `rerunFailureLastRun`), instead of filing every unmet
 * rendezvous as a transport fault.
 */
export class PartnerNoShowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PartnerNoShowError";
  }
}

/**
 * Resolves with the first incoming {@link DataConnection} on `peer`, or rejects
 * with a {@link PartnerNoShowError} if none arrives within `timeoutMs`, or with a
 * plain abort error if `signal` aborts first.
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
          reject(
            new PartnerNoShowError(
              "timed out waiting for the other party to connect",
            ),
          ),
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
