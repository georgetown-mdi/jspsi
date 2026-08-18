import {
  ConnectionError,
  MAX_WEBRTC_FRAME_BYTES,
  QueuedMessageConnection,
  asConnectionError,
} from "@psilink/core";

import {
  assertChunkReassemblySupported,
  boundChunkReassembly,
  checkDeliveredFrameBound,
} from "./boundedReassembly";
import { redactErrorIds } from "./peerLogging";
import { waitForConnectionOpen } from "./waitForOpen";
import { waitForPeerClose } from "./waitForPeerClose";

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
 * waiting on a clean close for the peer to take the final frame (see
 * {@link waitForPeerClose}), so a resolved close means delivered rather than
 * buffered -- except on the wait's ceiling, dead-peer, and already-not-open
 * paths, where the frame can still be in flight (see {@link waitForPeerClose}).
 * The ceiling reports itself through `onFinalFrameUnconfirmed`, so a caller can
 * tell its operator rather than let a run report success with the partner's
 * copy in doubt: it is the exit a finished exchange reaches with the peer still
 * live and the channel still open, so nothing else would tell them anything.
 * The dead-peer and already-not-open exits stay silent, so a partner whose stack
 * dies during the drain of a run that already reported success is never
 * reported to anyone; docs/spec/WEBRTC_TRANSPORT.md records that limit.
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
 *                 reassembly cap) and `closeDrainTimeoutMs` the ceiling on the
 *                 clean close's wait for the peer (see {@link waitForPeerClose}),
 *                 for tests only -- none of them is an operator-facing knob.
 *                 `onFinalFrameUnconfirmed` fires when a clean close's wait ends
 *                 on that ceiling, once per connection at most, leaving the
 *                 operator-facing wording to the caller that owns a warning
 *                 surface; omitting it makes the exit silent.
 */
export async function openPeerMessageConnection(
  conn: DataConnection,
  options?: {
    openTimeoutMs?: number;
    inactivityTimeoutMs?: number;
    maxFrameBytes?: number;
    maxConcurrentReassemblies?: number;
    closeDrainTimeoutMs?: number;
    onFinalFrameUnconfirmed?: () => void;
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
        close: async (closeOptions) => {
          conn.off("data", onData);
          conn.off("error", onError);
          conn.off("close", onClose);
          // A flushing close is the delivery guarantee, not hygiene. PeerJS's
          // flush is only the in-band close sentinel: it queues the sentinel
          // and returns with the final frame still in the browser's outbound
          // buffer, so returning here would report delivery for a frame that
          // has not left. Wait for the peer to close the channel instead --
          // it does that on reading the sentinel, which the ordered channel
          // places behind every frame already sent. The listener goes on
          // before the sentinel does, so an instant peer cannot outrun it.
          //
          // Only an open channel: PeerJS's flush path is a no-op on a channel
          // that never opened (it queues the sentinel and returns without
          // tearing down the RTCPeerConnection), so an unopened channel needs
          // the hard close or it leaks.
          if (closeOptions?.flush && conn.open) {
            const peerClosed = waitForPeerClose(
              conn,
              options?.closeDrainTimeoutMs,
            );
            conn.close({ flush: true });
            // Only the ceiling reports: the peer-gone and channel-not-open
            // exits stay silent even where the run itself succeeded, so a
            // partner whose stack dies during this drain reaches no one. The
            // limit is recorded in docs/spec/WEBRTC_TRANSPORT.md.
            if ((await peerClosed) === "ceiling")
              options?.onFinalFrameUnconfirmed?.();
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
