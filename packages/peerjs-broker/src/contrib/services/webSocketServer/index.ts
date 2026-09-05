import { EventEmitter } from "node:events";
import { OutgoingMessage } from "node:http";
import { Socket } from "node:net";

import { parseBoundedJson } from "@psilink/core";
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
import type { SignalingDiagnosticSource } from "../../../diagnostics.ts";

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
// cap on account of `src` alone, breaking for a frame of any payload kind the
// holdability margin that cap's 2x-the-wire-cap sizing rests on. Bounding the id
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

// Arm the release bound as a handle disposed of exactly once: expiring marks it
// spent before the deadline body runs, so a cancel behind that -- the socket
// closing after a terminate the deadline itself ordered -- finds nothing left to
// retire, and a cancelled deadline never expires. Every release path below wants
// that same bookkeeping, and holding it here makes the double disposal
// unrepresentable rather than merely absent from each of them.
function armReleaseDeadline(onExpire: () => void): { cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    timer = undefined;
    onExpire();
  }, SOCKET_RELEASE_TIMEOUT_MS);
  timer.unref();

  return {
    cancel: (): void => {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
    },
  };
}

// The response this server is still writing on `socket`, if there is one. Node's
// HTTP server assigns an outgoing message to the socket it is being written on
// and clears that reference when the message detaches on `finish`, so asking for
// it is asking the HTTP server itself whether the socket is still carrying an
// answer of ours.
//
// `_httpMessage` is internal to Node rather than a documented API, so it is read
// defensively and its behavior is driven rather than assumed: the `instanceof`
// makes a Node that stops setting it read as "nothing in flight" instead of as
// some other object's field, and the pipelined-response check in
// apps/web/test/unit/signalingServer.test.ts drives a real http.Server through
// the whole sequence -- so a Node that no longer sets it fails that check rather
// than quietly reopening the misread its caller below exists to avoid.
function responseStillWriting(socket: Duplex): OutgoingMessage | null {
  const assigned = (socket as { _httpMessage?: unknown })._httpMessage;
  return assigned instanceof OutgoingMessage ? assigned : null;
}

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
      this._onSocketError(error, "signaling-server");
    });
  }

  private _onSocketConnection(socket: WebSocket, req: IncomingMessage): void {
    // An unhandled socket error might crash the server. Handle it first.
    socket.on("error", (error) => {
      this._onSocketError(error, "client-socket");
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

  // A report leaves this server on its own `error` event, carrying what raised
  // it: the paths that reach here produce errors that look alike once the
  // `Error` is all that survives, so the source is what lets the sink
  // `CreateInstanceWSOnly` attaches tell them apart. It rides as a second event
  // argument, which a listener that wants only the error ignores. See
  // docs/spec/CHANNEL_SECURITY.md.
  private _onSocketError(
    error: unknown,
    source: SignalingDiagnosticSource,
  ): void {
    this.emit("error", error, source);
  }

  // Release an upgrade on a path that is not ours (shouldHandle() applies the
  // `path` option above). Node stops auto-destroying an unhandled upgrade the
  // moment any `upgrade` listener exists, so every socket this branch declines
  // must be released by someone or it is leaked -- the production connection
  // idle-timeout is at best a far coarser backstop. When this is the sole
  // `upgrade` listener, nothing else can answer and the socket is destroyed at
  // once. Where a co-resident listener exists -- Vite HMR at `/` in dev -- the
  // socket is left for it, and whether it answered is then TESTED rather than
  // assumed: a socket that has written nothing since the moment it became
  // nobody's was answered by nobody when the release bound expires, so it is
  // destroyed and the broken premise raised as an error rather than leaked on a
  // premise that no longer holds.
  private _releaseUnhandledUpgrade(
    server: HttpServer | HttpsServer,
    socket: Duplex,
  ): void {
    if (socket.destroyed) return;

    if (server.listenerCount("upgrade") === 1) {
      socket.destroy();
      return;
    }

    // `bytesWritten` counts the whole connection's lifetime rather than this
    // window, and this server writes on that connection itself: an upgrade
    // arrives on a connection it has already answered a request on (HTTP
    // keep-alive), or -- pipelined ahead of the upgrade in one write -- on one it
    // is answering still, since Node emits `upgrade` as soon as its parser sees
    // one rather than when the response ahead of it finishes. Either response's
    // bytes read as this upgrade's answer would leave precisely that socket held
    // past the bound with the watch below taken off it, which is both the leak
    // this release exists to close and the unwatched error that ends the process.
    // So an answer is movement against the count the socket carries once no
    // answer of this server's is being written on it -- a baseline taken at the
    // decline, and taken again if a response of ours detaches after it.
    let answerBaseline = socket instanceof Socket ? socket.bytesWritten : 0;

    // The window below is the one stretch in which this socket is nobody's:
    // declined here, not yet taken by a co-resident listener, and so carrying no
    // `error` listener of anyone's. A raw socket that emits `error` with none
    // attached terminates the process, and a peer needs nothing more exotic than
    // a reset -- being killed, or dropped by its network -- to emit one. So it is
    // watched from the decline to the bound: an error in that stretch destroys
    // the socket, which is that socket's release, leaving the bound behind it
    // nothing to reclaim and no unanswered upgrade to report against a peer that
    // merely hung up. The watch runs to the bound rather than to an adopter's
    // answer, so an adopted socket that errors in the stretch between the two is
    // destroyed and reported here.
    const releaseOnError = (error: Error): void => {
      socket.destroy();
      this._onSocketError(error, "released-socket");
    };
    socket.on("error", releaseOnError);

    let deadline: { cancel: () => void } | undefined;
    let stopAwaitingResponse = (): void => {};

    // Every handle the window installs comes off with the window, whichever way
    // it ends -- the peer closing, the bound concluding the socket was adopted,
    // the bound expiring on an unanswered one -- so a socket handed on to a
    // co-resident listener carries none of this server's bookkeeping into the
    // life that listener gives it.
    const dropWindowHandles = (): void => {
      deadline?.cancel();
      stopAwaitingResponse();
      socket.off("error", releaseOnError);
      socket.off("close", dropWindowHandles);
    };

    const releaseUnlessAnswered = (): void => {
      if (socket.destroyed) return;
      if (socket instanceof Socket && socket.bytesWritten > answerBaseline) {
        // Answered: the socket is its adopter's now, errors with it.
        dropWindowHandles();
        return;
      }

      // The handles stay on across the destroy -- the `close` it emits is what
      // drops them -- so the socket is watched right up to its release.
      socket.destroy();
      this._onSocketError(
        new Error(
          "PeerJS signaling server released an upgrade no co-resident listener answered",
        ),
        "unanswered-upgrade",
      );
    };

    // A socket this server is still writing a response on is not nobody's and
    // cannot be leaked by this decline, so the bound does not start on it: it
    // starts where that response lets the socket go, against a baseline taken
    // there, and again behind any response pipelined after it. Discounting the
    // whole stretch costs nothing an adopter could have used -- an answer written
    // into a response still writing is interleaved with it on one TCP stream, so
    // whatever adopted such a socket has a corrupted connection either way --
    // while counting it is the misread that leaks the socket unwatched.
    //
    // The wait is the response's own `finish`, behind the handler Node itself
    // registered on it: by the time this one runs the message has been detached
    // and its last byte counted, so the baseline it takes is final. A message
    // that has already finished is waited on by nobody -- the event cannot come
    // twice -- so the bound starts instead.
    const startWindowOnceSocketIsFree = (): void => {
      const responseInFlight = responseStillWriting(socket);
      if (!responseInFlight || responseInFlight.writableFinished) {
        deadline = armReleaseDeadline(releaseUnlessAnswered);
        return;
      }
      // Each wait is a `once` that has fired by the time the next replaces it,
      // so the one held here is the only one still to retire.
      const onResponseDetached = (): void => {
        if (socket instanceof Socket) answerBaseline = socket.bytesWritten;
        startWindowOnceSocketIsFree();
      };
      responseInFlight.once("finish", onResponseDetached);
      stopAwaitingResponse = (): void => {
        responseInFlight.off("finish", onResponseDetached);
      };
    };
    startWindowOnceSocketIsFree();

    socket.on("close", dropWindowHandles);
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

      // `client-frame` covers reading the peer's bytes and nothing else: the
      // parse, and the stamping behind it, which throws on a frame that parsed
      // to a null or a primitive. Everything past this point is this server's own
      // code, whose faults are attributed as such below rather than charged to
      // the peer.
      //
      // The parse is core's bounded chokepoint rather than a raw JSON.parse: it
      // refuses a structurally pathological body before the parser can reach an
      // uncatchable engine abort, which on a broker every peer shares would end
      // rendezvous for all of them. The `ws` maxPayload cap above is the byte
      // half of the same bound (docs/spec/CHANNEL_SECURITY.md). This is the
      // chokepoint's string arm: `data.toString()` decodes ahead of the scan,
      // so invalid UTF-8 is replaced here rather than refused.
      let message: Writable<IMessage>;
      try {
        message = parseBoundedJson(data.toString()) as Writable<IMessage>;
        message.src = client.getId();
      } catch (e) {
        this._onSocketError(e, "client-frame");
        return;
      }

      // Dispatch is absorbed rather than let out, because `ws` calls this handler
      // from inside its own receiver with nothing between it and the socket's
      // `data` event: a throw here is an uncaught exception, and this server is
      // internet-facing. Reachable rather than theoretical -- the relay
      // serializes a frame it holds for an absent destination and throws on a
      // non-string id field (models/messageQueue.ts) -- which is why the report
      // has to name this server: read as a client frame it points the operator
      // at a peer sending garbage instead of at the fault.
      try {
        this.emit("message", client, message);
      } catch (e) {
        this._onSocketError(e, "frame-dispatch");
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

    const deadline = armReleaseDeadline(() => {
      socket.terminate();
    });

    socket.once("close", () => {
      deadline.cancel();
    });
  }
}

type Writable<T> = {
  -readonly [K in keyof T]: T[K];
};
