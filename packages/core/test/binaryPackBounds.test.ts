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
 * model: a root array, plus per record its slot in that array, one object, the
 * object's four declared slots, and two key strings. This is the derivation the
 * production budget is sized against. */
function expectedMappedCost(n: number): number {
  const perRecord =
    WEBRTC_VALUE_WEIGHTS.scalar +
    WEBRTC_VALUE_WEIGHTS.object +
    4 * WEBRTC_VALUE_WEIGHTS.scalar +
    stringWeightOf("theirIndex".length) +
    stringWeightOf("iteration".length);
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
      coercedKeyName: 64,
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

  test("charges an integer the one backing slot its container reserves", () => {
    // fixarray(1) of a fixint: the element allocates nothing of its own, so the
    // array's base weight plus its single declared slot is the whole cost.
    atBoundary(
      new Uint8Array([0x91, 0x01]),
      WEBRTC_VALUE_WEIGHTS.array + WEBRTC_VALUE_WEIGHTS.scalar,
    );
  });

  test("charges a wide number marker (double) the same one slot", () => {
    // double (0xcb + 8 payload bytes) is a HeapNumber at runtime but is charged
    // only its container's slot here; this pins the documented under-count -- the
    // wire-byte cap, not the structure budget, is the backstop for a number-heavy
    // frame.
    atBoundary(
      new Uint8Array([0x91, 0xcb, 0, 0, 0, 0, 0, 0, 0, 0]),
      WEBRTC_VALUE_WEIGHTS.array + WEBRTC_VALUE_WEIGHTS.scalar,
    );
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

  test("charges a non-string map key the coerced property-name weight", () => {
    // fixmap(1) keyed by a fixint: `map[key] = value` retains the key's coerced
    // string form as the property name, which the key's own slot does not cover.
    atBoundary(
      new Uint8Array([0x81, 0x07, 0x08]),
      WEBRTC_VALUE_WEIGHTS.object +
        2 * WEBRTC_VALUE_WEIGHTS.scalar +
        WEBRTC_VALUE_WEIGHTS.coercedKeyName,
    );
  });

  test("charges a string map key nothing beyond the string itself", () => {
    // fixmap(1) keyed by "abc": the property name IS that string, already charged
    // in full, so no coerced-name weight is added on top of it.
    atBoundary(
      new Uint8Array([0x81, ...fixstr("abc"), 0x08]),
      WEBRTC_VALUE_WEIGHTS.object +
        2 * WEBRTC_VALUE_WEIGHTS.scalar +
        stringWeightOf(3),
    );
  });

  test("charges every non-string value beneath a container key", () => {
    // fixmap(1) whose key is a fixarray(2) of fixints: the key coerces to the
    // joined string forms of the values below it, so each of them is charged a
    // coerced-name weight as well as its slot.
    atBoundary(
      new Uint8Array([0x81, 0x92, 0x01, 0x02, 0x08]),
      WEBRTC_VALUE_WEIGHTS.object +
        2 * WEBRTC_VALUE_WEIGHTS.scalar +
        WEBRTC_VALUE_WEIGHTS.array +
        2 * WEBRTC_VALUE_WEIGHTS.scalar +
        3 * WEBRTC_VALUE_WEIGHTS.coercedKeyName,
    );
  });

  test("leaves a map's values uncharged by the coerced-name weight", () => {
    // fixmap(1) keyed by "a" with a fixarray(2) VALUE: nothing on the value side
    // becomes a property name, so the coerced-name weight is charged nowhere here.
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
