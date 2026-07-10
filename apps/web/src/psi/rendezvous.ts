import Peer from "peerjs";

import { deriveRendezvousPeerId, getLogger } from "@psilink/core";

import { isDiagnosticMode, whenDiagnostic } from "@utils/diagnostics";
import { ConfigManager } from "@utils/clientConfig";

import {
  createRedactingLogFunction,
  redactErrorIds,
  resolvePeerDebugLevel,
} from "./peerLogging";
import { DEFAULT_PEER_WAIT_TIMEOUT_MS } from "./waitForConnection";

import type { DataConnection, PeerOptions } from "peerjs";
import type { WebRTCEndpoint } from "@psilink/core";

const log = getLogger("rendezvous");

const configManager = new ConfigManager();
const config = await configManager.load();

/** Constructs a PeerJS {@link Peer} on a chosen id; injectable so the
 * register/dial/destroy paths are unit-testable without a real broker. */
export type PeerFactory = (id: string, options: PeerOptions) => Peer;

const defaultPeerFactory: PeerFactory = (id, options) => new Peer(id, options);

/**
 * The WebSocket heartbeat cadence the PeerJS client sends, pinned here rather
 * than left to the `peerjs` default. `peerjs` is a caret range (`^1.5.5`) whose
 * default `pingInterval` (5,000 ms in 1.5.x) is a default parameter inside a
 * bundled file -- not exported -- so a minor bump could silently change it. The
 * signaling server's "unconfirmed" reap window (`unconfirmed_timeout` in the
 * vendored peerjs-server reaper) is justified as a multiple of this cadence: a
 * real peer graduates to the generous `alive_timeout` window the moment its
 * first heartbeat lands, so the reap window only ever cuts a socket that
 * registers and stays silent. Setting the cadence to a psilink-owned value keeps
 * that safety margin pinned to something we control instead of a transitive
 * default. The reap-window-vs-cadence margin itself is enforced as a check in
 * `test/unit/signalingReaping.test.ts`, not asserted in prose here.
 */
export const PEER_PING_INTERVAL_MS = 5_000;

/**
 * Per-attempt ceiling for a dialed data channel to finish opening, matching the
 * channel-open bound in `waitForOpen.ts`. Reaching it means the inviter's id IS
 * registered (otherwise the broker would have answered `peer-unavailable` in a
 * single round-trip, far sooner) but the channel will not open -- a broken
 * channel, so the dial fails rather than retrying into the same stall.
 */
const DEFAULT_DIAL_ATTEMPT_TIMEOUT_MS = 30_000;

/**
 * Backoff between dial attempts while the inviter has not yet registered its
 * derived id (`peer-unavailable`). Human-timescale polling: the inviter starts
 * listening when its operator begins the exchange, which may be after the
 * acceptor consents, so the acceptor re-dials at this cadence until the inviter
 * appears, bounded by {@link DEFAULT_PEER_WAIT_TIMEOUT_MS}.
 */
const DEFAULT_DIAL_RETRY_DELAY_MS = 1_000;

/** A reachable host/port/path the PeerJS client dials the signaling server at. */
interface SignalingLocation {
  host: string;
  port: number;
  path: string;
}

/**
 * Build the PeerJS options for a signaling location. The ICE configuration
 * mirrors the former `client.ts`/`server.ts`: public STUN only, no TURN -- a
 * TURN relay forwards data, and while all traffic is relayed across the Internet
 * regardless, we do not route through a third-party relay by default (a
 * self-hosted TURN server is a future option).
 *
 * `redactableIds` are the session's derived rendezvous ids; the installed
 * `logFunction` strips them from PeerJS output so the per-session diagnostic
 * toggle can raise the debug level (see {@link resolvePeerDebugLevel}) without
 * any derived id reaching the console. It is installed at every level, not only
 * when diagnosing, so even the default errors-only output is redacted (PeerJS
 * error logs can carry an `Error` whose message embeds an id); the only effect
 * in non-diagnostic mode is the console prefix.
 */
function buildPeerOptions(
  loc: SignalingLocation,
  redactableIds: ReadonlyArray<string>,
): PeerOptions {
  return {
    host: loc.host,
    path: loc.path,
    port: loc.port,
    pingInterval: PEER_PING_INTERVAL_MS,
    debug: resolvePeerDebugLevel(config.PEERJS_DEBUG_LEVEL, isDiagnosticMode()),
    logFunction: createRedactingLogFunction(redactableIds),
    config: {
      iceServers: [
        { urls: ["stun:stun.l.google.com:19302", "stun:44.247.30.68:443"] },
      ],
      sdpSemantics: "unified-plan",
      iceTransportPolicy: "all",
    },
  };
}

/**
 * This app's own signaling location, for the inviter listening on its derived id.
 * Mirrors the former dialer: `localhost` is normalized to a loopback literal a
 * peer can dial, and an empty (default-port) location resolves to 443/80 by
 * scheme.
 */
function inviterLocationFromWindow(): SignalingLocation {
  let host = window.location.hostname;
  if (host === "localhost") host = "127.0.0.1";
  const port =
    Number(window.location.port) ||
    (window.location.protocol === "https:" ? 443 : 80);
  return { host, port, path: "/api/" };
}

/**
 * The inviter's signaling location, read off the invitation endpoint, for the
 * acceptor to dial. The host was already normalized when the invitation was
 * built (`webrtcEndpointFromLocation`). The endpoint omits the port only for a
 * default-port deployment, so when absent it is resolved by the acceptor's own
 * scheme (acceptor and inviter run the same app, typically the same origin).
 */
function acceptorLocationFromEndpoint(
  endpoint: WebRTCEndpoint,
): SignalingLocation {
  return {
    host: endpoint.host,
    port: endpoint.port ?? (window.location.protocol === "https:" ? 443 : 80),
    path: endpoint.path ?? "/api/",
  };
}

/**
 * Resolves once `peer` is registered with the broker (its `open` event), or
 * rejects on a pre-open `error` or an abort. A settle-once guard detaches every
 * listener exactly once. Does NOT destroy the peer on failure -- the public
 * caller owns that, so the destroy happens in exactly one place.
 */
function waitForPeerOpen(
  peer: Peer,
  options?: { signal?: AbortSignal },
): Promise<void> {
  const signal = options?.signal;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      peer.off("open", onOpen);
      peer.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
      action();
    };
    const onOpen = () => settle(resolve);
    const onError = (err: Error) => settle(() => reject(err));
    const onAbort = () =>
      settle(() =>
        reject(new Error("connecting to the signaling server was aborted")),
      );
    peer.once("open", onOpen);
    peer.once("error", onError);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort);
  });
}

/**
 * Connect to the signaling server and listen on the inviter's derived id,
 * resolving the registered {@link Peer}. The caller then awaits the inbound
 * connection (see {@link waitForIncomingConnection}). The Peer only surfaces on
 * success: a pre-open failure destroys it (freeing the broker id) before
 * rejecting, rather than leaking a registered peer the caller never receives.
 *
 * @param sharedSecret  The invitation's shared secret; the inviter id is derived
 *                      from it.
 * @param options       `signal` cancels the listen before or during broker
 *                      registration; `peerFactory` injects the {@link Peer}
 *                      constructor for testing.
 */
export async function listenAsInviter(
  sharedSecret: string,
  options?: { signal?: AbortSignal; peerFactory?: PeerFactory },
): Promise<Peer> {
  const makePeer = options?.peerFactory ?? defaultPeerFactory;
  const signal = options?.signal;
  // Derive both ids: the inviter listens on its own, but the acceptor's id is
  // the remote id PeerJS interpolates into its warnings, so the redacting log
  // function must know it too (see buildPeerOptions).
  const [inviterId, acceptorId] = await Promise.all([
    deriveRendezvousPeerId(sharedSecret, "inviter"),
    deriveRendezvousPeerId(sharedSecret, "acceptor"),
  ]);
  const loc = inviterLocationFromWindow();
  // Short-circuit before any broker contact -- placed after the (fast) async
  // derivation above so an abort that lands during it is caught here too -- so
  // when the caller has already aborted (e.g. the component unmounted before this
  // ran) no peer is constructed and no derived id is registered with the broker.
  if (signal?.aborted)
    throw new Error("connecting to the signaling server was aborted");
  // The derived id is a rendezvous address that correlates exchanges, so keep it
  // out of default (info) logs; surface it only at debug for connection triage.
  log.info(`listening as inviter at ${loc.host}:${loc.port}`);
  log.debug(`derived inviter peer id ${inviterId}`);
  const peer = makePeer(
    inviterId,
    buildPeerOptions(loc, [inviterId, acceptorId]),
  );
  try {
    await waitForPeerOpen(peer, { signal });
  } catch (err) {
    peer.destroy();
    // PeerJS embeds a derived id in some emitted errors (e.g. `ID "<id>" is
    // taken`); strip the ids before the error escapes to the app's error sinks.
    throw redactErrorIds(err, [inviterId, acceptorId]);
  }
  return peer;
}

/** The result of one dial attempt: an opened channel, or a recoverable
 * "the inviter is not registered yet" that the caller backs off and re-dials. */
type DialAttempt =
  { outcome: "open"; conn: DataConnection } | { outcome: "unavailable" };

/** Is `err` PeerJS's non-fatal `peer-unavailable`? The dialed id is not
 * registered yet, but the dialing peer survives, so the caller may re-dial. */
function isPeerUnavailable(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { type?: unknown }).type === "peer-unavailable"
  );
}

/** Normalize a PeerJS error (often a bare `{ type }` object, not an Error). */
function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** Resolve after `ms`, or reject promptly if `signal` aborts first. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("dialing the inviter was aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("dialing the inviter was aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Dial `inviterId`, retrying while the broker reports it `peer-unavailable` (the
 * inviter has not started listening yet), until the channel opens or the total
 * budget is spent. Each attempt is bounded by {@link
 * DEFAULT_DIAL_ATTEMPT_TIMEOUT_MS}; the retry budget is the human-timescale
 * {@link DEFAULT_PEER_WAIT_TIMEOUT_MS}, the same ceiling the inviter's inbound
 * wait uses, so neither side hangs forever waiting on the other.
 *
 * A single peer-level `error` listener spans the whole loop -- every attempt and
 * every backoff delay between them. A `peer-unavailable` resolves the in-flight
 * attempt as a retry; any other peer error is fatal and rejects the dial. A
 * per-attempt listener would leave the backoff windows uncovered, silently
 * dropping a fatal broker error that fired between attempts.
 */
async function dialInviterWithRetry(
  peer: Peer,
  inviterId: string,
  options: {
    retryDelayMs: number;
    openTimeoutMs: number;
    totalTimeoutMs: number;
    signal?: AbortSignal;
  },
): Promise<DataConnection> {
  const { retryDelayMs, openTimeoutMs, totalTimeoutMs, signal } = options;
  const deadline = Date.now() + totalTimeoutMs;

  // Routing hooks the in-flight attempt installs so the shared error listener
  // can hand a peer error to it; both are cleared between attempts. A peer error
  // arriving during a backoff (no attempt in flight) is instead recorded in
  // `fatalError` and thrown at the next loop top -- so it can never fire into the
  // void -- unless it is `peer-unavailable`, which is meaningless between dials.
  let onUnavailable: (() => void) | undefined;
  let onFatal: ((err: unknown) => void) | undefined;
  let fatalError: unknown;
  const onPeerError = (err: unknown) => {
    if (isPeerUnavailable(err)) onUnavailable?.();
    else if (onFatal) onFatal(err);
    else fatalError ??= err;
  };
  peer.on("error", onPeerError);

  // One dial attempt: open a reliable channel to `inviterId`. Resolves `"open"`
  // with the channel, `"unavailable"` when the shared listener reports
  // `peer-unavailable` (the peer survives, so the caller re-dials), or rejects on
  // a fatal peer error, an abort, or the per-attempt open timeout. A settle-once
  // guard detaches the channel listener and clears the routing hooks exactly once.
  const runAttempt = (attemptTimeoutMs: number): Promise<DialAttempt> =>
    new Promise<DialAttempt>((resolve, reject) => {
      const conn = peer.connect(inviterId, { reliable: true });
      let settled = false;
      const settle = (action: () => void) => {
        if (settled) return;
        settled = true;
        conn.off("open", onOpen);
        conn.off("error", onConnError);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        onUnavailable = undefined;
        onFatal = undefined;
        action();
      };
      const onOpen = () => settle(() => resolve({ outcome: "open", conn }));
      // A channel-level error is fatal to this attempt -- the same disposition as
      // any non-`peer-unavailable` error. PeerJS usually re-emits channel errors
      // on the parent peer (where `onPeerError` catches them), but a conn-only
      // error would otherwise hang the attempt until the open timeout.
      const onConnError = (err: unknown) =>
        settle(() => {
          conn.close();
          reject(asError(err));
        });
      const onAbort = () =>
        settle(() => {
          conn.close();
          reject(new Error("dialing the inviter was aborted"));
        });
      const timer = setTimeout(
        () =>
          settle(() => {
            conn.close();
            reject(new Error("timed out opening a connection to the inviter"));
          }),
        attemptTimeoutMs,
      );
      onUnavailable = () =>
        settle(() => {
          conn.close();
          resolve({ outcome: "unavailable" });
        });
      onFatal = (err) =>
        settle(() => {
          conn.close();
          reject(asError(err));
        });
      conn.once("open", onOpen);
      conn.once("error", onConnError);
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort);
    });

  try {
    for (;;) {
      if (signal?.aborted) throw new Error("dialing the inviter was aborted");
      if (fatalError !== undefined) throw asError(fatalError);
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new Error("timed out waiting for the inviter to come online");
      // Clamp the per-attempt open timeout to the remaining budget so an attempt
      // started near the deadline cannot run up to openTimeoutMs past it: the
      // total budget is the hard ceiling, shared with the inviter's inbound wait.
      const attempt = await runAttempt(Math.min(openTimeoutMs, remaining));
      if (attempt.outcome === "open") return attempt.conn;
      if (Date.now() + retryDelayMs >= deadline)
        throw new Error("timed out waiting for the inviter to come online");
      log.info("inviter not yet listening; retrying");
      await delay(retryDelayMs, signal);
    }
  } finally {
    peer.off("error", onPeerError);
  }
}

/**
 * Connect to the inviter's signaling server (read off the invitation
 * `endpoint`), register under the acceptor's derived id, and dial the inviter's
 * derived id, resolving `[peer, conn]` once the channel is open. If the inviter
 * is not listening yet the dial retries (see {@link dialInviterWithRetry}); any
 * pre-resolve failure destroys the peer (freeing the broker id) before rejecting,
 * rather than leaking a registered peer the caller never receives.
 *
 * @param sharedSecret  The invitation's shared secret; both derived ids come
 *                      from it.
 * @param endpoint      The invitation's WebRTC signaling endpoint.
 * @param options       `signal` cancels the dial (and its retry loop) on unmount;
 *                      `peerFactory` injects the {@link Peer} constructor for
 *                      testing; the `*Ms` overrides tune the retry timing.
 */
export async function dialAsAcceptor(
  sharedSecret: string,
  endpoint: WebRTCEndpoint,
  options?: {
    signal?: AbortSignal;
    peerFactory?: PeerFactory;
    retryDelayMs?: number;
    openTimeoutMs?: number;
    totalTimeoutMs?: number;
  },
): Promise<[Peer, DataConnection]> {
  const makePeer = options?.peerFactory ?? defaultPeerFactory;
  const signal = options?.signal;
  const [inviterId, acceptorId] = await Promise.all([
    deriveRendezvousPeerId(sharedSecret, "inviter"),
    deriveRendezvousPeerId(sharedSecret, "acceptor"),
  ]);
  const loc = acceptorLocationFromEndpoint(endpoint);
  // Derived ids are rendezvous addresses that correlate exchanges; keep them out
  // of default (info) logs and surface them only at debug for connection triage.
  // The host/port come from the partner's invitation endpoint
  // (`acceptorLocationFromEndpoint`), so dev-gate this line: a production console
  // carries no partner-influenced bytes, while a developer or a diagnosing
  // tester still gets the dial target.
  whenDiagnostic(() =>
    log.info(`dialing the inviter at ${loc.host}:${loc.port}`),
  );
  log.debug(`derived peer ids: inviter ${inviterId}, acceptor ${acceptorId}`);
  const peer = makePeer(
    acceptorId,
    buildPeerOptions(loc, [inviterId, acceptorId]),
  );
  try {
    await waitForPeerOpen(peer, { signal });
    const conn = await dialInviterWithRetry(peer, inviterId, {
      retryDelayMs: options?.retryDelayMs ?? DEFAULT_DIAL_RETRY_DELAY_MS,
      openTimeoutMs: options?.openTimeoutMs ?? DEFAULT_DIAL_ATTEMPT_TIMEOUT_MS,
      totalTimeoutMs: options?.totalTimeoutMs ?? DEFAULT_PEER_WAIT_TIMEOUT_MS,
      signal,
    });
    return [peer, conn];
  } catch (err) {
    peer.destroy();
    // PeerJS embeds a derived id in some emitted errors (e.g. a failed
    // negotiation to the dialed id); strip the ids before the error escapes to
    // the app's error sinks.
    throw redactErrorIds(err, [inviterId, acceptorId]);
  }
}
