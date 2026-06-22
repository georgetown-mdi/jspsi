import { describe, expect, test, vi } from "vitest";

import { ConnectionError } from "@psilink/core";

import {
  MAX_WEBRTC_FRAME_STRUCTURE_BYTES,
  WEBRTC_VALUE_WEIGHTS,
  boundChunkReassembly,
  checkDeliveredFrameBound,
  structureOverBudget,
} from "../../src/psi/boundedReassembly.js";

import type { DataConnection } from "peerjs";

interface Chunk {
  __peerData: number;
  n: number;
  total: number;
  data: Uint8Array;
}

function concatSlices(slices: Array<Uint8Array>): Uint8Array {
  let len = 0;
  for (const s of slices) len += s.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const s of slices) {
    out.set(s, off);
    off += s.length;
  }
  return out;
}

/**
 * A test double for the PeerJS binary connection's reassembly/unpack surface.
 * The unit tests drive each wrapped method with the input it processes -- chunk
 * objects into `_handleChunk`, frame bytes into `_handleDataMessage` -- rather
 * than through real PeerJS's entry ordering (where `_handleDataMessage` is the
 * sole entry and routes a chunk envelope to `_handleChunk`); that end-to-end
 * ordering is exercised by the live browser exchange test. What is modeled here
 * is the completion recursion this guard depends on: `_handleChunk` accumulates
 * slices keyed by message id (storing the chunk total from the first chunk) and,
 * on completion, concatenates and recurses into `_handleDataMessage`, the unpack
 * point. `delivered` records each frame that reached it (i.e. was not refused).
 */
class FakeChunkedConnection {
  _chunkedData: Record<
    number,
    { data: Array<Uint8Array>; count: number; total: number }
  > = {};
  delivered: Array<Uint8Array> = [];

  _handleDataMessage = (message: { data: Uint8Array }): void => {
    this.delivered.push(message.data);
  };

  _handleChunk = (chunk: Chunk): void => {
    const id = chunk.__peerData;
    const info = this._chunkedData[id] ?? {
      data: [],
      count: 0,
      total: chunk.total,
    };
    info.data[chunk.n] = chunk.data;
    info.count++;
    this._chunkedData[id] = info;
    if (info.count === info.total) {
      delete this._chunkedData[id];
      this._handleDataMessage({ data: concatSlices(info.data) });
    }
  };

  /** Number of distinct partials currently retained (incomplete reassemblies). */
  get partialCount(): number {
    return Object.keys(this._chunkedData).length;
  }
}

function makeChunk(id: number, n: number, total: number, bytes: number): Chunk {
  return { __peerData: id, n, total, data: new Uint8Array(bytes) };
}

/** A BinaryPack array32 header declaring `count` elements (no element bytes). */
function array32Header(count: number): Uint8Array {
  return new Uint8Array([
    0xdd,
    (count >>> 24) & 0xff,
    (count >>> 16) & 0xff,
    (count >>> 8) & 0xff,
    count & 0xff,
  ]);
}

/** `depth` nested array32 headers, each declaring `count` -- a deep spine whose
 * first header already declares more elements than the bytes that follow it. */
function nestedArrayHeaders(count: number, depth: number): Uint8Array {
  const out: Array<number> = [];
  for (let d = 0; d < depth; d++) out.push(...array32Header(count));
  return new Uint8Array(out);
}

/** A BinaryPack array16 of `n` fixints (each one wire byte), fully byte-backed. */
function arrayOfFixints(n: number): Uint8Array {
  const out = [0xdc, (n >>> 8) & 0xff, n & 0xff];
  for (let i = 0; i < n; i++) out.push(0x01);
  return new Uint8Array(out);
}

/** A BinaryPack str32 header declaring a `byteLen`-byte string (no payload). */
function str32Header(byteLen: number): Uint8Array {
  return new Uint8Array([
    0xd9,
    (byteLen >>> 24) & 0xff,
    (byteLen >>> 16) & 0xff,
    (byteLen >>> 8) & 0xff,
    byteLen & 0xff,
  ]);
}

/** A BinaryPack array16 of `n` empty objects (each a one-byte `fixmap` of zero
 * pairs) -- the cheapest-on-the-wire, heaviest-in-memory shape, the worst case the
 * byte-aware budget exists to charge honestly. */
function arrayOfEmptyObjects(n: number): Uint8Array {
  const out = [0xdc, (n >>> 8) & 0xff, n & 0xff];
  for (let i = 0; i < n; i++) out.push(0x80); // fixmap(0)
  return new Uint8Array(out);
}

/** A BinaryPack fixstr (declared length <= 15) of `s`, header byte + UTF-8 bytes. */
function fixstr(s: string): Array<number> {
  const bytes = [...new TextEncoder().encode(s)];
  return [0xb0 | bytes.length, ...bytes];
}

/** One mapped-element record `{theirIndex, iteration}` as BinaryPack: a `fixmap`
 * of two pairs with the real string keys and two small (fixint) values, exactly
 * the shape `conn.send` serializes for the largest legitimate inbound frame. */
function mappedRecord(theirIndex: number, iteration: number): Array<number> {
  return [
    0x82, // fixmap(2)
    ...fixstr("theirIndex"),
    theirIndex & 0x7f, // fixint
    ...fixstr("iteration"),
    iteration & 0x7f, // fixint
  ];
}

/** A BinaryPack array16 of `n` mapped-element records (the mapped-element frame).
 * Bounded to the array16 count so a large `n` fails loud rather than silently
 * truncating the header; the budget derivation uses {@link expectedMappedCost}
 * (pure arithmetic) for the multi-million-record ceiling, never a real buffer. */
function mappedElementFrame(n: number): Uint8Array {
  if (n > 0xffff)
    throw new RangeError(`mappedElementFrame: n=${n} exceeds array16`);
  const out: Array<number> = [0xdc, (n >>> 8) & 0xff, n & 0xff];
  for (let i = 0; i < n; i++) out.push(...mappedRecord(i % 128, 0));
  return new Uint8Array(out);
}

/** Resident weight of a string of `byteLen` wire bytes under the cost model. */
function stringWeightOf(byteLen: number): number {
  return (
    WEBRTC_VALUE_WEIGHTS.stringBase +
    WEBRTC_VALUE_WEIGHTS.stringPerByte * byteLen
  );
}

/** The charged retained cost of an `n`-record mapped-element frame under the cost
 * model: a root array, plus per record one object, two key strings, two integers.
 * This is the derivation the production budget is sized against. */
function expectedMappedCost(n: number): number {
  const perRecord =
    WEBRTC_VALUE_WEIGHTS.object +
    stringWeightOf("theirIndex".length) +
    WEBRTC_VALUE_WEIGHTS.scalar +
    stringWeightOf("iteration".length) +
    WEBRTC_VALUE_WEIGHTS.scalar;
  return WEBRTC_VALUE_WEIGHTS.array + n * perRecord;
}

type InstallOptions = {
  maxFrameBytes?: number;
  maxConcurrentReassemblies?: number;
  maxStructureBytes?: number;
  maxReassemblyDepth?: number;
  maxChunks?: number;
  minChunkResidentBytes?: number;
  maxStringBytes?: number;
};

function install(conn: FakeChunkedConnection, options?: InstallOptions) {
  const fail = vi.fn();
  // Default the per-chunk residency floor to 0 so byte-cap tests measure pure
  // payload; the residency behavior is exercised by its own test.
  boundChunkReassembly(conn as unknown as DataConnection, fail, {
    minChunkResidentBytes: 0,
    ...options,
  });
  return fail;
}

describe("boundChunkReassembly: wire-byte, chunk, and partial bounds", () => {
  test("rejects an over-cap reassembly and does not store the over-cap chunk", () => {
    const conn = new FakeChunkedConnection();
    const fail = install(conn, { maxFrameBytes: 100 });

    conn._handleChunk(makeChunk(1, 0, 10, 40)); // 40
    conn._handleChunk(makeChunk(1, 1, 10, 40)); // 80
    conn._handleChunk(makeChunk(1, 2, 10, 40)); // would be 120 > 100

    expect(fail).toHaveBeenCalledTimes(1);
    const err = fail.mock.calls[0][0] as ConnectionError;
    expect(err).toBeInstanceOf(ConnectionError);
    expect(err.kind).toBe("protocol");
    expect(err.message).toContain("size limit");
    expect(conn._chunkedData[1].count).toBe(2);
    expect(conn.delivered).toEqual([]);
  });

  test("accepts an at-cap frame and delivers it", () => {
    const conn = new FakeChunkedConnection();
    const fail = install(conn, { maxFrameBytes: 100 });

    conn._handleChunk(makeChunk(2, 0, 2, 50)); // 50
    conn._handleChunk(makeChunk(2, 1, 2, 50)); // 100, exactly at cap

    expect(fail).not.toHaveBeenCalled();
    expect(conn.delivered).toHaveLength(1);
    expect(conn.partialCount).toBe(0);
  });

  test("releases a completed frame's bytes so the next frame is bounded independently", () => {
    const conn = new FakeChunkedConnection();
    const fail = install(conn, { maxFrameBytes: 100 });

    conn._handleChunk(makeChunk(3, 0, 2, 50));
    conn._handleChunk(makeChunk(3, 1, 2, 50)); // completes, releases 100
    conn._handleChunk(makeChunk(4, 0, 2, 50));
    conn._handleChunk(makeChunk(4, 1, 2, 50)); // completes too -- no carryover

    expect(fail).not.toHaveBeenCalled();
    expect(conn.delivered).toHaveLength(2);
  });

  test("bounds the aggregate of concurrent partials by the running total", () => {
    const conn = new FakeChunkedConnection();
    const fail = install(conn, {
      maxFrameBytes: 100,
      maxConcurrentReassemblies: 8,
    });

    conn._handleChunk(makeChunk(1, 0, 5, 60)); // 60
    conn._handleChunk(makeChunk(2, 0, 5, 60)); // 60 + 60 = 120 > 100

    expect(fail).toHaveBeenCalledTimes(1);
    expect((fail.mock.calls[0][0] as ConnectionError).kind).toBe("protocol");
  });

  test("evicts the oldest partial beyond the concurrent cap rather than retaining it", () => {
    const conn = new FakeChunkedConnection();
    const fail = install(conn, {
      maxFrameBytes: 1_000_000,
      maxConcurrentReassemblies: 2,
    });

    for (const id of [1, 2, 3, 4, 5])
      conn._handleChunk(makeChunk(id, 0, 5, 10));

    expect(fail).not.toHaveBeenCalled();
    expect(conn.partialCount).toBe(2);
    expect(Object.keys(conn._chunkedData).map(Number).sort()).toEqual([4, 5]);
  });

  test("eviction frees the byte budget the evicted partial held", () => {
    const conn = new FakeChunkedConnection();
    const fail = install(conn, {
      maxFrameBytes: 100,
      maxConcurrentReassemblies: 1,
    });

    conn._handleChunk(makeChunk(1, 0, 5, 60)); // partial holds 60
    conn._handleChunk(makeChunk(2, 0, 5, 60)); // evicts #1 (frees 60), then stores 60

    expect(fail).not.toHaveBeenCalled();
    expect(conn.partialCount).toBe(1);
    expect(Object.keys(conn._chunkedData).map(Number)).toEqual([2]);
  });

  test("drops every chunk and frame once it has failed the connection", () => {
    const conn = new FakeChunkedConnection();
    const fail = install(conn, { maxFrameBytes: 100 });

    conn._handleChunk(makeChunk(1, 0, 10, 60)); // 60, stored
    conn._handleChunk(makeChunk(1, 1, 10, 60)); // 120 > 100 -> fail
    expect(fail).toHaveBeenCalledTimes(1);
    const partialsAtFailure = conn.partialCount;

    conn._handleChunk(makeChunk(1, 2, 10, 1));
    conn._handleChunk(makeChunk(2, 0, 10, 1));
    conn._handleDataMessage({ data: new Uint8Array([0x01]) });

    expect(fail).toHaveBeenCalledTimes(1);
    expect(conn.partialCount).toBe(partialsAtFailure);
    expect(conn.delivered).toEqual([]);
  });

  test("counts a string chunk by byte residency, not character length", () => {
    const conn = new FakeChunkedConnection();
    const fail = install(conn, { maxFrameBytes: 10 });

    conn._handleChunk({
      __peerData: 1,
      n: 0,
      total: 2,
      data: "abcdef",
    } as unknown as Chunk);

    expect(fail).toHaveBeenCalledTimes(1);
    expect((fail.mock.calls[0][0] as ConnectionError).kind).toBe("protocol");
  });

  test("bounds a flood of tiny chunks by per-chunk residency", () => {
    const conn = new FakeChunkedConnection();
    const fail = install(conn, {
      maxFrameBytes: 1000,
      minChunkResidentBytes: 256,
    });

    conn._handleChunk(makeChunk(1, 0, 100, 1)); // 256
    conn._handleChunk(makeChunk(1, 1, 100, 1)); // 512
    conn._handleChunk(makeChunk(1, 2, 100, 1)); // 768
    expect(fail).not.toHaveBeenCalled();
    conn._handleChunk(makeChunk(1, 3, 100, 1)); // 1024 > 1000

    expect(fail).toHaveBeenCalledTimes(1);
    expect((fail.mock.calls[0][0] as ConnectionError).message).toContain(
      "size limit",
    );
  });

  test("bounds the retained chunk count per reassembly", () => {
    const conn = new FakeChunkedConnection();
    const fail = install(conn, { maxChunks: 3 });

    conn._handleChunk(makeChunk(1, 0, 100, 10));
    conn._handleChunk(makeChunk(1, 1, 100, 10));
    conn._handleChunk(makeChunk(1, 2, 100, 10));
    expect(fail).not.toHaveBeenCalled();
    conn._handleChunk(makeChunk(1, 3, 100, 10)); // 4th chunk > 3

    expect(fail).toHaveBeenCalledTimes(1);
    expect((fail.mock.calls[0][0] as ConnectionError).message).toContain(
      "chunk",
    );
  });

  test("throws when the PeerJS reassembly/unpack internals are absent", () => {
    expect(() =>
      boundChunkReassembly({} as unknown as DataConnection, vi.fn()),
    ).toThrow(/reassembly\/unpack internals/);
    // _handleChunk present but _handleDataMessage missing must also fail loud.
    expect(() =>
      boundChunkReassembly(
        {
          _handleChunk: () => {},
          _chunkedData: {},
        } as unknown as DataConnection,
        vi.fn(),
      ),
    ).toThrow(/reassembly\/unpack internals/);
  });
});

describe("boundChunkReassembly: deserialized-structure bound at the unpack chokepoint", () => {
  test("rejects an unchunked frame whose retained cost exceeds the byte budget", () => {
    const conn = new FakeChunkedConnection();
    const fail = install(conn, { maxStructureBytes: 100 });

    // A byte-backed array of 200 fixints: 40 + 200*8 = 1640 retained bytes > 100.
    // Delivered straight through _handleDataMessage, never touching _handleChunk.
    conn._handleDataMessage({ data: arrayOfFixints(200) });

    expect(fail).toHaveBeenCalledTimes(1);
    const err = fail.mock.calls[0][0] as ConnectionError;
    expect(err.kind).toBe("protocol");
    expect(err.message).toContain("structure limit");
    expect(conn.delivered).toEqual([]);
  });

  test("rejects a frame within the old value-count budget but over the byte budget", () => {
    const conn = new FakeChunkedConnection();
    const fail = install(conn, { maxStructureBytes: 1000 });

    // 20 empty objects is 21 values -- trivially within any value-count budget --
    // but 40 + 20*64 = 1320 retained bytes, over the 1000-byte budget. This is the
    // empty-object amplification a flat per-value count let through; the scan
    // rejects it at the offending header, before unpack allocates the objects.
    conn._handleDataMessage({ data: arrayOfEmptyObjects(20) });

    expect(fail).toHaveBeenCalledTimes(1);
    expect((fail.mock.calls[0][0] as ConnectionError).message).toContain(
      "structure limit",
    );
    expect(conn.delivered).toEqual([]);
  });

  test("rejects a deep nested-array spine by the bytes-that-follow check", () => {
    const conn = new FakeChunkedConnection();
    const fail = install(conn, { maxStructureBytes: 1_000_000 });

    // Eight nested array32 each declaring 999000: each header declares far more
    // elements than the bytes that follow it, so the first is refused before the
    // byte budget even comes into play.
    conn._handleDataMessage({ data: nestedArrayHeaders(999000, 8) });

    expect(fail).toHaveBeenCalledTimes(1);
    expect(conn.delivered).toEqual([]);
  });

  test("rejects sibling containers whose combined retained cost exceeds the budget", () => {
    const conn = new FakeChunkedConnection();
    const fail = install(conn, { maxStructureBytes: 100 });

    // array(2) of two byte-backed array(60)s: each container is within the bytes
    // that follow, but 40 + 2*40 + 120*8 = 1080 retained bytes > 100, since the
    // running cost spans the whole structure, not just the current container.
    const frame = new Uint8Array([
      0xdc,
      0x00,
      0x02,
      ...arrayOfFixints(60),
      ...arrayOfFixints(60),
    ]);
    conn._handleDataMessage({ data: frame });

    expect(fail).toHaveBeenCalledTimes(1);
    expect(conn.delivered).toEqual([]);
  });

  test("rejects an array declaring more elements than the bytes that follow", () => {
    const conn = new FakeChunkedConnection();
    // Byte budget generous; the bytes-that-follow check is what catches the
    // zero-filled-array vector (a 5-byte header declaring a million elements).
    const fail = install(conn, { maxStructureBytes: 1_000_000_000 });

    conn._handleDataMessage({ data: array32Header(1_000_000) });

    expect(fail).toHaveBeenCalledTimes(1);
    expect(conn.delivered).toEqual([]);
  });

  test("rejects an oversized string the byte budget alone would miss", () => {
    const conn = new FakeChunkedConnection();
    const fail = install(conn, { maxStringBytes: 100 });

    // One value whose resident weight is small, but a 1000-byte string's build
    // transient dwarfs that slot -- refused by the per-string cap, not the budget.
    conn._handleDataMessage({ data: str32Header(1000) });

    expect(fail).toHaveBeenCalledTimes(1);
    const err = fail.mock.calls[0][0] as ConnectionError;
    expect(err.kind).toBe("protocol");
    expect(conn.delivered).toEqual([]);
  });

  test("accepts a small valid structure and delegates to unpack", () => {
    const conn = new FakeChunkedConnection();
    const fail = install(conn, { maxStructureBytes: 1000 });

    conn._handleDataMessage({ data: arrayOfFixints(50) }); // 40 + 50*8 = 440 <= 1000

    expect(fail).not.toHaveBeenCalled();
    expect(conn.delivered).toHaveLength(1);
  });

  test("accepts an at-budget legitimate mapped-element frame", () => {
    const conn = new FakeChunkedConnection();
    // Budget set to exactly the frame's charged cost: the largest legitimate frame
    // shape is admitted, never rejected on its own retained size.
    const fail = install(conn, { maxStructureBytes: expectedMappedCost(500) });

    conn._handleDataMessage({ data: mappedElementFrame(500) });

    expect(fail).not.toHaveBeenCalled();
    expect(conn.delivered).toHaveLength(1);
  });

  test("charges a large binary payload only its slot weight, not its bytes", () => {
    const conn = new FakeChunkedConnection();
    // Budget at exactly one scalar weight: a raw value passes, proving its 10-byte
    // payload is skipped (not charged) -- a real binary set frame is the wire
    // cap's concern, not this structural budget's.
    const fail = install(conn, {
      maxStructureBytes: WEBRTC_VALUE_WEIGHTS.scalar,
    });

    const raw = new Uint8Array(13);
    raw[0] = 0xda; // raw16
    raw[1] = 0x00;
    raw[2] = 0x0a; // length 10
    conn._handleDataMessage({ data: raw });

    expect(fail).not.toHaveBeenCalled();
    expect(conn.delivered).toHaveLength(1);
  });

  test("scans the reassembled frame on the chunked-completion path too", () => {
    const conn = new FakeChunkedConnection();
    const fail = install(conn, {
      maxStructureBytes: 100,
      maxFrameBytes: 1_000_000,
    });

    // A byte-backed over-budget array delivered as two chunks: the scan runs on
    // the reassembled buffer via the recursive _handleDataMessage call.
    const frame = arrayOfFixints(200);
    const mid = Math.ceil(frame.length / 2);
    conn._handleChunk({
      __peerData: 1,
      n: 0,
      total: 2,
      data: frame.subarray(0, mid),
    });
    conn._handleChunk({
      __peerData: 1,
      n: 1,
      total: 2,
      data: frame.subarray(mid),
    });

    expect(fail).toHaveBeenCalledTimes(1);
    expect((fail.mock.calls[0][0] as ConnectionError).message).toContain(
      "structure limit",
    );
    expect(conn.delivered).toEqual([]);
  });
});

describe("structureOverBudget", () => {
  test("flags a flat array over the byte budget", () => {
    // 40 + 50*8 = 440 retained bytes, over a 100-byte budget.
    expect(structureOverBudget(arrayOfFixints(50), 100, 256)).toBe(true);
  });

  test("passes a flat array under the byte budget", () => {
    expect(structureOverBudget(arrayOfFixints(50), 1000, 256)).toBe(false);
  });

  test("flags an array declaring more than the bytes that follow", () => {
    expect(structureOverBudget(array32Header(1000), 1_000_000, 256)).toBe(true);
  });

  test("flags a string longer than the per-string byte cap", () => {
    expect(structureOverBudget(str32Header(1000), 1_000_000, 256, 100)).toBe(
      true,
    );
  });

  test("passes a short fixstr under the per-string cap", () => {
    // fixstr "abc" (0xb3 + 3 bytes) is one value and well under any string cap.
    expect(
      structureOverBudget(
        new Uint8Array([0xb3, 0x61, 0x62, 0x63]),
        100,
        256,
        100,
      ),
    ).toBe(false);
  });

  test("flags a fixstr over the per-string cap, uniformly with the wide markers", () => {
    // fixstr "abcd" (4 bytes) against a 2-byte cap: the cap fires on fixstr too,
    // not only str16/str32, so the marker dispatch is one rule.
    expect(
      structureOverBudget(new Uint8Array(fixstr("abcd")), 1000, 256, 2),
    ).toBe(true);
  });

  test("flags excessive nesting depth", () => {
    // Each level is one byte-backed array of one element; deeper than the cap.
    const out: Array<number> = [];
    for (let d = 0; d < 10; d++) out.push(0x91); // fixarray(1)
    out.push(0x01); // a fixint leaf
    expect(structureOverBudget(new Uint8Array(out), 1000, 4)).toBe(true);
  });
});

describe("structureOverBudget: the per-value cost model", () => {
  // Each value kind is a single-value frame charged exactly its documented weight:
  // a budget one byte below the weight rejects, a budget at the weight accepts. The
  // string cap is left wide so only the structural weight is under test.
  const atBoundary = (frame: Uint8Array, weight: number): void => {
    expect(structureOverBudget(frame, weight - 1, 256, 1 << 20)).toBe(true);
    expect(structureOverBudget(frame, weight, 256, 1 << 20)).toBe(false);
  };

  test("charges an empty object the object weight", () => {
    atBoundary(new Uint8Array([0x80]), WEBRTC_VALUE_WEIGHTS.object); // fixmap(0)
  });

  test("charges an empty array the array weight", () => {
    atBoundary(new Uint8Array([0x90]), WEBRTC_VALUE_WEIGHTS.array); // fixarray(0)
  });

  test("charges an integer the scalar weight", () => {
    atBoundary(new Uint8Array([0x01]), WEBRTC_VALUE_WEIGHTS.scalar); // fixint
  });

  test("charges a wide number marker (double) the scalar weight", () => {
    // double (0xcb + 8 payload bytes) is a HeapNumber at runtime but is charged
    // the scalar slot here; this pins the documented under-count -- the wire-byte
    // cap, not the structure budget, is the backstop for a number-heavy frame.
    atBoundary(
      new Uint8Array([0xcb, 0, 0, 0, 0, 0, 0, 0, 0]),
      WEBRTC_VALUE_WEIGHTS.scalar,
    );
  });

  test("charges a string its header plus per-byte weight", () => {
    // fixstr "abcd": stringBase + 4 * stringPerByte.
    atBoundary(new Uint8Array(fixstr("abcd")), stringWeightOf(4));
  });

  test("the cost is additive across a mapped-element record", () => {
    // One record charges object + two key strings + two scalars; the array root
    // adds the array weight. Pinned against the real BinaryPack-encoded shape.
    expect(
      structureOverBudget(mappedElementFrame(1), expectedMappedCost(1), 256),
    ).toBe(false);
    expect(
      structureOverBudget(
        mappedElementFrame(1),
        expectedMappedCost(1) - 1,
        256,
      ),
    ).toBe(true);
  });

  test("the production budget admits the largest legitimate mapped-element frame", () => {
    // The ~4.19M-record (2^22) ceiling -- the 256 MiB wire cap's ~4M-element set --
    // at the conservative per-record weight stays under the fixed budget, so no
    // exchange the wire cap admits is rejected on a downstream frame.
    expect(expectedMappedCost(4_194_304)).toBeLessThan(
      MAX_WEBRTC_FRAME_STRUCTURE_BYTES,
    );
  });
});

describe("checkDeliveredFrameBound", () => {
  test("returns a terminal protocol error for an over-cap binary frame", () => {
    const err = checkDeliveredFrameBound(new Uint8Array(9), 8);
    expect(err).toBeInstanceOf(ConnectionError);
    expect(err?.kind).toBe("protocol");
  });

  test("accepts an at-cap binary frame", () => {
    expect(checkDeliveredFrameBound(new Uint8Array(8), 8)).toBeUndefined();
  });

  test("bounds a raw ArrayBuffer as well as a typed-array view", () => {
    expect(checkDeliveredFrameBound(new ArrayBuffer(9), 8)).toBeInstanceOf(
      ConnectionError,
    );
  });

  test("does not bound a non-binary frame", () => {
    expect(
      checkDeliveredFrameBound({ theirIndex: 1, iteration: 0 }, 1),
    ).toBeUndefined();
    expect(checkDeliveredFrameBound([1, 2, 3], 1)).toBeUndefined();
  });
});
