import { describe, expect, test, vi } from "vitest";

import { pack, unpack } from "peerjs-js-binarypack";

import {
  MAX_WEBRTC_FRAME_BYTES,
  MAX_WEBRTC_FRAME_STRUCTURE_BYTES,
  MAX_WEBRTC_STRING_BYTES,
  WEBRTC_VALUE_WEIGHTS,
  scanFrameStructure,
} from "@psilink/core";

import { normalizeBinary } from "@psilink/testkit/webrtcInboundFrames";

import { boundChunkReassembly } from "../../src/psi/transport/boundedReassembly.js";

import type { Packable, Unpackable } from "peerjs-js-binarypack";
import type { ConnectionError } from "@psilink/core";
import type { DataConnection } from "peerjs";

// This suite is the differential counterpart to boundedReassembly.test.ts: rather
// than hand-rolled BinaryPack fixtures, it drives the bounded reassembler against
// the real peerjs-js-binarypack `pack`/`unpack` (the library peerjs uses on the
// wire, reached through apps/web's own `peerjs`/`peerjs-js-binarypack`
// dependency), so a divergence between the defensive pre-scan and the real
// unpacker is caught. The pre-scan under test is core's
// (`connection/binaryPackBounds.ts`), imported rather than mocked; this suite
// lives here, not beside that module, because only this workspace declares the
// real packer.

/** The real PeerJS chunk MTU (peerjs/dist/bundler chunker), the boundary at which
 * a packed frame is split into `_handleChunk` slices on the wire. */
const PEERJS_CHUNK_MTU = 16300;

/**
 * The budget for the whole-corpus differential below, vitest's 5s default being
 * the wrong scale for it: it re-chunks every corpus frame a byte at a time
 * through a fresh reassembler, which is pure CPU and scales with machine load --
 * measured up to 6.2s worst case under container load, an order of magnitude
 * under this budget. Not a timing assertion: nothing waits for it to elapse on a
 * healthy run.
 */
const CORPUS_DIFFERENTIAL_TIMEOUT_MS = 60_000;

/** Encode a value with the real BinaryPack packer and return the wire bytes. The
 * packer returns a Promise only for `Blob` inputs, which the corpus never uses, so
 * the buffer is always available synchronously; the await keeps the type accurate. */
async function packBytes(value: Packable): Promise<Uint8Array> {
  const buf = await pack(value);
  return new Uint8Array(buf);
}

/** Unpack a reassembled frame. The published `unpack` type declares an
 * `ArrayBuffer`, but the implementation wraps its argument in `new Uint8Array(...)`
 * and reads `byteLength`/`slice`, so a `Uint8Array` view is exactly what PeerJS
 * hands it on the wire (the reassembled buffer). This adapter is the one place that
 * bridges the declared type to the real call shape. */
function unpackFrame(bytes: Uint8Array): Unpackable {
  return unpack<Unpackable>(bytes as unknown as ArrayBuffer);
}

interface Chunk {
  __peerData: number;
  n: number;
  total: number;
  data: Uint8Array;
}

/** Split `bytes` into PeerJS-style chunk envelopes at a fixed MTU (default the real
 * `PEERJS_CHUNK_MTU`), mirroring the real chunker: `total` is the chunk count, `n`
 * the index, `data` the slice. A zero-length frame yields one empty chunk. */
function chunkAtMtu(
  bytes: Uint8Array,
  id: number,
  mtu: number = PEERJS_CHUNK_MTU,
): Array<Chunk> {
  const total = Math.max(1, Math.ceil(bytes.length / mtu));
  const chunks: Array<Chunk> = [];
  for (let n = 0, start = 0; n < total; n++) {
    const end = Math.min(bytes.length, start + mtu);
    chunks.push({ __peerData: id, n, total, data: bytes.subarray(start, end) });
    start = end;
  }
  return chunks;
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
 * A test double for the PeerJS binary connection's reassembly/unpack surface,
 * reassembling exactly as real PeerJS does (accumulate slices keyed by message id,
 * store the total from the first chunk, and on completion concatenate and recurse
 * into `_handleDataMessage`). `_handleDataMessage` records the delivered wire bytes
 * so the differential can `unpack` them and compare against the real unpacker's
 * result on the original frame.
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
}

/** Install the bound guard with the production structural budget and per-string
 * cap, so a rejection would mean the pre-scan diverged from the real unpacker on a
 * legitimate frame -- not that a tiny test budget fired. */
function installProduction(conn: FakeChunkedConnection) {
  const fail = vi.fn();
  boundChunkReassembly(conn as unknown as DataConnection, fail, {
    // Never let the wire-byte or chunk-count caps fire for a corpus frame: this
    // suite isolates the structural pre-scan's agreement with the real unpacker.
    maxFrameBytes: Number.MAX_SAFE_INTEGER,
    maxChunks: Number.MAX_SAFE_INTEGER,
    minChunkResidentBytes: 0,
    maxStructureBytes: MAX_WEBRTC_FRAME_STRUCTURE_BYTES,
    maxStringBytes: MAX_WEBRTC_STRING_BYTES,
  });
  return fail;
}

/** Install the guard with a chosen structural budget, every other bound held wide,
 * so only the pre-scan can fail a frame. */
function installAtBudget(
  conn: FakeChunkedConnection,
  maxStructureBytes: number,
) {
  const fail = vi.fn();
  boundChunkReassembly(conn as unknown as DataConnection, fail, {
    maxFrameBytes: Number.MAX_SAFE_INTEGER,
    maxChunks: Number.MAX_SAFE_INTEGER,
    minChunkResidentBytes: 0,
    maxStructureBytes,
    maxStringBytes: MAX_WEBRTC_STRING_BYTES,
  });
  return fail;
}

/** A chain of `levels` `array32` headers, each declaring `declared` children, with
 * `padding` one-byte values behind the innermost -- so every level declares no more
 * children than the bytes that follow it, and the wire spends its element bytes once
 * rather than once per level. */
function nestedArrayFrame(
  levels: number,
  declared: number,
  padding: number,
): Uint8Array {
  const parts: Array<number> = [];
  for (let i = 0; i < levels; i++) {
    parts.push(
      0xdd,
      (declared >>> 24) & 0xff,
      (declared >>> 16) & 0xff,
      (declared >>> 8) & 0xff,
      declared & 0xff,
    );
  }
  for (let i = 0; i < padding; i++) parts.push(0x01);
  return new Uint8Array(parts);
}

/** An `array32` declaring `count` elements, each the real packer's encoding of an
 * empty binary value, so the declared `bin`/`raw` inventory is driven at a count no
 * `array16` header can express and every element byte is the encoder's. */
async function binaryArrayFrame(count: number): Promise<Uint8Array> {
  const element = await packBytes(new ArrayBuffer(0));
  const body = new Uint8Array(count * element.length);
  for (let i = 0; i < count; i++) body.set(element, i * element.length);
  return wideContainerFrame(0xdd, count, body);
}

/** A `map16` of `count` pairs whose keys are whatever `key(i)` returns, each run
 * through the real packer -- a shape no JS object can be packed into once the keys
 * are not strings, but one the real `unpack_map` reads and turns into property
 * names. Only the map header is assembled. */
async function keyedMapFrame(
  count: number,
  key: (i: number) => Packable,
): Promise<Uint8Array> {
  const parts: Array<Uint8Array> = [
    new Uint8Array([0xde, (count >>> 8) & 0xff, count & 0xff]),
  ];
  for (let i = 0; i < count; i++) {
    parts.push(await packBytes(key(i)));
    parts.push(await packBytes(i & 0x7f));
  }
  return concatSlices(parts);
}

/** A deterministic 32-bit PRNG (mulberry32). Seeded per corpus so generated nested
 * structures are fixed run-to-run -- no unseeded randomness gates an assertion. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A fixed spread of primitive and string values, chosen to exercise every
 * BinaryPack marker the packer emits: fixint boundaries, the uint/int width
 * escalation, float/double, the booleans/null/undefined singletons, fixstr vs.
 * str16 vs. str32 length cutoffs, and multibyte (2/3/4 UTF-8 byte) code points. */
const PRIMITIVE_CORPUS: Array<Packable> = [
  0,
  1,
  -1,
  31,
  -32,
  127,
  128,
  255,
  256,
  -33,
  -128,
  -129,
  32767,
  -32768,
  -32769,
  65535,
  65536,
  2147483647,
  -2147483648,
  4294967296,
  0.5,
  -0.5,
  3.14159,
  1e-10,
  1234.5678,
  true,
  false,
  null,
  undefined,
  "",
  "a",
  "abc",
  "x".repeat(15), // last fixstr length
  "y".repeat(16), // first str16 length
  "z".repeat(300), // wide str16
  "café", // 2-byte UTF-8 (é)
  "日本語", // 3-byte UTF-8
  "😀🎉", // 4-byte UTF-8 (surrogate-pair code points)
  "mixed: a é 語 😀 end",
];

/** Binary inputs: fixraw (<= 15 bytes), raw16 (> 15), and typed-array views the
 * packer routes through `pack_bin`. Encoded fresh each call so a corpus is a plain
 * value list. */
function binaryCorpus(): Array<Packable> {
  const fixraw = new Uint8Array([1, 2, 3, 254, 255]).buffer; // 5 bytes -> fixraw
  const raw16 = new Uint8Array(300);
  for (let i = 0; i < raw16.length; i++) raw16[i] = (i * 7) & 0xff;
  const view = new Uint8Array([9, 8, 7, 6, 5]); // typed-array view -> pack_bin
  return [fixraw, raw16.buffer, view];
}

/** A seeded generator of nested arrays/objects mixing every value kind, so the
 * differential covers deep structure (the array/object recursion in both the real
 * unpacker and the pre-scan), not only flat frames. */
function nestedCorpus(seed: number, count: number): Array<Packable> {
  const rand = mulberry32(seed);
  const pick = <T>(xs: Array<T>): T => xs[Math.floor(rand() * xs.length)];

  const leaf = (): Packable =>
    pick<Packable>([
      Math.floor(rand() * 1000) - 500,
      rand() * 2 - 1,
      pick([true, false, null, undefined]),
      "k" + Math.floor(rand() * 1000).toString(),
      "é語".repeat(1 + Math.floor(rand() * 3)),
      new Uint8Array([1, 2, 3, Math.floor(rand() * 256)]).buffer,
    ]);

  const build = (depth: number): Packable => {
    if (depth <= 0) return leaf();
    const n = Math.floor(rand() * 4);
    if (rand() < 0.5) {
      const arr: Array<Packable> = [];
      for (let i = 0; i < n; i++) arr.push(build(depth - 1));
      return arr;
    }
    const obj: { [key: string]: Packable } = {};
    for (let i = 0; i < n; i++) obj["key" + i.toString()] = build(depth - 1);
    return obj;
  };

  const out: Array<Packable> = [];
  for (let i = 0; i < count; i++) out.push(build(3));
  return out;
}

/** The mapped-element frame shape the WebRTC transport actually sends -- an array
 * of `{theirIndex, iteration}` records -- so the differential covers the real
 * in-protocol frame, not only synthetic shapes. */
function mappedElementFrame(n: number): Array<Packable> {
  const out: Array<{ theirIndex: number; iteration: number }> = [];
  for (let i = 0; i < n; i++) out.push({ theirIndex: i, iteration: i % 3 });
  return out;
}

/** A BinaryPack `array32`/`map32` header (marker byte plus a 4-byte big-endian
 * element count) followed by `body`, matching `pack_array`/`pack_object`'s
 * wide-container encoding. The pinned packer (peerjs-js-binarypack 2.1.0) recurses
 * once per element and overflows the call stack far below the 65536-element
 * threshold, so it cannot emit these two markers; `unpack_array`/`unpack_map` has
 * no such limit and decodes them normally. These frames are assembled to the same
 * wire encoding the packer would produce were it iterative, and their reference
 * value comes from the real `unpack` -- only the encoder is stack-bounded here,
 * not the wire format or its decode. */
function wideContainerFrame(marker: number, count: number, body: Uint8Array) {
  const frame = new Uint8Array(5 + body.length);
  frame[0] = marker;
  frame[1] = (count >>> 24) & 0xff;
  frame[2] = (count >>> 16) & 0xff;
  frame[3] = (count >>> 8) & 0xff;
  frame[4] = count & 0xff;
  frame.set(body, 5);
  return frame;
}

/** Wire frames for the wide BinaryPack container/scalar markers the size-bounded
 * corpus above never crosses (`map16`, `map32`, `array32`, `str32`, `raw32`). The
 * `array32`/`map32` amplification vectors are exactly what the structural budget
 * exists to bound, so the differential must charge them the same inventory the real
 * unpacker builds. `map16`, `str32`, and `raw32` are packed from real values;
 * `array32`/`map32` are assembled by {@link wideContainerFrame} because the pinned
 * packer cannot emit them. All content is deterministic. */
async function wideMarkerCorpus(): Promise<
  Array<{ label: string; packed: Uint8Array }>
> {
  const map16: { [key: string]: Packable } = {};
  for (let i = 0; i < 16; i++) map16["field" + i.toString()] = i;

  const str32 = "s".repeat(70000); // > 65535 wire bytes -> str32, under the 1 MiB cap
  const raw32 = new Uint8Array(70000);
  for (let i = 0; i < raw32.length; i++) raw32[i] = (i * 31 + 7) & 0xff;

  const array32Count = 65536;
  const array32Body = new Uint8Array(array32Count); // element count positive fixints
  for (let i = 0; i < array32Count; i++) array32Body[i] = i & 0x7f;

  const map32Count = 65536;
  const map32Parts: Array<Uint8Array> = [];
  for (let i = 0; i < map32Count; i++) {
    map32Parts.push(await packBytes("k" + i.toString()));
    map32Parts.push(await packBytes(i & 0x7f));
  }
  const map32Body = concatSlices(map32Parts);

  return [
    { label: "map16", packed: await packBytes(map16) },
    { label: "str32", packed: await packBytes(str32) },
    { label: "raw32", packed: await packBytes(raw32.buffer) },
    {
      label: "array32",
      packed: wideContainerFrame(0xdd, array32Count, array32Body),
    },
    { label: "map32", packed: wideContainerFrame(0xdf, map32Count, map32Body) },
  ];
}

/** Every frame the differential drives, labeled for a readable failure and held
 * as its real wire bytes. Most entries are a `Packable` run through the real packer;
 * the wide-container markers the packer cannot emit are assembled bytes (see
 * {@link wideMarkerCorpus}). Every consumer walks the same `packed` bytes, so each
 * case -- packed or assembled -- gets the identical strength of check. */
async function corpus(): Promise<Array<{ label: string; packed: Uint8Array }>> {
  const values: Array<{ label: string; value: Packable }> = [];
  PRIMITIVE_CORPUS.forEach((value, i) =>
    values.push({ label: `primitive[${i}]`, value }),
  );
  binaryCorpus().forEach((value, i) =>
    values.push({ label: `binary[${i}]`, value }),
  );
  values.push({ label: "primitives-array", value: [...PRIMITIVE_CORPUS] });
  values.push({
    label: "object",
    value: { theirIndex: 7, iteration: 2, status: "matched", note: "café 😀" },
  });
  nestedCorpus(0x5eed1234, 24).forEach((value, i) =>
    values.push({ label: `nested[${i}]`, value }),
  );
  [0, 1, 2, 50, 512].forEach((n) =>
    values.push({ label: `mapped-frame[${n}]`, value: mappedElementFrame(n) }),
  );

  const entries: Array<{ label: string; packed: Uint8Array }> = [];
  for (const { label, value } of values) {
    entries.push({ label, packed: await packBytes(value) });
  }
  entries.push(...(await wideMarkerCorpus()));
  return entries;
}

describe("boundedReassembly differential: real peerjs-js-binarypack", () => {
  test(
    "delivers the exact wire bytes and unpacks to the real unpacker's result",
    { timeout: CORPUS_DIFFERENTIAL_TIMEOUT_MS },
    async () => {
      for (const { label, packed } of await corpus()) {
        const conn = new FakeChunkedConnection();
        const fail = installProduction(conn);
        for (const chunk of chunkAtMtu(packed, 1)) conn._handleChunk(chunk);

        expect(
          fail,
          `${label}: pre-scan rejected a real-encoded frame`,
        ).not.toHaveBeenCalled();
        expect(
          conn.delivered,
          `${label}: not delivered exactly once`,
        ).toHaveLength(1);

        const delivered = conn.delivered[0];
        expect(
          Array.from(delivered),
          `${label}: reassembled bytes diverge from the packed frame`,
        ).toEqual(Array.from(packed));

        const reassembledValue = normalizeBinary(unpackFrame(delivered));
        const referenceValue = normalizeBinary(unpackFrame(packed));
        expect(
          reassembledValue,
          `${label}: reassembled frame unpacks differently than the real unpacker`,
        ).toEqual(referenceValue);
      }
    },
  );

  test("reassembles a multi-chunk frame the same as one delivery", async () => {
    // A frame large enough to cross the real 16300-byte MTU into several chunks, so
    // the completion recursion path (not just the single-frame path) is exercised
    // against the real packer.
    const value = mappedElementFrame(4000);
    const packed = await packBytes(value);
    expect(
      packed.length,
      "frame did not exceed the MTU; multi-chunk path not exercised",
    ).toBeGreaterThan(PEERJS_CHUNK_MTU);

    const conn = new FakeChunkedConnection();
    const fail = installProduction(conn);
    const chunks = chunkAtMtu(packed, 1);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) conn._handleChunk(chunk);

    expect(fail).not.toHaveBeenCalled();
    expect(conn.delivered).toHaveLength(1);
    expect(Array.from(conn.delivered[0])).toEqual(Array.from(packed));
    expect(unpackFrame(conn.delivered[0])).toEqual(unpackFrame(packed));
  });

  test("splits at every byte boundary without changing the outcome", async () => {
    // The reassembler must be insensitive to WHERE the chunk cuts fall: a value
    // encoded once, then re-chunked at every possible 1-byte MTU, must always
    // reassemble to the same bytes and unpack to the same value. This stresses cuts
    // landing mid-marker, mid-length-prefix, and mid-payload against the real
    // packer's output.
    const value = {
      theirIndex: 65537,
      iteration: 2,
      label: "café 日本 😀",
      tags: ["a", "bb", 128, -129, 3.5, null, [1, 2, [3]]],
    };
    const packed = await packBytes(value);
    const reference = unpackFrame(packed);

    for (let mtu = 1; mtu <= packed.length; mtu++) {
      const conn = new FakeChunkedConnection();
      const fail = installProduction(conn);
      for (const chunk of chunkAtMtu(packed, 1, mtu)) conn._handleChunk(chunk);

      expect(
        fail,
        `mtu=${mtu}: pre-scan rejected the frame`,
      ).not.toHaveBeenCalled();
      expect(conn.delivered, `mtu=${mtu}: not delivered once`).toHaveLength(1);
      expect(
        Array.from(conn.delivered[0]),
        `mtu=${mtu}: reassembled bytes diverge`,
      ).toEqual(Array.from(packed));
      expect(
        unpackFrame(conn.delivered[0]),
        `mtu=${mtu}: unpacks differently`,
      ).toEqual(reference);
    }
  });
});

describe("scanFrameStructure differential: agrees with the real unpacker", () => {
  test("never rejects a real-encoded corpus frame under the production budget", async () => {
    // The pre-scan is a defensive superset of the real unpacker's marker dispatch:
    // any frame the real unpacker accepts within the memory envelope, the scan must
    // admit (no false rejection). Every corpus value is a legitimate, small frame far
    // under the production budget, so a refusal here is a divergence -- a marker the
    // scan mis-reads relative to `Unpacker.unpack`.
    for (const { label, packed } of await corpus()) {
      expect(
        scanFrameStructure(
          packed,
          MAX_WEBRTC_FRAME_STRUCTURE_BYTES,
          256,
          MAX_WEBRTC_STRING_BYTES,
        ),
        `${label}: scan rejected a frame the real unpacker accepts`,
      ).toBeUndefined();
    }
  });

  test("charges exactly the modelled cost of the frame's real marker inventory", async () => {
    // A stronger differential than "does not reject": the pre-scan's accept/reject
    // boundary must sit at the exact cost the frame's real marker inventory implies
    // under the published weights. An independent walk (referenceWalk, mirroring
    // Unpacker.unpack's dispatch) sums each value's WEBRTC_VALUE_WEIGHTS cost from
    // the real-encoded bytes; scanFrameStructure must accept at exactly that budget
    // and reject one byte below it. Both sides score by the same weight model, so
    // this pins the scan to the model rather than the model to the heap; every kind
    // the corpus holds is scored, `bin`/`raw` included.
    for (const { label, packed } of await corpus()) {
      const { cost, endOffset, nonStringKey } = referenceWalk(packed);
      // The reference walk must consume the whole real-encoded frame; a short read
      // would mean the reference itself mis-modeled a marker, invalidating `cost`.
      expect(
        endOffset,
        `${label}: reference walk did not consume the frame`,
      ).toBe(packed.length);
      // The assumption the cost comparison rests on -- no corpus frame the real
      // packer emits holds a map key the scan refuses -- established on this
      // independent oracle rather than only through the scan accepting the frame.
      expect(
        nonStringKey,
        `${label}: the real packer emitted a non-string map key`,
      ).toBe(false);
      expect(
        scanFrameStructure(packed, cost, 256, MAX_WEBRTC_STRING_BYTES),
        `${label}: scan rejected at its own reference cost`,
      ).toBeUndefined();
      expect(
        scanFrameStructure(packed, cost - 1, 256, MAX_WEBRTC_STRING_BYTES),
        `${label}: scan accepted one byte below its reference cost`,
      ).toEqual({ rule: "structure-bytes", limit: cost - 1 });
    }
  });
});

describe("boundedReassembly on the shapes the wire size understates", () => {
  // The corpus above is what a real encoder produces, and in all of it the wire
  // sends every declared value at a size that says what it retains. These are the
  // shapes where what `unpack` retains is decided by something else -- a declared
  // count an ancestor reserves room for, a declared value that decodes to far more
  // than the byte that declared it, and a key the assignment coerces into a property
  // name -- driven through the web wrap rather than against the scan alone, so the
  // enforcement this transport actually installs is what the assertions see.

  test("fails closed on a nested chain whose reserved stores exceed the production budget", () => {
    const frame = nestedArrayFrame(200, 700_000, 700_000);
    // Far below the wire-byte cap, so nothing but the structural pre-scan can be
    // what refuses it.
    expect(frame.byteLength).toBeLessThan(1024 * 1024);

    const conn = new FakeChunkedConnection();
    const fail = installProduction(conn);
    for (const chunk of chunkAtMtu(frame, 1)) conn._handleChunk(chunk);

    expect(fail).toHaveBeenCalledTimes(1);
    expect(conn.delivered).toHaveLength(0);
  });

  test("fails closed on a frame whose declared bin/raw views exceed the budget", async () => {
    // A `bin`/`raw` element is one wire byte here and decodes to a view of its own,
    // so this frame's retained cost is decided by the count it declares rather than
    // by its size. Driven through the wrap at the production structural budget, with
    // the wire-byte and chunk caps held wide, so the structural pre-scan is the only
    // bound that can refuse it.
    const frame = await binaryArrayFrame(5_000_000);
    expect(frame.byteLength).toBeLessThan(MAX_WEBRTC_FRAME_BYTES);

    const conn = new FakeChunkedConnection();
    const fail = installProduction(conn);
    for (const chunk of chunkAtMtu(frame, 1)) conn._handleChunk(chunk);

    expect(fail).toHaveBeenCalledTimes(1);
    expect(conn.delivered).toHaveLength(0);
  });

  test("delivers the same shape while its declared views stay within the budget", async () => {
    // The refusal above is the budget acting on the declared count, not the wrap
    // refusing binary content: the identical shape an order of magnitude smaller is
    // delivered, and the real unpacker builds one retained view per element from it.
    const count = 500_000;
    const frame = await binaryArrayFrame(count);

    const conn = new FakeChunkedConnection();
    const fail = installProduction(conn);
    for (const chunk of chunkAtMtu(frame, 1)) conn._handleChunk(chunk);

    expect(fail).not.toHaveBeenCalled();
    expect(conn.delivered).toHaveLength(1);

    const decoded = unpackFrame(conn.delivered[0]) as Array<unknown>;
    expect(decoded).toHaveLength(count);
    expect(ArrayBuffer.isView(decoded[0])).toBe(true);
  });

  test("fails closed on a non-string-key map a string-keyed one of the same width passes", async () => {
    // Two maps of the same pair count and near-identical wire size: one keyed by
    // real-packed strings, one by real-packed doubles. The string-keyed frame is
    // costed and passes at its own budget; the numeric-keyed one is refused for its
    // keys, so it does not get through at that budget or at any other.
    const pairs = 100;
    const stringKeys = await keyedMapFrame(pairs, (i) => `k${i.toString()}`);
    const numericKeys = await keyedMapFrame(pairs, (i) => (i + 1) * Math.PI);
    const budget = referenceWalk(stringKeys).cost;
    expect(referenceWalk(stringKeys).nonStringKey).toBe(false);
    expect(referenceWalk(numericKeys).nonStringKey).toBe(true);

    const accepting = new FakeChunkedConnection();
    const acceptFail = installAtBudget(accepting, budget);
    for (const chunk of chunkAtMtu(stringKeys, 1))
      accepting._handleChunk(chunk);
    expect(acceptFail).not.toHaveBeenCalled();
    expect(accepting.delivered).toHaveLength(1);

    for (const wideBudget of [budget, MAX_WEBRTC_FRAME_STRUCTURE_BYTES]) {
      const refusing = new FakeChunkedConnection();
      const refuseFail = installAtBudget(refusing, wideBudget);
      for (const chunk of chunkAtMtu(numericKeys, 1))
        refusing._handleChunk(chunk);
      expect(refuseFail).toHaveBeenCalledTimes(1);
      // The failure names the key rule rather than the budget it was not over.
      expect((refuseFail.mock.calls[0][0] as ConnectionError).message).toBe(
        "inbound WebRTC frame keys a map with a value that is not a string",
      );
      expect(refusing.delivered).toHaveLength(0);
    }
  });

  test("fails closed on a non-string key whose subtree underruns the frame", () => {
    // A non-string map key combined with a cursor underrun, driven through the web
    // wrap: a map key declaring 8 levels of 20,000 children with only the innermost
    // level on the wire, so the scan's cursor underruns inside the key subtree. The
    // real unpacker zero-fills every declared descendant and joins the lot into one
    // coerced property name; the wrap must refuse the frame before it unpacks.
    const levels = 8;
    const width = 20_000;
    const parts: Array<Uint8Array> = [new Uint8Array([0x81])]; // fixmap(1)
    for (let i = 0; i < levels; i++) {
      parts.push(
        new Uint8Array([
          0xdd,
          (width >>> 24) & 0xff,
          (width >>> 16) & 0xff,
          (width >>> 8) & 0xff,
          width & 0xff,
        ]),
      );
    }
    parts.push(new Uint8Array(width).fill(0x01));
    let length = 0;
    for (const part of parts) length += part.length;
    const frame = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      frame.set(part, offset);
      offset += part.length;
    }

    // Far below the wire-byte cap, and its declared descendants far outrun it, so
    // nothing but the structural pre-scan can be what refuses it.
    expect(frame.byteLength).toBeLessThan(1024 * 1024);
    expect(frame.byteLength).toBeLessThan(levels * width);
    expect(referenceWalk(frame).nonStringKey).toBe(true);

    const conn = new FakeChunkedConnection();
    const fail = installProduction(conn);
    for (const chunk of chunkAtMtu(frame, 1)) conn._handleChunk(chunk);

    expect(fail).toHaveBeenCalledTimes(1);
    expect(conn.delivered).toHaveLength(0);
  });
});

/** Resident-byte weight of a string of `declaredBytes` wire bytes under the
 * published cost model (a SeqString header plus its UTF-16 characters). */
function stringWeightOf(declaredBytes: number): number {
  return (
    WEBRTC_VALUE_WEIGHTS.stringBase +
    WEBRTC_VALUE_WEIGHTS.stringPerByte * declaredBytes
  );
}

/**
 * Walks `bytes` with the real unpacker's marker semantics and sums the retained
 * cost under the published `WEBRTC_VALUE_WEIGHTS`: each container its own weight
 * plus a backing slot per declared child, each string its header-plus-per-byte
 * weight, each `bin`/`raw` value the fixed view overhead, and each number marker
 * wider than 16 bits the heap number it may box; a value charged no more than its
 * container's slot adds nothing further. `cost` is the exact budget the production
 * scan should charge; `endOffset` is where the real unpacker finishes. Not derived
 * from `scanFrameStructure`, so a marker-dispatch bug there shows as a boundary
 * mismatch here rather than being masked by a shared walk.
 *
 * `nonStringKey` reports the frame's map keys: the scan refuses a frame holding a
 * non-string key at any budget, so a flagged frame has no `cost` comparison to
 * make.
 */
function referenceWalk(bytes: Uint8Array): {
  cost: number;
  endOffset: number;
  nonStringKey: boolean;
} {
  let i = 0;
  let cost = 0;
  let nonStringKey = false;
  const u8 = (): number => bytes[i++];
  const u16 = (): number => u8() * 0x100 + u8();
  const u32 = (): number =>
    u8() * 0x1000000 + u8() * 0x10000 + u8() * 0x100 + u8();

  /** A value the weights charge no more than the slot its container already charged.
   * At a key position it is a key the scan refuses. */
  const slotOnly = (atKeyPosition: boolean): void => {
    if (atKeyPosition) nonStringKey = true;
  };

  /** A `bin`/`raw` value: the fixed per-value overhead of the view `unpack_raw`
   * returns, charged on top of its container's slot. Its payload is charged nothing,
   * being ~1x the value's wire bytes and bounded by the wire-byte cap. At a key
   * position it is a key the scan refuses. */
  const binaryValue = (atKeyPosition: boolean): void => {
    cost += WEBRTC_VALUE_WEIGHTS.binary;
    if (atKeyPosition) nonStringKey = true;
  };

  /** A number marker wider than 16 bits: the heap number its value is held in when
   * the container's slot cannot hold it, charged on top of that slot whatever the
   * marker holds. At a key position it is a key the scan refuses. */
  const boxedNumber = (atKeyPosition: boolean): void => {
    cost += WEBRTC_VALUE_WEIGHTS.boxedNumber;
    if (atKeyPosition) nonStringKey = true;
  };

  function one(atKeyPosition: boolean): void {
    const type = u8();
    if (type < 0x80) {
      slotOnly(atKeyPosition); // positive fixint
      return;
    }
    if ((type ^ 0xe0) < 0x20) {
      slotOnly(atKeyPosition); // negative fixint
      return;
    }
    let size: number;
    if ((size = type ^ 0xa0) <= 0x0f) {
      i += size; // fixraw
      binaryValue(atKeyPosition);
      return;
    }
    if ((size = type ^ 0xb0) <= 0x0f) {
      i += size; // fixstr: a string is its own property name, charged in full
      cost += stringWeightOf(size);
      return;
    }
    if ((size = type ^ 0x90) <= 0x0f) {
      container(size, WEBRTC_VALUE_WEIGHTS.array, false, atKeyPosition); // fixarray
      return;
    }
    if ((size = type ^ 0x80) <= 0x0f) {
      container(size * 2, WEBRTC_VALUE_WEIGHTS.object, true, atKeyPosition); // fixmap
      return;
    }
    switch (type) {
      case 0xc0: // null
      case 0xc1: // undefined
      case 0xc2: // false
      case 0xc3: // true
      case 0xd4:
      case 0xd5:
      case 0xd6:
      case 0xd7:
        slotOnly(atKeyPosition);
        return;
      case 0xcc: // uint8
      case 0xd0: // int8
        i += 1;
        slotOnly(atKeyPosition);
        return;
      case 0xcd: // uint16
      case 0xd1: // int16
        i += 2;
        slotOnly(atKeyPosition);
        return;
      case 0xca: // float
      case 0xce: // uint32
      case 0xd2: // int32
        i += 4;
        boxedNumber(atKeyPosition);
        return;
      case 0xcb: // double
      case 0xcf: // uint64
      case 0xd3: // int64
        i += 8;
        boxedNumber(atKeyPosition);
        return;
      case 0xd8: {
        // str16
        const size16 = u16();
        i += size16;
        cost += stringWeightOf(size16);
        return;
      }
      case 0xd9: {
        // str32
        const size32 = u32();
        i += size32;
        cost += stringWeightOf(size32);
        return;
      }
      case 0xda: {
        // raw16
        const size16 = u16();
        i += size16;
        binaryValue(atKeyPosition);
        return;
      }
      case 0xdb: {
        // raw32
        const size32 = u32();
        i += size32;
        binaryValue(atKeyPosition);
        return;
      }
      case 0xdc: // array16
        container(u16(), WEBRTC_VALUE_WEIGHTS.array, false, atKeyPosition);
        return;
      case 0xdd: // array32
        container(u32(), WEBRTC_VALUE_WEIGHTS.array, false, atKeyPosition);
        return;
      case 0xde: // map16
        container(u16() * 2, WEBRTC_VALUE_WEIGHTS.object, true, atKeyPosition);
        return;
      case 0xdf: // map32
        container(u32() * 2, WEBRTC_VALUE_WEIGHTS.object, true, atKeyPosition);
        return;
      default:
        slotOnly(atKeyPosition);
        return;
    }
  }

  /** A container of `children` declared child values: its base weight, a backing
   * slot per declared child, then the children themselves. A map's children
   * alternate key, value, so its even-indexed children are the key positions. */
  function container(
    children: number,
    base: number,
    isMap: boolean,
    atKeyPosition: boolean,
  ): void {
    cost += base + children * WEBRTC_VALUE_WEIGHTS.scalar;
    if (atKeyPosition) nonStringKey = true;
    for (let k = 0; k < children; k++) {
      one(isMap && k % 2 === 0);
    }
  }

  one(false);
  return { cost, endOffset: i, nonStringKey };
}
