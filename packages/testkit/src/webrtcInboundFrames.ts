// The labelled WebRTC inbound frames both transports are held to, and the pre-scan
// verdict each one must draw.
//
// One wire format has three enforcement points. Core's structural pre-scan
// (packages/core/src/connection/binaryPackBounds.ts) decides what a frame costs and
// which rule refuses it; the CLI's reassembler and the web app's PeerJS wrap each own
// their own chunk handling and call that scan at two chokepoints of their own.
// Nothing about the three living in one repository makes them agree, so this set is
// driven through every one of them, and each transport's verdict is compared against
// {@link preScanVerdict} -- and so, transitively, against the other transport's. What
// fails: a frame the scan refuses that a transport delivers, a frame the scan admits
// that a transport refuses, a refusal the two attribute to different rules or word
// differently, and a rule that fires on a whole frame but not on the same frame
// arriving in chunks.
//
// The set lives here rather than in either test tree because both apps need it and
// neither may import the other, and rather than behind `@psilink/core/testing`
// because it is built with the real `peerjs-js-binarypack` packer, which
// `packages/core` does not declare in its `dependencies` -- putting it there would
// inline a copy of the wire codec into core's published `dist/testing.*`
// (docs/TESTING.md, Shared test material). What each transport contributes is the
// half that cannot move: the assertion that drives its own reassembler.
//
// Every frame is the real packer's output. The two shapes that packer never emits --
// a container declaring more elements than the bytes behind it, and a map key that is
// not a string -- are assembled around real-packed parts, the same concession core's
// differential suite makes for the markers the packer cannot reach.

import { pack, unpack } from "peerjs-js-binarypack";

import {
  MAX_WEBRTC_FRAME_STRUCTURE_BYTES,
  MAX_WEBRTC_REASSEMBLY_DEPTH,
  MAX_WEBRTC_STRING_BYTES,
  describeFrameStructureRefusal,
  scanFrameStructure,
} from "@psilink/core";

import type { FrameStructureRefusal } from "@psilink/core";
import type { Unpackable } from "peerjs-js-binarypack";

/** The three limits `scanFrameStructure` measures a frame against. A fixture has
 * its own, and every side is driven with those same three numbers, so a divergence
 * can only be the enforcement and never the setup. */
export interface FrameScanLimits {
  readonly maxStructureBytes: number;
  readonly maxDepth: number;
  readonly maxStringBytes: number;
}

/** One labelled frame: the wire bytes, the limits they are measured under, and the
 * pre-scan rule they must draw -- `undefined` where the frame is admitted and must
 * reach the application whole. */
export interface WebrtcFrameFixture {
  readonly label: string;
  readonly frame: Uint8Array;
  readonly limits: FrameScanLimits;
  readonly refusedBy: FrameStructureRefusal["rule"] | undefined;
}

/** What one side made of a fixture: the refusal it raised, the value it delivered,
 * or an inbound path still waiting for more datagrams. */
export type FrameVerdict =
  | { kind: "refused"; errorKind: string; message: string }
  | { kind: "delivered"; value: unknown }
  | { kind: "pending" };

/** The production limits, so a fixture reduces only the limit its own rule tests and
 * stays inside the real envelope on the other two. */
const PRODUCTION_LIMITS: FrameScanLimits = {
  maxStructureBytes: MAX_WEBRTC_FRAME_STRUCTURE_BYTES,
  maxDepth: MAX_WEBRTC_REASSEMBLY_DEPTH,
  maxStringBytes: MAX_WEBRTC_STRING_BYTES,
};

/** The reduced structure budget the retained-byte pair is measured against. It has to
 * sit above what a chunk envelope itself costs, or a reassembly leg would refuse an
 * envelope instead of the frame it holds and pass while testing nothing; each
 * transport's pending-until-the-last-datagram test holds that, failing on any
 * envelope the scan refuses. */
const REDUCED_STRUCTURE_BYTES = 4096;

/** The reduced nesting cap the depth pair is measured against. */
const REDUCED_DEPTH = 4;

/** The reduced per-string cap the string pair is measured against. */
const REDUCED_STRING_BYTES = 1024;

/** BinaryPack-encode one value with the real packer. `pack` returns a promise only
 * for a `Blob` input, which no fixture is, so the synchronous branch is the only
 * reachable one -- asserted rather than assumed, since an awaited-by-accident promise
 * would put `[object Promise]` in a fixture's bytes. Exported for the chunk envelopes
 * a transport's leg wraps a fixture in, which are frames too. */
export function packValue(value: unknown): Uint8Array {
  // `pack` accepts far more than its `Packable` type admits (these frames are plain
  // objects of strings, numbers and byte arrays); the cast is the boundary between
  // the fixtures' `unknown` values and its declared input type.
  const packed = pack(value as Parameters<typeof pack>[0]);
  if (packed instanceof Promise) {
    throw new Error("BinaryPack packed a fixture asynchronously");
  }
  return new Uint8Array(packed);
}

/** BinaryPack-decode a frame with the real unpacker. Its published type declares an
 * `ArrayBuffer` while what a transport holds on the wire is a view over the datagram's
 * bytes; the real call reads that view (measured, along with the decode shape a view
 * argument produces -- see {@link comparableVerdict}), so this cast is the one place
 * bridging the declared type to the real call. */
export function unpackFrame(bytes: Uint8Array): unknown {
  return unpack<Unpackable>(bytes as unknown as ArrayBuffer);
}

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
 * typecheck -- in every workspace that consumes it -- until it has a fixture. */
const refusedFrames: Record<
  FrameStructureRefusal["rule"],
  Omit<WebrtcFrameFixture, "refusedBy">
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
 * refuses too little; then in-protocol frames at the production limits, the shapes a
 * reassembler has to deliver for an exchange to complete. (Core's differential suite
 * holds the exhaustive enumeration of what psilink sends; these are the
 * representative shapes, driven here through the transports rather than the scan
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

/** The labelled set every side is driven against: the refused frames, one per
 * pre-scan rule, then the admitted ones. */
export const WEBRTC_INBOUND_FRAME_FIXTURES: Array<WebrtcFrameFixture> = [
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

/** The pre-scan's verdict on a fixture's bytes, unmediated by any transport. */
export function frameScanRefusal(
  fixture: WebrtcFrameFixture,
): FrameStructureRefusal | undefined {
  return scanFrameStructure(
    fixture.frame,
    fixture.limits.maxStructureBytes,
    fixture.limits.maxDepth,
    fixture.limits.maxStringBytes,
  );
}

/** The reference verdict every transport is compared against: the pre-scan's refusal
 * rendered as a transport must render it, or the value the real unpacker yields for a
 * frame the scan admits. */
export function preScanVerdict(fixture: WebrtcFrameFixture): FrameVerdict {
  const refusal = frameScanRefusal(fixture);
  if (refusal !== undefined) {
    return {
      kind: "refused",
      errorKind: "protocol",
      message: `inbound WebRTC frame ${describeFrameStructureRefusal(refusal)}`,
    };
  }
  return { kind: "delivered", value: unpackFrame(fixture.frame) };
}

/** Rewrite every `ArrayBuffer`/typed array in a decoded value to a plain number
 * array, so a binary payload -- the PSI engine frame and the AEAD envelope are exactly
 * that shape -- is compared by its bytes however it was decoded. Two measurements make
 * this critical rather than decoration: a deep-equality assertion compares a typed
 * array's contents but treats two distinct `ArrayBuffer`s as equal whatever their
 * bytes, and the real unpacker's decode of a `bin` mirrors the type it was handed --
 * an `ArrayBuffer` argument decodes to an `ArrayBuffer`, a view to a view. A transport
 * that hands the unpacker the buffer rather than a view over it therefore delivers a
 * value a bare comparison cannot see into. */
export function normalizeBinary(value: unknown): unknown {
  if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) {
    return Array.from(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    );
  }
  if (Array.isArray(value)) return value.map(normalizeBinary);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = normalizeBinary(inner);
    }
    return out;
  }
  return value;
}

/** A verdict with its delivered value made byte-comparable ({@link normalizeBinary}).
 * Both sides of a parity assertion pass through this, never one. */
export function comparableVerdict(verdict: FrameVerdict): FrameVerdict {
  return verdict.kind === "delivered"
    ? { kind: "delivered", value: normalizeBinary(verdict.value) }
    : verdict;
}
