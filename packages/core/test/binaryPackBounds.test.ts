import { pack } from "peerjs-js-binarypack";
import { describe, expect, test } from "vitest";

import {
  MAX_CHUNKS_PER_REASSEMBLY,
  MAX_CONCURRENT_REASSEMBLIES,
  MAX_WEBRTC_FRAME_BYTES,
  MAX_WEBRTC_FRAME_STRUCTURE_BYTES,
  MAX_WEBRTC_REASSEMBLY_DEPTH,
  MAX_WEBRTC_STRING_BYTES,
  MIN_CHUNK_RESIDENT_BYTES,
  WEBRTC_VALUE_WEIGHTS,
  describeFrameStructureRefusal,
  scanFrameStructure,
} from "../src/connection/binaryPackBounds";

import type { FrameStructureRefusal } from "../src/connection/binaryPackBounds";
import type { Packable } from "peerjs-js-binarypack";

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
 * of two pairs with the real string keys, a small (fixint) `iteration`, and
 * `theirIndex` under one of two widths -- a fixint at 127 and below, a `uint32`
 * above it (the differential suite checks the real packer's width choices at
 * scale). Exactly the shape `conn.send` serializes for the largest legitimate
 * inbound frame. */
function mappedRecord(theirIndex: number, iteration: number): Array<number> {
  const index =
    theirIndex > 0x7f
      ? [
          0xce,
          (theirIndex >>> 24) & 0xff,
          (theirIndex >>> 16) & 0xff,
          (theirIndex >>> 8) & 0xff,
          theirIndex & 0xff,
        ]
      : [theirIndex];
  return [
    0x82, // fixmap(2)
    ...fixstr("theirIndex"),
    ...index,
    ...fixstr("iteration"),
    iteration & 0x7f, // fixint
  ];
}

/** A BinaryPack array16 of `n` mapped-element records (the mapped-element frame),
 * indexed from `firstIndex` so the frame can be built at either index width.
 * Bounded to the array16 count so a large `n` fails loud rather than silently
 * truncating the header; the budget derivation uses {@link expectedMappedCost}
 * (pure arithmetic) for the multi-million-record ceiling, never a real buffer. */
function mappedElementFrame(n: number, firstIndex = 0): Uint8Array {
  if (n > 0xffff)
    throw new RangeError(`mappedElementFrame: n=${n} exceeds array16`);
  const out: Array<number> = [0xdc, (n >>> 8) & 0xff, n & 0xff];
  for (let i = 0; i < n; i++)
    out.push(...mappedRecord(firstIndex + (i % 128), 0));
  return new Uint8Array(out);
}

/** Resident weight of a string of `byteLen` wire bytes under the cost model. */
function stringWeightOf(byteLen: number): number {
  return (
    WEBRTC_VALUE_WEIGHTS.stringBase +
    WEBRTC_VALUE_WEIGHTS.stringPerByte * byteLen
  );
}

/** The charged retained cost of one mapped-element record under the cost model: its
 * slot in the root array, one object, the object's four declared slots, and two key
 * strings -- plus the boxed-number weight when the record's index is wide enough to
 * take a `uint32` marker. */
function mappedRecordCost(wideIndex: boolean): number {
  return (
    WEBRTC_VALUE_WEIGHTS.scalar +
    WEBRTC_VALUE_WEIGHTS.object +
    4 * WEBRTC_VALUE_WEIGHTS.scalar +
    stringWeightOf("theirIndex".length) +
    stringWeightOf("iteration".length) +
    (wideIndex ? WEBRTC_VALUE_WEIGHTS.boxedNumber : 0)
  );
}

/** The charged retained cost of an `n`-record mapped-element frame: the root array
 * plus each record's cost. This is the derivation the production budget is sized
 * against. */
function expectedMappedCost(n: number, wideIndex = false): number {
  return WEBRTC_VALUE_WEIGHTS.array + n * mappedRecordCost(wideIndex);
}

describe("the WebRTC inbound bound constants", () => {
  // Each value is specified normatively in docs/spec/CHANNEL_SECURITY.md (WebRTC
  // data-channel inbound bound). Pinned here as literals so a silent retune of a
  // bound fails rather than quietly widening the memory envelope a security
  // review signed off on; changing one means changing the spec with it.
  test("hold the values the channel-security spec names", () => {
    expect(MAX_WEBRTC_FRAME_BYTES).toBe(268_435_456);
    expect(MAX_WEBRTC_FRAME_STRUCTURE_BYTES).toBe(1_073_741_824);
    expect(MAX_WEBRTC_REASSEMBLY_DEPTH).toBe(256);
    expect(MAX_WEBRTC_STRING_BYTES).toBe(1_048_576);
    expect(MAX_CHUNKS_PER_REASSEMBLY).toBe(131_072);
    expect(MAX_CONCURRENT_REASSEMBLIES).toBe(8);
    expect(MIN_CHUNK_RESIDENT_BYTES).toBe(256);
  });

  test("charge the per-kind retained weights the spec table names", () => {
    expect(WEBRTC_VALUE_WEIGHTS).toEqual({
      object: 64,
      array: 40,
      scalar: 8,
      boxedNumber: 16,
      stringBase: 16,
      stringPerByte: 2,
      binary: 256,
    });
  });
});

describe("scanFrameStructure", () => {
  test("flags a string longer than the per-string byte cap", () => {
    expect(scanRefuses(str32Header(1000), 1_000_000, 256, 100)).toBe(true);
  });

  test("passes a short fixstr under the per-string cap", () => {
    // fixstr "abc" (0xb3 + 3 bytes) is one value and well under any string cap.
    expect(
      scanRefuses(new Uint8Array([0xb3, 0x61, 0x62, 0x63]), 100, 256, 100),
    ).toBe(false);
  });

  test("flags a fixstr over the per-string cap, uniformly with the wide markers", () => {
    // fixstr "abcd" (4 bytes) against a 2-byte cap: the cap fires on fixstr too,
    // not only str16/str32, so the marker dispatch is one rule.
    expect(scanRefuses(new Uint8Array(fixstr("abcd")), 1000, 256, 2)).toBe(
      true,
    );
  });
});

describe("scanFrameStructure: the per-value cost model", () => {
  // Each value kind is a single-value frame charged exactly its documented weight:
  // a budget one byte below the weight rejects, a budget at the weight accepts. The
  // string cap is left wide so only the structural weight is under test.
  const atBoundary = (frame: Uint8Array, weight: number): void => {
    expect(scanRefuses(frame, weight - 1, 256, 1 << 20)).toBe(true);
    expect(scanRefuses(frame, weight, 256, 1 << 20)).toBe(false);
  };

  test("charges an empty object the object weight", () => {
    atBoundary(new Uint8Array([0x80]), WEBRTC_VALUE_WEIGHTS.object); // fixmap(0)
  });

  test("charges an empty array the array weight", () => {
    atBoundary(new Uint8Array([0x90]), WEBRTC_VALUE_WEIGHTS.array); // fixarray(0)
  });

  test("charges an integer the one backing slot its container reserves", () => {
    // fixarray(1) of a fixint: the element allocates nothing of its own, so the
    // array's base weight plus its single declared slot is the whole cost.
    atBoundary(
      new Uint8Array([0x91, 0x01]),
      WEBRTC_VALUE_WEIGHTS.array + WEBRTC_VALUE_WEIGHTS.scalar,
    );
  });

  test("charges every wide number marker the boxed weight above its slot", () => {
    // A number the container's slot cannot hold is boxed on the heap, so each
    // marker wide enough to hold such a value is charged that box on top of the
    // slot -- whatever value the marker actually holds, so the charge reads the
    // wire alone rather than the engine's small-integer range.
    const payload = (n: number): Array<number> => new Array<number>(n).fill(0);
    for (const marker of [
      [0xca, ...payload(4)], // float
      [0xce, ...payload(4)], // uint32
      [0xd2, ...payload(4)], // int32
      [0xcb, ...payload(8)], // double
      [0xcf, ...payload(8)], // uint64
      [0xd3, ...payload(8)], // int64
    ]) {
      atBoundary(
        new Uint8Array([0x91, ...marker]),
        WEBRTC_VALUE_WEIGHTS.array +
          WEBRTC_VALUE_WEIGHTS.scalar +
          WEBRTC_VALUE_WEIGHTS.boxedNumber,
      );
    }
  });

  test("charges a narrow number marker its container's slot alone", () => {
    // The markers whose whole value range fits the smallest small-integer range an
    // engine draws: nothing is ever boxed for them, so the slot is the whole cost
    // and the boxed weight would be dead over-charge.
    const payload = (n: number): Array<number> => new Array<number>(n).fill(0);
    for (const marker of [
      [0x01], // positive fixint
      [0xff], // negative fixint
      [0xcc, ...payload(1)], // uint8
      [0xd0, ...payload(1)], // int8
      [0xcd, ...payload(2)], // uint16
      [0xd1, ...payload(2)], // int16
    ]) {
      atBoundary(
        new Uint8Array([0x91, ...marker]),
        WEBRTC_VALUE_WEIGHTS.array + WEBRTC_VALUE_WEIGHTS.scalar,
      );
    }
  });

  test("charges a bin/raw value its view overhead above the container's slot", () => {
    // fixarray(1) of a fixraw(0): the element decodes to a Uint8Array of its own, so
    // the frame costs the array's base weight, the slot the array reserved for that
    // element, and the per-value binary weight on top of it.
    atBoundary(
      new Uint8Array([0x91, 0xa0]),
      WEBRTC_VALUE_WEIGHTS.array +
        WEBRTC_VALUE_WEIGHTS.scalar +
        WEBRTC_VALUE_WEIGHTS.binary,
    );
  });

  test("charges every bin/raw marker alike, whatever payload it declares", () => {
    // One value each, charged the same per-value weight: what varies with the
    // declared length is the payload, which is ~1x the wire bytes and so bounded by
    // the wire-byte cap rather than by this budget.
    const payload = (n: number): Array<number> =>
      new Array<number>(n).fill(0x41);
    for (const frame of [
      new Uint8Array([0xa0]), // fixraw(0)
      new Uint8Array([0xaa, ...payload(10)]), // fixraw(10)
      new Uint8Array([0xda, 0x01, 0x2c, ...payload(300)]), // raw16(300)
      new Uint8Array([0xdb, 0, 0, 0x01, 0x2c, ...payload(300)]), // raw32(300)
    ]) {
      atBoundary(frame, WEBRTC_VALUE_WEIGHTS.binary);
    }
  });

  test("charges a container's declared slots at its own header", () => {
    // An array16 of 40 elements backed by 40 wire bytes: the backing store is
    // charged from the DECLARED count at the header, so the same total is reached
    // whether or not the scan goes on to read every element.
    atBoundary(
      arrayOfFixints(40),
      WEBRTC_VALUE_WEIGHTS.array + 40 * WEBRTC_VALUE_WEIGHTS.scalar,
    );
  });

  test("charges every ancestor's declared slots in a nest, not only the innermost", () => {
    // Three array16 headers each declaring 40 elements, with 40 wire bytes behind
    // the innermost. Every level reserves its own 40-slot backing store, so the
    // charge is three arrays and 120 slots even though only the innermost level's
    // elements are on the wire.
    const nested = new Uint8Array([
      0xdc,
      0x00,
      40,
      0xdc,
      0x00,
      40,
      ...arrayOfFixints(40),
    ]);
    atBoundary(
      nested,
      3 * WEBRTC_VALUE_WEIGHTS.array + 120 * WEBRTC_VALUE_WEIGHTS.scalar,
    );
  });

  test("charges a string map key nothing beyond the string itself", () => {
    // fixmap(1) keyed by "abc": the property name IS that string, charged in full
    // by the string weight and by nothing else.
    atBoundary(
      new Uint8Array([0x81, ...fixstr("abc"), 0x08]),
      WEBRTC_VALUE_WEIGHTS.object +
        2 * WEBRTC_VALUE_WEIGHTS.scalar +
        stringWeightOf(3),
    );
  });

  test("charges a non-string value at a map's VALUE position nothing extra", () => {
    // fixmap(1) keyed by "a" with a fixarray(2) VALUE: only keys are refused, so a
    // container on the value side is charged exactly what it would cost anywhere.
    atBoundary(
      new Uint8Array([0x81, ...fixstr("a"), 0x92, 0x01, 0x02]),
      WEBRTC_VALUE_WEIGHTS.object +
        2 * WEBRTC_VALUE_WEIGHTS.scalar +
        stringWeightOf(1) +
        WEBRTC_VALUE_WEIGHTS.array +
        2 * WEBRTC_VALUE_WEIGHTS.scalar,
    );
  });

  test("charges a string its header plus per-byte weight", () => {
    // fixstr "abcd": stringBase + 4 * stringPerByte.
    atBoundary(new Uint8Array(fixstr("abcd")), stringWeightOf(4));
  });

  test("the cost is additive across a mapped-element record", () => {
    // One record charges object + two key strings + two scalars; the array root
    // adds the array weight. Pinned against the real BinaryPack-encoded shape.
    expect(scanRefuses(mappedElementFrame(1), expectedMappedCost(1), 256)).toBe(
      false,
    );
    expect(
      scanRefuses(mappedElementFrame(1), expectedMappedCost(1) - 1, 256),
    ).toBe(true);
  });

  test("a wide index adds the boxed weight to the record's cost", () => {
    // The same record at an index past 65,535 -- where every record of a
    // multi-million-record frame sits -- costs the boxed weight more, the
    // difference the budget's admitted-record derivation turns on.
    const frame = mappedElementFrame(1, 100_000);
    const cost = expectedMappedCost(1, true);
    expect(cost - expectedMappedCost(1)).toBe(WEBRTC_VALUE_WEIGHTS.boxedNumber);
    expect(scanRefuses(frame, cost, 256)).toBe(false);
    expect(scanRefuses(frame, cost - 1, 256)).toBe(true);
  });

  test("the mapped cost of 2^22 records stays under the structure budget", () => {
    // The wire-byte cap and the structure budget are independent, with no
    // headroom relation between them -- this pins the mapped cost of a
    // 4.19M-record (2^22) frame against the structure budget alone, at the
    // conservative per-record weight a multi-million-record frame's wide indices
    // hold.
    expect(expectedMappedCost(4_194_304, true)).toBeLessThan(
      MAX_WEBRTC_FRAME_STRUCTURE_BYTES,
    );
  });

  test("the budget refuses a boxed-number frame before the wire cap does", () => {
    // What the boxed weight closes: the cheapest boxed number is 5 wire bytes (a
    // 4-byte payload behind its marker) charged 24 with its slot, so the wire a
    // frame must spend to meet this budget stays inside the wire-byte cap. The
    // structure budget is therefore the binding control for a number-heavy frame,
    // rather than leaving its retention to the wire cap.
    const CHEAPEST_BOXED_WIRE_BYTES = 5;
    const perValue =
      WEBRTC_VALUE_WEIGHTS.scalar + WEBRTC_VALUE_WEIGHTS.boxedNumber;
    const valuesAtBudget = Math.ceil(
      MAX_WEBRTC_FRAME_STRUCTURE_BYTES / perValue,
    );
    expect(valuesAtBudget * CHEAPEST_BOXED_WIRE_BYTES).toBeLessThan(
      MAX_WEBRTC_FRAME_BYTES,
    );
  });
});

describe("scanFrameStructure: the map-key rule", () => {
  // A map key that is not a string on the wire is refused rather than costed: the
  // property name `map[key] = value` coerces it to grows with the descendants
  // `unpack` zero-fills past the end of the buffer, not with the bytes the frame
  // spends declaring them, so no charge taken during the walk can bound it. The
  // real packer emits a map only for a plain JS object, whose keys are strings, so
  // no legitimate frame is refused here -- the differential suite holds that
  // assumption to the real packer.
  const refuses = (frame: Uint8Array): boolean =>
    scanRefuses(frame, Number.MAX_SAFE_INTEGER, 256, 1 << 20);

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

/** Encode a value with the real BinaryPack packer and return the wire bytes. The
 * packer resolves synchronously for everything but a `Blob`, which nothing here
 * packs; the await keeps the declared type honest. */
async function packFrame(value: Packable): Promise<Uint8Array> {
  return new Uint8Array(await pack(value));
}

/** `n` mapped-element records, the shape of the largest legitimate frame. */
function records(n: number): Packable {
  return Array.from({ length: n }, (_, i) => ({
    theirIndex: i,
    iteration: 0,
  })) as Packable;
}

/** `n` binary values of `bytes` each: the kind charged the `binary` weight on top
 * of its container's slot, so a frame of them meets the retained-byte budget on
 * that weight rather than on its containers. */
function binaryValues(n: number, bytes: number): Packable {
  return Array.from({ length: n }, () => new ArrayBuffer(bytes)) as Packable;
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
  const wideBudget = Number.MAX_SAFE_INTEGER;
  const wideStringCap = 1 << 20;

  /** The refusal `frame` draws under these limits; a frame the scan admits fails
   * the test here rather than at a confusing assertion downstream. */
  function refusalFor(
    frame: Uint8Array,
    maxStructureBytes: number,
    maxDepth = 256,
    maxStringBytes = wideStringCap,
  ): FrameStructureRefusal {
    const refusal = scanFrameStructure(
      frame,
      maxStructureBytes,
      maxDepth,
      maxStringBytes,
    );
    if (refusal === undefined) throw new Error("the scan admitted the frame");
    return refusal;
  }

  test("names the retained-byte budget for a frame of packed records", async () => {
    const frame = await packFrame(records(200));
    expect(refusalFor(frame, 1000)).toEqual({
      rule: "structure-bytes",
      limit: 1000,
    });
  });

  test("names the retained-byte budget for a frame of packed binary values", async () => {
    // The `binary` weight has no rule of its own: a frame of `bin`/`raw` values
    // meets the same budget every other kind is charged against. The boundary is
    // pinned so the refusal is that weight's doing and not the root array's -- the
    // array and its slots alone are 200 of the 5,320 charged bytes.
    const frame = await packFrame(binaryValues(20, 4));
    const cost =
      WEBRTC_VALUE_WEIGHTS.array +
      20 * (WEBRTC_VALUE_WEIGHTS.scalar + WEBRTC_VALUE_WEIGHTS.binary);
    expect(scanFrameStructure(frame, cost, 256, wideStringCap)).toBeUndefined();
    expect(refusalFor(frame, cost - 1)).toEqual({
      rule: "structure-bytes",
      limit: cost - 1,
    });
  });

  test("names the nesting-depth cap", async () => {
    const frame = await packFrame(nestedArrays(12));
    expect(refusalFor(frame, wideBudget, 4)).toEqual({
      rule: "nesting-depth",
      limit: 4,
    });
  });

  test("names the per-string cap", async () => {
    const frame = await packFrame("x".repeat(4096));
    expect(refusalFor(frame, wideBudget, 256, 1024)).toEqual({
      rule: "string-bytes",
      limit: 1024,
    });
  });

  test("names the byte-backed-elements check", () => {
    // An array32 declaring 1,000 elements with no bytes behind it: the packer emits
    // the elements it declares, so this shape is assembled.
    expect(refusalFor(array32Header(1000), wideBudget)).toEqual({
      rule: "unbacked-elements",
    });
  });

  test("names the map-key rule", () => {
    // A fixmap keyed by a fixint, likewise assembled: the packer emits a map only
    // for a plain JS object, whose keys are strings.
    expect(refusalFor(new Uint8Array([0x81, 0x07, 0x08]), wideBudget)).toEqual({
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
      limits: [number, number, number];
      frames: Array<Uint8Array>;
    }> = [
      {
        message: "exceeds its 1000-byte structure limit",
        limits: [1000, 256, wideStringCap],
        frames: [
          await packFrame(records(200)),
          await packFrame(binaryValues(300, 4096)),
        ],
      },
      {
        message: "exceeds its 4-level nesting limit",
        limits: [wideBudget, 4, wideStringCap],
        frames: [
          await packFrame(nestedArrays(12)),
          await packFrame(nestedArrays(200)),
        ],
      },
      {
        message: "exceeds its 1024-byte string limit",
        limits: [wideBudget, 256, 1024],
        frames: [
          await packFrame("x".repeat(2048)),
          await packFrame("y".repeat(200_000)),
        ],
      },
      {
        message:
          "declares a container with more elements than the bytes behind it can encode",
        limits: [wideBudget, 256, wideStringCap],
        frames: [array32Header(1000), array32Header(0xffffffff)],
      },
      {
        message: "keys a map with a value that is not a string",
        limits: [wideBudget, 256, wideStringCap],
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
