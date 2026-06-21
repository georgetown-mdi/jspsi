import {
  ConnectionError,
  QueuedMessageConnection,
  asConnectionError,
} from "@psilink/core";

import {
  MAX_WEBRTC_FRAME_BYTES,
  assertChunkReassemblySupported,
  boundChunkReassembly,
  checkDeliveredFrameBound,
} from "./boundedReassembly";
import { redactErrorIds } from "./peerLogging";
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
 * The inbound path is byte-bounded against a hostile or buggy peer: PeerJS chunk
 * reassembly is capped so an oversized PSI set frame or a flood of
 * never-completed partial reassemblies fails closed rather than allocating
 * proportional to what the peer sends (see {@link boundChunkReassembly}), and a
 * delivered frame is re-checked at this stable layer (see
 * {@link checkDeliveredFrameBound}). This is the WebRTC transport's own bound:
 * core's AEAD frame-size envelope is out of scope on the web path, which runs
 * the data channel under DTLS and declines the AEAD wrap.
 *
 * If the channel never opens (timeout, or a pre-open `error`/`close`), the
 * returned promise rejects and the half-open channel is torn down before the
 * rejection propagates, since `peer.disconnect()` alone would not close it.
 *
 * @param conn     A PeerJS data connection, open or not yet open.
 * @param options  `openTimeoutMs` bounds how long to wait for the channel to
 *                 open (see {@link waitForConnectionOpen}); `inactivityTimeoutMs`
 *                 overrides the {@link DEFAULT_WEBRTC_INACTIVITY_TIMEOUT_MS}
 *                 parked-receive budget. `maxFrameBytes` /
 *                 `maxConcurrentReassemblies` override the fixed inbound bounds
 *                 (default {@link MAX_WEBRTC_FRAME_BYTES} and the concurrent
 *                 reassembly cap) for tests only -- they are not an
 *                 operator-facing knob.
 */
export async function openPeerMessageConnection(
  conn: DataConnection,
  options?: {
    openTimeoutMs?: number;
    inactivityTimeoutMs?: number;
    maxFrameBytes?: number;
    maxConcurrentReassemblies?: number;
  },
): Promise<MessageConnection> {
  const maxFrameBytes = options?.maxFrameBytes ?? MAX_WEBRTC_FRAME_BYTES;
  // Validate the PeerJS chunk-reassembly premise before attaching any listener or
  // constructing the connection: if it is broken, throwing here leaves nothing to
  // tear down, whereas throwing from the constructor callback below would strand
  // the half-wired channel (the QueuedMessageConnection is never returned, so its
  // catch-driven close cannot run).
  assertChunkReassemblySupported(conn);
  const opened = waitForConnectionOpen(conn, options?.openTimeoutMs);
  const mc = new QueuedMessageConnection(
    (controls) => {
      // Bound PeerJS chunk reassembly before any chunk arrives, so an oversized
      // frame or a partial-reassembly flood fails closed (via controls.fail)
      // rather than allocating proportional to the peer-chosen size. The over-cap
      // error carries no peer id, so it needs no redaction.
      boundChunkReassembly(conn, controls.fail, {
        maxFrameBytes,
        maxConcurrentReassemblies: options?.maxConcurrentReassemblies,
      });
      // Re-check a fully delivered frame at this stable layer: a backstop for the
      // chunk-layer bound above (which reaches into PeerJS internals) that refuses
      // an over-cap binary frame as delivered, however it was assembled.
      const onData = (data: unknown) => {
        const overCap = checkDeliveredFrameBound(data, maxFrameBytes);
        if (overCap) {
          controls.fail(overCap);
          return;
        }
        controls.deliver(data);
      };
      // PeerJS interpolates the remote id (`conn.peer`, a derived rendezvous id)
      // into the errors it emits on a mid-exchange failure; redact it before
      // `asConnectionError` wraps, so neither the wrapped message nor the
      // attached `.cause` carries the id to the lifecycle's console/alert sinks.
      const onError = (err: unknown) =>
        controls.fail(
          asConnectionError(redactErrorIds(err, [conn.peer]), "transport"),
        );
      // A clean remote close can carry the peer's final frame still queued, so
      // it uses finish(): receive() drains that frame before the close error
      // surfaces. A genuine error (onError) uses fail(), the abnormal
      // counterpart; receive() still drains an already-queued frame ahead of
      // the error, but fail() carries no clean-close semantics. The kind stays
      // `transport` (not a dedicated peer-closed kind) by decision; see
      // docs/COMMUNICATION.md ("Error handling").
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
    // ConnectionError through unchanged. Redact first: a pre-open PeerJS error
    // can carry the remote derived id (`conn.peer`).
    throw asConnectionError(redactErrorIds(err, [conn.peer]), "transport");
  }
  return mc;
}
