import { ConnectionError } from "@psilink/core";

import type { DataConnection } from "peerjs";

/**
 * Maximum size, in bytes, of a single inbound frame the web WebRTC data-channel
 * receive path will reassemble into memory. The web peer-to-peer transport runs
 * the PeerJS data channel directly: it discards the rotated key and declines the
 * application-layer AEAD wrap under DTLS (see {@link ./authenticateExchange}),
 * so core's `EncryptedMessageConnection` and its ~512 MiB `MAX_FRAME_SIZE_BYTES`
 * envelope -- a file-sync transport control -- never bind here. This is the
 * WebRTC transport's own inbound byte bound, the analogue of the file-sync
 * frame-size cap (docs/spec/CHANNEL_SECURITY.md) for the one transport that cap
 * does not reach. Without it a hostile or buggy peer can stream an oversized PSI
 * set frame (or a flood of never-completed chunk reassemblies) and drive the
 * receiving tab toward memory exhaustion, allocating proportional to what the
 * peer chooses to send.
 *
 * Value: 268,435,456 bytes (256 MiB). Unlike the file-sync cap -- a *decode*
 * ceiling anchored to Node's `MAX_STRING_LENGTH` -- this is a browser-tab
 * *memory envelope*, in the spirit of the directory-listing cap: above the
 * realistic largest legitimate PSI set frame (one party's set as raw EC points,
 * ~64 bytes/element binary, so a few-million-element set is tens to low-hundreds
 * of MiB; the 100 MiB CSV upload cap, `MAX_CSV_FILE_BYTES`, bounds it), below an
 * allocation that would crash the tab. 256 MiB is ~4 million elements. This
 * counts the *wire* (reassembled) bytes; the deserialized structure those bytes
 * unpack to is bounded separately by {@link MAX_WEBRTC_FRAME_STRUCTURE_BYTES},
 * because BinaryPack `unpack` can allocate far more than the wire size. Fixed, not
 * operator-configurable: a configurable cap risks being raised to reintroduce
 * the denial of service.
 */
export const MAX_WEBRTC_FRAME_BYTES = 256 * 1024 * 1024;

/**
 * Maximum number of concurrently-incomplete PeerJS chunk reassemblies retained
 * at once. The PSI protocol is strictly lockstep (see docs/spec/PROTOCOL.md):
 * each party sends one frame and waits for the reply, and the reliable, ordered
 * data channel delivers a frame's chunks contiguously, so at most ONE frame is
 * ever mid-reassembly on an honest exchange. This cap is generous headroom above
 * that maximum of one; beyond it the oldest incomplete partial is evicted (see
 * {@link boundChunkReassembly}), which bounds a flood of never-completed partials
 * from distinct message ids -- the case PeerJS leaves unbounded, since it retains
 * a partial keyed by message id indefinitely and never evicts one. Fixed, not
 * configurable, for the same reason as the byte bound.
 */
export const MAX_CONCURRENT_REASSEMBLIES = 8;

/**
 * Approximate per-value retained-byte weights the structural pre-scan charges, so
 * the per-frame budget {@link MAX_WEBRTC_FRAME_STRUCTURE_BYTES} is a memory
 * envelope rather than a flat value count. BinaryPack `unpack` allocates a real JS
 * value per declared element, but the retained cost of that value varies by kind,
 * so charging every value `+1` (the prior value-count budget) let a frame of the
 * *heaviest* kind retain far more than a frame of the same value count in the
 * *lightest* kind. Each weight is the measured/approximate V8 resident size of one
 * value of that kind, charged once as the scan reads that value's header:
 *
 * - `object` (64): an empty JS object from a BinaryPack map -- `unpack` does
 *   `new Object()` then assigns each key -- measured ~64 bytes resident (the
 *   JSObject plus its property/elements backing and hidden-class delta). This is
 *   the dominant amplifier the byte budget exists to charge honestly: one wire
 *   byte (a `fixmap` of zero pairs) unpacks to ~64 bytes.
 * - `array` (40): an empty JS array (`new Array(0)`), measured ~40 bytes (the
 *   JSArray plus an empty backing store). A non-empty array's per-element backing
 *   slot is attributed to each element via `scalar` below, so this is the base.
 * - `scalar` (8): an integer, boolean, null, or undefined -- stored as a tagged
 *   SMI/oddball in the one machine word (8 bytes) of its parent container's
 *   backing slot, with no separate heap allocation. A `bin`/`raw` value is also
 *   charged `scalar`: its payload is ~1x its wire bytes and so already bounded by
 *   {@link MAX_WEBRTC_FRAME_BYTES}, not by this structural budget. (The few number
 *   markers that unpack to a HeapNumber rather than a SMI -- `float`, `double`,
 *   `uint32`/`int32` past the SMI range, `uint64`/`int64` -- retain ~24 bytes
 *   incl. their slot, more than the 8 charged here; but each costs >= 5 wire
 *   bytes, so the wire-byte cap bounds an all-HeapNumber frame to well within this
 *   budget's envelope regardless.)
 * - `string` (`stringBase` 16 + `stringPerByte` 2 per declared wire byte): a
 *   SeqString header (~16 bytes) plus its characters. `unpack_string` decodes the
 *   declared UTF-8 wire length into a JS string of at most that many UTF-16 code
 *   units (~2 bytes each), so `stringBase + 2 * declaredWireBytes` upper-bounds its
 *   resident size. (A string's *build* transient -- a per-code-point cons-string
 *   tree -- is bounded separately by {@link MAX_WEBRTC_STRING_BYTES}, not here.)
 *
 * The model is deliberately a *conservative* upper bound: e.g. it charges every
 * object key string in full, though V8 internalizes repeated property keys to one
 * shared string, so the real retained peak of a key-heavy frame is lower. A true
 * memory envelope is simpler for a security reviewer to audit than one resting on
 * V8 interning/representation choices an engine update could change; the cost of
 * conservatism is a budget sized above the realistic legitimate frame rather than
 * hugging it (see {@link MAX_WEBRTC_FRAME_STRUCTURE_BYTES}). Fixed, not
 * configurable, for the same reason as the budget itself.
 */
export const WEBRTC_VALUE_WEIGHTS = {
  object: 64,
  array: 40,
  scalar: 8,
  stringBase: 16,
  stringPerByte: 2,
} as const;

/**
 * Maximum approximate *retained-byte* cost a single inbound frame's deserialized
 * structure may reach -- the byte-aware successor to the former value-count
 * budget. {@link MAX_WEBRTC_FRAME_BYTES} bounds the *wire* bytes, but PeerJS
 * (BinaryPack) `unpack`s a frame into a JS structure *synchronously, before
 * delivery and before any schema validation*, and that structure can be far
 * larger than the wire: BinaryPack encodes an empty object or array in one byte
 * but `unpack` allocates a real JS value per element (see
 * {@link WEBRTC_VALUE_WEIGHTS}), and -- worse -- a `new Array(N)` from an
 * `array32` header eagerly allocates N slots even when the elements are absent,
 * since `unpack` reads past the end of the buffer as zero rather than throwing. So
 * a tiny wire frame of array/object headers -- an in-protocol shape, since the
 * association-table and mapped-element frames are arrays of numbers/objects --
 * could deserialize to many GiB. A structural pre-scan (see
 * {@link structureOverBudget}, run at the unpack chokepoint) sums each declared
 * value's per-kind weight and rejects the frame *before* `unpack` allocates if the
 * running cost would exceed this budget, fail-closed. The scan also bounds each
 * declared container by the bytes that follow it (each element needs at least one
 * byte to encode), which ties the value count to the wire size and closes the
 * zero-filled-array vector.
 *
 * Value: 1,073,741,824 (2^30, 1 GiB), derived from the largest legitimate frame's
 * *retained* cost. That is the mapped-element frame -- `Array<{theirIndex,
 * iteration}>`, one entry per matched record -- which `unpack`s, per record, to
 * one object (64) + two key strings ("theirIndex" 16+20, "iteration" 16+18) + two
 * integer values (8 each) ~= 150 bytes under the weights above. At the
 * ~4-million-element (2^22) set ceiling the wire-byte cap implies, that is ~4.19M
 * records ~= 629 MiB; 2^30 leaves ~1.6x headroom (matching the prior count
 * budget's ~21M-value-vs-2^25 ratio) so no exchange the wire cap admits is
 * rejected on a downstream frame -- a property the unit tests pin against the real
 * frame shape. Residual: the per-frame worst case is now this budget rather than
 * the ~2 GiB an all-empty-objects frame reached under the flat count. A frame of
 * the heaviest kind (~16.7M empty objects) reaches ~1 GiB and is rejected there,
 * and reaching even that requires ~16 MiB of proportional wire (the per-container
 * byte check ties cost to wire), freed once the schema layer rejects the frame. A
 * tighter budget is available only by making the weights less conservative (e.g.
 * crediting key-string internalization); that aggressiveness is a security-review
 * judgment (see docs/spec/CHANNEL_SECURITY.md). Fixed, not configurable: a
 * configurable bound risks being raised to reintroduce the denial of service.
 */
export const MAX_WEBRTC_FRAME_STRUCTURE_BYTES = 1_073_741_824;

/**
 * Maximum nesting depth the structural pre-scan walks before rejecting. Legitimate
 * frames are shallow (an array of two-key objects is depth three); this bounds the
 * scan's own working stack against a pathologically nested frame and matches
 * core's `MAX_NESTING_DEPTH`. Fixed, not configurable.
 */
export const MAX_WEBRTC_REASSEMBLY_DEPTH = 256;

/**
 * Maximum number of chunks a single reassembly may accumulate. PeerJS retains
 * each chunk as its own `Uint8Array` (measured ~232 bytes resident even for a
 * one-byte slice), an overhead the byte cap -- which counts only payload bytes --
 * undercounts, so a flood of tiny chunks could exhaust memory while staying far
 * under {@link MAX_WEBRTC_FRAME_BYTES}. This caps the count so that overhead is
 * bounded: with {@link MAX_CONCURRENT_REASSEMBLIES} reassemblies at most this many
 * chunks each, retained chunk overhead stays on the order of the byte cap.
 *
 * Value: 131,072 (2^17), ~8x the ~16,500 chunks a 256 MiB frame produces at
 * PeerJS's ~16 KiB (16,300-byte) chunk MTU, so it never rejects a legitimate
 * frame while bounding a tiny-chunk flood. Fixed, not configurable.
 */
export const MAX_CHUNKS_PER_REASSEMBLY = 131_072;

/** Per-chunk retained overhead (a `Uint8Array` plus its slot, measured ~232
 * bytes even for a one-byte slice), the floor each chunk is charged against the
 * byte cap so a tiny-chunk flood is bounded by true memory; see
 * {@link MAX_CHUNKS_PER_REASSEMBLY}. */
export const MIN_CHUNK_RESIDENT_BYTES = 256;

/**
 * Maximum byte length of a single BinaryPack string a frame may contain. The
 * structural budget charges a string its *resident* size (see
 * {@link WEBRTC_VALUE_WEIGHTS}), but `unpack_string` builds that string via a
 * per-code-point concatenation whose transient cons-string tree is many times
 * larger again, so a single ~256 MiB-wire `str32` -- whose resident weight stays
 * within the structure budget -- would spike to multiple GiB *during the build*.
 * This caps each string's declared length so that transient is bounded; binary set
 * frames are `bin` (not strings) and every legitimate string a PSI frame carries
 * (the `{theirIndex, iteration}` keys, a `status` value, a payload cell) is far
 * shorter, so the cap never rejects one.
 *
 * Value: 1,048,576 (1 MiB), orders of magnitude above any legitimate string yet
 * small enough that the worst-case build transient stays in the tens of MiB.
 * Fixed, not configurable.
 */
export const MAX_WEBRTC_STRING_BYTES = 1024 * 1024;

/**
 * One slice of a chunked PeerJS frame, as it reaches the connection's
 * `_handleChunk`. Shape pinned from the PeerJS chunker (`__peerData` is the
 * message id shared by every chunk of one frame, `n` the chunk index, `total`
 * the chunk count, `data` the slice bytes). A premise this guard rests on; see
 * {@link boundChunkReassembly}.
 */
interface PeerChunk {
  __peerData: number;
  n: number;
  total: number;
  data: ArrayBufferView | ArrayBuffer | string | undefined;
}

/** A message handed to PeerJS's `_handleDataMessage`, the sole point at which an
 * inbound (or reassembled) frame is `unpack`ed. `data` is the raw bytes about to
 * be deserialized. */
interface PeerDataMessage {
  data: ArrayBufferView | ArrayBuffer | string | undefined;
}

/**
 * The PeerJS `DataConnection` internals this guard wraps. PeerJS reassembles a
 * chunked binary frame in `_handleChunk` (accumulating slices into `_chunkedData`
 * keyed by message id, deleting the entry on completion), and `unpack`s every
 * frame -- unchunked, or the reassembled buffer on completion -- in
 * `_handleDataMessage`. None is part of the public `DataConnection` type, so this
 * is a documented dependency premise (the binary/chunked connection class is the
 * one `peer.connect`/an incoming connection uses by default; see the `peerjs`
 * bundler). {@link assertChunkReassemblySupported} checks all three exist, so a
 * `peerjs` upgrade that renames or restructures them fails loud rather than
 * silently dropping the bound.
 */
interface ChunkedDataConnection {
  _handleChunk: (chunk: PeerChunk) => void;
  _handleDataMessage: (message: PeerDataMessage) => void;
  _chunkedData: Record<number, { count: number } | undefined>;
}

/** Resident byte length of a chunk slice. A binary-mode channel always supplies
 * a `Uint8Array`/`ArrayBuffer`, so `byteLength` is the usual path; a string is
 * counted as UTF-16 code units times two (its worst-case heap residency, the
 * same measure the signaling-server queue cap uses) rather than character
 * length, which would undercount multi-byte text and under-enforce the bound. */
function chunkByteLength(data: PeerChunk["data"]): number {
  if (data === undefined) return 0;
  if (typeof data === "string") return data.length * 2;
  return data.byteLength;
}

/** Coerce a frame's bytes to a `Uint8Array` view for the structural scan, without
 * copying. Binary-mode channels always supply a view/buffer; a string (never
 * expected on this path) yields an empty view, which the scan treats as a
 * harmless empty frame. */
function toUint8(data: PeerDataMessage["data"]): Uint8Array {
  if (data === undefined || typeof data === "string") return new Uint8Array(0);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/** A terminal bound-exceeded error, shared by every enforcement point. Kind
 * `protocol`: an over-bound frame is the peer violating the message contract
 * (the same class as core's inbound-buffer overflow), never benign, since every
 * bound sits far above any legitimate frame. It carries no peer-controlled bytes
 * (only the fixed limit), so it needs no redaction. */
function frameBoundError(detail: string): ConnectionError {
  return new ConnectionError(
    `inbound WebRTC frame exceeds its ${detail}`,
    "protocol",
  );
}

/**
 * The delivered-frame half of the inbound byte bound: returns the terminal
 * {@link frameBoundError} if `data` is a binary frame larger than `maxBytes`,
 * otherwise `undefined`. This runs at the stable `data` event -- a backstop, at
 * the public layer, for the reassembly guard at the fragile internal layer: an
 * over-cap `Uint8Array` is refused as delivered regardless of how (or whether)
 * PeerJS chunked it. A parsed object/array returns `undefined` (not cheaply
 * byte-measurable here); the reassembly bounds govern it before delivery and
 * core's count/structure bounds after.
 */
export function checkDeliveredFrameBound(
  data: unknown,
  maxBytes: number = MAX_WEBRTC_FRAME_BYTES,
): ConnectionError | undefined {
  const size =
    ArrayBuffer.isView(data) || data instanceof ArrayBuffer
      ? data.byteLength
      : undefined;
  return size !== undefined && size > maxBytes
    ? frameBoundError(`${maxBytes}-byte size limit`)
    : undefined;
}

/** A forward-only cursor over one BinaryPack buffer; every read throws
 * `RangeError` past the end, which the scan treats as a malformed/truncated
 * frame. */
class ByteCursor {
  private i = 0;

  constructor(private readonly b: Uint8Array) {}

  remaining(): number {
    return this.b.length - this.i;
  }

  u8(): number {
    if (this.i >= this.b.length) throw new RangeError("underrun");
    return this.b[this.i++];
  }

  u16(): number {
    return this.u8() * 0x100 + this.u8();
  }

  u32(): number {
    return (
      this.u8() * 0x1000000 +
      this.u8() * 0x10000 +
      this.u8() * 0x100 +
      this.u8()
    );
  }

  skip(n: number): void {
    if (n > this.remaining()) throw new RangeError("underrun");
    this.i += n;
  }
}

/** One BinaryPack value's contribution to the structural scan: `children` is the
 * number of child values a container declares (0 for a scalar or string), and
 * `weight` is the approximate retained bytes this single value allocates (see
 * {@link WEBRTC_VALUE_WEIGHTS}). A string over the per-string byte cap signals
 * `weight = -1`, the reject sentinel. */
interface ValueHeader {
  children: number;
  weight: number;
}

/** Resident-byte weight of a string of `declaredBytes` wire bytes: a SeqString
 * header plus its UTF-16 characters (see {@link WEBRTC_VALUE_WEIGHTS}). */
function stringWeight(declaredBytes: number): number {
  return (
    WEBRTC_VALUE_WEIGHTS.stringBase +
    WEBRTC_VALUE_WEIGHTS.stringPerByte * declaredBytes
  );
}

/** A string value of `declaredBytes` wire bytes: refused (`weight = -1`) if it
 * exceeds `maxStringBytes`, else its payload skipped and its resident weight
 * charged. Shared by every string marker (`fixstr`/`str16`/`str32`) so the
 * per-string cap is enforced uniformly rather than only on the wide markers --
 * a `fixstr` is at most 15 bytes so the cap cannot fire for it in production, but
 * routing it through here keeps the marker dispatch a single rule instead of one
 * that rests on a "fixstr is always small" assumption. */
function stringValue(
  cursor: ByteCursor,
  declaredBytes: number,
  maxStringBytes: number,
): ValueHeader {
  if (declaredBytes > maxStringBytes) return { children: 0, weight: -1 };
  cursor.skip(declaredBytes);
  return { children: 0, weight: stringWeight(declaredBytes) };
}

const SCALAR: ValueHeader = {
  children: 0,
  weight: WEBRTC_VALUE_WEIGHTS.scalar,
};

/** Reads one BinaryPack value's header at the cursor, skipping a scalar's
 * payload, and returns the value's {@link ValueHeader} (its declared child count
 * and its per-kind retained-byte weight; `weight = -1` for a string whose declared
 * length exceeds `maxStringBytes`). Mirrors `peerjs-js-binarypack`'s
 * `Unpacker.unpack` marker dispatch: a map of K pairs declares 2K children (K keys
 * + K values), each weighted as it is read. A `bin`/`raw` value is charged the
 * scalar slot weight, its payload being ~1x wire and so bounded by the wire-byte
 * cap. An unknown marker yields a scalar weight and 0 children (BinaryPack returns
 * `undefined` for it without consuming a payload). */
function readValueHeader(
  cursor: ByteCursor,
  maxStringBytes: number,
): ValueHeader {
  const type = cursor.u8();
  if (type < 0x80) return SCALAR; // positive fixint
  if ((type ^ 0xe0) < 0x20) return SCALAR; // negative fixint
  if ((type ^ 0xa0) <= 0x0f) {
    cursor.skip(type ^ 0xa0); // fixraw (binary), payload bounded by the wire cap
    return SCALAR;
  }
  if ((type ^ 0xb0) <= 0x0f)
    return stringValue(cursor, type ^ 0xb0, maxStringBytes); // fixstr (<= 15 bytes)
  if ((type ^ 0x90) <= 0x0f)
    return { children: type ^ 0x90, weight: WEBRTC_VALUE_WEIGHTS.array }; // fixarray
  if ((type ^ 0x80) <= 0x0f)
    return { children: (type ^ 0x80) * 2, weight: WEBRTC_VALUE_WEIGHTS.object }; // fixmap
  switch (type) {
    case 0xc0: // null
    case 0xc1: // undefined
    case 0xc2: // false
    case 0xc3: // true
    case 0xd4: // unused
    case 0xd5:
    case 0xd6:
    case 0xd7:
      return SCALAR;
    case 0xcc: // uint8
    case 0xd0: // int8
      cursor.skip(1);
      return SCALAR;
    case 0xcd: // uint16
    case 0xd1: // int16
      cursor.skip(2);
      return SCALAR;
    case 0xca: // float
    case 0xce: // uint32
    case 0xd2: // int32
      cursor.skip(4);
      return SCALAR;
    case 0xcb: // double
    case 0xcf: // uint64
    case 0xd3: // int64
      cursor.skip(8);
      return SCALAR;
    case 0xda: // raw16
      cursor.skip(cursor.u16()); // unpack_raw copies `size` bytes (~1x wire),
      return SCALAR; // bounded by the wire-byte cap; charged the scalar slot only
    case 0xdb: // raw32
      cursor.skip(cursor.u32());
      return SCALAR;
    case 0xd8:
      // str16: unpack_string builds a JS string of the declared length, ~2x its
      // wire size and with a large transient cons-string tree, so the per-string
      // byte cap bounds the build (legitimate PSI frames carry only short
      // strings) while the weight bounds its resident size.
      return stringValue(cursor, cursor.u16(), maxStringBytes);
    case 0xd9: // str32
      return stringValue(cursor, cursor.u32(), maxStringBytes);
    case 0xdc: // array16
      return { children: cursor.u16(), weight: WEBRTC_VALUE_WEIGHTS.array };
    case 0xdd: // array32
      return { children: cursor.u32(), weight: WEBRTC_VALUE_WEIGHTS.array };
    case 0xde: // map16
      return {
        children: cursor.u16() * 2,
        weight: WEBRTC_VALUE_WEIGHTS.object,
      };
    case 0xdf: // map32
      return {
        children: cursor.u32() * 2,
        weight: WEBRTC_VALUE_WEIGHTS.object,
      };
    default:
      return SCALAR;
  }
}

/**
 * Whether the BinaryPack value in `buf` would deserialize to a structure whose
 * approximate retained-byte cost exceeds `maxStructureBytes`, nest deeper than
 * `maxDepth`, contain a string longer than `maxStringBytes`, or declare any
 * container with more elements than the bytes that follow it can encode. Walks the
 * structure reading only container headers and scalar lengths -- never
 * materializing the payload -- and charges each declared value its per-kind weight
 * (see {@link WEBRTC_VALUE_WEIGHTS}), rejecting as soon as the running cost
 * breaches the budget, a container over-declares, or a string over-declares, so an
 * over-budget frame is caught before `unpack` allocates (the empty-object/array
 * amplification, the `new Array(N)`-from-a-tiny-header case where each declared
 * element must be backed by at least one wire byte, and the giant-string case
 * where `unpack_string` builds a JS string far larger than its slot). A read past
 * the end (a malformed/truncated frame) returns `false`: every value it passed was
 * within both the byte budget and the bytes-that-follow check, so the structure it
 * commits `unpack` to is already bounded, and PeerJS's own unpack handles the
 * malformation downstream.
 */
export function structureOverBudget(
  buf: Uint8Array,
  maxStructureBytes: number,
  maxDepth: number,
  maxStringBytes: number = MAX_WEBRTC_STRING_BYTES,
): boolean {
  const cursor = new ByteCursor(buf);
  // remaining[d] = child values still to read at nesting level d; one root value.
  const remaining: Array<number> = [1];
  // Running sum of the approximate retained bytes the structure has committed
  // `unpack` to allocate (every value's per-kind weight: the root plus every
  // container's children).
  let cost = 0;
  try {
    while (remaining.length > 0) {
      const top = remaining.length - 1;
      if (remaining[top] === 0) {
        remaining.pop();
        continue;
      }
      remaining[top]--;
      const { children, weight } = readValueHeader(cursor, maxStringBytes);
      // A string over the per-string byte cap (`weight = -1`) is refused outright.
      if (weight < 0) return true;
      cost += weight;
      if (cost > maxStructureBytes) return true;
      if (children > 0) {
        // Each declared element needs at least one byte to encode, so a container
        // claiming more elements than the bytes that follow is a zero-fill lie.
        if (children > cursor.remaining()) return true;
        if (remaining.length >= maxDepth) return true;
        remaining.push(children);
      }
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Asserts `conn` exposes the PeerJS internals {@link boundChunkReassembly} wraps.
 * Encodes the dependency premise as a runtime check, not a comment: a `peerjs`
 * upgrade that renames or restructures the chunk reassembly or the unpack
 * chokepoint must fail loud (the live browser exchange test installs the guard on
 * every exchange) rather than silently run with no inbound bound. Called up front
 * in `openPeerMessageConnection`, before any listener is attached, so a broken
 * premise fails cleanly with nothing to tear down.
 */
export function assertChunkReassemblySupported(conn: DataConnection): void {
  const probe = conn as unknown as {
    _handleChunk?: unknown;
    _handleDataMessage?: unknown;
    _chunkedData?: unknown;
  };
  if (
    typeof probe._handleChunk !== "function" ||
    typeof probe._handleDataMessage !== "function" ||
    !probe._chunkedData ||
    typeof probe._chunkedData !== "object"
  ) {
    throw new Error(
      "PeerJS data connection does not expose the expected reassembly/unpack " +
        "internals (_handleChunk/_handleDataMessage/_chunkedData); the inbound " +
        "frame bound cannot be installed. Re-verify against the installed peerjs " +
        "version.",
    );
  }
}

/**
 * Wraps `conn`'s PeerJS reassembly and unpack so an inbound frame cannot exhaust
 * memory, the primary inbound bound for the WebRTC transport. PeerJS reassembles
 * a chunked frame in `_handleChunk` (accumulating slices keyed by message id) and
 * `unpack`s every frame -- unchunked, or the reassembled buffer on completion --
 * in `_handleDataMessage`, with no cap on any of total wire bytes, deserialized
 * structure size, retained chunk count, or concurrent reassemblies, and no
 * eviction of a never-completed partial. This wrap adds all of those before
 * delegating, each fail-closed via `fail` (mirroring the file-sync frame-size
 * control's intent), so the offending chunk is never stored and the offending
 * frame is never unpacked:
 *
 * - Wire bytes across all in-flight reassemblies are bounded by `maxFrameBytes`
 *   (in `_handleChunk`).
 * - Retained chunks per reassembly are bounded by `maxChunks`, each charged at
 *   least `minChunkResidentBytes` against the byte cap (a chunk is a retained
 *   `Uint8Array` the payload-byte count undercounts).
 * - Concurrent incomplete reassemblies are bounded by `maxConcurrentReassemblies`;
 *   a new id beyond the cap evicts the oldest partial. Eviction is silent and
 *   non-fatal: the lockstep protocol never has a legitimate second partial, so it
 *   only drops adversarial data, and logging per eviction would itself be a
 *   spray-amplified log-flood vector.
 * - The deserialized structure's approximate retained-byte cost is bounded by
 *   `maxStructureBytes` (in `_handleDataMessage`, the unpack chokepoint, which both
 *   an unchunked frame and the reassembled-completion path flow through): the
 *   frame's BinaryPack structure is scanned and each declared value charged its
 *   per-kind weight before PeerJS unpacks it, since `unpack` can allocate far more
 *   than the wire bytes.
 *
 * @param conn   The PeerJS data connection (open or not yet open).
 * @param fail   Latches a terminal failure (the connection's `controls.fail`).
 * @param options  Per-bound overrides defaulting to the fixed module constants;
 *                 set only by tests, never an operator-facing knob.
 * @throws If the PeerJS internals are not as expected (a broken upgrade premise).
 */
export function boundChunkReassembly(
  conn: DataConnection,
  fail: (error: ConnectionError) => void,
  options?: {
    maxFrameBytes?: number;
    maxConcurrentReassemblies?: number;
    maxStructureBytes?: number;
    maxReassemblyDepth?: number;
    maxChunks?: number;
    minChunkResidentBytes?: number;
    maxStringBytes?: number;
  },
): void {
  const maxFrameBytes = options?.maxFrameBytes ?? MAX_WEBRTC_FRAME_BYTES;
  const maxConcurrent =
    options?.maxConcurrentReassemblies ?? MAX_CONCURRENT_REASSEMBLIES;
  const maxStructureBytes =
    options?.maxStructureBytes ?? MAX_WEBRTC_FRAME_STRUCTURE_BYTES;
  const maxDepth = options?.maxReassemblyDepth ?? MAX_WEBRTC_REASSEMBLY_DEPTH;
  const maxChunks = options?.maxChunks ?? MAX_CHUNKS_PER_REASSEMBLY;
  const minChunkBytes =
    options?.minChunkResidentBytes ?? MIN_CHUNK_RESIDENT_BYTES;
  const maxStringBytes = options?.maxStringBytes ?? MAX_WEBRTC_STRING_BYTES;

  assertChunkReassemblySupported(conn);
  const internals = conn as unknown as ChunkedDataConnection;
  const originalHandleChunk = internals._handleChunk.bind(internals);
  const originalHandleDataMessage =
    internals._handleDataMessage.bind(internals);

  // Per-id accumulated state, in arrival order (Map preserves insertion order,
  // so the first key is the oldest partial to evict).
  const inFlight = new Map<number, { bytes: number; chunks: number }>();
  let bytesInFlight = 0;
  // Latched once a bound fails the connection: it is terminal, so every later
  // chunk and frame is dropped without bookkeeping, reassembly, or unpack.
  let failed = false;

  const failClosed = (error: ConnectionError): void => {
    failed = true;
    fail(error);
  };

  const evictOldest = (): void => {
    const oldest = inFlight.keys().next().value;
    if (oldest === undefined) return;
    bytesInFlight -= inFlight.get(oldest)?.bytes ?? 0;
    inFlight.delete(oldest);
    delete internals._chunkedData[oldest];
  };

  // Bounds the chunk ACCUMULATION (before completion): wire bytes, retained chunk
  // count, and concurrent reassemblies, evicting the oldest partial past the cap.
  internals._handleChunk = (chunk: PeerChunk): void => {
    if (failed) return;
    const id = chunk.__peerData;
    const bytes = Math.max(chunkByteLength(chunk.data), minChunkBytes);
    const entry = inFlight.get(id);

    if (entry === undefined) {
      while (inFlight.size >= maxConcurrent) evictOldest();
    }
    if (bytesInFlight + bytes > maxFrameBytes) {
      failClosed(frameBoundError(`${maxFrameBytes}-byte size limit`));
      return;
    }
    const chunks = (entry?.chunks ?? 0) + 1;
    if (chunks > maxChunks) {
      failClosed(frameBoundError(`${maxChunks}-chunk reassembly limit`));
      return;
    }

    bytesInFlight += bytes;
    inFlight.set(id, { bytes: (entry?.bytes ?? 0) + bytes, chunks });

    originalHandleChunk(chunk);

    // PeerJS deletes the `_chunkedData` entry when the frame completes; mirror
    // that here so a completed frame's bytes are released from the running total.
    if (internals._chunkedData[id] === undefined) {
      bytesInFlight -= inFlight.get(id)?.bytes ?? 0;
      inFlight.delete(id);
    }
  };

  // Bounds the DESERIALIZED structure at the unpack chokepoint, which both an
  // unchunked frame (direct call) and a completed reassembly (recursive call from
  // `_handleChunk`) flow through. Scanning here, before the original unpacks,
  // covers a tiny unchunked frame that never reaches `_handleChunk` at all.
  internals._handleDataMessage = (message: PeerDataMessage): void => {
    if (failed) return;
    if (
      structureOverBudget(
        toUint8(message.data),
        maxStructureBytes,
        maxDepth,
        maxStringBytes,
      )
    ) {
      failClosed(frameBoundError(`${maxStructureBytes}-byte structure limit`));
      return;
    }
    originalHandleDataMessage(message);
  };
}
