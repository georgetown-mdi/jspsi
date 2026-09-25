import { Buffer } from "node:buffer";
import http from "node:http";
import net from "node:net";
import { randomBytes } from "node:crypto";

import { afterEach, describe, expect, test } from "vitest";
import WebSocket from "ws";

import { CreatePeerServerWSOnly } from "@alcove/peerjs-broker";
import { MAX_RELAY_BUFFERED_BYTES } from "@alcove/peerjs-broker/messageHandler/handlers/transmission/index";
import { MAX_SIGNALING_PAYLOAD_BYTES } from "@alcove/peerjs-broker/services/webSocketServer/index";

import { KEY } from "../utils/signalingHarness";

import type { AddressInfo } from "node:net";
import type { IConfig } from "@alcove/peerjs-broker/config/index";
import type { IRealm } from "@alcove/peerjs-broker/models/realm";

// The relay's bounds on what it holds for a peer, driven over real sockets
// against the broker `CreatePeerServerWSOnly` builds -- the one the web app's
// mount and the standalone runner both use -- so the message handler, the
// realm and the socket server under test are the shipped ones.

const SENDER_ID = "peer-sender";
const RECIPIENT_ID = "peer-recipient";

interface SignalingFrame {
  type?: unknown;
  src?: unknown;
  dst?: unknown;
  payload?: unknown;
}

interface PeerSocket {
  ws: WebSocket;
  /** Every frame the server sent this socket, in arrival order. */
  frames: Array<SignalingFrame>;
  /** The byte length of each frame, in the same order. */
  frameBytes: Array<number>;
}

interface Broker {
  port: number;
  realm: IRealm;
  server: http.Server;
}

const clients: Array<WebSocket> = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const ws of clients.splice(0)) ws.terminate();
  while (cleanups.length) await cleanups.pop()?.();
});

async function startShippedBroker(
  options: Partial<IConfig> = {},
): Promise<Broker> {
  const server = http.createServer();
  const diagnostics: Array<string> = [];
  const { realm } = CreatePeerServerWSOnly(
    server,
    (line) => diagnostics.push(line),
    { path: "/", key: KEY, ...options },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { port: (server.address() as AddressInfo).port, realm, server };
}

function signalingUrl(port: number, id: string, token = "tok"): string {
  return `ws://127.0.0.1:${port}/peerjs?key=${KEY}&id=${id}&token=${token}`;
}

function connectCollecting(
  port: number,
  id: string,
  token = "tok",
): Promise<PeerSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(signalingUrl(port, id, token));
    clients.push(ws);
    const frames: Array<SignalingFrame> = [];
    const frameBytes: Array<number> = [];
    ws.on("message", (data: WebSocket.RawData) => {
      const text = data.toString();
      const frame = JSON.parse(text) as SignalingFrame;
      frames.push(frame);
      frameBytes.push(Buffer.byteLength(text, "utf8"));
      if (frame.type === "OPEN") resolve({ ws, frames, frameBytes });
    });
    ws.on("error", reject);
  });
}

/** Register `id` over a hand-rolled connection and then stop reading it, so
 * nothing the server writes is taken off the socket: the peer that stops
 * reading while its connection stays up. */
async function registerThenStopReading(
  port: number,
  id: string,
): Promise<net.Socket> {
  const socket = net.connect(port, "127.0.0.1");
  socket.on("error", () => {});
  cleanups.push(() => {
    socket.destroy();
    return Promise.resolve();
  });
  const received: Array<Buffer> = [];
  const onData = (chunk: Buffer): void => {
    received.push(chunk);
  };
  socket.on("data", onData);
  await new Promise<void>((resolve) => socket.once("connect", resolve));
  socket.write(
    [
      `GET /peerjs?key=${KEY}&id=${id}&token=tok HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
      "Sec-WebSocket-Version: 13",
      "",
      "",
    ].join("\r\n"),
  );
  await waitFor(() =>
    Buffer.concat(received).toString("latin1").includes('"type":"OPEN"'),
  );
  socket.off("data", onData);
  socket.pause();
  return socket;
}

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

function settlesWithin(
  promise: Promise<unknown>,
  ms: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** A signaling frame whose string payload brings it to `payloadChars` over
 * the envelope, addressed to `dst`. */
function offerFrame(dst: string, payloadChars: number): string {
  return JSON.stringify({
    type: "OFFER",
    dst,
    payload: "x".repeat(payloadChars),
  });
}

describe("relay send-buffer bound", () => {
  test("drops a destination that stops reading before its buffer passes the bound", async () => {
    const broker = await startShippedBroker();
    const sender = await connectCollecting(broker.port, SENDER_ID);
    await registerThenStopReading(broker.port, RECIPIENT_ID);

    // The broker's own socket toward the recipient, observed at every send the
    // relay makes on it: the highest `bufferedAmount` it reaches is the most
    // the process ever held for this peer.
    const toRecipient = broker.realm.getClientById(RECIPIENT_ID)!.getSocket()!;
    let peakBuffered = 0;
    const relaySend = toRecipient.send.bind(toRecipient);
    toRecipient.send = ((data: string) => {
      relaySend(data);
      peakBuffered = Math.max(peakBuffered, toRecipient.bufferedAmount);
    }) as typeof toRecipient.send;
    const recipientReleased = (): boolean =>
      toRecipient.readyState === WebSocket.CLOSED;

    // Far more than the bound, so a relay that buffered without one would sit
    // many times over it by the end; the loop stops as soon as the recipient is
    // dropped.
    const frame = offerFrame(RECIPIENT_ID, 200 * 1024);
    const offeredLimit = 64 * MAX_RELAY_BUFFERED_BYTES;
    let offered = 0;
    while (!recipientReleased() && offered < offeredLimit) {
      sender.ws.send(frame);
      offered += frame.length;
      while (
        sender.ws.bufferedAmount > 4 * 1024 * 1024 &&
        !recipientReleased()
      ) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    await waitFor(recipientReleased, 5_000);

    expect(peakBuffered).toBeGreaterThan(0);
    expect(peakBuffered).toBeLessThanOrEqual(MAX_RELAY_BUFFERED_BYTES);
    expect(broker.realm.getClientById(RECIPIENT_ID)).toBeUndefined();

    // The sender is told the recipient left and keeps its own registration.
    await waitFor(() =>
      sender.frames.some(
        (received) =>
          received.type === "LEAVE" && received.src === RECIPIENT_ID,
      ),
    );
    expect(sender.ws.readyState).toBe(WebSocket.OPEN);
    expect(broker.realm.getClientById(SENDER_ID)).toBeDefined();
  }, 30_000);

  test("a recipient that keeps reading takes more than the bound in total", async () => {
    // The bound is on bytes waiting for the recipient, not on bytes relayed to
    // it: a reader receives traffic well past it and stays connected.
    const broker = await startShippedBroker();
    const sender = await connectCollecting(broker.port, SENDER_ID);
    const recipient = await connectCollecting(broker.port, RECIPIENT_ID);

    const frame = offerFrame(RECIPIENT_ID, 200 * 1024);
    const frameCount =
      Math.ceil((3 * MAX_RELAY_BUFFERED_BYTES) / frame.length) + 1;
    for (let sent = 1; sent <= frameCount; sent += 1) {
      sender.ws.send(frame);
      await waitFor(
        () =>
          recipient.frames.filter((received) => received.type === "OFFER")
            .length === sent,
      );
    }

    expect(recipient.ws.readyState).toBe(WebSocket.OPEN);
    expect(broker.realm.getClientById(RECIPIENT_ID)).toBeDefined();
    expect(sender.frames.map((received) => received.type)).toEqual(["OPEN"]);
  }, 30_000);

  test("relays the largest frame decoding can produce to an idle recipient", async () => {
    // The relayed form of a frame can exceed its wire form: a binary frame is
    // decoded as UTF-8, and each invalid byte becomes a three-byte U+FFFD. A
    // wire-legal frame made of them is the largest thing the relay writes in
    // one send, and the bound must hold it on a socket with nothing queued.
    const broker = await startShippedBroker();
    const sender = await connectCollecting(broker.port, SENDER_ID);
    const recipient = await connectCollecting(broker.port, RECIPIENT_ID);

    const head = Buffer.from(
      `{"type":"OFFER","dst":"${RECIPIENT_ID}","payload":"`,
    );
    const tail = Buffer.from('"}');
    const invalidBytes = Buffer.alloc(
      MAX_SIGNALING_PAYLOAD_BYTES - head.length - tail.length,
      0xff,
    );
    const wireFrame = Buffer.concat([head, invalidBytes, tail]);
    expect(wireFrame.length).toBe(MAX_SIGNALING_PAYLOAD_BYTES);
    sender.ws.send(wireFrame, { binary: true });

    await waitFor(() =>
      recipient.frames.some((received) => received.type === "OFFER"),
    );
    const offerIndex = recipient.frames.findIndex(
      (received) => received.type === "OFFER",
    );
    const relayedBytes = recipient.frameBytes[offerIndex];
    expect(relayedBytes).toBeGreaterThan(2.9 * MAX_SIGNALING_PAYLOAD_BYTES);
    expect(relayedBytes).toBeLessThanOrEqual(MAX_RELAY_BUFFERED_BYTES);
    expect(recipient.ws.readyState).toBe(WebSocket.OPEN);
    expect(sender.frames.map((received) => received.type)).toEqual(["OPEN"]);
  });

  test("a dropped recipient's socket is released without waiting on a close handshake", async () => {
    const broker = await startShippedBroker();
    const sender = await connectCollecting(broker.port, SENDER_ID);
    const stalled = await registerThenStopReading(broker.port, RECIPIENT_ID);
    const released = new Promise<void>((resolve) =>
      stalled.once("close", () => resolve()),
    );

    const frame = offerFrame(RECIPIENT_ID, 200 * 1024);
    for (
      let offered = 0;
      broker.realm.getClientById(RECIPIENT_ID) !== undefined &&
      offered < 64 * MAX_RELAY_BUFFERED_BYTES;
      offered += frame.length
    ) {
      sender.ws.send(frame);
      while (sender.ws.bufferedAmount > 4 * 1024 * 1024) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    await waitFor(
      () => broker.realm.getClientById(RECIPIENT_ID) === undefined,
      5_000,
    );

    // Resuming reads lets the peer see its side end; a close handshake the
    // peer never answers would instead hold the socket for the `ws` close
    // timer.
    stalled.resume();
    expect(await settlesWithin(released, 3_000)).toBe(true);
    await new Promise<void>((resolve) =>
      broker.server.getConnections((_error, count) => {
        expect(count).toBe(1);
        resolve();
      }),
    );
  }, 30_000);
});

/** How many connections the broker's HTTP server still holds open. */
function openConnections(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.getConnections((error, count) => {
      if (error) reject(error);
      else resolve(count);
    });
  });
}

describe("leaving the realm", () => {
  test("a client that leaves with no destination is disconnected along with its registration", async () => {
    // Every socket the broker holds for a client is counted by the realm, so
    // the sockets held stay within `concurrent_limit` however many clients
    // register and leave.
    const concurrentLimit = 2;
    const broker = await startShippedBroker({
      concurrent_limit: concurrentLimit,
    });

    const leaverCount = concurrentLimit * 2;
    for (let index = 0; index < leaverCount; index += 1) {
      const leaver = await connectCollecting(
        broker.port,
        `peer-leaver-${index}`,
      );
      const closed = new Promise<void>((resolve) =>
        leaver.ws.once("close", () => resolve()),
      );
      leaver.ws.send(JSON.stringify({ type: "LEAVE" }));
      expect(await settlesWithin(closed, 1_000)).toBe(true);
      expect(broker.realm.getClientById(`peer-leaver-${index}`)).toBe(
        undefined,
      );
    }

    expect(broker.realm.getClientsIds()).toEqual([]);
    const deadline = Date.now() + 3_000;
    while ((await openConnections(broker.server)) > 0) {
      if (Date.now() >= deadline) throw new Error("connections still held");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });

  test("a client that leaves no longer relays under its id", async () => {
    const broker = await startShippedBroker();
    const recipient = await connectCollecting(broker.port, RECIPIENT_ID);
    const leaver = await connectCollecting(broker.port, SENDER_ID);

    leaver.ws.send(JSON.stringify({ type: "LEAVE" }));
    // Sent behind the LEAVE on the same socket, so it would reach the relay if
    // the socket were still being read.
    leaver.ws.send(
      JSON.stringify({ type: "OFFER", dst: RECIPIENT_ID, payload: "late" }),
      () => {},
    );
    await waitFor(() => leaver.ws.readyState === WebSocket.CLOSED);

    // A client registering the id afresh is relayed as usual.
    const successor = await connectCollecting(
      broker.port,
      SENDER_ID,
      "another-token",
    );
    successor.ws.send(
      JSON.stringify({ type: "OFFER", dst: RECIPIENT_ID, payload: "fresh" }),
    );
    await waitFor(() =>
      recipient.frames.some((received) => received.type === "OFFER"),
    );
    expect(
      recipient.frames
        .filter((received) => received.type === "OFFER")
        .map((received) => received.payload),
    ).toEqual(["fresh"]);
  });
});
