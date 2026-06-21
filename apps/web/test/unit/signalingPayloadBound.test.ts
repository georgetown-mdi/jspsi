import { createServer } from "node:http";

import WebSocket, { WebSocketServer as WsServer } from "ws";
import { afterEach, describe, expect, test } from "vitest";

import {
  MAX_SIGNALING_PAYLOAD_BYTES,
  WebSocketServer,
} from "@peerjs-server/services/webSocketServer/index.ts";
import { Realm } from "@peerjs-server/models/realm.ts";

import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

// The signaling server's default authentication gate: the well-known PeerJS key,
// id and token being free strings (so this models the unauthenticated client).
const KEY = "peerjs";

interface Harness {
  wss: WebSocketServer;
  httpServer: Server;
  port: number;
  errors: Array<Error>;
}

let harness: Harness | undefined;
const clients: Array<WebSocket> = [];

afterEach(async () => {
  for (const ws of clients.splice(0)) {
    try {
      ws.terminate();
    } catch {
      // already gone
    }
  }
  const server = harness?.httpServer;
  harness = undefined;
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Stand up the vendored WebSocketServer on a fresh loopback HTTP server. The
 * `error` events the server re-emits (an over-cap frame surfaces as one) are
 * collected rather than left to throw as an unhandled EventEmitter `error`. */
function startHarness(): Promise<Harness> {
  const httpServer = createServer();
  const realm = new Realm();
  const wss = new WebSocketServer({
    server: httpServer,
    realm,
    config: { path: "/", key: KEY, concurrent_limit: 5000 },
  });
  const errors: Array<Error> = [];
  wss.on("error", (error: Error) => errors.push(error));
  return new Promise((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => {
      const { port } = httpServer.address() as AddressInfo;
      const h: Harness = { wss, httpServer, port, errors };
      harness = h;
      resolve(h);
    });
  });
}

/** Connect a client through the signaling upgrade path and resolve it once it is
 * a registered peer (the server answers OPEN), so the inbound message handler is
 * attached. The path is `/peerjs` -- `config.path` "/" plus the WS_PATH suffix. */
function connectRegistered(port: number, id: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const url = `ws://127.0.0.1:${port}/peerjs?key=${KEY}&id=${id}&token=tok`;
    const ws = new WebSocket(url);
    clients.push(ws);
    ws.on("message", (data: WebSocket.RawData) => {
      const type = (JSON.parse(data.toString()) as { type?: unknown }).type;
      if (type === "OPEN") resolve(ws);
    });
    ws.on("error", reject);
    // A clean server close before OPEN (e.g. the concurrent-limit or invalid-key
    // path) emits no `error`; reject so a misconfigured registration fails the
    // test promptly instead of hanging until the vitest timeout.
    ws.on("close", () =>
      reject(new Error("signaling socket closed before OPEN")),
    );
  });
}

describe("signaling-server inbound frame bound", () => {
  test("an over-budget frame is rejected by ws before it reaches the parser, without crashing the server", async () => {
    const { wss, port, errors } = await startHarness();

    let messageEmitted = false;
    wss.on("message", () => {
      messageEmitted = true;
    });

    const ws = await connectRegistered(port, "over-budget");

    // One byte past the configured cap: ws rejects it at the frame-length stage
    // (close 1009, WS_ERR_UNSUPPORTED_MESSAGE_LENGTH) before the message handler's
    // JSON.parse can run, so the handler never fires and the process survives.
    const closeCode = await new Promise<number>((resolve) => {
      ws.on("close", (code: number) => resolve(code));
      ws.on("error", () => {
        // The peer may also see the socket reset as it is torn down; the close
        // event carries the verdict. Swallow so it is not an unhandled error.
      });
      ws.send(Buffer.alloc(MAX_SIGNALING_PAYLOAD_BYTES + 1));
    });

    expect(closeCode).toBe(1009);
    expect(messageEmitted).toBe(false);
    // The server re-emitted the receiver's error (handled, not fatal) rather than
    // aborting; the harness is still alive to serve the next test.
    expect(errors.length).toBeGreaterThan(0);
  });

  test("a legitimate signaling message is parsed and handled unchanged", async () => {
    const { wss, port } = await startHarness();

    const received = new Promise<{
      id: string;
      message: Record<string, unknown>;
    }>((resolve) => {
      wss.on(
        "message",
        (client: { getId: () => string }, message: Record<string, unknown>) => {
          resolve({ id: client.getId(), message });
        },
      );
    });

    const ws = await connectRegistered(port, "normal");
    const offer = { type: "OFFER", dst: "peer-2", payload: "sdp-blob" };
    ws.send(JSON.stringify(offer));

    const { id, message } = await received;
    expect(id).toBe("normal");
    // The handler stamps `src` with the sender's id and leaves the rest intact.
    expect(message).toMatchObject({
      type: "OFFER",
      dst: "peer-2",
      payload: "sdp-blob",
      src: "normal",
    });
  });

  test("a frame at exactly the cap is accepted, pinning the reject boundary to strictly-greater", async () => {
    const { wss, port } = await startHarness();

    const handled = new Promise<Record<string, unknown>>((resolve, reject) => {
      wss.on(
        "message",
        (
          _client: { getId: () => string },
          message: Record<string, unknown>,
        ) => {
          resolve(message);
        },
      );
      // A 1009 close of an at-limit frame would re-emit as a server `error`; that
      // means the cap rejected exactly MAX bytes (an off-by-one the over-cap test,
      // which sends MAX + 1, cannot catch). Fail fast rather than hang to timeout.
      wss.on("error", reject);
    });

    const ws = await connectRegistered(port, "at-limit");
    // A valid-JSON, all-ASCII frame whose byte length is EXACTLY the cap: ASCII
    // means UTF-8 byte length equals string length, so this lands on the boundary
    // ws compares with strictly `>` -- MAX is accepted, MAX + 1 (the over-cap test)
    // is rejected.
    const base = { type: "OFFER", dst: "peer-2", payload: "" };
    const pad = "a".repeat(
      MAX_SIGNALING_PAYLOAD_BYTES - JSON.stringify(base).length,
    );
    const frame = JSON.stringify({ ...base, payload: pad });
    expect(frame.length).toBe(MAX_SIGNALING_PAYLOAD_BYTES);
    ws.send(frame);

    const message = await handled;
    expect(message).toMatchObject({ type: "OFFER", src: "at-limit" });
  });

  test("a custom factory that drops the maxPayload bound fails closed at construction", () => {
    const httpServer = createServer();
    try {
      expect(
        () =>
          new WebSocketServer({
            server: httpServer,
            realm: new Realm(),
            config: {
              path: "/",
              key: KEY,
              concurrent_limit: 5000,
              // A factory that ignores the passed options (their maxPayload),
              // building a server on the ws 100 MiB default -- the silent-bypass
              // the guard must catch.
              createWebSocketServer: (options) =>
                new WsServer({ path: options.path, noServer: true }),
            },
          }),
      ).toThrow(/maxPayload/);
    } finally {
      httpServer.close();
    }
  });
});
