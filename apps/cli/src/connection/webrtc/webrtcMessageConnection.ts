import {
  ConnectionError,
  QueuedMessageConnection,
  asConnectionError,
} from "@psilink/core";

import { BoundedInboundFrames } from "./inboundBounds";
import {
  PeerJsFrameEncoder,
  packCloseSentinel,
  toFrameBytes,
} from "./peerjsWire";
import { openWebRtcPeerSession } from "./weriftPeer";

import type { WebRtcPeerOptions, WebRtcPeerSession } from "./weriftPeer";
import type { MessageConnection } from "@psilink/core";
import type { RTCDataChannel } from "werift";

/**
 * The CLI's WebRTC transport as a {@link MessageConnection}: the binding that
 * lets the post-handshake exchange pipeline run over a werift data channel
 * without knowing it is one. The web app's `peerMessageConnection.ts` is the
 * same mapping over a PeerJS DataConnection, and the two agree on every
 * observable: a remote close half-closes (so a final frame already queued is
 * drained before the close is reported), an error fails, and a deliberate close
 * flushes.
 *
 * Two things this side has to do differently, because it drives the raw channel
 * rather than PeerJS:
 *
 * - Framing. Outbound values are BinaryPack-packed and chunked into the
 *   envelopes a browser peer reassembles; inbound datagrams go through the
 *   bounded reassembler (`inboundBounds.ts`) before anything is delivered.
 * - Draining. Both transports wait for the peer before a clean close resolves,
 *   on the strongest signal each stack exposes: PeerJS's flushing close is just
 *   the in-band sentinel, so the web waits for the PEER to close the channel on
 *   reading it -- which SCTP ordering necessarily places behind everything
 *   already handed to `send` -- and leaves the connection standing. A CLI
 *   process cannot leave it standing, so it sends the same sentinel and waits
 *   for the peer to ACKNOWLEDGE the bytes before tearing down.
 *
 *   That wait is critical, not hygiene, and what it waits ON is the whole
 *   point: tearing the connection down while data is outstanding loses it --
 *   measured at 4 MiB handed off and zero bytes received -- and the channel's
 *   own `bufferedAmount` is not the signal that says it is safe. It reaches
 *   zero while chunks are still unacknowledged, so a close gated on it lost
 *   roughly one frame in three over a loopback channel with no packet loss at
 *   all. The condition the drain actually waits on is the SCTP association's
 *   send and unacknowledged queues both being empty (see
 *   `weriftPeer.ts`), which is the peer having the bytes. This is the
 *   final-frame loss the delivery contract in docs/COMMUNICATION.md ("Message
 *   delivery and teardown") exists to prevent.
 */

/**
 * Parked-receive inactivity budget, matching the web WebRTC transport's.
 * Hour-scale because the timer arms only while a receive waits on an empty
 * queue, so it bounds the peer's per-step single-threaded PSI compute -- which
 * sends no keepalive while it runs -- and thus the workable dataset size.
 *
 * By design a transport-local constant rather than core's file-sync
 * `DEFAULT_PEER_TIMEOUT_MS`: the two govern unrelated transports and only
 * coincide in value, so tuning one must not silently move the other.
 */
export const DEFAULT_WEBRTC_INACTIVITY_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * Ceiling on the clean close's outbound drain. Sized from the two facts that
 * bound it: a frame may be as large as `MAX_WEBRTC_FRAME_BYTES` (256 MiB), and
 * werift's measured loopback send path runs at a few MiB/s, so a worst-case
 * final frame needs minutes. It is a ceiling, not a wait -- the drain returns
 * the moment the buffer empties, which for a lockstep protocol's final frame is
 * normally milliseconds -- and on expiry the connection tears down anyway
 * rather than hanging an unattended run forever.
 *
 * It is the safety check rather than the usual exit against a peer that has gone:
 * werift's own consent-freshness check leaves the `connected` state about
 * thirty seconds after a peer disappears (measured), and the drain watches that
 * (see {@link drainOutbound}). The ceiling covers the remaining case -- a peer
 * that answers ICE but stops acknowledging data.
 */
export const DEFAULT_CLOSE_FLUSH_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * How often the drain re-reads the acknowledgement condition. Polled because
 * werift raises no event for it: the channel's `bufferedAmountLow` event is
 * about a different (and, for delivery, useless) counter, and `bytesSent` /
 * `messagesSent` are counted at hand-off rather than as bytes leave, so they
 * reach their final value before the drain even starts.
 */
const CLOSE_FLUSH_POLL_INTERVAL_MS = 10;

/**
 * Ceiling on getting the close sentinel itself onto the wire, once every frame
 * before it has been acknowledged. Short because the sentinel is a single small
 * chunk and the only thing waited on is its transmission, not its
 * acknowledgement -- which never arrives, since a peer closes on reading it.
 */
const SENTINEL_HANDOFF_TIMEOUT_MS = 2_000;

export interface WebRtcMessageConnectionOptions {
  inactivityTimeoutMs?: number;
  closeFlushTimeoutMs?: number;
  /** Per-bound overrides for the inbound reassembler; tests only. */
  inboundBounds?: ConstructorParameters<typeof BoundedInboundFrames>[0];
}

/**
 * Resolve once `settled` holds -- or once there is no live peer left to drain
 * to, or the budget runs out.
 *
 * The liveness condition is not belt-and-braces. An acknowledgement never comes
 * from a peer that has gone, so a drain that watched only the clock would turn
 * a partner's crash into a wait as long as the ceiling. werift's
 * consent-freshness check leaves the `connected` state about thirty seconds
 * after the peer disappears -- slow, but two orders of magnitude below it.
 */
async function drainOutbound(
  channel: RTCDataChannel,
  session: Pick<WebRtcPeerSession, "isConnected">,
  settled: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (
    !settled() &&
    channel.readyState === "open" &&
    session.isConnected() &&
    Date.now() < deadline
  ) {
    // A ref'd timer: the drain IS the delivery guarantee, so it
    // must hold the event loop open rather than letting a process that has
    // finished its exchange exit with the last frame still in flight.
    await new Promise((resolve) =>
      setTimeout(resolve, CLOSE_FLUSH_POLL_INTERVAL_MS),
    );
  }
}

/**
 * Wrap an open data channel as a {@link MessageConnection}. The inbound handler
 * is attached synchronously here, before anything else can run, so a frame the
 * peer sends the instant the channel opens is queued rather than dropped.
 *
 * Takes ownership of `session`: closing the connection closes the channel, the
 * peer connection and the broker socket beneath it.
 */
export function webRtcMessageConnection(
  session: WebRtcPeerSession,
  options?: WebRtcMessageConnectionOptions,
): MessageConnection {
  const { channel } = session;
  const closeFlushTimeoutMs =
    options?.closeFlushTimeoutMs ?? DEFAULT_CLOSE_FLUSH_TIMEOUT_MS;

  return new QueuedMessageConnection(
    (controls) => {
      const encoder = new PeerJsFrameEncoder();
      const bounds = new BoundedInboundFrames(options?.inboundBounds);

      channel.onmessage = ({ data }) => {
        let outcome;
        try {
          outcome = bounds.accept(toFrameBytes(data));
        } catch (err) {
          controls.fail(asConnectionError(err, "protocol"));
          return;
        }
        if (outcome.kind === "pending") return;
        if (outcome.kind === "close") {
          // The peer's in-band clean close. `finish` rather than `fail`: the
          // sentinel travels the same ordered channel behind every frame the
          // peer already sent, so a final frame may still be queued here and
          // must be drained before the close is reported.
          controls.finish(
            new ConnectionError("peer connection closed", "transport"),
          );
          return;
        }
        controls.deliver(outcome.value);
      };
      channel.onclose = () =>
        controls.finish(
          new ConnectionError("peer connection closed", "transport"),
        );
      channel.onerror = ({ error }) =>
        controls.fail(asConnectionError(error, "transport"));
      // A partner that vanishes -- crashed, or cut off -- closes neither the
      // channel nor the exchange, so without this the connection would sit on
      // its hour-scale inactivity budget instead of failing. `fail`, not
      // `finish`: nothing about a dropped peer is a clean close. Idempotent
      // against this side's own teardown, which reaches a terminal state before
      // it closes the peer connection.
      session.onDisconnected(() =>
        controls.fail(
          new ConnectionError(
            "the connection to the exchange partner was lost",
            "transport",
          ),
        ),
      );

      return {
        send: (data) => {
          for (const datagram of encoder.encode(data)) {
            channel.send(Buffer.from(datagram));
          }
        },
        close: async (closeOptions) => {
          channel.onmessage = undefined;
          channel.onclose = undefined;
          channel.onerror = undefined;
          // Flush only an open channel: on a closed one the sentinel cannot be
          // written and there is nothing left to drain, so the wait would be
          // pure delay on a path that is already failing.
          if (closeOptions?.flush && channel.readyState === "open") {
            // Phase one: every frame already handed over reaches the peer. This
            // is the delivery guarantee, so it waits for acknowledgement and
            // gets the whole budget.
            await drainOutbound(
              channel,
              session,
              session.outboundAcknowledged,
              closeFlushTimeoutMs,
            );
            try {
              channel.send(Buffer.from(packCloseSentinel()));
            } catch {
              // The channel went while the sentinel was being written; the peer
              // will see the drop instead of the clean close, and every frame
              // before it has already been acknowledged.
            }
            // Phase two: the sentinel goes on the wire. It is NOT waited on
            // for acknowledgement -- a peer closes the moment it reads the
            // sentinel, so it stops acknowledging at exactly that point and
            // this wait would always spend the whole budget. Losing the
            // sentinel costs the peer its clean-close signal (it falls back
            // to observing the connection drop), never a frame.
            await drainOutbound(
              channel,
              session,
              session.outboundTransmitted,
              SENTINEL_HANDOFF_TIMEOUT_MS,
            );
          }
          await session.close();
        },
        // No `setInboundFrameCap`: this transport bounds its inbound path with
        // its own fixed reassembly envelope rather than a per-exchange cap, so
        // the connection's setInboundFrameCap is a no-op here by construction
        // (see MessageConnection.setInboundFrameCap).
      };
    },
    {
      inactivityTimeoutMs:
        options?.inactivityTimeoutMs ?? DEFAULT_WEBRTC_INACTIVITY_TIMEOUT_MS,
      // No `inactivityHint`: the file-sync CLI can name likely receiver-side
      // causes for a silent peer, but on a live data channel silence means the
      // peer is computing or gone, and neither is guidance worth a sentence.
    },
  );
}

/**
 * Rendezvous with the exchange partner and return the resulting
 * {@link MessageConnection}. The single entry point a caller needs: it registers
 * with the broker, negotiates the peer connection, waits for the data channel,
 * and wraps it.
 */
export async function openWebRtcMessageConnection(
  options: WebRtcPeerOptions & WebRtcMessageConnectionOptions,
): Promise<MessageConnection> {
  const session = await openWebRtcPeerSession(options);
  return webRtcMessageConnection(session, options);
}
