import { pack, unpack } from "peerjs-js-binarypack";

import { ConnectionError } from "@psilink/core";

/**
 * The PeerJS DataConnection wire, written out rather than obtained by running
 * PeerJS: the CLI drives werift's `RTCPeerConnection` directly and speaks
 * PeerJS-compatible framing on the raw data channel, so a browser PeerJS peer on
 * the other end sees exactly what another PeerJS peer would send
 * (docs/notes/cli-webrtc-stack.md, "The PeerJS wire the CLI speaks").
 *
 * Every shape here was measured against the installed `peerjs` 1.5.5 and
 * `peerjs-js-binarypack` 2.1.0 rather than read off their sources, and both are
 * exact-pinned for that reason (docs/spec/DEPENDENCY_PINS.md). What was measured:
 * the chunk envelope's four keys and their order, the 16,300-byte chunking
 * threshold, the close sentinel's exact object, the truthy-`__peerData` receive
 * dispatch, and the fact that `pack` encodes a `Uint8Array`, an `ArrayBuffer` and
 * a Node `Buffer` to identical bytes. The round-trip tests in
 * test/unit/peerjsWire.test.ts pin those bytes as fixtures, so a bump that moves
 * the encoding fails there rather than at a partner's browser.
 *
 * This module is the framing only. The bounds that make the receive path safe
 * against a hostile peer live beside it in `inboundBounds.ts`, which is the only
 * thing that should call {@link classifyInboundValue} in production.
 */

/**
 * Byte length past which PeerJS splits a packed message into chunks
 * (`peerjs`'s `util.chunkedMTU`). Well under the 65,536-byte SCTP message
 * ceiling both peers negotiate, so it is a PeerJS convention rather than a
 * transport limit -- which is exactly why it has to be matched: a browser peer
 * reassembles by this envelope, not by anything SCTP knows about.
 */
export const PEERJS_CHUNK_MTU = 16_300;

/**
 * The `serialization` value the CLI advertises on its OFFER. Critical rather
 * than a preference: the receiving PeerJS peer selects its DataConnection
 * subclass from this field, and only the `binary` subclass implements the chunk
 * envelope below, so a mismatch is a protocol break
 * (docs/notes/cli-webrtc-stack.md).
 */
export const PEERJS_SERIALIZATION = "binary";

/**
 * First chunk-envelope message id. PeerJS's counter starts at 1, and the receive
 * dispatch keys off `__peerData` being TRUTHY, so an id of 0 would be treated as a
 * plain application frame holding a `__peerData` property. Starting at 1 is
 * therefore part of the wire, not an off-by-one.
 */
const FIRST_MESSAGE_ID = 1;

/** One inbound BinaryPack value, classified by the PeerJS receive dispatch. */
export type InboundValue =
  /** The in-band clean-close sentinel; the peer is done sending. */
  | { kind: "close" }
  /** One slice of a chunked frame, to be reassembled by message id. */
  | {
      kind: "chunk";
      messageId: number;
      index: number;
      total: number;
      data: Uint8Array;
    }
  /** A complete application frame. */
  | { kind: "data"; value: unknown };

/** A frame the peer sent that this side cannot interpret as any wire shape. */
function malformedFrameError(detail: string): ConnectionError {
  return new ConnectionError(
    `the peer sent a malformed WebRTC frame: ${detail}`,
    "protocol",
  );
}

/**
 * Coerce a binary data-channel message to a `Uint8Array` view without
 * copying. werift's `onmessage` delivers a Node `Buffer` for binary, a
 * string for a text-mode peer, and nothing for a zero-length binary message;
 * none is a PeerJS binary frame and each is refused as malformed -- an empty
 * view unpacks to the number `0` (measured), which would otherwise pass as a
 * bogus application frame `0`. A WebRTC data channel has a per-message type,
 * so either shape is possible on the same channel.
 *
 * @throws {ConnectionError} of kind `protocol` on a non-binary or empty datagram.
 */
export function toFrameBytes(data: unknown): Uint8Array {
  let view: Uint8Array;
  if (data instanceof ArrayBuffer) {
    view = new Uint8Array(data);
  } else if (ArrayBuffer.isView(data)) {
    view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  } else {
    throw malformedFrameError("it is not a binary datagram");
  }
  if (view.byteLength === 0) {
    throw malformedFrameError("it is an empty datagram");
  }
  return view;
}

/**
 * BinaryPack-encode one application value, exactly as PeerJS's binary
 * DataConnection `_send` does before chunking.
 *
 * `pack` returns a `Promise` only for a `Blob` input, which nothing on this path
 * constructs (Node hands us `Buffer`/`Uint8Array` payloads), so the synchronous
 * branch is the only reachable one -- asserted rather than assumed, since a
 * silently-awaited promise would put a `[object Promise]` on the wire.
 */
export function packValue(value: unknown): Uint8Array {
  // `pack` accepts far more than its `Packable` type admits (the psilink frames
  // are plain objects of strings, numbers and byte arrays); the cast is the
  // boundary between our `unknown` frames and its declared input type.
  const packed = pack(value as Parameters<typeof pack>[0]);
  if (packed instanceof Promise) {
    throw new ConnectionError(
      "BinaryPack returned an asynchronous result for an outbound frame; the " +
        "CLI transport packs only synchronous payloads",
      "usage",
    );
  }
  return new Uint8Array(packed);
}

/** The PeerJS in-band clean-close sentinel, packed and ready to send. */
export function packCloseSentinel(): Uint8Array {
  return packValue({ __peerData: { type: "close" } });
}

/**
 * Split an already-packed frame into the chunk envelopes PeerJS would put on the
 * wire, or return it whole when it is at or under the MTU. The envelope's key
 * order (`__peerData`, `n`, `data`, `total`) matches PeerJS's chunker so the
 * emitted bytes are identical, not merely equivalent.
 */
export function chunkPacked(
  packed: Uint8Array,
  messageId: number,
  chunkMtu: number = PEERJS_CHUNK_MTU,
): Array<Uint8Array> {
  if (packed.byteLength <= chunkMtu) return [packed];
  const total = Math.ceil(packed.byteLength / chunkMtu);
  const chunks: Array<Uint8Array> = [];
  for (let start = 0; start < packed.byteLength; start += chunkMtu) {
    chunks.push(
      packValue({
        __peerData: messageId,
        n: chunks.length,
        data: packed.subarray(
          start,
          Math.min(packed.byteLength, start + chunkMtu),
        ),
        total,
      }),
    );
  }
  return chunks;
}

/**
 * Encodes outbound application frames as the datagrams a PeerJS peer expects.
 * Holds the per-connection chunk message-id counter, so one instance belongs to
 * one data channel: ids only have to be distinct among the reassemblies in
 * flight at once, and a monotonic per-connection counter is the same discipline
 * PeerJS applies per page.
 */
export class PeerJsFrameEncoder {
  private nextMessageId = FIRST_MESSAGE_ID;

  constructor(private readonly chunkMtu: number = PEERJS_CHUNK_MTU) {}

  /** The datagrams for one application frame, in send order. */
  encode(value: unknown): Array<Uint8Array> {
    const packed = packValue(value);
    if (packed.byteLength <= this.chunkMtu) return [packed];
    return chunkPacked(packed, this.nextMessageId++, this.chunkMtu);
  }
}

/** Is `value` a non-array object, the only shape the wire's envelopes take? */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A chunk index/count that indexes a real slice: a non-negative safe integer. */
function isChunkOrdinal(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/**
 * Classify one already-unpacked inbound value by PeerJS's receive dispatch:
 * a truthy `__peerData` is either the close sentinel or a chunk, and
 * anything else is a complete application frame.
 *
 * The chunk branch validates the envelope's shape (every field is
 * peer-chosen): `total` must be a positive integer, `n` must be in
 * `[0, total)`, and `data` must be bytes. The numeric CAPS (how many
 * chunks, how many bytes, how many reassemblies at once) are not applied
 * here -- they belong to `inboundBounds.ts`, which owns the memory
 * envelope.
 *
 * @throws {ConnectionError} of kind `protocol` if the value has a
 *         `__peerData` that is neither the close sentinel nor a well-formed
 *         chunk envelope.
 */
export function classifyInboundValue(unpacked: unknown): InboundValue {
  if (!isPlainObject(unpacked)) return { kind: "data", value: unpacked };
  const peerData = unpacked.__peerData;
  if (!peerData) return { kind: "data", value: unpacked };
  if (isPlainObject(peerData)) {
    if (peerData.type === "close") return { kind: "close" };
    throw malformedFrameError(
      "its __peerData is an object that is not the close sentinel",
    );
  }
  if (typeof peerData !== "number" || !Number.isSafeInteger(peerData)) {
    throw malformedFrameError("its chunk message id is not an integer");
  }
  const { n, total, data } = unpacked;
  if (!isChunkOrdinal(total) || total < 1) {
    throw malformedFrameError("its chunk count is not a positive integer");
  }
  if (!isChunkOrdinal(n) || n >= total) {
    throw malformedFrameError("its chunk index is outside the declared count");
  }
  if (!ArrayBuffer.isView(data) && !(data instanceof ArrayBuffer)) {
    throw malformedFrameError("its chunk payload is not binary");
  }
  return {
    kind: "chunk",
    messageId: peerData,
    index: n,
    total,
    data: toFrameBytes(data),
  };
}

/**
 * BinaryPack-decode one inbound datagram. Kept beside the encoder so both
 * directions name the same library entry points, and so the one cast covering
 * `unpack`'s declared `ArrayBuffer` parameter (it reads any `Uint8Array` view,
 * measured) sits in one place.
 *
 * @throws {ConnectionError} of kind `protocol` on a truncated or malformed body;
 *         `unpack`'s own throw holds a span of peer bytes, so it is replaced
 *         rather than wrapped.
 */
export function unpackFrame(bytes: Uint8Array): unknown {
  try {
    return unpack(bytes as unknown as ArrayBuffer);
  } catch {
    throw malformedFrameError("its BinaryPack body could not be decoded");
  }
}

/**
 * Join a completed reassembly's slices into the packed frame they encode.
 * `parts` is indexed by chunk ordinal and must be dense; the caller
 * (`inboundBounds.ts`) only calls this once every ordinal has arrived.
 */
export function concatChunks(parts: Array<Uint8Array>): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return joined;
}
