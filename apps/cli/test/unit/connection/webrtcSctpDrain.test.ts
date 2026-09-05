import { expect, test } from "vitest";

import {
  sctpOutboundAcknowledged,
  sctpOutboundTransmitted,
} from "../../../src/connection/webrtc/weriftPeer";

import type { RTCPeerConnection } from "werift";

/** A peer connection stand-in exposing only the SCTP association shape these read. */
function fakePeer(sctp: unknown): RTCPeerConnection {
  return { sctp } as unknown as RTCPeerConnection;
}

// --- queues present ----------------------------------------------------------

test("outbound and sent both empty is treated as acknowledged and transmitted", () => {
  const peer = fakePeer({ sctp: { outboundQueue: [], sentQueue: [] } });
  expect(sctpOutboundAcknowledged(peer)).toBe(true);
  expect(sctpOutboundTransmitted(peer)).toBe(true);
});

test("a chunk still queued for send is neither acknowledged nor transmitted", () => {
  const peer = fakePeer({ sctp: { outboundQueue: [{}], sentQueue: [] } });
  expect(sctpOutboundAcknowledged(peer)).toBe(false);
  expect(sctpOutboundTransmitted(peer)).toBe(false);
});

test("a chunk sent but not yet acknowledged is transmitted but not acknowledged", () => {
  const peer = fakePeer({ sctp: { outboundQueue: [], sentQueue: [{}] } });
  expect(sctpOutboundAcknowledged(peer)).toBe(false);
  expect(sctpOutboundTransmitted(peer)).toBe(true);
});

// --- queues unreadable: the stated fallback -----------------------------------
//
// `assertSctpDrainSupported` only confirms the queues are readable at channel
// open; past that point the fallback below is what a torn-down association's
// caller relies on, so it is pinned directly here rather than left as prose.

test("a missing sctp association is treated as fully acknowledged and transmitted", () => {
  const peer = fakePeer(undefined);
  expect(sctpOutboundAcknowledged(peer)).toBe(true);
  expect(sctpOutboundTransmitted(peer)).toBe(true);
});

test("a missing inner sctp association is treated as fully acknowledged and transmitted", () => {
  const peer = fakePeer({ sctp: undefined });
  expect(sctpOutboundAcknowledged(peer)).toBe(true);
  expect(sctpOutboundTransmitted(peer)).toBe(true);
});

test("a queue field reshaped away from an array is treated as fully acknowledged and transmitted", () => {
  const peer = fakePeer({
    sctp: { outboundQueue: "not an array", sentQueue: [] },
  });
  expect(sctpOutboundAcknowledged(peer)).toBe(true);
  expect(sctpOutboundTransmitted(peer)).toBe(true);
});
