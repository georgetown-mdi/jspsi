import http from "node:http";
import https from "node:https";
import net from "node:net";
import { randomBytes } from "node:crypto";

import WebSocket, { WebSocketServer as WsServer } from "ws";
import { afterEach, describe, expect, test } from "vitest";

import {
  MAX_HANDSHAKE_PARAM_LENGTH,
  SOCKET_RELEASE_TIMEOUT_MS,
  WebSocketServer,
} from "@psilink/peerjs-broker/services/webSocketServer/index";
import { Errors } from "@psilink/peerjs-broker/enums";
import { Realm } from "@psilink/peerjs-broker/models/realm";

import {
  loopbackTlsCert,
  requireLoopbackTlsCert,
} from "@psilink/testkit/loopbackTlsCert";
import { hardenUpgradeSurface } from "../../server/upgradeHardening";

import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import type { IRealm } from "@psilink/peerjs-broker/models/realm";
import type { ServerResponse } from "node:http";

// Socket-level coverage for the signaling guards that need a live `ws`
// connection: the liveness flag that gates the two-tier reaper, the
// pre-handshake idle timeout's exemption of an established socket, the
// one-socket-per-registered-client invariant a re-attach holds, and the bounded
// release of every socket a refusal or an unhandled upgrade leaves behind,
// alongside a regression check that a normal registration still answers OPEN.
// These drive a real http.Server -- or, where the guard turns on which socket
// object the HTTP layer hands out, an https.Server -- plus `ws` on a loopback
// port, the pattern test/devServer/signalingProbe.ts uses. The per-message size
// cap is covered in signalingPayloadBound.test.ts; the pre-101 handshake timeout
// in signalingUpgradeTimeout.test.ts, which imports no `ws` (see the note there).

/** How many `error` and `close` listeners a socket has. The release
 * window installs one of each, so these counts are where a test sees whether it
 * took them back off. */
interface HandleCounts {
  error: number;
  close: number;
}

function handleCounts(socket: Duplex): HandleCounts {
  return {
    error: socket.listenerCount("error"),
    close: socket.listenerCount("close"),
  };
}

interface CoResidentUpgrade {
  url: string;
  /** Handles on the socket as the upgrade reached the signaling server, before
   * its release window installed any of its own. */
  handlesBeforeWindow: HandleCounts;
  /** Handles once the window is open: the signaling server's `upgrade` listener
   * runs before the co-resident one, so its watch is on by this point. */
  handlesAtWindowOpen: HandleCounts;
  /** Handles once the co-resident listener has adopted it, so the difference
   * from the line above is the adopter's own. */
  handlesAfterAdopt: HandleCounts;
}

/** A response the server has begun and the test finishes when it chooses, so a
 * socket can be held mid-response for as long as a case needs. */
interface StreamingResponse {
  /** How many chunks have reached the socket so far. */
  chunksWritten: () => number;
  /** Stop writing and finish the response, which is what detaches it from the
   * socket it was being written on. */
  finish: () => void;
}

interface Signaling {
  port: number;
  realm: IRealm;
  /** The live `ws` server, whose `clients` set is the authoritative count of
   * sockets the process is still holding open. */
  wss: WebSocketServer;
  /** Every `error` the server re-emitted, collected so it does not throw as an
   * unhandled EventEmitter `error`. */
  errors: Array<Error>;
  /** Every socket the HTTP server accepted. A raw upgrade never becomes a `ws`
   * client, so this is where a test sees whether the process still holds one. */
  accepted: Array<net.Socket>;
  /** Each upgrade the co-resident listener was handed. The signaling server's own
   * `upgrade` listener is registered first and so has already run, which makes an
   * entry here the observable that its release window is open. */
  coResidentUpgrades: Array<CoResidentUpgrade>;
  /** Each streaming response the server has begun, in request order. */
  streamed: Array<StreamingResponse>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function startSignaling(
  opts: {
    preHandshakeIdleMs?: number;
    tls?: boolean;
    concurrentLimit?: number;
    /** Attach a second `upgrade` listener, the shape a shared dev server has
     * (Vite's HMR handler at `/`), that either adopts the upgrades this server
     * leaves it or ignores them. */
    coResidentUpgrade?: "answers" | "ignores";
    /** Answer ordinary (non-upgrade) requests, the other half of a shared
     * server: a connection can then reach the upgrade path with response bytes
     * already written on it, or -- on `STREAMING_PATH` -- with a response of the
     * server's still being written. */
    answerOrdinaryRequests?: boolean;
  } = {},
): Promise<Signaling> {
  const server = opts.tls
    ? https.createServer(requireLoopbackTlsCert())
    : http.createServer();
  if (opts.preHandshakeIdleMs !== undefined) {
    hardenUpgradeSurface(server, {
      preHandshakeIdleMs: opts.preHandshakeIdleMs,
    });
  }
  const streamed: Array<StreamingResponse> = [];
  if (opts.answerOrdinaryRequests) {
    server.on("request", (req, res) => {
      if (req.url === STREAMING_PATH) {
        streamed.push(startStreamingResponse(res));
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/plain",
        "Content-Length": String(ORDINARY_RESPONSE_BODY.length),
      });
      res.end(ORDINARY_RESPONSE_BODY);
    });
  }
  // Registered ahead of the signaling server's own `upgrade` listener, so it
  // sees each socket as the server was handed it: the baseline the release
  // window's handles are added to, and the one they have to come back to. Only
  // the co-resident shapes get it -- in the sole-listener shape it would be the
  // second `upgrade` listener and so change the very thing under test.
  let handlesBeforeWindow: HandleCounts = { error: 0, close: 0 };
  if (opts.coResidentUpgrade !== undefined) {
    server.on("upgrade", (_req, socket) => {
      handlesBeforeWindow = handleCounts(socket);
    });
  }

  const realm = new Realm();
  const wss = new WebSocketServer({
    server,
    realm,
    config: {
      path: "/api",
      key: "peerjs",
      concurrent_limit: opts.concurrentLimit ?? 5000,
    },
  });
  // The real wiring (instance.ts) attaches an error listener; without one the
  // server's `emit("error")` on a socket error would throw as unhandled.
  const errors: Array<Error> = [];
  wss.on("error", (error: Error) => errors.push(error));

  const coResidentUpgrades: Array<CoResidentUpgrade> = [];
  if (opts.coResidentUpgrade !== undefined) {
    const adopter =
      opts.coResidentUpgrade === "answers"
        ? new WsServer({ noServer: true })
        : null;
    server.on("upgrade", (req, socket, head) => {
      // Only the upgrades the signaling server declined are this listener's; an
      // upgrade on the signaling path has already been adopted by it.
      if (req.url?.startsWith("/api/peerjs")) return;
      const handlesAtWindowOpen = handleCounts(socket);
      // An adopter owns the errors of the connection it took, as Vite's HMR
      // handler does, so the adopted socket gets a listener of its own here.
      adopter?.handleUpgrade(req, socket, head, (adopted) => {
        adopted.on("error", () => {});
      });
      coResidentUpgrades.push({
        url: req.url ?? "",
        handlesBeforeWindow,
        handlesAtWindowOpen,
        handlesAfterAdopt: handleCounts(socket),
      });
    });
  }

  const accepted: Array<net.Socket> = [];
  server.on("connection", (socket: net.Socket) => accepted.push(socket));

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
  return { port, realm, wss, errors, accepted, coResidentUpgrades, streamed };
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

interface RawConnection {
  /** Every byte the server has written to this socket, as text. Server-to-client
   * frames are unmasked, so a signaling frame's JSON reads verbatim here. */
  received: () => string;
  /** Write a request on this connection, once it is up. */
  send: (request: string) => void;
  /** Resolves once the server releases the socket. */
  released: Promise<void>;
  /** Hang up with a TCP RST rather than a FIN -- what a peer that is killed, or
   * whose network drops it, leaves the server holding. */
  reset: () => void;
}

/** Open a connection by hand and never answer what comes back -- neither the
 * close frame a refusal sends nor anything else. A `ws` client replies to a close
 * frame and so releases the server's socket for it, which is exactly the
 * cooperation a peer holding sockets on purpose withholds; this is the peer that
 * withholds it. */
function openRawConnection(port: number): RawConnection {
  const socket = net.connect(port, "127.0.0.1");
  const chunks: Array<Buffer> = [];
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  // A released socket may land as a reset; `close` holds the verdict.
  socket.on("error", () => {});
  const released = new Promise<void>((resolve) => {
    socket.once("close", () => resolve());
  });
  cleanups.push(() => {
    socket.destroy();
    return Promise.resolve();
  });
  return {
    received: () => Buffer.concat(chunks).toString("utf8"),
    send: (request: string) => {
      if (socket.connecting) {
        socket.once("connect", () => socket.write(request));
      } else {
        socket.write(request);
      }
    },
    released,
    reset: () => {
      // A peer that hangs up after the server released the socket has nothing
      // left to reset, and says so rather than throwing the test off course.
      if (!socket.destroyed) socket.resetAndDestroy();
    },
  };
}

function upgradeRequest(port: number, target: string): string {
  return [
    `GET ${target} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
    "Sec-WebSocket-Version: 13",
    "",
    "",
  ].join("\r\n");
}

const ORDINARY_RESPONSE_BODY = "an ordinary response";

/** The path whose response is written a chunk at a time until the test finishes
 * it, rather than answered and done. */
const STREAMING_PATH = "/streaming";
const STREAMING_CHUNK_MS = 200;

/** An ordinary keep-alive GET: answering it leaves the connection open with
 * response bytes already written on it. */
function ordinaryRequest(port: number, target: string): string {
  return [
    `GET ${target} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    "Connection: keep-alive",
    "",
    "",
  ].join("\r\n");
}

/** Begin a response that keeps writing until the caller finishes it, so the
 * socket stays assigned to it -- the state a handler that takes its time, or a
 * long-lived event stream, leaves a connection in. */
function startStreamingResponse(res: ServerResponse): StreamingResponse {
  res.writeHead(200, { "Content-Type": "text/plain" });
  let chunksWritten = 0;
  const timer = setInterval(() => {
    chunksWritten += 1;
    res.write(`chunk ${chunksWritten}\n`);
  }, STREAMING_CHUNK_MS);
  const stop = (): void => {
    clearInterval(timer);
  };
  res.on("close", stop);
  cleanups.push(() => {
    stop();
    return Promise.resolve();
  });
  return {
    chunksWritten: () => chunksWritten,
    finish: () => {
      stop();
      res.end();
    },
  };
}

function openRawUpgrade(port: number, target: string): RawConnection {
  const connection = openRawConnection(port);
  connection.send(upgradeRequest(port, target));
  return connection;
}

/** Whether `promise` settles within `ms` -- a released socket answers `true`, a
 * retained one `false`, either way without blocking to the vitest timeout. */
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

  test.skipIf(loopbackTlsCert === null)(
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

// A release the peer declines to cooperate with must still happen on the bound,
// so every case below drives a raw socket that answers nothing. Waiting a
// multiple of the bound keeps the check accurate on a slow runner while staying far
// under the `ws` close timer (30 seconds) a missing release would fall back to,
// which is the failure these pin.
const RELEASE_MARGIN_MS = SOCKET_RELEASE_TIMEOUT_MS * 3;

const refusalCases: Array<{
  name: string;
  concurrentLimit?: number;
  prepare?: (sig: Signaling) => Promise<void>;
  query: string;
  refusal: string;
}> = [
  {
    name: "a handshake missing its token",
    query: "?key=peerjs&id=peer-refused",
    refusal: Errors.INVALID_WS_PARAMETERS,
  },
  {
    name: "an over-length handshake parameter",
    query: `?key=peerjs&id=${"a".repeat(MAX_HANDSHAKE_PARAM_LENGTH + 1)}&token=tok`,
    refusal: Errors.WS_PARAMETER_TOO_LONG,
  },
  {
    name: "a wrong realm key",
    query: "?key=not-the-key&id=peer-refused&token=tok",
    refusal: Errors.INVALID_KEY,
  },
  {
    name: "an id already claimed under another token",
    prepare: async (sig) => {
      const holder = new WebSocket(signalingUrl(sig.port, "peer-claimed"));
      cleanups.push(() => {
        holder.terminate();
        return Promise.resolve();
      });
      await waitForFrame(holder, "OPEN");
    },
    query: "?key=peerjs&id=peer-claimed&token=a-different-token",
    refusal: "ID is taken",
  },
  {
    name: "a registration past the concurrent limit",
    concurrentLimit: 0,
    query: "?key=peerjs&id=peer-refused&token=tok",
    refusal: Errors.CONNECTION_LIMIT_EXCEED,
  },
];

describe("signaling socket release", () => {
  test.each(refusalCases)(
    "$name is told why it was refused and its socket released",
    async ({ concurrentLimit, prepare, query, refusal }) => {
      const sig = await startSignaling({ concurrentLimit });
      await prepare?.(sig);
      // Whatever the case's setup legitimately holds -- the registered client an
      // id-claim refusal needs -- is what the count must fall back to.
      const heldBefore = sig.wss.socketServer.clients.size;

      const peer = openRawUpgrade(sig.port, `/api/peerjs${query}`);

      expect(await settlesWithin(peer.released, RELEASE_MARGIN_MS)).toBe(true);
      // The buffer holds only what arrived before the release, so finding the
      // refusal in it is the ordering assertion as well: a peer that is cut
      // before its frame is written never learns why it was refused.
      expect(peer.received()).toContain(refusal);
      await waitFor(() => sig.wss.socketServer.clients.size === heldBefore);
      expect(sig.errors).toEqual([]);
    },
    15_000,
  );

  test("an upgrade on another path is released at once when nothing else can answer", async () => {
    // The sole-listener shape, which is the production one: no co-resident
    // listener exists, so nothing else will ever answer this socket.
    const sig = await startSignaling();

    const peer = openRawUpgrade(sig.port, "/not-the-signaling-path");

    expect(await settlesWithin(peer.released, RELEASE_MARGIN_MS)).toBe(true);
    // Releasing what nobody else could have answered is the expected shape, not
    // an assumption that broke.
    expect(sig.errors).toEqual([]);
  }, 15_000);

  test("an upgrade left to a co-resident listener that answers it is not taken back", async () => {
    // The assumption the branch rests on, holding: the co-resident listener adopts
    // the upgrade, and the socket it now owns must survive the release bound --
    // cutting it is the dev-server HMR teardown the `noServer` wiring exists to
    // avoid.
    const sig = await startSignaling({ coResidentUpgrade: "answers" });

    const peer = openRawUpgrade(sig.port, "/not-the-signaling-path");
    await waitFor(() => peer.received().includes("101 Switching Protocols"));

    expect(
      await settlesWithin(peer.released, SOCKET_RELEASE_TIMEOUT_MS * 2),
    ).toBe(false);
    expect(sig.errors).toEqual([]);
  }, 15_000);

  test("an adopted socket is left holding none of the release window's handles", async () => {
    // The hand-off has to be clean as well as survivable: a watch or a close
    // handler of this server's still attached to a socket it no longer owns is
    // bookkeeping running against an adopter's connection for as long as that
    // connection lives.
    const sig = await startSignaling({ coResidentUpgrade: "answers" });

    const peer = openRawUpgrade(sig.port, "/not-the-signaling-path");
    await waitFor(() => peer.received().includes("101 Switching Protocols"));
    await waitFor(() => sig.coResidentUpgrades.length > 0);
    const [upgrade] = sig.coResidentUpgrades;

    // The window really does install a watch and a close handler, so the check
    // below is not passing on a window that installed nothing.
    expect(upgrade.handlesAtWindowOpen).toEqual({
      error: upgrade.handlesBeforeWindow.error + 1,
      close: upgrade.handlesBeforeWindow.close + 1,
    });

    // Past the bound, which is where the hand-off concludes: what the socket
    // has is the baseline plus the adopter's own handles, and nothing else.
    await new Promise((resolve) => setTimeout(resolve, RELEASE_MARGIN_MS));
    expect(sig.accepted[0].destroyed).toBe(false);
    expect(handleCounts(sig.accepted[0])).toEqual({
      error:
        upgrade.handlesBeforeWindow.error +
        (upgrade.handlesAfterAdopt.error - upgrade.handlesAtWindowOpen.error),
      close:
        upgrade.handlesBeforeWindow.close +
        (upgrade.handlesAfterAdopt.close - upgrade.handlesAtWindowOpen.close),
    });
    expect(sig.errors).toEqual([]);
  }, 15_000);

  test("an upgrade left to a co-resident listener that ignores it is released on the bound", async () => {
    // The same assumption, broken: a second `upgrade` listener exists, so the
    // sole-listener release does not apply, but nothing answers the socket. It is
    // reclaimed on the bound rather than held on an assumption that no longer holds.
    const sig = await startSignaling({ coResidentUpgrade: "ignores" });

    const peer = openRawUpgrade(sig.port, "/not-the-signaling-path");

    expect(await settlesWithin(peer.released, RELEASE_MARGIN_MS)).toBe(true);
    expect(peer.received()).toBe("");
    expect(sig.errors).toHaveLength(1);
    expect(sig.errors[0].message).toContain("no co-resident listener answered");
    // The release takes the window's handles with it: nothing of this server's
    // outlives the socket it was watching. Polled rather than read once --
    // `destroy()` flips `destroyed` immediately, while the `close` the teardown
    // hangs on waits for the handle to come fully down an event-loop turn or
    // more later -- and polling the counts themselves keeps the failure clear.
    await expect
      .poll(() => handleCounts(sig.accepted[0]), { timeout: RELEASE_MARGIN_MS })
      .toEqual(sig.coResidentUpgrades[0].handlesBeforeWindow);
  }, 15_000);

  test("an upgrade declined on a connection an ordinary request was answered on is still released", async () => {
    // Adoption is movement in the socket's write counter during the window, not
    // a non-zero counter: HTTP keep-alive lets an upgrade arrive on a connection
    // this server has already written a response on, and reading those earlier
    // bytes as this upgrade's answer would leave the socket held past the bound
    // with its watch taken off -- the leak this release exists to close, and an
    // unwatched socket for the peer to reset the process out from under.
    const sig = await startSignaling({
      coResidentUpgrade: "ignores",
      answerOrdinaryRequests: true,
    });

    const peer = openRawConnection(sig.port);
    peer.send(ordinaryRequest(sig.port, "/ordinary"));
    await waitFor(() => peer.received().includes(ORDINARY_RESPONSE_BODY));
    peer.send(upgradeRequest(sig.port, "/not-the-signaling-path"));
    await waitFor(() => sig.coResidentUpgrades.length > 0);

    const releasedOnBound = await settlesWithin(
      peer.released,
      RELEASE_MARGIN_MS,
    );
    // Hang up hard whether or not the release happened, so a socket wrongly left
    // open is left holding the reset that ends the process rather than being
    // reported as a failed assertion the process never reaches.
    peer.reset();
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(releasedOnBound).toBe(true);
    expect(sig.accepted).toHaveLength(1);
    expect(sig.accepted[0].destroyed).toBe(true);
    expect(sig.errors).toHaveLength(1);
    expect(sig.errors[0].message).toContain("no co-resident listener answered");

    // The process is not merely alive but still brokering.
    const ws = new WebSocket(signalingUrl(sig.port, "peer-after-reused"));
    await waitForFrame(ws, "OPEN");
    ws.close();
  }, 15_000);

  test("an upgrade pipelined behind a response still writing is released once that response ends", async () => {
    // Node emits `upgrade` as soon as its parser sees one, so a client that
    // pipelines an upgrade behind a request in a single write reaches this
    // server's decline while the response ahead of it is still being written --
    // on the very socket the release window is now watching. Those bytes are
    // this server's own; counting them as the upgrade's answer concludes an
    // adoption that never happened, which leaves the socket held past the bound
    // with the watch taken off it and a reset from the peer ending the process.
    const sig = await startSignaling({
      coResidentUpgrade: "ignores",
      answerOrdinaryRequests: true,
    });

    const peer = openRawConnection(sig.port);
    // One write holding both, so the upgrade is parsed before the response to
    // the request ahead of it has written a byte.
    peer.send(
      ordinaryRequest(sig.port, STREAMING_PATH) +
        upgradeRequest(sig.port, "/not-the-signaling-path"),
    );
    await waitFor(() => sig.coResidentUpgrades.length > 0);
    await waitFor(() => sig.streamed.length > 0);
    await waitFor(() => sig.streamed[0].chunksWritten() > 0);

    // Past the bound with the response still writing: the socket is this
    // server's own to write on rather than nobody's, so the window has not
    // concluded anything about it and its watch is still in place -- which is
    // what keeps the reset below from ending the process.
    await new Promise((resolve) =>
      setTimeout(resolve, SOCKET_RELEASE_TIMEOUT_MS * 2),
    );
    const heldMidResponse = {
      destroyed: sig.accepted[0].destroyed,
      handles: handleCounts(sig.accepted[0]),
    };

    // The response ends, and with it the stretch the window had to sit out. The
    // socket is nobody's from here, and nobody answers it.
    sig.streamed[0].finish();
    const releasedAfterResponse = await settlesWithin(
      peer.released,
      RELEASE_MARGIN_MS,
    );
    // Hang up hard whether or not the release happened, so a socket wrongly left
    // open is left holding the reset that ends the process rather than being
    // reported as a failed assertion the process never reaches.
    peer.reset();
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(heldMidResponse).toEqual({
      destroyed: false,
      handles: sig.coResidentUpgrades[0].handlesAtWindowOpen,
    });
    expect(releasedAfterResponse).toBe(true);
    expect(sig.accepted).toHaveLength(1);
    expect(sig.accepted[0].destroyed).toBe(true);
    expect(sig.errors).toHaveLength(1);
    expect(sig.errors[0].message).toContain("no co-resident listener answered");

    // The process is not merely alive but still brokering.
    const ws = new WebSocket(signalingUrl(sig.port, "peer-after-pipelined"));
    await waitForFrame(ws, "OPEN");
    ws.close();
  }, 20_000);

  test("a peer that resets inside the co-resident window is released, not crashed on", async () => {
    // The window is the one stretch where the socket has no owner: this server
    // has declined it and the co-resident listener has not taken it. A raw socket
    // held there with no `error` listener turns an ordinary hang-up -- a peer
    // killed, or a network that drops it -- into an unhandled `error` that ends
    // the process, taking rendezvous down for every peer over an upgrade this
    // server was never going to serve.
    const sig = await startSignaling({ coResidentUpgrade: "ignores" });

    const peer = openRawUpgrade(sig.port, "/not-the-signaling-path");
    // Reset only once the co-resident listener has been handed the upgrade. The
    // signaling server's listener runs before it, so that hand-off is the window
    // opening; an RST any earlier can reach the server with the request itself
    // still unread, which never opens the window at all.
    await waitFor(() => sig.coResidentUpgrades.length > 0);
    peer.reset();

    await waitFor(() => sig.errors.length > 0);
    expect(sig.errors).toHaveLength(1);
    expect(sig.errors[0].message).toContain("ECONNRESET");
    // Handling the error released the socket: the server holds nothing open.
    expect(sig.accepted).toHaveLength(1);
    expect(sig.accepted[0].destroyed).toBe(true);
    // And the window's own handles went with it, on this path as on the others.
    await expect
      .poll(() => handleCounts(sig.accepted[0]), { timeout: RELEASE_MARGIN_MS })
      .toEqual(sig.coResidentUpgrades[0].handlesBeforeWindow);

    // That release is also the whole of it, so the bound behind it finds nothing
    // left to reclaim and does not go on to accuse a peer that hung up of leaving
    // an upgrade unanswered.
    await new Promise((resolve) =>
      setTimeout(resolve, SOCKET_RELEASE_TIMEOUT_MS * 2),
    );
    expect(sig.errors).toHaveLength(1);

    // The process is not merely alive but still brokering.
    const ws = new WebSocket(signalingUrl(sig.port, "peer-after-reset"));
    await waitForFrame(ws, "OPEN");
    ws.close();
  }, 15_000);

  test("a peer that resets after adoption but before the bound is released and reported by this server", async () => {
    // The watch comes off at the bound rather than at the adopter's answer, so
    // between the two -- most of a second, an adopter answering in the same tick
    // as the decline -- a socket someone else already owns still holds it.
    // What the watch does in that stretch is what this pins: the socket is
    // released and the error raised here rather than left to the adopter. The
    // report is what attributes the release, an adopter having reasons of its
    // own to destroy a socket that just reset but no way to raise one here.
    const sig = await startSignaling({ coResidentUpgrade: "answers" });

    const peer = openRawUpgrade(sig.port, "/not-the-signaling-path");
    await waitFor(() => peer.received().includes("101 Switching Protocols"));
    await waitFor(() => sig.coResidentUpgrades.length > 0);
    // Adopted, and the bound a whole second off: the reset lands in the stretch.
    peer.reset();

    await waitFor(() => sig.errors.length > 0);
    expect(sig.errors).toHaveLength(1);
    expect(sig.errors[0].message).toContain("ECONNRESET");
    expect(sig.accepted).toHaveLength(1);
    expect(sig.accepted[0].destroyed).toBe(true);

    // Past the bound: the release the watch already performed is the whole of
    // it, so nothing is reclaimed a second time and an adopted socket is not
    // accused of leaving an upgrade unanswered.
    await new Promise((resolve) =>
      setTimeout(resolve, SOCKET_RELEASE_TIMEOUT_MS * 2),
    );
    expect(sig.errors).toHaveLength(1);

    // The process is not merely alive but still brokering.
    const ws = new WebSocket(
      signalingUrl(sig.port, "peer-after-adopted-reset"),
    );
    await waitForFrame(ws, "OPEN");
    ws.close();
  }, 15_000);
});
