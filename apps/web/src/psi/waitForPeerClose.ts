import type { DataConnection } from "peerjs";

/**
 * Default ceiling on the clean close's wait for the peer to take the final
 * frame. Sized like the CLI transport's drain ceiling
 * (`DEFAULT_CLOSE_FLUSH_TIMEOUT_MS`): a frame may be as large as
 * `MAX_WEBRTC_FRAME_BYTES` (256 MiB), so a worst-case final frame needs minutes
 * on a slow link. It is a ceiling, not a wait -- the wait ends the moment the
 * peer closes, which for a lockstep protocol's final frame is normally
 * milliseconds -- and on expiry the close returns anyway rather than hanging a
 * finished exchange forever.
 */
export const DEFAULT_PEER_CLOSE_TIMEOUT_MS = 5 * 60 * 1000;

/** Peer-connection states with no live peer left to deliver to. `disconnected`
 * is deliberately absent: it is a transient loss of ICE connectivity that
 * recovers, and treating it as terminal would report delivery for a frame still
 * in flight. A peer that never comes back reaches `failed` when ICE gives up on
 * it, and the ceiling covers a peer that answers ICE but stops reading. */
const DEAD_PEER_STATES: ReadonlySet<RTCPeerConnectionState> = new Set([
  "failed",
  "closed",
]);

/** The WebRTC objects under a PeerJS connection. Read through one accessor
 * because PeerJS types both as always present while a connection that never
 * negotiated has neither: the wait then has nothing to watch, which is the same
 * answer as a channel that is no longer open. */
function transportOf(conn: DataConnection): {
  channel: RTCDataChannel | undefined;
  peerConnection: RTCPeerConnection | undefined;
} {
  return { channel: conn.dataChannel, peerConnection: conn.peerConnection };
}

/**
 * Resolves once the peer has closed the data channel underneath `conn` - the
 * one delivery signal a browser peer gets - or once there is no live peer left
 * to deliver to, or once `timeoutMs` runs out. Never rejects: the caller is
 * already tearing down.
 *
 * This is what makes a clean close mean delivery. PeerJS's flushing close only
 * queues its in-band close sentinel and returns, so the close resolves with the
 * final frame still sitting in the browser's outbound buffer (measured: 8.4 MB
 * of a 16 MiB frame still buffered, and the peer reading it 1.3 s later). The
 * peer closes the channel when it reads that sentinel, which the ordered,
 * reliable channel necessarily places behind every frame already handed to
 * `send`; that close travels back as this channel's own `close` event. Waiting
 * for it is therefore the browser's form of the acknowledged drain the CLI
 * transport performs against the SCTP queues -- and it is stronger than
 * `bufferedAmount` reaching zero, which is not delivery on this transport (see
 * docs/spec/WEBRTC_TRANSPORT.md).
 *
 * The event is the peer's, not this side's: PeerJS leaves the local channel
 * open on a flushing close, so nothing here closes it (measured: the channel
 * stayed `open` for the whole observation window against a peer patched not to
 * close, while `bufferedAmount` had reached zero early in it).
 *
 * Call this BEFORE asking PeerJS to close, so a peer that closes the instant it
 * reads the sentinel cannot beat the listener into place.
 *
 * @param conn       The connection about to be closed; its channel and peer
 *                   connection are read now, before PeerJS can tear either off.
 * @param timeoutMs  Ceiling on the wait
 *                   (default {@link DEFAULT_PEER_CLOSE_TIMEOUT_MS}).
 */
export function waitForPeerClose(
  conn: DataConnection,
  timeoutMs: number = DEFAULT_PEER_CLOSE_TIMEOUT_MS,
): Promise<void> {
  const { channel, peerConnection } = transportOf(conn);
  // Nothing to wait for: a channel that is not open can carry neither the
  // sentinel nor the frames behind it, so the wait would be pure delay on a
  // path that has already lost whatever was buffered.
  if (channel === undefined || channel.readyState !== "open")
    return Promise.resolve();
  return new Promise<void>((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      channel.removeEventListener("close", settle);
      channel.removeEventListener("closing", settle);
      peerConnection?.removeEventListener(
        "connectionstatechange",
        onPeerConnectionState,
      );
      resolve();
    };
    const onPeerConnectionState = () => {
      if (
        peerConnection !== undefined &&
        DEAD_PEER_STATES.has(peerConnection.connectionState)
      )
        settle();
    };
    const timer = setTimeout(settle, timeoutMs);
    channel.addEventListener("close", settle);
    channel.addEventListener("closing", settle);
    peerConnection?.addEventListener(
      "connectionstatechange",
      onPeerConnectionState,
    );
    // The peer may already have gone while this side was still sending.
    onPeerConnectionState();
  });
}
