// The send-side half of the WebRTC data-channel frame bound
// (docs/spec/CHANNEL_SECURITY.md, "WebRTC data-channel inbound bound"): the
// arithmetic a sender uses to refuse a frame the partner's receive path would
// refuse, before the frame goes on the wire. Every refusal the exchange makes
// on this bound -- the pre-connection count check and the per-round check on
// the built frame -- goes through `webrtcFrameExceedsBound`, so the two cannot
// disagree about where the bound falls.

import {
  MAX_WEBRTC_FRAME_BYTES,
  MIN_CHUNK_RESIDENT_BYTES,
} from "./binaryPackBounds";

/**
 * Byte length past which PeerJS splits a packed message into chunks
 * (`peerjs`'s `util.chunkedMTU`), measured against the pinned `peerjs`
 * (docs/spec/DEPENDENCY_PINS.md). A packed frame at or under it goes on the
 * wire whole; a longer one goes as `ceil(bytes / PEERJS_CHUNK_MTU)` chunk
 * envelopes of at most this many payload bytes each.
 */
export const PEERJS_CHUNK_MTU = 16_300;

/**
 * The most bytes a PeerJS chunk envelope adds around its payload slice: a
 * four-entry map header, the four key strings (`__peerData`, `n`, `data`,
 * `total`), three integers at BinaryPack's widest integer marker (nine bytes
 * each), and the payload's `bin16` header, the widest a slice of at most
 * {@link PEERJS_CHUNK_MTU} bytes takes.
 */
const MAX_PEERJS_CHUNK_ENVELOPE_BYTES = 1 + 11 + 2 + 5 + 6 + 3 * 9 + 3;

/**
 * Bytes one encrypted PSI element takes in a serialized set: a 33-byte
 * compressed curve point plus its protobuf tag and length byte. A set of `n`
 * elements serializes to at least `n` times this: the response the PSI
 * library builds is exactly that long, and the setup and request add a few
 * bytes of message framing (docs/spec/PROTOCOL.md, "The memory ceiling, and
 * the CSV intake cap").
 */
export const PSI_ENCODED_ELEMENT_BYTES = 35;

/**
 * Length of the BinaryPack frame a byte array of `payloadBytes` bytes packs
 * to: the payload plus the `fixraw`, `bin16`, or `bin32` header its length
 * selects -- the frame a PSI set, a single-pass reply, or any other binary
 * message puts on the data channel.
 */
export function binaryPackByteStringLength(payloadBytes: number): number {
  if (payloadBytes <= 0x0f) return payloadBytes + 1;
  if (payloadBytes <= 0xffff) return payloadBytes + 3;
  return payloadBytes + 5;
}

/**
 * The most bytes a WebRTC receiver charges against its frame bound for one
 * packed frame of `packedFrameBytes` bytes. A frame sent whole is charged its
 * own length. A chunked frame is charged per chunk, each at least
 * {@link MIN_CHUNK_RESIDENT_BYTES}, and a receiver that counts whole chunk
 * datagrams charges each chunk's envelope too, so this adds the widest
 * envelope to every chunk. It is an upper bound on what either receiver
 * charges: the web app counts chunk payloads, the CLI whole datagrams.
 */
export function webrtcFrameReceiveCharge(packedFrameBytes: number): number {
  if (packedFrameBytes <= PEERJS_CHUNK_MTU) return packedFrameBytes;
  const chunks = Math.ceil(packedFrameBytes / PEERJS_CHUNK_MTU);
  const lastSlice = packedFrameBytes - (chunks - 1) * PEERJS_CHUNK_MTU;
  const chargeFor = (slice: number): number =>
    Math.max(slice + MAX_PEERJS_CHUNK_ENVELOPE_BYTES, MIN_CHUNK_RESIDENT_BYTES);
  return (chunks - 1) * chargeFor(PEERJS_CHUNK_MTU) + chargeFor(lastSlice);
}

/**
 * Whether a packed frame of `packedFrameBytes` bytes is one the partner's
 * WebRTC receive path could refuse: true when {@link webrtcFrameReceiveCharge}
 * exceeds `maxFrameBytes`. The one test every sender-side refusal of this
 * bound applies.
 *
 * @param maxFrameBytes - The receiver's bound, {@link MAX_WEBRTC_FRAME_BYTES}
 *   unless a test lowers it.
 */
export function webrtcFrameExceedsBound(
  packedFrameBytes: number,
  maxFrameBytes: number = MAX_WEBRTC_FRAME_BYTES,
): boolean {
  return webrtcFrameReceiveCharge(packedFrameBytes) > maxFrameBytes;
}

/**
 * The fewest bytes the packed frame of a PSI set of `elementCount` elements
 * can take: the byte-array frame around {@link PSI_ENCODED_ELEMENT_BYTES} per
 * element. A lower bound on every set frame of that count, so a count whose
 * frame this already puts over the bound is one no set of it can fit.
 */
export function minimumPsiSetFrameBytes(elementCount: number): number {
  return binaryPackByteStringLength(elementCount * PSI_ENCODED_ELEMENT_BYTES);
}

/**
 * The reason a round's refusal puts on the abort frame it sends the partner.
 * A fixed literal, like every abort reason (see `sendAbort`).
 */
export const WEBRTC_FRAME_LIMIT_ABORT_REASON =
  "a PSI set is too large for one WebRTC message";

const MIB = 1024 * 1024;

/**
 * A byte count as the operator reads it: whole bytes under a mebibyte, else
 * mebibytes to one decimal place. `roundUp` rounds a size up rather than to
 * nearest, so a size over a bound never displays as equal to it.
 */
function formatBytes(bytes: number, roundUp: boolean): string {
  if (bytes < MIB) return `${bytes} bytes`;
  const tenths = (roundUp ? Math.ceil : Math.round)((bytes / MIB) * 10);
  return `${(tenths / 10).toString()} MiB`;
}

const SPLIT_OR_FILE_SYNC_REMEDY =
  "Split the input into smaller files and run one exchange for each, or " +
  "run the exchange with the command-line application over SFTP or a " +
  "synced folder, which allow larger messages.";

/**
 * The refusal a WebRTC exchange raises at its start when this party's first
 * round alone cannot fit one message: `elementCount` is the fewest values that
 * round sends, so the size stated is the least its set can take.
 */
export function roundOneSetTooLargeMessage(
  elementCount: number,
  maxFrameBytes: number = MAX_WEBRTC_FRAME_BYTES,
): string {
  const charge = webrtcFrameReceiveCharge(
    minimumPsiSetFrameBytes(elementCount),
  );
  return (
    "This input is too large for a WebRTC exchange: the first linkage key " +
    `gives this party at least ${elementCount} values to send, a set of at ` +
    `least ${formatBytes(charge, true)}, over the ` +
    `${formatBytes(maxFrameBytes, false)} one WebRTC message can hold. ` +
    `Nothing was sent. ${SPLIT_OR_FILE_SYNC_REMEDY}`
  );
}

/**
 * The refusal a round raises on a set frame it built that the partner's
 * receive path would refuse. `setOwner` is whose set the frame holds: this
 * party's own, or the partner's, which the reply returns re-encrypted.
 */
export function builtSetTooLargeMessage(
  setOwner: "local" | "partner",
  packedFrameBytes: number,
  maxFrameBytes: number = MAX_WEBRTC_FRAME_BYTES,
): string {
  const size = formatBytes(webrtcFrameReceiveCharge(packedFrameBytes), true);
  const limit = formatBytes(maxFrameBytes, false);
  return setOwner === "local"
    ? `The set this party sends for this linkage key is ${size}, over the ` +
        `${limit} one WebRTC message can hold, so the exchange stopped ` +
        `before sending it and told your partner. ${SPLIT_OR_FILE_SYNC_REMEDY}`
    : `The reply to your partner's set for this linkage key is ${size}, ` +
        `over the ${limit} one WebRTC message can hold, so the exchange ` +
        "stopped before sending it and told your partner. Ask your partner " +
        "to split their input into smaller files and run one exchange for " +
        "each, or run the exchange together with the command-line " +
        "application over SFTP or a synced folder, which allow larger " +
        "messages.";
}
