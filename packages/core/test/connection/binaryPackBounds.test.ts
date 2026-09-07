import { pack, unpack } from "peerjs-js-binarypack";
import { describe, expect, test } from "vitest";

import {
  MAX_CHUNKS_PER_REASSEMBLY,
  MAX_CONCURRENT_REASSEMBLIES,
  MAX_WEBRTC_FRAME_BYTES,
  MAX_WEBRTC_REASSEMBLY_DEPTH,
  MAX_WEBRTC_STRING_BYTES,
  MIN_CHUNK_RESIDENT_BYTES,
  describeFrameStructureRefusal,
  scanFrameStructure,
} from "../../src/connection/binaryPackBounds";
import { MAX_SINGLE_PASS_CELLS } from "../../src/connection/frameSize";

import type { FrameStructureRefusal } from "../../src/connection/binaryPackBounds";
import type { Packable, Unpackable } from "peerjs-js-binarypack";

/** Whether the scan refuses `frame` under the given limits, for the tests that
 * assert only the verdict; the rule each refusal names is asserted separately (see
 * "the rule a refusal names"). */
function scanRefuses(...args: Parameters<typeof scanFrameStructure>): boolean {
  return scanFrameStructure(...args) !== undefined;
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

describe("the WebRTC inbound bound constants", () => {
  // Each value is specified normatively in docs/spec/CHANNEL_SECURITY.md (WebRTC
  // data-channel inbound bound). Pinned here as literals so a silent retune of a
  // bound fails rather than quietly widening the memory envelope a security
  // review signed off on; changing one means changing the spec with it.
  test("hold the values the channel-security spec names", () => {
    expect(MAX_WEBRTC_FRAME_BYTES).toBe(268_435_456);
    expect(MAX_WEBRTC_REASSEMBLY_DEPTH).toBe(256);
    expect(MAX_WEBRTC_STRING_BYTES).toBe(104_857_600);
    expect(MAX_CHUNKS_PER_REASSEMBLY).toBe(131_072);
    expect(MAX_CONCURRENT_REASSEMBLIES).toBe(8);
    expect(MIN_CHUNK_RESIDENT_BYTES).toBe(256);
  });
});

describe("scanFrameStructure", () => {
  test("flags a string longer than the per-string byte cap", () => {
    expect(scanRefuses(str32Header(1000), 256, 100)).toBe(true);
  });

  test("passes a short fixstr under the per-string cap", () => {
    // fixstr "abc" (0xb3 + 3 bytes) is one value and well under any string cap.
    expect(
      scanRefuses(new Uint8Array([0xb3, 0x61, 0x62, 0x63]), 256, 100),
    ).toBe(false);
  });

  test("flags a fixstr over the per-string cap, uniformly with the wide markers", () => {
    // fixstr "abcd" (4 bytes) against a 2-byte cap: the cap fires on fixstr too,
    // not only str16/str32, so the marker dispatch is one rule.
    expect(scanRefuses(new Uint8Array(fixstr("abcd")), 256, 2)).toBe(true);
  });

  test("admits a string declaring exactly the production per-string cap", () => {
    // The boundary the cap is set at, driven at the production value with a
    // header alone: a str32 declaring the cap is admitted (the scan runs off the
    // end of the buffer, which it treats as a truncated frame and delegates),
    // and one byte more draws the string rule. Declaring rather than packing the
    // payload keeps a 100 MiB allocation out of a unit test; the differential
    // suite drives real strings through the same rule.
    expect(
      scanFrameStructure(
        str32Header(MAX_WEBRTC_STRING_BYTES),
        MAX_WEBRTC_REASSEMBLY_DEPTH,
        MAX_WEBRTC_STRING_BYTES,
      ),
    ).toBeUndefined();
    expect(
      scanFrameStructure(
        str32Header(MAX_WEBRTC_STRING_BYTES + 1),
        MAX_WEBRTC_REASSEMBLY_DEPTH,
        MAX_WEBRTC_STRING_BYTES,
      ),
    ).toEqual({ rule: "string-bytes", limit: MAX_WEBRTC_STRING_BYTES });
  });
});

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

/** `levels` nested array32 headers each declaring `width` children, with `width`
 * one-byte values behind the innermost -- so every level's declared count is
 * backed by the bytes that follow it, and the wire spends those bytes once
 * however many levels reserve them. */
function nestedArrayFrame(levels: number, width: number): Uint8Array {
  const parts: Array<Uint8Array> = [];
  for (let i = 0; i < levels; i += 1) parts.push(array32Header(width));
  parts.push(new Uint8Array(width).fill(0x01));
  return concatBytes(parts);
}

/** Encode with the real packer. It resolves asynchronously only for a `Blob`,
 * which nothing here packs; an awaited-by-accident promise would put
 * `[object Promise]` in a fixture's bytes, so the branch is asserted. */
function packSync(value: Packable): Uint8Array {
  const packed = pack(value);
  if (packed instanceof Promise) {
    throw new Error("BinaryPack packed a fixture asynchronously");
  }
  return new Uint8Array(packed);
}

/** One legitimate frame shape, built at a record count: the wire bytes, and the
 * element total its containers declare between them. The builder counts what it
 * declares rather than the scan handing the count back. */
interface RecordShape {
  readonly label: string;
  readonly build: (records: number) => {
    frame: Uint8Array;
    declaredElements: number;
  };
}

/** The two largest legitimate non-binary shapes psilink puts on the data channel,
 * built per record with the real packer under a hand-written array32 header so a
 * record count too large for `pack`'s per-element recursion still assembles. */
const RECORD_SHAPES: Array<RecordShape> = [
  {
    label: "a mapped-element frame",
    build: (records) => ({
      frame: concatBytes([
        array32Header(records),
        ...Array.from({ length: records }, (_, i) =>
          packSync({ theirIndex: i, iteration: i % 3 }),
        ),
      ]),
      // The outer array's element per record, plus the two key/value pairs of
      // each record's fixmap.
      declaredElements: records * 5,
    }),
  },
  {
    label: "a payload frame's rows",
    build: (records) => ({
      frame: concatBytes([
        array32Header(records),
        ...Array.from({ length: records }, () => packSync(["20001"])),
      ]),
      declaredElements: records * 2,
    }),
  },
];

describe("scanFrameStructure: the cumulative element rule", () => {
  const scan = (frame: Uint8Array): FrameStructureRefusal | undefined =>
    scanFrameStructure(
      frame,
      MAX_WEBRTC_REASSEMBLY_DEPTH,
      MAX_WEBRTC_STRING_BYTES,
    );

  test("refuses nested levels that each declare the same trailing bytes", () => {
    // Every level here satisfies the per-container rule -- 700,000 declared
    // against the 700,000 one-byte values that follow -- yet `unpack_array`
    // reserves that width once per level, so 200 levels retain 1.1 GB over
    // 701,000 wire bytes. The cumulative rule is what refuses it.
    expect(scan(nestedArrayFrame(200, 700_000))).toEqual({
      rule: "total-elements",
    });
  });

  test("admits the same declared counts backed at one level, and unpacks them", () => {
    const frame = nestedArrayFrame(1, 700_000);
    expect(scan(frame)).toBeUndefined();
    const decoded = unpack<Unpackable>(frame as unknown as ArrayBuffer);
    expect(Array.isArray(decoded) && decoded.length).toBe(700_000);
  });

  test("admits the largest legitimate shapes at the single-pass ceiling", () => {
    // Both quantities are affine in the record count, so two builds fix each
    // shape's per-record slope and the ceiling frame follows from them. The
    // slopes are taken at small record indices, whose packed integers are
    // narrower than the ceiling's, so the extrapolated wire bytes understate the
    // real frame's while the declared count per record is exact.
    const small = 1_000;
    const large = 3_000;
    for (const { label, build } of RECORD_SHAPES) {
      const at = { small: build(small), large: build(large) };
      expect(scan(at.small.frame), `${label} was refused`).toBeUndefined();
      expect(scan(at.large.frame), `${label} was refused`).toBeUndefined();

      const span = large - small;
      const elementsPerRecord =
        (at.large.declaredElements - at.small.declaredElements) / span;
      const bytesPerRecord =
        (at.large.frame.byteLength - at.small.frame.byteLength) / span;
      const elementsAtCeiling =
        at.large.declaredElements +
        elementsPerRecord * (MAX_SINGLE_PASS_CELLS - large);
      const bytesAtCeiling =
        at.large.frame.byteLength +
        bytesPerRecord * (MAX_SINGLE_PASS_CELLS - large);
      expect(
        elementsAtCeiling,
        `${label} at ${MAX_SINGLE_PASS_CELLS} records declares ${elementsAtCeiling} elements over at least ${bytesAtCeiling} wire bytes`,
      ).toBeLessThan(bytesAtCeiling);
    }
  });
});

describe("scanFrameStructure: the map-key rule", () => {
  // A map key that is not a string on the wire is refused: the property name
  // `map[key] = value` coerces it to grows with the descendants `unpack`
  // zero-fills past the end of the buffer, not with the bytes the frame spends
  // declaring them. The real packer never emits such a key; the differential
  // suite holds that assumption.
  const refuses = (frame: Uint8Array): boolean =>
    scanRefuses(frame, 256, 1 << 20);

  test("refuses a map keyed by a container", () => {
    // fixmap(1) whose key is a fixarray(2): the coerced name is the joined form of
    // everything below it, so the whole subtree is refused at the key's marker.
    expect(refuses(new Uint8Array([0x81, 0x92, 0x01, 0x02, 0x08]))).toBe(true);
  });

  test("refuses a map keyed by a nested map", () => {
    expect(
      refuses(new Uint8Array([0x81, 0x81, ...fixstr("a"), 0x01, 0x08])),
    ).toBe(true);
  });

  test("refuses a map keyed by bin/raw, null, and a boolean alike", () => {
    expect(refuses(new Uint8Array([0x81, 0xa1, 0x41, 0x08]))).toBe(true); // fixraw(1)
    expect(refuses(new Uint8Array([0x81, 0xc0, 0x08]))).toBe(true); // null
    expect(refuses(new Uint8Array([0x81, 0xc3, 0x08]))).toBe(true); // true
    expect(
      refuses(new Uint8Array([0x81, 0xcb, 0, 0, 0, 0, 0, 0, 0, 0, 0x08])),
    ).toBe(true); // double
  });

  test("accepts every string marker at a key position", () => {
    // fixstr and str16 both name a property directly; neither is refused.
    expect(refuses(new Uint8Array([0x81, ...fixstr("abc"), 0x08]))).toBe(false);
    expect(
      refuses(new Uint8Array([0x81, 0xd8, 0x00, 0x03, 0x61, 0x62, 0x63, 0x08])),
    ).toBe(false);
  });

  test("refuses a key nested in a map that is itself a map's value", () => {
    // The rule follows the key positions of every map, not only the root's: an
    // integer-keyed map buried on a value side is refused just the same.
    expect(
      refuses(new Uint8Array([0x81, ...fixstr("a"), 0x81, 0x07, 0x08])),
    ).toBe(true);
  });

  test("leaves a map's values free to be any kind", () => {
    // Every non-string kind that is refused at a key position passes at a value
    // position, so the rule is scoped to keys rather than to kinds.
    expect(refuses(new Uint8Array([0x81, ...fixstr("a"), 0x07]))).toBe(false);
    expect(refuses(new Uint8Array([0x81, ...fixstr("a"), 0xc0]))).toBe(false);
    expect(
      refuses(new Uint8Array([0x81, ...fixstr("a"), 0x92, 0x01, 0x02])),
    ).toBe(false);
  });
});

/** Encode a value with the real BinaryPack packer and return the wire bytes, for
 * the tests whose surrounding case is already async. */
async function packFrame(value: Packable): Promise<Uint8Array> {
  return packSync(value);
}

/** A single value wrapped in `levels` arrays. */
function nestedArrays(levels: number): Packable {
  let value: Packable = 1;
  for (let d = 0; d < levels; d += 1) value = [value] as Packable;
  return value;
}

describe("scanFrameStructure: the rule a refusal names", () => {
  // A refusal names the rule that fired, so an operator (and any support thread
  // reading the failure) sees the control that refused the frame rather than a
  // stand-in. Each rule is driven by a frame the REAL packer produced, except
  // the two whose shapes it never emits -- a container declaring more elements
  // than its backing bytes, and a non-string map key -- assembled here as the
  // differential suite's concession for markers the packer never reaches.
  const wideStringCap = 1 << 20;

  /** The refusal `frame` draws under these limits; a frame the scan admits fails
   * the test here rather than at a confusing assertion downstream. */
  function refusalFor(
    frame: Uint8Array,
    maxDepth = 256,
    maxStringBytes = wideStringCap,
  ): FrameStructureRefusal {
    const refusal = scanFrameStructure(frame, maxDepth, maxStringBytes);
    if (refusal === undefined) throw new Error("the scan admitted the frame");
    return refusal;
  }

  test("names the nesting-depth cap", async () => {
    const frame = await packFrame(nestedArrays(12));
    expect(refusalFor(frame, 4)).toEqual({
      rule: "nesting-depth",
      limit: 4,
    });
  });

  test("names the per-string cap", async () => {
    const frame = await packFrame("x".repeat(4096));
    expect(refusalFor(frame, 256, 1024)).toEqual({
      rule: "string-bytes",
      limit: 1024,
    });
  });

  test("names the byte-backed-elements check", () => {
    // An array32 declaring 1,000 elements with no bytes behind it: the packer emits
    // the elements it declares, so this shape is assembled.
    expect(refusalFor(array32Header(1000))).toEqual({
      rule: "unbacked-elements",
    });
  });

  test("names the cumulative element rule", () => {
    // Two byte-backed levels over the same trailing bytes: the per-container rule
    // passes at each, the cumulative one does not.
    expect(refusalFor(nestedArrayFrame(2, 1024))).toEqual({
      rule: "total-elements",
    });
  });

  test("names the map-key rule", () => {
    // A fixmap keyed by a fixint, likewise assembled: the packer emits a map only
    // for a plain JS object, whose keys are strings.
    expect(refusalFor(new Uint8Array([0x81, 0x07, 0x08]))).toEqual({
      rule: "map-key",
    });
  });

  test("renders one fixed message per rule, whatever the refused frame declares", async () => {
    // The rendered text is composed from the receiving side's own limits alone, so
    // no length, count, depth, or byte the peer chose reaches an operator through
    // it. Each rule is put to two frames differing in every quantity the peer
    // controls, and both must render the same message.
    const cases: Array<{
      message: string;
      limits: [number, number];
      frames: Array<Uint8Array>;
    }> = [
      {
        message: "exceeds its 4-level nesting limit",
        limits: [4, wideStringCap],
        frames: [
          await packFrame(nestedArrays(12)),
          await packFrame(nestedArrays(200)),
        ],
      },
      {
        message: "exceeds its 1024-byte string limit",
        limits: [256, 1024],
        frames: [
          await packFrame("x".repeat(2048)),
          await packFrame("y".repeat(200_000)),
        ],
      },
      {
        message:
          "declares a container with more elements than the bytes behind it can encode",
        limits: [256, wideStringCap],
        frames: [array32Header(1000), array32Header(0xffffffff)],
      },
      {
        message:
          "declares more elements across the whole frame than its bytes can encode",
        limits: [256, wideStringCap],
        frames: [nestedArrayFrame(2, 1024), nestedArrayFrame(200, 700_000)],
      },
      {
        message: "keys a map with a value that is not a string",
        limits: [256, wideStringCap],
        frames: [
          new Uint8Array([0x81, 0x07, 0x08]), // fixint key
          new Uint8Array([0x81, ...array32Header(0xffffffff), 0x08]), // array32 key
        ],
      },
    ];

    for (const { message, limits, frames } of cases) {
      for (const frame of frames) {
        expect(
          describeFrameStructureRefusal(refusalFor(frame, ...limits)),
          `a ${frame.byteLength}-byte frame rendered another message`,
        ).toBe(message);
      }
    }
  });
});
