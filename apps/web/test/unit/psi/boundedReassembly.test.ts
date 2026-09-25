import { describe, expect, test, vi } from "vitest";

import { pack, unpack } from "peerjs-js-binarypack";

import {
  ConnectionError,
  MAX_WEBRTC_FRAME_BYTES,
  MAX_WEBRTC_STRING_BYTES,
} from "@alcove/core";

import { MAX_CSV_FILE_BYTES } from "@components/csvIntake";

import {
  boundChunkReassembly,
  checkDeliveredFrameBound,
} from "../../../src/psi/transport/boundedReassembly.js";

import type { DataConnection } from "peerjs";
import type { Unpackable } from "peerjs-js-binarypack";

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
  /** Chunks that reached PeerJS's handler, where it runs
   * `new Uint8Array(chunk.data)`: a refused chunk must leave this unchanged. */
  handledChunks = 0;

  _handleDataMessage = (message: { data: Uint8Array }): void => {
    this.delivered.push(message.data);
  };

  _handleChunk = (chunk: Chunk): void => {
    this.handledChunks++;
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
 * truncating the header. */
function mappedElementFrame(n: number): Uint8Array {
  if (n > 0xffff)
    throw new RangeError(`mappedElementFrame: n=${n} exceeds array16`);
  const out: Array<number> = [0xdc, (n >>> 8) & 0xff, n & 0xff];
  for (let i = 0; i < n; i++) out.push(...mappedRecord(i % 128, 0));
  return new Uint8Array(out);
}

type InstallOptions = {
  maxFrameBytes?: number;
  maxConcurrentReassemblies?: number;
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

  test("refuses a chunk declaring more chunks than the reassembly limit", () => {
    const conn = new FakeChunkedConnection();
    const fail = install(conn, { maxChunks: 3 });

    conn._handleChunk(makeChunk(1, 0, 4, 10));

    expect(fail).toHaveBeenCalledTimes(1);
    expect((fail.mock.calls[0][0] as ConnectionError).message).toBe(
      "inbound WebRTC frame exceeds its 3-chunk reassembly limit",
    );
    expect(conn.handledChunks).toBe(0);
  });

  test("accepts a chunk declaring exactly the reassembly limit", () => {
    const conn = new FakeChunkedConnection();
    const fail = install(conn, { maxChunks: 3 });

    for (const n of [0, 1, 2]) conn._handleChunk(makeChunk(1, n, 3, 10));

    expect(fail).not.toHaveBeenCalled();
    expect(conn.delivered).toHaveLength(1);
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

describe("boundChunkReassembly: chunk envelope shape", () => {
  // Each `data` below is one PeerJS would turn into a buffer of the peer's
  // choosing with `new Uint8Array(data)`, sized far past `maxFrameBytes`.
  const nonBinaryPayloads: Array<[string, unknown]> = [
    ["a number", 2_000_000],
    ["a numeric string", "2000000"],
    ["an array-like object", { length: 2_000_000 }],
    ["an object claiming a byte length", { byteLength: 1 }],
    ["an array", [1, 2, 3]],
    ["a missing value", undefined],
  ];

  test.each(nonBinaryPayloads)(
    "refuses %s as chunk data before charging or storing it",
    (_label, data) => {
      const conn = new FakeChunkedConnection();
      const fail = install(conn, { maxFrameBytes: 1_000_000 });

      conn._handleChunk({ __peerData: 1, n: 0, total: 2, data } as never);

      expect(fail).toHaveBeenCalledTimes(1);
      const err = fail.mock.calls[0][0] as ConnectionError;
      expect(err).toBeInstanceOf(ConnectionError);
      expect(err.kind).toBe("protocol");
      expect(err.message).toBe(
        "inbound WebRTC frame has a malformed chunk envelope: its chunk " +
          "payload is not binary",
      );
      expect(conn.handledChunks).toBe(0);
      expect(conn.partialCount).toBe(0);
    },
  );

  test("refuses every later chunk once a non-binary one has failed the connection", () => {
    const conn = new FakeChunkedConnection();
    const fail = install(conn, { maxFrameBytes: 100 });

    conn._handleChunk({
      __peerData: 1,
      n: 0,
      total: 2,
      data: 2_000_000,
    } as never);
    conn._handleChunk(makeChunk(2, 0, 2, 1_000));

    expect(fail).toHaveBeenCalledTimes(1);
    expect(conn.handledChunks).toBe(0);
  });

  const malformedEnvelopes: Array<[string, Record<string, unknown>, string]> = [
    [
      "a non-integer message id",
      { __peerData: "1", n: 0, total: 2 },
      "its chunk message id is not an integer",
    ],
    [
      "a fractional chunk count",
      { __peerData: 1, n: 0, total: 1.5 },
      "its chunk count is not a positive integer",
    ],
    [
      "a zero chunk count",
      { __peerData: 1, n: 0, total: 0 },
      "its chunk count is not a positive integer",
    ],
    [
      "an index at the declared count",
      { __peerData: 1, n: 2, total: 2 },
      "its chunk index is outside the declared count",
    ],
    [
      "a negative index",
      { __peerData: 1, n: -1, total: 2 },
      "its chunk index is outside the declared count",
    ],
  ];

  test.each(malformedEnvelopes)(
    "refuses a chunk with %s",
    (_label, fields, detail) => {
      const conn = new FakeChunkedConnection();
      const fail = install(conn);

      conn._handleChunk({ data: new Uint8Array(4), ...fields } as never);

      expect(fail).toHaveBeenCalledTimes(1);
      expect((fail.mock.calls[0][0] as ConnectionError).message).toBe(
        `inbound WebRTC frame has a malformed chunk envelope: ${detail}`,
      );
      expect(conn.handledChunks).toBe(0);
    },
  );

  test("refuses a decoded object inheriting from an ArrayBuffer and latches the connection", () => {
    const sliceAsPrototype = Object.defineProperty({}, "__proto__", {
      value: new Uint8Array(4),
      enumerable: true,
      writable: true,
      configurable: true,
    });
    const packed = pack({
      __peerData: 1,
      n: 0,
      data: sliceAsPrototype,
      total: 2,
    });
    if (packed instanceof Promise) throw new Error("packed asynchronously");
    const envelope = unpack<Unpackable>(packed) as { data: unknown };
    expect(envelope.data).toBeInstanceOf(ArrayBuffer);

    const conn = new FakeChunkedConnection();
    const fail = install(conn);
    conn._handleChunk(envelope as never);
    conn._handleChunk(makeChunk(2, 0, 2, 4));

    expect(fail).toHaveBeenCalledTimes(1);
    expect((fail.mock.calls[0][0] as ConnectionError).message).toBe(
      "inbound WebRTC frame has a malformed chunk envelope: its chunk " +
        "payload is not binary",
    );
    expect(conn.handledChunks).toBe(0);
    expect(conn.partialCount).toBe(0);
  });

  test("fails the connection when chunk handling throws, and drops later chunks", () => {
    const conn = new FakeChunkedConnection();
    conn._handleChunk = () => {
      conn.handledChunks++;
      throw new RangeError("allocation failed");
    };
    const fail = install(conn);

    conn._handleChunk(makeChunk(1, 0, 2, 4));
    conn._handleChunk(makeChunk(2, 0, 2, 4));

    expect(fail).toHaveBeenCalledTimes(1);
    const err = fail.mock.calls[0][0] as ConnectionError;
    expect(err.kind).toBe("protocol");
    expect(err.message).toBe("inbound WebRTC frame could not be reassembled");
    expect(conn.handledChunks).toBe(1);
  });

  test.each([
    ["typed-array view", new Uint8Array(0)],
    ["ArrayBuffer", new ArrayBuffer(0)],
  ])("refuses an empty %s slice", (_label, data) => {
    const conn = new FakeChunkedConnection();
    const fail = install(conn);

    conn._handleChunk({ __peerData: 1, n: 0, total: 2, data } as never);

    expect(fail).toHaveBeenCalledTimes(1);
    expect((fail.mock.calls[0][0] as ConnectionError).message).toBe(
      "inbound WebRTC frame has a malformed chunk envelope: its chunk " +
        "payload is empty",
    );
    expect(conn.handledChunks).toBe(0);
  });

  test("accepts an ArrayBuffer slice as well as a typed-array view", () => {
    const conn = new FakeChunkedConnection();
    const fail = install(conn);

    conn._handleChunk({
      __peerData: 1,
      n: 0,
      total: 2,
      data: new ArrayBuffer(4),
    } as never);

    expect(fail).not.toHaveBeenCalled();
    expect(conn.handledChunks).toBe(1);
  });
});

describe("boundChunkReassembly: deserialized-structure bound at the unpack chokepoint", () => {
  test("rejects a map keyed by a non-string, naming the map-key rule", () => {
    const conn = new FakeChunkedConnection();
    const fail = install(conn);

    // fixmap(1) keyed by a fixint: the property name `unpack_map` coerces such a
    // key to is not bounded by what declares it.
    conn._handleDataMessage({ data: new Uint8Array([0x81, 0x07, 0x08]) });

    expect(fail).toHaveBeenCalledTimes(1);
    expect((fail.mock.calls[0][0] as ConnectionError).message).toBe(
      "inbound WebRTC frame keys a map with a value that is not a string",
    );
    expect(conn.delivered).toEqual([]);
  });

  test("rejects a deep nested-array spine by the bytes-that-follow check", () => {
    const conn = new FakeChunkedConnection();
    const fail = install(conn);

    // Eight nested array32 each declaring 999000: each header declares far more
    // elements than the bytes that follow it, so the first is refused.
    conn._handleDataMessage({ data: nestedArrayHeaders(999000, 8) });

    expect(fail).toHaveBeenCalledTimes(1);
    expect((fail.mock.calls[0][0] as ConnectionError).message).toBe(
      "inbound WebRTC frame declares a container with more elements than the " +
        "bytes behind it can encode",
    );
    expect(conn.delivered).toEqual([]);
  });

  test("rejects a spine nested deeper than the depth cap, naming that cap", () => {
    const conn = new FakeChunkedConnection();
    const fail = install(conn, { maxReassemblyDepth: 4 });

    // Ten fixarray(1) levels over one fixint leaf: every level is byte-backed, so
    // only the depth cap can refuse it.
    const spine = new Uint8Array([...new Array<number>(10).fill(0x91), 0x01]);
    conn._handleDataMessage({ data: spine });

    expect(fail).toHaveBeenCalledTimes(1);
    expect((fail.mock.calls[0][0] as ConnectionError).message).toBe(
      "inbound WebRTC frame exceeds its 4-level nesting limit",
    );
    expect(conn.delivered).toEqual([]);
  });

  test("rejects an array declaring more elements than the bytes that follow", () => {
    const conn = new FakeChunkedConnection();
    // The bytes-that-follow check is what catches the zero-filled-array vector (a
    // 5-byte header declaring a million elements).
    const fail = install(conn);

    conn._handleDataMessage({ data: array32Header(1_000_000) });

    expect(fail).toHaveBeenCalledTimes(1);
    expect((fail.mock.calls[0][0] as ConnectionError).message).toBe(
      "inbound WebRTC frame declares a container with more elements than the " +
        "bytes behind it can encode",
    );
    expect(conn.delivered).toEqual([]);
  });

  test("rejects a string declaring more bytes than the per-string cap", () => {
    const conn = new FakeChunkedConnection();
    const fail = install(conn, { maxStringBytes: 100 });

    conn._handleDataMessage({ data: str32Header(1000) });

    expect(fail).toHaveBeenCalledTimes(1);
    const err = fail.mock.calls[0][0] as ConnectionError;
    expect(err.kind).toBe("protocol");
    expect(err.message).toBe(
      "inbound WebRTC frame exceeds its 100-byte string limit",
    );
    expect(conn.delivered).toEqual([]);
  });

  test("accepts a small valid structure and delegates to unpack", () => {
    const conn = new FakeChunkedConnection();
    const fail = install(conn);

    conn._handleDataMessage({ data: arrayOfFixints(50) });

    expect(fail).not.toHaveBeenCalled();
    expect(conn.delivered).toHaveLength(1);
  });

  test("accepts a legitimate mapped-element frame at the production limits", () => {
    const conn = new FakeChunkedConnection();
    const fail = install(conn);

    conn._handleDataMessage({ data: mappedElementFrame(500) });

    expect(fail).not.toHaveBeenCalled();
    expect(conn.delivered).toHaveLength(1);
  });

  test("accepts a binary value whatever payload it declares", () => {
    const conn = new FakeChunkedConnection();
    const fail = install(conn);

    // A raw16 declaring a 10-byte payload: the scan skips the payload rather than
    // reading it, so a real binary set frame is the wire cap's concern.
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
    const fail = install(conn, { maxFrameBytes: 1_000_000 });

    // An over-declared array delivered as two chunks: the scan runs on the
    // reassembled buffer via the recursive _handleDataMessage call.
    const frame = new Uint8Array([...array32Header(1_000_000), 0x01, 0x01]);
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
    expect((fail.mock.calls[0][0] as ConnectionError).message).toBe(
      "inbound WebRTC frame declares a container with more elements than the " +
        "bytes behind it can encode",
    );
    expect(conn.delivered).toEqual([]);
  });

  test("caps a single string at the file size the CSV intake accepts", () => {
    // The per-string cap is set to the intake cap because a payload cell is not
    // length-bounded upstream: a cell that reached the wire from an admitted file
    // must not be refused here. Core cannot import the app that owns the intake
    // cap, so the two are held together here.
    expect(MAX_WEBRTC_STRING_BYTES).toBe(MAX_CSV_FILE_BYTES);
  });

  test("keeps the set frame of a file at the intake cap inside the frame envelope", () => {
    // The narrowest row shape docs/spec/PROTOCOL.md measures is a two-column id
    // and email file at 33.5 bytes a row. One distinct key value per row puts
    // one 35-byte encrypted element per row in a single set frame, so an
    // intake cap past about 245 MiB would admit a file whose set frame the
    // receiving tab refuses mid-exchange.
    const narrowestBytesPerRow = 33.5;
    const encryptedElementBytes = 35;
    const rowsAtCap = Math.ceil(MAX_CSV_FILE_BYTES / narrowestBytesPerRow);
    expect(rowsAtCap * encryptedElementBytes).toBeLessThan(
      MAX_WEBRTC_FRAME_BYTES,
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
