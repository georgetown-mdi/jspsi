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

/** Peer-connection states with nothing live left to deliver over: ICE gave up
 * (`failed`), or this side tore the connection down (`closed`). `disconnected`
 * is deliberately absent: it is a transient loss of ICE connectivity that
 * recovers, and treating it as terminal would report delivery for a frame still
 * in flight. A peer that never comes back reaches `failed` when ICE gives up on
 * it, and the ceiling covers a peer that answers ICE but stops reading. */
const DEAD_PEER_STATES: ReadonlySet<RTCPeerConnectionState> = new Set([
  "failed",
  "closed",
]);

/**
 * How the clean close's wait for the peer ended. Exactly one of these carries a
 * delivery signal, so a caller that must tell "the peer took the final frame"
 * from "the wait gave up" branches on this rather than on the wait returning.
 */
export type PeerCloseOutcome =
  /** The channel closed while this side's link was still live (its
   * `close`/`closing` event): the ordered channel places the close sentinel
   * behind every frame already handed to `send`, so a peer that reads in order
   * took the final frame before closing. The only exit that can mean delivered
   * -- for a conforming peer; one that closes without draining its inbound queue
   * is indistinguishable from one that read everything -- and a channel that
   * starts closing on a link this side has already torn down is not it (see the
   * listener note below). */
  | "peer-closed"
  /** The ceiling ran out with the channel still open and the peer still live:
   * the peer answered ICE but never took the sentinel, so the final frame may
   * still be sitting in this side's outbound buffer. */
  | "ceiling"
  /** Nothing live is left to deliver over: the peer connection reached `failed`
   * because ICE gave up on the peer, or `closed` because this side tore it
   * down. Whatever was buffered went with it either way, which is why the two
   * share an exit -- neither leaves a partner who can still confirm. Reported
   * however the wait learns of it: the state change, or a channel close
   * arriving on an already-dead connection. */
  | "peer-gone"
  /** The channel was not open when the wait began, so it could carry neither
   * the sentinel nor the frames behind it. */
  | "channel-not-open"
  /** The caller's signal aborted, so the wait was cut short rather than left
   * standing to the ceiling: the peer chooses that duration, and a cancelling
   * operator must not have to spend it. The sentinel may never have been read,
   * so this carries no delivery signal -- and it is its own exit rather than
   * one of the link's, so that a wait the operator cut is reported as that
   * rather than as whatever the teardown behind it does to the channel. */
  | "run-aborted";

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
 * to deliver to, or once `signal` aborts, or once `timeoutMs` runs out,
 * reporting which of those ended the wait ({@link PeerCloseOutcome}). Never
 * rejects: the caller is already tearing down.
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
 * The flushing close itself does not close the local channel: it leaves it
 * `open` and touches neither `close` nor `closing` (measured: the channel
 * stayed `open` for the whole observation window against a peer patched not to
 * close, while `bufferedAmount` had reached zero early in it -- see
 * apps/web/test/browser/webrtcCloseDelivery.test.ts). A close on that channel
 * is still not the peer's by construction, though: tearing THIS side's peer
 * connection down closes the channel too, and discards everything the drain was
 * waiting on. The wait tells the two apart by the link rather than by assuming
 * which local paths can reach it -- the peer connection is dead only where this
 * side is the one that ended it -- and reports the peer's close only for a
 * channel that closed while the link was still live.
 *
 * Call this BEFORE asking PeerJS to close, so a peer that closes the instant it
 * reads the sentinel cannot beat the listener into place.
 *
 * @param conn       The connection about to be closed; its channel and peer
 *                   connection are read now, before PeerJS can tear either off.
 * @param timeoutMs  Ceiling on the wait
 *                   (default {@link DEFAULT_PEER_CLOSE_TIMEOUT_MS}).
 * @param signal     The run's signal, if the caller has one: an abort ends the
 *                   wait with `run-aborted` instead of leaving a cancelling
 *                   operator to wait out a duration the peer chooses. Checked on
 *                   entry as well as listened for, so a teardown driven BY the
 *                   abort starts no wait at all.
 */
export function waitForPeerClose(
  conn: DataConnection,
  timeoutMs: number = DEFAULT_PEER_CLOSE_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<PeerCloseOutcome> {
  if (signal?.aborted) return Promise.resolve("run-aborted");
  const { channel, peerConnection } = transportOf(conn);
  // Nothing to wait for: a channel that is not open can carry neither the
  // sentinel nor the frames behind it, so the wait would be pure delay on a
  // path that has already lost whatever was buffered.
  if (channel === undefined || channel.readyState !== "open")
    return Promise.resolve("channel-not-open");
  return new Promise<PeerCloseOutcome>((resolve) => {
    let settled = false;
    const settle = (outcome: PeerCloseOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      channel.removeEventListener("close", onChannelClose);
      channel.removeEventListener("closing", onChannelClosing);
      peerConnection?.removeEventListener(
        "connectionstatechange",
        onPeerConnectionState,
      );
      signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const noLivePeerConnection = () =>
      peerConnection !== undefined &&
      DEAD_PEER_STATES.has(peerConnection.connectionState);
    const onChannelClosing = () => {
      // The channel is going down, but not necessarily at the peer's hand: a
      // teardown of this side's own peer connection takes the channel with it,
      // and everything still in the outbound buffer with that. The link says
      // which of the two happened, and this is the event at which it can still
      // be asked -- a close under way has not yet been answered by this side's
      // stack, which a completed one has (see the `close` handler). Both
      // readings are driven against the real stack in
      // apps/web/test/browser/webrtcCloseDelivery.test.ts.
      settle(noLivePeerConnection() ? "peer-gone" : "peer-closed");
    };
    const onChannelClose = () => {
      // The terminal event, kept for a stack that never enters `closing` at
      // all. It deliberately does not repeat the reading above: a close that
      // has already completed is one this side's own stack may have answered by
      // tearing the link down, so a dead link here would not say that the link
      // was dead BEFORE the close. Reporting the peer's close is the reading
      // that cannot invent a doubt about a healthy exchange.
      settle("peer-closed");
    };
    const onAbort = () => {
      settle("run-aborted");
    };
    const onPeerConnectionState = () => {
      if (noLivePeerConnection()) settle("peer-gone");
    };
    const timer = setTimeout(() => {
      settle("ceiling");
    }, timeoutMs);
    channel.addEventListener("close", onChannelClose);
    channel.addEventListener("closing", onChannelClosing);
    peerConnection?.addEventListener(
      "connectionstatechange",
      onPeerConnectionState,
    );
    signal?.addEventListener("abort", onAbort);
    // The peer may already have gone while this side was still sending.
    onPeerConnectionState();
  });
}
