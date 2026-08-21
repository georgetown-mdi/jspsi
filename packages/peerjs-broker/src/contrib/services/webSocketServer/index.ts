import { EventEmitter } from "node:events";
import { Socket } from "node:net";

import { WebSocketServer as Server } from "ws";

import { Errors, MessageType } from "../../enums.ts";

import { Client } from "../../models/client.ts";

import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Server as HttpsServer } from "node:https";
import type { Duplex } from "node:stream";

import type WebSocket from "ws";

import type { IClient } from "../../models/client.ts";
import type { IConfig } from "../../config/index.ts";
import type { IMessage } from "../../models/message.js";
import type { IRealm } from "../../models/realm.ts";

export interface IWebSocketServer extends EventEmitter {
  readonly path: string;
}

type CustomConfig = Pick<
  IConfig,
  "path" | "key" | "concurrent_limit" | "createWebSocketServer"
>;

const WS_PATH = "peerjs";

// Cap inbound WebSocket frames well below the `ws` 100 MiB default. This server
// brokers only small control messages -- SDP OFFER/ANSWER, ICE CANDIDATE,
// HEARTBEAT and the like, all KB-scale; the PSI payload itself flows peer-to-peer
// over the WebRTC data channel and never crosses this socket -- so 256 KiB sits
// far above any legitimate signaling frame yet hundreds of times below both the
// default and the size a single object or array needs to drive JSON.parse into an
// uncatchable, process-terminating V8 abort. `ws` rejects an over-cap frame in the
// receiver (close 1009) before the message handler's JSON.parse can run, so a
// single oversized frame from any unauthenticated client -- this server is
// internet-facing in production, gated only by the well-known default key -- can
// neither crash the broker (taking down rendezvous for every peer) nor pin its
// memory. See docs/spec/CHANNEL_SECURITY.md.
export const MAX_SIGNALING_PAYLOAD_BYTES = 256 * 1024;

// Bound the length of each upgrade-handshake parameter (`id`, `token`, `key`)
// where it enters in `_onSocketConnection`, before the id is stored in the realm
// `clients` map or stamped onto a relayed frame as `message.src`. Without this an
// id is capped only incidentally by Node's ~16 KiB HTTP header-size limit on the
// upgrade URL, not by any application bound -- and the id is the one
// attacker-controlled string the server both retains in the `clients` map and
// writes onto every frame it relays. 256 is generous: psilink's rendezvous ids are
// 32 hex chars (`deriveRendezvousPeerId`) and a PeerJS default id is a UUID (~36),
// so the cap sits ~7x above any legitimate id and refuses no real peer, yet well
// over an order of magnitude below the incidental header limit (~64x).
//
// The `id` bound is the load-bearing one. The relay's per-queue byte cap
// (`MAX_QUEUE_BYTES`, models/realm.ts) sizes a queued frame by the UTF-16 resident
// bytes of its string fields, `src` included, and the server overwrites `src` with
// the connecting client's id (below): an unbounded id therefore lets a single
// near-maximum frame addressed to an absent destination exceed the per-queue byte
// cap on account of `src` alone, breaking the "any single legal frame is always
// holdable" margin that cap's 2x-the-wire-cap sizing rests on. Bounding the id
// holds that `src` contribution to at most 2 * MAX_HANDSHAKE_PARAM_LENGTH (512)
// resident bytes -- a negligible fraction of the 512 KiB queue cap -- so a real,
// KB-scale frame from any accepted id stays holdable. `token` and `key` are bounded
// at the same point for a uniform "no handshake parameter is unbounded" invariant:
// `token` is also retained per-client in the `clients` map (the same standing
// memory surface as the id), while `key` is only compared and never stored.
// See docs/spec/CHANNEL_SECURITY.md.
export const MAX_HANDSHAKE_PARAM_LENGTH = 256;

// Bound every exit that leaves this server holding a socket it will not go on to
// serve: a refusal (a missing or over-length handshake parameter, a wrong key, an
// id claimed under another token, the concurrent limit) and an upgrade on a path
// that is not ours. A refusal sends its error frame and closes, which starts the
// WebSocket close handshake; `ws` releases the socket once the peer answers the
// close frame, or once its own close timer expires -- 30 seconds of retained
// socket per refusal on the pinned `ws`, and a refused peer is precisely the one
// with nothing to negotiate and no reason to answer. One second is far above the
// round trip an answering peer needs, having already been written its error
// frame, and 30x below what `ws` would otherwise hold; it is equally the window a
// co-resident `upgrade` listener gets to answer an upgrade this server left for
// it, which sits far above the same-tick answer one gives, so a socket it adopted
// is never taken back from it. See docs/spec/CHANNEL_SECURITY.md.
export const SOCKET_RELEASE_TIMEOUT_MS = 1_000;

export class WebSocketServer extends EventEmitter implements IWebSocketServer {
  public readonly path: string;
  private readonly realm: IRealm;
  private readonly config: CustomConfig;
  public readonly socketServer: Server;

  constructor({
    server,
    realm,
    config,
  }: {
    server: HttpServer | HttpsServer;
    realm: IRealm;
    config: CustomConfig;
  }) {
    super();

    this.setMaxListeners(0);

    this.realm = realm;
    this.config = config;

    const path = this.config.path;
    this.path = `${path}${path.endsWith("/") ? "" : "/"}${WS_PATH}`;

    // Attach to the shared HTTP server via `noServer` + a path-scoped `upgrade`
    // listener rather than passing `server` to `ws`. Given `{ server, path }`,
    // `ws` installs its own `upgrade` listener that calls `abortHandshake(socket,
    // 400)` on every upgrade whose path does not match -- including Vite's HMR
    // socket at `/`. On the shared dev server that tears HMR down (the socket
    // 101s, then `ws` destroys it) and Vite drops into a reconnect/full-reload
    // loop. Routing upgrades ourselves and ignoring non-matching paths leaves
    // them for the other `upgrade` listeners (Vite's HMR handler).
    const options: WebSocket.ServerOptions = {
      path: this.path,
      noServer: true,
      maxPayload: MAX_SIGNALING_PAYLOAD_BYTES,
    };

    this.socketServer = config.createWebSocketServer
      ? config.createWebSocketServer(options)
      : new Server(options);

    // `createWebSocketServer` is an injection seam: a factory is handed `options`
    // (carrying the maxPayload bound above) but is free to ignore them, which
    // would silently drop the frame-size cap and reopen the DoS. The default
    // `new Server(options)` path always honors it; fail closed at startup rather
    // than trust an injected factory that built a server without the cap.
    if (this.socketServer.options.maxPayload !== MAX_SIGNALING_PAYLOAD_BYTES) {
      throw new Error(
        "PeerJS signaling WebSocket server is missing its required maxPayload bound",
      );
    }

    // This listener lives for the life of `server`, with no teardown -- by
    // design, not omission. The peer server is a per-process singleton
    // (`usePeerServer`) bound to the process-lived dev/Nitro HTTP server, so this
    // WebSocketServer is constructed once and shares the server's lifetime; the
    // socketServer is never closed. There is therefore no reinstantiation that
    // would stack listeners, and no closed socketServer for a stale listener to
    // dispatch to.
    server.on("upgrade", (req, socket, head) => {
      if (!this.socketServer.shouldHandle(req)) {
        this._releaseUnhandledUpgrade(server, socket);
        return;
      }
      // Bail if the socket was already torn down between the event and here;
      // handleUpgrade would otherwise write the handshake to a dead socket.
      if (socket.destroyed) return;
      this.socketServer.handleUpgrade(req, socket, head, (ws) => {
        this.socketServer.emit("connection", ws, req);
      });
    });

    this.socketServer.on("connection", (socket, req) => {
      this._onSocketConnection(socket, req);
    });
    this.socketServer.on("error", (error: Error) => {
      this._onSocketError(error);
    });
  }

  private _onSocketConnection(socket: WebSocket, req: IncomingMessage): void {
    // An unhandled socket error might crash the server. Handle it first.
    socket.on("error", (error) => {
      this._onSocketError(error);
    });

    // We are only interested in the query, the base url is therefore not relevant
    const { searchParams } = new URL(req.url ?? "", "https://peerjs");
    const { id, token, key } = Object.fromEntries(searchParams.entries());

    if (!id || !token || !key) {
      this._sendErrorAndRelease(socket, Errors.INVALID_WS_PARAMETERS);
      return;
    }

    if (
      id.length > MAX_HANDSHAKE_PARAM_LENGTH ||
      token.length > MAX_HANDSHAKE_PARAM_LENGTH ||
      key.length > MAX_HANDSHAKE_PARAM_LENGTH
    ) {
      this._sendErrorAndRelease(socket, Errors.WS_PARAMETER_TOO_LONG);
      return;
    }

    if (key !== this.config.key) {
      this._sendErrorAndRelease(socket, Errors.INVALID_KEY);
      return;
    }

    const client = this.realm.getClientById(id);

    if (client) {
      if (token !== client.getToken()) {
        // ID-taken, invalid token
        this._sendAndRelease(socket, MessageType.ID_TAKEN, "ID is taken");
        return;
      }

      this._configureWS(socket, client);
      return;
    }

    this._registerClient({ socket, id, token });
  }

  private _onSocketError(error: Error): void {
    // handle error
    this.emit("error", error);
  }

  // Release an upgrade on a path that is not ours (shouldHandle() applies the
  // `path` option above). Node stops auto-destroying an unhandled upgrade the
  // moment any `upgrade` listener exists, so every socket this branch declines
  // must be released by someone or it is leaked -- the production connection
  // idle-timeout is at best a far coarser backstop. When this is the sole
  // `upgrade` listener, nothing else can answer and the socket is destroyed at
  // once. Where a co-resident listener exists -- Vite HMR at `/` in dev -- the
  // socket is left for it, and whether it answered is then TESTED rather than
  // assumed: a socket still carrying no response bytes when the release bound
  // expires was answered by nobody, so it is destroyed and the broken premise
  // raised as an error rather than leaked on a premise that no longer holds.
  private _releaseUnhandledUpgrade(
    server: HttpServer | HttpsServer,
    socket: Duplex,
  ): void {
    if (socket.destroyed) return;

    if (server.listenerCount("upgrade") === 1) {
      socket.destroy();
      return;
    }

    // The window below is the one stretch in which this socket is nobody's:
    // declined here, not yet taken by a co-resident listener, and so carrying no
    // `error` listener of anyone's. A raw socket that emits `error` with none
    // attached terminates the process, and a peer needs nothing more exotic than
    // a reset -- being killed, or dropped by its network -- to emit one. So it is
    // watched for exactly the window and no longer: an error inside it destroys
    // the socket, which is that socket's release, leaving the bound behind it
    // nothing to reclaim and no unanswered upgrade to report against a peer that
    // merely hung up; an error after a co-resident listener has answered belongs
    // to the listener that adopted it, along with the socket.
    const releaseOnError = (error: Error): void => {
      socket.destroy();
      this._onSocketError(error);
    };
    socket.on("error", releaseOnError);

    const release = setTimeout(() => {
      if (socket.destroyed) return;
      if (socket instanceof Socket && socket.bytesWritten > 0) {
        // Answered: the socket is its adopter's now, errors with it.
        socket.off("error", releaseOnError);
        return;
      }

      socket.destroy();
      this._onSocketError(
        new Error(
          "PeerJS signaling server released an upgrade no co-resident listener answered",
        ),
      );
    }, SOCKET_RELEASE_TIMEOUT_MS);
    release.unref();

    socket.once("close", () => {
      clearTimeout(release);
      socket.off("error", releaseOnError);
    });
  }

  private _registerClient({
    socket,
    id,
    token,
  }: {
    socket: WebSocket;
    id: string;
    token: string;
  }): void {
    // Check concurrent limit
    const clientsCount = this.realm.getClientsIds().length;

    if (clientsCount >= this.config.concurrent_limit) {
      this._sendErrorAndRelease(socket, Errors.CONNECTION_LIMIT_EXCEED);
      return;
    }

    const newClient: IClient = new Client({ id, token });
    this.realm.setClient(newClient, id);
    socket.send(JSON.stringify({ type: MessageType.OPEN }));

    this._configureWS(socket, newClient);
  }

  private _configureWS(socket: WebSocket, client: IClient): void {
    // A client holds exactly one socket, so attaching this one detaches whatever
    // was there. Every in-application close path -- the liveness reaper, the
    // `close` handler installed below -- acts on `client.getSocket()`, which
    // makes the attach the one place that can retire the socket it replaces, and
    // holds the realm slot this client occupies to one socket however many
    // attaches have passed through it.
    const detachedSocket = client.getSocket();

    client.setSocket(socket);
    // Each newly attached socket starts an unconfirmed session: its first inbound
    // frame re-confirms liveness. This matters on the reconnect path, where
    // `client` is reused and would otherwise carry a prior session's confirmed
    // state -- skipping the short unconfirmed window -- into the new socket.
    client.resetLiveness();

    // Terminate rather than close: `close()` sends a close frame and waits for
    // the peer's reply before the socket is released, so a peer that never
    // answers holds it until `ws` gives up on its own close timer -- 30 seconds
    // of retained socket per detach. The detached socket is being replaced by the
    // same peer's newer one, so there is nothing to negotiate. Ordered after
    // setSocket so the detached socket's own `close` handler sees a client that
    // has moved on and leaves the registration alone.
    if (detachedSocket && detachedSocket !== socket) {
      detachedSocket.terminate();
    }

    // Cleanup after a socket closes.
    socket.on("close", () => {
      if (client.getSocket() === socket) {
        this.realm.removeClientById(client.getId());
        this.emit("close", client);
      }
    });

    // Handle messages from peers.
    socket.on("message", (data) => {
      // Any inbound frame proves the client is a real, talking peer rather than a
      // socket that registered and went silent, so it graduates from the short
      // unconfirmed reap window to the generous alive_timeout and refreshes the
      // liveness clock (see Client.confirm and the reaper in
      // checkBrokenConnections). Mark it before parsing -- a live-but-malformed
      // frame is still liveness, and the parse below can throw.
      client.confirm();
      try {
        const message = JSON.parse(data.toString()) as Writable<IMessage>;

        message.src = client.getId();

        this.emit("message", client, message);
      } catch (e) {
        this.emit("error", e);
      }
    });

    this.emit("connection", client);
  }

  private _sendErrorAndRelease(socket: WebSocket, msg: Errors): void {
    this._sendAndRelease(socket, MessageType.ERROR, msg);
  }

  // Hand the peer the frame that tells it why it was refused, then release the
  // socket on the bound above. The frame and the close frame behind it are
  // written first, so a peer that answers the close handshake is released on it;
  // the terminate is the deadline on that handshake, which a refused peer has no
  // reason to complete and every reason -- if it is holding sockets on purpose --
  // to stall.
  private _sendAndRelease(
    socket: WebSocket,
    type: MessageType,
    msg: string,
  ): void {
    socket.send(JSON.stringify({ type, payload: { msg } }));
    socket.close();

    const release = setTimeout(() => {
      socket.terminate();
    }, SOCKET_RELEASE_TIMEOUT_MS);
    release.unref();

    socket.once("close", () => {
      clearTimeout(release);
    });
  }
}

type Writable<T> = {
  -readonly [K in keyof T]: T[K];
};
