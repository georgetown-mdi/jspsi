// Message-frame envelope codec for the file-sync wire protocol: the pure
// serialize/deserialize over the raw `version || type || seq || payload` bytes
// every data-plane message file carries. Everything here is a pure function of
// its byte/number inputs -- no instance state, no I/O -- so the wire layout and
// its validation live in one place.
//
// This module is deliberately NOT re-exported by the package barrel (main.ts
// barrels fileSyncConnection.ts via `export *`, not this file), so an
// `@internal` export here stays out of the package's public runtime surface
// while a unit test can deep-import it -- the same pattern as fileSyncNames.ts
// and fileSyncConstants.ts. The currently-public codec symbols
// (MESSAGE_ENVELOPE_VERSION, MESSAGE_TYPE_OBJECT, MESSAGE_TYPE_BINARY,
// MESSAGE_HEADER_BYTES, serializeFileSyncMessageHeader, serializeFileSyncMessage)
// keep their public surface by being re-exported from fileSyncConnection.ts
// (which IS barrelled).

// Binary message-frame envelope. Every data-plane message file -- a JSON control
// message (the pre-encryption handshake) and an encrypted binary PSI frame alike
// -- is written as raw bytes `version || type || seq || payload`:
//
//   byte 0      version/format marker (MESSAGE_ENVELOPE_VERSION)
//   byte 1      payload type (MESSAGE_TYPE_OBJECT | MESSAGE_TYPE_BINARY) -- the
//               OUTER, cleartext discriminator the reader keys on, because an
//               encrypted frame's own type tag lives inside the AEAD ciphertext
//               and cannot drive the transport read
//   bytes 2..9  per-session sequence number, 8-byte big-endian
//   bytes 10..  payload: UTF-8 JSON (MESSAGE_TYPE_OBJECT) or raw frame bytes
//               (MESSAGE_TYPE_BINARY)
//
// Carrying the payload as raw bytes -- rather than the former
// `{ ts, seq, type, payload }` JSON with a Uint8Array payload base64url-encoded
// into the `payload` string -- removes the ~4/3 base64 expansion and ends the
// read path's reliance on `Buffer.prototype.toString()` (which throws above
// Node's maximum string length), so a frame larger than that limit can be read.
// The send-time `ts` is no longer carried in the body (it was write-only there;
// a timestamped filename still records it).
/** @internal */
export const MESSAGE_ENVELOPE_VERSION = 1;
/** @internal */
export const MESSAGE_TYPE_OBJECT = 0;
/** @internal */
export const MESSAGE_TYPE_BINARY = 1;
/** @internal */
export const MESSAGE_HEADER_BYTES = 10;

// Human-readable label for a message payload type, used only in log lines (it
// preserves the pre-binary "Object"/"Uint8Array" wording so log-scraping stays
// stable across this format change).
export const messageTypeLabel = (type: number): string =>
  type === MESSAGE_TYPE_BINARY ? "Uint8Array" : "Object";

// Writes the MESSAGE_HEADER_BYTES-long envelope header (version || type || seq)
// into the first 10 bytes of `out`. Every byte is assigned, so an allocUnsafe
// target leaks no uninitialized bytes. Shared by the header-only serializer (the
// streamed send path) and the whole-message serializer (test message injection)
// so the byte layout lives in one place.
const writeMessageHeader = (out: Buffer, type: number, seq: number): void => {
  out[0] = MESSAGE_ENVELOPE_VERSION;
  out[1] = type;
  out.writeBigUInt64BE(BigInt(seq), 2);
};

/**
 * Serialize just the {@link MESSAGE_HEADER_BYTES}-byte envelope header
 * (`version || type || seq`), returning a fresh Buffer holding only those bytes.
 * The send path streams this header and the payload as two chunks (see
 * {@link FileSyncConnection.send}) rather than concatenating them into one
 * buffer, so it never copies the whole payload to prepend the 10-byte header: a
 * binary frame holds ~1x its size live, not ~2x. The on-disk bytes are
 * identical to {@link serializeFileSyncMessage}'s (`header || payload`); the byte
 * count the filename declares is `MESSAGE_HEADER_BYTES + payload.length`.
 *
 * @internal exported for the file-sync transport tests.
 */
export function serializeFileSyncMessageHeader(
  type: number,
  seq: number,
): Buffer {
  const header = Buffer.allocUnsafe(MESSAGE_HEADER_BYTES);
  writeMessageHeader(header, type, seq);
  return header;
}

/**
 * Serialize a data-plane message into its on-disk binary envelope. `payload` is
 * the raw payload bytes (UTF-8 JSON for {@link MESSAGE_TYPE_OBJECT}, the frame
 * itself for {@link MESSAGE_TYPE_BINARY}). The returned Buffer's length is the
 * exact on-disk byte count encoded into the message filename, so the receiver's
 * sync-gate can distinguish a partially-synced file from a complete one.
 *
 * The live send path does NOT use this: it streams a
 * {@link serializeFileSyncMessageHeader} header and the payload as two chunks to
 * avoid the full-payload copy this makes (`out.set`). This whole-buffer form is
 * retained for the transport tests, which inject a complete message file's bytes.
 *
 * @internal exported for the file-sync transport tests.
 */
export function serializeFileSyncMessage(
  type: number,
  seq: number,
  payload: Uint8Array,
): Buffer {
  const out = Buffer.allocUnsafe(MESSAGE_HEADER_BYTES + payload.length);
  writeMessageHeader(out, type, seq);
  out.set(payload, MESSAGE_HEADER_BYTES);
  return out;
}

export interface DeserializedMessage {
  type: number;
  seq: number;
  // A view onto the source buffer (no copy): a MESSAGE_TYPE_OBJECT payload is
  // handed to parseBoundedJson, a MESSAGE_TYPE_BINARY payload is delivered as-is,
  // so the frame is never stringified regardless of its size.
  payload: Uint8Array;
}

// Thrown by deserializeFileSyncMessage when byte 0 -- the cleartext envelope
// version marker -- is not this build's MESSAGE_ENVELOPE_VERSION. That byte is
// the one signal that separates a same-version peer's (possibly corrupt) frame
// from a foreign wire format: a JSON-text control message from a peer that
// predates the binary envelope begins with '{' (0x7B), and any future
// envelope-version bump raises the byte, so an unrecognized value most likely
// means the partner is on an incompatible psilink version rather than that a
// same-version frame corrupted. The read path translates this into an
// operator-facing "likely incompatible partner version" hint instead of the raw
// "malformed envelope" text. It cannot be perfectly precise -- a foreign format
// that happens to reuse byte 0 == 1 would still fall through to the generic
// checks -- so the message is a "likely" hint, not a certain diagnosis.
export class IncompatibleEnvelopeVersionError extends Error {
  constructor(readonly foundVersion: number) {
    super(`unsupported message envelope version ${foundVersion}`);
    this.name = "IncompatibleEnvelopeVersionError";
  }
}

/**
 * Parse a message file's bytes back into its envelope fields, validating the
 * version marker, the type discriminator, and the minimum length. Throws a plain
 * Error (the caller wraps it as a terminal UsageError) on any structural
 * failure. Deliberately does NOT decode the payload, so a frame larger than
 * Node's maximum string length is never converted to a string here.
 */
export function deserializeFileSyncMessage(
  raw: Uint8Array,
): DeserializedMessage {
  if (raw.length < MESSAGE_HEADER_BYTES)
    throw new Error("message envelope is shorter than its header");
  if (raw[0] !== MESSAGE_ENVELOPE_VERSION)
    throw new IncompatibleEnvelopeVersionError(raw[0]);
  const type = raw[1];
  if (type !== MESSAGE_TYPE_OBJECT && type !== MESSAGE_TYPE_BINARY)
    throw new Error(`unknown message payload type ${type}`);
  // An honest writer caps seq at the per-session message counter (far below
  // 2^53), so reject anything above MAX_SAFE_INTEGER as malformed before
  // narrowing to a Number -- a Number() conversion above that range loses
  // precision, and comparing as BigInt first mirrors the AEAD decorator's
  // inbound-seq guard (handleInbound) rather than leaning on the downstream
  // retain-mode cross-check to fail-safe on the corrupted value.
  const seqBig = new DataView(
    raw.buffer,
    raw.byteOffset,
    raw.byteLength,
  ).getBigUint64(2, false);
  if (seqBig > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("message envelope sequence number exceeds safe range");
  const seq = Number(seqBig);
  return { type, seq, payload: raw.subarray(MESSAGE_HEADER_BYTES) };
}
