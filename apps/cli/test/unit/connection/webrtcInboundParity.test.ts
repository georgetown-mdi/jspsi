import { describe, expect, test } from "vitest";

import { ConnectionError } from "@psilink/core";
import {
  WEBRTC_INBOUND_FRAME_FIXTURES,
  comparableVerdict,
  frameScanRefusal,
  preScanVerdict,
} from "@psilink/testkit/webrtcInboundFrames";

import { BoundedInboundFrames } from "../../../src/connection/webrtc/inboundBounds";
import { chunkPacked } from "../../../src/connection/webrtc/peerjsWire";

import type {
  FrameVerdict,
  WebrtcFrameFixture,
} from "@psilink/testkit/webrtcInboundFrames";
import type { InboundBoundOptions } from "../../../src/connection/webrtc/inboundBounds";

// The WebRTC inbound bound has two enforcement points over one wire format: core's
// structural pre-scan (packages/core/src/connection/binaryPackBounds.ts), which
// decides what a frame costs and which rule refuses it, and this transport's
// reassembler, which owns its own chunk handling and calls that scan at two
// chokepoints of its own. Nothing about their living in one repository makes them
// agree, so the labelled fixture set is driven through BOTH below and every
// divergence fails: a frame the scan refuses that the reassembler delivers, a frame
// the scan admits that the reassembler refuses, a refusal the two attribute to
// different rules, and a rule that fires on a whole frame but not on the same frame
// arriving in chunks.
//
// The set itself is `@psilink/testkit/webrtcInboundFrames`, shared with the web app's
// PeerJS wrap, which is held to it the same way (apps/web/test/unit/
// webrtcInboundParity.test.ts) -- so the two transports' verdicts are compared against
// one reference and therefore against each other. What lives here is the half no
// shared package can hold: core cannot import an app, so the assertion driving THIS
// reassembler belongs in this app's test tree. The scan it is driven against is the
// one this app links from core's BUILD, not a source copy.

/** The reassembler's overrides for a fixture's limits. Only the three limits the
 * fixture set varies are set; every other bound stays at its production default, as
 * it does on the web leg. */
function boundsFor(fixture: WebrtcFrameFixture): InboundBoundOptions {
  return {
    maxStructureBytes: fixture.limits.maxStructureBytes,
    maxReassemblyDepth: fixture.limits.maxDepth,
    maxStringBytes: fixture.limits.maxStringBytes,
  };
}

/** The reassembler's verdict on a fixture delivered as `datagrams`, in order. */
function reassemblerVerdict(
  fixture: WebrtcFrameFixture,
  datagrams: Array<Uint8Array>,
): FrameVerdict {
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
function chunkedDatagrams(fixture: WebrtcFrameFixture): Array<Uint8Array> {
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
    for (const fixture of WEBRTC_INBOUND_FRAME_FIXTURES) {
      expect(frameScanRefusal(fixture)?.rule, fixture.label).toBe(
        fixture.refusedBy,
      );
    }
  });

  test("label both halves, under labels that identify one frame each", () => {
    // A refused-only set would pin nothing about what still gets through, and an
    // admitted-only set nothing about what is stopped; a repeated label would let one
    // fixture stand in for another in a failure message.
    expect(
      WEBRTC_INBOUND_FRAME_FIXTURES.some(
        ({ refusedBy }) => refusedBy !== undefined,
      ),
    ).toBe(true);
    expect(
      WEBRTC_INBOUND_FRAME_FIXTURES.some(
        ({ refusedBy }) => refusedBy === undefined,
      ),
    ).toBe(true);
    expect(
      new Set(WEBRTC_INBOUND_FRAME_FIXTURES.map(({ label }) => label)).size,
    ).toBe(WEBRTC_INBOUND_FRAME_FIXTURES.length);
  });
});

describe("the CLI reassembler against core's pre-scan", () => {
  test("refuses exactly what the pre-scan refuses, naming the same rule", () => {
    for (const fixture of WEBRTC_INBOUND_FRAME_FIXTURES) {
      expect(
        comparableVerdict(reassemblerVerdict(fixture, [fixture.frame])),
        fixture.label,
      ).toEqual(comparableVerdict(preScanVerdict(fixture)));
    }
  });

  test("reaches the same verdict on a frame delivered in chunks", () => {
    // The reassembler scans a datagram on arrival and the frame its chunks assemble
    // into again, so a rule that fires on a whole frame must fire on the assembled
    // bytes too -- otherwise chunking is a way past the bound.
    for (const fixture of WEBRTC_INBOUND_FRAME_FIXTURES) {
      expect(
        comparableVerdict(
          reassemblerVerdict(fixture, chunkedDatagrams(fixture)),
        ),
        fixture.label,
      ).toEqual(comparableVerdict(preScanVerdict(fixture)));
    }
  });

  test("holds a chunked frame pending until its last datagram", () => {
    // The verdicts above are read off the last datagram, which says nothing about the
    // ones before it: a reassembler that decided early would pass those tests while
    // delivering (or refusing) a frame it had not seen whole.
    for (const fixture of WEBRTC_INBOUND_FRAME_FIXTURES) {
      const bounds = new BoundedInboundFrames(boundsFor(fixture));
      for (const datagram of chunkedDatagrams(fixture).slice(0, -1)) {
        expect(bounds.accept(datagram), fixture.label).toEqual({
          kind: "pending",
        });
      }
    }
  });
});
