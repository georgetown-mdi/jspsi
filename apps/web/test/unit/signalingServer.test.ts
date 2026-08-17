import http from "node:http";
import https from "node:https";

import { afterEach, describe, expect, test } from "vitest";
import WebSocket from "ws";

import { Realm } from "@peerjs-server/models/realm";
import { WebSocketServer } from "@peerjs-server/services/webSocketServer/index";
import { createLoopbackTlsCert } from "../utils/loopbackTlsCert";
import { hardenUpgradeSurface } from "../../server/upgradeHardening";

import type { AddressInfo } from "node:net";
import type { IRealm } from "@peerjs-server/models/realm";

// Socket-level coverage for the signaling guards that need a live `ws`
// connection: the liveness flag that gates the two-tier reaper, the
// pre-handshake idle timeout's exemption of an established socket, and the
// one-socket-per-registered-client invariant a re-attach holds, alongside a
// regression check that a normal registration still answers OPEN. These drive a
// real http.Server -- or, where the guard turns on which socket object the HTTP
// layer hands out, an https.Server -- plus `ws` on a loopback port, the pattern
// test/devServer/signalingProbe.ts uses. The per-message size cap is covered in
// signalingPayloadBound.test.ts; the pre-101 handshake timeout in
// signalingUpgradeTimeout.test.ts, which imports no `ws` (see the note there).

interface Signaling {
  port: number;
  realm: IRealm;
  /** The live `ws` server, whose `clients` set is the authoritative count of
   * sockets the process is still holding open. */
  wss: WebSocketServer;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function startSignaling(
  opts: { preHandshakeIdleMs?: number; tls?: boolean } = {},
): Promise<Signaling> {
  const server = opts.tls
    ? https.createServer(createLoopbackTlsCert())
    : http.createServer();
  if (opts.preHandshakeIdleMs !== undefined) {
    hardenUpgradeSurface(server, {
      preHandshakeIdleMs: opts.preHandshakeIdleMs,
    });
  }
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
    () =>
      new Promise<void>((resolve) => {
        // Force-close any still-open (upgraded) connections so close() resolves
        // promptly even when a test failed before closing its own `ws` -- an
        // upgraded socket would otherwise keep the server alive and hang teardown.
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { port, realm, wss };
}

function signalingUrl(port: number, id: string, secure = false): string {
  return (
    `${secure ? "wss" : "ws"}://127.0.0.1:${port}/api/peerjs` +
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
    const settle = (action: () => void) => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("error", onError);
      action();
    };
    const onMessage = (data: WebSocket.RawData) => {
      let frameType: unknown;
      try {
        frameType = (JSON.parse(data.toString()) as { type?: unknown }).type;
      } catch {
        return;
      }
      if (frameType === type) settle(resolve);
    };
    const onError = () =>
      settle(() => reject(new Error("socket error before frame")));
    const timer = setTimeout(
      () =>
        settle(() =>
          reject(new Error(`no ${type} frame within ${timeoutMs}ms`)),
        ),
      timeoutMs,
    );
    ws.on("message", onMessage);
    ws.on("error", onError);
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

  test("an established connection is not cut by the pre-handshake idle timeout", async () => {
    // Harden with a short pre-handshake idle bound, then prove an upgraded socket
    // that stays silent past it survives: `ws` resets the socket timeout to 0 on
    // the 101, handing liveness back to the reaper. If `ws` stopped doing that,
    // this fails rather than silently tearing down idle established peers.
    const sig = await startSignaling({ preHandshakeIdleMs: 500 });
    const ws = new WebSocket(signalingUrl(sig.port, "peer-quiet"));
    await waitForFrame(ws, "OPEN");
    // Stay completely silent well past the 500ms pre-handshake bound.
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  test.skipIf(process.platform === "win32")(
    "an established TLS connection is not cut by the pre-handshake idle timeout",
    async () => {
      // Over TLS the socket `ws` releases on the 101 is the TLSSocket, not the
      // accepted socket the bound was armed on, so a bound that stayed behind on
      // the latter would reap this peer part-way through an exchange -- silently,
      // and only on a deployment terminating TLS in the app.
      const sig = await startSignaling({ preHandshakeIdleMs: 500, tls: true });
      const ws = new WebSocket(signalingUrl(sig.port, "peer-quiet-tls", true), {
        rejectUnauthorized: false,
      });
      await waitForFrame(ws, "OPEN");
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    },
  );

  test("re-attaching under one id and token holds one socket, not one per attach", async () => {
    // Repeated attaches under the same credentials all resolve to the one client
    // and so cost one realm slot; the sockets they arrive on must not pile up
    // behind that single slot. `socketServer.clients` is the process's own count
    // of sockets it is still holding, which is what has to stay flat.
    const sig = await startSignaling();
    const sockets: Array<WebSocket> = [];
    const attachCount = 8;

    for (let attach = 0; attach < attachCount; attach += 1) {
      const ws = new WebSocket(signalingUrl(sig.port, "peer-reattach"));
      sockets.push(ws);
      if (attach === 0) {
        await waitForFrame(ws, "OPEN");
      } else {
        // Only the first attach registers and answers OPEN; a later one attaches
        // to the existing client, so wait on the observable consequence instead.
        const detached = sockets[attach - 1];
        await waitFor(() => detached.readyState === WebSocket.CLOSED);
      }
      // The registration survives each re-attach: a detached socket closing must
      // not take the client it no longer belongs to out of the realm.
      expect(sig.realm.getClientById("peer-reattach")).toBeDefined();
    }

    await waitFor(() => sig.wss.socketServer.clients.size === 1);
    expect(sig.realm.getClientsIds()).toEqual(["peer-reattach"]);
    for (const [index, ws] of sockets.entries()) {
      const expected =
        index === attachCount - 1 ? WebSocket.OPEN : WebSocket.CLOSED;
      expect(ws.readyState).toBe(expected);
    }
    // The one socket the process still holds is the one the client points at, so
    // every in-application close path can reach it.
    expect(
      sig.realm.getClientById("peer-reattach")?.getSocket(),
    ).not.toBeNull();

    sockets[attachCount - 1].close();
  });

  test("a detached socket stops being relayed as its client", async () => {
    // A socket the client no longer points at must not go on speaking for it:
    // the server stamps every relayed frame with the client's id, so a detached
    // socket left readable would keep authoring frames as that peer.
    const sig = await startSignaling();
    const relayed: Array<unknown> = [];
    sig.wss.on("message", (_client: unknown, message: { dst?: unknown }) =>
      relayed.push(message.dst),
    );

    const first = new WebSocket(signalingUrl(sig.port, "peer-detach"));
    first.on("error", () => {});
    await waitForFrame(first, "OPEN");
    const second = new WebSocket(signalingUrl(sig.port, "peer-detach"));
    await waitFor(() => first.readyState === WebSocket.CLOSED);

    // Whatever `ws` does with a write to a closed socket, nothing may reach the
    // relay from it -- the frame below is sent first, so it would sort ahead of
    // the attached socket's if it ever landed.
    first.send(JSON.stringify({ type: "OFFER", dst: "detached" }), () => {});

    second.send(JSON.stringify({ type: "OFFER", dst: "attached" }));
    await waitFor(() => relayed.length > 0);
    expect(relayed).toEqual(["attached"]);

    second.close();
  });
});
