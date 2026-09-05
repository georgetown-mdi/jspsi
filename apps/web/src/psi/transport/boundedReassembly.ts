// The PeerJS-coupled half of the WebRTC data-channel inbound bound
// (docs/spec/CHANNEL_SECURITY.md): it wraps this connection class's reassembly
// and unpack internals to enforce the bounds at the points PeerJS leaves
// unbounded. The transport-agnostic half -- the fixed bound constants and the
// BinaryPack structural pre-scan they parameterize -- lives in `@psilink/core`
// (connection/binaryPackBounds.ts), so every WebRTC transport enforces one
// implementation of them.

import {
  ConnectionError,
  MAX_CHUNKS_PER_REASSEMBLY,
  MAX_CONCURRENT_REASSEMBLIES,
  MAX_WEBRTC_FRAME_BYTES,
  MAX_WEBRTC_FRAME_STRUCTURE_BYTES,
  MAX_WEBRTC_REASSEMBLY_DEPTH,
  MAX_WEBRTC_STRING_BYTES,
  MIN_CHUNK_RESIDENT_BYTES,
  describeFrameStructureRefusal,
  scanFrameStructure,
} from "@psilink/core";

import type { DataConnection } from "peerjs";

/**
 * One slice of a chunked PeerJS frame, as it reaches the connection's
 * `_handleChunk`. Shape pinned from the PeerJS chunker (`__peerData` is the
 * message id shared by every chunk of one frame, `n` the chunk index, `total`
 * the chunk count, `data` the slice bytes). An assumption this guard rests
 * on; see {@link boundChunkReassembly}.
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
 * The PeerJS `DataConnection` internals this guard wraps. PeerJS reassembles
 * a chunked binary frame in `_handleChunk` (accumulating slices into
 * `_chunkedData` keyed by message id, deleting the entry on completion), and
 * `unpack`s every frame -- unchunked, or the reassembled buffer on completion
 * -- in `_handleDataMessage`. None is part of the public `DataConnection`
 * type, so this is a documented dependency assumption;
 * {@link assertChunkReassemblySupported} checks all three exist, so a
 * `peerjs` upgrade that renames or restructures them fails loud.
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

/** A terminal refusal, shared by every enforcement point: `predicate` says what
 * the frame did, so the message names the rule that fired rather than one
 * standing in for the rest. Kind `protocol`: a refused frame is the peer
 * violating the message contract (the same class as core's inbound-buffer
 * overflow), never benign, since every bound sits far above any legitimate frame.
 * It holds no peer-controlled bytes (only the fixed limits), so it needs no
 * redaction. */
function frameRefusalError(predicate: string): ConnectionError {
  return new ConnectionError(`inbound WebRTC frame ${predicate}`, "protocol");
}

/**
 * The delivered-frame half of the inbound byte bound: returns the terminal
 * {@link frameRefusalError} if `data` is a binary frame larger than
 * `maxBytes`, otherwise `undefined`. Runs at the stable `data` event -- a
 * safety check, at the public layer, for the reassembly guard at the fragile
 * internal layer, refusing an over-cap `Uint8Array` regardless of how PeerJS
 * chunked it. A parsed object/array returns `undefined`: the reassembly
 * bounds govern it before delivery and core's count/structure bounds after.
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
    ? frameRefusalError(`exceeds its ${maxBytes}-byte size limit`)
    : undefined;
}

/**
 * Asserts `conn` exposes the PeerJS internals {@link boundChunkReassembly}
 * wraps. Encodes the dependency assumption as a runtime check, not a
 * comment: a `peerjs` upgrade that renames or restructures the chunk
 * reassembly or the unpack chokepoint must fail loud (the live browser
 * exchange test installs the guard on every exchange) rather than silently
 * run with no inbound bound. Called before any listener is attached, so a
 * broken assumption fails cleanly with nothing to tear down.
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
 * Wraps `conn`'s PeerJS reassembly and unpack so an inbound frame cannot
 * exhaust memory, the primary inbound bound for the WebRTC transport. PeerJS
 * itself caps none of wire bytes, deserialized structure size, retained
 * chunk count, or concurrent reassemblies, and evicts no never-completed
 * partial; this wrap adds all of those before delegating, each fail-closed
 * via `fail`, so the offending chunk is never stored and the offending frame
 * is never unpacked:
 *
 * - Wire bytes across all in-flight reassemblies: `maxFrameBytes` (in
 *   `_handleChunk`).
 * - Retained chunks per reassembly: `maxChunks`, each charged at least
 *   `minChunkResidentBytes` against the byte cap.
 * - Concurrent incomplete reassemblies: `maxConcurrentReassemblies`; a new id
 *   beyond the cap silently evicts the oldest partial (the lockstep protocol
 *   never has a legitimate second partial, so eviction only drops
 *   adversarial data).
 * - Deserialized structure's approximate retained-byte cost:
 *   `maxStructureBytes`, in `_handleDataMessage` (both an unchunked frame and
 *   a completed reassembly flow through it) -- the frame's BinaryPack
 *   structure is scanned and each value charged its per-kind weight before
 *   PeerJS unpacks it, since `unpack` can allocate far more than the wire
 *   bytes. The same walk enforces nesting depth, the per-string cap, the
 *   byte-backed-elements check and the map-key rule.
 *
 * @param conn   The PeerJS data connection (open or not yet open).
 * @param fail   Latches a terminal failure (the connection's `controls.fail`).
 * @param options  Per-bound overrides defaulting to the fixed core constants;
 *                 set only by tests, never an operator-facing setting.
 * @throws If the PeerJS internals are not as expected (a broken upgrade
 *   assumption).
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
      failClosed(
        frameRefusalError(`exceeds its ${maxFrameBytes}-byte size limit`),
      );
      return;
    }
    const chunks = (entry?.chunks ?? 0) + 1;
    if (chunks > maxChunks) {
      failClosed(
        frameRefusalError(`exceeds its ${maxChunks}-chunk reassembly limit`),
      );
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
    const refusal = scanFrameStructure(
      toUint8(message.data),
      maxStructureBytes,
      maxDepth,
      maxStringBytes,
    );
    if (refusal !== undefined) {
      failClosed(frameRefusalError(describeFrameStructureRefusal(refusal)));
      return;
    }
    originalHandleDataMessage(message);
  };
}
