// The send-side counterpart of boundedReassembly.ts: it replaces this
// connection class's BinaryPack encode step so an outbound frame's element
// count is bounded by memory rather than by the JavaScript stack. The encoder
// itself -- and the byte-for-byte comparison against the pinned packer that
// keeps the wire unchanged -- lives in `@psilink/core`
// (connection/binaryPackEncode.ts), so both WebRTC transports put the same
// bytes on the wire.
//
// PeerJS packs an outbound frame with `peerjs-js-binarypack`'s `pack`, which
// descends one call frame per element: a matched set of a few thousand records
// overflows the sender's stack after both parties have paid for the PSI
// compute. Chunking and buffering are left to PeerJS; only the encode step
// changes (docs/spec/WEBRTC_TRANSPORT.md).

import { encodeBinaryPackValue } from "@psilink/core";

import type { DataConnection } from "peerjs";

/**
 * The PeerJS `DataConnection` internals this override replaces and calls.
 * `_send` packs one outbound value and hands it to `_sendChunks` (over the
 * chunker's MTU) or to `_bufferedSend` (at or under it, and for every chunk
 * `_sendChunks` sends back through `_send`). None is part of the public
 * `DataConnection` type, so this is a documented dependency assumption;
 * {@link assertIterativePackingSupported} checks all four exist, so a `peerjs`
 * upgrade that renames or restructures the send path fails loud.
 */
interface PackingDataConnection {
  _send: (data: unknown, chunked: boolean) => void;
  _sendChunks: (packed: ArrayBuffer) => void;
  _bufferedSend: (packed: ArrayBuffer) => void;
  chunker: { chunkedMTU: number };
}

/**
 * Asserts `conn` exposes the PeerJS internals
 * {@link packOutboundFramesIteratively} replaces and calls. Encodes the
 * dependency assumption as a runtime check, not a comment: a `peerjs` upgrade
 * that renames the encode step or moves the chunker must fail loud (the live
 * browser exchange test installs the override on every exchange) rather than
 * silently leave the recursive packer in place, which fails only once an
 * exchange is large enough -- past the PSI compute both parties paid for.
 * Called before any listener is attached, so a broken assumption fails cleanly
 * with nothing to tear down.
 */
export function assertIterativePackingSupported(conn: DataConnection): void {
  const probe = conn as unknown as {
    _send?: unknown;
    _sendChunks?: unknown;
    _bufferedSend?: unknown;
    chunker?: { chunkedMTU?: unknown };
  };
  if (
    typeof probe._send !== "function" ||
    typeof probe._sendChunks !== "function" ||
    typeof probe._bufferedSend !== "function" ||
    typeof probe.chunker?.chunkedMTU !== "number"
  ) {
    throw new Error(
      "PeerJS data connection does not expose the expected send internals " +
        "(_send/_sendChunks/_bufferedSend/chunker.chunkedMTU); outbound frames " +
        "cannot be packed without recursion. Re-verify against the installed " +
        "peerjs version.",
    );
  }
}

/**
 * Replaces `conn`'s BinaryPack encode step with core's iterative encoder,
 * leaving PeerJS's chunking and buffering to PeerJS. The replacement keeps the
 * original's contract exactly: an already-chunked value, or a packed frame at
 * or under the chunker's MTU, goes straight to `_bufferedSend`; anything larger
 * goes to `_sendChunks`, whose chunk envelopes come back through this same
 * replacement.
 *
 * @param conn  The PeerJS data connection (open or not yet open); install
 *              before the first send.
 * @throws If the PeerJS internals are not as expected (a broken upgrade
 *   assumption), or, at send time, if a frame holds a value kind the wire does
 *   not carry.
 */
export function packOutboundFramesIteratively(conn: DataConnection): void {
  assertIterativePackingSupported(conn);
  const internals = conn as unknown as PackingDataConnection;

  internals._send = (data: unknown, chunked: boolean): void => {
    const packed = encodeBinaryPackValue(data);
    if (!chunked && packed.byteLength > internals.chunker.chunkedMTU) {
      internals._sendChunks(packed);
      return;
    }
    internals._bufferedSend(packed);
  };
}
