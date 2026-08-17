import type { Server as HttpServer, IncomingMessage } from "node:http";
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
 * owes the server a request: it is released the moment one arrives, so what the
 * server does with the connection thereafter -- however long the handler takes,
 * however quiet a long-lived response goes -- is outside its reach. `ws` performs
 * the same release for the upgrade path, resetting the socket timeout to 0 the
 * moment a socket completes the 101, so an established WebSocket is governed by
 * the liveness reaper rather than by this.
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

// The reap callback armed on each socket, so releasing the bound can also detach
// it. `setTimeout(0)` alone disarms the timer but leaves the callback subscribed
// to the socket's `timeout` event, where a re-arm by Node's own keep-alive
// handling would later fire it; detaching leaves a released socket carrying none
// of this module's state.
const idleReapCallbackBySocket = new WeakMap<Socket, () => void>();

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

/** Clear a socket's idle bound and detach its reap callback. */
function releaseIdleBound(socket: Socket): void {
  socket.setTimeout(0);
  const reapCallback = idleReapCallbackBySocket.get(socket);
  if (reapCallback) {
    socket.removeListener("timeout", reapCallback);
    idleReapCallbackBySocket.delete(socket);
  }
}

/**
 * Release the pre-request idle bound on the socket a request arrived on. The
 * bound covers the window in which the socket owes the server a request; once it
 * has delivered one, the server owns the pace of what follows, so nothing about
 * the response -- a slow handler, or an event stream that stays quiet between
 * frames -- may be measured against a client-idleness clock. Closes over
 * nothing, so a repeated harden compares it by identity like
 * {@link closeStalledHandshake}.
 */
function releasePreRequestIdleBound(req: IncomingMessage): void {
  releaseIdleBound(req.socket);
}

/**
 * Bound the pre-101 upgrade handshake on the shared HTTP server: an
 * unauthenticated client that opens a connection and dribbles -- or never
 * finishes -- its request headers is closed server-side rather than held until a
 * loose (60s) default, and one that connects and then sends nothing at all (no
 * request for the header/request timeouts to bound) is reaped on a per-socket
 * idle timeout. All three bound only the window before the server has a request
 * in hand: each is released once one arrives, whether that is a WebSocket
 * upgrade the signaling layer then governs (the `ws` close timer and the liveness
 * reaper) or an ordinary request whose response the server paces. The override
 * args exist so the behavior is unit-testable on a short clock; production uses
 * the defaults.
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
    const destroyIdleSocket = (): void => {
      socket.destroy();
    };
    idleReapCallbackBySocket.set(socket, destroyIdleSocket);
    socket.setTimeout(idleMs, destroyIdleSocket);
  };
  // Over TLS the bound has to ride the socket the HTTP layer hands out -- the
  // TLSSocket, which the request hook below and `ws` on the 101 each release --
  // so hand it over once the handshake completes. Until then the accepted socket
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

  // Idempotent for the same reason the clientError wiring is: the release hook
  // holds no per-call state, so removing it first keeps a repeated harden at one.
  // No matching hook is wired on `upgrade`: `ws` releases the bound itself on the
  // 101, and an extra `upgrade` listener would flip the signaling server's
  // sole-listener test for whether an unhandled upgrade is its to close.
  server.removeListener("request", releasePreRequestIdleBound);
  server.on("request", releasePreRequestIdleBound);
}
