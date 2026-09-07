import { describe, expect, test } from "vitest";

import { pack } from "peerjs-js-binarypack";

import { encodeBinaryPackValue } from "../../src/connection/binaryPackEncode";

import type { Packable } from "peerjs-js-binarypack";

// The oracle suite for the outbound encoder: every assertion here compares the
// in-repo encoder's bytes against the REAL peerjs-js-binarypack `pack`, the
// packer a partner running the library alone decodes with. The encoder exists
// only because that packer recurses once per element, so the comparison runs at
// every size the library itself survives, and the sizes past its ceiling are
// held by the round-trip suite beside this one.
//
// `peerjs-js-binarypack` is an exact-pinned devDependency of THIS package
// (packages/core/package.json), so a bump that moves the encoding fails here
// rather than at a partner's browser (docs/spec/DEPENDENCY_PINS.md).

/** The real packer's bytes for `value`. `pack` returns a promise only for a
 * `Blob`, which no frame here is, so the synchronous branch is the only
 * reachable one -- asserted rather than assumed, since an awaited-by-accident
 * promise would compare `[object Promise]` against real bytes. */
function oracleBytes(value: unknown): Uint8Array {
  const packed = pack(value as Packable);
  if (packed instanceof Promise) {
    throw new Error("BinaryPack packed a probe value asynchronously");
  }
  return new Uint8Array(packed);
}

/** The real packer's bytes, or `undefined` where its own recursion ceiling
 * stops it. That ceiling moves with whatever stack is already in use, so a Node
 * or vitest change can push it below a size chosen under it; the size that
 * reaches it has no oracle any more, which is a fact about the library rather
 * than a divergence in the encoder. */
function oracleBytesWithinPackerCeiling(
  value: unknown,
): Uint8Array | undefined {
  try {
    return oracleBytes(value);
  } catch (error) {
    if (error instanceof RangeError) return undefined;
    throw error;
  }
}

function encodedBytes(value: unknown): Uint8Array {
  return new Uint8Array(encodeBinaryPackValue(value));
}

function expectSameBytesAs(
  oracle: Uint8Array,
  value: unknown,
  label: string,
): void {
  const encoded = encodedBytes(value);
  // Compared as hex rather than as arrays: a mismatch deep in a 5 MB frame
  // prints a readable diff instead of a wall of element indices.
  expect(
    `${label}: ${Buffer.from(encoded).toString("hex")}`,
    `${label} diverged from the pinned packer`,
  ).toBe(`${label}: ${Buffer.from(oracle).toString("hex")}`);
}

function expectSameBytes(value: unknown, label: string): void {
  expectSameBytesAs(oracleBytes(value), value, label);
}

/** The iteration map psilink sends after the PSI round: one entry per matched
 * record (packages/core/src/psi/link.ts, `exchangeMappedElements`). */
function iterationMap(
  n: number,
): Array<{ theirIndex: number; iteration: number }> {
  return Array.from({ length: n }, (_, index) => ({
    theirIndex: index,
    iteration: index % 3,
  }));
}

/** The association table, two parallel index arrays
 * (packages/core/src/psi/participant.ts). */
function associationTable(n: number): [Array<number>, Array<number>] {
  return [
    Array.from({ length: n }, (_, index) => index),
    Array.from({ length: n }, (_, index) => (index * 7) % (n || 1)),
  ];
}

/** The local half of the association table, sent on its own
 * (packages/core/src/psi/participant.ts). */
function localIndices(n: number): Array<number> {
  return Array.from({ length: n }, (_, index) => index * 2);
}

/** The payload frame, one row of disclosed columns per matched record
 * (packages/core/src/payloadExchange.ts, `preparePayload`). */
function payloadFrame(n: number): {
  hasData: boolean;
  columns: Array<string>;
  rowIndices: Array<number>;
  rows: Array<Array<string | null>>;
} {
  return {
    hasData: true,
    columns: ["zip", "sex", "birth_date"],
    rowIndices: Array.from({ length: n }, (_, index) => index),
    rows: Array.from({ length: n }, (_, index) => [
      String(20001 + (index % 900)),
      index % 2 === 0 ? "M" : "F",
      index % 5 === 0
        ? null
        : `1970-01-${String((index % 28) + 1).padStart(2, "0")}`,
    ]),
  };
}

const RECORD_SCALING_FRAMES = [
  { name: "iteration map", build: iterationMap },
  { name: "association table", build: associationTable },
  { name: "payload frame", build: payloadFrame },
  { name: "local indices", build: localIndices },
] as const;

/** Sizes the real packer survives, so it can serve as the oracle: the empty
 * frame, the single record, both sides of the 15/16 fixed-header boundary, and
 * two sizes under the packer's own recursion ceiling, measured at roughly 7,800
 * records for the iteration map and higher for the other three. The top size
 * keeps well clear of it because the ceiling moves with the stack already in
 * use; a size above `SKIPPABLE_SIZE_FLOOR` that reaches it anyway skips below
 * rather than failing. */
const ORACLE_SIZES = [0, 1, 15, 16, 200, 5000];

/** The size above which a missing oracle is a fact about the library rather
 * than a loss of coverage. A ceiling that fell to this size or below has taken
 * byte equality down to frames of a few records, which is the regression this
 * suite exists to catch, so the case fails instead of skipping. */
const SKIPPABLE_SIZE_FLOOR = 200;

describe("encodeBinaryPackValue: the record-scaling frames, byte for byte", () => {
  for (const { name, build } of RECORD_SCALING_FRAMES) {
    for (const size of ORACLE_SIZES) {
      test(`${name} at ${size} records`, (context) => {
        const frame = build(size);
        const oracle = oracleBytesWithinPackerCeiling(frame);
        if (oracle === undefined) {
          const noOracle =
            `the pinned packer overflows its own call stack at ${size} ` +
            `${name} records, so it cannot serve as the oracle for this size`;
          if (size <= SKIPPABLE_SIZE_FLOOR) {
            throw new Error(
              `${noOracle}; its ceiling has fallen to ${SKIPPABLE_SIZE_FLOOR} ` +
                "records or below, which leaves the byte-for-byte comparison " +
                "measuring nothing but tiny frames",
            );
          }
          context.skip(
            `${noOracle}; lower the top oracle size rather than reading this ` +
              "as an encoder regression",
          );
          return;
        }
        expectSameBytesAs(oracle, frame, `${name}@${size}`);
      });
    }
  }
});

/** Every value kind the packer has a marker for, at each boundary where it
 * switches marker: the encoder's whole dispatch surface, so a branch that picks
 * a different width than the library fails here rather than on a partner's
 * frame. */
const MARKER_PROBES: Array<{ label: string; value: unknown }> = [
  { label: "null", value: null },
  { label: "undefined", value: undefined },
  { label: "true", value: true },
  { label: "false", value: false },
  { label: "zero", value: 0 },
  { label: "negative zero", value: -0 },
  { label: "positive fixint ceiling", value: 0x7f },
  { label: "negative fixint floor", value: -0x20 },
  { label: "uint8 floor", value: 0x80 },
  { label: "uint8 ceiling", value: 0xff },
  { label: "int8 floor", value: -0x80 },
  { label: "int8 just below the fixint floor", value: -0x21 },
  { label: "uint16 floor", value: 0x100 },
  { label: "uint16 ceiling", value: 0xffff },
  { label: "int16 floor", value: -0x8000 },
  { label: "int16 just below the int8 floor", value: -0x81 },
  { label: "uint32 floor", value: 0x10000 },
  { label: "uint32 ceiling", value: 0xffffffff },
  { label: "int32 floor", value: -0x80000000 },
  { label: "int32 just below the int16 floor", value: -0x8001 },
  { label: "int64 floor of the safe range", value: -Number.MAX_SAFE_INTEGER },
  { label: "int64 just above the uint32 ceiling", value: 0x100000000 },
  {
    label: "int64 at the safe-integer ceiling",
    value: Number.MAX_SAFE_INTEGER,
  },
  { label: "double, positive", value: 1.5 },
  { label: "double, negative", value: -2.25 },
  { label: "double, small magnitude", value: 1e-7 },
  // The largest magnitude that still reaches the double branch: every double
  // above 2^53 has an integral value, so the packer sends it down the integer
  // ladder instead.
  { label: "double, large magnitude", value: 2 ** 52 - 0.5 },
  { label: "empty string", value: "" },
  { label: "fixstr ceiling", value: "x".repeat(15) },
  { label: "str16 floor", value: "x".repeat(16) },
  { label: "str16 ceiling", value: "x".repeat(0xffff) },
  { label: "str32 floor", value: "x".repeat(0x10000) },
  { label: "multi-byte string", value: "näme 中文 \u{1f600}" },
  { label: "empty byte array", value: new Uint8Array(0) },
  { label: "fixraw ceiling", value: new Uint8Array(15).fill(7) },
  { label: "raw16 floor", value: new Uint8Array(16).fill(7) },
  { label: "raw16 ceiling", value: new Uint8Array(0xffff).fill(7) },
  { label: "raw32 floor", value: new Uint8Array(0x10000).fill(7) },
  { label: "ArrayBuffer", value: new Uint8Array([1, 2, 3]).buffer },
  {
    label: "byte view at a non-zero offset",
    value: new Uint8Array([1, 2, 3, 4, 5]).subarray(1, 4),
  },
  { label: "empty array", value: [] },
  { label: "fixarray ceiling", value: Array.from({ length: 15 }, (_, i) => i) },
  { label: "array16 floor", value: Array.from({ length: 16 }, (_, i) => i) },
  { label: "empty object", value: {} },
  {
    label: "fixmap ceiling",
    value: Object.fromEntries(
      Array.from({ length: 15 }, (_, i) => [`k${i}`, i]),
    ),
  },
  {
    label: "map16 floor",
    value: Object.fromEntries(
      Array.from({ length: 16 }, (_, i) => [`k${i}`, i]),
    ),
  },
  {
    label: "the chunk envelope the PeerJS chunker builds",
    value: {
      __peerData: 1,
      n: 0,
      data: new Uint8Array(16_300).fill(3).buffer,
      total: 2,
    },
  },
  { label: "the close sentinel", value: { __peerData: { type: "close" } } },
  {
    label: "a kex handshake message",
    value: { kexMsg: "1", e: "BASE64", reqEnc: false },
  },
  {
    label: "a protocol-setup decision",
    value: { decision: "abort", abortReasons: ["count mismatch"] },
  },
  {
    label: "an AEAD envelope",
    value: new Uint8Array(1 + 12 + 4096 + 16).fill(9),
  },
  {
    // Not a cycle: the encoder's cycle guard tracks the containers on the walk
    // from the root down, so a value reached twice on separate branches is
    // written twice, as the library writes it.
    label: "a value reached twice on separate branches",
    value: (() => {
      const shared = { theirIndex: 0, iteration: 1 };
      return [shared, [shared]];
    })(),
  },
  {
    label: "mixed nesting",
    value: {
      a: [1, "two", null, [3.5, { b: new Uint8Array([9]) }]],
      c: { d: [] as Array<unknown>, e: {} },
    },
  },
];

describe("encodeBinaryPackValue: every marker, at its boundaries", () => {
  for (const { label, value } of MARKER_PROBES) {
    test(label, () => {
      expectSameBytes(value, label);
    });
    test(`${label}, nested in a frame`, () => {
      expectSameBytes(
        { head: 1, value, tail: "marker-tail" },
        `nested ${label}`,
      );
    });
  }
});

describe("encodeBinaryPackValue: nesting the library survives", () => {
  test("arrays nested to the inbound depth cap", () => {
    let value: unknown = 1;
    for (let depth = 0; depth < 256; depth += 1) value = [value];
    expectSameBytes(value, "256 nested arrays");
  });

  test("objects nested to the inbound depth cap", () => {
    let value: unknown = 1;
    for (let depth = 0; depth < 256; depth += 1) value = { inner: value };
    expectSameBytes(value, "256 nested objects");
  });
});
