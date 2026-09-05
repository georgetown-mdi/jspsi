import { describe, expect, test } from "vitest";

import {
  WEBRTC_INBOUND_FRAME_FIXTURES,
  comparableVerdict,
  packValue,
  preScanVerdict,
  unpackFrame,
} from "@psilink/testkit/webrtcInboundFrames";

import { boundChunkReassembly } from "../../src/psi/boundedReassembly.js";

import type {
  FrameVerdict,
  WebrtcFrameFixture,
} from "@psilink/testkit/webrtcInboundFrames";
import type { ConnectionError } from "@psilink/core";
import type { DataConnection } from "peerjs";

// Core's structural pre-scan (packages/core/src/connection/binaryPackBounds.ts) and
// this app's PeerJS wrap (src/psi/boundedReassembly.ts) enforce the same bound; the
// wrap calls the scan at the unpack chokepoint for every datagram and reassembled
// frame. The fixture set (`@psilink/testkit/webrtcInboundFrames`), also driven
// by the CLI's own parity suite, drives both here, and every divergence fails --
// including a rule that fires on a whole frame but not the same frame in chunks.

/** PeerJS's chunk message ids start at 1: the receive dispatch keys off `__peerData`
 * being TRUTHY, so a chunk numbered 0 would be read as a plain application frame. */
const CHUNK_MESSAGE_ID = 1;

/** One chunk envelope as it arrives from `unpack`: the message id shared by every
 * chunk of one frame, the chunk index, the chunk count, and the slice. BinaryPack
 * decodes a `bin` field to an `ArrayBuffer` under Node's resolution of the packer and
 * to a `Uint8Array` under the browser build this app links, so the slice is taken as
 * either. */
interface ChunkEnvelope {
  __peerData: number;
  n: number;
  total: number;
  data: ArrayBuffer | Uint8Array;
}

function isChunkEnvelope(value: unknown): value is ChunkEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    Boolean((value as { __peerData?: unknown }).__peerData)
  );
}

function sliceBytes(data: ChunkEnvelope["data"]): Uint8Array {
  return data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function concatSlices(slices: Array<Uint8Array>): Uint8Array {
  let len = 0;
  for (const slice of slices) len += slice.length;
  const out = new Uint8Array(len);
  let offset = 0;
  for (const slice of slices) {
    out.set(slice, offset);
    offset += slice.length;
  }
  return out;
}

/**
 * A test double for the PeerJS binary connection's receive path, mirroring real
 * PeerJS: `_handleDataMessage` is the sole entry, routing a truthy `__peerData` to
 * `_handleChunk`, which reassembles and recurses back through `this._handleDataMessage`
 * -- so a reassembled frame re-enters the wrap's replacement of that method. That
 * puts the structural scan on both the chunk envelope and the assembled frame,
 * matching the CLI reassembler's two chokepoints.
 */
class FakePeerJsConnection {
  _chunkedData: Record<
    number,
    { data: Array<Uint8Array>; count: number; total: number } | undefined
  > = {};
  /** Each unpacked frame that reached the application. */
  delivered: Array<unknown> = [];

  _handleDataMessage = (message: { data: Uint8Array }): void => {
    const value = unpackFrame(message.data);
    if (isChunkEnvelope(value)) this._handleChunk(value);
    else this.delivered.push(value);
  };

  _handleChunk = (chunk: ChunkEnvelope): void => {
    const id = chunk.__peerData;
    const info = this._chunkedData[id] ?? {
      data: [],
      count: 0,
      total: chunk.total,
    };
    info.data[chunk.n] = sliceBytes(chunk.data);
    info.count++;
    this._chunkedData[id] = info;
    if (info.count === info.total) {
      delete this._chunkedData[id];
      this._handleDataMessage({ data: concatSlices(info.data) });
    }
  };
}

/** A connection with the wrap installed at a fixture's three structural limits, every
 * other bound left at its production default exactly as the CLI leg leaves them.
 * `failures` collects what the wrap latched, which is how it reports a refusal (it
 * calls `fail` rather than throwing). */
function guardedConnection(fixture: WebrtcFrameFixture): {
  conn: FakePeerJsConnection;
  failures: Array<ConnectionError>;
} {
  const conn = new FakePeerJsConnection();
  const failures: Array<ConnectionError> = [];
  boundChunkReassembly(
    conn as unknown as DataConnection,
    (error) => failures.push(error),
    {
      maxStructureBytes: fixture.limits.maxStructureBytes,
      maxReassemblyDepth: fixture.limits.maxDepth,
      maxStringBytes: fixture.limits.maxStringBytes,
    },
  );
  return { conn, failures };
}

/** The wrap's verdict on a fixture delivered as `datagrams`, in order. */
function wrapVerdict(
  fixture: WebrtcFrameFixture,
  datagrams: Array<Uint8Array>,
): FrameVerdict {
  const { conn, failures } = guardedConnection(fixture);
  for (const datagram of datagrams) conn._handleDataMessage({ data: datagram });

  expect(
    failures.length,
    `${fixture.label} failed the connection more than once`,
  ).toBeLessThanOrEqual(1);
  expect(
    conn.delivered.length,
    `${fixture.label} delivered more than one frame`,
  ).toBeLessThanOrEqual(1);

  if (failures.length > 0) {
    // Fail-closed, not fail-and-deliver: the refused frame must never have reached
    // the application, which a verdict read off the refusal alone would not show.
    expect(
      conn.delivered,
      `${fixture.label} delivered a frame it also refused`,
    ).toEqual([]);
    const [failure] = failures;
    return {
      kind: "refused",
      errorKind: failure.kind,
      message: failure.message,
    };
  }
  return conn.delivered.length === 1
    ? { kind: "delivered", value: conn.delivered[0] }
    : { kind: "pending" };
}

/** A fixture split into the chunk envelopes a PeerJS sender puts on the wire -- three
 * of them whatever the frame's size, so the reassembly path always sees a partial
 * before it sees the whole. The envelope's four keys and their order are PeerJS's
 * chunker's, the same shape the CLI's wire encoder emits. */
function chunkedDatagrams(fixture: WebrtcFrameFixture): Array<Uint8Array> {
  const frame = fixture.frame;
  const mtu = Math.ceil(frame.byteLength / 3);
  const total = Math.ceil(frame.byteLength / mtu);
  const datagrams: Array<Uint8Array> = [];
  for (let start = 0; start < frame.byteLength; start += mtu) {
    datagrams.push(
      packValue({
        __peerData: CHUNK_MESSAGE_ID,
        n: datagrams.length,
        data: frame.subarray(start, Math.min(frame.byteLength, start + mtu)),
        total,
      }),
    );
  }
  expect(datagrams.length, `${fixture.label} did not chunk`).toBeGreaterThan(1);
  return datagrams;
}

describe("the web PeerJS wrap against core's pre-scan", () => {
  test("refuses exactly what the pre-scan refuses, naming the same rule", () => {
    const observed = new Set<FrameVerdict["kind"]>();
    for (const fixture of WEBRTC_INBOUND_FRAME_FIXTURES) {
      const verdict = wrapVerdict(fixture, [fixture.frame]);
      observed.add(verdict.kind);
      expect(comparableVerdict(verdict), fixture.label).toEqual(
        comparableVerdict(preScanVerdict(fixture)),
      );
    }
    // The vacuity guard for this leg: a fixture set that had stopped holding one of
    // its halves -- or a wrap that refused or delivered everything -- would satisfy
    // every assertion above while pinning only one side of the bound.
    expect(observed).toEqual(new Set(["refused", "delivered"]));
  });

  test("reaches the same verdict on a frame delivered in chunks", () => {
    // The wrap scans each chunk envelope as it arrives and the frame the chunks
    // assemble into again, so a rule that fires on a whole frame must fire on the
    // assembled bytes too -- otherwise chunking is a way past the bound.
    const observed = new Set<FrameVerdict["kind"]>();
    for (const fixture of WEBRTC_INBOUND_FRAME_FIXTURES) {
      const verdict = wrapVerdict(fixture, chunkedDatagrams(fixture));
      observed.add(verdict.kind);
      expect(comparableVerdict(verdict), fixture.label).toEqual(
        comparableVerdict(preScanVerdict(fixture)),
      );
    }
    expect(observed).toEqual(new Set(["refused", "delivered"]));
  });

  test("holds a chunked frame pending until its last datagram", () => {
    // The verdicts above are read off the last datagram, which says nothing about the
    // ones before it: a wrap that decided early would pass those tests while
    // delivering (or refusing) a frame it had not seen whole. It also holds the
    // fixture limits above what a chunk envelope itself costs -- a leg that refused
    // an envelope instead of the frame it holds would pass while testing nothing.
    for (const fixture of WEBRTC_INBOUND_FRAME_FIXTURES) {
      const { conn, failures } = guardedConnection(fixture);
      for (const datagram of chunkedDatagrams(fixture).slice(0, -1)) {
        conn._handleDataMessage({ data: datagram });
      }
      expect(failures, fixture.label).toEqual([]);
      expect(conn.delivered, fixture.label).toEqual([]);
    }
  });
});
