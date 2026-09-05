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
import type { PeerCloseOutcome } from "./waitForPeerClose";

/**
 * Parked-receive inactivity budget for the WebRTC transport. Hour-scale: the
 * timer arms only while a receive waits on an empty queue, so it bounds the
 * peer's per-step single-threaded WASM compute time (no keepalive while
 * running), and thus the workable dataset size. A transport-local constant by
 * design, not core's file-sync `DEFAULT_PEER_TIMEOUT_MS`: the two govern
 * unrelated transports and only coincide in value today.
 */
const DEFAULT_WEBRTC_INACTIVITY_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * Returns a {@link MessageConnection} backed by the PeerJS data channel `conn`.
 * The `data` listener attaches before the open handshake is awaited, since
 * PeerJS does not replay events to a listener attached later and the
 * initiator can send its first frame unprompted. A remote `error` or `close`
 * both expose a `transport` {@link ConnectionError}, draining any
 * already-buffered frame via `receive` first. `close` waits on
 * {@link waitForPeerClose} for the peer to take the final frame before
 * resolving, except on that wait's ceiling, dead-peer, already-not-open, and
 * cancelled paths, where the frame can still be in flight; how the wait ended
 * is reported unjudged through `onCloseOutcome`.
 *
 * The inbound path is byte-bounded against a hostile or buggy peer
 * ({@link boundChunkReassembly}, re-checked at delivery by
 * {@link checkDeliveredFrameBound}) -- the WebRTC transport's own bound, since
 * core's AEAD frame-size envelope does not apply on the DTLS-wrapped web path.
 *
 * If the channel never opens, the returned promise rejects and the half-open
 * channel is torn down first, since `peer.disconnect()` alone would not
 * close it.
 *
 * @param conn     A PeerJS data connection, open or not yet open.
 * @param options  `openTimeoutMs`, `inactivityTimeoutMs`, `maxFrameBytes`,
 *                 `maxConcurrentReassemblies`, and `closeDrainTimeoutMs`
 *                 override the fixed defaults; test-only, none is an
 *                 operator-facing setting. `onCloseOutcome` reports
 *                 {@link PeerCloseOutcome} once per connection, left unwritten
 *                 to the operator here; a non-flushing close reports nothing.
 *                 `signal` cuts the close-drain wait short, since core's
 *                 `MessageConnection.close()` takes no arguments of its own.
 */
export async function openPeerMessageConnection(
  conn: DataConnection,
  options?: {
    openTimeoutMs?: number;
    inactivityTimeoutMs?: number;
    maxFrameBytes?: number;
    maxConcurrentReassemblies?: number;
    closeDrainTimeoutMs?: number;
    onCloseOutcome?: (outcome: PeerCloseOutcome) => void;
    signal?: AbortSignal;
  },
): Promise<MessageConnection> {
  const maxFrameBytes = options?.maxFrameBytes ?? MAX_WEBRTC_FRAME_BYTES;
  // Validate the PeerJS chunk-reassembly assumption before attaching any
  // listener or constructing the connection: throwing here leaves nothing to
  // tear down, whereas throwing from the constructor callback below would
  // strand the half-wired channel (the QueuedMessageConnection is never
  // returned, so its catch-driven close cannot run).
  assertChunkReassemblySupported(conn);
  const opened = waitForConnectionOpen(conn, options?.openTimeoutMs);
  const mc = new QueuedMessageConnection(
    (controls) => {
      // Bound PeerJS chunk reassembly before any chunk arrives, so an oversized
      // frame or a partial-reassembly flood fails closed (via controls.fail)
      // rather than allocating proportional to the peer-chosen size. The over-cap
      // error holds no peer id, so it needs no redaction.
      boundChunkReassembly(conn, controls.fail, {
        maxFrameBytes,
        maxConcurrentReassemblies: options?.maxConcurrentReassemblies,
      });
      // Re-check a fully delivered frame at this stable layer: a safety check
      // for the chunk-layer bound above (which reaches into PeerJS internals)
      // that refuses an over-cap binary frame as delivered, however assembled.
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
      // attached `.cause` passes the id to the lifecycle's console/alert sinks.
      const onError = (err: unknown) =>
        controls.fail(
          asConnectionError(redactErrorIds(err, [conn.peer]), "transport"),
        );
      // A clean remote close can hold the peer's final frame still queued, so
      // it uses finish(): receive() drains that frame before the close error
      // shows. A genuine error (onError) uses fail(), the abnormal
      // counterpart; receive() still drains an already-queued frame ahead of
      // the error, but fail() holds no clean-close semantics. The kind stays
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
          // A flushing close is the delivery guarantee, not hygiene: PeerJS's
          // flush queues the in-band close sentinel and returns while the
          // final frame is still in the browser's outbound buffer, so this
          // waits for the peer to close the channel instead (it does that on
          // reading the sentinel, ordered behind every frame already sent;
          // the listener attaches before the sentinel is queued). PeerJS's
          // flush is a no-op on a channel that never opened, so an unopened
          // channel needs the hard close below or it leaks.
          if (closeOptions?.flush && conn.open) {
            const peerClosed = waitForPeerClose(
              conn,
              options?.closeDrainTimeoutMs,
              options?.signal,
            );
            conn.close({ flush: true });
            // Awaited on its own line, never inside the optional call below: an
            // optional call whose callee is absent skips its arguments too, so
            // folding the await in would drop the wait -- the delivery guarantee
            // itself -- for every caller that passes no callback.
            const outcome = await peerClosed;
            options?.onCloseOutcome?.(outcome);
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
    // can hold the remote derived id (`conn.peer`).
    throw asConnectionError(redactErrorIds(err, [conn.peer]), "transport");
  }
  return mc;
}
