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
 * unpack to is bounded separately by {@link MAX_WEBRTC_FRAME_NODES}, because
 * BinaryPack `unpack` can allocate far more than the wire size. Fixed, not
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
 * Maximum number of JavaScript values a single inbound frame may deserialize to.
 * The {@link MAX_WEBRTC_FRAME_BYTES} cap bounds the *wire* bytes, but PeerJS
 * (BinaryPack) `unpack`s a completed frame into a JS structure *synchronously,
 * before delivery and before any schema validation*, and that structure can be
 * far larger than the wire: BinaryPack encodes an empty object or array in one
 * byte but `unpack` allocates a real JS value per element (measured ~64 bytes per
 * empty object, ~40 per empty array, ~8 per integer). So a ~256 MiB wire frame of
 * such elements -- an in-protocol shape, since the association-table and
 * mapped-element frames are arrays of numbers/objects -- would deserialize to
 * many GiB. A structural pre-scan (see {@link boundChunkReassembly}) rejects a
 * frame whose declared container element counts exceed this bound *before* the
 * unpack allocates, fail-closed.
 *
 * Value: 33,554,432 (2^25), derived from the largest legitimate frame. That is
 * the mapped-element frame -- `Array<{theirIndex, iteration}>`, one entry per
 * matched record -- which deserializes to ~5 values per record (the outer array
 * slot, the object, its two keys and two values). At the set-size ceiling the
 * 256 MiB byte cap implies (~4 million elements), that is ~21 million values;
 * 2^25 leaves headroom so no exchange the byte cap admits is rejected on a
 * downstream frame. Residual: the worst-case attacker heap is bounded to roughly
 * this count times the ~64-byte empty-object cost (~2 GiB) -- fixed, and far
 * below the ~16 GiB the byte cap alone permitted; tightening it further would
 * require lowering the set-size byte cap. Fixed, not configurable.
 */
export const MAX_WEBRTC_FRAME_NODES = 33_554_432;

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
 * Value: 131,072 (2^17), ~8x the ~16,100 chunks a 256 MiB frame produces at
 * PeerJS's ~16 KiB chunk MTU, so it never rejects a legitimate frame while
 * bounding a tiny-chunk flood. Fixed, not configurable.
 */
export const MAX_CHUNKS_PER_REASSEMBLY = 131_072;

/** Per-chunk retained overhead (a `Uint8Array` plus its slot, measured ~232
 * bytes even for a one-byte slice), the floor each chunk is charged against the
 * byte cap so a tiny-chunk flood is bounded by true memory; see
 * {@link MAX_CHUNKS_PER_REASSEMBLY}. */
export const MIN_CHUNK_RESIDENT_BYTES = 256;

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

/** PeerJS's per-message reassembly state: slices keyed by chunk index, a running
 * count, and the declared chunk total (set from the first chunk). */
interface ChunkInfo {
  data: Array<Uint8Array | undefined>;
  count: number;
  total: number;
}

/**
 * The PeerJS `DataConnection` internals this guard wraps. PeerJS reassembles a
 * chunked binary frame in `_handleChunk`, accumulating slices into `_chunkedData`
 * keyed by message id and deleting the entry once the frame completes. Neither
 * field is part of the public `DataConnection` type, so this is a documented
 * dependency premise (the binary/chunked connection class is the one
 * `peer.connect`/an incoming connection uses by default; see the `peerjs`
 * bundler). {@link assertChunkReassemblySupported} checks both exist, so a
 * `peerjs` upgrade that renames or restructures them fails loud rather than
 * silently dropping the bound.
 */
interface ChunkedDataConnection {
  _handleChunk: (chunk: PeerChunk) => void;
  _chunkedData: Record<number, ChunkInfo | undefined>;
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

/** Coerce a chunk slice to a `Uint8Array` view for the structural scan, without
 * copying where possible. Binary-mode channels always supply a view/buffer; a
 * string (never expected on this path) yields an empty view, which the scan
 * treats as a harmless gap. */
function toUint8(data: PeerChunk["data"]): Uint8Array {
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
 * the public layer, for the {@link boundChunkReassembly} guard at the fragile
 * internal layer: an over-cap `Uint8Array` is refused as delivered regardless of
 * how (or whether) PeerJS chunked it.
 *
 * A parsed object/array returns `undefined` (not cheaply byte-measurable here);
 * those frames are governed by the reassembly bounds before delivery and by
 * core's count/structure bounds after, and a large set arrives as the binary
 * `Uint8Array` this does measure.
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

/** A cursor over an ordered list of byte slices, presenting them as one logical
 * big-endian stream without concatenating (so scanning the large binary set
 * frame skips its payload in O(slices), never materializing a second copy).
 * Every read throws `RangeError` past the end, which the scan treats as a
 * malformed/truncated frame. */
class SliceCursor {
  private si = 0;
  private off = 0;

  constructor(private readonly slices: ReadonlyArray<Uint8Array>) {}

  private seek(): void {
    while (
      this.si < this.slices.length &&
      this.off >= this.slices[this.si].length
    ) {
      this.off = 0;
      this.si++;
    }
  }

  u8(): number {
    this.seek();
    if (this.si >= this.slices.length) throw new RangeError("underrun");
    return this.slices[this.si][this.off++];
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
    while (n > 0) {
      this.seek();
      if (this.si >= this.slices.length) throw new RangeError("underrun");
      const avail = this.slices[this.si].length - this.off;
      if (n < avail) {
        this.off += n;
        return;
      }
      n -= avail;
      this.off = 0;
      this.si++;
    }
  }
}

/** Reads one BinaryPack value's header at the cursor, skipping a scalar's
 * payload, and returns the number of child values a container declares (0 for a
 * scalar). Mirrors `peerjs-js-binarypack`'s `Unpacker.unpack` marker dispatch:
 * a map of K pairs declares 2K children (K keys + K values). An unknown marker
 * yields 0 (BinaryPack returns `undefined` for it without consuming a payload). */
function readValueChildren(cursor: SliceCursor): number {
  const type = cursor.u8();
  if (type < 0x80) return 0; // positive fixint
  if ((type ^ 0xe0) < 0x20) return 0; // negative fixint
  if ((type ^ 0xa0) <= 0x0f) {
    cursor.skip(type ^ 0xa0); // fixraw
    return 0;
  }
  if ((type ^ 0xb0) <= 0x0f) {
    cursor.skip(type ^ 0xb0); // fixstr
    return 0;
  }
  if ((type ^ 0x90) <= 0x0f) return type ^ 0x90; // fixarray
  if ((type ^ 0x80) <= 0x0f) return (type ^ 0x80) * 2; // fixmap
  switch (type) {
    case 0xc0: // null
    case 0xc1: // undefined
    case 0xc2: // false
    case 0xc3: // true
    case 0xd4: // unused
    case 0xd5:
    case 0xd6:
    case 0xd7:
      return 0;
    case 0xcc: // uint8
    case 0xd0: // int8
      cursor.skip(1);
      return 0;
    case 0xcd: // uint16
    case 0xd1: // int16
      cursor.skip(2);
      return 0;
    case 0xca: // float
    case 0xce: // uint32
    case 0xd2: // int32
      cursor.skip(4);
      return 0;
    case 0xcb: // double
    case 0xcf: // uint64
    case 0xd3: // int64
      cursor.skip(8);
      return 0;
    case 0xd8: // str16
    case 0xda: // raw16
      cursor.skip(cursor.u16());
      return 0;
    case 0xd9: // str32
    case 0xdb: // raw32
      cursor.skip(cursor.u32());
      return 0;
    case 0xdc: // array16
      return cursor.u16();
    case 0xdd: // array32
      return cursor.u32();
    case 0xde: // map16
      return cursor.u16() * 2;
    case 0xdf: // map32
      return cursor.u32() * 2;
    default:
      return 0;
  }
}

/** Whether the BinaryPack value spanning `slices` would deserialize to more than
 * `maxNodes` values, or nest deeper than `maxDepth`. Walks the structure reading
 * only container headers and scalar lengths -- never materializing the payload --
 * and rejects as soon as a declared container size would breach the budget, so an
 * over-cap frame is caught at its header before `unpack` allocates. A read past
 * the end (a malformed or truncated frame) returns `false`: it passed every
 * declared-size check, so it cannot be an amplification, and PeerJS's own unpack
 * handles the malformation downstream. */
function structureOverBudget(
  slices: ReadonlyArray<Uint8Array>,
  maxNodes: number,
  maxDepth: number,
): boolean {
  const cursor = new SliceCursor(slices);
  // remaining[d] = child values still to read at nesting level d; one root value.
  const remaining: Array<number> = [1];
  let nodes = 0;
  try {
    while (remaining.length > 0) {
      const top = remaining.length - 1;
      if (remaining[top] === 0) {
        remaining.pop();
        continue;
      }
      remaining[top]--;
      nodes++;
      if (nodes > maxNodes) return true;
      const children = readValueChildren(cursor);
      if (children > 0) {
        if (remaining.length >= maxDepth) return true;
        if (nodes + children > maxNodes) return true;
        remaining.push(children);
      }
    }
  } catch {
    return false;
  }
  return false;
}

/** Reconstruct a completed frame's slices in chunk-index order from PeerJS's
 * accumulated state plus the completing chunk (not yet stored). Returns
 * `undefined` if any index is missing (a duplicate-index chunk inflated the count
 * without filling every slot -- a malformed frame PeerJS will itself error on),
 * in which case the caller skips the scan and delegates. */
function orderedSlices(
  prev: ChunkInfo,
  chunk: PeerChunk,
): ReadonlyArray<Uint8Array> | undefined {
  const slices: Array<Uint8Array> = new Array<Uint8Array>(prev.total);
  for (let k = 0; k < prev.total; k++) {
    if (k === chunk.n) {
      slices[k] = toUint8(chunk.data);
      continue;
    }
    const stored = prev.data[k];
    if (stored === undefined) return undefined;
    slices[k] = stored;
  }
  return slices;
}

/**
 * Asserts `conn` exposes the PeerJS chunk-reassembly internals
 * {@link boundChunkReassembly} wraps. Encodes the dependency premise as a runtime
 * check, not a comment: a `peerjs` upgrade that renames or restructures the chunk
 * reassembly must fail loud (the live browser exchange test installs the guard on
 * every exchange) rather than silently run with no inbound bound. Called up front
 * in `openPeerMessageConnection`, before any listener is attached, so a broken
 * premise fails cleanly with nothing to tear down.
 */
export function assertChunkReassemblySupported(conn: DataConnection): void {
  const probe = conn as unknown as {
    _handleChunk?: unknown;
    _chunkedData?: unknown;
  };
  if (
    typeof probe._handleChunk !== "function" ||
    !probe._chunkedData ||
    typeof probe._chunkedData !== "object"
  ) {
    throw new Error(
      "PeerJS data connection does not expose the expected chunk-reassembly " +
        "internals (_handleChunk/_chunkedData); the inbound frame bound cannot " +
        "be installed. Re-verify against the installed peerjs version.",
    );
  }
}

/**
 * Wraps `conn`'s PeerJS chunk reassembly so it cannot exhaust memory, the
 * primary inbound bound for the WebRTC transport. PeerJS reassembles a chunked
 * frame in `_handleChunk`, accumulating slices keyed by message id and then
 * `unpack`ing the completed buffer into a JS structure -- with no cap on total
 * wire bytes, on the deserialized value count, on retained chunk count, on
 * concurrent reassemblies, and no eviction of a never-completed partial. This
 * wrap adds all of those before delegating to the original, each fail-closed via
 * `fail` (mirroring the file-sync frame-size control's intent), so the offending
 * chunk is never stored or unpacked:
 *
 * - Wire bytes across all in-flight reassemblies are bounded by `maxFrameBytes`.
 * - The deserialized value count is bounded by `maxFrameNodes`: on the completing
 *   chunk, the reassembled BinaryPack structure is scanned (see
 *   {@link structureOverBudget}) before PeerJS unpacks it, since `unpack` can
 *   allocate far more than the wire bytes.
 * - Retained chunks per reassembly are bounded by `maxChunks` (each chunk is a
 *   retained `Uint8Array` the byte cap undercounts).
 * - Concurrent incomplete reassemblies are bounded by `maxConcurrentReassemblies`;
 *   a new id beyond the cap evicts the oldest partial. Eviction is silent and
 *   non-fatal: the lockstep protocol never has a legitimate second partial, so it
 *   only drops adversarial data, and logging per eviction would itself be a
 *   spray-amplified log-flood vector.
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
    maxFrameNodes?: number;
    maxReassemblyDepth?: number;
    maxChunks?: number;
    minChunkResidentBytes?: number;
  },
): void {
  const maxFrameBytes = options?.maxFrameBytes ?? MAX_WEBRTC_FRAME_BYTES;
  const maxConcurrent =
    options?.maxConcurrentReassemblies ?? MAX_CONCURRENT_REASSEMBLIES;
  const maxFrameNodes = options?.maxFrameNodes ?? MAX_WEBRTC_FRAME_NODES;
  const maxDepth = options?.maxReassemblyDepth ?? MAX_WEBRTC_REASSEMBLY_DEPTH;
  const maxChunks = options?.maxChunks ?? MAX_CHUNKS_PER_REASSEMBLY;
  // Charge each chunk at least its retained per-chunk overhead, so a flood of
  // tiny chunks is bounded by true memory rather than payload bytes; legitimate
  // chunks (~16 KiB) far exceed this, so it never affects them.
  const minChunkBytes =
    options?.minChunkResidentBytes ?? MIN_CHUNK_RESIDENT_BYTES;

  assertChunkReassemblySupported(conn);
  const internals = conn as unknown as ChunkedDataConnection;
  const original = internals._handleChunk.bind(internals);

  // Per-id accumulated state, in arrival order (Map preserves insertion order,
  // so the first key is the oldest partial to evict).
  const inFlight = new Map<number, { bytes: number; chunks: number }>();
  let bytesInFlight = 0;
  // Latched once a bound fails the connection: it is terminal, so every later
  // chunk is dropped without bookkeeping or reaching the original handler.
  let failed = false;

  const evictOldest = (): void => {
    const oldest = inFlight.keys().next().value;
    if (oldest === undefined) return;
    bytesInFlight -= inFlight.get(oldest)?.bytes ?? 0;
    inFlight.delete(oldest);
    delete internals._chunkedData[oldest];
  };

  const failClosed = (error: ConnectionError): void => {
    failed = true;
    fail(error);
  };

  internals._handleChunk = (chunk: PeerChunk): void => {
    if (failed) return;
    const id = chunk.__peerData;
    const bytes = Math.max(chunkByteLength(chunk.data), minChunkBytes);
    const entry = inFlight.get(id);

    // A frame's first chunk starts a new reassembly: enforce the concurrent-count
    // cap first, evicting the oldest partial to make room.
    if (entry === undefined) {
      while (inFlight.size >= maxConcurrent) evictOldest();
    }

    // Wire-byte cap across every in-flight reassembly.
    if (bytesInFlight + bytes > maxFrameBytes) {
      failClosed(frameBoundError(`${maxFrameBytes}-byte size limit`));
      return;
    }
    // Per-reassembly chunk-count cap (retained chunk overhead).
    const chunks = (entry?.chunks ?? 0) + 1;
    if (chunks > maxChunks) {
      failClosed(frameBoundError(`${maxChunks}-chunk reassembly limit`));
      return;
    }
    // Deserialized value-count cap: scan the completed BinaryPack structure
    // before PeerJS unpacks it (which can allocate far more than the wire bytes).
    const prev = internals._chunkedData[id];
    if (prev !== undefined && prev.count + 1 === prev.total) {
      const slices = orderedSlices(prev, chunk);
      if (
        slices !== undefined &&
        structureOverBudget(slices, maxFrameNodes, maxDepth)
      ) {
        failClosed(frameBoundError(`${maxFrameNodes}-value structure limit`));
        return;
      }
    }

    bytesInFlight += bytes;
    inFlight.set(id, { bytes: (entry?.bytes ?? 0) + bytes, chunks });

    original(chunk);

    // PeerJS deletes the `_chunkedData` entry when the frame completes; mirror
    // that here so a completed frame's bytes are released from the running total.
    if (internals._chunkedData[id] === undefined) {
      bytesInFlight -= inFlight.get(id)?.bytes ?? 0;
      inFlight.delete(id);
    }
  };
}
