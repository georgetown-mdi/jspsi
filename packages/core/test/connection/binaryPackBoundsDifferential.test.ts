import { describe, expect, test } from "vitest";

import { pack, unpack } from "peerjs-js-binarypack";

import {
  MAX_WEBRTC_FRAME_BYTES,
  MAX_WEBRTC_REASSEMBLY_DEPTH,
  MAX_WEBRTC_STRING_BYTES,
  scanFrameStructure,
} from "../../src/connection/binaryPackBounds";

import type { FrameStructureRefusal } from "../../src/connection/binaryPackBounds";
import type { Packable, Unpackable } from "peerjs-js-binarypack";

// The differential counterpart to binaryPackBounds.test.ts, which drives the scan
// against hand-written fixtures. Here the oracle is the REAL peerjs-js-binarypack:
// every frame is produced by the real `pack` (or, for the markers that packer never
// emits, assembled around real-packed parts), and what each frame decodes to is read
// off the value the real `unpack` returns rather than from a second walk of the wire.
//
// `peerjs-js-binarypack` is an exact-pinned devDependency of THIS package
// (packages/core/package.json), so the guard holds whether or not an app keeps the
// dependency: the scan lives here, and so does the pin backing it
// (docs/spec/DEPENDENCY_PINS.md).
//
// What this suite holds is the scan's reading of the wire against the real
// unpacker's: that the two agree on every marker's payload width and child count,
// that no frame psilink sends is refused, and that the two shapes the rules exist
// for are the shapes the real unpacker really amplifies. What an admitted frame
// RETAINS is measured, not modelled, in binaryPackRetention.test.ts.

/** The trailing value every probe frame has after the marker under test. Both
 * the real unpacker and the scan must land on it at the same offset, so a marker
 * whose payload width the scan skips differently shifts onto a payload byte instead
 * and charges something else. It is a string rather than a small integer precisely
 * so that mis-landing is expensive to hide: its weight (a string header plus two
 * bytes per character) is far from the scalar weight an arbitrary payload byte would
 * most often be charged. */
const SENTINEL = "marker-tail";

/** The BinaryPack marker classes `readValueHeader` dispatches on, as the byte ranges
 * that select each branch, in marker order. This is the coverage denominator: the
 * scan dispatches on one leading byte, so a list that partitions 0x00-0xff covers its
 * whole dispatch surface -- a partition the first test below asserts rather than
 * assumes. */
const MARKER_CLASSES = [
  { name: "positive fixint", lo: 0x00, hi: 0x7f },
  { name: "fixmap", lo: 0x80, hi: 0x8f },
  { name: "fixarray", lo: 0x90, hi: 0x9f },
  { name: "fixraw", lo: 0xa0, hi: 0xaf },
  { name: "fixstr", lo: 0xb0, hi: 0xbf },
  { name: "null", lo: 0xc0, hi: 0xc0 },
  { name: "undefined", lo: 0xc1, hi: 0xc1 },
  { name: "false", lo: 0xc2, hi: 0xc2 },
  { name: "true", lo: 0xc3, hi: 0xc3 },
  { name: "reserved", lo: 0xc4, hi: 0xc9 },
  { name: "float", lo: 0xca, hi: 0xca },
  { name: "double", lo: 0xcb, hi: 0xcb },
  { name: "uint8", lo: 0xcc, hi: 0xcc },
  { name: "uint16", lo: 0xcd, hi: 0xcd },
  { name: "uint32", lo: 0xce, hi: 0xce },
  { name: "uint64", lo: 0xcf, hi: 0xcf },
  { name: "int8", lo: 0xd0, hi: 0xd0 },
  { name: "int16", lo: 0xd1, hi: 0xd1 },
  { name: "int32", lo: 0xd2, hi: 0xd2 },
  { name: "int64", lo: 0xd3, hi: 0xd3 },
  { name: "unused", lo: 0xd4, hi: 0xd7 },
  { name: "str16", lo: 0xd8, hi: 0xd8 },
  { name: "str32", lo: 0xd9, hi: 0xd9 },
  { name: "raw16", lo: 0xda, hi: 0xda },
  { name: "raw32", lo: 0xdb, hi: 0xdb },
  { name: "array16", lo: 0xdc, hi: 0xdc },
  { name: "array32", lo: 0xdd, hi: 0xdd },
  { name: "map16", lo: 0xde, hi: 0xde },
  { name: "map32", lo: 0xdf, hi: 0xdf },
  { name: "negative fixint", lo: 0xe0, hi: 0xff },
] as const;

type MarkerName = (typeof MARKER_CLASSES)[number]["name"];

/** How a probe frame was produced: `packer` frames are entirely the real encoder's
 * output; `assembled` frames have a hand-written header for a marker the pinned
 * packer never chooses, with every surrounding value still real-packed. */
type FrameSource = "packer" | "assembled";

interface MarkerCase {
  marker: MarkerName;
  label: string;
  source: FrameSource;
  /** `fixarray(2)` of the probe value and {@link SENTINEL}, so the marker under test
   * sits at offset 1 and is followed by a value both sides must agree on. */
  frame: Uint8Array;
}

/** Encode a value with the real BinaryPack packer and return the wire bytes. The
 * packer resolves synchronously for everything but a `Blob`, which no corpus value
 * is; the await keeps the declared type accurate. */
async function packBytes(value: Packable): Promise<Uint8Array> {
  return new Uint8Array(await pack(value));
}

/** Decode with the real BinaryPack unpacker. The published signature declares an
 * `ArrayBuffer`, but the implementation wraps its argument in `new Uint8Array(...)`,
 * so a view is exactly what PeerJS hands it on the wire; this is the one place that
 * bridges the declared type to the real call shape. */
function unpackFrame(bytes: Uint8Array): Unpackable {
  return unpack<Unpackable>(bytes as unknown as ArrayBuffer);
}

function concatBytes(parts: Array<Uint8Array>): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** A probe frame the real packer produces whole: `[value, SENTINEL]` as a
 * `fixarray`, so the marker the packer chose for `value` lands at offset 1. */
async function packedCase(
  marker: MarkerName,
  label: string,
  value: Packable,
): Promise<MarkerCase> {
  return {
    marker,
    label,
    source: "packer",
    frame: await packBytes([value, SENTINEL]),
  };
}

/** A probe frame for a marker the pinned packer never emits: the same
 * `fixarray(2)` wrapper and sentinel, taken from the real packer, around
 * hand-written marker bytes. The frame is still legal BinaryPack the real
 * `unpack` reads, which is what the scan must agree with -- the scan reads the
 * wire, not the encoder. */
async function assembledCase(
  marker: MarkerName,
  label: string,
  markerBytes: Array<number>,
): Promise<MarkerCase> {
  const [wrapper] = await packBytes([SENTINEL, SENTINEL]);
  const sentinel = await packBytes(SENTINEL);
  return {
    marker,
    label,
    source: "assembled",
    frame: concatBytes([
      new Uint8Array([wrapper]),
      new Uint8Array(markerBytes),
      sentinel,
    ]),
  };
}

/** A 4-byte big-endian element/byte count, the width `array32`/`map32`/`str32`/
 * `raw32` headers state. */
function u32Bytes(count: number): Array<number> {
  return [
    (count >>> 24) & 0xff,
    (count >>> 16) & 0xff,
    (count >>> 8) & 0xff,
    count & 0xff,
  ];
}

/**
 * One probe frame per marker class {@link MARKER_CLASSES} names.
 *
 * Most classes are reached from a real value the pinned packer encodes. Seven are
 * assembled instead, because no value routes the packer there (which seven is
 * pinned as a check below, not left to this comment): `undefined` packs as `null`
 * (0xc0), a fractional number packs as a `double`
 * (0xcb) rather than a `float`, a large integer packs as an `int64` (0xd3) rather
 * than a `uint64`, the `reserved`/`unused` ranges are markers the format assigns no
 * value to, and `array32`/`map32` need more than 65535 elements -- a count the
 * packer's per-element recursion cannot reach before exhausting the call stack,
 * though the unpacker's loops decode them with no such limit. Every one of the
 * seven is still a frame the real `unpack` reads, and the assertions below take
 * their reference from it.
 */
async function buildMarkerCorpus(): Promise<Array<MarkerCase>> {
  const bigString = "s".repeat(70000); // > 65535 wire bytes -> str32, under the cap
  const raw16Bytes = new Uint8Array(300);
  for (let i = 0; i < raw16Bytes.length; i++) raw16Bytes[i] = (i * 7) & 0xff;
  const raw32Bytes = new Uint8Array(70000);
  for (let i = 0; i < raw32Bytes.length; i++)
    raw32Bytes[i] = (i * 31 + 7) & 0xff;

  const map16: { [key: string]: Packable } = {};
  for (let i = 0; i < 16; i++) map16["field" + i.toString()] = i;

  const cases: Array<MarkerCase> = [
    await packedCase("positive fixint", "0", 0),
    await packedCase("positive fixint", "127", 127),
    await packedCase("negative fixint", "-1", -1),
    await packedCase("negative fixint", "-32", -32),
    await packedCase("fixmap", "{a:1}", { a: 1 }),
    await packedCase("fixarray", "[1,2]", [1, 2]),
    await packedCase(
      "fixraw",
      "3-byte buffer",
      new Uint8Array([1, 2, 3]).buffer,
    ),
    await packedCase("fixstr", '"a"', "a"),
    await packedCase("fixstr", "15-byte string", "x".repeat(15)),
    await packedCase("fixstr", "multibyte under 16 bytes", "café 日本"),
    await packedCase("null", "null", null),
    await packedCase("false", "false", false),
    await packedCase("true", "true", true),
    await packedCase("double", "0.5", 0.5),
    await packedCase("uint8", "128", 128),
    await packedCase("uint16", "256", 256),
    await packedCase("uint32", "65536", 65536),
    await packedCase("int8", "-33", -33),
    await packedCase("int16", "-129", -129),
    await packedCase("int32", "-32769", -32769),
    await packedCase("int64", "2^32", 4294967296),
    await packedCase("str16", "16-byte string", "y".repeat(16)),
    await packedCase("str16", "multibyte over 15 bytes", "café 日本語 😀"),
    await packedCase("str32", "70000-char string", bigString),
    await packedCase("raw16", "300-byte buffer", raw16Bytes.buffer),
    await packedCase("raw32", "70000-byte buffer", raw32Bytes.buffer),
    await packedCase("array16", "16 fixints", new Array<number>(16).fill(1)),
    await packedCase("map16", "16 fields", map16),
    await assembledCase("undefined", "0xc1", [0xc1]),
    await assembledCase(
      "float",
      "1.5 as float32",
      [0xca, 0x3f, 0xc0, 0x00, 0x00],
    ),
    await assembledCase("uint64", "2^33", [0xcf, 0, 0, 0, 2, 0, 0, 0, 0]),
  ];

  // The reserved and unused ranges hold no value, so every byte in them is probed
  // rather than one representative: the scan charges each a scalar with no payload,
  // and the sentinel that follows proves the real unpacker skips no payload either.
  for (let byte = 0xc4; byte <= 0xc9; byte++) {
    cases.push(
      await assembledCase("reserved", "0x" + byte.toString(16), [byte]),
    );
  }
  for (let byte = 0xd4; byte <= 0xd7; byte++) {
    cases.push(await assembledCase("unused", "0x" + byte.toString(16), [byte]));
  }

  // Wide containers, whose bodies are real-packed values behind a hand-written
  // header. The declared count is small: the header's width, not the element count,
  // is what selects the marker the scan dispatches on, and a small count keeps the
  // sentinel check exact. The amplification shape a large count implies is driven
  // separately by `wideArrayFrame` below and by binaryPackBounds.test.ts.
  const array32Body = concatBytes([
    await packBytes(1),
    await packBytes(2),
    await packBytes(3),
  ]);
  cases.push(
    await assembledCase("array32", "3 elements", [
      0xdd,
      ...u32Bytes(3),
      ...array32Body,
    ]),
  );
  const map32Body = concatBytes([
    await packBytes("alpha"),
    await packBytes(1),
    await packBytes("beta"),
    await packBytes(2),
  ]);
  cases.push(
    await assembledCase("map32", "2 pairs", [
      0xdf,
      ...u32Bytes(2),
      ...map32Body,
    ]),
  );

  return cases;
}

/** The marker corpus, built once per file run: it is a deterministic packing
 * workload every caller walks read-only, so rebuilding it per test buys nothing. */
let markerCorpusOnce: Promise<Array<MarkerCase>> | undefined;
function markerCorpus(): Promise<Array<MarkerCase>> {
  return (markerCorpusOnce ??= buildMarkerCorpus());
}

/** A chain of `levels` `array16` headers, each declaring `declared` children, with
 * `padding` one-byte values behind the innermost -- so every level declares no more
 * children than the bytes that follow it, and the wire spends its element bytes once
 * rather than once per level. What the real unpacker builds from that is not modeled
 * here: the tests below decode the frame and read the structure it produced. */
function nestedArrayFrame(
  levels: number,
  declared: number,
  padding: number,
): Uint8Array {
  const parts: Array<number> = [];
  for (let i = 0; i < levels; i++) {
    parts.push(0xdc, (declared >>> 8) & 0xff, declared & 0xff);
  }
  for (let i = 0; i < padding; i++) parts.push(0x01);
  return new Uint8Array(parts);
}

/** The same chain at a width only an `array32` header can declare. */
function wideNestedArrayFrame(
  levels: number,
  declared: number,
  padding: number,
): Uint8Array {
  const parts: Array<number> = [];
  for (let i = 0; i < levels; i++) parts.push(0xdd, ...u32Bytes(declared));
  for (let i = 0; i < padding; i++) parts.push(0x01);
  return new Uint8Array(parts);
}

/** A `map16` of `count` pairs whose keys are real-packed doubles -- a shape the
 * packer never emits from a JS object, whose keys are already strings, but which the
 * real `unpack_map` reads and turns into coerced property names. Each key's bytes are
 * the real encoder's; only the surrounding map header is assembled. */
async function numericKeyMapFrame(count: number): Promise<Uint8Array> {
  const parts: Array<Uint8Array> = [
    new Uint8Array([0xde, (count >>> 8) & 0xff, count & 0xff]),
  ];
  for (let i = 0; i < count; i++) {
    parts.push(await packBytes((i + 1) * Math.PI));
    parts.push(await packBytes(i & 0x7f));
  }
  return concatBytes(parts);
}

/** A deterministic 32-bit PRNG (mulberry32), so the generated nested structures are
 * fixed run to run and no unseeded randomness gates an assertion. */
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

/** Seeded nested arrays and objects mixing every value kind, so the differential
 * covers deep structure -- the container recursion both the real unpacker and the
 * scan walk -- and not only the one-marker probe frames. */
function nestedValues(seed: number, count: number): Array<Packable> {
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

/** The frame shape the WebRTC transport actually sends -- an array of
 * `{theirIndex, iteration}` records -- so the differential covers the largest
 * legitimate non-binary frame, not only synthetic shapes. */
function mappedElementFrame(n: number): Packable {
  const out: Array<{ theirIndex: number; iteration: number }> = [];
  for (let i = 0; i < n; i++) out.push({ theirIndex: i, iteration: i % 3 });
  return out;
}

/** An `array32` declaring `count` elements, each the real packer's encoding of a
 * one-byte value, so the wide-container amplification shape is driven at a count no
 * `array16` header can express and every element byte is still the encoder's. */
async function wideArrayFrame(count: number): Promise<Uint8Array> {
  const element = await packBytes(1);
  const body = new Uint8Array(count * element.length);
  for (let i = 0; i < count; i++) body.set(element, i * element.length);
  return concatBytes([new Uint8Array([0xdd, ...u32Bytes(count)]), body]);
}

/** An `array32` declaring `count` elements, each the real packer's encoding of an
 * empty binary value, so a frame's declared `bin`/`raw` inventory is driven at a
 * count no `array16` header can express and every element byte is the encoder's. */
async function binaryArrayFrame(count: number): Promise<Uint8Array> {
  const element = await packBytes(new ArrayBuffer(0));
  const body = new Uint8Array(count * element.length);
  for (let i = 0; i < count; i++) body.set(element, i * element.length);
  return concatBytes([new Uint8Array([0xdd, ...u32Bytes(count)]), body]);
}

/** Whole-frame shapes, at the root rather than wrapped in a probe array. */
async function buildShapeCorpus(): Promise<
  Array<{ label: string; frame: Uint8Array }>
> {
  const entries: Array<{ label: string; frame: Uint8Array }> = [];
  const values: Array<{ label: string; value: Packable }> = [
    {
      label: "record object",
      value: {
        theirIndex: 7,
        iteration: 2,
        status: "matched",
        note: "café 😀",
      },
    },
  ];
  nestedValues(0x5eed1234, 24).forEach((value, i) =>
    values.push({ label: `nested[${i}]`, value }),
  );
  [0, 1, 2, 50, 512, 4000].forEach((n) =>
    values.push({ label: `mapped-frame[${n}]`, value: mappedElementFrame(n) }),
  );
  for (const { label, value } of values) {
    entries.push({ label, frame: await packBytes(value) });
  }
  entries.push({
    label: "array32[65536]",
    frame: await wideArrayFrame(65536),
  });
  return entries;
}

/** The shape corpus, built once per file run, on the same read-only terms as the
 * marker corpus. */
let shapeCorpusOnce:
  Promise<Array<{ label: string; frame: Uint8Array }>> | undefined;
function shapeCorpus(): Promise<Array<{ label: string; frame: Uint8Array }>> {
  return (shapeCorpusOnce ??= buildShapeCorpus());
}

/** Every frame the cost differential drives: the per-marker probes and the
 * whole-frame shapes, each walked by the same assertions. */
async function allFrames(): Promise<
  Array<{ label: string; frame: Uint8Array }>
> {
  const markers = (await markerCorpus()).map(({ marker, label, frame }) => ({
    label: `${marker}: ${label}`,
    frame,
  }));
  return [...markers, ...(await shapeCorpus())];
}

const utf8 = new TextEncoder();

/** The scan's verdict on `frame` under the production depth and per-string
 * limits. */
function scanVerdict(frame: Uint8Array): FrameStructureRefusal | undefined {
  return scanFrameStructure(
    frame,
    MAX_WEBRTC_REASSEMBLY_DEPTH,
    MAX_WEBRTC_STRING_BYTES,
  );
}

/** Whether the scan admits `frame` under those same limits. */
function scanAdmits(frame: Uint8Array): boolean {
  return scanVerdict(frame) === undefined;
}

describe("the BinaryPack marker classes the scan dispatches on", () => {
  test("partition every byte a marker can be", () => {
    for (let byte = 0x00; byte <= 0xff; byte++) {
      const matched = MARKER_CLASSES.filter(
        ({ lo, hi }) => byte >= lo && byte <= hi,
      );
      expect(
        matched.map(({ name }) => name),
        `0x${byte.toString(16)} is not classified exactly once`,
      ).toHaveLength(1);
    }
  });

  test("are each reached by a probe frame", async () => {
    const covered = new Set((await markerCorpus()).map(({ marker }) => marker));
    expect([...covered].sort()).toEqual(
      MARKER_CLASSES.map(({ name }) => name)
        .slice()
        .sort(),
    );
  });

  test("are each reached from a real value, bar the seven the packer never emits", async () => {
    // Which classes had to be assembled rather than packed is the corpus's one
    // concession, so it is pinned here: a bump that starts emitting one of these --
    // or stops emitting one of the rest -- is a red test rather than a corpus that
    // has quietly stopped exercising the real encoder.
    const assembled = (await markerCorpus())
      .filter(({ source }) => source === "assembled")
      .map(({ marker }) => marker);
    expect([...new Set(assembled)].sort()).toEqual(
      [
        "array32",
        "float",
        "map32",
        "reserved",
        "uint64",
        "undefined",
        "unused",
      ].sort(),
    );
  });
});

/** The marker class a wire byte selects, by the same byte ranges the scan dispatches
 * on -- exactly one, since {@link MARKER_CLASSES} partitions the byte. */
function markerClassOf(byte: number): MarkerName {
  const matched = MARKER_CLASSES.find(({ lo, hi }) => byte >= lo && byte <= hi);
  if (matched === undefined) {
    throw new Error(`0x${byte.toString(16)} matches no marker class`);
  }
  return matched.name;
}

describe("the real packer's marker table", () => {
  test("puts each probe value's marker where the scan reads it", async () => {
    for (const { marker, label, source, frame } of await markerCorpus()) {
      if (source !== "packer") continue;
      expect(
        markerClassOf(frame[0]),
        `${marker}/${label}: the packer no longer wraps a two-element array in a fixarray`,
      ).toBe("fixarray");
      expect(
        markerClassOf(frame[1]),
        `${marker}/${label}: the packer emitted 0x${frame[1].toString(16)}`,
      ).toBe(marker);
    }
  });

  test("chooses another marker for the three values that could reach an assembled one", async () => {
    // Three of the seven assembled classes have a value that would plausibly encode
    // there and does not; the other four have none at all (`reserved` and `unused`
    // have no value, and `array32`/`map32` need a container wider than the packer's
    // per-element recursion survives). Pinned as a check so a bump that starts
    // emitting one of these three is a red test rather than a stale corpus comment.
    expect(
      (await packBytes(undefined))[0],
      "undefined no longer packs as null",
    ).toBe(0xc0);
    expect(
      (await packBytes(1.5))[0],
      "a fraction no longer packs as a double",
    ).toBe(0xcb);
    expect(
      (await packBytes(8589934592))[0],
      "a large positive integer no longer packs as an int64",
    ).toBe(0xd3);
  });

  test("agrees with the real unpacker on where each probe's payload ends", async () => {
    // The sentinel that follows the marker under test lands at index 1 of the decoded
    // array only if the real unpacker consumed exactly the marker's declared payload.
    // The scan's charge is compared against this same decode, so a width the two read
    // differently cannot pass unnoticed here.
    for (const { marker, label, frame } of await markerCorpus()) {
      const decoded = unpackFrame(frame);
      expect(
        Array.isArray(decoded),
        `${marker}/${label}: probe frame did not decode to an array`,
      ).toBe(true);
      const elements = decoded as Array<unknown>;
      expect(
        elements,
        `${marker}/${label}: probe frame lost an element`,
      ).toHaveLength(2);
      expect(
        elements[1],
        `${marker}/${label}: the sentinel moved, so the payload width diverges`,
      ).toBe(SENTINEL);
    }
  });

  test("writes a mapped-element index past 65,535 in a wide marker", async () => {
    // A mapped-element record's index takes a marker whose payload width the scan
    // has to skip by exactly, and at the record counts a real exchange reaches that
    // marker is a wide one. Read off the packer rather than off its ranges.
    const record = await packBytes({ theirIndex: 6_000_000, iteration: 2 });
    expect(markerClassOf(record[0]), "the record is no longer a fixmap").toBe(
      "fixmap",
    );
    const afterKey = 1 + 1 + "theirIndex".length; // the fixmap byte, then the key
    expect(markerClassOf(record[afterKey])).toBe("uint32");
  });

  test("round-trips a string's declared wire byte length", async () => {
    // The per-string cap is enforced on the DECLARED wire length, so what the
    // unpacker builds from those bytes has to be the string they encode: a decode
    // that dropped or added code points would put the cap on a different quantity
    // than the one it is set against.
    for (const value of [
      "",
      "a",
      "café",
      "日本語",
      "😀🎉",
      "mixed: a é 語 😀 end",
      "z".repeat(300),
      "s".repeat(70000),
    ]) {
      const decoded = unpackFrame(await packBytes(value));
      expect(
        decoded,
        "the unpacker did not return the string it was given",
      ).toBe(value);
      expect(
        utf8.encode(decoded as string).length,
        "re-encoding the decode does not recover the declared wire length",
      ).toBe(utf8.encode(value).length);
    }
  });
});

describe("scanFrameStructure against the real unpacker", () => {
  test("admits every real-encoded frame under the production limits", async () => {
    // No corpus frame comes near the production limits, so a refusal here is a
    // divergence -- a marker the scan mis-reads relative to the real unpacker --
    // and not a tight test limit firing.
    for (const { label, frame } of await allFrames()) {
      expect(
        scanFrameStructure(
          frame,
          MAX_WEBRTC_REASSEMBLY_DEPTH,
          MAX_WEBRTC_STRING_BYTES,
        ),
        `${label}: the scan refused a frame the real unpacker accepts`,
      ).toBeUndefined();
    }
  });
});

describe("scanFrameStructure on the shapes the wire size understates", () => {
  // The corpus above is every frame a real encoder produces, and in all of them the
  // wire holds each declared value. These are the two shapes where what `unpack`
  // retains is decided by something other than the bytes it reads: a declared count
  // an ancestor reserves room for, and a key the assignment coerces. Each is decoded
  // by the real unpacker here, so what the rules answer is a structure that decode
  // really produces.

  test("the real unpacker reserves every level of a nested chain in full", async () => {
    const frame = nestedArrayFrame(6, 20, 20);
    const decoded = unpackFrame(frame);

    // What the real unpacker builds from this frame, read off the decode rather
    // than assumed: six levels, each the full declared width, with only the
    // innermost level's elements on the wire.
    let level: unknown = decoded;
    for (let d = 0; d < 6; d++) {
      expect(Array.isArray(level), `level ${d}: not an array`).toBe(true);
      const elements = level as Array<unknown>;
      expect(elements, `level ${d}: not the declared width`).toHaveLength(20);
      level = elements[0];
    }
    expect(
      level,
      "the innermost level did not decode the wire's elements",
    ).toBe(1);

    // That reservation per level is what the per-container rule cannot see and
    // the cumulative one does: six levels declare 120 children between them over
    // 38 wire bytes.
    expect(scanVerdict(frame)).toEqual({ rule: "total-elements" });
  });

  test("refuses a nested chain whose reserved stores outrun its wire size", () => {
    // 200 levels of 700,000 declared children each, every level with more bytes
    // behind it than children in front of it, so the byte-backed rule is met at
    // every level and the frame stays under a megabyte. The real unpacker
    // reserves 1.1 GB for it; the cumulative element rule is what refuses it.
    const frame = wideNestedArrayFrame(200, 700_000, 700_000);
    expect(frame.byteLength).toBeLessThan(1024 * 1024);
    expect(scanVerdict(frame)).toEqual({ rule: "total-elements" });
  });

  test("admits the same declared count backed at one level", () => {
    // The refused chain's near neighbour: one level declaring the same 700,000
    // children over the same element bytes. What the rule turns on is a count
    // declared once per level, not the count itself.
    const frame = wideNestedArrayFrame(1, 700_000, 700_000);
    expect(scanAdmits(frame)).toBe(true);
    expect(unpackFrame(frame)).toHaveLength(700_000);
  });

  test("refuses a map whose keys the real unpacker coerces from packed doubles", async () => {
    const pairs = 500;
    const frame = await numericKeyMapFrame(pairs);
    const decoded = unpackFrame(frame) as Record<string, unknown>;

    // The real unpacker does retain one coerced property name per pair, so the
    // refusal below is answering a retention this frame really would impose.
    const names = Object.keys(decoded);
    expect(
      names,
      "the map did not decode to one property per pair",
    ).toHaveLength(pairs);
    expect(names[0]).toBe(String(Math.PI));

    expect(scanAdmits(frame), "a non-string map key was admitted").toBe(false);
  });

  test("refuses a map keyed by a container, whatever the unpacker would join it into", () => {
    const elements = 50;
    const frame = concatBytes([
      new Uint8Array([0x81, 0xdc, 0x00, elements]), // fixmap(1), array16(50) key
      new Uint8Array(elements).fill(0x01),
      new Uint8Array([0x07]),
    ]);
    const decoded = unpackFrame(frame) as Record<string, unknown>;

    const names = Object.keys(decoded);
    expect(names).toHaveLength(1);
    expect(
      names[0],
      "the array key did not coerce to its joined element forms",
    ).toBe(new Array<number>(elements).fill(1).join(","));

    expect(scanAdmits(frame), "a container map key was admitted").toBe(false);
  });
});

describe("scanFrameStructure on a frame of bin/raw values", () => {
  // A `bin`/`raw` element is one wire byte at its shortest and decodes to a view of
  // its own, the flat shape whose wire size says least about what `unpack` retains
  // (the per-value figure is measured in binaryPackRetention.test.ts). The rules
  // here admit it; the wire-byte cap is what bounds both the views and the payloads
  // they wrap.

  test("the real unpacker retains one view per declared element", async () => {
    const count = 2_000;
    const frame = await binaryArrayFrame(count);
    const decoded = unpackFrame(frame) as Array<unknown>;

    expect(
      decoded,
      "the frame did not decode to one value per declared element",
    ).toHaveLength(count);
    const buffers = new Set<ArrayBufferLike>();
    for (const value of decoded) {
      expect(
        ArrayBuffer.isView(value),
        "an element did not decode to a binary view",
      ).toBe(true);
      buffers.add((value as Uint8Array).buffer);
    }
    // Each view holds a buffer of its own rather than a window onto the frame, so
    // the measured per-value retention is answering a cost the decode really
    // imposes.
    expect(buffers.size, "the decoded views share their backing buffer").toBe(
      count,
    );
  });

  test("admits a frame of declared views far below the wire cap", async () => {
    // One wire byte per element: five million views inside four megabytes of wire,
    // admitted, so what bounds this shape is the wire cap and the measured
    // per-view retention rather than a rule here.
    const frame = await binaryArrayFrame(5_000_000);
    expect(frame.byteLength).toBeLessThan(MAX_WEBRTC_FRAME_BYTES);
    expect(scanAdmits(frame)).toBe(true);
  });
});

/** Every top-level value psilink hands a PeerJS data connection's `send()`, which is
 * what `pack` puts on the WebRTC wire: the kex handshake frames, the protocol-setup
 * exchange, the PSI engine's binary frames, the association/iteration tables, the
 * payload and receipt messages, and the CLI leg's AEAD envelope. Shapes taken from
 * the send sites in kex.ts, protocolSetup.ts, participant.ts, link.ts,
 * payloadExchange.ts, signedReceipt.ts, and connection/encryptedMessageConnection.ts.
 * Field values are representative rather than real; only the SHAPES bind the key
 * rule, since a JS object's own keys are strings whatever they hold. */
function webrtcSendSiteValues(): Array<{ label: string; value: Packable }> {
  const bin = (n: number): ArrayBuffer => new Uint8Array(n).fill(7).buffer;
  return [
    { label: "kex abort", value: { kexMsg: "abort" } },
    { label: "kex msg1", value: { kexMsg: "1", e: "BASE64", reqEnc: false } },
    {
      label: "kex msg2",
      value: { kexMsg: "2", e: "BASE64", confirm: "MAC", reqEnc: false },
    },
    { label: "kex msg3", value: { kexMsg: "3", confirm: "MAC" } },
    {
      label: "setup abort",
      value: { decision: "abort", abortReasons: ["count mismatch"] },
    },
    {
      label: "setup terms",
      value: {
        linkageTerms: {
          version: 1,
          keyColumns: [
            {
              name: "first_name",
              transforms: [
                { function: "lowercase" },
                { function: "split_on", params: { delimiter: " " } },
              ],
            },
          ],
          payloadColumns: ["zip"],
        },
        recordCount: 12345,
        protocolVersion: 1,
        save: true,
        disclosesPayload: false,
        hostKey: { fingerprint: "SHA256:abcd", keyType: "ssh-ed25519" },
        decision: "proceed",
      },
    },
    { label: "setup proceed", value: { decision: "proceed" } },
    { label: "setup shared secret", value: { sharedSecret: "BASE64" } },
    { label: "psi engine bytes", value: bin(4096) },
    { label: "local indices", value: [0, 3, 7, 11] },
    {
      label: "association table",
      value: [
        [0, 4, 9],
        [1, 2, 3],
      ],
    },
    { label: "iteration map", value: mappedElementFrame(64) },
    { label: "status completed", value: { status: "completed" } },
    { label: "payload absent", value: { hasData: false } },
    {
      label: "payload present",
      value: {
        hasData: true,
        columns: ["zip", "sex"],
        rowIndices: [0, 1],
        rows: [
          ["20001", "M"],
          ["20002", null],
        ],
      },
    },
    {
      label: "signed receipt",
      value: {
        certificate: {
          version: 1,
          algorithm: "ES256",
          identity: "partner@example.org",
          publicKey: { kty: "EC", crv: "P-256", x: "BASE64X", y: "BASE64Y" },
          signature: "BASE64SIG",
        },
        signature: "BASE64SIG",
      },
    },
    { label: "aead envelope", value: bin(1 + 12 + 4096 + 16) },
  ];
}

describe("the map-key rule against the real packer", () => {
  // The rule refuses any frame whose map key is not a string on the wire, which is
  // safe only because no legitimate frame holds one. That is a claim about the
  // real packer's behavior on the real send-site shapes, so it is driven here rather
  // than asserted in prose: the scan itself is the detector, since a non-string key
  // anywhere in a frame refuses it.

  test("admits every value psilink sends on the WebRTC data channel", async () => {
    for (const { label, value } of webrtcSendSiteValues()) {
      const frame = await packBytes(value);
      expect(
        scanAdmits(frame),
        `the scan refused a real-packed ${label} frame`,
      ).toBe(true);
    }
  });

  test("refuses to pack the JS values that would hold a non-string key", () => {
    // A map on the wire comes only from a plain JS object, whose own keys are
    // strings. The structures that could key one otherwise are rejected by the
    // packer itself -- synchronously, before any wire bytes exist -- so a send
    // site that reached for one fails at the sender rather than emitting a frame
    // every receiver refuses.
    for (const value of [
      new Map([["a", 1]]),
      new Map([[1, "one"]]),
      new Set([1, 2, 3]),
    ]) {
      expect(() => pack(value as unknown as Packable)).toThrow(
        /not yet supported/,
      );
    }
  });
});

describe("a non-string map key over a cursor underrun", () => {
  // Dangerous together: a map key whose subtree declares more descendants
  // than the wire backs, so the cursor underruns. An underrun alone leaves the
  // zero-filled elements in stores an ancestor's declared count already
  // committed, but under a key the unpacker joins the whole zero-filled subtree
  // into one property name, whose size grows with what the frame declares rather
  // than with the wire. The key rule decides on the marker byte before the scan
  // descends, so an underrun deeper in the frame can't reach it.

  const LEVELS = 8;
  const WIDTH = 20_000;

  /** `levels` nested `array32` headers each declaring `width` children, with only
   * the innermost level's children on the wire. */
  function unbackedChain(levels: number, width: number): Uint8Array {
    const parts: Array<Uint8Array> = [];
    for (let i = 0; i < levels; i++) {
      parts.push(new Uint8Array([0xdd, ...u32Bytes(width)]));
    }
    parts.push(new Uint8Array(width).fill(0x01));
    return concatBytes(parts);
  }

  /** The chain at a map's KEY position, with the map's value off the end. */
  const atKey = (): Uint8Array =>
    concatBytes([new Uint8Array([0x81]), unbackedChain(LEVELS, WIDTH)]);

  /** An `array32` declaring twice as many children as the real-packed doubles
   * behind it, so the cursor underruns inside it while every other rule is met:
   * the doubles back the declared count byte for byte, and the declared total
   * stays far under the frame's own size. */
  async function underrunningContainer(doubles: number): Promise<Uint8Array> {
    const parts: Array<Uint8Array> = [
      new Uint8Array([0xdd, ...u32Bytes(doubles * 2)]),
    ];
    for (let i = 0; i < doubles; i++) {
      parts.push(await packBytes((i + 1) * Math.PI));
    }
    return concatBytes(parts);
  }

  test("an underrunning container at a value position is admitted", async () => {
    // The control: an underrun ALONE is not what refuses a frame. This container
    // declares 40 children over 20 real-packed doubles, sits behind a real string
    // key, and is admitted -- so what the key-position cases below refuse is the
    // key, not the underrun.
    const frame = concatBytes([
      new Uint8Array([0x81, 0xb1, 0x6b]), // fixmap(1), fixstr "k"
      await underrunningContainer(20),
    ]);
    expect(scanAdmits(frame)).toBe(true);

    // The declared children really do outrun the wire: the unpacker reserves all
    // 40 and zero-fills the 20 the bytes do not reach.
    const outer = (unpackFrame(frame) as Record<string, unknown>)["k"];
    expect(Array.isArray(outer) && outer.length).toBe(40);
    expect((outer as Array<unknown>)[39]).toBe(0);
  });

  test("refuses the same underrunning container at a key position", async () => {
    const frame = concatBytes([
      new Uint8Array([0x81]),
      await underrunningContainer(20),
    ]);
    expect(scanVerdict(frame)).toEqual({ rule: "map-key" });
  });

  test("refuses the chain at a key position on the key's marker alone", () => {
    // The key rule decides before the scan descends, so it fires on this chain
    // rather than the cumulative element rule its subtree would otherwise draw.
    expect(scanVerdict(atKey())).toEqual({ rule: "map-key" });
    expect(scanVerdict(unbackedChain(LEVELS, WIDTH))).toEqual({
      rule: "total-elements",
    });
  });

  test("the real unpacker amplifies that frame into one oversized property name", () => {
    // Driving the real unpacker on the refused bytes: they coerce a whole
    // zero-filled key subtree into a single property name an order of magnitude
    // larger than the wire that declared it. Measured here so the refusal is
    // answering a real cost, and so a packer bump that stopped coercing shows up as
    // a changed figure rather than a silently idle rule.
    const frame = atKey();
    const decoded = unpackFrame(frame) as Record<string, unknown>;
    const names = Object.keys(decoded);
    expect(names).toHaveLength(1);

    expect(names[0].length).toBeGreaterThan(300_000);
    expect(
      names[0].length / frame.byteLength,
      `the coerced name is ${names[0].length} characters over ${frame.byteLength} wire bytes`,
    ).toBeGreaterThan(15);
  });
});
