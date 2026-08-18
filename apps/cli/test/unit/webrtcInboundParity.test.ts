import { describe, expect, test } from "vitest";

import {
  ConnectionError,
  MAX_WEBRTC_FRAME_STRUCTURE_BYTES,
  MAX_WEBRTC_REASSEMBLY_DEPTH,
  MAX_WEBRTC_STRING_BYTES,
  describeFrameStructureRefusal,
  scanFrameStructure,
} from "@psilink/core";

import { BoundedInboundFrames } from "../../src/connection/webrtc/inboundBounds";
import {
  chunkPacked,
  packValue,
  unpackFrame,
} from "../../src/connection/webrtc/peerjsWire";

import type { FrameStructureRefusal } from "@psilink/core";
import type { InboundBoundOptions } from "../../src/connection/webrtc/inboundBounds";

// The WebRTC inbound bound has two enforcement points over one wire format: core's
// structural pre-scan (packages/core/src/connection/binaryPackBounds.ts), which
// decides what a frame costs and which rule refuses it, and this transport's
// reassembler, which owns its own chunk handling and calls that scan at two
// chokepoints of its own. Nothing about their living in one repository makes them
// agree, so one labelled fixture set is driven through BOTH below and every
// divergence fails: a frame the scan refuses that the reassembler delivers, a frame
// the scan admits that the reassembler refuses, a refusal the two attribute to
// different rules, and a rule that fires on a whole frame but not on the same frame
// arriving in chunks.
//
// The set lives here rather than behind `@psilink/core/testing` because the parity
// assertion can only live here -- core cannot import an app -- and test material
// stays in its own test tree until a second workspace genuinely needs it
// (docs/TESTING.md, Shared test material). The scan it is driven against is
// therefore the one this app links from core's BUILD, not a source copy.
//
// Every frame is the real packer's output. The two shapes that packer never emits --
// a container declaring more elements than the bytes behind it, and a map key that is
// not a string -- are assembled around real-packed parts, the same concession core's
// differential suite makes for the markers the packer cannot reach.

/** The three limits `scanFrameStructure` measures a frame against. A fixture carries
 * its own, and both halves are driven with those same three numbers, so a divergence
 * can only be the enforcement and never the setup. */
interface FrameScanLimits {
  readonly maxStructureBytes: number;
  readonly maxDepth: number;
  readonly maxStringBytes: number;
}

/** One labelled frame: the wire bytes, the limits they are measured under, and the
 * pre-scan rule they must draw -- `undefined` where the frame is admitted and must
 * reach the application whole. */
interface FrameFixture {
  readonly label: string;
  readonly frame: Uint8Array;
  readonly limits: FrameScanLimits;
  readonly refusedBy: FrameStructureRefusal["rule"] | undefined;
}

/** The production limits, so a fixture reduces only the limit its own rule tests and
 * stays inside the real envelope on the other two. */
const PRODUCTION_LIMITS: FrameScanLimits = {
  maxStructureBytes: MAX_WEBRTC_FRAME_STRUCTURE_BYTES,
  maxDepth: MAX_WEBRTC_REASSEMBLY_DEPTH,
  maxStringBytes: MAX_WEBRTC_STRING_BYTES,
};

/** The reduced structure budget the retained-byte pair is measured against. It has to
 * sit above what a chunk envelope itself costs, or the reassembly leg below would
 * refuse an envelope instead of the frame it carries and pass while testing nothing;
 * the pending-until-the-last-datagram test holds that, failing on any envelope the
 * scan refuses. */
const REDUCED_STRUCTURE_BYTES = 4096;

/** The reduced nesting cap the depth pair is measured against. */
const REDUCED_DEPTH = 4;

/** The reduced per-string cap the string pair is measured against. */
const REDUCED_STRING_BYTES = 1024;

/** `n` mapped-element records -- `Array<{theirIndex, iteration}>`, the largest
 * legitimate frame the structural budget is sized against. */
function mappedElementRecords(
  n: number,
): Array<{ theirIndex: number; iteration: number }> {
  return Array.from({ length: n }, (_, i) => ({
    theirIndex: i,
    iteration: i % 3,
  }));
}

/** A single value wrapped in `levels` arrays. */
function nestedArrays(levels: number): unknown {
  let value: unknown = 1;
  for (let d = 0; d < levels; d += 1) value = [value];
  return value;
}

/** A BinaryPack `array32` header declaring `count` elements and nothing else: the
 * lying container header the real packer never emits, since it packs the elements it
 * declares. */
function array32Header(count: number): Uint8Array {
  return new Uint8Array([
    0xdd,
    (count >>> 24) & 0xff,
    (count >>> 16) & 0xff,
    (count >>> 8) & 0xff,
    count & 0xff,
  ]);
}

/** A BinaryPack `fixmap` header declaring one key/value pair, the wrapper the
 * non-string key is assembled under. */
const FIXMAP_ONE_PAIR = new Uint8Array([0x81]);

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

/** One refused frame per pre-scan rule, keyed by the rule it must draw rather than
 * listed, so a sixth rule added to `FrameStructureRefusal` fails this file's
 * typecheck until it has a fixture of its own. */
const refusedFrames: Record<
  FrameStructureRefusal["rule"],
  Omit<FrameFixture, "refusedBy">
> = {
  "structure-bytes": {
    label: "200 mapped-element records over the structure budget",
    frame: packValue(mappedElementRecords(200)),
    limits: {
      ...PRODUCTION_LIMITS,
      maxStructureBytes: REDUCED_STRUCTURE_BYTES,
    },
  },
  "nesting-depth": {
    label: "arrays nested past the depth cap",
    frame: packValue(nestedArrays(12)),
    limits: { ...PRODUCTION_LIMITS, maxDepth: REDUCED_DEPTH },
  },
  "string-bytes": {
    label: "a string over the per-string cap",
    frame: packValue("x".repeat(REDUCED_STRING_BYTES * 4)),
    limits: { ...PRODUCTION_LIMITS, maxStringBytes: REDUCED_STRING_BYTES },
  },
  "unbacked-elements": {
    label: "an array32 declaring a million elements over one packed value",
    frame: concatBytes([array32Header(1_000_000), packValue("psilink")]),
    limits: PRODUCTION_LIMITS,
  },
  "map-key": {
    label: "a fixmap keyed by a packed integer",
    frame: concatBytes([FIXMAP_ONE_PAIR, packValue(7), packValue("iteration")]),
    limits: PRODUCTION_LIMITS,
  },
};

/** A representative binary frame of `n` bytes, the shape the PSI engine and the AEAD
 * envelope both put on the wire. */
function binaryFrame(n: number): ArrayBuffer {
  return new Uint8Array(n).fill(7).buffer;
}

/** The admitted half. Each refused fixture's near neighbour comes first, under the
 * SAME reduced limits, so a side that refuses too much fails as loudly as one that
 * refuses too little; then in-protocol frames at the production limits, the shapes
 * the reassembler has to deliver for an exchange to complete. (Core's differential
 * suite holds the exhaustive enumeration of what psilink sends; these are the
 * representative shapes, driven here through the reassembler rather than the scan
 * alone.) */
const admittedValues: Array<{
  label: string;
  value: unknown;
  limits: FrameScanLimits;
}> = [
  {
    label: "20 mapped-element records under the same structure budget",
    value: mappedElementRecords(20),
    limits: {
      ...PRODUCTION_LIMITS,
      maxStructureBytes: REDUCED_STRUCTURE_BYTES,
    },
  },
  {
    label: "arrays nested to the same depth cap",
    value: nestedArrays(REDUCED_DEPTH - 1),
    limits: { ...PRODUCTION_LIMITS, maxDepth: REDUCED_DEPTH },
  },
  {
    label: "a string exactly at the same per-string cap",
    value: "x".repeat(REDUCED_STRING_BYTES),
    limits: { ...PRODUCTION_LIMITS, maxStringBytes: REDUCED_STRING_BYTES },
  },
  {
    label: "an array whose declared elements are all on the wire",
    value: Array.from({ length: 1000 }, (_, i) => i),
    limits: PRODUCTION_LIMITS,
  },
  {
    label: "a map the packer keyed with strings",
    value: { theirIndex: 3, iteration: 1 },
    limits: PRODUCTION_LIMITS,
  },
  {
    label: "a kex handshake message",
    value: { kexMsg: "1", e: "BASE64", reqEnc: false },
    limits: PRODUCTION_LIMITS,
  },
  {
    label: "a protocol-setup decision",
    value: { decision: "abort", abortReasons: ["count mismatch"] },
    limits: PRODUCTION_LIMITS,
  },
  {
    label: "a PSI engine frame",
    value: binaryFrame(4096),
    limits: PRODUCTION_LIMITS,
  },
  {
    label: "an association table",
    value: [
      [0, 4, 9],
      [1, 2, 3],
    ],
    limits: PRODUCTION_LIMITS,
  },
  {
    label: "a mapped-element frame",
    value: mappedElementRecords(64),
    limits: PRODUCTION_LIMITS,
  },
  {
    label: "a payload message",
    value: {
      hasData: true,
      columns: ["zip", "sex"],
      rowIndices: [0, 1],
      rows: [
        ["20001", "M"],
        ["20002", null],
      ],
    },
    limits: PRODUCTION_LIMITS,
  },
  {
    label: "an AEAD envelope",
    value: binaryFrame(1 + 12 + 4096 + 16),
    limits: PRODUCTION_LIMITS,
  },
];

/** The labelled set both halves are driven against: the refused frames, one per
 * pre-scan rule, then the admitted ones. */
const fixtures: Array<FrameFixture> = [
  ...Object.entries(refusedFrames).map(([rule, fixture]) => ({
    ...fixture,
    refusedBy: rule as FrameStructureRefusal["rule"],
  })),
  ...admittedValues.map(({ label, value, limits }) => ({
    label,
    frame: packValue(value),
    limits,
    refusedBy: undefined,
  })),
];

/** The reassembler's overrides for a fixture's limits. */
function boundsFor(fixture: FrameFixture): InboundBoundOptions {
  return {
    maxStructureBytes: fixture.limits.maxStructureBytes,
    maxReassemblyDepth: fixture.limits.maxDepth,
    maxStringBytes: fixture.limits.maxStringBytes,
  };
}

/** The pre-scan's verdict on a fixture's bytes, unmediated by any transport. */
function scanRefusal(fixture: FrameFixture): FrameStructureRefusal | undefined {
  return scanFrameStructure(
    fixture.frame,
    fixture.limits.maxStructureBytes,
    fixture.limits.maxDepth,
    fixture.limits.maxStringBytes,
  );
}

/** What one side made of a fixture: the refusal it raised, the value it delivered,
 * or an inbound path still waiting for more datagrams. */
type Verdict =
  | { kind: "refused"; errorKind: string; message: string }
  | { kind: "delivered"; value: unknown }
  | { kind: "pending" };

/** Core's verdict: the pre-scan's refusal rendered as a transport must render it, or
 * the value the real unpacker yields for a frame the scan admits. */
function coreVerdict(fixture: FrameFixture): Verdict {
  const refusal = scanRefusal(fixture);
  if (refusal !== undefined) {
    return {
      kind: "refused",
      errorKind: "protocol",
      message: `inbound WebRTC frame ${describeFrameStructureRefusal(refusal)}`,
    };
  }
  return { kind: "delivered", value: unpackFrame(fixture.frame) };
}

/** The reassembler's verdict on a fixture delivered as `datagrams`, in order. */
function reassemblerVerdict(
  fixture: FrameFixture,
  datagrams: Array<Uint8Array>,
): Verdict {
  const bounds = new BoundedInboundFrames(boundsFor(fixture));
  try {
    let outcome = { kind: "pending" } as ReturnType<
      BoundedInboundFrames["accept"]
    >;
    for (const datagram of datagrams) outcome = bounds.accept(datagram);
    return outcome.kind === "frame"
      ? { kind: "delivered", value: outcome.value }
      : { kind: "pending" };
  } catch (err) {
    if (!(err instanceof ConnectionError)) throw err;
    return { kind: "refused", errorKind: err.kind, message: err.message };
  }
}

/** A fixture split into the chunk envelopes a PeerJS sender would emit for it: three
 * of them whatever the frame's size, so the reassembly path always sees a partial
 * before it sees the whole. */
function chunkedDatagrams(fixture: FrameFixture): Array<Uint8Array> {
  const datagrams = chunkPacked(
    fixture.frame,
    1,
    Math.ceil(fixture.frame.byteLength / 3),
  );
  expect(datagrams.length, `${fixture.label} did not chunk`).toBeGreaterThan(1);
  return datagrams;
}

describe("the WebRTC inbound frame fixtures", () => {
  test("draw the pre-scan rule each one is labelled with", () => {
    for (const fixture of fixtures) {
      expect(scanRefusal(fixture)?.rule, fixture.label).toBe(fixture.refusedBy);
    }
  });

  test("label both halves, under labels that identify one frame each", () => {
    // A refused-only set would pin nothing about what still gets through, and an
    // admitted-only set nothing about what is stopped; a repeated label would let one
    // fixture stand in for another in a failure message.
    expect(fixtures.some(({ refusedBy }) => refusedBy !== undefined)).toBe(
      true,
    );
    expect(fixtures.some(({ refusedBy }) => refusedBy === undefined)).toBe(
      true,
    );
    expect(new Set(fixtures.map(({ label }) => label)).size).toBe(
      fixtures.length,
    );
  });
});

describe("the CLI reassembler against core's pre-scan", () => {
  test("refuses exactly what the pre-scan refuses, naming the same rule", () => {
    for (const fixture of fixtures) {
      expect(
        reassemblerVerdict(fixture, [fixture.frame]),
        fixture.label,
      ).toEqual(coreVerdict(fixture));
    }
  });

  test("reaches the same verdict on a frame delivered in chunks", () => {
    // The reassembler scans a datagram on arrival and the frame its chunks assemble
    // into again, so a rule that fires on a whole frame must fire on the assembled
    // bytes too -- otherwise chunking is a way past the bound.
    for (const fixture of fixtures) {
      expect(
        reassemblerVerdict(fixture, chunkedDatagrams(fixture)),
        fixture.label,
      ).toEqual(coreVerdict(fixture));
    }
  });

  test("holds a chunked frame pending until its last datagram", () => {
    // The verdicts above are read off the last datagram, which says nothing about the
    // ones before it: a reassembler that decided early would pass those tests while
    // delivering (or refusing) a frame it had not seen whole.
    for (const fixture of fixtures) {
      const bounds = new BoundedInboundFrames(boundsFor(fixture));
      for (const datagram of chunkedDatagrams(fixture).slice(0, -1)) {
        expect(bounds.accept(datagram), fixture.label).toEqual({
          kind: "pending",
        });
      }
    }
  });
});
