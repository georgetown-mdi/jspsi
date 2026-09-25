import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import {
  InProcessPsiEngine,
  MAX_WEBRTC_FRAME_BYTES,
  PSIParticipant,
  WebRtcFrameLimitError,
} from "@alcove/core";
import {
  binaryPackByteStringLength,
  webrtcFrameReceiveCharge,
} from "@alcove/core/testing";

import { BoundedInboundFrames } from "../../../src/connection/webrtc/inboundBounds";
import {
  PEERJS_CHUNK_MTU,
  PeerJsFrameEncoder,
} from "../../../src/connection/webrtc/peerjsWire";
import { webRtcMessageConnection } from "../../../src/connection/webrtc/webrtcMessageConnection";

import type { WebRtcPeerSession } from "../../../src/connection/webrtc/weriftPeer";
import type { RTCDataChannel } from "werift";

// The CLI's half of the sender-side WebRTC frame bound: its data channel states
// the bound its own receive path applies, a PSI round over it refuses a set
// frame past that bound before sending, and the charge the check weighs covers
// what this receive path charges for the frames its own chunker writes.

const psiLibrary = await PSI();

/** A data channel that records what is sent and delivers nothing. */
function recordingSession(): {
  session: WebRtcPeerSession;
  sent: Array<Uint8Array>;
} {
  const sent: Array<Uint8Array> = [];
  const channel = {
    readyState: "open",
    bufferedAmount: 0,
    send: (data: Buffer) => sent.push(new Uint8Array(data)),
    close: () => {},
  };
  return {
    sent,
    session: {
      channel: channel as unknown as RTCDataChannel,
      isConnected: () => false,
      outboundAcknowledged: () => true,
      outboundTransmitted: () => true,
      onDisconnected: () => {},
      close: () => Promise.resolve(),
    },
  };
}

/** Every frame `datagrams` reassemble to on a receive path bounded at `max`. */
function received(datagrams: Array<Uint8Array>, max: number): Array<unknown> {
  const bounds = new BoundedInboundFrames({ maxFrameBytes: max });
  const frames: Array<unknown> = [];
  for (const datagram of datagrams) {
    const outcome = bounds.accept(datagram);
    if (outcome.kind === "frame") frames.push(outcome.value);
  }
  return frames;
}

test("the data channel states the receive bound it applies", () => {
  expect(
    webRtcMessageConnection(
      recordingSession().session,
    ).outboundWebRtcFrameBound?.(),
  ).toBe(MAX_WEBRTC_FRAME_BYTES);
  expect(
    webRtcMessageConnection(recordingSession().session, {
      inboundBounds: { maxFrameBytes: 4096 },
    }).outboundWebRtcFrameBound?.(),
  ).toBe(4096);
});

test("the check's charge covers what this receive path charges for a chunked frame", () => {
  // A receive path bounded at exactly the charge admits the frame, so a frame
  // the sender admits is never one this receiver refuses.
  for (const payload of [
    PEERJS_CHUNK_MTU,
    PEERJS_CHUNK_MTU * 2 + 7,
    PEERJS_CHUNK_MTU * 3 - 5,
    PEERJS_CHUNK_MTU * 5 + 200,
  ]) {
    const packed = binaryPackByteStringLength(payload);
    const datagrams = new PeerJsFrameEncoder().encode(new Uint8Array(payload));
    expect(received(datagrams, webrtcFrameReceiveCharge(packed))).toHaveLength(
      1,
    );
  }
});

/**
 * The first frame a starter's round over the CLI data channel sends for a set
 * of `count` values, with the channel's receive bound at `bound`: the set it
 * sent, or the refusal it raised in its place.
 */
async function starterFirstFrame(
  count: number,
  bound: number,
): Promise<{ ended: unknown; sent: Array<Uint8Array> }> {
  const { session, sent } = recordingSession();
  const conn = webRtcMessageConnection(session, {
    inboundBounds: { maxFrameBytes: bound },
  });
  const starter = new PSIParticipant(
    "server",
    psiLibrary,
    { role: "starter", verbose: -1 },
    {
      setup: Number.POSITIVE_INFINITY,
      request: Number.POSITIVE_INFINITY,
      response: Number.POSITIVE_INFINITY,
    },
  );
  const round = starter
    .identifyIntersection(
      conn,
      Array.from({ length: count }, (_unused, i) => `value-${i}`),
    )
    .then(
      () => undefined,
      (err: unknown) => err,
    );
  // A round that sent its setup waits for the partner, which never answers.
  const settled = await Promise.race([
    round,
    new Promise((resolve) => setTimeout(() => resolve("waiting"), 500)),
  ]);
  await conn.close();
  starter.dispose();
  return { ended: settled, sent };
}

test("a set frame one over the bound is refused before sending, and one under and at it is sent", async () => {
  // Large enough that the setup crosses the chunk size, so the bound is the
  // chunked charge rather than the frame's own length.
  const count = 1000;
  const engine = new InProcessPsiEngine(
    psiLibrary,
    "starter",
    "server",
    "identifier-revealing",
  );
  const { setup } = await engine.createServerSetup(
    Array.from({ length: count }, (_unused, i) => `value-${i}`),
  );
  engine.dispose();
  const packed = binaryPackByteStringLength(setup.byteLength);
  expect(packed).toBeGreaterThan(PEERJS_CHUNK_MTU);
  const charge = webrtcFrameReceiveCharge(packed);

  for (const bound of [charge + 1, charge]) {
    const { ended, sent } = await starterFirstFrame(count, bound);
    expect(ended).toBe("waiting");
    // The partner's receive path, bounded the same, takes the whole setup.
    const [frame] = received(sent, bound);
    expect((frame as Uint8Array).byteLength).toBe(setup.byteLength);
  }

  const { ended, sent } = await starterFirstFrame(count, charge - 1);
  expect(ended).toBeInstanceOf(WebRtcFrameLimitError);
  expect((ended as Error).message).toMatch(/Split the input/);
  // What went on the wire in its place is the abort, not the set.
  expect(received(sent, charge - 1)).toEqual([
    { decision: "abort", abortReasons: [expect.any(String)] },
  ]);
});
