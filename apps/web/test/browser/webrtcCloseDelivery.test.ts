/// <reference types="@vitest/browser-playwright/context" />

import { expect, inject, test } from "vitest";

import { generateSharedSecret } from "@psilink/core";

import {
  CLOSE_OUTCOME_WARNINGS,
  FINAL_FRAME_UNCONFIRMED_LINK_LOST_WARNING,
  FINAL_FRAME_UNCONFIRMED_WAIT_EXPIRED_WARNING,
} from "../../src/psi/exchangeLifecycle.js";
import { openPeerMessageConnection } from "../../src/psi/peerMessageConnection.js";

import { canReachServer } from "../utils/pspiFixtures.js";
import { connectRendezvousPair } from "../utils/rendezvousPair.js";

import type { MessageConnection } from "@psilink/core";
import type { PeerCloseOutcome } from "../../src/psi/waitForPeerClose.js";
import type { RendezvousPair } from "../utils/rendezvousPair.js";

/**
 * The web transport's clean close against the real stack: a real PeerJS pair
 * over the app's own broker, in real Chromium, with the final frame big enough
 * that its delivery takes measurable time.
 *
 * What it pins is the delivery contract in docs/COMMUNICATION.md: a party's
 * last act is a send immediately followed by a close, so a close that returns
 * while the frame is still in the browser's outbound buffer drops it the moment
 * anything ends that page's WebRTC stack. PeerJS's flushing close does exactly
 * that -- it queues its in-band sentinel and returns -- which is why the close
 * waits for the peer to take the frame (waitForPeerClose.ts). The zero-ceiling
 * case below is the same exchange with that wait disabled, so a regression to
 * flush-and-return cannot pass this file by making the ordering vacuous.
 */

const addressInfo = {
  address: "127.0.0.1",
  port: inject("webDevServerPort") ?? 3000,
};
const hostString = `http://${addressInfo.address}:${String(addressInfo.port)}`;
const serverUnreachableNote = `PeerJS coordination server at ${hostString} unreachable`;

/**
 * Large enough that the browser cannot have delivered it by the time a
 * flush-and-return close resolves: measured at hundreds of milliseconds over
 * loopback, against the sub-millisecond return of the unwaited close.
 */
const FINAL_FRAME_BYTES = 8 * 1024 * 1024;

function frameOfBytes(size: number, tag: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1)
    bytes[index] = (index + tag) % 251;
  return bytes;
}

/** PeerJS hands an assembled chunked frame back as a `Uint8Array` and an
 * unchunked one as an `ArrayBuffer`; both are the frame's bytes. */
function asBytes(frame: unknown): Uint8Array {
  if (frame instanceof Uint8Array) return frame;
  if (frame instanceof ArrayBuffer) return new Uint8Array(frame);
  throw new Error(
    `expected binary frame, got ${Object.prototype.toString.call(frame)}`,
  );
}

interface ReceivedFrame {
  bytes: Uint8Array;
  at: number;
}

/** Every frame the peer delivers, stamped, up to the close the peer's sentinel
 * surfaces as a terminal receive error. */
async function receiveUntilClosed(
  mc: MessageConnection,
  origin: number,
): Promise<Array<ReceivedFrame>> {
  const frames: Array<ReceivedFrame> = [];
  for (;;) {
    try {
      frames.push({
        bytes: asBytes(await mc.receive(30_000)),
        at: performance.now() - origin,
      });
    } catch {
      return frames;
    }
  }
}

/** Both parties' view of one send-then-close: when the peer actually read the
 * final frame, when the sender's close resolved, and how the sender's wait for
 * the peer ended over it. */
interface CloseTiming {
  received: Array<ReceivedFrame>;
  closeResolvedAt: number;
  outcomes: Array<PeerCloseOutcome>;
}

async function sendThenClose(options: {
  finalFrameSize: number;
  closeDrainTimeoutMs?: number;
  /** Breaks the link between the two sends and the sender's close, in the tick
   * the close begins: a receiver still on the other end of a working channel is
   * the default. */
  breakLink?: (pair: RendezvousPair) => void;
  /** Breaks the link in the tick AFTER the sender's close has begun, so the
   * break lands on a drain already standing rather than before one starts. */
  breakLinkDuringDrain?: (pair: RendezvousPair) => void;
}): Promise<CloseTiming> {
  const pair = await connectRendezvousPair(generateSharedSecret(), addressInfo);
  const { inviterPeer, acceptorPeer, inviterConn, acceptorConn } = pair;
  const outcomes: Array<PeerCloseOutcome> = [];
  try {
    const senderMc = await openPeerMessageConnection(acceptorConn, {
      closeDrainTimeoutMs: options.closeDrainTimeoutMs,
      onCloseOutcome: (outcome) => outcomes.push(outcome),
    });
    const receiverMc = await openPeerMessageConnection(inviterConn);
    const origin = performance.now();
    const receiving = receiveUntilClosed(receiverMc, origin);

    await senderMc.send(frameOfBytes(64, 1));
    await senderMc.send(frameOfBytes(options.finalFrameSize, 7));
    // No await between the break and the close. Left a turn to react to it,
    // PeerJS marks the connection closed, the close takes its non-flushing
    // branch and no wait runs at all -- measured: a 100 ms gap here reports no
    // outcome whatsoever on either of the link-break tests below.
    options.breakLink?.(pair);
    // The production teardown's order (exchangeLifecycle.ts): the flushing
    // close, then the broker id is freed. `disconnect` deliberately leaves the
    // data channel standing.
    const closing = senderMc.close();
    // A zero delay is enough to land inside the drain: the final frame is sized
    // so its delivery takes hundreds of milliseconds (FINAL_FRAME_BYTES), which
    // is the whole window the wait exists to cover.
    if (options.breakLinkDuringDrain)
      setTimeout(() => options.breakLinkDuringDrain?.(pair), 0);
    await closing;
    const closeResolvedAt = performance.now() - origin;
    acceptorPeer.disconnect();

    const received = await receiving;
    await receiverMc.close();
    return { received, closeResolvedAt, outcomes };
  } finally {
    inviterPeer.destroy();
    acceptorPeer.destroy();
  }
}

/** Assert the frame arrived whole: the length, and the generated pattern at the
 * edges and across the body, so a truncated or misassembled reassembly fails. */
function expectFinalFrame(frame: ReceivedFrame | undefined, size: number) {
  expect(frame?.bytes.byteLength).toBe(size);
  const bytes = frame?.bytes ?? new Uint8Array();
  for (const index of [0, 1, size - 2, size - 1, Math.floor(size / 2)])
    expect(bytes[index]).toBe((index + 7) % 251);
}

test("a clean close resolves only once the peer has read the final frame", async (ctx) => {
  if (!(await canReachServer(hostString)))
    return ctx.skip(serverUnreachableNote);
  const { received, closeResolvedAt, outcomes } = await sendThenClose({
    finalFrameSize: FINAL_FRAME_BYTES,
  });

  expect(received.length).toBe(2);
  expectFinalFrame(received.at(-1), FINAL_FRAME_BYTES);
  // Both parties run in this one page, so the stamps share a clock: the close
  // resolving no earlier than the peer's read is the delivery guarantee itself.
  expect(closeResolvedAt).toBeGreaterThanOrEqual(received[1].at);
  // A real peer's close against a real stack IS the delivery signal, so the run
  // tells its operator nothing. Only the real stack can pin that direction, and
  // it is the one that matters: a notice here would tell the operator of a
  // healthy exchange to distrust it.
  expect(outcomes).toEqual(["peer-closed"]);
  expect(CLOSE_OUTCOME_WARNINGS[outcomes[0]]).toBeUndefined();
}, 120_000);

test("the wait is what orders it: an unwaited close returns with the frame in flight", async (ctx) => {
  if (!(await canReachServer(hostString)))
    return ctx.skip(serverUnreachableNote);
  // A zero ceiling is PeerJS's own flush-and-return close, the model this
  // transport does not rely on. The frame still arrives here -- nothing tears
  // the page's peer connection down -- but the close no longer says so, which
  // is what the guarantee above is worth.
  const { received, closeResolvedAt, outcomes } = await sendThenClose({
    finalFrameSize: FINAL_FRAME_BYTES,
    closeDrainTimeoutMs: 0,
  });

  expect(received.length).toBe(2);
  expectFinalFrame(received.at(-1), FINAL_FRAME_BYTES);
  expect(closeResolvedAt).toBeLessThan(received[1].at);
  // The close ended on its ceiling with the frame in flight, which is exactly
  // the state the operator has to be told about -- once: the frame arrived here
  // only because nothing tore this page's stack down behind it.
  expect(outcomes).toEqual(["ceiling"]);
  expect(CLOSE_OUTCOME_WARNINGS[outcomes[0]]).toBe(
    FINAL_FRAME_UNCONFIRMED_WAIT_EXPIRED_WARNING,
  );
}, 120_000);

test("a link that dies before the peer confirms tells the operator so", async (ctx) => {
  if (!(await canReachServer(hostString)))
    return ctx.skip(serverUnreachableNote);
  // The link-death exit against the real stack: the peer connection carrying
  // the final frame is gone when the close's wait looks, so no delivery signal
  // is coming and the operator hears the wording for a link that went rather
  // than for a partner who never confirmed.
  //
  // The break is this side's own half of the link, which is the half a browser
  // test can take away: the exit is defined by this peer connection reaching a
  // dead state, and an in-page teardown of the REMOTE half does not produce one
  // -- it resets the stream gracefully and arrives here as the peer's close
  // (pinned by the test below, which is why a rewrite to break the other half
  // would stop covering this exit).
  const { outcomes } = await sendThenClose({
    finalFrameSize: FINAL_FRAME_BYTES,
    breakLink: ({ acceptorConn }) => acceptorConn.peerConnection.close(),
  });

  expect(outcomes).toEqual(["peer-gone"]);
  expect(CLOSE_OUTCOME_WARNINGS[outcomes[0]]).toBe(
    FINAL_FRAME_UNCONFIRMED_LINK_LOST_WARNING,
  );
}, 120_000);

test("a link torn down under a standing drain is not reported as delivered", async (ctx) => {
  if (!(await canReachServer(hostString)))
    return ctx.skip(serverUnreachableNote);
  // The same teardown as the test above, but on a drain already under way --
  // the window the wait exists to cover. It closes this side's channel, so the
  // wait sees the event that normally IS the delivery signal, on an exchange
  // that delivered nothing: the partner is left with the small frame and none
  // of the final one. Reading the link at that event is what separates the two,
  // so this is the case that fails if a stack change (or a rewrite of the
  // handler) puts the reading back after the close has completed.
  const { received, outcomes } = await sendThenClose({
    finalFrameSize: FINAL_FRAME_BYTES,
    breakLinkDuringDrain: ({ acceptorConn }) =>
      acceptorConn.peerConnection.close(),
  });

  expect(received.length).toBe(1);
  expect(outcomes).toEqual(["peer-gone"]);
  expect(CLOSE_OUTCOME_WARNINGS[outcomes[0]]).toBe(
    FINAL_FRAME_UNCONFIRMED_LINK_LOST_WARNING,
  );
}, 120_000);

test("a peer torn down in this page still closes its stream, and reads as delivered", async (ctx) => {
  if (!(await canReachServer(hostString)))
    return ctx.skip(serverUnreachableNote);
  // What a partner disappearing looks like from here when both peers share a
  // renderer: Chromium tears the remote peer connection down through a graceful
  // stream reset, so this side gets the same channel close a peer that read the
  // sentinel would send, and reports delivery. The limit that leaves -- a close
  // signal is not proof the partner's application read what was behind it -- is
  // recorded in docs/spec/WEBRTC_TRANSPORT.md; a stack that stopped resetting
  // the stream would redden here rather than quietly change what a close means.
  const { outcomes } = await sendThenClose({
    finalFrameSize: FINAL_FRAME_BYTES,
    breakLink: ({ inviterConn }) => inviterConn.peerConnection.close(),
  });

  expect(outcomes).toEqual(["peer-closed"]);
}, 120_000);
