import { describe, expect, test, vi } from "vitest";

import { ConnectionError } from "@psilink/core";

import {
  boundChunkReassembly,
  checkDeliveredFrameBound,
} from "../../src/psi/boundedReassembly.js";

import type { DataConnection } from "peerjs";

interface Chunk {
  __peerData: number;
  n: number;
  total: number;
  data: Uint8Array;
}

/**
 * A faithful model of the PeerJS binary connection's chunk reassembly: it
 * accumulates slices into `_chunkedData` keyed by message id and deletes the
 * entry once the frame completes -- the exact lifecycle boundChunkReassembly
 * wraps. `completed` records each id whose frame finished, for observation.
 */
class FakeChunkedConnection {
  _chunkedData: Record<number, { data: Array<Uint8Array>; count: number }> = {};
  completed: Array<number> = [];

  _handleChunk = (chunk: Chunk): void => {
    const id = chunk.__peerData;
    const info = this._chunkedData[id] ?? { data: [], count: 0 };
    info.data[chunk.n] = chunk.data;
    info.count++;
    this._chunkedData[id] = info;
    if (info.count === chunk.total) {
      delete this._chunkedData[id];
      this.completed.push(id);
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

function install(
  conn: FakeChunkedConnection,
  options?: { maxFrameBytes?: number; maxConcurrentReassemblies?: number },
) {
  const fail = vi.fn();
  boundChunkReassembly(conn as unknown as DataConnection, fail, options);
  return fail;
}

describe("boundChunkReassembly", () => {
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
    // The over-cap chunk was never delegated to the original, so only the two
    // in-cap chunks were stored -- allocation did not track the peer's claim.
    expect(conn._chunkedData[1].count).toBe(2);
  });

  test("accepts an at-cap frame and completes it", () => {
    const conn = new FakeChunkedConnection();
    const fail = install(conn, { maxFrameBytes: 100 });

    conn._handleChunk(makeChunk(2, 0, 2, 50)); // 50
    conn._handleChunk(makeChunk(2, 1, 2, 50)); // 100, exactly at cap -> accepted

    expect(fail).not.toHaveBeenCalled();
    expect(conn.completed).toEqual([2]);
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
    expect(conn.completed).toEqual([3, 4]);
  });

  test("bounds the aggregate of concurrent partials by the running total", () => {
    const conn = new FakeChunkedConnection();
    const fail = install(conn, {
      maxFrameBytes: 100,
      maxConcurrentReassemblies: 8,
    });

    conn._handleChunk(makeChunk(1, 0, 5, 60)); // 60
    conn._handleChunk(makeChunk(2, 0, 5, 60)); // 60 + 60 = 120 > 100, no single frame over cap

    expect(fail).toHaveBeenCalledTimes(1);
    expect((fail.mock.calls[0][0] as ConnectionError).kind).toBe("protocol");
  });

  test("evicts the oldest partial beyond the concurrent cap rather than retaining it", () => {
    const conn = new FakeChunkedConnection();
    const fail = install(conn, {
      maxFrameBytes: 1_000_000,
      maxConcurrentReassemblies: 2,
    });

    // Five never-completed partials from distinct ids, each one chunk of a
    // claimed-5-chunk frame. Only the two most recent are retained.
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
    conn._handleChunk(makeChunk(2, 0, 5, 60)); // new id evicts #1 (frees 60), then stores 60

    expect(fail).not.toHaveBeenCalled();
    expect(conn.partialCount).toBe(1);
    expect(Object.keys(conn._chunkedData).map(Number)).toEqual([2]);
  });

  test("drops every chunk once it has failed the connection", () => {
    const conn = new FakeChunkedConnection();
    const fail = install(conn, { maxFrameBytes: 100 });

    conn._handleChunk(makeChunk(1, 0, 10, 60)); // 60, stored
    conn._handleChunk(makeChunk(1, 1, 10, 60)); // 120 > 100 -> fail, not stored
    expect(fail).toHaveBeenCalledTimes(1);
    const partialsAtFailure = conn.partialCount;

    // Post-failure chunks -- a small one for the failed id and one for a fresh id
    // -- must not re-enter the new-frame path, reach the original handler, or
    // re-fire fail(); the connection is already terminal.
    conn._handleChunk(makeChunk(1, 2, 10, 1));
    conn._handleChunk(makeChunk(2, 0, 10, 1));

    expect(fail).toHaveBeenCalledTimes(1);
    expect(conn.partialCount).toBe(partialsAtFailure);
    expect(conn.completed).toEqual([]);
  });

  test("counts a string chunk by byte residency, not character length", () => {
    const conn = new FakeChunkedConnection();
    const fail = install(conn, { maxFrameBytes: 10 });

    // Six characters is 6 by length but 12 resident bytes (UTF-16 x2), over the
    // 10-byte cap; counting characters would undercount and miss the bound.
    conn._handleChunk({
      __peerData: 1,
      n: 0,
      total: 2,
      data: "abcdef",
    } as unknown as Chunk);

    expect(fail).toHaveBeenCalledTimes(1);
    expect((fail.mock.calls[0][0] as ConnectionError).kind).toBe("protocol");
  });

  test("throws when the PeerJS chunk internals are absent", () => {
    expect(() =>
      boundChunkReassembly({} as unknown as DataConnection, vi.fn()),
    ).toThrow(/chunk-reassembly internals/);
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
