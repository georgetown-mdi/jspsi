import type {
  Server as HttpServer,
  IncomingMessage,
  ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";
import type { Server as HttpsServer } from "node:https";
import type { Socket } from "node:net";

/**
 * Default bound (ms) for receiving the complete request headers before the
 * connection is reaped. A real signaling handshake sends its (small) headers in
 * one segment, so this sits far above any legitimate upgrade while closing a
 * slowloris that dribbles -- or never finishes -- its headers. Node enforces it
 * on its periodic connections-checking sweep, so the effective bound is this
 * plus up to one sweep interval.
 */
export const SIGNALING_HEADERS_TIMEOUT_MS = 10_000;

/**
 * Default backstop (ms) for receiving the entire request. Must exceed
 * {@link SIGNALING_HEADERS_TIMEOUT_MS} (Node wants requestTimeout greater than
 * headersTimeout, or 0 to disable); it bounds a client that completes headers
 * but then stalls the rest of the request.
 */
export const SIGNALING_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Default bound (ms) for a connected socket that has not begun -- or has paused
 * before finishing -- its request. {@link SIGNALING_HEADERS_TIMEOUT_MS} and
 * {@link SIGNALING_REQUEST_TIMEOUT_MS} only arm once HTTP request parsing has
 * begun, so a peer that completes the TCP handshake and then sends nothing has
 * no request for them to bound and would sit held open until the OS reaps it.
 * This per-socket idle timeout closes that hold. It binds only while the socket
 * owes the server a request, and stops reaching it once one has wholly arrived,
 * so what the server does with the connection thereafter -- however long the
 * handler takes, however quiet a long-lived response goes -- is outside its
 * reach, as is how fast the client takes it. `ws` takes the upgrade path out
 * from under it outright, resetting the socket timeout to 0 the moment a socket
 * completes the 101, so an established WebSocket is governed by the liveness
 * reaper rather than by this.
 */
export const SIGNALING_PREHANDSHAKE_IDLE_MS = 10_000;

// Per-server idle hooks, tracked so a repeated harden (a test re-hardening, a
// hot reload) replaces rather than stacks them. Unlike closeStalledHandshake,
// they close over their per-call idle bound, so they cannot be shared functions
// compared by identity.
const idleHooksByServer = new WeakMap<
  HttpServer | HttpsServer,
  { arm: (socket: Socket) => void; handOffToTls: (socket: Socket) => void }
>();

// The reap callback armed on each socket, so handing the bound to a wrapping
// socket can also detach it. `setTimeout(0)` alone disarms the timer but leaves
// the callback subscribed to the socket's `timeout` event, where a re-arm by
// Node's own keep-alive handling would later fire it; detaching leaves a socket
// this module has let go of carrying none of its state.
const idleReapCallbackBySocket = new WeakMap<Socket, () => void>();

// The request each socket is currently delivering, for the reap to weigh. Node's
// `request` event fires once the headers are parsed, which is not the moment the
// request is in hand: a client that declares a body still owes the rest of it,
// and `complete` is the flag that tells the two apart.
const pendingRequestBySocket = new WeakMap<Socket, IncomingMessage>();

/**
 * Close a stalled or malformed handshake. Node already does this from its
 * built-in `clientError` default, but that default is suppressed the moment any
 * `clientError` listener is attached -- which an embedding framework, or a test
 * environment that loads `ws`, may do -- so we close it explicitly rather than
 * rely on a default that another listener can silently disable. Mirrors the
 * default's best-effort response for a still-writable socket, then destroys.
 */
function closeStalledHandshake(
  err: NodeJS.ErrnoException,
  socket: Duplex,
): void {
  if (socket.writable) {
    const status =
      err.code === "ERR_HTTP_REQUEST_TIMEOUT"
        ? "408 Request Timeout"
        : "400 Bad Request";
    // Send a best-effort response, then destroy once it has flushed. `end()`
    // alone only half-closes (sends our FIN), so a peer that never sends its own
    // FIN could otherwise hold the connection half-open -- the exact resource
    // hold this guard exists to close. Destroying in the flush callback reaps the
    // socket without truncating the response for a peer that is reading it.
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`, () =>
      socket.destroy(),
    );
  } else {
    socket.destroy();
  }
}

/**
 * A socket wrapping another, as a TLS connection wraps the accepted TCP socket.
 * `_parent` is the only link Node exposes between the two, and Node's own timer
 * refresh walks it, so an idle bound armed on the inner socket is kept alive by
 * traffic on the wrapper while being invisible to every release, which sees the
 * wrapper alone. The HTTPS tests fail if a Node release drops the link.
 */
type WrappingSocket = Socket & { _parent?: Socket | null };

/** Clear a socket's idle bound and detach the state this module put on it. */
function releaseIdleBound(socket: Socket): void {
  socket.setTimeout(0);
  const reapCallback = idleReapCallbackBySocket.get(socket);
  if (reapCallback) {
    socket.removeListener("timeout", reapCallback);
    idleReapCallbackBySocket.delete(socket);
  }
  pendingRequestBySocket.delete(socket);
}

/** Placeholder listener; see {@link trackPendingRequest}. */
function deferTimeoutToIdleReap(): void {}

/**
 * Record the request a socket has begun delivering, for the reap below to weigh,
 * and take a timed-out socket out of Node's hands so that reap is what decides
 * its fate. This event is not itself the moment the bound stops reaching the
 * socket: it fires once the headers are parsed, while the client still owes the
 * server a request until the whole of it has arrived, so one that announces a
 * body and then stalls stays under the bound. Leaving the bound armed that far is
 * what needs the placeholder listener: Node destroys a socket that hits its
 * timeout unless the request, the response, or the server carries a `timeout`
 * listener, and putting one on the response stays its hand for exactly as long as
 * a response is in flight -- the window the reap deliberately lets pass. Closes
 * over nothing, so a repeated harden compares it by identity like
 * {@link closeStalledHandshake}.
 */
function trackPendingRequest(req: IncomingMessage, res: ServerResponse): void {
  pendingRequestBySocket.set(req.socket, req);
  res.on("timeout", deferTimeoutToIdleReap);
}

/**
 * Bound the pre-101 upgrade handshake on the shared HTTP server: an
 * unauthenticated client that opens a connection and dribbles -- or never
 * finishes -- its request headers is closed server-side rather than held until a
 * loose (60s) default, and one that connects and then sends nothing at all (no
 * request for the header/request timeouts to bound) is reaped on a per-socket
 * idle timeout. All three bound only the window before the server has a request
 * in hand: each stops binding once one has wholly arrived, whether that is a
 * WebSocket upgrade the signaling layer then governs (the `ws` close timer and
 * the liveness reaper) or an ordinary request whose response the server paces and
 * the client drains at whatever rate it likes. A client that gets as far as
 * complete headers and then stalls the body it announced has delivered no request
 * and stays under all three. The override args exist so the behavior is
 * unit-testable on a short clock; production uses the defaults.
 */
export function hardenUpgradeSurface(
  server: HttpServer | HttpsServer,
  options: {
    headersTimeoutMs?: number;
    requestTimeoutMs?: number;
    preHandshakeIdleMs?: number;
  } = {},
): void {
  server.headersTimeout =
    options.headersTimeoutMs ?? SIGNALING_HEADERS_TIMEOUT_MS;
  server.requestTimeout =
    options.requestTimeoutMs ?? SIGNALING_REQUEST_TIMEOUT_MS;
  // Idempotent: remove first so a repeated call (a test that re-hardens a server,
  // a hot-reload) cannot stack a second handler that fires twice per error.
  server.removeListener("clientError", closeStalledHandshake);
  server.on("clientError", closeStalledHandshake);

  // Reap a connected-but-idle socket the header/request timeouts cannot see
  // (see SIGNALING_PREHANDSHAKE_IDLE_MS). Replace any prior reaper so a repeated
  // call does not stack a second one.
  const idleMs = options.preHandshakeIdleMs ?? SIGNALING_PREHANDSHAKE_IDLE_MS;
  const previousHooks = idleHooksByServer.get(server);
  if (previousHooks) {
    server.removeListener("connection", previousHooks.arm);
    server.removeListener("secureConnection", previousHooks.handOffToTls);
  }
  const armPreHandshakeIdleBound = (socket: Socket): void => {
    const reapUnlessRequestIsInHand = (): void => {
      if (socket.destroyed) return;
      // Weighed when the socket has gone quiet, which is the moment the question
      // has an answer: a request that has wholly arrived puts the connection in
      // the server's hands and in the client's, so this window passes without a
      // reap. A socket with no request at all, or one whose request stopped
      // part-way, still owes the server bytes.
      if (!pendingRequestBySocket.get(socket)?.complete) socket.destroy();
    };
    idleReapCallbackBySocket.set(socket, reapUnlessRequestIsInHand);
    // Subscribed rather than passed to setTimeout, which subscribes for one
    // firing only: a window the reap deliberately lets pass would take the reap
    // with it.
    socket.on("timeout", reapUnlessRequestIsInHand);
    socket.setTimeout(idleMs);
  };
  // Over TLS the bound has to ride the socket the HTTP layer hands out -- the
  // TLSSocket, which the request hook below keys on and `ws` releases on the 101
  // -- so hand it over once the handshake completes. Until then the accepted socket
  // carries the only bound covering a peer that opens a connection and never
  // starts a handshake. Inert on a plain HTTP server, which emits no
  // `secureConnection`.
  const handOffIdleBoundToTlsSocket = (tlsSocket: Socket): void => {
    const wrappedSocket = (tlsSocket as WrappingSocket)._parent;
    if (wrappedSocket) releaseIdleBound(wrappedSocket);
    armPreHandshakeIdleBound(tlsSocket);
  };
  idleHooksByServer.set(server, {
    arm: armPreHandshakeIdleBound,
    handOffToTls: handOffIdleBoundToTlsSocket,
  });
  server.on("connection", armPreHandshakeIdleBound);
  server.on("secureConnection", handOffIdleBoundToTlsSocket);

  // Idempotent for the same reason the clientError wiring is: the tracking hook
  // holds no per-call state, so removing it first keeps a repeated harden at one.
  // No matching hook is wired on `upgrade`: `ws` releases the bound itself on the
  // 101, and an extra `upgrade` listener would flip the signaling server's
  // sole-listener test for whether an unhandled upgrade is its to close.
  server.removeListener("request", trackPendingRequest);
  server.on("request", trackPendingRequest);
}
