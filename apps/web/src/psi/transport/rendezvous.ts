import Peer from "peerjs";

import {
  ConnectionError,
  RELAY_CREDENTIAL_MAX_TTL_SECONDS,
  authorityMovingSignalingField,
  deriveRelayKey,
  deriveRendezvousPeerId,
  getLogger,
  mintRelayCredential,
} from "@alcove/core";

import { isDiagnosticMode, whenDiagnostic } from "@utils/diagnostics";
import { ConfigManager } from "@utils/clientConfig";

import {
  DEFAULT_PEER_WAIT_TIMEOUT_MS,
  PartnerNoShowError,
} from "./waitForConnection";
import {
  createRedactingLogFunction,
  redactErrorIds,
  resolvePeerDebugLevel,
} from "./peerLogging";
import { watchIceGathering, withIceServerFailure } from "./iceGathering";
import { boundPeerSignaling } from "./signalingBounds";

import type { DataConnection, PeerOptions } from "peerjs";
import type { WebRTCEndpoint } from "@alcove/core";

const log = getLogger("rendezvous");

const configManager = new ConfigManager();
const config = await configManager.load();

/** Constructs a PeerJS {@link Peer} on a chosen id; injectable so the
 * register/dial/destroy paths are unit-testable without a real broker. */
type PeerFactory = (id: string, options: PeerOptions) => Peer;

const defaultPeerFactory: PeerFactory = (id, options) => {
  const peer = new Peer(id, options);
  try {
    return boundPeerSignaling(peer);
  } catch (err) {
    peer.destroy();
    throw err;
  }
};

/**
 * The WebSocket heartbeat cadence the PeerJS client sends, pinned here rather
 * than left to the `peerjs` default: that default lives in a bundled,
 * unexported file, so a minor version bump could silently change it. The
 * signaling server's "unconfirmed" reap window (`unconfirmed_timeout` in the
 * vendored peerjs-server reaper) is a multiple of this cadence, enforced by
 * `test/unit/psi/signalingReaping.test.ts`.
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
 * Ceiling on registering with the signaling server: opening its socket and
 * receiving `OPEN` (docs/spec/WEBRTC_TRANSPORT.md, "Budgets"). PeerJS sets no
 * bound of its own, and the rendezvous budget starts only once registered, so
 * without this a server that accepts the socket and never answers holds the
 * party until it is cancelled.
 */
export const BROKER_REGISTRATION_TIMEOUT_MS = 30_000;

/** What a party whose registration ran past a `timeoutMs` bound is told. */
export function brokerRegistrationTimedOutMessage(timeoutMs: number): string {
  const seconds = Math.max(1, Math.round(timeoutMs / 1000));
  return (
    `The signaling server did not accept the connection within ` +
    `${seconds} second${seconds === 1 ? "" : "s"}. Check the network ` +
    `connection and try again; if it keeps happening, the signaling server ` +
    `may be down.`
  );
}

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
 * A relay a peer connection gathers candidates against: TURN and STUN urls
 * under core's `connection.turn` / `connection.stun` grammar, and no
 * credential. The credential is minted per run from the exchange's shared
 * secret ({@link buildIceServers}).
 */
export interface RelayLocator {
  /** `turn:` / `turns:` urls, served by one relay under one credential. */
  turn: ReadonlyArray<string>;
  /** `stun:` / `stuns:` urls; a relay naming any url replaces the default
   * pair, so a relay naming TURN urls alone gathers no STUN candidate. */
  stun: ReadonlyArray<string>;
}

/** The STUN pair a run with no relay, or a relay naming no url, uses. */
const DEFAULT_STUN_URLS = [
  "stun:stun.l.google.com:19302",
  "stun:44.247.30.68:443",
];

/**
 * Lifetime of the relay credential a run mints. It must outlast the peer wait
 * ({@link DEFAULT_PEER_WAIT_TIMEOUT_MS}) and the exchange after it, and core
 * refuses anything over one hour, so it is that ceiling.
 */
export const RELAY_CREDENTIAL_TTL_SECONDS = RELAY_CREDENTIAL_MAX_TTL_SECONDS;

/** The label in a minted credential's username, `<expiry>:<label>`. */
const RELAY_CREDENTIAL_LABEL = "alcove";

/**
 * The ICE server list for one run. With no relay, or one naming no url, it is
 * the default STUN pair alone. Otherwise it holds the relay's STUN urls as one
 * entry when it names any, and its TURN urls as one entry holding a credential
 * minted at `now` from the relay key the exchange's shared secret derives, and
 * no default pair: the CLI's `connection.stun` / `connection.turn` rule, where
 * a configured list replaces the default. Nothing minted or derived outlives
 * the returned list.
 *
 * @internal
 */
export async function buildIceServers(
  relay: RelayLocator | undefined,
  sharedSecret: string,
  now: Date,
): Promise<Array<RTCIceServer>> {
  if (relay === undefined || relay.turn.length + relay.stun.length === 0)
    return [{ urls: [...DEFAULT_STUN_URLS] }];
  const iceServers: Array<RTCIceServer> = [];
  if (relay.stun.length > 0) iceServers.push({ urls: [...relay.stun] });
  if (relay.turn.length > 0) {
    const { username, credential } = await mintRelayCredential({
      key: await deriveRelayKey(sharedSecret),
      label: RELAY_CREDENTIAL_LABEL,
      ttlSeconds: RELAY_CREDENTIAL_TTL_SECONDS,
      now,
    });
    iceServers.push({ urls: [...relay.turn], username, credential });
  }
  return iceServers;
}

/**
 * Build the PeerJS options for a signaling location and a run's ICE server
 * list ({@link buildIceServers}).
 *
 * `redactableIds` are the session's derived rendezvous ids; the installed
 * `logFunction` strips them from PeerJS output at every debug level, not
 * only when diagnosing -- PeerJS error logs can embed an id even at the
 * default errors-only level.
 */
function buildPeerOptions(
  loc: SignalingLocation,
  redactableIds: ReadonlyArray<string>,
  iceServers: Array<RTCIceServer>,
): PeerOptions {
  return {
    host: loc.host,
    path: loc.path,
    port: loc.port,
    pingInterval: PEER_PING_INTERVAL_MS,
    debug: resolvePeerDebugLevel(config.PEERJS_DEBUG_LEVEL, isDiagnosticMode()),
    logFunction: createRedactingLogFunction(redactableIds),
    config: {
      iceServers,
      sdpSemantics: "unified-plan",
      iceTransportPolicy: "all",
    },
  };
}

/**
 * This app's own signaling location, for the inviter listening on its derived id.
 * `localhost` is normalized to a loopback literal a peer can dial, and an empty
 * (default-port) location resolves to 443/80 by scheme.
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
 * The refusal an invitation endpoint whose `host` could move the dialed address
 * gets. Names the class of character rather than echoing the value: the value
 * comes from the partner's invitation, so echoing it would put partner-chosen
 * bytes in front of the operator in place of the remedy.
 */
export const WEBRTC_ENDPOINT_HOST_REFUSED =
  "this invitation's signaling endpoint names a host that could move the " +
  "connection to another server: the host must contain none of @ / ? # \\ or " +
  "whitespace. Ask your partner to send a new invitation created from their " +
  "own address.";

/**
 * The refusal an invitation endpoint whose `path` could move the dialed address
 * gets (see {@link WEBRTC_ENDPOINT_HOST_REFUSED}).
 */
export const WEBRTC_ENDPOINT_PATH_REFUSED =
  "this invitation's signaling endpoint names a path that could move the " +
  'connection to another server: the path must start with "/" and contain ' +
  "none of @ ? # \\ or whitespace. Ask your partner to send a new invitation " +
  "created from their own address.";

/**
 * An endpoint refusal in the shape the run's alert reads as an invitation
 * fault: a `security`-kind {@link ConnectionError} holding core's
 * `alcoveRecoveryHintEmitted` tag, which together show the refusal's own text
 * and remedy with no retry control (`failureFor` in
 * `apps/web/src/exchange/useInviterExchange.ts`). A plain `Error` takes the
 * generic retryable copy instead, and every retry refuses identically, since
 * the endpoint alone decides it. The tag's contract holds here: both refusals
 * are fixed sentences naming the operator's next step, composed from no
 * partner-authored value.
 */
function endpointRefusal(message: string): ConnectionError {
  return Object.assign(new ConnectionError(message, "security"), {
    alcoveRecoveryHintEmitted: true,
  });
}

/**
 * The inviter's signaling location, read off the invitation endpoint, for the
 * acceptor to dial. The host was already normalized when the invitation was
 * built (`webrtcEndpointFromLocation`). The endpoint omits the port only for a
 * default-port deployment, so when absent it is resolved by the acceptor's own
 * scheme (acceptor and inviter run the same app, typically the same origin).
 *
 * `host` and `path` are refused for shape here, before the location reaches a
 * Peer: the endpoint is content the remote partner wrote and the operator
 * cannot inspect, and the PeerJS client assembles its signaling address by
 * string concatenation, so a delimiter left in either field can put the
 * authority somewhere the endpoint does not name. The rule is core's
 * {@link authorityMovingSignalingField}, the same one the CLI applies to a
 * webrtc `server` block; what each refused shape does to the assembled address
 * is measured against the real client in
 * test/browser/webrtcEndpointAuthority.test.ts and recorded in
 * docs/spec/WEBRTC_TRANSPORT.md.
 *
 * @throws {ConnectionError} if `host` or `path` has a shape that could move
 *                           the address ({@link endpointRefusal}).
 */
function acceptorLocationFromEndpoint(
  endpoint: WebRTCEndpoint,
): SignalingLocation {
  const location = {
    host: endpoint.host,
    port: endpoint.port ?? (window.location.protocol === "https:" ? 443 : 80),
    path: endpoint.path ?? "/api/",
  };
  const moved = authorityMovingSignalingField(location);
  if (moved === "host") throw endpointRefusal(WEBRTC_ENDPOINT_HOST_REFUSED);
  if (moved === "path") throw endpointRefusal(WEBRTC_ENDPOINT_PATH_REFUSED);
  return location;
}

/**
 * Resolves once `peer` is registered with the broker (its `open` event), or
 * rejects on a pre-open `error`, an abort, or `timeoutMs` passing first -- the
 * last as a `transport`-kind {@link ConnectionError} stating
 * {@link brokerRegistrationTimedOutMessage} for that bound. A settle-once guard
 * detaches every listener and clears the timer exactly once. Does NOT destroy
 * the peer on failure -- the public caller owns that, so the destroy happens in
 * exactly one place.
 */
function waitForPeerOpen(
  peer: Peer,
  options: { signal?: AbortSignal; timeoutMs: number },
): Promise<void> {
  const signal = options.signal;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
    const timer = setTimeout(() => {
      settle(() =>
        reject(
          new ConnectionError(
            brokerRegistrationTimedOutMessage(options.timeoutMs),
            "transport",
          ),
        ),
      );
    }, options.timeoutMs);
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
 * connection (see {@link waitForIncomingConnection}). The Peer is returned
 * only on success: a pre-open failure destroys it (freeing the broker id)
 * before rejecting, rather than leaking a registered peer the caller never
 * receives.
 *
 * @param sharedSecret  The invitation's shared secret; the inviter id is derived
 *                      from it.
 * @param options       `signal` cancels the listen before or during broker
 *                      registration; `relay` is the relay this run gathers
 *                      against, none when absent; `peerFactory` injects the
 *                      {@link Peer} constructor for testing;
 *                      `registrationTimeoutMs` overrides
 *                      {@link BROKER_REGISTRATION_TIMEOUT_MS}.
 */
export async function listenAsInviter(
  sharedSecret: string,
  options?: {
    signal?: AbortSignal;
    relay?: RelayLocator;
    peerFactory?: PeerFactory;
    registrationTimeoutMs?: number;
  },
): Promise<Peer> {
  const makePeer = options?.peerFactory ?? defaultPeerFactory;
  const signal = options?.signal;
  // Derive both ids: the inviter listens on its own, but the acceptor's id is
  // the remote id PeerJS interpolates into its warnings, so the redacting log
  // function must know it too (see buildPeerOptions).
  const [inviterId, acceptorId, iceServers] = await Promise.all([
    deriveRendezvousPeerId(sharedSecret, "inviter"),
    deriveRendezvousPeerId(sharedSecret, "acceptor"),
    buildIceServers(options?.relay, sharedSecret, new Date()),
  ]);
  const loc = inviterLocationFromWindow();
  // Short-circuit before any broker contact. Placed after the (fast) async
  // derivation above so an abort during it is still caught: no peer is
  // constructed and no derived id registered when the caller already aborted.
  if (signal?.aborted)
    throw new Error("connecting to the signaling server was aborted");
  // The derived id is a rendezvous address that correlates exchanges, so keep it
  // out of default (info) logs; show it only at debug for connection triage.
  log.info(`listening as inviter at ${loc.host}:${loc.port}`);
  log.debug(`derived inviter peer id ${inviterId}`);
  const peer = makePeer(
    inviterId,
    buildPeerOptions(loc, [inviterId, acceptorId], iceServers),
  );
  try {
    await waitForPeerOpen(peer, {
      signal,
      timeoutMs:
        options?.registrationTimeoutMs ?? BROKER_REGISTRATION_TIMEOUT_MS,
    });
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
 * Dial `inviterId`, retrying on `peer-unavailable` until the channel opens
 * or the total budget -- {@link DEFAULT_PEER_WAIT_TIMEOUT_MS}, matching the
 * inviter's own inbound-wait ceiling -- is spent; each attempt is bounded by
 * {@link DEFAULT_DIAL_ATTEMPT_TIMEOUT_MS}.
 *
 * One peer-level `error` listener spans the whole loop, including backoff
 * delays, so a fatal broker error between attempts is never dropped;
 * `peer-unavailable` retries, anything else is fatal.
 *
 * A spent budget throws {@link PartnerNoShowError} (every attempt was
 * `peer-unavailable`: the inviter never registered); the per-attempt open
 * timeout is a plain error instead, since reaching it means the id IS
 * registered but the channel will not open.
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
      watchIceGathering(conn);
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
          const failure = withIceServerFailure(conn, asError(err), false);
          conn.close();
          reject(failure);
        });
      const onAbort = () =>
        settle(() => {
          conn.close();
          reject(new Error("dialing the inviter was aborted"));
        });
      const timer = setTimeout(
        () =>
          settle(() => {
            const failure = withIceServerFailure(
              conn,
              new Error("timed out opening a connection to the inviter"),
              attemptTimeoutMs >= openTimeoutMs,
            );
            conn.close();
            reject(failure);
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
        throw new PartnerNoShowError(
          "timed out waiting for the inviter to come online",
        );
      // Clamp the per-attempt open timeout to the remaining budget so an attempt
      // started near the deadline cannot run up to openTimeoutMs past it: the
      // total budget is the hard ceiling, shared with the inviter's inbound wait.
      const attempt = await runAttempt(Math.min(openTimeoutMs, remaining));
      if (attempt.outcome === "open") return attempt.conn;
      if (Date.now() + retryDelayMs >= deadline)
        throw new PartnerNoShowError(
          "timed out waiting for the inviter to come online",
        );
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
 *                      `relay` is the relay this run gathers against, none when
 *                      absent; `peerFactory` injects the {@link Peer}
 *                      constructor for testing; the `*Ms` overrides tune the
 *                      registration bound and the retry timing.
 */
export async function dialAsAcceptor(
  sharedSecret: string,
  endpoint: WebRTCEndpoint,
  options?: {
    signal?: AbortSignal;
    relay?: RelayLocator;
    peerFactory?: PeerFactory;
    registrationTimeoutMs?: number;
    retryDelayMs?: number;
    openTimeoutMs?: number;
    totalTimeoutMs?: number;
  },
): Promise<[Peer, DataConnection]> {
  const makePeer = options?.peerFactory ?? defaultPeerFactory;
  const signal = options?.signal;
  const [inviterId, acceptorId, iceServers] = await Promise.all([
    deriveRendezvousPeerId(sharedSecret, "inviter"),
    deriveRendezvousPeerId(sharedSecret, "acceptor"),
    buildIceServers(options?.relay, sharedSecret, new Date()),
  ]);
  const loc = acceptorLocationFromEndpoint(endpoint);
  // Derived ids are rendezvous addresses that correlate exchanges; keep them
  // out of default (info) logs and show them only at debug for connection
  // triage. The host/port come from the partner's invitation endpoint
  // (`acceptorLocationFromEndpoint`), so dev-gate this line: a production
  // console contains no partner-influenced bytes, while a developer or a
  // diagnosing tester still gets the dial target.
  whenDiagnostic(() =>
    log.info(`dialing the inviter at ${loc.host}:${loc.port}`),
  );
  log.debug(`derived peer ids: inviter ${inviterId}, acceptor ${acceptorId}`);
  const peer = makePeer(
    acceptorId,
    buildPeerOptions(loc, [inviterId, acceptorId], iceServers),
  );
  try {
    await waitForPeerOpen(peer, {
      signal,
      timeoutMs:
        options?.registrationTimeoutMs ?? BROKER_REGISTRATION_TIMEOUT_MS,
    });
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
