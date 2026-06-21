import { createServer } from "node:http";

import { afterEach, describe, expect, test } from "vitest";
import WebSocket from "ws";

import {
  MAX_HANDSHAKE_PARAM_LENGTH,
  WebSocketServer,
} from "@peerjs-server/services/webSocketServer/index.ts";
import { Errors } from "@peerjs-server/enums.ts";
import { Realm } from "@peerjs-server/models/realm.ts";

import type { AddressInfo } from "node:net";
import type { IRealm } from "@peerjs-server/models/realm.ts";
import type { Server } from "node:http";

// The signaling server's default authentication gate: the well-known PeerJS key,
// id and token being free strings (so this models the unauthenticated client).
const KEY = "peerjs";

interface Harness {
  wss: WebSocketServer;
  httpServer: Server;
  port: number;
  realm: IRealm;
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

function startHarness(): Promise<Harness> {
  const httpServer = createServer();
  const realm = new Realm();
  const wss = new WebSocketServer({
    server: httpServer,
    realm,
    config: { path: "/", key: KEY, concurrent_limit: 5000 },
  });
  // The real wiring attaches an error listener; without one the server's
  // `emit("error")` on a socket error would throw as an unhandled EventEmitter
  // `error`.
  wss.on("error", () => {});
  return new Promise((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => {
      const { port } = httpServer.address() as AddressInfo;
      const h: Harness = { wss, httpServer, port, realm };
      harness = h;
      resolve(h);
    });
  });
}

function paramString(params: {
  id?: string;
  token?: string;
  key?: string;
}): string {
  const id = params.id ?? "peer";
  const token = params.token ?? "tok";
  const key = params.key ?? KEY;
  return `key=${key}&id=${id}&token=${token}`;
}

/** Reject `promise` if it does not settle within `ms`, with a labelled error so
 * a never-arriving event fails with a clear diagnostic rather than blocking to
 * the bare vitest timeout. The timer is cleared once either side settles. */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${label}`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Open an upgrade with the given handshake params and resolve once the server
 * answers OPEN -- the registered path. The signaling path is `/peerjs` (config
 * `path` "/" plus the WS_PATH suffix). */
function connectRegistered(
  port: number,
  params: { id?: string; token?: string; key?: string },
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/peerjs?${paramString(params)}`,
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

/** Open an upgrade with the given handshake params and resolve with the `msg`
 * of the server's ERROR frame -- the refused path. Resolves with `null` if the
 * socket closes without an ERROR frame, so a test fails clearly rather than
 * hanging if the rejection ever stops sending one. */
function connectExpectRejection(
  port: number,
  params: { id?: string; token?: string; key?: string },
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/peerjs?${paramString(params)}`,
    );
    clients.push(ws);
    let errorMsg: string | null = null;
    ws.on("message", (data: WebSocket.RawData) => {
      const frame = JSON.parse(data.toString()) as {
        type?: unknown;
        payload?: { msg?: unknown };
      };
      if (frame.type === "OPEN") {
        reject(new Error("refused handshake unexpectedly registered"));
        return;
      }
      if (frame.type === "ERROR" && typeof frame.payload?.msg === "string") {
        errorMsg = frame.payload.msg;
      }
    });
    // The peer may see the socket reset as the server tears it down; the close
    // event carries the verdict. Swallow so it is not an unhandled error.
    ws.on("error", () => {});
    ws.on("close", () => resolve(errorMsg));
  });
}

describe("signaling-server handshake parameter length bound", () => {
  test("an over-length id is refused before it is registered or used as src", async () => {
    const { port, realm } = await startHarness();
    const longId = "a".repeat(MAX_HANDSHAKE_PARAM_LENGTH + 1);

    const msg = await connectExpectRejection(port, { id: longId });

    expect(msg).toBe(Errors.WS_PARAMETER_TOO_LONG);
    // The id never entered the realm `clients` map.
    expect(realm.getClientById(longId)).toBeUndefined();
    expect(realm.getClientsIds()).toHaveLength(0);
  });

  test("an id at exactly the cap registers, pinning the reject boundary to strictly-greater", async () => {
    const { port, realm } = await startHarness();
    const capId = "a".repeat(MAX_HANDSHAKE_PARAM_LENGTH);

    const ws = await connectRegistered(port, { id: capId });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(realm.getClientById(capId)).toBeDefined();
    // The id is exactly the registered value, never truncated or otherwise
    // altered (acceptance: "the id never exceeds that length anywhere
    // downstream").
    expect(realm.getClientById(capId)?.getId()).toBe(capId);
  });

  test("a UUID-scale id registers and is stamped verbatim onto a relayed frame's src", async () => {
    const { wss, port } = await startHarness();
    // psilink's rendezvous ids are 32 hex chars (deriveRendezvousPeerId); a
    // PeerJS default id is a UUID (~36). Both are far below the cap.
    const id = "0123456789abcdef0123456789abcdef";

    const received = new Promise<{ id: string; src: unknown }>((resolve) => {
      wss.on(
        "message",
        (client: { getId: () => string }, message: { src?: unknown }) => {
          resolve({ id: client.getId(), src: message.src });
        },
      );
    });

    const ws = await connectRegistered(port, { id });
    ws.send(JSON.stringify({ type: "OFFER", dst: "peer-2", payload: "sdp" }));

    const { id: registeredId, src } = await withTimeout(
      received,
      3_000,
      "relayed frame",
    );
    expect(registeredId).toBe(id);
    // The server overwrites `src` with the connecting client's id; the bounded id
    // is what lands on the relayed frame.
    expect(src).toBe(id);
  });

  test("an over-length token is refused at the same chokepoint", async () => {
    const { port, realm } = await startHarness();
    const longToken = "t".repeat(MAX_HANDSHAKE_PARAM_LENGTH + 1);

    const msg = await connectExpectRejection(port, { token: longToken });

    expect(msg).toBe(Errors.WS_PARAMETER_TOO_LONG);
    expect(realm.getClientsIds()).toHaveLength(0);
  });

  test("an over-length key is refused by the length check before the key-match check", async () => {
    const { port } = await startHarness();
    const longKey = "k".repeat(MAX_HANDSHAKE_PARAM_LENGTH + 1);

    const msg = await connectExpectRejection(port, { key: longKey });

    // The length check runs ahead of the `key !== config.key` comparison, so an
    // over-length key surfaces as TOO_LONG rather than INVALID_KEY.
    expect(msg).toBe(Errors.WS_PARAMETER_TOO_LONG);
  });
});
