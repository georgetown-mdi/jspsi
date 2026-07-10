import { createServer } from "node:http";

import WebSocket from "ws";

import { Realm } from "@peerjs-server/models/realm.ts";
import { WebSocketServer } from "@peerjs-server/services/webSocketServer/index.ts";

import type { AddressInfo } from "node:net";
import type { IRealm } from "@peerjs-server/models/realm.ts";
import type { Server } from "node:http";

// The signaling server's default authentication gate: the well-known PeerJS key,
// id and token being free strings (so this models the unauthenticated client).
export const KEY = "peerjs";

export interface SignalingHarness {
  wss: WebSocketServer;
  httpServer: Server;
  port: number;
  realm: IRealm;
  /** Every `error` the server re-emitted (an over-cap frame surfaces as one),
   * collected so it does not throw as an unhandled EventEmitter `error`. */
  errors: Array<Error>;
}

export interface SignalingHarnessFixture {
  /** Stand up a fresh loopback WebSocketServer, tracked for teardown. */
  start: () => Promise<SignalingHarness>;
  /** Every socket dialed via {@link connectRegistered}, terminated on teardown. */
  clients: Array<WebSocket>;
}

/** Register the shared `afterEach` that terminates every dialed client and closes
 * the active harness's HTTP server, and return a `start` that stands up the
 * vendored WebSocketServer on a fresh loopback HTTP server (wiring the same
 * `error` handler the real instance does) and records it for that teardown. */
export function createSignalingHarness(
  afterEach: (fn: () => Promise<void>) => void,
): SignalingHarnessFixture {
  let harness: SignalingHarness | undefined;
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
  const start = (): Promise<SignalingHarness> => {
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
        harness = { wss, httpServer, port, realm, errors };
        resolve(harness);
      });
    });
  };
  return { start, clients };
}

export function handshakeParamString(params: {
  id?: string;
  token?: string;
  key?: string;
}): string {
  const id = params.id ?? "peer";
  const token = params.token ?? "tok";
  const key = params.key ?? KEY;
  return `key=${key}&id=${id}&token=${token}`;
}

/** Open an upgrade with the given handshake params and resolve once the server
 * answers OPEN -- the registered path. The signaling path is `/peerjs` (config
 * `path` "/" plus the WS_PATH suffix). Pushes the socket onto `clients` for
 * teardown. */
export function connectRegistered(
  port: number,
  clients: Array<WebSocket>,
  params: { id?: string; token?: string; key?: string },
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/peerjs?${handshakeParamString(params)}`,
    );
    clients.push(ws);
    // Remove every listener on the first terminal event so a later close or
    // error -- e.g. the `afterEach` teardown of a successfully-registered socket
    // -- cannot reject an already-resolved promise.
    const cleanup = () => {
      ws.off("message", onMessage);
      ws.off("error", onError);
      ws.off("close", onClose);
    };
    const onMessage = (data: WebSocket.RawData) => {
      const type = (JSON.parse(data.toString()) as { type?: unknown }).type;
      if (type === "OPEN") {
        cleanup();
        resolve(ws);
      }
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("signaling socket closed before OPEN"));
    };
    ws.on("message", onMessage);
    ws.on("error", onError);
    ws.on("close", onClose);
  });
}
