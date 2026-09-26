import { PeerErrorType } from "peerjs";

import type Peer from "peerjs";

/**
 * Largest inbound signaling frame accepted, in UTF-8 bytes, before PeerJS
 * parses it: the CLI's value (`MAX_SIGNALING_FRAME_BYTES`,
 * `apps/cli/src/connection/webrtc/brokerClient.ts`). A signaling frame is an
 * SDP or one ICE candidate, kilobytes at most. The browser's WebSocket has
 * already read the frame by the time this refuses it, so it bounds what is
 * parsed, not what the socket allocates once.
 */
export const MAX_SIGNALING_FRAME_BYTES = 256 * 1024;

/**
 * Most signaling messages PeerJS holds for connections it has not set up
 * yet, across every connection id: the CLI's per-connection candidate cap
 * (`MAX_PENDING_REMOTE_CANDIDATES`, `apps/cli/src/connection/webrtc/
 * weriftPeer.ts`). Past it the surplus is dropped silently, as the CLI drops
 * it, since logging each one would be a log flood of its own.
 */
export const MAX_PENDING_SIGNALING_MESSAGES = 128;

/** The PeerJS internals the two bounds are installed on. */
interface PeerSignalingInternals {
  socket: {
    start: (id: string, token: string) => void;
    _socket?: WebSocket;
  };
  _lostMessages: Map<string, Array<unknown>>;
  _storeMessage: (connectionId: string, message: unknown) => void;
}

function signalingInternals(peer: Peer): PeerSignalingInternals {
  const probe = peer as unknown as Partial<PeerSignalingInternals>;
  if (
    typeof probe.socket?.start !== "function" ||
    !(probe._lostMessages instanceof Map) ||
    typeof probe._storeMessage !== "function"
  ) {
    throw new Error(
      "PeerJS peer does not expose the expected signaling internals " +
        "(socket.start/_lostMessages/_storeMessage); the signaling bounds " +
        "cannot be installed. Re-verify against the installed peerjs version.",
    );
  }
  return probe as PeerSignalingInternals;
}

/** Whether `text` is over {@link MAX_SIGNALING_FRAME_BYTES} in UTF-8. */
function exceedsSignalingFrameBytes(text: string): boolean {
  // UTF-8 never takes fewer bytes than UTF-16 code units, nor more than three
  // per unit, so only a frame between the two needs encoding to decide.
  if (text.length > MAX_SIGNALING_FRAME_BYTES) return true;
  if (text.length * 3 <= MAX_SIGNALING_FRAME_BYTES) return false;
  return new TextEncoder().encode(text).byteLength > MAX_SIGNALING_FRAME_BYTES;
}

function heldMessageCount(held: Map<string, Array<unknown>>): number {
  let count = 0;
  for (const messages of held.values()) count += messages.length;
  return count;
}

/**
 * Hold `peer`'s signaling path to the CLI's two bounds. A frame over
 * {@link MAX_SIGNALING_FRAME_BYTES} is never parsed: the peer reports a
 * `server-error` naming the limit and leaves the signaling server, as the CLI
 * ends its signaling connection on one. Messages held for a connection not yet
 * set up stop at {@link MAX_PENDING_SIGNALING_MESSAGES}. Installed right after
 * construction, before the socket can deliver a frame, and again on every
 * later socket the peer opens.
 *
 * @throws {Error} if the installed PeerJS does not expose the internals.
 */
export function boundPeerSignaling(peer: Peer): Peer {
  const internals = signalingInternals(peer);

  const refuseOversizedFrame = (): void => {
    peer.emitError(
      PeerErrorType.ServerError,
      `the signaling server sent a frame larger than the ` +
        `${MAX_SIGNALING_FRAME_BYTES}-byte limit`,
    );
    peer.disconnect();
  };

  const guardSocket = (): void => {
    const socket = internals.socket._socket;
    const deliver = socket?.onmessage;
    if (socket === undefined || typeof deliver !== "function") return;
    socket.onmessage = (event: MessageEvent) => {
      if (
        typeof event.data === "string" &&
        exceedsSignalingFrameBytes(event.data)
      ) {
        refuseOversizedFrame();
        return;
      }
      deliver.call(socket, event);
    };
  };

  const start = internals.socket.start.bind(internals.socket);
  internals.socket.start = (id: string, token: string) => {
    start(id, token);
    guardSocket();
  };
  guardSocket();

  const store = internals._storeMessage.bind(peer);
  internals._storeMessage = (connectionId: string, message: unknown) => {
    if (
      heldMessageCount(internals._lostMessages) >=
      MAX_PENDING_SIGNALING_MESSAGES
    )
      return;
    store(connectionId, message);
  };

  return peer;
}
