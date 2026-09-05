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

import { classifyInboundValue, concatChunks, unpackFrame } from "./peerjsWire";

/**
 * The CLI's WebRTC data-channel inbound bound: the reassembler the transport
 * feeds every datagram through, so a hostile or buggy peer cannot drive this
 * process toward memory exhaustion by choosing what it sends. It is the CLI half
 * of the control specified in docs/spec/CHANNEL_SECURITY.md ("WebRTC data-channel
 * inbound bound"); the web half wraps PeerJS's own reassembly internals
 * (apps/web/src/psi/transport/boundedReassembly.ts). Both enforce the SAME
 * constants and the SAME BinaryPack structural pre-scan, which is why those
 * live once in `@psilink/core` (connection/binaryPackBounds.ts) rather than
 * beside either transport.
 *
 * Where this differs from the web half, and why: the CLI owns its reassembler
 * outright instead of wrapping PeerJS's, so it can be stricter in two places
 * PeerJS is not.
 *
 * - A chunk ordinal is accepted ONCE. PeerJS counts every chunk it receives and
 *   completes a frame when the count reaches the declared total, so a peer that
 *   repeats one ordinal completes a frame full of holes. Here a repeat is charged
 *   against the caps and then dropped, and a frame completes only when every
 *   distinct ordinal has arrived.
 * - A reassembled frame may not itself be an envelope. PeerJS re-enters its
 *   dispatch on the assembled bytes, so a chunk stream that assembles into
 *   another chunk envelope recurses; a legitimate sender never produces one
 *   (it chunks an already-packed application frame), so nesting is refused.
 *
 * The bounds themselves, in the order a datagram meets them:
 *
 * 1. The datagram's own wire bytes, against `maxFrameBytes`. Not redundant with
 *    the SCTP message ceiling: that ceiling is negotiated in the SDP, so a peer
 *    can raise its side of it, and this is the check that does not move.
 * 2. The BinaryPack structural pre-scan, before `unpack` allocates anything --
 *    `unpack` can build a structure far larger than the wire bytes it reads.
 * 3. Per reassembly: the declared chunk count and the accepted chunk count,
 *    against `maxChunks`.
 * 4. Across all reassemblies in flight: total retained bytes against
 *    `maxFrameBytes`, each chunk charged at least `minChunkResidentBytes` (a
 *    retained view costs more than its payload, so a tiny-chunk flood would
 *    otherwise be undercounted).
 * 5. Concurrent incomplete reassemblies against `maxConcurrentReassemblies`,
 *    evicting the oldest past the cap. Eviction is silent and non-fatal: the
 *    lockstep PSI protocol never has a legitimate second partial, so it only ever
 *    drops adversarial data, and logging per eviction would itself be a
 *    log-flood vector.
 * 6. The assembled frame meets the structural pre-scan again before its own
 *    `unpack`.
 *
 * Every breach is terminal and fail-closed: the offending bytes are never
 * unpacked and never delivered, and the failure names the rule that refused them
 * -- the pre-scan enforces the retained-byte budget, the nesting depth, the
 * per-string cap, the byte-backed-elements check and the map-key rule on one walk.
 */

/** What one accepted datagram produced. */
export type InboundOutcome =
  /** Nothing to deliver yet: a chunk was retained, dropped, or evicted. */
  | { kind: "pending" }
  /** The peer's in-band clean close. */
  | { kind: "close" }
  /** A complete application frame, ready for the message queue. */
  | { kind: "frame"; value: unknown };

/** Per-bound overrides; set only by tests, never an operator-facing setting. */
export interface InboundBoundOptions {
  maxFrameBytes?: number;
  maxConcurrentReassemblies?: number;
  maxStructureBytes?: number;
  maxReassemblyDepth?: number;
  maxChunks?: number;
  minChunkResidentBytes?: number;
  maxStringBytes?: number;
}

/**
 * A terminal refusal of one frame: `predicate` says what the frame did, so the
 * message names the rule that fired rather than one standing in for the rest.
 * For the five pre-scan rules the predicate comes from core's one renderer, so
 * both transports word those identically; the wire-byte and chunk-cap
 * predicates are composed here, from this side's own fixed limits.
 *
 * Kind `protocol`: every bound sits far above any legitimate frame, so meeting
 * one is the peer violating the message contract, never benign. It holds only
 * the fixed limits, no peer-controlled bytes, so it needs no redaction.
 */
function frameRefusalError(predicate: string): ConnectionError {
  return new ConnectionError(`inbound WebRTC frame ${predicate}`, "protocol");
}

/**
 * A reassembly the peer framed in a way no PeerJS sender produces. Distinct from
 * {@link frameRefusalError}: the fault is in the chunk stream around the frames
 * rather than in a frame the scan read. Also `protocol`, and likewise holds no
 * peer-controlled bytes.
 */
function reassemblyProtocolError(detail: string): ConnectionError {
  return new ConnectionError(
    `the peer sent an invalid WebRTC chunk stream: ${detail}`,
    "protocol",
  );
}

/** One frame mid-reassembly: its slices by ordinal, plus what it has cost. */
interface Reassembly {
  readonly total: number;
  readonly parts: Array<Uint8Array | undefined>;
  /** Distinct ordinals received so far; the frame completes at `total`. */
  distinct: number;
  /** Chunks charged to this reassembly, repeats included. */
  charged: number;
  /** Bytes charged to the in-flight total, released when it completes. */
  bytes: number;
}

/**
 * The bounded inbound path for one data channel. Feed it every datagram the
 * channel delivers, in arrival order; it returns what that datagram produced and
 * throws a terminal {@link ConnectionError} the moment a bound is breached.
 *
 * Not reusable across channels: it holds one channel's in-flight reassembly
 * state, and the byte budget is per-channel.
 */
export class BoundedInboundFrames {
  private readonly maxFrameBytes: number;
  private readonly maxConcurrent: number;
  private readonly maxStructureBytes: number;
  private readonly maxDepth: number;
  private readonly maxChunks: number;
  private readonly minChunkBytes: number;
  private readonly maxStringBytes: number;

  // In arrival order, so the first key is the oldest partial to evict (a Map
  // preserves insertion order and re-setting an existing key does not move it).
  private readonly inFlight = new Map<number, Reassembly>();
  private bytesInFlight = 0;

  constructor(options?: InboundBoundOptions) {
    this.maxFrameBytes = options?.maxFrameBytes ?? MAX_WEBRTC_FRAME_BYTES;
    this.maxConcurrent =
      options?.maxConcurrentReassemblies ?? MAX_CONCURRENT_REASSEMBLIES;
    this.maxStructureBytes =
      options?.maxStructureBytes ?? MAX_WEBRTC_FRAME_STRUCTURE_BYTES;
    this.maxDepth = options?.maxReassemblyDepth ?? MAX_WEBRTC_REASSEMBLY_DEPTH;
    this.maxChunks = options?.maxChunks ?? MAX_CHUNKS_PER_REASSEMBLY;
    this.minChunkBytes =
      options?.minChunkResidentBytes ?? MIN_CHUNK_RESIDENT_BYTES;
    this.maxStringBytes = options?.maxStringBytes ?? MAX_WEBRTC_STRING_BYTES;
  }

  /** Bytes currently retained across every incomplete reassembly. */
  retainedBytes(): number {
    return this.bytesInFlight;
  }

  /**
   * Bound, decode and dispatch one inbound datagram.
   *
   * @throws {ConnectionError} of kind `protocol` on a bound breach or a
   *         malformed frame. The connection is terminal after one: the caller
   *         latches the failure and stops feeding.
   */
  accept(bytes: Uint8Array): InboundOutcome {
    const value = this.decodeBounded(bytes);
    const classified = classifyInboundValue(value);
    if (classified.kind === "close") return { kind: "close" };
    if (classified.kind === "data")
      return { kind: "frame", value: classified.value };

    const assembled = this.acceptChunk(
      classified.messageId,
      classified.index,
      classified.total,
      classified.data,
      bytes.byteLength,
    );
    if (assembled === undefined) return { kind: "pending" };

    // The assembled bytes get the same pre-scan the datagram got: they are a
    // frame the peer composed out of parts, and nothing has scanned them whole.
    const inner = this.decodeBounded(assembled);
    const innerKind = classifyInboundValue(inner);
    if (innerKind.kind !== "data") {
      throw reassemblyProtocolError(
        "its chunks reassemble into another envelope rather than a frame",
      );
    }
    return { kind: "frame", value: innerKind.value };
  }

  /** Wire-byte cap, then structural pre-scan, then `unpack`. In that order. */
  private decodeBounded(bytes: Uint8Array): unknown {
    if (bytes.byteLength > this.maxFrameBytes) {
      throw frameRefusalError(
        `exceeds its ${this.maxFrameBytes}-byte size limit`,
      );
    }
    const refusal = scanFrameStructure(
      bytes,
      this.maxStructureBytes,
      this.maxDepth,
      this.maxStringBytes,
    );
    if (refusal !== undefined) {
      throw frameRefusalError(describeFrameStructureRefusal(refusal));
    }
    return unpackFrame(bytes);
  }

  /**
   * Retain one chunk against every cap, returning the joined frame once the last
   * distinct ordinal lands and `undefined` while the frame is still incomplete.
   * `wireBytes` is the whole datagram's length, not the slice's: the envelope
   * around the slice is retained too while the reassembly is in flight.
   */
  private acceptChunk(
    messageId: number,
    index: number,
    total: number,
    data: Uint8Array,
    wireBytes: number,
  ): Uint8Array | undefined {
    if (total > this.maxChunks) {
      throw frameRefusalError(
        `exceeds its ${this.maxChunks}-chunk reassembly limit`,
      );
    }
    let entry = this.inFlight.get(messageId);
    if (entry !== undefined && entry.total !== total) {
      throw reassemblyProtocolError(
        "one frame's chunks declare two different chunk counts",
      );
    }
    if (entry === undefined) {
      while (this.inFlight.size >= this.maxConcurrent) this.evictOldest();
    }

    const charge = Math.max(wireBytes, this.minChunkBytes);
    if (this.bytesInFlight + charge > this.maxFrameBytes) {
      throw frameRefusalError(
        `exceeds its ${this.maxFrameBytes}-byte size limit`,
      );
    }
    if ((entry?.charged ?? 0) + 1 > this.maxChunks) {
      throw frameRefusalError(
        `exceeds its ${this.maxChunks}-chunk reassembly limit`,
      );
    }

    if (entry === undefined) {
      entry = {
        total,
        parts: new Array<Uint8Array | undefined>(total),
        distinct: 0,
        charged: 0,
        bytes: 0,
      };
      this.inFlight.set(messageId, entry);
    }
    entry.charged += 1;
    entry.bytes += charge;
    this.bytesInFlight += charge;

    // A repeated ordinal is charged above (so a repeat flood still meets the
    // caps) but never overwrites the slice already held: the first arrival wins,
    // and the frame stays one ordinal short until a new one lands.
    if (entry.parts[index] === undefined) {
      entry.parts[index] = data;
      entry.distinct += 1;
    }
    if (entry.distinct < total) return undefined;

    this.release(messageId, entry);
    return concatChunks(entry.parts as Array<Uint8Array>);
  }

  private release(messageId: number, entry: Reassembly): void {
    this.bytesInFlight -= entry.bytes;
    this.inFlight.delete(messageId);
  }

  private evictOldest(): void {
    const oldest = this.inFlight.entries().next().value;
    if (oldest === undefined) return;
    this.release(oldest[0], oldest[1]);
  }
}
