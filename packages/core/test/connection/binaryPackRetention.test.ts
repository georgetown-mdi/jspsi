import { describe, expect, test } from "vitest";

import { pack, unpack } from "peerjs-js-binarypack";

import {
  MAX_WEBRTC_REASSEMBLY_DEPTH,
  MAX_WEBRTC_STRING_BYTES,
  scanFrameStructure,
} from "../../src/connection/binaryPackBounds";

import type { Packable, Unpackable } from "peerjs-js-binarypack";

// What an ADMITTED frame retains, measured against the real pinned unpacker
// rather than modelled. The structural pre-scan bounds a frame's shape -- its
// nesting depth, its per-string length, its byte-backed containers, the elements
// its containers declare between them, its map keys -- and the wire-byte cap
// bounds its size; what those leave is a multiple of the wire bytes, and this is
// where that multiple is a number rather than a claim.
// docs/spec/CHANNEL_SECURITY.md states it as the control's envelope.
//
// The envelope is (wire bytes) x (the worst retention of one declared node),
// because the cumulative element rule admits at most one declared node per wire
// byte. So the bound each admitted shape is held to below is PER DECLARED NODE,
// and the worst of them is what the spec multiplies the wire cap by. A string is
// the one shape whose retention is not per node -- `unpack_string` retains per
// code point -- so it is held per wire byte instead, and its figure sits below
// the per-node worst, which is why it does not move the envelope.
//
// Each shape is the worst measured amplification for one of the three mechanisms
// the unpacker retains by: a reserved backing slot per declared element
// (`unpack_array`), a cons-string tree per string code point (`unpack_string`),
// and a per-value copy per binary value (`unpack_raw`). A
// `peerjs-js-binarypack` bump that changes any of them moves a measured figure
// past its bound and reddens here rather than widening the envelope silently.
//
// The bounds are generous multiples of the measured figures, not the figures
// themselves: this is a drift detector across engine versions and platforms, so
// a bound tight enough to flake would be read as noise rather than as drift.

/** The runner's collector, exposed by `--expose-gc` (`execArgv` in this
 * package's vitest config). Without it every heap delta below would be whatever
 * the collector happened to have done, so the measurements skip themselves
 * rather than report a number nothing stands behind. */
const collect = (globalThis as { gc?: () => void }).gc;

/** Why a measurement skipped, stated at the run: a runtime skip carries its note
 * into the skipped-leg reporter, so a runner that stops passing the flag says
 * what it stopped measuring rather than naming a leg and leaving it at that. */
const NO_COLLECTOR_REASON =
  "run without --expose-gc: a heap delta measured with no collector to settle " +
  "the heap stands for nothing";

/** Settle the heap: a full collection cycle, repeated, so the reading before and
 * the reading after are both taken at a floor rather than mid-cycle. */
function settle(): void {
  for (let i = 0; i < 4; i++) collect?.();
}

function heapUsed(): number {
  settle();
  return process.memoryUsage().heapUsed;
}

function packBytes(value: Packable): Uint8Array {
  const packed = pack(value);
  if (packed instanceof Promise) {
    throw new Error("BinaryPack packed a fixture asynchronously");
  }
  return new Uint8Array(packed);
}

function unpackFrame(bytes: Uint8Array): unknown {
  return unpack<Unpackable>(bytes as unknown as ArrayBuffer);
}

function u32Bytes(n: number): Array<number> {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function concatBytes(parts: Array<Uint8Array>): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

/** `levels` nested `array32` headers each declaring `width` children, with
 * `width` one-byte values behind the innermost -- so every level satisfies the
 * per-container rule and the wire spends its element bytes once rather than once
 * per level. */
function nestedArrayFrame(levels: number, width: number): Uint8Array {
  const parts: Array<Uint8Array> = [];
  for (let i = 0; i < levels; i++) {
    parts.push(new Uint8Array([0xdd, ...u32Bytes(width)]));
  }
  parts.push(new Uint8Array(width).fill(0x01));
  return concatBytes(parts);
}

/** An `array32` of `count` one-byte values, all of `marker`: an empty `bin`
 * (`0xa0`) or an empty `fixmap` (`0x80`). */
function flatFrame(count: number, marker: number): Uint8Array {
  return concatBytes([
    new Uint8Array([0xdd, ...u32Bytes(count)]),
    new Uint8Array(count).fill(marker),
  ]);
}

/** An `array32` of `count` values, each `marker` followed by the `payload` bytes
 * `unpack` reads for it. */
function markerFrame(
  count: number,
  marker: number,
  payload: Array<number>,
): Uint8Array {
  const value = new Uint8Array([marker, ...payload]);
  const frame = new Uint8Array(5 + count * value.length);
  frame.set([0xdd, ...u32Bytes(count)], 0);
  for (let i = 0; i < count; i++) frame.set(value, 5 + i * value.length);
  return frame;
}

/** How a shape's retention is charged: against the elements its containers
 * declare, or -- for a string, whose cost is per code point -- against its wire
 * bytes. */
type Denominator = "declared node" | "wire byte";

const FLAT_ELEMENTS = 200_000;

const SHAPES: Array<{
  label: string;
  build: () => Uint8Array;
  per: Denominator;
  declaredElements: number;
  maxRetained: number;
}> = [
  {
    // `unpack_raw` returns a per-value copy whose fixed cost dwarfs a one-byte
    // payload, and an empty `bin` declares one in a single wire byte. This is
    // the worst per-node figure measured over every one-byte value marker, so
    // it is the multiplier the spec states the envelope with.
    label: "an array of empty bin values",
    build: () => flatFrame(FLAT_ELEMENTS, 0xa0),
    per: "declared node",
    declaredElements: FLAT_ELEMENTS,
    maxRetained: 512,
  },
  {
    // `unpack_map` builds a plain object per value, and an empty `fixmap`
    // declares one in a single wire byte.
    label: "an array of empty fixmap values",
    build: () => flatFrame(FLAT_ELEMENTS, 0x80),
    per: "declared node",
    declaredElements: FLAT_ELEMENTS,
    maxRetained: 160,
  },
  {
    // `unpack_string` concatenates one code point at a time, leaving a cons-string
    // tree whose cost is per character rather than per string -- the same
    // amplification whether the frame spends its bytes on one long string or many
    // short ones, which is why the per-string cap bounds a value and not a frame.
    label: "one string of a megabyte",
    build: () => packBytes("x".repeat(1024 * 1024)),
    per: "wire byte",
    declaredElements: 0,
    maxRetained: 64,
  },
];

/** The number markers wider than 16 bits, each with the payload bytes `unpack`
 * reads after the marker. Every one of them decodes through arithmetic into a JS
 * number, so it costs an array slot and at most a heap number behind it; a
 * version that decoded one into a heavier boxed value -- a `BigInt` for the
 * 64-bit markers, say -- would retain past the per-slot figure the envelope
 * rests on
 * (docs/spec/DEPENDENCY_PINS.md, the PeerJS stack upgrade checklist). */
const WIDE_NUMBER_MARKERS: Array<{
  label: string;
  marker: number;
  payload: Array<number>;
}> = [
  { label: "float", marker: 0xca, payload: [0x3f, 0x8c, 0xcc, 0xcd] },
  {
    label: "double",
    marker: 0xcb,
    payload: [0x3f, 0xf1, 0x99, 0x99, 0x99, 0x99, 0x99, 0x9a],
  },
  { label: "uint32", marker: 0xce, payload: [0xff, 0xff, 0xff, 0xff] },
  { label: "int32", marker: 0xd2, payload: [0xff, 0xff, 0xff, 0x00] },
  {
    label: "uint64",
    marker: 0xcf,
    payload: [0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00],
  },
  {
    label: "int64",
    marker: 0xd3,
    payload: [0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00],
  },
];

/** Elements the wide-number frames declare. Larger than the flat shapes' count
 * because a number costs one array slot: the heap delta at this width is megabytes
 * rather than the kilobytes a smaller count would leave to read against noise. */
const WIDE_NUMBER_ELEMENTS = 1_000_000;

/** Bound on what one wide number retains per declared node. Measured between 8.0
 * -- the array slot alone, where the decoded value is a small integer the slot
 * holds itself -- and 24.0, where it is a heap number the slot points at. Both
 * sit far under the per-node worst the envelope multiplies by; the bound is above
 * both, so it detects a decode that grew heavier still, while the JS-number claim
 * is held exactly by the leg above rather than by this figure. */
const MAX_WIDE_NUMBER_RETAINED = 64;

/** Bytes the heap holds for `frame`'s decoded value, and what it gives back when
 * that value is dropped. */
function measureRetention(frame: Uint8Array): {
  retained: number;
  releasedOnDrop: number;
} {
  const before = heapUsed();
  let decoded: unknown = unpackFrame(frame);
  const retained = heapUsed() - before;
  // Read the decode without handing it to an assertion, which would hold the
  // value past the drop below and measure a release of nothing.
  if (decoded === undefined || decoded === null) {
    throw new Error("the frame decoded to nothing");
  }
  decoded = undefined;
  return { retained, releasedOnDrop: retained - (heapUsed() - before) };
}

describe("what an admitted frame retains, measured against the real unpacker", () => {
  test("stays under the measured amplification bound for every shape", (ctx) => {
    ctx.skip(collect === undefined, NO_COLLECTOR_REASON);
    for (const { label, build, per, declaredElements, maxRetained } of SHAPES) {
      const frame = build();
      expect(
        scanFrameStructure(
          frame,
          MAX_WEBRTC_REASSEMBLY_DEPTH,
          MAX_WEBRTC_STRING_BYTES,
        ),
        `${label}: refused by the pre-scan, so it measures nothing admitted`,
      ).toBeUndefined();

      const { retained, releasedOnDrop } = measureRetention(frame);
      const units =
        per === "declared node" ? declaredElements : frame.byteLength;
      const perUnit = retained / units;
      expect(
        perUnit,
        `${label}: ${units} ${per}s retained ${retained} bytes, ${perUnit.toFixed(1)} per ${per} (the envelope multiplies the wire cap by the worst per-node figure, ~208 bytes, measured on the empty bin view)`,
      ).toBeLessThan(maxRetained);
      // A retention the drop does not give back would be a leak somewhere else
      // in the run rather than this frame's decode, and would put the figure
      // above on the wrong quantity.
      expect(
        releasedOnDrop / retained,
        `${label}: dropping the decode released ${releasedOnDrop} of ${retained} bytes`,
      ).toBeGreaterThan(0.9);
    }
  });

  test("decodes every wide number marker to a JS number", () => {
    for (const { label, marker, payload } of WIDE_NUMBER_MARKERS) {
      expect(
        typeof unpackFrame(new Uint8Array([marker, ...payload])),
        `${label}: decoded to something other than a JS number`,
      ).toBe("number");
    }
  });

  test("retains one node per declared wide number marker", (ctx) => {
    ctx.skip(collect === undefined, NO_COLLECTOR_REASON);
    for (const { label, marker, payload } of WIDE_NUMBER_MARKERS) {
      const frame = markerFrame(WIDE_NUMBER_ELEMENTS, marker, payload);
      expect(
        scanFrameStructure(
          frame,
          MAX_WEBRTC_REASSEMBLY_DEPTH,
          MAX_WEBRTC_STRING_BYTES,
        ),
        `${label}: refused by the pre-scan, so it measures nothing admitted`,
      ).toBeUndefined();

      const { retained, releasedOnDrop } = measureRetention(frame);
      const perNode = retained / WIDE_NUMBER_ELEMENTS;
      expect(
        perNode,
        `${label}: ${WIDE_NUMBER_ELEMENTS} declared nodes retained ${retained} bytes, ${perNode.toFixed(1)} per declared node`,
      ).toBeLessThan(MAX_WIDE_NUMBER_RETAINED);
      expect(
        releasedOnDrop / retained,
        `${label}: dropping the decode released ${releasedOnDrop} of ${retained} bytes`,
      ).toBeGreaterThan(0.9);
    }
  });
});

describe("what the pre-scan keeps out of the envelope above", () => {
  test("the nested chain reserving the same bytes at every level", () => {
    // The shape that declares more nodes than the frame has wire bytes: 200
    // byte-backed levels over 701,000 of them retain 1.1 GB, 1,598x, because
    // `unpack_array` reserves the declared width once per level. The cumulative
    // element rule refuses it, so the per-node figures above still bound a
    // frame's retention against its wire size.
    expect(
      scanFrameStructure(
        nestedArrayFrame(200, 700_000),
        MAX_WEBRTC_REASSEMBLY_DEPTH,
        MAX_WEBRTC_STRING_BYTES,
      ),
    ).toEqual({ rule: "total-elements" });
  });
});
