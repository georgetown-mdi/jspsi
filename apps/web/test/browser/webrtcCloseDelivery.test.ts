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
 * over the app's own broker, in real Chromium, with a final frame large
 * enough that delivery is measurable. This pins the delivery contract in
 * docs/COMMUNICATION.md: a close must wait for the peer to take the last
 * frame, since PeerJS's own close can return before it leaves the buffer.
 * The zero-ceiling case below disables that wait.
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
 * shows up as a terminal receive error. */
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
  /** Whether the sender's client had already issued its broker disconnect (a
   * client-side flag; the broker's own release happens in its socket-close
   * handler one round trip later) -- read before the default order calls it,
   * so a `disconnect` that did nothing cannot pass for one that did. */
  senderDisconnectedAtClose: boolean;
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
  /** Frees the sender's broker registration BEFORE its close instead of after
   * it: the managed re-run's teardown order (managedRunDriver.ts), whose drain
   * outlives the outcome it reports and so must not hold the record's
   * rendezvous id. */
  freeBrokerIdFirst?: boolean;
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
    // The one-shot lifecycle's teardown order (exchangeLifecycle.ts): the
    // flushing close, then the broker id is freed. `disconnect` leaves the
    // data channel standing, which is what lets the managed re-run's
    // teardown free the id first instead.
    if (options.freeBrokerIdFirst) acceptorPeer.disconnect();
    const closing = senderMc.close();
    // A zero delay is enough to land inside the drain: the final frame is sized
    // so its delivery takes hundreds of milliseconds (FINAL_FRAME_BYTES), which
    // is the whole window the wait exists to cover.
    if (options.breakLinkDuringDrain)
      setTimeout(() => options.breakLinkDuringDrain?.(pair), 0);
    await closing;
    const closeResolvedAt = performance.now() - origin;
    const senderDisconnectedAtClose = acceptorPeer.disconnected;
    if (!options.freeBrokerIdFirst) acceptorPeer.disconnect();

    const received = await receiving;
    await receiverMc.close();
    return {
      received,
      closeResolvedAt,
      outcomes,
      senderDisconnectedAtClose,
    };
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

test("a peer whose broker id is already freed still delivers on its close", async (ctx) => {
  if (!(await canReachServer(hostString)))
    return ctx.skip(serverUnreachableNote);
  // The assumption the managed re-run's teardown rests on (managedRunDriver.ts):
  // it frees the broker id before draining, so a failed run's retry can register
  // the record's rendezvous id again while the drain is still standing. Freeing
  // it must cost that drain nothing -- same delivery, same ordering, same
  // outcome as the test above -- and only the real stack can say so.
  const timing = await sendThenClose({
    finalFrameSize: FINAL_FRAME_BYTES,
    freeBrokerIdFirst: true,
  });

  expect(timing.senderDisconnectedAtClose).toBe(true);
  expect(timing.received.length).toBe(2);
  expectFinalFrame(timing.received.at(-1), FINAL_FRAME_BYTES);
  expect(timing.closeResolvedAt).toBeGreaterThanOrEqual(timing.received[1].at);
  expect(timing.outcomes).toEqual(["peer-closed"]);
  expect(CLOSE_OUTCOME_WARNINGS[timing.outcomes[0]]).toBeUndefined();
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
  // The link-death exit against the real stack: the peer connection holding
  // the final frame is gone when the close's wait looks, so the operator
  // hears the wording for a lost link rather than an unconfirmed partner. The
  // break is this side's own half -- the half a browser test can take away --
  // since tearing down the remote half instead resets the stream gracefully
  // and arrives here as the peer's close (the next test covers that case).
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
  // the window the wait exists to cover. It closes this side's channel, so
  // the wait sees the event that normally is the delivery signal, on an
  // exchange that delivered nothing but the small frame. Reading the link at
  // that event is what separates the two cases.
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

test("both parties closing a drained exchange treat each other's close as the receipt", async (ctx) => {
  if (!(await canReachServer(hostString)))
    return ctx.skip(serverUnreachableNote);
  // The shape every real exchange ends in: both parties have what they came
  // for, and both run the flushing close at once. Reading the peer's close
  // sentinel is what makes PeerJS tear this side's peer connection down, so
  // each side's channel starts closing on a link of its own closing. A wait
  // that read only the link would tell both operators of every healthy
  // exchange to check that their partner got the final message.
  const pair = await connectRendezvousPair(generateSharedSecret(), addressInfo);
  const { inviterPeer, acceptorPeer, inviterConn, acceptorConn } = pair;
  const senderOutcomes: Array<PeerCloseOutcome> = [];
  const receiverOutcomes: Array<PeerCloseOutcome> = [];
  try {
    const senderMc = await openPeerMessageConnection(acceptorConn, {
      onCloseOutcome: (outcome) => senderOutcomes.push(outcome),
    });
    const receiverMc = await openPeerMessageConnection(inviterConn, {
      onCloseOutcome: (outcome) => receiverOutcomes.push(outcome),
    });

    await senderMc.send(frameOfBytes(64, 1));
    await senderMc.send(frameOfBytes(FINAL_FRAME_BYTES, 7));
    // Drain before either side closes, so nothing is owed when they do: this
    // pins the healthy ending, not a peer that closes on a frame in flight.
    await receiverMc.receive(30_000);
    const received: ReceivedFrame = {
      bytes: asBytes(await receiverMc.receive(30_000)),
      at: performance.now(),
    };
    expectFinalFrame(received, FINAL_FRAME_BYTES);

    await Promise.all([senderMc.close(), receiverMc.close()]);
  } finally {
    inviterPeer.destroy();
    acceptorPeer.destroy();
  }

  expect(senderOutcomes).toEqual(["peer-closed"]);
  expect(receiverOutcomes).toEqual(["peer-closed"]);
  expect(CLOSE_OUTCOME_WARNINGS[senderOutcomes[0]]).toBeUndefined();
  expect(CLOSE_OUTCOME_WARNINGS[receiverOutcomes[0]]).toBeUndefined();
}, 120_000);

test("a peer torn down in this page still closes its stream, and is treated as delivered", async (ctx) => {
  if (!(await canReachServer(hostString)))
    return ctx.skip(serverUnreachableNote);
  // What a partner disappearing looks like from here when both peers share a
  // renderer: Chromium tears the remote peer connection down through a
  // graceful stream reset, so this side gets an ordinary peer close and
  // reports delivery. The limit that leaves -- a close signal is not proof
  // the partner's application read what was behind it -- is recorded in
  // docs/spec/WEBRTC_TRANSPORT.md; a stack that stopped resetting the stream
  // this way would fail here instead of quietly changing what a close means.
  const { outcomes } = await sendThenClose({
    finalFrameSize: FINAL_FRAME_BYTES,
    breakLink: ({ inviterConn }) => inviterConn.peerConnection.close(),
  });

  expect(outcomes).toEqual(["peer-closed"]);
}, 120_000);
