import Peer, { util } from "peerjs";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { WebSocketServer } from "ws";

import {
  MAX_PENDING_SIGNALING_MESSAGES,
  MAX_SIGNALING_FRAME_BYTES,
  boundPeerSignaling,
} from "../../../src/psi/transport/signalingBounds.js";

import type { AddressInfo } from "node:net";
import type { WebSocket as ServerSocket } from "ws";

// Drives the real PeerJS Peer, its Socket and Node's WebSocket against a
// loopback WebSocket server standing in for the signaling server, so the bounds
// are measured on the objects the browser runs rather than on a stand-in.

// PeerJS probes for WebRTC once at module load and refuses to start a peer
// without it; Node has none, and nothing here opens a peer connection.
const supports = util.supports as { data: boolean };
const supportedData = supports.data;

let server: WebSocketServer;
let port: number;
let nextSocket: (socket: ServerSocket) => void = () => {};
const peers: Array<Peer> = [];

beforeAll(async () => {
  supports.data = true;
  server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  server.on("connection", (socket) => nextSocket(socket));
  await new Promise<void>((resolve) => server.once("listening", resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(() => {
  for (const peer of peers.splice(0)) peer.destroy();
});

afterAll(async () => {
  supports.data = supportedData;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A bounded peer, and the server side of the socket it opened. */
async function connectedPeer(): Promise<{ peer: Peer; socket: ServerSocket }> {
  const accepted = new Promise<ServerSocket>((resolve) => {
    nextSocket = resolve;
  });
  const peer = boundPeerSignaling(
    new Peer("bounded-peer", {
      host: "127.0.0.1",
      port,
      path: "/",
      secure: false,
      pingInterval: 60_000,
      config: { iceServers: [] },
    }),
  );
  peers.push(peer);
  return { peer, socket: await accepted };
}

/** The first `open` or `error` the peer emits. */
function firstOutcome(peer: Peer): Promise<"open" | Error> {
  return new Promise((resolve) => {
    peer.once("open", () => resolve("open"));
    peer.once("error", (err: Error) => resolve(err));
  });
}

/** An OPEN frame padded with `pad` to exactly `bytes` UTF-8 bytes. */
function paddedOpen(bytes: number, pad: string): string {
  const base = JSON.stringify({ type: "OPEN", pad: "" });
  const padBytes = new TextEncoder().encode(pad).byteLength;
  const count = Math.floor((bytes - base.length) / padBytes);
  const frame = JSON.stringify({ type: "OPEN", pad: pad.repeat(count) });
  const fill = bytes - new TextEncoder().encode(frame).byteLength;
  return frame + " ".repeat(fill);
}

test("a frame at the byte limit is parsed", async () => {
  const { peer, socket } = await connectedPeer();
  const outcome = firstOutcome(peer);
  socket.send(paddedOpen(MAX_SIGNALING_FRAME_BYTES, "x"));
  expect(await outcome).toBe("open");
});

test.each([
  ["one-byte", "x"],
  ["multi-byte", "é"],
])(
  "a %s frame over the byte limit is refused unparsed and ends signaling",
  async (_label, pad) => {
    const { peer, socket } = await connectedPeer();
    const outcome = firstOutcome(peer);
    const closed = new Promise<void>((resolve) =>
      socket.once("close", resolve),
    );
    socket.send(paddedOpen(MAX_SIGNALING_FRAME_BYTES + 1, pad));
    const result = await outcome;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe(
      `the signaling server sent a frame larger than the ` +
        `${MAX_SIGNALING_FRAME_BYTES}-byte limit`,
    );
    await closed;
    expect(peer.open).toBe(false);
    expect(peer.disconnected).toBe(true);
  },
);

test("messages held for connections not yet set up stop at the cap", async () => {
  const { peer, socket } = await connectedPeer();
  const opened = firstOutcome(peer);
  socket.send(JSON.stringify({ type: "OPEN" }));
  expect(await opened).toBe("open");

  const candidate = (connectionId: string) =>
    JSON.stringify({
      type: "CANDIDATE",
      src: "partner",
      dst: "bounded-peer",
      payload: {
        type: "data",
        connectionId,
        candidate: { candidate: "", sdpMid: "0", sdpMLineIndex: 0 },
      },
    });
  for (let i = 0; i < 300; i += 1) socket.send(candidate("dc_one"));
  for (let i = 0; i < 300; i += 1) socket.send(candidate(`dc_${i}`));
  // Frames arrive in order, so the error this answers with comes after every
  // candidate above has been handled.
  const sentinel = firstOutcome(peer);
  socket.send(JSON.stringify({ type: "EXPIRE", src: "partner" }));
  expect(await sentinel).toBeInstanceOf(Error);

  const held = (
    peer as unknown as { _lostMessages: Map<string, Array<unknown>> }
  )._lostMessages;
  expect([...held.values()].flat()).toHaveLength(
    MAX_PENDING_SIGNALING_MESSAGES,
  );
  expect(held.get("dc_one")).toHaveLength(MAX_PENDING_SIGNALING_MESSAGES);
});
