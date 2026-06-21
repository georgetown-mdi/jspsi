import http from "node:http";

import { afterEach, describe, expect, test } from "vitest";
import WebSocket from "ws";

import { Realm } from "@peerjs-server/models/realm";
import { WebSocketServer } from "@peerjs-server/services/webSocketServer/index";

import type { AddressInfo } from "node:net";
import type { IRealm } from "@peerjs-server/models/realm";

// Socket-level coverage for the signaling guards that need a live `ws`
// connection: the per-message size cap and the liveness flag that gates the
// two-tier reaper, alongside a regression check that a normal registration still
// answers OPEN. These drive a real http.Server + `ws` on a loopback port, the
// same pattern test/devServer/signalingProbe.ts uses. The pre-101 handshake
// timeout is covered separately in signalingUpgradeTimeout.test.ts, which imports
// no `ws` (see the note there).

const MAX_MESSAGE_BYTES = 64 * 1024;

interface Signaling {
  port: number;
  realm: IRealm;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function startSignaling(): Promise<Signaling> {
  const server = http.createServer();
  const realm = new Realm();
  const wss = new WebSocketServer({
    server,
    realm,
    config: { path: "/api", key: "peerjs", concurrent_limit: 5000 },
  });
  // The real wiring (instance.ts) attaches an error listener; without one the
  // server's `emit("error")` on a socket error would throw as unhandled.
  wss.on("error", () => {});

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  cleanups.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  return { port, realm };
}

function signalingUrl(port: number, id: string): string {
  return (
    `ws://127.0.0.1:${port}/api/peerjs` +
    `?key=peerjs&id=${id}&token=tok&version=1.5.5`
  );
}

/** Resolve once a frame of the given `type` arrives, reject on timeout/error. */
function waitForFrame(
  ws: WebSocket,
  type: string,
  timeoutMs = 3_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no ${type} frame within ${timeoutMs}ms`)),
      timeoutMs,
    );
    ws.on("message", (data: WebSocket.RawData) => {
      let frameType: unknown;
      try {
        frameType = (JSON.parse(data.toString()) as { type?: unknown }).type;
      } catch {
        return;
      }
      if (frameType === type) {
        clearTimeout(timer);
        resolve();
      }
    });
    ws.on("error", () => {
      clearTimeout(timer);
      reject(new Error("socket error before frame"));
    });
  });
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("signaling socket guards", () => {
  test("a normal registration completes and answers OPEN", async () => {
    const sig = await startSignaling();
    const ws = new WebSocket(signalingUrl(sig.port, "peer-open"));
    await waitForFrame(ws, "OPEN");
    expect(sig.realm.getClientById("peer-open")).toBeDefined();
    ws.close();
  });

  test("a registered client is confirmed only after it sends a frame", async () => {
    const sig = await startSignaling();
    const ws = new WebSocket(signalingUrl(sig.port, "peer-live"));
    await waitForFrame(ws, "OPEN");

    // Registered but silent so far: unconfirmed, so the reaper holds it to the
    // short window.
    expect(sig.realm.getClientById("peer-live")?.isConfirmed()).toBe(false);

    // Any inbound frame graduates it to the generous alive_timeout.
    ws.send(JSON.stringify({ type: "HEARTBEAT" }));
    await waitFor(
      () => sig.realm.getClientById("peer-live")?.isConfirmed() === true,
    );
    expect(sig.realm.getClientById("peer-live")?.isConfirmed()).toBe(true);
    ws.close();
  });

  test("an inbound frame larger than the cap closes the connection", async () => {
    const sig = await startSignaling();
    const ws = new WebSocket(signalingUrl(sig.port, "peer-big"));
    await waitForFrame(ws, "OPEN");

    const closeCode = await new Promise<number>((resolve) => {
      ws.on("close", (code) => resolve(code));
      ws.send("x".repeat(MAX_MESSAGE_BYTES + 1));
    });
    // 1009 = message too big.
    expect(closeCode).toBe(1009);
  });
});
