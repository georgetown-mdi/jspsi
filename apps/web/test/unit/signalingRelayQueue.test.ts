import http from "node:http";

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import WebSocket from "ws";

import { getDiagnosticSink, setDiagnosticSink } from "@psilink/core";

import {
  MessageQueue,
  serializeFrame,
} from "@psilink/peerjs-broker/models/messageQueue";
import { CreatePeerServerWSOnly } from "@psilink/peerjs-broker";
import { MAX_QUEUE_BYTES } from "@psilink/peerjs-broker/models/realm";
import { MessageType } from "@psilink/peerjs-broker/enums";

import { signalingDiagnosticSink } from "../../src/signalingDiagnostics";

import { KEY } from "../utils/signalingHarness";

import type { AddressInfo } from "node:net";
import type { DiagnosticSink } from "@psilink/core";
import type { IMessage } from "@psilink/peerjs-broker/models/message";
import type { IRealm } from "@psilink/peerjs-broker/models/realm";
import type { SerializedFrame } from "@psilink/peerjs-broker/models/messageQueue";

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

/** A signaling payload of the shape a real offer has: a JSON object, not a
 * string. Sizing it is what decides whether the relay holds the frame. */
const OFFER_PAYLOAD = {
  sdp: { type: "offer", sdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n" },
  type: "data",
  connectionId: "dc_4f2a",
  browser: "chrome",
};

/** A payload holding every JSON shape a signaling frame can nest -- objects
 * inside arrays inside objects, numbers, booleans, null, and non-Latin1 text --
 * so what the hold returns is compared against more than a string. */
const NESTED_PAYLOAD = {
  sdp: {
    type: "offer",
    sdp: "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n",
  },
  candidates: [
    { candidate: "candidate:1 1 udp 2113937151 127.0.0.1 54321 typ host" },
    {
      candidate:
        "candidate:2 1 tcp 1518280447 127.0.0.1 9 typ host tcptype active",
    },
  ],
  metadata: { label: "linkage-Ā", retries: 3, reliable: true, note: null },
  connectionId: "dc_7b3e",
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

/** The broker's logger context, which marks its lines in a capture that sees
 * every prefixed logger in the process. */
const BROKER_LOG_CONTEXT = "peerjs-broker";

const clients: Array<WebSocket> = [];
const cleanups: Array<() => Promise<void>> = [];

let capturedLines: Array<string>;
let priorSink: DiagnosticSink | undefined;

beforeEach(() => {
  capturedLines = [];
  priorSink = getDiagnosticSink();
  setDiagnosticSink((_method, prefix, args) => {
    capturedLines.push([prefix, ...args.map((arg) => String(arg))].join(" "));
  });
});

afterEach(async () => {
  setDiagnosticSink(priorSink);
  for (const ws of clients.splice(0)) ws.terminate();
  while (cleanups.length) await cleanups.pop()?.();
});

/** Only the broker's lines: the capture is process-wide, so another core logger
 * emitting during a test must not be treated as a broker diagnostic. */
function brokerLines(): Array<string> {
  return capturedLines.filter((line) =>
    line.includes(`[${BROKER_LOG_CONTEXT}]`),
  );
}

/** A signaling server built by `CreatePeerServerWSOnly` -- the single builder
 * the web app's mount and the standalone runner both go through -- so the queue
 * and the drain behind it are the shipped ones rather than a restatement. */
async function startShippedBroker(): Promise<{ port: number; realm: IRealm }> {
  const server = http.createServer();
  const { realm } = CreatePeerServerWSOnly(server, signalingDiagnosticSink, {
    path: "/",
    key: KEY,
  });
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

    // Held rather than dropped: the queue exists and holds the one frame.
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

  test("delivers a deeply nested payload unchanged through the hold", async () => {
    // The queue holds a frame in serialized form and reconstitutes it on the
    // way out, so what a held payload must survive is a round trip through that
    // form -- nesting, arrays, numbers, booleans, null, and non-Latin1 text
    // included, not just the one SDP string of the offer above.
    const broker = await startShippedBroker();

    const absent = await connectCollecting(broker.port, ABSENT_ID);
    absent.ws.close();
    await waitFor(() => broker.realm.getClientById(ABSENT_ID) === undefined);

    const sender = await connectCollecting(broker.port, SENDER_ID);
    sender.ws.send(
      JSON.stringify({
        type: "OFFER",
        dst: ABSENT_ID,
        payload: NESTED_PAYLOAD,
      }),
    );

    await waitFor(
      () => broker.realm.getMessageQueueById(ABSENT_ID)?.size() === 1,
    );

    const reconnected = await connectCollecting(broker.port, ABSENT_ID);
    await waitFor(() =>
      reconnected.frames.some((frame) => frame.type === "OFFER"),
    );
    const offer = reconnected.frames.find((frame) => frame.type === "OFFER")!;
    expect(offer.src).toBe(SENDER_ID);
    expect(offer.payload).toEqual(NESTED_PAYLOAD);
  });

  test("drops a held frame it cannot reconstitute and delivers the rest of the hold", async () => {
    // The drain parses each frame held as JSON text, and it runs from inside the
    // socket's connection event with nothing between it and `ws` -- so a parse
    // that threw would be an uncaught exception on an internet-facing server.
    // Planted here rather than sent, since the text a frame is held with is this
    // server's own serialization and no peer can corrupt it over the wire: what
    // is measured is what the drain does if one ever is.
    const broker = await startShippedBroker();

    const absent = await connectCollecting(broker.port, ABSENT_ID);
    absent.ws.close();
    await waitFor(() => broker.realm.getClientById(ABSENT_ID) === undefined);

    const sender = await connectCollecting(broker.port, SENDER_ID);
    sender.ws.send(
      JSON.stringify({ type: "OFFER", dst: ABSENT_ID, payload: OFFER_PAYLOAD }),
    );
    await waitFor(
      () => broker.realm.getMessageQueueById(ABSENT_ID)?.size() === 1,
    );

    const corruptedText = "{ not json";
    const corrupted: SerializedFrame = {
      message: {
        type: MessageType.OFFER,
        src: SENDER_ID,
        dst: ABSENT_ID,
        payload: corruptedText,
      },
      byteSize:
        2 *
        (MessageType.OFFER.length +
          SENDER_ID.length +
          ABSENT_ID.length +
          corruptedText.length),
      payloadKind: "json",
    };
    broker.realm.getMessageQueueById(ABSENT_ID)!.addMessage(corrupted);

    sender.ws.send(
      JSON.stringify({
        type: "OFFER",
        dst: ABSENT_ID,
        payload: NESTED_PAYLOAD,
      }),
    );
    await waitFor(
      () => broker.realm.getMessageQueueById(ABSENT_ID)?.size() === 3,
    );

    // Both good frames arrive, in the order they were held, with the corrupted
    // one between them dropped rather than delivered or blocking the two.
    const reconnected = await connectCollecting(broker.port, ABSENT_ID);
    await waitFor(
      () =>
        reconnected.frames.filter((frame) => frame.type === "OFFER").length ===
        2,
    );
    expect(
      reconnected.frames
        .filter((frame) => frame.type === "OFFER")
        .map((frame) => frame.payload),
    ).toEqual([OFFER_PAYLOAD, NESTED_PAYLOAD]);

    // The drop is reported as this server's own fault rather than the peer's,
    // down the same route the enqueue boundary's refusal takes.
    await waitFor(() =>
      brokerLines().some((line) => line.includes("[frame-dispatch]")),
    );
    expect(brokerLines().some((line) => line.includes("[client-frame]"))).toBe(
      false,
    );

    // The drain ran to the end and released the hold, and the socket that came
    // back for it is still open.
    expect(broker.realm.getMessageQueueById(ABSENT_ID)).toBeUndefined();
    expect(reconnected.ws.readyState).toBe(WebSocket.OPEN);
  });
});

describe("queue byte accounting", () => {
  // MAX_QUEUE_BYTES bounds a queue by the sizes charged into its running total,
  // so a frame whose `byteSize` disagrees with the frame itself would move that
  // bound off the memory it exists to hold down. Driven against the queue rather
  // than over a socket because the in-tree enqueue path sizes every frame with
  // `serializeFrame` and so cannot produce the disagreement: the reachable
  // caller is one outside this repository, holding these package exports.

  /** An offer sized the way the enqueue path sizes it, so what a test varies is
   * the accounted size alone. */
  function sizedOffer(): SerializedFrame {
    return serializeFrame({
      type: MessageType.OFFER,
      src: SENDER_ID,
      dst: ABSENT_ID,
      payload: OFFER_PAYLOAD,
    } as unknown as IMessage);
  }

  test.each([
    ["understates", 1],
    ["overstates", 4096],
  ])(
    "refuses a frame whose accounted size %s the frame",
    (_direction, byteSize) => {
      const queue = new MessageQueue();
      queue.addMessage(sizedOffer());
      const heldBytes = queue.byteSize();
      expect(heldBytes).toBeGreaterThan(0);

      expect(() => {
        queue.addMessage({ ...sizedOffer(), byteSize });
      }).toThrow(RangeError);

      // Refused outright: neither the mismatched size nor the frame it came with
      // reaches the queue, so the total still describes exactly what is held.
      expect(queue.size()).toBe(1);
      expect(queue.byteSize()).toBe(heldBytes);
    },
  );

  test("a mismatch on a frame the queue would otherwise hold is caught before the total moves", () => {
    // The mismatch that matters is one the cap would never have questioned: the
    // size handed in is small and legal, and only the frame behind it is large.
    const queue = new MessageQueue();
    const oversized = serializeFrame({
      type: MessageType.OFFER,
      src: SENDER_ID,
      dst: ABSENT_ID,
      payload: "x".repeat(200_000),
    });
    expect(oversized.byteSize).toBeLessThanOrEqual(MAX_QUEUE_BYTES);
    expect(oversized.byteSize).toBeGreaterThan(MAX_QUEUE_BYTES / 2);

    expect(() => {
      queue.addMessage({ ...oversized, byteSize: 16 });
    }).toThrow(RangeError);

    expect(queue.size()).toBe(0);
    expect(queue.byteSize()).toBe(0);
  });
});
