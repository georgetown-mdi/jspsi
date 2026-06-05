import {
  ConnectionError,
  QueuedMessageConnection,
  asConnectionError,
} from "@psilink/core";

import { waitForConnectionOpen } from "./waitForOpen";

import type { DataConnection } from "peerjs";
import type { MessageConnection } from "@psilink/core";

/**
 * Parked-receive inactivity budget for the WebRTC transport. Hour-scale: the
 * timer arms only while a receive waits on an empty queue, so it bounds the
 * peer's per-step single-threaded WASM compute time (which sends no keepalive
 * while running), and thus the workable dataset size.
 *
 * Deliberately a transport-local constant rather than core's file-sync
 * `DEFAULT_PEER_TIMEOUT_MS`: the two govern unrelated transports (a file
 * rendezvous TTL vs. a data-channel inactivity deadline) and only coincide in
 * value today, so tuning one must not silently move the other.
 */
const DEFAULT_WEBRTC_INACTIVITY_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * Returns a {@link MessageConnection} backed by the PeerJS data channel `conn`.
 * The inbound `data` listener is attached synchronously, before the open
 * handshake is awaited, so a frame the peer sends the instant the channel opens
 * is queued rather than dropped: PeerJS does not replay events to a listener
 * attached later, and the initiator sends its first frame unprompted - possibly
 * before this side has finished loading its PSI WASM. A remote `error` or
 * `close` both surface a `transport` {@link ConnectionError}; either way an
 * already-buffered frame is drained by `receive` before the error surfaces
 * (`close` is a clean half-close, `error` an abnormal drop). `send` writes to
 * the channel; and `close` detaches the listeners and closes the channel,
 * flushing buffered writes first on a clean close.
 *
 * If the channel never opens (timeout, or a pre-open `error`/`close`), the
 * returned promise rejects and the half-open channel is torn down before the
 * rejection propagates, since `peer.disconnect()` alone would not close it.
 *
 * @param conn     A PeerJS data connection, open or not yet open.
 * @param options  `openTimeoutMs` bounds how long to wait for the channel to
 *                 open (see {@link waitForConnectionOpen}); `inactivityTimeoutMs`
 *                 overrides the {@link DEFAULT_WEBRTC_INACTIVITY_TIMEOUT_MS}
 *                 parked-receive budget.
 */
export async function openPeerMessageConnection(
  conn: DataConnection,
  options?: { openTimeoutMs?: number; inactivityTimeoutMs?: number },
): Promise<MessageConnection> {
  const opened = waitForConnectionOpen(conn, options?.openTimeoutMs);
  const mc = new QueuedMessageConnection(
    (controls) => {
      const onData = (data: unknown) => controls.deliver(data);
      const onError = (err: unknown) =>
        controls.fail(asConnectionError(err, "transport"));
      // A clean remote close can carry the peer's final frame still queued, so
      // it uses finish(): receive() drains that frame before the close error
      // surfaces. A genuine error (onError) uses fail(), the abnormal
      // counterpart; receive() still drains an already-queued frame ahead of
      // the error, but fail() carries no clean-close semantics.
      const onClose = () =>
        controls.finish(
          new ConnectionError("peer connection closed", "transport"),
        );
      conn.on("data", onData);
      conn.on("error", onError);
      conn.on("close", onClose);
      return {
        send: (data) => conn.send(data),
        close: (closeOptions) => {
          conn.off("data", onData);
          conn.off("error", onError);
          conn.off("close", onClose);
          // flush drains buffered outbound writes before closing, but PeerJS's
          // flush path is a no-op on a channel that never opened: it queues a
          // close sentinel and returns before tearing down the
          // RTCPeerConnection. So only flush an open channel; otherwise
          // hard-close, or an unopened channel leaks.
          if (closeOptions?.flush && conn.open) {
            conn.close({ flush: true });
          } else {
            conn.close();
          }
        },
      };
    },
    {
      inactivityTimeoutMs:
        options?.inactivityTimeoutMs ?? DEFAULT_WEBRTC_INACTIVITY_TIMEOUT_MS,
    },
  );
  try {
    await opened;
  } catch (err) {
    // The open handshake failed; tear down the half-open channel and its
    // listeners so it does not linger before re-throwing the open error.
    await mc.close();
    // waitForConnectionOpen rejects with a bare Error (timeout, pre-open
    // error/close), so tag it as a `transport` ConnectionError at the boundary;
    // otherwise a consumer that branches on ConnectionError.kind cannot classify
    // an open-time failure (F5). asConnectionError passes an existing
    // ConnectionError through unchanged.
    throw asConnectionError(err, "transport");
  }
  return mc;
}
