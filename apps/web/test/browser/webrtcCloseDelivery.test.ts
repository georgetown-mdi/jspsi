/// <reference types="@vitest/browser-playwright/context" />

import { expect, inject, test } from "vitest";

import { generateSharedSecret } from "@psilink/core";

import { openPeerMessageConnection } from "../../src/psi/peerMessageConnection.js";

import { canReachServer } from "../utils/pspiFixtures.js";
import { connectRendezvousPair } from "../utils/rendezvousPair.js";

import type { MessageConnection } from "@psilink/core";

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
 * final frame, when the sender's close resolved, and how many times the sender
 * reported the final frame unconfirmed over it. */
interface CloseTiming {
  received: Array<ReceivedFrame>;
  closeResolvedAt: number;
  unconfirmed: number;
}

async function sendThenClose(options: {
  finalFrameSize: number;
  closeDrainTimeoutMs?: number;
}): Promise<CloseTiming> {
  const { inviterPeer, acceptorPeer, inviterConn, acceptorConn } =
    await connectRendezvousPair(generateSharedSecret(), addressInfo);
  let unconfirmed = 0;
  try {
    const senderMc = await openPeerMessageConnection(acceptorConn, {
      closeDrainTimeoutMs: options.closeDrainTimeoutMs,
      onFinalFrameUnconfirmed: () => (unconfirmed += 1),
    });
    const receiverMc = await openPeerMessageConnection(inviterConn);
    const origin = performance.now();
    const receiving = receiveUntilClosed(receiverMc, origin);

    await senderMc.send(frameOfBytes(64, 1));
    await senderMc.send(frameOfBytes(options.finalFrameSize, 7));
    // The production teardown's order (exchangeLifecycle.ts): the flushing
    // close, then the broker id is freed. `disconnect` deliberately leaves the
    // data channel standing.
    await senderMc.close();
    const closeResolvedAt = performance.now() - origin;
    acceptorPeer.disconnect();

    const received = await receiving;
    await receiverMc.close();
    return { received, closeResolvedAt, unconfirmed };
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
  const { received, closeResolvedAt, unconfirmed } = await sendThenClose({
    finalFrameSize: FINAL_FRAME_BYTES,
  });

  expect(received.length).toBe(2);
  expectFinalFrame(received.at(-1), FINAL_FRAME_BYTES);
  // Both parties run in this one page, so the stamps share a clock: the close
  // resolving no earlier than the peer's read is the delivery guarantee itself.
  expect(closeResolvedAt).toBeGreaterThanOrEqual(received[1].at);
  // A real peer's close against a real stack IS the delivery signal, so nothing
  // is reported unconfirmed. Only the real stack can pin that direction, and it
  // is the one that matters: a notice here would tell the operator of a healthy
  // exchange to distrust it.
  expect(unconfirmed).toBe(0);
}, 120_000);

test("the wait is what orders it: an unwaited close returns with the frame in flight", async (ctx) => {
  if (!(await canReachServer(hostString)))
    return ctx.skip(serverUnreachableNote);
  // A zero ceiling is PeerJS's own flush-and-return close, the model this
  // transport does not rely on. The frame still arrives here -- nothing tears
  // the page's peer connection down -- but the close no longer says so, which
  // is what the guarantee above is worth.
  const { received, closeResolvedAt, unconfirmed } = await sendThenClose({
    finalFrameSize: FINAL_FRAME_BYTES,
    closeDrainTimeoutMs: 0,
  });

  expect(received.length).toBe(2);
  expectFinalFrame(received.at(-1), FINAL_FRAME_BYTES);
  expect(closeResolvedAt).toBeLessThan(received[1].at);
  // The close ended on its ceiling with the frame in flight, which is exactly
  // the state the operator has to be told about -- once: the frame arrived here
  // only because nothing tore this page's stack down behind it.
  expect(unconfirmed).toBe(1);
}, 120_000);
