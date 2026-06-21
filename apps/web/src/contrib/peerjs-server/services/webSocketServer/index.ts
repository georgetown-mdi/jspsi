import { EventEmitter } from "node:events";

import { WebSocketServer as Server } from "ws";

import { Errors, MessageType } from "../../enums.ts";

import { Client } from "../../models/client.ts";

import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Server as HttpsServer } from "node:https";

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

    // This listener lives for the life of `server`, with no teardown -- by
    // design, not omission. The peer server is a per-process singleton
    // (`usePeerServer`) bound to the process-lived dev/Nitro HTTP server, so this
    // WebSocketServer is constructed once and shares the server's lifetime; the
    // socketServer is never closed. There is therefore no reinstantiation that
    // would stack listeners, and no closed socketServer for a stale listener to
    // dispatch to.
    server.on("upgrade", (req, socket, head) => {
      if (!this.socketServer.shouldHandle(req)) {
        // Not our path (shouldHandle() applies the `path` option above). Leave it
        // for a co-resident `upgrade` listener -- e.g. Vite HMR at `/` in dev. But
        // when we are the ONLY upgrade listener (the production server, where
        // nothing else will answer) close it rather than leak an open socket:
        // Node will not auto-destroy an unhandled upgrade once any `upgrade`
        // listener exists, and no socket timeout reaps it. This restores the
        // prompt reject the old `{ server, path }` wiring did, without clobbering
        // co-resident listeners.
        if (server.listenerCount("upgrade") === 1 && !socket.destroyed) {
          socket.destroy();
        }
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
      this._sendErrorAndClose(socket, Errors.INVALID_WS_PARAMETERS);
      return;
    }

    if (key !== this.config.key) {
      this._sendErrorAndClose(socket, Errors.INVALID_KEY);
      return;
    }

    const client = this.realm.getClientById(id);

    if (client) {
      if (token !== client.getToken()) {
        // ID-taken, invalid token
        socket.send(
          JSON.stringify({
            type: MessageType.ID_TAKEN,
            payload: { msg: "ID is taken" },
          }),
        );

        socket.close();
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
      this._sendErrorAndClose(socket, Errors.CONNECTION_LIMIT_EXCEED);
      return;
    }

    const newClient: IClient = new Client({ id, token });
    this.realm.setClient(newClient, id);
    socket.send(JSON.stringify({ type: MessageType.OPEN }));

    this._configureWS(socket, newClient);
  }

  private _configureWS(socket: WebSocket, client: IClient): void {
    client.setSocket(socket);

    // Cleanup after a socket closes.
    socket.on("close", () => {
      if (client.getSocket() === socket) {
        this.realm.removeClientById(client.getId());
        this.emit("close", client);
      }
    });

    // Handle messages from peers.
    socket.on("message", (data) => {
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

  private _sendErrorAndClose(socket: WebSocket, msg: Errors): void {
    socket.send(
      JSON.stringify({
        type: MessageType.ERROR,
        payload: { msg },
      }),
    );

    socket.close();
  }
}

type Writable<T> = {
  -readonly [K in keyof T]: T[K];
};
