import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Socket } from "node:net";

/**
 * The pre-101 bounds the standalone runner puts on its own HTTP server.
 *
 * Separate from `standalone.ts`, which listens at import time, so the bounds can
 * be applied to a server a test owns. The values are the ones
 * docs/spec/CHANNEL_SECURITY.md states for the signaling upgrade surface, held
 * here as constants of this package's own: the web app installs the same three
 * bounds on the server it deploys (`apps/web/server/upgradeHardening.ts`), and a
 * package does not import from an app.
 */

/** Bound (ms) for receiving the complete request headers. A signaling handshake
 * sends its small headers in one segment, so this sits far above a legitimate
 * upgrade while closing one that dribbles them. Node checks it on a periodic
 * sweep, so the effective close is this plus up to one sweep interval. */
export const STANDALONE_HEADERS_TIMEOUT_MS = 10_000;

/** Bound (ms) for receiving the entire request, covering a client that finishes
 * its headers and then stalls the rest. Node requires it above
 * {@link STANDALONE_HEADERS_TIMEOUT_MS}. */
export const STANDALONE_REQUEST_TIMEOUT_MS = 15_000;

/** Bound (ms) for a connected socket that has not begun, or has stopped
 * part-way through, its request. The two above arm only once request parsing
 * has begun, so a peer that completes the TCP handshake and sends nothing has no
 * request for them to bound; this per-socket idle timeout closes that hold, on
 * its own clock rather than the sweep. */
export const STANDALONE_PREHANDSHAKE_IDLE_MS = 10_000;

/** Placeholder listener; see {@link applyStandaloneUpgradeBounds}. */
function deferTimeoutToIdleReap(): void {}

/**
 * Bound the window before the runner has a request in hand: complete headers, a
 * complete request, and a socket that goes quiet owing either.
 *
 * All three stop reaching a connection once a request has wholly arrived, so
 * neither a handler taking its time nor an established WebSocket is under them
 * -- `ws` clears the socket timeout on the 101, and the signaling layer's own
 * liveness reaper governs the socket from there. Nothing is wired on `upgrade`:
 * the signaling server reads `listenerCount("upgrade")` to tell whether a
 * co-resident listener could answer an upgrade it declined, and a second
 * listener here would change that answer.
 *
 * The override arguments exist so the behavior is testable on a short clock; the
 * runner uses the defaults.
 */
export function applyStandaloneUpgradeBounds(
  server: Server,
  overrides: {
    headersTimeoutMs?: number;
    requestTimeoutMs?: number;
    preHandshakeIdleMs?: number;
  } = {},
): void {
  server.headersTimeout =
    overrides.headersTimeoutMs ?? STANDALONE_HEADERS_TIMEOUT_MS;
  server.requestTimeout =
    overrides.requestTimeoutMs ?? STANDALONE_REQUEST_TIMEOUT_MS;
  const idleMs =
    overrides.preHandshakeIdleMs ?? STANDALONE_PREHANDSHAKE_IDLE_MS;

  // The request each socket is delivering, for the reap to weigh. Node's
  // `request` event fires once the headers are parsed, which is not the moment
  // the request is in hand: a client that declares a body still owes the rest of
  // it, and `complete` is the flag that tells the two apart.
  const pendingRequestBySocket = new WeakMap<Socket, IncomingMessage>();

  server.on("connection", (socket: Socket) => {
    const reapUnlessRequestIsInHand = (): void => {
      if (socket.destroyed) return;
      if (!pendingRequestBySocket.get(socket)?.complete) socket.destroy();
    };
    // Subscribed rather than passed to `setTimeout`, which subscribes for one
    // firing only: a window the reap lets pass would take the reap with it.
    socket.on("timeout", reapUnlessRequestIsInHand);
    socket.setTimeout(idleMs);
  });

  server.on("request", (request: IncomingMessage, response: ServerResponse) => {
    pendingRequestBySocket.set(request.socket, request);
    // Node destroys a timed-out socket unless the request, the response, or the
    // server holds a `timeout` listener. This one stays its hand for as long as
    // a response is in flight, leaving the reap above to decide.
    response.on("timeout", deferTimeoutToIdleReap);
  });
}
