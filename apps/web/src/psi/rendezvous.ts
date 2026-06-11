import Peer from "peerjs";

import { deriveRendezvousPeerId, getLogger } from "@psilink/core";

import { ConfigManager } from "@utils/clientConfig";

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
 */
function buildPeerOptions(loc: SignalingLocation): PeerOptions {
  return {
    host: loc.host,
    path: loc.path,
    port: loc.port,
    debug: config.PEERJS_DEBUG_LEVEL,
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
 * @param options       `peerFactory` injects the {@link Peer} constructor for
 *                      testing.
 */
export async function listenAsInviter(
  sharedSecret: string,
  options?: { peerFactory?: PeerFactory },
): Promise<Peer> {
  const makePeer = options?.peerFactory ?? defaultPeerFactory;
  const inviterId = await deriveRendezvousPeerId(sharedSecret, "inviter");
  const loc = inviterLocationFromWindow();
  log.info(
    `listening as inviter on derived id ${inviterId} at ${loc.host}:${loc.port}`,
  );
  const peer = makePeer(inviterId, buildPeerOptions(loc));
  try {
    await waitForPeerOpen(peer);
  } catch (err) {
    peer.destroy();
    throw err;
  }
  return peer;
}

/** The result of one dial attempt: an opened channel, or a recoverable
 * "the inviter is not registered yet" that the caller backs off and re-dials. */
type DialAttempt =
  | { outcome: "open"; conn: DataConnection }
  | { outcome: "unavailable" };

/**
 * One dial attempt: open a reliable channel to `inviterId`. Resolves `"open"`
 * with the opened channel, resolves `"unavailable"` on a non-fatal
 * `peer-unavailable` (the inviter has not registered its id yet; the peer
 * survives, so the caller may re-dial on the same peer), or rejects on any other
 * error, an abort, or the per-attempt open timeout. A settle-once guard detaches
 * every listener and closes the dead channel exactly once.
 */
function attemptDial(
  peer: Peer,
  inviterId: string,
  options: { openTimeoutMs: number; signal?: AbortSignal },
): Promise<DialAttempt> {
  const { openTimeoutMs, signal } = options;
  return new Promise<DialAttempt>((resolve, reject) => {
    const conn = peer.connect(inviterId, { reliable: true });
    let settled = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      conn.off("open", onOpen);
      peer.off("error", onError);
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      action();
    };
    const onOpen = () => settle(() => resolve({ outcome: "open", conn }));
    const onError = (err: unknown) => {
      // `peer-unavailable` is a non-fatal PeerJS error: the dialed id is not
      // registered, but this peer stays alive and can re-dial. Anything else is
      // fatal to the dial.
      if (
        typeof err === "object" &&
        err !== null &&
        (err as { type?: unknown }).type === "peer-unavailable"
      ) {
        settle(() => {
          conn.close();
          resolve({ outcome: "unavailable" });
        });
      } else {
        settle(() => {
          conn.close();
          reject(err instanceof Error ? err : new Error(String(err)));
        });
      }
    };
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
      openTimeoutMs,
    );
    conn.once("open", onOpen);
    peer.once("error", onError);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort);
  });
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
  for (;;) {
    if (signal?.aborted) throw new Error("dialing the inviter was aborted");
    const attempt = await attemptDial(peer, inviterId, {
      openTimeoutMs,
      signal,
    });
    if (attempt.outcome === "open") return attempt.conn;
    if (Date.now() + retryDelayMs >= deadline)
      throw new Error("timed out waiting for the inviter to come online");
    log.info(`inviter ${inviterId} not yet listening; retrying`);
    await delay(retryDelayMs, signal);
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
  log.info(
    `dialing inviter ${inviterId} as acceptor ${acceptorId} at ${loc.host}:${loc.port}`,
  );
  const peer = makePeer(acceptorId, buildPeerOptions(loc));
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
    throw err;
  }
}
