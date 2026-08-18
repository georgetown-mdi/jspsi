import { unpack } from "peerjs-js-binarypack";
import { expect, test } from "vitest";

import {
  ConnectionError,
  MAX_CHUNKS_PER_REASSEMBLY,
  MAX_CONCURRENT_REASSEMBLIES,
  MIN_CHUNK_RESIDENT_BYTES,
} from "@psilink/core";

import { BoundedInboundFrames } from "../../src/connection/webrtc/inboundBounds";
import {
  PEERJS_CHUNK_MTU,
  PeerJsFrameEncoder,
  packCloseSentinel,
  packValue,
  toFrameBytes,
} from "../../src/connection/webrtc/peerjsWire";

import type { InboundBoundOptions } from "../../src/connection/webrtc/inboundBounds";

/** One chunk envelope, built directly so a test can choose every field. */
function chunk(
  messageId: number,
  index: number,
  total: number,
  payload: Uint8Array,
): Uint8Array {
  return packValue({ __peerData: messageId, n: index, data: payload, total });
}

/** Re-tag an encoded chunk envelope under a different message id. */
function retag(datagram: Uint8Array, messageId: number): Uint8Array {
  const envelope = unpack(datagram as unknown as ArrayBuffer) as {
    n: number;
    total: number;
    data: unknown;
  };
  return chunk(
    messageId,
    envelope.n,
    envelope.total,
    toFrameBytes(envelope.data),
  );
}

/** The kind and message of the ConnectionError `run` is expected to throw. */
function refusal(run: () => unknown): { kind: string; message: string } {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(ConnectionError);
    const error = err as ConnectionError;
    return { kind: error.kind, message: error.message };
  }
  throw new Error("expected a refusal");
}

// --- the happy path ---------------------------------------------------------

test("an unchunked frame is delivered whole", () => {
  const bounds = new BoundedInboundFrames();
  const [only] = new PeerJsFrameEncoder().encode({ step: 1, ok: true });
  expect(bounds.accept(only)).toEqual({
    kind: "frame",
    value: { step: 1, ok: true },
  });
});

test("a chunked frame is pending until its last slice, then delivered", () => {
  const bounds = new BoundedInboundFrames();
  const datagrams = new PeerJsFrameEncoder().encode({
    body: new Uint8Array(PEERJS_CHUNK_MTU * 3),
  });
  expect(datagrams.length).toBeGreaterThan(2);
  for (const datagram of datagrams.slice(0, -1)) {
    expect(bounds.accept(datagram)).toEqual({ kind: "pending" });
  }
  expect(bounds.accept(datagrams[datagrams.length - 1]).kind).toBe("frame");
  expect(bounds.retainedBytes()).toBe(0);
});

test("a reassembled frame carries the bytes the sender packed", () => {
  const bounds = new BoundedInboundFrames();
  const body = new Uint8Array(PEERJS_CHUNK_MTU * 2 + 7);
  for (let i = 0; i < body.length; i += 1) body[i] = i % 251;
  let outcome = { kind: "pending" } as ReturnType<
    BoundedInboundFrames["accept"]
  >;
  for (const datagram of new PeerJsFrameEncoder().encode({
    tag: "set",
    body,
  })) {
    outcome = bounds.accept(datagram);
  }
  expect(outcome.kind).toBe("frame");
  const value = (
    outcome as { kind: "frame"; value: { tag: string; body: unknown } }
  ).value;
  expect(value.tag).toBe("set");
  expect(Buffer.from(toFrameBytes(value.body)).equals(Buffer.from(body))).toBe(
    true,
  );
});

test("the close sentinel is reported, not delivered as a frame", () => {
  const bounds = new BoundedInboundFrames();
  expect(bounds.accept(packCloseSentinel())).toEqual({ kind: "close" });
});

test("two frames interleaved on the wire each reassemble to their own value", () => {
  const bounds = new BoundedInboundFrames();
  const a = new PeerJsFrameEncoder().encode({
    tag: "a",
    body: new Uint8Array(PEERJS_CHUNK_MTU + 1).fill(1),
  });
  // Distinct encoders both start at message id 1, so re-tag the second frame.
  const b = new PeerJsFrameEncoder()
    .encode({ tag: "b", body: new Uint8Array(PEERJS_CHUNK_MTU + 1).fill(2) })
    .map((datagram) => retag(datagram, 2));
  expect(bounds.accept(a[0])).toEqual({ kind: "pending" });
  expect(bounds.accept(b[0])).toEqual({ kind: "pending" });
  expect(bounds.accept(a[1]).kind).toBe("frame");
  expect(bounds.accept(b[1]).kind).toBe("frame");
  expect(bounds.retainedBytes()).toBe(0);
});

// --- the bounds -------------------------------------------------------------

test("a datagram over the wire-byte cap is refused before it is unpacked", () => {
  const bounds = new BoundedInboundFrames({ maxFrameBytes: 512 });
  const { kind, message } = refusal(() => bounds.accept(new Uint8Array(513)));
  expect(kind).toBe("protocol");
  expect(message).toContain("512-byte size limit");
});

test("a structure-amplifying frame is refused before unpack allocates", () => {
  // An array32 header declaring 2^32-1 elements from five wire bytes: the
  // structural pre-scan charges it and rejects before `unpack` allocates.
  const bomb = new Uint8Array([0xdd, 0xff, 0xff, 0xff, 0xff]);
  const bounds = new BoundedInboundFrames({ maxStructureBytes: 4096 });
  const { kind, message } = refusal(() => bounds.accept(bomb));
  expect(kind).toBe("protocol");
  expect(message).toContain("4096-byte structure limit");
});

test("a reassembly declaring more chunks than the cap is refused up front", () => {
  const bounds = new BoundedInboundFrames({ maxChunks: 4 });
  expect(
    refusal(() => bounds.accept(chunk(1, 0, 5, new Uint8Array(8)))).message,
  ).toContain("4-chunk reassembly limit");
});

test("a repeated chunk ordinal is charged but never completes the frame", () => {
  const bounds = new BoundedInboundFrames({ maxChunks: 6 });
  const repeated = chunk(1, 0, 3, new Uint8Array(8));
  for (let i = 0; i < 6; i += 1) {
    expect(bounds.accept(repeated)).toEqual({ kind: "pending" });
  }
  // Only one distinct ordinal ever arrived, so the frame is still incomplete;
  // the seventh repeat trips the per-reassembly chunk cap.
  expect(refusal(() => bounds.accept(repeated)).message).toContain(
    "6-chunk reassembly limit",
  );
});

test("a chunk flood is bounded by retained bytes, each chunk charged a floor", () => {
  // A one-byte slice still costs a retained view, so the byte cap charges the
  // resident floor rather than the payload; otherwise a tiny-chunk flood would
  // stay far under the cap while exhausting memory.
  const bounds = new BoundedInboundFrames({
    maxFrameBytes: MIN_CHUNK_RESIDENT_BYTES * 4,
    maxChunks: 1_000,
  });
  for (let n = 0; n < 4; n += 1) {
    expect(bounds.accept(chunk(1, n, 1_000, new Uint8Array(1))).kind).toBe(
      "pending",
    );
  }
  expect(
    refusal(() => bounds.accept(chunk(1, 4, 1_000, new Uint8Array(1)))).message,
  ).toContain("size limit");
});

test("past the concurrency cap the oldest partial is evicted, silently", () => {
  const bounds = new BoundedInboundFrames({ maxConcurrentReassemblies: 2 });
  const slice = new Uint8Array(16);
  expect(bounds.accept(chunk(1, 0, 2, slice))).toEqual({ kind: "pending" });
  expect(bounds.accept(chunk(2, 0, 2, slice))).toEqual({ kind: "pending" });
  // A third id evicts id 1 rather than failing the connection: the lockstep
  // protocol never has a legitimate second partial, so eviction only ever drops
  // adversarial data.
  expect(bounds.accept(chunk(3, 0, 2, slice))).toEqual({ kind: "pending" });
  // id 1's first slice is gone, so its second slice starts a fresh reassembly
  // instead of completing one.
  expect(bounds.accept(chunk(1, 1, 2, slice))).toEqual({ kind: "pending" });
});

test("chunks that declare two different totals are refused", () => {
  const bounds = new BoundedInboundFrames();
  expect(bounds.accept(chunk(1, 0, 3, new Uint8Array(4)))).toEqual({
    kind: "pending",
  });
  expect(
    refusal(() => bounds.accept(chunk(1, 1, 4, new Uint8Array(4)))).message,
  ).toContain("two different chunk counts");
});

test("chunks that reassemble into another envelope are refused", () => {
  // PeerJS re-enters its own dispatch on the assembled bytes; a legitimate
  // sender never produces a nested envelope, so nesting is a protocol error
  // rather than a recursion this side follows.
  const inner = packCloseSentinel();
  const half = Math.ceil(inner.byteLength / 2);
  const bounds = new BoundedInboundFrames();
  expect(bounds.accept(chunk(1, 0, 2, inner.subarray(0, half)))).toEqual({
    kind: "pending",
  });
  expect(
    refusal(() => bounds.accept(chunk(1, 1, 2, inner.subarray(half)))).message,
  ).toContain("another envelope");
});

test("a refusal carries the limit and no peer-supplied bytes", () => {
  const marker = "PEER-CHOSEN-MARKER";
  const bounds = new BoundedInboundFrames({ maxFrameBytes: 8 });
  expect(
    refusal(() => bounds.accept(packValue({ marker }))).message,
  ).not.toContain(marker);
});

test("a pre-scan refusal names the rule that fired", () => {
  // One frame per rule the pre-scan enforces, each refused with the rule named, so
  // an operator (and any support thread reading the failure) sees the control that
  // refused the frame. The first three frames come from the real encoder; the last
  // two are assembled, since that encoder emits neither a container it does not
  // fill nor a map key that is not a string.
  const spine: unknown = Array.from({ length: 12 }).reduce<unknown>(
    (inner) => [inner],
    1,
  );
  const cases: Array<{
    rule: string;
    frame: Uint8Array;
    options: InboundBoundOptions;
    message: string;
  }> = [
    {
      rule: "the retained-byte budget",
      frame: packValue(
        Array.from({ length: 200 }, (_, i) => ({
          theirIndex: i,
          iteration: 0,
        })),
      ),
      options: { maxStructureBytes: 1000 },
      message: "inbound WebRTC frame exceeds its 1000-byte structure limit",
    },
    {
      rule: "the nesting-depth cap",
      frame: packValue(spine),
      options: { maxReassemblyDepth: 4 },
      message: "inbound WebRTC frame exceeds its 4-level nesting limit",
    },
    {
      rule: "the per-string cap",
      frame: packValue("x".repeat(4096)),
      options: { maxStringBytes: 1024 },
      message: "inbound WebRTC frame exceeds its 1024-byte string limit",
    },
    {
      rule: "the byte-backed-elements check",
      // array32 declaring 1,000,000 elements with no bytes behind it.
      frame: new Uint8Array([0xdd, 0x00, 0x0f, 0x42, 0x40]),
      options: {},
      message:
        "inbound WebRTC frame declares a container with more elements than " +
        "the bytes behind it can encode",
    },
    {
      rule: "the map-key rule",
      frame: new Uint8Array([0x81, 0x07, 0x08]), // fixmap(1) keyed by a fixint
      options: {},
      message:
        "inbound WebRTC frame keys a map with a value that is not a string",
    },
  ];

  for (const { rule, frame, options, message } of cases) {
    const bounds = new BoundedInboundFrames(options);
    const { kind, message: reported } = refusal(() => bounds.accept(frame));
    expect(kind, rule).toBe("protocol");
    expect(reported, rule).toBe(message);
  }
});

// --- the defaults are core's constants, not a per-transport re-derivation ----

test("the default chunk-count cap is core's", () => {
  const bounds = new BoundedInboundFrames();
  expect(
    refusal(() =>
      bounds.accept(
        chunk(1, 0, MAX_CHUNKS_PER_REASSEMBLY + 1, new Uint8Array(4)),
      ),
    ).message,
  ).toContain(`${MAX_CHUNKS_PER_REASSEMBLY}-chunk reassembly limit`);
});

test("the default concurrency cap is core's", () => {
  const bounds = new BoundedInboundFrames();
  const slice = new Uint8Array(4);
  for (let id = 1; id <= MAX_CONCURRENT_REASSEMBLIES; id += 1) {
    expect(bounds.accept(chunk(id, 0, 2, slice)).kind).toBe("pending");
  }
  const beforeEviction = bounds.retainedBytes();
  // One id past the cap evicts the oldest, so the retained total does not grow.
  expect(
    bounds.accept(chunk(MAX_CONCURRENT_REASSEMBLIES + 1, 0, 2, slice)).kind,
  ).toBe("pending");
  expect(bounds.retainedBytes()).toBe(beforeEviction);
});
