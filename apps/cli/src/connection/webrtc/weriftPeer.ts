import {
  chainDetailCauses,
  ConnectionError,
  UsageError,
  deriveRendezvousPeerId,
  getLogger,
  redactAndSanitizeForDisplay,
} from "@psilink/core";

import { REPORT_LIBRARY_INCOMPATIBILITY } from "../libraryIncompatibility";
import { BROKER_MESSAGE, connectToBroker } from "./brokerClient";
import {
  describeSelectedCandidatePair,
  iceFailureDetails,
  readIceStats,
} from "./iceDiagnostics";
import { PEERJS_SERIALIZATION } from "./peerjsWire";

import type {
  BrokerClient,
  BrokerLocation,
  BrokerMessage,
} from "./brokerClient";
import type { RendezvousRole, WebRTCConnectionConfig } from "@psilink/core";
import type {
  RTCDataChannel,
  RTCIceCandidate,
  RTCIceServer,
  RTCPeerConnection,
} from "werift";

/**
 * Negotiation: a werift `RTCPeerConnection` brought to an open data channel
 * against a peer reached through the PeerJS broker.
 *
 * The two roles are asymmetric and fixed by what the web app already does, so a
 * CLI peer can meet a browser one. The ACCEPTOR dials: it creates the data
 * channel, offers, and re-offers until it is answered. The INVITER listens: it
 * waits for an offer, answers it, and takes the channel the remote created.
 * Both derive the same pair of rendezvous ids from the shared secret
 * (`deriveRendezvousPeerId`), so neither has to be told the other's address.
 *
 * Three measured werift behaviours shape this module -- local candidates are
 * queued until this side's description is sent to the broker, a configured
 * `iceServers` list replaces rather than extends werift's built-in STUN
 * default, and the broker drops an undeliverable offer silently, so the
 * dialer re-offers on a timer -- each with its assumptions and
 * re-verification in docs/spec/DEPENDENCY_PINS.md.
 */

const log = getLogger("webrtc");

/** Prefix PeerJS gives a DataConnection id, matched so a browser peer's logs read normally. */
const CONNECTION_ID_PREFIX = "dc_";

/**
 * Longest connectionId this side adopts from an offer. A real PeerJS
 * DataConnection id is a short `dc_<random>` string; this side echoes the
 * adopted id on every ANSWER and CANDIDATE it sends, so an over-long one from a
 * counterparty would push those outbound frames past the broker's inbound
 * `maxPayload` and get this side's socket closed -- a remote-triggered
 * rendezvous failure. An offered id that is not this short shape is not a PeerJS
 * peer's, so it is ignored and this side keeps the id it generated.
 */
export const MAX_CONNECTION_ID_LENGTH = 64;

/**
 * How many remote candidates are held while this side's description is not yet
 * applied. A candidate that arrives early is queued until the description can
 * apply it; a peer -- or a hostile broker registered under the derived id --
 * that never sends its OFFER/ANSWER could otherwise stream CANDIDATE frames for
 * the whole rendezvous budget and have every one retained, the one inbound
 * signaling path with no memory envelope. A real negotiation trickles at most a
 * few dozen candidates (one per interface, per address family, per configured
 * STUN/TURN), so this sits comfortably above any legitimate volume and bites
 * only a flood.
 */
export const MAX_PENDING_REMOTE_CANDIDATES = 128;

/** How often the dialer re-sends its offer while the peer has not answered. */
export const DEFAULT_OFFER_RETRY_INTERVAL_MS = 1_000;

/**
 * Total budget for the two parties to find each other. Human-timescale: one
 * operator's exchange may start well before the other's, and this is the same
 * ceiling the web app gives its own rendezvous wait.
 */
export const DEFAULT_RENDEZVOUS_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Ceiling on the data channel opening once both descriptions are exchanged.
 * Reaching it means the peer is present and negotiating but no candidate pair
 * ever worked -- a network path problem, not a peer that has not arrived -- so
 * it fails rather than restarting the rendezvous.
 */
export const DEFAULT_CHANNEL_OPEN_TIMEOUT_MS = 30_000;

/**
 * The STUN server a peer connection built with no `iceServers` list gathers
 * against. It is werift's own built-in, not a psilink choice, so the value is
 * established by driving the library rather than by reading it: the integration
 * suite resolves this host to loopback and watches the real peer's STUN binding
 * request arrive on this port (`test/integration/webrtc/transport.test.ts`).
 *
 * An operator is told this endpoint before they hand a recurring exchange's
 * secret to a scheduler, so a stale copy of it is a false confidentiality
 * statement rather than a typo. Every copy outside this workspace -- the web
 * app's command-line export panel, which may not import across apps, and the
 * docs that state the default -- is held to this value by
 * `npm run check:stun-default-claims`.
 */
export const WERIFT_BUILT_IN_STUN_URI = "stun:stun.l.google.com:19302";

/** The warning line emitted when no ICE servers are configured (see below). */
export const NO_ICE_SERVERS_WARNING =
  "no ICE servers are configured for this webrtc connection, so the built-in " +
  `default (${WERIFT_BUILT_IN_STUN_URI}) will be used to discover this ` +
  "host's public address. That address, and the fact of a session, are " +
  "disclosed to that server; no exchange content is. Set `stun` (or `turn`) " +
  "on the connection to use your own server instead, or set a single " +
  "unreachable `stun` entry to gather host candidates only, which costs about " +
  "five seconds of gathering and works only where both parties share a network.";

/** The warning line emitted when the signaling socket is plaintext (see below). */
export const PLAINTEXT_SIGNALING_WARNING =
  "this webrtc connection sets `secure: false`, so signaling runs over a " +
  "plain `ws:` socket: the rendezvous ids derived from the invitation " +
  "secret, both parties' session descriptions, and the candidate addresses " +
  "they gather all cross the network in the clear, disclosing each party's " +
  "network location to anything on the path and letting it disrupt the " +
  "rendezvous. No exchange content is disclosed -- the two parties " +
  "authenticate each other directly and the data channel is encrypted end " +
  "to end regardless. Omit `secure` or set it to true to use TLS, which is " +
  "the default; leave it false only for a broker you reach without a " +
  "network in between, such as one on the same machine.";

/** A peer session: the open channel, and the teardown for everything under it. */
export interface WebRtcPeerSession {
  /** The open, reliable, ordered data channel. */
  channel: RTCDataChannel;
  /**
   * Whether the underlying peer connection is still up. Read by the clean
   * close's outbound drain, which exists to get a final frame to a LIVE peer:
   * once the peer has gone there is nothing left to drain to, and waiting on an
   * acknowledgement that will never come would turn a lost peer into a hang.
   */
  isConnected: () => boolean;
  /**
   * Whether the peer has ACKNOWLEDGED every byte handed to the channel. What a
   * clean close waits on before it tears anything down; see
   * {@link SctpDrainInternals} for why the channel's own `bufferedAmount` is not
   * that condition.
   */
  outboundAcknowledged: () => boolean;
  /**
   * Whether every byte handed to the channel has at least been TRANSMITTED,
   * acknowledged or not. The weaker condition, and the only one available for
   * the close sentinel itself: a peer closes on receiving it, so it stops
   * acknowledging at exactly that point and waiting for an acknowledgement of
   * the sentinel would always spend the whole close budget.
   */
  outboundTransmitted: () => boolean;
  /**
   * Install the handler called when the peer connection leaves the connected
   * state. The only signal a party gets that its partner has gone without
   * saying so: werift does not raise the data channel's own `close` when the
   * remote peer connection is torn down, so a consumer waiting on the channel
   * alone would wait out its inactivity budget instead. werift's
   * consent-freshness check reaches this in about thirty seconds.
   */
  onDisconnected: (handler: () => void) => void;
  /** Tear down the channel, the peer connection and the broker socket. Idempotent. */
  close: () => Promise<void>;
}

/**
 * The two SCTP association queues that stand between a handed-off message and
 * the peer having it: `outboundQueue` holds chunks not yet transmitted, and
 * `sentQueue` holds chunks transmitted but not yet acknowledged. Both empty is
 * the only observable point at which tearing the connection down cannot lose
 * data; the channel's own `bufferedAmount` is not a refinement of that and
 * loses data if used instead. This reaches past werift's public API, which is
 * why werift is exact-pinned -- the measurement behind it and its
 * re-verification: docs/spec/DEPENDENCY_PINS.md.
 */
interface SctpDrainInternals {
  sctp: { sctp: { outboundQueue: Array<unknown>; sentQueue: Array<unknown> } };
}

/** Read the association's queues, or `undefined` if they are not as expected. */
function sctpQueues(
  peer: RTCPeerConnection,
): { outbound: number; sent: number } | undefined {
  const association = (peer as unknown as Partial<SctpDrainInternals>).sctp
    ?.sctp;
  if (association === undefined) return undefined;
  const { outboundQueue, sentQueue } = association;
  if (!Array.isArray(outboundQueue) || !Array.isArray(sentQueue))
    return undefined;
  return { outbound: outboundQueue.length, sent: sentQueue.length };
}

/**
 * Assert the SCTP queues {@link sctpOutboundAcknowledged} reads are present.
 * Encodes the dependency assumption as a check rather than a comment: without
 * these the clean close has no acknowledgement to wait on, and a final frame is
 * lost silently. Called once the channel is open, where the association exists.
 *
 * @throws {ConnectionError} of kind `usage` if the internals are not as expected.
 */
export function assertSctpDrainSupported(peer: RTCPeerConnection): void {
  if (sctpQueues(peer) !== undefined) return;
  log.debug(
    "the installed werift does not expose sctp.sctp.outboundQueue / " +
      "sentQueue, which the flushing close waits on",
  );
  throw new ConnectionError(
    "the installed WebRTC library does not support the clean close this " +
      "exchange needs, so a final message could be lost when the connection " +
      "closes. This build of psilink is not compatible with that library; " +
      `${REPORT_LIBRARY_INCOMPATIBILITY}.`,
    "usage",
  );
}

/**
 * Has the peer acknowledged everything handed to the channel?
 *
 * `assertSctpDrainSupported` guarantees the queues are readable at channel
 * open, not for the rest of the session, so `queues === undefined` here is
 * reachable -- chiefly once the association behind them has been torn down.
 * At that point there is no further acknowledgement this side could wait on
 * anyway, so `true` is the answer by design: the close's own liveness checks
 * (`channel.readyState`, `session.isConnected()` in `drainOutbound`) are what
 * decide when a torn-down peer stops being worth waiting for, not this
 * fallback.
 *
 * @internal exported for testing
 */
export function sctpOutboundAcknowledged(peer: RTCPeerConnection): boolean {
  const queues = sctpQueues(peer);
  if (queues === undefined) return true;
  return queues.outbound === 0 && queues.sent === 0;
}

/**
 * Has everything handed to the channel at least been put on the wire? Same
 * `queues === undefined` fallback as {@link sctpOutboundAcknowledged}, for
 * the same reason.
 *
 * @internal exported for testing
 */
export function sctpOutboundTransmitted(peer: RTCPeerConnection): boolean {
  const queues = sctpQueues(peer);
  if (queues === undefined) return true;
  return queues.outbound === 0;
}

export interface WebRtcPeerOptions {
  /** Where the signaling broker lives. */
  location: BrokerLocation;
  /** Which end of the rendezvous this party is. */
  role: RendezvousRole;
  /** The invitation's shared secret; both rendezvous ids derive from it. */
  sharedSecret: string;
  /** ICE servers, already resolved. Empty or absent selects werift's default. */
  iceServers?: Array<RTCIceServer>;
  offerRetryIntervalMs?: number;
  rendezvousTimeoutMs?: number;
  channelOpenTimeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Constructs the peer connection; injected so a unit test can assert the
   * configuration it is handed without standing up ICE.
   */
  peerConnectionFactory?: (configuration: {
    iceServers?: Array<RTCIceServer>;
  }) => RTCPeerConnection;
  /**
   * Constructs the broker socket; forwarded to {@link connectToBroker} so a
   * unit test can drive the whole negotiation -- which frame goes out when --
   * against a scripted broker.
   */
  socketFactory?: (url: string) => WebSocket;
}

/**
 * PeerJS API key the vendored broker (and the public PeerJS cloud) serves under,
 * used when the connection names none.
 */
export const DEFAULT_BROKER_KEY = "peerjs";

/**
 * The refusal a `server.host` whose shape could move the signaling socket gets.
 * Names the field and the class of character rather than echoing the value: the
 * value is partner-supplied on an invitation-seeded connection and bounded only
 * by length, so echoing it would spend the display boundary's per-link budget
 * the remedy needs.
 */
export const WEBRTC_BROKER_HOST_REFUSED =
  "this webrtc connection's server `host` could move the signaling socket to " +
  "another server: it must include none of @ / ? # \\ or whitespace. Set `host` " +
  "to the hostname alone, with the port in `port` and the mount point in `path`.";

/** The refusal a `server.path` whose shape could move the signaling socket gets. */
export const WEBRTC_BROKER_PATH_REFUSED =
  "this webrtc connection's server `path` could move the signaling socket to " +
  'another server: it must start with "/" and include none of @ ? # \\ or ' +
  "whitespace. Set `path` to the broker's mount point, such as `/` or `/psi`.";

/**
 * Refused anywhere in a `host`. Each is a delimiter the URL parser acts on: `@`
 * closes an authority's userinfo, `/` `?` and `#` end the host, `\` folds to
 * `/`, and whitespace either ends the parse or is stripped. None of them appears
 * in a hostname or an IP literal.
 */
const HOST_AUTHORITY_DELIMITERS = /[@/?#\\]|\s/;

/**
 * Refused anywhere in a `path`, which is {@link HOST_AUTHORITY_DELIMITERS} less
 * the separator a path is made of. A leading `/` is required separately: a value
 * without one is not a mount point, and where it lands depends on how the
 * address is assembled rather than on what the field means.
 */
const PATH_AUTHORITY_DELIMITERS = /[@?#\\]|\s/;

/**
 * Resolve a webrtc connection's `server` block into the broker location the
 * signaling socket dials.
 *
 * Every default here is the one a PeerJS client applies to the same omission, so
 * a connection block authored against a PeerJS deployment's documentation
 * reaches the same socket from the CLI: the root path, the `peerjs` API key, and
 * the scheme's standard port. The exception is `secure`, which a browser client
 * infers from the page it was served over and the CLI cannot -- see
 * {@link WebRTCServer.secure} for why an omitted value is TLS.
 *
 * It is also where `host` and `path` are refused for shape, since both routes
 * here -- an operator's `psilink.yaml` and the invitation endpoint an offline
 * accept persists -- can hold a partner-supplied value; the refused
 * characters and both routes are recorded in docs/spec/WEBRTC_TRANSPORT.md.
 * `key` needs no equivalent refusal: it cannot appear on an invitation
 * endpoint and is encoded as a query parameter.
 *
 * A location that resolves to plaintext warns rather than refuses, here
 * because this is the one place the choice becomes a socket the run will
 * dial; what that discloses is recorded in docs/CLI.md.
 *
 * @throws {UsageError} if the configured port is not a dialable 1-65535 value,
 *   or if `host` or `path` has a shape that could move the authority.
 */
export function brokerLocationFromConnection(
  server: WebRTCConnectionConfig["server"],
  warn: (message: string) => void = (message) => log.warn(message),
): BrokerLocation {
  const secure = server.secure ?? true;
  // The connection schema admits port 0 (an OS-assigned ephemeral port) because
  // it is a legal port number; nothing listens on it, so refuse it here with the
  // field named rather than dial `:0` and report a connect failure.
  if (server.port !== undefined && (server.port < 1 || server.port > 65535))
    throw new UsageError(
      `this webrtc connection's server port (${server.port}) is not a ` +
        "dialable port; set `port` to a value between 1 and 65535, or omit it " +
        `to use the default (${secure ? 443 : 80})`,
    );
  if (HOST_AUTHORITY_DELIMITERS.test(server.host))
    throw new UsageError(WEBRTC_BROKER_HOST_REFUSED);
  const path = server.path ?? "/";
  if (!path.startsWith("/") || PATH_AUTHORITY_DELIMITERS.test(path))
    throw new UsageError(WEBRTC_BROKER_PATH_REFUSED);
  // Past the refusals, so a connection that fails to resolve at all gets its
  // refusal alone rather than a warning about a socket nothing will dial.
  if (!secure) warn(PLAINTEXT_SIGNALING_WARNING);
  return {
    host: server.host,
    port: server.port ?? (secure ? 443 : 80),
    path,
    key: server.key ?? DEFAULT_BROKER_KEY,
    secure,
  };
}

/**
 * Resolve a webrtc connection's configured `stun`/`turn` entries into the ICE
 * server list the peer connection is built with.
 *
 * An `iceProvision` block is refused rather than ignored: it names servers the
 * operator meant to use, and silently falling back to the built-in default
 * would be a downgrade they never chose.
 *
 * @throws {UsageError} if the connection configures `iceProvision`.
 */
export function iceServersFromConnection(
  connection: Pick<WebRTCConnectionConfig, "stun" | "turn" | "iceProvision">,
): Array<RTCIceServer> {
  if (connection.iceProvision !== undefined) {
    throw new UsageError(
      "this webrtc connection configures `ice_provision`, which the CLI does " +
        "not support: list the servers directly under `stun` and `turn` instead",
    );
  }
  const servers: Array<RTCIceServer> = [];
  if (connection.stun !== undefined && connection.stun.length > 0) {
    servers.push({ urls: [...connection.stun] });
  }
  for (const turn of connection.turn ?? []) {
    // `credential_type: hmac-sha1` describes how a deployment MINTS a
    // time-limited credential, not how a client presents it: the minted value
    // is still sent as the password, so both types take the same shape here.
    servers.push({
      urls: turn.url,
      username: turn.username,
      credential: turn.credential,
    });
  }
  return servers;
}

/**
 * The configuration object the peer connection is constructed with, and the
 * point the no-servers warning is emitted from.
 *
 * An empty list is NOT passed through as an empty list: to werift an empty
 * `iceServers` and an absent one both mean "use the built-in default", so
 * omitting it keeps the two from looking different when they are not. Both arms
 * are driven in webrtcIceConfiguration.test.ts -- an empty list and no list each
 * yield `{}` with the warning, and a non-empty list is passed verbatim, which is
 * what makes it, and not the default, the list actually used. What werift falls
 * back to when it is given neither is measured by the integration suite.
 */
export function buildPeerConfiguration(
  iceServers: Array<RTCIceServer> | undefined,
  warn: (message: string) => void = (message) => log.warn(message),
): { iceServers?: Array<RTCIceServer> } {
  if (iceServers === undefined || iceServers.length === 0) {
    warn(NO_ICE_SERVERS_WARNING);
    return {};
  }
  return { iceServers };
}

/**
 * Construct werift's peer connection, loading the library at the point of use.
 *
 * The import is deferred rather than static because it is not free: werift and
 * its dependency tree cost the CLI bundle roughly 0.3 s to load, and the CLI
 * bundles to a single CommonJS file whose external `require`s all run at
 * startup -- so a static import here would put that cost on every invocation,
 * `psilink --version` included, for a channel most runs never open. The
 * measurement and its basis are recorded once, at the lint rule that holds
 * this deferral: the `no-restricted-syntax` entry banning a value import (or
 * re-export) of werift across `apps/cli/src` (eslint.config.mjs).
 */
async function defaultPeerConnection(configuration: {
  iceServers?: Array<RTCIceServer>;
}): Promise<RTCPeerConnection> {
  const werift = await import("werift");
  return new werift.RTCPeerConnection(configuration);
}

/** A fresh PeerJS-shaped DataConnection id. */
function newConnectionId(): string {
  return `${CONNECTION_ID_PREFIX}${Math.random().toString(36).slice(2)}`;
}

/**
 * The connectionId this side adopts from an offer, or `undefined` to keep its
 * own. A PeerJS id is a short run of URL-safe characters; anything longer than
 * {@link MAX_CONNECTION_ID_LENGTH} or outside that alphabet is not one, and is
 * refused rather than echoed back on every outbound frame.
 */
function adoptableConnectionId(offered: unknown): string | undefined {
  if (typeof offered !== "string") return undefined;
  if (offered.length === 0 || offered.length > MAX_CONNECTION_ID_LENGTH)
    return undefined;
  if (!/^[A-Za-z0-9_-]+$/.test(offered)) return undefined;
  return offered;
}

/** The `{type, sdp}` a broker payload holds, if it holds one. */
function sessionDescriptionFrom(
  payload: unknown,
): { type: "offer" | "answer"; sdp: string } | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const sdp = (payload as { sdp?: unknown }).sdp;
  if (typeof sdp !== "object" || sdp === null) return undefined;
  const { type, sdp: text } = sdp as { type?: unknown; sdp?: unknown };
  if ((type !== "offer" && type !== "answer") || typeof text !== "string")
    return undefined;
  return { type, sdp: text };
}

/**
 * The plain object form of a locally-gathered candidate, as a `CANDIDATE`
 * payload holds it. werift's `RTCIceCandidate` is a class instance whose
 * `toJSON` produces exactly the browser-shaped
 * `{candidate, sdpMid, sdpMLineIndex, usernameFragment}` a PeerJS peer expects,
 * so the conversion goes through it rather than reading the fields off the
 * instance -- one place for the wire shape, and it stays right if werift adds a
 * field.
 */
function candidateToPayload(
  candidate: RTCIceCandidate,
): Record<string, unknown> {
  return { ...candidate.toJSON() };
}

/** The candidate object a CANDIDATE payload holds, if it holds one. */
function candidateFrom(payload: unknown): Record<string, unknown> | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const candidate = (payload as { candidate?: unknown }).candidate;
  if (typeof candidate !== "object" || candidate === null) return undefined;
  return candidate as Record<string, unknown>;
}

/**
 * Bring up a data channel to the rendezvous peer, resolving once it is open.
 *
 * Every failure path tears down what it built -- the channel, the peer
 * connection and the broker socket -- before rejecting, so a failed rendezvous
 * leaves no registered id and no half-open connection behind.
 */
export async function openWebRtcPeerSession(
  options: WebRtcPeerOptions,
): Promise<WebRtcPeerSession> {
  const {
    location,
    role,
    sharedSecret,
    iceServers,
    offerRetryIntervalMs = DEFAULT_OFFER_RETRY_INTERVAL_MS,
    rendezvousTimeoutMs = DEFAULT_RENDEZVOUS_TIMEOUT_MS,
    channelOpenTimeoutMs = DEFAULT_CHANNEL_OPEN_TIMEOUT_MS,
    signal,
    peerConnectionFactory,
    socketFactory,
  } = options;

  const [inviterId, acceptorId] = await Promise.all([
    deriveRendezvousPeerId(sharedSecret, "inviter"),
    deriveRendezvousPeerId(sharedSecret, "acceptor"),
  ]);
  const localId = role === "inviter" ? inviterId : acceptorId;
  const remoteId = role === "inviter" ? acceptorId : inviterId;

  const configuration = buildPeerConfiguration(iceServers);
  const peer =
    peerConnectionFactory === undefined
      ? await defaultPeerConnection(configuration)
      : peerConnectionFactory(configuration);
  let broker: BrokerClient | undefined;
  let torn = false;

  const teardown = async (): Promise<void> => {
    if (torn) return;
    torn = true;
    broker?.close();
    try {
      await peer.close();
    } catch {
      // A peer connection already closed by a failure path throws on a second
      // close; the caller is on a failure path either way.
    }
  };

  const negotiation = new Negotiation({
    peer,
    role,
    remoteId,
    offerRetryIntervalMs,
    rendezvousTimeoutMs,
    channelOpenTimeoutMs,
    signal,
  });

  try {
    broker = await connectToBroker({
      location,
      id: localId,
      handlers: {
        onMessage: (message) => negotiation.onBrokerMessage(message),
        onClose: (error) => negotiation.fail(error),
      },
      signal,
      socketFactory,
    });
    const channel = await negotiation.run(broker);
    assertSctpDrainSupported(peer);
    await logSelectedCandidatePair(peer);
    // Take the state hook back off the negotiation, whose interest in it ended
    // when the channel opened.
    let onLost: (() => void) | undefined;
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === "connected") return;
      onLost?.();
    };
    return {
      channel,
      isConnected: () => peer.connectionState === "connected",
      outboundAcknowledged: () => sctpOutboundAcknowledged(peer),
      outboundTransmitted: () => sctpOutboundTransmitted(peer),
      onDisconnected: (handler) => {
        onLost = handler;
      },
      close: teardown,
    };
  } catch (err) {
    await teardown();
    throw err;
  }
}

/**
 * Report which candidate pair the open channel runs over.
 *
 * The remote candidate type is the partner's own token, so it is escaped here,
 * at the log sink, rather than composed raw (CONTRIBUTING.md, Operator-facing
 * escaping). A report that names no pair says so: an operator comparing two
 * runs learns as much from the absence as from a type.
 */
async function logSelectedCandidatePair(
  peer: RTCPeerConnection,
): Promise<void> {
  const report = await readIceStats(peer);
  if (report === undefined) {
    log.debug("the data channel opened; no ICE statistics were available");
    return;
  }
  const pair = describeSelectedCandidatePair(report);
  if (pair === undefined) {
    log.debug(
      "the data channel opened; ICE reported no selected candidate pair",
    );
    return;
  }
  log.debug(
    `the data channel opened over candidate pair ${redactAndSanitizeForDisplay(pair)}`,
  );
}

interface NegotiationOptions {
  peer: RTCPeerConnection;
  role: RendezvousRole;
  remoteId: string;
  offerRetryIntervalMs: number;
  rendezvousTimeoutMs: number;
  channelOpenTimeoutMs: number;
  signal?: AbortSignal;
}

/**
 * One rendezvous attempt's state machine, kept as a class because the broker
 * hands messages in at any point and both roles have to survive a frame
 * arriving before the step that consumes it.
 */
class Negotiation {
  private readonly options: NegotiationOptions;
  private broker: BrokerClient | undefined;
  private connectionId = newConnectionId();
  /** Local candidates gathered before this side's description reached the broker. */
  private readonly pendingLocalCandidates: Array<Record<string, unknown>> = [];
  /** Every local candidate sent so far, re-sent with each retried offer. */
  private readonly sentLocalCandidates: Array<Record<string, unknown>> = [];
  /** Remote candidates that arrived before a remote description could apply them. */
  private readonly pendingRemoteCandidates: Array<Record<string, unknown>> = [];
  private localDescriptionSent = false;
  private remoteDescriptionSet = false;
  private answered = false;
  private answerAccepted = false;
  private channel: RTCDataChannel | undefined;
  private channelOpenTimer: ReturnType<typeof setTimeout> | undefined;
  /** Set once the run has settled, after which nothing is left to time out. */
  private finished = false;
  private settle:
    | {
        resolve: (channel: RTCDataChannel) => void;
        reject: (err: unknown) => void;
      }
    | undefined;
  private failure: ConnectionError | undefined;

  constructor(options: NegotiationOptions) {
    this.options = options;
  }

  /** Latch a terminal failure; the run rejects with the first one latched. */
  fail(error: ConnectionError): void {
    if (this.failure !== undefined) return;
    this.failure = error;
    this.settle?.reject(error);
  }

  /**
   * Latch a failure of the network path, with what ICE gathered, received and
   * tried attached as labelled cause links.
   *
   * The two failures that reach here -- the peer connection reporting `failed`,
   * and the channel-open deadline -- are both "both parties are present and no
   * path formed", the case an operator can act on only once they know whether a
   * relay candidate was even gathered. The stats are collected BEFORE the
   * failure is latched, since latching it tears the peer connection down, and
   * are bounded so a diagnostic cannot hold a bounded failure open.
   */
  private async failWithIceDiagnosis(summary: string): Promise<void> {
    if (this.failure !== undefined) return;
    const report = await readIceStats(this.options.peer);
    this.fail(
      new ConnectionError(
        summary,
        "transport",
        report === undefined
          ? undefined
          : { cause: chainDetailCauses(iceFailureDetails(report)) },
      ),
    );
  }

  async run(broker: BrokerClient): Promise<RTCDataChannel> {
    this.broker = broker;
    const { peer, role, signal } = this.options;

    peer.onicecandidate = ({ candidate }) => {
      // An end-of-candidates event has no candidate and needs no frame: the
      // remote learns gathering is done from the description it already has.
      if (!candidate) return;
      this.emitLocalCandidate(candidateToPayload(candidate));
    };
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === "failed") {
        void this.failWithIceDiagnosis(
          "the peer connection failed before the data channel opened; no " +
            "network path between the two parties could be established",
        );
      }
    };

    const opened = new Promise<RTCDataChannel>((resolve, reject) => {
      this.settle = { resolve, reject };
      if (this.failure !== undefined) reject(this.failure);
    });
    // Keep the rejection handled from the instant the promise exists, before
    // the acceptor's `await this.offer()` below yields the turn: a failure
    // latched through fail() in that window rejects `opened` while nothing is
    // awaiting it yet, which would otherwise be an unhandled rejection that
    // terminates the process. `await opened` below still exposes the latched
    // failure -- this handler only keeps the interim rejection from going
    // unhandled.
    opened.catch(() => {});

    if (role === "acceptor") {
      const channel = peer.createDataChannel(this.connectionId, {
        ordered: true,
      });
      this.watchChannel(channel);
      await this.offer();
      this.startOfferRetries();
    } else {
      peer.ondatachannel = ({ channel }) => this.watchChannel(channel);
    }

    // The rendezvous owns the signal from here: the broker client releases its
    // own abort listener the moment the registration is confirmed, so this is
    // the only thing watching it and this is the phase an abort is now reported
    // as. The re-check runs first because the acceptor's offer above yields the
    // turn -- werift gathers as it describes -- and an abort landing in that
    // window reaches no listener at all; without it that run would sit out the
    // whole rendezvous budget after the operator had already interrupted it.
    const abort = (): void =>
      this.fail(
        new ConnectionError("the WebRTC rendezvous was cancelled", "closed"),
      );
    if (signal?.aborted) abort();
    signal?.addEventListener("abort", abort, { once: true });

    const rendezvousTimer = setTimeout(
      () =>
        this.fail(
          new ConnectionError(
            `the exchange partner did not ` +
              `${role === "acceptor" ? "answer" : "offer"} within ` +
              `${this.options.rendezvousTimeoutMs}ms`,
            "transport",
          ),
        ),
      this.options.rendezvousTimeoutMs,
    );

    try {
      return await opened;
    } finally {
      this.finished = true;
      clearTimeout(rendezvousTimer);
      this.stopChannelOpenDeadline();
      this.stopOfferRetries();
      signal?.removeEventListener("abort", abort);
    }
  }

  onBrokerMessage(message: BrokerMessage): void {
    // Once the run has settled -- the channel opened, or a terminal failure was
    // latched -- the negotiation has no further use for broker traffic. Dropping
    // it here stops a post-open OFFER from reflecting a fresh full-SDP ANSWER
    // back through the broker, and a post-open CANDIDATE from being fed to the
    // peer, for the remaining lifetime of the session.
    if (this.finished || this.failure !== undefined) return;
    // Only the derived peer id is a legitimate source, and the honest broker
    // always stamps `src` on a relayed frame, so a frame holding none is not
    // peer traffic and is dropped. A third party would have to know an id
    // derived from the invitation secret to reach here at all, so this is depth
    // rather than the primary control -- but it means a stray, planted, or
    // src-less frame cannot perturb a live negotiation.
    if (message.src !== this.options.remoteId) return;
    void this.handle(message).catch((err: unknown) =>
      this.fail(
        err instanceof ConnectionError
          ? err
          : new ConnectionError(
              "the WebRTC negotiation failed while applying a signaling frame",
              "transport",
              { cause: err },
            ),
      ),
    );
  }

  private async handle(message: BrokerMessage): Promise<void> {
    switch (message.type) {
      case BROKER_MESSAGE.offer:
        await this.onOffer(message);
        return;
      case BROKER_MESSAGE.answer:
        await this.onAnswer(message);
        return;
      case BROKER_MESSAGE.candidate:
        await this.onCandidate(message);
        return;
      case BROKER_MESSAGE.leave:
        this.fail(
          new ConnectionError(
            "the exchange partner left the signaling server before the " +
              "connection was established",
            "transport",
          ),
        );
        return;
      default:
        return;
    }
  }

  private async onOffer(message: BrokerMessage): Promise<void> {
    if (this.options.role !== "inviter") return;
    const description = sessionDescriptionFrom(message.payload);
    if (description === undefined || description.type !== "offer") return;
    if (this.answered) {
      // The dialer re-offers until it is answered, so a repeat means its answer
      // did not land yet rather than a renegotiation; re-send rather than
      // rebuild, which would discard the connection already forming.
      this.resendAnswer();
      return;
    }
    this.answered = true;
    const offeredId = adoptableConnectionId(
      (message.payload as { connectionId?: unknown }).connectionId,
    );
    if (offeredId !== undefined) this.connectionId = offeredId;
    const { peer } = this.options;
    await peer.setRemoteDescription({ type: "offer", sdp: description.sdp });
    this.markRemoteDescriptionSet();
    await this.applyPendingRemoteCandidates();
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    this.sendAnswer();
  }

  private async onAnswer(message: BrokerMessage): Promise<void> {
    if (
      this.options.role !== "acceptor" ||
      this.answerAccepted ||
      this.remoteDescriptionSet
    )
      return;
    const description = sessionDescriptionFrom(message.payload);
    if (description === undefined || description.type !== "answer") return;
    // Latch synchronously before the first await, mirroring onOffer's
    // `answered`. `remoteDescriptionSet` is only set after setRemoteDescription
    // resolves, so without this latch two ANSWERs delivered in one tick both
    // pass the guard and both call setRemoteDescription; werift's throw on the
    // second is caught as a terminal failure, letting a counterparty fail the
    // acceptor's rendezvous by answering twice.
    this.answerAccepted = true;
    this.stopOfferRetries();
    await this.options.peer.setRemoteDescription({
      type: "answer",
      sdp: description.sdp,
    });
    this.markRemoteDescriptionSet();
    await this.applyPendingRemoteCandidates();
  }

  /**
   * Record that the peer's description is applied. Routed through one method so
   * the flag cannot be set without arming what waits on it.
   */
  private markRemoteDescriptionSet(): void {
    this.remoteDescriptionSet = true;
    this.armChannelOpenDeadline();
  }

  private async onCandidate(message: BrokerMessage): Promise<void> {
    const candidate = candidateFrom(message.payload);
    if (candidate === undefined) return;
    if (!this.remoteDescriptionSet) {
      // Bounded, and past the cap the surplus is dropped rather than failing the
      // rendezvous: a legitimate late description still applies the ones held,
      // and a peer that only floods candidates cannot grow this without bound.
      // Dropping is silent -- logging per candidate would itself be a log-flood
      // vector, the same reason inboundBounds.ts evicts silently.
      if (this.pendingRemoteCandidates.length < MAX_PENDING_REMOTE_CANDIDATES) {
        this.pendingRemoteCandidates.push(candidate);
      }
      return;
    }
    await this.addRemoteCandidate(candidate);
  }

  private async applyPendingRemoteCandidates(): Promise<void> {
    for (const candidate of this.pendingRemoteCandidates.splice(0)) {
      await this.addRemoteCandidate(candidate);
    }
  }

  /**
   * Apply one remote candidate, absorbing a parse failure. werift throws a
   * `DOMException` on a candidate string it cannot parse; one unusable
   * candidate out of a set is not a reason to fail a rendezvous the remaining
   * candidates may still complete, and a peer that sends only bad ones fails on
   * the connection-state or rendezvous deadline instead.
   */
  private async addRemoteCandidate(
    candidate: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.options.peer.addIceCandidate(candidate);
    } catch {
      // Silent by design: logging per candidate would let a peer that sprays
      // malformed candidates drive the operator's console.
    }
  }

  private async offer(): Promise<void> {
    const { peer } = this.options;
    const description = await peer.createOffer();
    await peer.setLocalDescription(description);
    const local = peer.localDescription;
    if (local === undefined || local === null) {
      throw new ConnectionError(
        "the local session description was not available after it was set",
        "transport",
      );
    }
    this.broker?.send({
      type: BROKER_MESSAGE.offer,
      dst: this.options.remoteId,
      payload: {
        sdp: { type: local.type, sdp: local.sdp },
        type: "data",
        connectionId: this.connectionId,
        metadata: null,
        label: this.connectionId,
        reliable: true,
        serialization: PEERJS_SERIALIZATION,
      },
    });
    this.flushLocalCandidates();
  }

  private sendAnswer(): void {
    const local = this.options.peer.localDescription;
    if (local === undefined || local === null) return;
    this.broker?.send({
      type: BROKER_MESSAGE.answer,
      dst: this.options.remoteId,
      payload: {
        sdp: { type: local.type, sdp: local.sdp },
        type: "data",
        connectionId: this.connectionId,
      },
    });
    this.flushLocalCandidates();
  }

  private resendAnswer(): void {
    this.sendAnswer();
    for (const candidate of this.sentLocalCandidates) {
      this.sendCandidate(candidate);
    }
  }

  private offerRetryTimer: ReturnType<typeof setInterval> | undefined;

  /**
   * Re-send the offer, and every candidate already gathered, on a timer. The
   * broker drops a message addressed to a peer that is not registered and says
   * nothing about it, so a dialer that offered before its partner arrived has no
   * signal to wait on -- only a repeat that lands once the partner is there. A
   * repeat has the same connection id, which a browser PeerJS peer that
   * already has the connection ignores.
   */
  private startOfferRetries(): void {
    this.offerRetryTimer = setInterval(() => {
      if (this.remoteDescriptionSet || this.failure !== undefined) return;
      void this.offer().catch((err: unknown) =>
        this.fail(
          err instanceof ConnectionError
            ? err
            : new ConnectionError(
                "the WebRTC offer could not be re-sent to the exchange partner",
                "transport",
                { cause: err },
              ),
        ),
      );
      for (const candidate of this.sentLocalCandidates) {
        this.sendCandidate(candidate);
      }
    }, this.options.offerRetryIntervalMs);
  }

  private stopOfferRetries(): void {
    if (this.offerRetryTimer === undefined) return;
    clearInterval(this.offerRetryTimer);
    this.offerRetryTimer = undefined;
  }

  /**
   * Hold a locally-gathered candidate until this side's description is on the
   * broker. A candidate that arrives at a browser PeerJS peer before the
   * description it belongs to is handed straight to `addIceCandidate` and lost,
   * with no signal back -- and werift's SDP-inlined candidates would hide the
   * loss until the inlined set was not enough.
   */
  private emitLocalCandidate(candidate: Record<string, unknown>): void {
    if (!this.localDescriptionSent) {
      this.pendingLocalCandidates.push(candidate);
      return;
    }
    this.sendCandidate(candidate);
    this.sentLocalCandidates.push(candidate);
  }

  private flushLocalCandidates(): void {
    this.localDescriptionSent = true;
    for (const candidate of this.pendingLocalCandidates.splice(0)) {
      this.sendCandidate(candidate);
      this.sentLocalCandidates.push(candidate);
    }
  }

  private sendCandidate(candidate: Record<string, unknown>): void {
    this.broker?.send({
      type: BROKER_MESSAGE.candidate,
      dst: this.options.remoteId,
      payload: {
        candidate,
        type: "data",
        connectionId: this.connectionId,
      },
    });
  }

  /** Resolve the run once `channel` opens, bounded by the open deadline. */
  private watchChannel(channel: RTCDataChannel): void {
    if (this.channel !== undefined) return;
    this.channel = channel;
    const settleOpen = (): void => {
      this.stopChannelOpenDeadline();
      this.stopOfferRetries();
      this.settle?.resolve(channel);
    };
    if (channel.readyState === "open") {
      settleOpen();
      return;
    }
    channel.onopen = settleOpen;
    channel.onclose = () => {
      this.stopChannelOpenDeadline();
      this.fail(
        new ConnectionError(
          "the data channel closed before it opened",
          "transport",
        ),
      );
    };
    this.armChannelOpenDeadline();
  }

  /**
   * Start the ceiling on the channel opening, once both the channel exists
   * and the peer's description is applied -- the point at which the peer is
   * known to be present and negotiating.
   *
   * The dialer creates its channel before it has even offered, so arming here
   * instead would spend the network-path ceiling waiting for a partner who
   * has not started yet; that wait belongs to the rendezvous budget, not
   * this one.
   */
  private armChannelOpenDeadline(): void {
    if (this.finished || this.channelOpenTimer !== undefined) return;
    if (this.channel === undefined || !this.remoteDescriptionSet) return;
    this.channelOpenTimer = setTimeout(
      () =>
        void this.failWithIceDiagnosis(
          `the data channel did not open within ` +
            `${this.options.channelOpenTimeoutMs}ms after the exchange ` +
            "partner's session description arrived",
        ),
      this.options.channelOpenTimeoutMs,
    );
  }

  private stopChannelOpenDeadline(): void {
    if (this.channelOpenTimer === undefined) return;
    clearTimeout(this.channelOpenTimer);
    this.channelOpenTimer = undefined;
  }
}
