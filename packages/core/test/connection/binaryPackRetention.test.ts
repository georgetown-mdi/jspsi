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
// nesting depth, its per-string length, its byte-backed containers, its map keys
// -- and the wire-byte cap bounds its size; what those leave is a multiple of the
// wire bytes, and this is where that multiple is a number rather than a claim.
// docs/spec/CHANNEL_SECURITY.md states it as the control's envelope.
//
// Each shape below is the worst measured amplification for one of the three
// mechanisms the unpacker retains by: a reserved backing slot per declared
// element (`unpack_array`), a cons-string tree per string code point
// (`unpack_string`), and a per-value copy per binary value (`unpack_raw`). A
// `peerjs-js-binarypack` bump that changes any of them moves a measured figure
// past its bound and reddens here rather than widening the envelope silently.
//
// The bounds are generous multiples of the measured figures, not the figures
// themselves: this is a drift detector across engine versions and platforms, so
// a bound tight enough to flake would be read as noise rather than as drift.

/** The runner's collector, exposed by `--expose-gc` (`execArgv` in this
 * package's vitest config). Without it every heap delta below would be whatever
 * the collector happened to have done, so the measurement skips itself rather
 * than report a number nothing stands behind -- and the run's skipped-leg
 * reporter names it, so a runner that stops passing the flag is visible. */
const collect = (globalThis as { gc?: () => void }).gc;

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
 * `width` one-byte values behind the innermost -- so every level is byte-backed
 * and the wire spends its element bytes once rather than once per level. */
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

const SHAPES: Array<{
  label: string;
  build: () => Uint8Array;
  maxRetainedPerWireByte: number;
}> = [
  {
    // `unpack_array` reserves `new Array(size)` from the declared count before
    // reading an element, so a byte-backed chain re-reserves the same width at
    // every level. The bound is twice the ceiling the depth cap implies: at most
    // MAX_WEBRTC_REASSEMBLY_DEPTH levels, each reserving one machine word per
    // wire byte behind it.
    label: "a nested chain of byte-backed array32 levels",
    build: () => nestedArrayFrame(200, 20_000),
    maxRetainedPerWireByte: MAX_WEBRTC_REASSEMBLY_DEPTH * 8 * 2,
  },
  {
    // `unpack_raw` returns a per-value copy whose fixed cost dwarfs a one-byte
    // payload, and an empty `bin` declares one in a single wire byte.
    label: "an array of empty bin values",
    build: () => flatFrame(200_000, 0xa0),
    maxRetainedPerWireByte: 512,
  },
  {
    // `unpack_map` builds a plain object per value, and an empty `fixmap`
    // declares one in a single wire byte.
    label: "an array of empty fixmap values",
    build: () => flatFrame(200_000, 0x80),
    maxRetainedPerWireByte: 160,
  },
  {
    // `unpack_string` concatenates one code point at a time, leaving a cons-string
    // tree whose cost is per character rather than per string -- the same
    // amplification whether the frame spends its bytes on one long string or many
    // short ones, which is why the per-string cap bounds a value and not a frame.
    label: "one string of a megabyte",
    build: () => packBytes("x".repeat(1024 * 1024)),
    maxRetainedPerWireByte: 64,
  },
];

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

describe.skipIf(collect === undefined)(
  "what an admitted frame retains, measured against the real unpacker",
  () => {
    test("stays under the measured amplification bound for every shape", () => {
      for (const { label, build, maxRetainedPerWireByte } of SHAPES) {
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
        const perWireByte = retained / frame.byteLength;
        expect(
          perWireByte,
          `${label}: ${frame.byteLength} wire bytes retained ${retained} bytes, ${perWireByte.toFixed(1)}x`,
        ).toBeLessThan(maxRetainedPerWireByte);
        // A retention the drop does not give back would be a leak somewhere else
        // in the run rather than this frame's decode, and would put the figure
        // above on the wrong quantity.
        expect(
          releasedOnDrop / retained,
          `${label}: dropping the decode released ${releasedOnDrop} of ${retained} bytes`,
        ).toBeGreaterThan(0.9);
      }
    });
  },
);
