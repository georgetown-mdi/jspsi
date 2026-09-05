import { pack, unpack } from "peerjs-js-binarypack";
import { expect, test } from "vitest";

import { ConnectionError } from "@psilink/core";

import {
  PEERJS_CHUNK_MTU,
  PeerJsFrameEncoder,
  chunkPacked,
  classifyInboundValue,
  concatChunks,
  packCloseSentinel,
  packValue,
  toFrameBytes,
  unpackFrame,
} from "../../src/connection/webrtc/peerjsWire";

// --- wire fixtures ----------------------------------------------------------
//
// These hex strings were captured from the installed `peerjs` 1.5.5 and
// `peerjs-js-binarypack` 2.1.0 -- the exact pins the web app holds -- by
// packing the shapes PeerJS itself puts on the wire. They are the cross-
// implementation vectors for the framing: a bump that changes the encoding, the
// chunk envelope's keys, or the close sentinel fails here rather than at a
// partner's browser. See docs/spec/DEPENDENCY_PINS.md.

const CLOSE_SENTINEL_HEX = "81ba5f5f706565724461746181b474797065b5636c6f7365";
const CHUNK_ENVELOPE_HEX =
  "84ba5f5f706565724461746101b16e00b464617461a401020304b5746f74616c02";

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

test("the close sentinel matches the bytes PeerJS sends on a flushing close", () => {
  expect(hex(packCloseSentinel())).toBe(CLOSE_SENTINEL_HEX);
  expect(classifyInboundValue(unpackFrame(packCloseSentinel()))).toEqual({
    kind: "close",
  });
});

test("a chunk envelope matches PeerJS's key set and order", () => {
  const envelope = packValue({
    __peerData: 1,
    n: 0,
    data: new Uint8Array([1, 2, 3, 4]),
    total: 2,
  });
  expect(hex(envelope)).toBe(CHUNK_ENVELOPE_HEX);
});

test("the chunker matches PeerJS's own MTU and envelope for the same input", () => {
  const payload = new Uint8Array(PEERJS_CHUNK_MTU * 2 + 11).fill(7);
  const packed = packValue(payload);
  const ours = chunkPacked(packed, 1);
  // What peerjs's util.chunk would produce for the same packed buffer.
  const total = Math.ceil(packed.byteLength / PEERJS_CHUNK_MTU);
  const theirs: Array<Uint8Array> = [];
  for (let start = 0; start < packed.byteLength; start += PEERJS_CHUNK_MTU) {
    theirs.push(
      new Uint8Array(
        pack({
          __peerData: 1,
          n: theirs.length,
          data: packed.slice(start, start + PEERJS_CHUNK_MTU),
          total,
        }) as ArrayBuffer,
      ),
    );
  }
  expect(ours.map(hex)).toEqual(theirs.map(hex));
});

// --- round trips ------------------------------------------------------------

test("a frame at or under the MTU is sent whole, over it is chunked", () => {
  const encoder = new PeerJsFrameEncoder();
  const small = encoder.encode({ hello: "world" });
  expect(small).toHaveLength(1);
  expect(small[0].byteLength).toBeLessThanOrEqual(PEERJS_CHUNK_MTU);

  const large = encoder.encode({ body: new Uint8Array(PEERJS_CHUNK_MTU * 3) });
  expect(large.length).toBeGreaterThan(1);
  for (const chunk of large) {
    const classified = classifyInboundValue(unpackFrame(chunk));
    expect(classified.kind).toBe("chunk");
  }
});

test("chunk message ids start at 1 and increment per logical frame", () => {
  const encoder = new PeerJsFrameEncoder(8);
  const ids = [0, 1, 2].map(() => {
    const first = classifyInboundValue(
      unpackFrame(encoder.encode({ body: new Uint8Array(64) })[0]),
    );
    if (first.kind !== "chunk") throw new Error("expected a chunk");
    return first.messageId;
  });
  // Zero is not a usable id: the receive dispatch keys off __peerData being
  // truthy, so an id of 0 would be treated as a plain application frame.
  expect(ids).toEqual([1, 2, 3]);
});

test("chunks reassemble to the packed frame the encoder started from", () => {
  const value = {
    kind: "psi-set",
    elements: new Uint8Array(PEERJS_CHUNK_MTU * 2 + 5).fill(3),
  };
  const encoder = new PeerJsFrameEncoder();
  const parts = encoder.encode(value).map((chunk) => {
    const classified = classifyInboundValue(unpackFrame(chunk));
    if (classified.kind !== "chunk") throw new Error("expected a chunk");
    return classified.data;
  });
  const assembled = unpackFrame(concatChunks(parts)) as typeof value;
  expect(assembled.kind).toBe("psi-set");
  expect(hex(toFrameBytes(assembled.elements))).toBe(hex(value.elements));
});

test("an unchunked frame round-trips through the real unpacker", () => {
  const encoder = new PeerJsFrameEncoder();
  const [only] = encoder.encode({ step: 2, ok: true, note: "fin" });
  expect(unpack(only as unknown as ArrayBuffer)).toEqual({
    step: 2,
    ok: true,
    note: "fin",
  });
});

// --- inbound classification -------------------------------------------------

test("a frame with no __peerData is delivered as application data", () => {
  expect(classifyInboundValue({ step: 1 })).toEqual({
    kind: "data",
    value: { step: 1 },
  });
  expect(classifyInboundValue([1, 2, 3])).toEqual({
    kind: "data",
    value: [1, 2, 3],
  });
  // A falsy __peerData is not an envelope -- the same rule PeerJS applies.
  expect(classifyInboundValue({ __peerData: 0, step: 1 })).toEqual({
    kind: "data",
    value: { __peerData: 0, step: 1 },
  });
});

test.each([
  [
    "a __peerData object that is not the sentinel",
    { __peerData: { type: "x" } },
  ],
  [
    "a non-integer chunk id",
    { __peerData: "1", n: 0, total: 1, data: new Uint8Array(1) },
  ],
  [
    "a zero chunk count",
    { __peerData: 1, n: 0, total: 0, data: new Uint8Array(1) },
  ],
  [
    "a fractional chunk count",
    { __peerData: 1, n: 0, total: 1.5, data: new Uint8Array(1) },
  ],
  [
    "a chunk index past the count",
    { __peerData: 1, n: 2, total: 2, data: new Uint8Array(1) },
  ],
  [
    "a negative chunk index",
    { __peerData: 1, n: -1, total: 2, data: new Uint8Array(1) },
  ],
  [
    "a non-binary chunk payload",
    { __peerData: 1, n: 0, total: 1, data: "bytes" },
  ],
])("classification refuses %s", (_label, value) => {
  expect(() => classifyInboundValue(value)).toThrow(ConnectionError);
  try {
    classifyInboundValue(value);
  } catch (err) {
    expect((err as ConnectionError).kind).toBe("protocol");
  }
});

test("a malformed BinaryPack body fails as a protocol error holding no peer bytes", () => {
  // A str32 header declaring a length the body cannot supply.
  const truncated = new Uint8Array([0xd9, 0xff, 0xff, 0xff, 0xff, 0x41]);
  let thrown: unknown;
  try {
    unpackFrame(truncated);
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(ConnectionError);
  expect((thrown as ConnectionError).kind).toBe("protocol");
  expect((thrown as ConnectionError).message).not.toContain("A");
});

// --- byte coercion ----------------------------------------------------------

test("toFrameBytes views a Buffer, a view and an ArrayBuffer without copying", () => {
  const backing = new Uint8Array([9, 9, 1, 2, 3, 9]);
  expect(hex(toFrameBytes(Buffer.from([1, 2, 3])))).toBe("010203");
  expect(hex(toFrameBytes(backing.subarray(2, 5)))).toBe("010203");
  expect(hex(toFrameBytes(new Uint8Array([1, 2, 3]).buffer))).toBe("010203");
});

test.each([
  ["a text-mode payload", "not bytes"],
  ["an undefined payload", undefined],
  ["a plain object", {}],
  ["an empty binary view", new Uint8Array(0)],
  ["an empty ArrayBuffer", new ArrayBuffer(0)],
])("toFrameBytes refuses %s as malformed", (_label, value) => {
  // A string or object is not a PeerJS binary frame, and an empty binary message
  // unpacks to the number 0 -- both are refused rather than reinterpreted, since
  // delivering a bogus frame 0 is what the old empty-view return produced.
  expect(() => toFrameBytes(value)).toThrow(ConnectionError);
  try {
    toFrameBytes(value);
  } catch (err) {
    expect((err as ConnectionError).kind).toBe("protocol");
  }
});
