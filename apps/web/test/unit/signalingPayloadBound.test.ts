import { createServer } from "node:http";

import { afterEach, describe, expect, test } from "vitest";
import { WebSocketServer as WsServer } from "ws";

import {
  MAX_SIGNALING_PAYLOAD_BYTES,
  WebSocketServer,
} from "@peerjs-server/services/webSocketServer/index.ts";
import { Realm } from "@peerjs-server/models/realm.ts";

import {
  KEY,
  connectRegistered,
  createSignalingHarness,
} from "../utils/signalingHarness.ts";

const { start: startHarness, clients } = createSignalingHarness(afterEach);

describe("signaling-server inbound frame bound", () => {
  test("an over-budget frame is rejected by ws before it reaches the parser, without crashing the server", async () => {
    const { wss, port, errors } = await startHarness();

    let messageEmitted = false;
    wss.on("message", () => {
      messageEmitted = true;
    });

    const ws = await connectRegistered(port, clients, { id: "over-budget" });

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

    const ws = await connectRegistered(port, clients, { id: "normal" });
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

    const ws = await connectRegistered(port, clients, { id: "at-limit" });
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
