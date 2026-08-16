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
  structureOverBudget,
} from "../src/connection/binaryPackBounds";

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
 * truncating the header; the budget derivation uses {@link expectedMappedCost}
 * (pure arithmetic) for the multi-million-record ceiling, never a real buffer. */
function mappedElementFrame(n: number): Uint8Array {
  if (n > 0xffff)
    throw new RangeError(`mappedElementFrame: n=${n} exceeds array16`);
  const out: Array<number> = [0xdc, (n >>> 8) & 0xff, n & 0xff];
  for (let i = 0; i < n; i++) out.push(...mappedRecord(i % 128, 0));
  return new Uint8Array(out);
}

/** Resident weight of a string of `byteLen` wire bytes under the cost model. */
function stringWeightOf(byteLen: number): number {
  return (
    WEBRTC_VALUE_WEIGHTS.stringBase +
    WEBRTC_VALUE_WEIGHTS.stringPerByte * byteLen
  );
}

/** The charged retained cost of an `n`-record mapped-element frame under the cost
 * model: a root array, plus per record one object, two key strings, two integers.
 * This is the derivation the production budget is sized against. */
function expectedMappedCost(n: number): number {
  const perRecord =
    WEBRTC_VALUE_WEIGHTS.object +
    stringWeightOf("theirIndex".length) +
    WEBRTC_VALUE_WEIGHTS.scalar +
    stringWeightOf("iteration".length) +
    WEBRTC_VALUE_WEIGHTS.scalar;
  return WEBRTC_VALUE_WEIGHTS.array + n * perRecord;
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
      stringBase: 16,
      stringPerByte: 2,
    });
  });
});

describe("structureOverBudget", () => {
  test("flags a flat array over the byte budget", () => {
    // 40 + 50*8 = 440 retained bytes, over a 100-byte budget.
    expect(structureOverBudget(arrayOfFixints(50), 100, 256)).toBe(true);
  });

  test("passes a flat array under the byte budget", () => {
    expect(structureOverBudget(arrayOfFixints(50), 1000, 256)).toBe(false);
  });

  test("flags an array declaring more than the bytes that follow", () => {
    expect(structureOverBudget(array32Header(1000), 1_000_000, 256)).toBe(true);
  });

  test("flags a string longer than the per-string byte cap", () => {
    expect(structureOverBudget(str32Header(1000), 1_000_000, 256, 100)).toBe(
      true,
    );
  });

  test("passes a short fixstr under the per-string cap", () => {
    // fixstr "abc" (0xb3 + 3 bytes) is one value and well under any string cap.
    expect(
      structureOverBudget(
        new Uint8Array([0xb3, 0x61, 0x62, 0x63]),
        100,
        256,
        100,
      ),
    ).toBe(false);
  });

  test("flags a fixstr over the per-string cap, uniformly with the wide markers", () => {
    // fixstr "abcd" (4 bytes) against a 2-byte cap: the cap fires on fixstr too,
    // not only str16/str32, so the marker dispatch is one rule.
    expect(
      structureOverBudget(new Uint8Array(fixstr("abcd")), 1000, 256, 2),
    ).toBe(true);
  });

  test("flags excessive nesting depth", () => {
    // Each level is one byte-backed array of one element; deeper than the cap.
    const out: Array<number> = [];
    for (let d = 0; d < 10; d++) out.push(0x91); // fixarray(1)
    out.push(0x01); // a fixint leaf
    expect(structureOverBudget(new Uint8Array(out), 1000, 4)).toBe(true);
  });
});

describe("structureOverBudget: the per-value cost model", () => {
  // Each value kind is a single-value frame charged exactly its documented weight:
  // a budget one byte below the weight rejects, a budget at the weight accepts. The
  // string cap is left wide so only the structural weight is under test.
  const atBoundary = (frame: Uint8Array, weight: number): void => {
    expect(structureOverBudget(frame, weight - 1, 256, 1 << 20)).toBe(true);
    expect(structureOverBudget(frame, weight, 256, 1 << 20)).toBe(false);
  };

  test("charges an empty object the object weight", () => {
    atBoundary(new Uint8Array([0x80]), WEBRTC_VALUE_WEIGHTS.object); // fixmap(0)
  });

  test("charges an empty array the array weight", () => {
    atBoundary(new Uint8Array([0x90]), WEBRTC_VALUE_WEIGHTS.array); // fixarray(0)
  });

  test("charges an integer the scalar weight", () => {
    atBoundary(new Uint8Array([0x01]), WEBRTC_VALUE_WEIGHTS.scalar); // fixint
  });

  test("charges a wide number marker (double) the scalar weight", () => {
    // double (0xcb + 8 payload bytes) is a HeapNumber at runtime but is charged
    // the scalar slot here; this pins the documented under-count -- the wire-byte
    // cap, not the structure budget, is the backstop for a number-heavy frame.
    atBoundary(
      new Uint8Array([0xcb, 0, 0, 0, 0, 0, 0, 0, 0]),
      WEBRTC_VALUE_WEIGHTS.scalar,
    );
  });

  test("charges a string its header plus per-byte weight", () => {
    // fixstr "abcd": stringBase + 4 * stringPerByte.
    atBoundary(new Uint8Array(fixstr("abcd")), stringWeightOf(4));
  });

  test("the cost is additive across a mapped-element record", () => {
    // One record charges object + two key strings + two scalars; the array root
    // adds the array weight. Pinned against the real BinaryPack-encoded shape.
    expect(
      structureOverBudget(mappedElementFrame(1), expectedMappedCost(1), 256),
    ).toBe(false);
    expect(
      structureOverBudget(
        mappedElementFrame(1),
        expectedMappedCost(1) - 1,
        256,
      ),
    ).toBe(true);
  });

  test("the mapped cost of 2^22 records stays under the structure budget", () => {
    // The wire-byte cap and the structure budget are independent, with no
    // headroom relation between them -- this pins the mapped cost of a
    // 4.19M-record (2^22) frame against the structure budget alone, at the
    // conservative per-record weight.
    expect(expectedMappedCost(4_194_304)).toBeLessThan(
      MAX_WEBRTC_FRAME_STRUCTURE_BYTES,
    );
  });
});
