import type { DataConnection } from "peerjs";

/**
 * Default ceiling on the clean close's wait for the peer to take the final
 * frame, sized like the CLI transport's drain ceiling
 * (`DEFAULT_CLOSE_FLUSH_TIMEOUT_MS`): a worst-case frame
 * (`MAX_WEBRTC_FRAME_BYTES`, 256 MiB) needs minutes on a slow link. A
 * ceiling, not a wait -- it ends the moment the peer closes, and on expiry
 * the close returns anyway rather than hanging a finished exchange forever.
 */
export const DEFAULT_PEER_CLOSE_TIMEOUT_MS = 5 * 60 * 1000;

/** Peer-connection states with nothing live left to deliver over: ICE gave up
 * (`failed`), or this side tore the connection down (`closed`). `disconnected`
 * is absent: it is a transient loss of ICE connectivity that recovers, and
 * treating it as terminal would report delivery for a frame still in flight.
 * A peer that never comes back reaches `failed`; the ceiling covers a peer
 * that answers ICE but stops reading. */
const DEAD_PEER_STATES: ReadonlySet<RTCPeerConnectionState> = new Set([
  "failed",
  "closed",
]);

/**
 * How the clean close's wait for the peer ended. Exactly one of these holds a
 * delivery signal, so a caller that must tell "the peer took the final frame"
 * from "the wait gave up" branches on this rather than on the wait returning.
 */
export type PeerCloseOutcome =
  /** The channel closed with no sign of a teardown the peer had no part in:
   * the ordered channel places the close sentinel behind every frame already
   * handed to `send`, so a peer that reads in order took the final frame
   * before closing. Read at `closing`, where the link is still readable; an
   * already-gone link there reports `peer-gone` instead unless the peer's own
   * close took it down. A `close` with no prior `closing` is still read as
   * the peer's. */
  | "peer-closed"
  /** The ceiling ran out with the channel still open and the peer still live:
   * the peer answered ICE but never took the sentinel, so the final frame may
   * still be sitting in this side's outbound buffer. */
  | "ceiling"
  /** Nothing live is left to deliver over: the peer connection reached
   * `failed` (ICE gave up) or `closed` (this side tore it down); either way
   * whatever was buffered went with it, and no partner is left to confirm.
   * Reported by the state change, or by a channel closing on an already-dead
   * link with no peer close to account for it. */
  | "peer-gone"
  /** The channel was not open when the wait began, so it could send neither
   * the sentinel nor the frames behind it. */
  | "channel-not-open"
  /** The caller's signal aborted, so the wait was cut short rather than left
   * standing to the ceiling: a cancelling operator must not have to wait out
   * a duration the peer chooses. The sentinel may never have been read, so
   * this holds no delivery signal -- and it is its own exit rather than one
   * of the link's, so a cut wait is reported as that rather than whatever the
   * teardown behind it does to the channel. */
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
 * Whether PeerJS itself has already ended this connection. PeerJS clears
 * `open` inside `DataConnection.close()`, reached by reading the peer's
 * in-band close sentinel, by this side's own non-flushing close, and by
 * PeerJS's own cleanup paths (a broker-relayed LEAVE, an inbound OFFER
 * echoing the live connection id, ICE reaching failed or closed, a send
 * error, or the channel's own close). A healthy exchange where both parties
 * close therefore reaches `closing` on a link this side's own read of the
 * peer's sentinel already ended.
 *
 * A `closing` reached on a dead link with `open` still true is an end that
 * bypassed PeerJS -- this side's raw peer-connection teardown, the mid-drain
 * loss this wait exists to catch. Any PeerJS-mediated end is instead treated
 * as the peer's close; delivery proof remains the application-level
 * completion, not the close itself (see docs/spec/WEBRTC_TRANSPORT.md for
 * that limit).
 *
 * The flushing close this side runs leaves the flag alone: it only queues
 * this side's own sentinel and returns. Both readings are measured on a real
 * pair in Chromium and pinned in
 * apps/web/test/browser/webrtcCloseDelivery.test.ts, the healthy one also
 * end to end in apps/web/test/browser/exchangeLifecycle.test.ts.
 */
function peerCloseAlreadyRead(conn: DataConnection): boolean {
  return !conn.open;
}

/**
 * Resolves once the peer has closed the data channel underneath `conn` (the
 * one delivery signal a browser peer gets), once no live peer is left to
 * deliver to, once `signal` aborts, or once `timeoutMs` runs out, reporting
 * which ended the wait ({@link PeerCloseOutcome}). Never rejects: the caller
 * is already tearing down.
 *
 * This is what makes a clean close mean delivery: PeerJS's flushing close
 * only queues its in-band close sentinel and returns, leaving the final
 * frame still in the browser's outbound buffer (measured in
 * apps/web/test/browser/webrtcCloseDelivery.test.ts). The peer closes the
 * channel only once it reads that sentinel, which the ordered, reliable
 * channel places behind every frame already handed to `send`; that close
 * travels back as this channel's own `close` event, a stronger signal than
 * `bufferedAmount` reaching zero (see docs/spec/WEBRTC_TRANSPORT.md).
 *
 * The flushing close leaves the local channel `open`, touching neither
 * `close` nor `closing`. A close from tearing THIS side's own peer
 * connection down is not the peer's, and is told apart from the peer's real
 * close at `closing` by whether the link is already dead and whether PeerJS
 * has already read the peer's close sentinel (see
 * {@link peerCloseAlreadyRead}); a completed `close` with no prior `closing`
 * is still read as the peer's (see docs/spec/WEBRTC_TRANSPORT.md).
 *
 * Call this BEFORE asking PeerJS to close, so a peer that closes the instant
 * it reads the sentinel cannot beat the listener into place.
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
  // Nothing to wait for: a channel that is not open can send neither the
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
      // The channel is going down, but not necessarily at the peer's hand:
      // tearing this side's own peer connection down takes the channel with
      // it too. A dead link alone is not this side's teardown -- the peer's
      // close ends this side's link through PeerJS (see
      // peerCloseAlreadyRead) -- so only a link gone with no peer close in
      // hand counts as that. Driven against the real stack in
      // apps/web/test/browser/webrtcCloseDelivery.test.ts.
      settle(
        noLivePeerConnection() && !peerCloseAlreadyRead(conn)
          ? "peer-gone"
          : "peer-closed",
      );
    };
    const onChannelClose = () => {
      // The terminal event, kept for a stack that never enters `closing` at
      // all. Does not repeat the `closing` reading: once a close has
      // completed, a dead link no longer says whether it was dead before the
      // close or torn down in answer to it, so this reports the peer's close
      // rather than inventing a doubt about a healthy exchange.
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
