import type { Duplex } from "node:stream";
import type { Server as HttpServer } from "node:http";
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
 * This per-socket idle timeout closes that hold. `ws` resets the socket timeout
 * to 0 the moment a socket completes the 101 upgrade, so an established
 * WebSocket -- governed by the liveness reaper, not this -- is never cut by it.
 */
export const SIGNALING_PREHANDSHAKE_IDLE_MS = 10_000;

// Per-server idle reaper, tracked so a repeated harden (a test re-hardening, a
// hot reload) replaces rather than stacks it. Unlike closeStalledHandshake, the
// reaper closes over its per-call idle bound, so it cannot be a single shared
// function compared by identity.
const idleReaperByServer = new WeakMap<
  HttpServer | HttpsServer,
  (socket: Socket) => void
>();

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
 * Bound the pre-101 upgrade handshake on the shared HTTP server: an
 * unauthenticated client that opens a connection and dribbles -- or never
 * finishes -- its request headers is closed server-side rather than held until a
 * loose (60s) default, and one that connects and then sends nothing at all (no
 * request for the header/request timeouts to bound) is reaped on a per-socket
 * idle timeout. Once a socket completes the 101 it is a WebSocket the signaling
 * layer governs (the `ws` close timer and the liveness reaper), so these bound
 * only the handshake. The override args exist so the behavior is unit-testable
 * on a short clock; production uses the defaults.
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
  const previousReaper = idleReaperByServer.get(server);
  if (previousReaper) server.removeListener("connection", previousReaper);
  const reapIdlePreHandshakeSocket = (socket: Socket): void => {
    socket.setTimeout(idleMs, () => socket.destroy());
  };
  idleReaperByServer.set(server, reapIdlePreHandshakeSocket);
  server.on("connection", reapIdlePreHandshakeSocket);
}
