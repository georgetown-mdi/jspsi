import { describe, expect, test } from "vitest";

import { pack, unpack } from "peerjs-js-binarypack";

import {
  MAX_WEBRTC_FRAME_STRUCTURE_BYTES,
  MAX_WEBRTC_REASSEMBLY_DEPTH,
  MAX_WEBRTC_STRING_BYTES,
  scanFrameStructure,
} from "../../src/connection/binaryPackBounds";
import { encodeBinaryPackValue } from "../../src/connection/binaryPackEncode";

import type { Packable, Unpackable } from "peerjs-js-binarypack";

// The half of the encoder's coverage the real packer cannot witness: the frame
// sizes past its own recursion ceiling, and the value kinds the encoder refuses
// rather than guesses at. The byte-for-byte comparison against the pinned packer
// is in binaryPackEncodeDifferential.test.ts.
//
// Above the ceiling the oracle is the real `unpack` -- a frame this encoder
// wrote must deserialize to the value it was given -- plus the inbound
// structural scan, which every one of these frames has to pass for a partner to
// accept it.

/** The frames whose size follows the matched-record count, built as their send
 * sites build them (packages/core/src/psi/link.ts,
 * packages/core/src/psi/participant.ts, packages/core/src/payloadExchange.ts). */
const RECORD_SCALING_FRAMES = [
  {
    name: "iteration map",
    build: (n: number) =>
      Array.from({ length: n }, (_, index) => ({
        theirIndex: index,
        iteration: index % 3,
      })),
  },
  {
    name: "association table",
    build: (n: number) => [
      Array.from({ length: n }, (_, index) => index),
      Array.from({ length: n }, (_, index) => (index * 7) % (n || 1)),
    ],
  },
  {
    name: "local indices",
    build: (n: number) => Array.from({ length: n }, (_, index) => index * 2),
  },
  {
    name: "payload frame",
    build: (n: number) => ({
      hasData: true,
      columns: ["zip", "sex"],
      rowIndices: Array.from({ length: n }, (_, index) => index),
      rows: Array.from({ length: n }, (_, index) => [
        String(20001 + (index % 900)),
        index % 5 === 0 ? null : "M",
      ]),
    }),
  },
] as const;

/** Record counts past the pinned packer's own recursion ceiling (measured at
 * roughly 7,800 records): the first round number above it, the 16-bit container
 * boundary where the header widens to `array32`/`map32`, and the size the
 * end-to-end suites drive. */
const ABOVE_THE_CEILING = [10_000, 65_536, 200_000];

describe("encodeBinaryPackValue: frames the pinned packer cannot write", () => {
  test("the pinned packer overflows the stack where this encoder does not", () => {
    const overCeiling = RECORD_SCALING_FRAMES[0].build(200_000);
    expect(() => pack(overCeiling as Packable)).toThrow(RangeError);
    expect(encodeBinaryPackValue(overCeiling).byteLength).toBeGreaterThan(0);
  });

  for (const { name, build } of RECORD_SCALING_FRAMES) {
    for (const size of ABOVE_THE_CEILING) {
      test(`${name} at ${size} records round-trips and is admitted`, () => {
        const frame = build(size);
        const encoded = new Uint8Array(encodeBinaryPackValue(frame));

        expect(
          scanFrameStructure(
            encoded,
            MAX_WEBRTC_FRAME_STRUCTURE_BYTES,
            MAX_WEBRTC_REASSEMBLY_DEPTH,
            MAX_WEBRTC_STRING_BYTES,
          ),
        ).toBeUndefined();
        expect(unpack<Unpackable>(encoded as unknown as ArrayBuffer)).toEqual(
          frame,
        );
      });
    }
  }
});

describe("encodeBinaryPackValue: nesting", () => {
  test("descends past the depth the pinned packer's call stack allows", () => {
    let value: unknown = 1;
    for (let depth = 0; depth < 100_000; depth += 1) value = [value];
    expect(() => pack(value as Packable)).toThrow(RangeError);
    expect(encodeBinaryPackValue(value).byteLength).toBe(100_001);
  });
});

describe("encodeBinaryPackValue: refusals", () => {
  const refused: Array<{ label: string; value: unknown }> = [
    { label: "a Date", value: new Date(0) },
    { label: "a Map", value: new Map([["a", 1]]) },
    { label: "a Set", value: new Set([1]) },
    { label: "a class instance", value: new (class Frame {})() },
    { label: "an object with no prototype", value: Object.create(null) },
    { label: "a function", value: () => 1 },
    { label: "a symbol", value: Symbol("frame") },
    { label: "a bigint", value: 1n },
    { label: "a DataView", value: new DataView(new ArrayBuffer(4)) },
  ];

  for (const { label, value } of refused) {
    test(`refuses ${label}`, () => {
      expect(() => encodeBinaryPackValue(value)).toThrowError(
        /cannot BinaryPack an outbound frame/,
      );
    });

    test(`refuses ${label} nested in a frame`, () => {
      expect(() => encodeBinaryPackValue({ rows: [value] })).toThrowError(
        /cannot BinaryPack an outbound frame/,
      );
    });
  }

  // The packer reads a value's own `constructor` to decide a map and calls its
  // own `hasOwnProperty` to decide each key, so an own key of either name
  // shadows a check the packer makes; the encoder must refuse wherever the
  // packer does, not write a map the packer would not have.
  const packerShadows: Array<{ key: string; value: object }> = [
    { key: "constructor", value: { constructor: 1, theirIndex: 0 } },
    { key: "hasOwnProperty", value: { hasOwnProperty: 1, theirIndex: 0 } },
  ];

  for (const { key, value } of packerShadows) {
    test(`refuses an object whose own ${key} key the packer also refuses`, () => {
      expect(() => pack(value as unknown as Packable)).toThrow();
      expect(() => encodeBinaryPackValue(value)).toThrowError(
        /cannot BinaryPack an outbound frame/,
      );
    });
  }

  test("refuses an object that holds itself, rather than walking forever", () => {
    const frame: Record<string, unknown> = { theirIndex: 0 };
    frame.parent = frame;
    expect(() => pack(frame as Packable)).toThrow(RangeError);
    expect(() => encodeBinaryPackValue(frame)).toThrowError(
      /an outbound frame that holds itself/,
    );
  });

  test("refuses an array that holds itself, rather than walking forever", () => {
    const frame: Array<unknown> = [1];
    frame.push(frame);
    expect(() => pack(frame as Packable)).toThrow(RangeError);
    expect(() => encodeBinaryPackValue(frame)).toThrowError(
      /an outbound frame that holds itself/,
    );
  });

  test("refuses a number the pinned packer also refuses", () => {
    expect(() => pack(Number.MAX_VALUE as Packable)).toThrow();
    expect(() => encodeBinaryPackValue(Number.MAX_VALUE)).toThrowError(
      /a number outside the integer range/,
    );
  });

  test("names the refused kind without quoting the value", () => {
    expect(() => encodeBinaryPackValue({ when: new Date(0) })).toThrowError(
      /an instance of Date/,
    );
  });

  test("refuses with a usage-kind connection error", () => {
    expect(() => encodeBinaryPackValue(new Date(0))).toThrowError(
      expect.objectContaining({ name: "ConnectionError", kind: "usage" }),
    );
  });
});
