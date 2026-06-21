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
 * ceiling anchored to Node's `MAX_STRING_LENGTH`, derived so it never rejects a
 * frame that JSON-text path could otherwise process -- this is a browser-tab
 * *memory envelope*, in the spirit of the directory-listing cap: set above the
 * realistic largest legitimate PSI set frame and below an allocation that would
 * crash the tab. The largest legitimate inbound frame is one party's full
 * encrypted set sent as raw elliptic-curve points (~64 bytes/element; see
 * docs/spec/PROTOCOL.md), carried as a single binary `Uint8Array` -- with no
 * base64url 4/3 inflation, since the data channel is binary, unlike the
 * file-sync JSON-text wire. The web upload cap is 100 MiB of CSV
 * (`MAX_CSV_FILE_BYTES`), which at realistic record sizes (tens of bytes/row)
 * yields at most a few million unique key values, so a few-million-element set
 * frame is tens to low-hundreds of MiB; 256 MiB is ~4 million elements,
 * comfortably above that while half the file-sync 512 MiB cap in deference to
 * the browser tab's smaller heap budget (a near-cap frame's reassembly transient
 * -- accumulated chunks, the concatenated buffer, and the unpacked array -- is
 * several hundred MiB even at this value). A set larger than this would need a
 * pathological sub-25-byte-per-row CSV and is in any case beyond what an
 * in-browser WASM PSI computation can carry. The bound is a fixed constant, not
 * an operator-configurable option, for the same reason as every other transport
 * memory bound: a configurable cap risks being raised high enough to reintroduce
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
 * {@link boundChunkReassembly}), which is what bounds a flood of never-completed
 * partials from distinct message ids -- the case PeerJS leaves unbounded, since
 * it retains a partial keyed by message id indefinitely and never evicts one.
 * The {@link MAX_WEBRTC_FRAME_BYTES} running-total bound is what caps the
 * reassembly *data* memory; this count cap bounds the *number* of retained
 * partials (and thus their bookkeeping overhead), so the two compose to a fixed
 * memory ceiling regardless of how many distinct ids a peer sprays. Fixed, not
 * configurable, for the same reason as the byte bound.
 */
export const MAX_CONCURRENT_REASSEMBLIES = 8;

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
  data: { byteLength?: number; length?: number } | undefined;
}

/**
 * The PeerJS `DataConnection` internals this guard wraps. PeerJS reassembles a
 * chunked binary frame in `_handleChunk`, accumulating slices into
 * `_chunkedData` keyed by message id and deleting the entry once the frame
 * completes. Neither field is part of the public `DataConnection` type, so this
 * is a documented dependency premise (the binary/chunked connection class is the
 * one `peer.connect`/an incoming connection uses by default; see the `peerjs`
 * bundler). {@link boundChunkReassembly} asserts both exist at install time, so a
 * `peerjs` upgrade that renames or restructures them fails loud (the live
 * browser exchange test installs this guard) rather than silently dropping the
 * bound.
 */
interface ChunkedDataConnection {
  _handleChunk: (chunk: PeerChunk) => void;
  _chunkedData: Record<number, unknown>;
}

/** Byte length of a chunk slice, tolerant of a `Uint8Array`/`ArrayBuffer` or a
 * length-bearing view; `0` if unmeasurable (never expected, fails safe low). */
function chunkByteLength(data: PeerChunk["data"]): number {
  if (data === undefined) return 0;
  if (typeof data.byteLength === "number") return data.byteLength;
  if (typeof data.length === "number") return data.length;
  return 0;
}

/** The terminal over-cap error, shared by both enforcement points. Kind
 * `protocol`: an over-cap frame is the peer violating the message contract (the
 * same class as core's inbound-buffer overflow), never a benign condition, since
 * the cap sits far above any legitimate frame. It carries no peer-controlled
 * bytes (only the fixed cap), so it needs no redaction. */
function oversizedFrameError(maxBytes: number): ConnectionError {
  return new ConnectionError(
    `inbound WebRTC frame exceeds the ${maxBytes}-byte maximum`,
    "protocol",
  );
}

/**
 * The delivered-frame half of the inbound byte bound: returns the terminal
 * {@link oversizedFrameError} if `data` is a binary frame larger than `maxBytes`,
 * otherwise `undefined`. This runs at the stable `data` event -- a backstop, at
 * the public layer, for the {@link boundChunkReassembly} guard at the fragile
 * internal layer: an over-cap `Uint8Array` is refused as delivered regardless of
 * how (or whether) PeerJS chunked it.
 *
 * A parsed JSON object/array returns `undefined` (not cheaply byte-measurable
 * here); those frames -- the association tables and status messages -- are
 * governed by core's count/structure bounds, and a large set arrives as the
 * binary `Uint8Array` this does measure.
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
    ? oversizedFrameError(maxBytes)
    : undefined;
}

/**
 * Wraps `conn`'s PeerJS chunk reassembly so it cannot exhaust memory, the
 * primary inbound bound for the WebRTC transport. PeerJS reassembles a chunked
 * frame in `_handleChunk`, accumulating slices keyed by message id with no cap
 * on total bytes, no cap on concurrent incomplete reassemblies, and no eviction
 * of a never-completed partial. This wrap adds all three before delegating to
 * the original, so the over-cap chunk is never stored:
 *
 * - A running total of bytes across all in-flight reassemblies is bounded by
 *   `maxFrameBytes`. A chunk that would push it over fails the exchange via
 *   `fail` (fail-closed, mirroring the file-sync frame-size control's intent)
 *   rather than allocating proportional to the peer-chosen size. This bounds a
 *   single oversized frame and a single big never-completed partial alike.
 * - The number of concurrent incomplete reassemblies is bounded by
 *   `maxConcurrentReassemblies`. A new message id beyond the cap evicts the
 *   oldest incomplete partial (deleting it from `_chunkedData`), bounding a
 *   flood of partials from many distinct ids. Eviction is silent and non-fatal:
 *   the lockstep protocol never has a legitimate second partial, so eviction
 *   only ever drops adversarial data, and logging per eviction would itself be a
 *   spray-amplified log-flood vector.
 *
 * @param conn   The PeerJS data connection (open or not yet open).
 * @param fail   Latches a terminal failure (the connection's `controls.fail`).
 * @param options  `maxFrameBytes` / `maxConcurrentReassemblies` default to the
 *                 fixed {@link MAX_WEBRTC_FRAME_BYTES} /
 *                 {@link MAX_CONCURRENT_REASSEMBLIES}; overridden only by tests,
 *                 never an operator-facing knob.
 * @throws If the PeerJS internals are not as expected (a broken upgrade premise).
 */
export function boundChunkReassembly(
  conn: DataConnection,
  fail: (error: ConnectionError) => void,
  options?: { maxFrameBytes?: number; maxConcurrentReassemblies?: number },
): void {
  const maxFrameBytes = options?.maxFrameBytes ?? MAX_WEBRTC_FRAME_BYTES;
  const maxConcurrent =
    options?.maxConcurrentReassemblies ?? MAX_CONCURRENT_REASSEMBLIES;

  const internals = conn as unknown as ChunkedDataConnection;
  // Encode the dependency premise as a runtime check, not a comment: a `peerjs`
  // upgrade that renames or restructures the chunk reassembly must fail loud
  // (the live browser exchange test installs this guard) rather than silently
  // run the exchange with no inbound bound. Validate against a loosely-typed view
  // (the cast above asserts the fields exist; this re-checks at runtime).
  const probe = internals as { _handleChunk?: unknown; _chunkedData?: unknown };
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

  const original = internals._handleChunk.bind(internals);
  // Per-id accumulated bytes, in arrival order (Map preserves insertion order,
  // so the first key is the oldest partial to evict). Mirrors PeerJS's own
  // `_chunkedData` lifecycle: an entry is added on a frame's first chunk and
  // removed when the frame completes or is evicted.
  const inFlight = new Map<number, number>();
  let bytesInFlight = 0;

  const evictOldest = (): void => {
    const oldest = inFlight.keys().next().value;
    if (oldest === undefined) return;
    bytesInFlight -= inFlight.get(oldest) ?? 0;
    inFlight.delete(oldest);
    delete internals._chunkedData[oldest];
  };

  internals._handleChunk = (chunk: PeerChunk): void => {
    const id = chunk.__peerData;
    const chunkBytes = chunkByteLength(chunk.data);

    // A frame's first chunk starts a new reassembly: enforce the concurrent-count
    // cap first, evicting the oldest partial to make room.
    if (!inFlight.has(id)) {
      while (inFlight.size >= maxConcurrent) evictOldest();
    }

    // Fail closed before the original stores this chunk, so the over-cap byte is
    // never allocated. The running total spans every in-flight reassembly, so
    // this caps both a single frame and the aggregate of concurrent partials.
    if (bytesInFlight + chunkBytes > maxFrameBytes) {
      fail(oversizedFrameError(maxFrameBytes));
      return;
    }

    bytesInFlight += chunkBytes;
    inFlight.set(id, (inFlight.get(id) ?? 0) + chunkBytes);

    original(chunk);

    // PeerJS deletes the `_chunkedData` entry when the frame completes; mirror
    // that here so a completed frame's bytes are released from the running total.
    if (internals._chunkedData[id] === undefined) {
      bytesInFlight -= inFlight.get(id) ?? 0;
      inFlight.delete(id);
    }
  };
}
