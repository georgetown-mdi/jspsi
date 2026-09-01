import http from "node:http";

import { afterEach, describe, expect, test } from "vitest";
import WebSocket from "ws";

import { CreatePeerServerWSOnly } from "@psilink/peerjs-broker";

import { KEY } from "../utils/signalingHarness";

import type { AddressInfo } from "node:net";
import type { IRealm } from "@psilink/peerjs-broker/models/realm";

// The relay's hold-for-reconnect queue driven end to end over real sockets: a
// signaling frame addressed to a peer that has dropped its socket is held and
// handed over when that peer comes back. The queue's bounds are unit-covered in
// signalingReaping.test.ts against the realm directly; what is measured here is
// the shipped wiring around them -- sizing the frame, holding it, and the drain
// on the reconnect -- which only a real registration exercises.

/** The destination that goes away and comes back, and the peer that addresses
 * it while it is gone. */
const ABSENT_ID = "peer-absent";
const SENDER_ID = "peer-sender";

/** A signaling payload of the shape a real offer carries: a JSON object, not a
 * string. Sizing it is what decides whether the relay holds the frame. */
const OFFER_PAYLOAD = {
  sdp: { type: "offer", sdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n" },
  type: "data",
  connectionId: "dc_4f2a",
  browser: "chrome",
};

interface SignalingFrame {
  type?: unknown;
  src?: unknown;
  dst?: unknown;
  payload?: unknown;
}

interface PeerSocket {
  ws: WebSocket;
  /** Every frame the server sent this socket, in arrival order. Collected from
   * the moment the socket opens, so a frame the server pushes right behind the
   * OPEN -- which is what a drained queue does -- cannot be missed. */
  frames: Array<SignalingFrame>;
}

const clients: Array<WebSocket> = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const ws of clients.splice(0)) ws.terminate();
  while (cleanups.length) await cleanups.pop()?.();
});

/** A signaling server built by `CreatePeerServerWSOnly` -- the single builder
 * the web app's mount and the standalone runner both go through -- so the queue
 * and the drain behind it are the shipped ones rather than a restatement. */
async function startShippedBroker(): Promise<{ port: number; realm: IRealm }> {
  const server = http.createServer();
  const { realm } = CreatePeerServerWSOnly(server, { path: "/", key: KEY });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { port: (server.address() as AddressInfo).port, realm };
}

function connectCollecting(port: number, id: string): Promise<PeerSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/peerjs?key=${KEY}&id=${id}&token=tok`,
    );
    clients.push(ws);
    const frames: Array<SignalingFrame> = [];
    ws.on("message", (data: WebSocket.RawData) => {
      const frame = JSON.parse(data.toString()) as SignalingFrame;
      frames.push(frame);
      if (frame.type === "OPEN") resolve({ ws, frames });
    });
    ws.on("error", reject);
  });
}

/** Poll a loopback condition to a deadline inside the suite's own test timeout,
 * so a condition that never holds fails naming itself rather than as an
 * uninformative test timeout. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("relay hold-for-reconnect round trip", () => {
  test("holds an offer for a briefly-absent peer and delivers it on reconnect", async () => {
    const broker = await startShippedBroker();

    // The destination registers and then drops its socket, so the frame below
    // is addressed to an id the realm holds no client for.
    const absent = await connectCollecting(broker.port, ABSENT_ID);
    absent.ws.close();
    await waitFor(() => broker.realm.getClientById(ABSENT_ID) === undefined);

    const sender = await connectCollecting(broker.port, SENDER_ID);
    sender.ws.send(
      JSON.stringify({
        type: "OFFER",
        dst: ABSENT_ID,
        payload: OFFER_PAYLOAD,
      }),
    );

    // Held rather than dropped: the queue exists and carries the one frame.
    await waitFor(
      () => broker.realm.getMessageQueueById(ABSENT_ID)?.size() === 1,
    );

    // And handed over intact when the peer comes back, stamped with the id the
    // server resolved for the sender rather than anything the sender claimed.
    const reconnected = await connectCollecting(broker.port, ABSENT_ID);
    await waitFor(() =>
      reconnected.frames.some((frame) => frame.type === "OFFER"),
    );
    const offer = reconnected.frames.find((frame) => frame.type === "OFFER")!;
    expect(offer.src).toBe(SENDER_ID);
    expect(offer.payload).toEqual(OFFER_PAYLOAD);

    // The hold is released by the drain, so the queue is not left standing.
    expect(broker.realm.getMessageQueueById(ABSENT_ID)).toBeUndefined();

    // Nothing was bounced back to the sender: a held frame is not an error.
    expect(sender.frames.map((frame) => frame.type)).toEqual(["OPEN"]);
  });
});
