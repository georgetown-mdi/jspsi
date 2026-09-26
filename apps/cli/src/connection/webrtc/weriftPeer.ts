import logLibrary from "loglevel";

import {
  authorityMovingSignalingField,
  chainDetailCauses,
  ConnectionError,
  InternalConsistencyError,
  UsageError,
  deriveRendezvousPeerId,
  getLogger,
  mintRunRelayCredential,
  RELAY_CREDENTIAL_MAX_TTL_SECONDS,
  redactAndSanitizeForDisplay,
  selectRunRelay,
} from "@alcove/core";

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
import type { IceTransportPolicy } from "./iceDiagnostics";
import type {
  RelayCredential,
  RendezvousRole,
  WebRTCConnectionConfig,
} from "@alcove/core";
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
 * channel, offers, and offers again each time the broker reports the offer
 * expired undelivered, until it is answered. The INVITER listens: it waits for
 * an offer, answers it, and takes the channel the remote created.
 * Both derive the same pair of rendezvous ids from the shared secret
 * (`deriveRendezvousPeerId`), so neither has to be told the other's address.
 *
 * Two measured werift behaviours shape this module -- local candidates are
 * queued until this side's description is sent to the broker, and a configured
 * `iceServers` list replaces rather than extends werift's built-in STUN
 * default -- and one measured PeerJS behaviour: a second `OFFER` for a
 * connection id a browser peer holds replaces that connection. Each has its
 * assumptions and re-verification in docs/spec/DEPENDENCY_PINS.md. The broker's hold and expiry of frames for an
 * unregistered peer, which decides when the dialer offers again, is in
 * docs/spec/WEBRTC_TRANSPORT.md.
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

/**
 * How long the acceptor waits after sending its offer for an answer or the
 * broker's `EXPIRE` before sending it again anyway. The vendored broker answers
 * a frame it holds for an absent peer with `EXPIRE` within about 6 s, and one
 * it will not hold at once, but reports nothing for a frame it has handed to
 * the peer's socket: an offer delivered to a partner whose socket then drops
 * before it answers is lost unreported. This is far enough past the hold that
 * the copy it replaces is no longer held.
 */
export const DEFAULT_UNREPORTED_OFFER_RESEND_MS = 30_000;

/**
 * The least time between two sends of the acceptor's offer on the broker's
 * `EXPIRE`. The vendored broker drops a held frame within about 6 s of queuing
 * it, so an offer sent this long after the last is never held beside it. An
 * `EXPIRE` inside the interval is not dropped: every one arriving there is
 * answered by a single send when the interval ends.
 */
export const MIN_OFFER_RESEND_INTERVAL_MS = 10_000;

/**
 * How long a connection replaced by a renewal, or by an inviter following a new
 * offer, stays open and negotiable after its replacement is offered or built.
 * A browser inviter adopts the first offer it receives; its client still
 * answers later ones, but the app never uses those connections. The vendored
 * broker holds frames for a late registrant for about 5 s and delivers them
 * all when it registers, so an answer to the old offer can arrive after the
 * new one is sent. The window covers that hold, with margin.
 */
export const RENEWAL_OVERLAP_MS = 15_000;

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
 * against. It is werift's own built-in, not an Alcove choice, so the value is
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
      "closes. This build of Alcove is not compatible with that library; " +
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
  /**
   * Candidate types ICE may use. Absent leaves werift's own default (`all`).
   */
  iceTransportPolicy?: IceTransportPolicy;
  /**
   * Rebuild the peer connection from a fresh ICE server list while the partner
   * has not arrived (see {@link IceServerRenewal}). Absent, the connection
   * built from `iceServers` is kept for the whole wait.
   */
  iceServerRenewal?: IceServerRenewal;
  rendezvousTimeoutMs?: number;
  channelOpenTimeoutMs?: number;
  /** See {@link DEFAULT_UNREPORTED_OFFER_RESEND_MS}. */
  unreportedOfferResendMs?: number;
  /** How long a replaced connection stays negotiable; see {@link RENEWAL_OVERLAP_MS}. */
  renewalOverlapMs?: number;
  signal?: AbortSignal;
  /**
   * Constructs the peer connection; injected so a unit test can assert the
   * configuration it is handed without standing up ICE.
   */
  peerConnectionFactory?: (
    configuration: WeriftPeerConfiguration,
  ) => RTCPeerConnection;
  /**
   * Constructs the broker socket; forwarded to {@link connectToBroker} so a
   * unit test can drive the whole negotiation -- which frame goes out when --
   * against a scripted broker.
   */
  socketFactory?: (url: string) => WebSocket;
}

/**
 * How a rendezvous replaces an ICE server list that expires: each `afterMs`
 * the partner has not yet sent a session description, the peer connection is
 * replaced by one built from `resolve()`'s list. The acceptor offers again
 * under a new connection id, keeping the old offer answerable for
 * {@link RENEWAL_OVERLAP_MS}; the inviter, which has sent nothing yet, only
 * swaps the connection it will answer from. An inviter that answers a
 * partner's new offer also builds its replacement from `resolve()`.
 */
export interface IceServerRenewal {
  afterMs: number;
  /** `waitedMs` is how long the run has waited for its partner so far. */
  resolve: (waitedMs: number) => Promise<RenewedIceServers>;
}

/** A fresh ICE server list, and the line logged when a wait replaces the connection with it. */
export interface RenewedIceServers {
  iceServers: Array<RTCIceServer>;
  notice: string;
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
 * here -- an operator's `alcove.yaml` and the invitation endpoint an offline
 * accept persists -- can hold a partner-supplied value. The rule is core's
 * {@link authorityMovingSignalingField}, shared with the browser acceptor so
 * both refuse the same delimiters; the CLI additionally requires a bare
 * authority (no port or path in the host), which the browser does not check.
 * The refused characters and both routes are recorded in
 * docs/spec/WEBRTC_TRANSPORT.md.
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
  const path = server.path ?? "/";
  const moved = authorityMovingSignalingField({ host: server.host, path });
  if (moved === "host") throw new UsageError(WEBRTC_BROKER_HOST_REFUSED);
  if (moved === "path") throw new UsageError(WEBRTC_BROKER_PATH_REFUSED);
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
 * Resolve a webrtc connection's relay servers into the ICE server list the
 * peer connection is built with: the invitation's relay where it names one,
 * else the connection's own `stun`/`turn` entries, per kind
 * (`selectRunRelay`).
 *
 * An `iceProvision` block is refused rather than ignored: it names servers the
 * operator meant to use, and silently falling back to the built-in default
 * would be a downgrade they never chose.
 *
 * @param runRelayCredential The credential minted for this run
 *   (`relayCredentialForRun`), presented to every TURN url the invitation's
 *   relay names and to every own `turn` entry that sets no username or
 *   credential. Required when the selection holds either.
 * @throws {UsageError} if the connection configures `iceProvision`.
 * @throws {Error} if a TURN url that takes the run's credential is selected
 *   and no credential was supplied, which is a fault in the caller.
 */
export function iceServersFromConnection(
  connection: Pick<
    WebRTCConnectionConfig,
    "stun" | "turn" | "iceProvision" | "invitationRelay"
  >,
  runRelayCredential?: RelayCredential,
): Array<RTCIceServer> {
  if (connection.iceProvision !== undefined) {
    throw new UsageError(
      "this webrtc connection configures `ice_provision`, which the CLI does " +
        "not support: list the servers directly under `stun` and `turn` instead",
    );
  }
  const { stun, turn } = selectRunRelay(connection);
  const servers: Array<RTCIceServer> = [];
  if (stun !== undefined && stun.urls.length > 0) {
    servers.push({ urls: stun.urls });
  }
  const minted = (): RelayCredential => {
    if (runRelayCredential === undefined)
      throw new InternalConsistencyError(
        "iceServersFromConnection: a TURN url that takes the run's credential " +
          "is selected but no relay credential was minted for this run",
      );
    return runRelayCredential;
  };
  if (turn?.source === "invitation") {
    const { username, credential } = minted();
    for (const url of turn.urls)
      servers.push({ urls: url, username, credential });
  } else {
    for (const server of turn?.servers ?? []) {
      // `credential_type: hmac-sha1` describes how a deployment MINTS a
      // time-limited credential, not how a client presents it: the minted value
      // is still sent as the password, so both types take the same shape here.
      const { username, credential } =
        server.credential === undefined ? minted() : server;
      servers.push({ urls: server.url, username, credential });
    }
  }
  return servers;
}

/**
 * The refusal a run gets when an own `turn` entry sets no username or
 * credential and the run holds no shared secret to mint one from.
 *
 * @internal exported for testing
 */
export function turnEntryNeedsSecretMessage(url: string): string {
  return (
    `the turn entry for ${url} sets no username or credential, so its ` +
    "credential is minted from the exchange's shared secret, and this run " +
    "holds none. Establish one with 'alcove invite' and 'alcove accept', " +
    "or set username and credential on the entry."
  );
}

/**
 * Mint this run's TURN credential, or return `undefined` when the run
 * presents none. A credential is minted when the run relays through the TURN
 * urls the invitation's relay names, or through an own `turn` entry that sets
 * no username or credential: from the current shared secret, for
 * `RELAY_CREDENTIAL_MAX_TTL_SECONDS` (`mintRunRelayCredential`), and never
 * stored. Async, unlike the rest of the dial's resolution, because the key
 * derivation is.
 *
 * With no shared secret, the invitation's urls yield `undefined`, which the
 * dial itself refuses, and an own entry needing a minted credential is refused
 * here by name.
 *
 * @throws {UsageError} if an own `turn` entry needs a minted credential and
 *   `sharedSecret` is undefined.
 */
export async function relayCredentialForRun(
  connection: Pick<WebRTCConnectionConfig, "stun" | "turn" | "invitationRelay">,
  sharedSecret: string | undefined,
  now: Date,
): Promise<RelayCredential | undefined> {
  const { turn } = selectRunRelay(connection);
  if (turn === undefined) return undefined;
  if (turn.source === "own") {
    const unset = turn.servers.find(
      (server) => server.credential === undefined,
    );
    if (unset === undefined) return undefined;
    if (sharedSecret === undefined)
      throw new UsageError(turnEntryNeedsSecretMessage(unset.url));
  }
  if (sharedSecret === undefined) return undefined;
  return mintRunRelayCredential(sharedSecret, now);
}

/**
 * How long a run waits for its partner before it mints a fresh TURN credential
 * and rebuilds the peer connection with it: half the credential's lifetime, so
 * a partner arriving at any point in the wait leaves at least that half for
 * the connection to form.
 */
export const RELAY_CREDENTIAL_RENEWAL_MS =
  (RELAY_CREDENTIAL_MAX_TTL_SECONDS * 1000) / 2;

/**
 * How often an inviter that has answered follows an OFFER naming a new
 * connection id by rebuilding its peer connection: once at any time, then at
 * most once per interval, an unused interval not carrying over. A partner
 * renews at most this often, so a partner offering new ids faster is broken,
 * and the surplus offers are dropped.
 */
export const MIN_NEW_OFFER_INTERVAL_MS = RELAY_CREDENTIAL_RENEWAL_MS;

/**
 * The renewal a run presenting a minted TURN credential dials with: each
 * {@link RELAY_CREDENTIAL_RENEWAL_MS} the partner is absent, a credential is
 * minted from `sharedSecret` at `now()` and the ICE servers resolved with it,
 * so a wait longer than the credential's lifetime still reaches the relay with
 * one it accepts.
 */
export function relayCredentialRenewal(
  connection: Pick<
    WebRTCConnectionConfig,
    "stun" | "turn" | "iceProvision" | "invitationRelay"
  >,
  sharedSecret: string,
  now: () => Date = () => new Date(),
): IceServerRenewal {
  return {
    afterMs: RELAY_CREDENTIAL_RENEWAL_MS,
    resolve: async (waitedMs) => {
      const credential = await mintRunRelayCredential(sharedSecret, now());
      return {
        iceServers: iceServersFromConnection(connection, credential),
        notice: relayCredentialRenewalNotice(credential, waitedMs),
      };
    },
  };
}

/**
 * The line a run prints when a long wait for its partner renews the
 * credential, `waitedMs` into the wait.
 */
export function relayCredentialRenewalNotice(
  credential: RelayCredential,
  waitedMs: number,
): string {
  return (
    "the exchange partner has not connected within " +
    `${Math.round(waitedMs / 60_000)} minutes, so the connection ` +
    "attempt restarts with a new relay credential that expires at " +
    credential.expiresAt.toISOString()
  );
}

/**
 * The line a run prints when it presents a minted TURN credential: which
 * relay it goes to, and the credential's lifetime and expiry.
 */
export function relayCredentialNotice(
  connection: Pick<WebRTCConnectionConfig, "stun" | "turn" | "invitationRelay">,
  credential: RelayCredential,
): string {
  const relay =
    selectRunRelay(connection).turn?.source === "invitation"
      ? "the TURN server your partner's invitation named"
      : (connection.turn ?? [])
          .filter((server) => server.credential === undefined)
          .map((server) => server.url)
          .join(", ");
  return (
    `relaying through ${relay}, with a credential derived from the ` +
    "exchange's shared secret that is valid for " +
    `${RELAY_CREDENTIAL_MAX_TTL_SECONDS / 60} minutes and expires at ` +
    credential.expiresAt.toISOString()
  );
}

/** The `RTCConfiguration` fields the peer connection is constructed with. */
export interface WeriftPeerConfiguration {
  iceServers?: Array<RTCIceServer>;
  iceTransportPolicy?: IceTransportPolicy;
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
 *
 * An absent `iceTransportPolicy` is likewise omitted rather than spelled out as
 * `"all"`, so an unconfigured connection is constructed with the same object it
 * always was and the library's own default decides. What werift does with each
 * arm -- the value it reports back, and the candidates a relay-only policy
 * gathers -- is driven in webrtcIceTransportPolicy.test.ts.
 */
export function buildPeerConfiguration(
  iceServers: Array<RTCIceServer> | undefined,
  iceTransportPolicy?: IceTransportPolicy,
  warn: (message: string) => void = (message) => log.warn(message),
): WeriftPeerConfiguration {
  const policy = iceTransportPolicy === undefined ? {} : { iceTransportPolicy };
  if (iceServers === undefined || iceServers.length === 0) {
    warn(NO_ICE_SERVERS_WARNING);
    return policy;
  }
  return { iceServers, ...policy };
}

/**
 * Construct werift's peer connection, loading the library at the point of use.
 *
 * The import is deferred rather than static because it is not free: werift and
 * its dependency tree cost the CLI bundle roughly 0.3 s to load, and the CLI
 * bundles to a single CommonJS file whose external `require`s all run at
 * startup -- so a static import here would put that cost on every invocation,
 * `alcove --version` included, for a channel most runs never open. The
 * measurement and its basis are recorded once, at the lint rule that holds
 * this deferral: the `no-restricted-syntax` entry banning a value import (or
 * re-export) of werift across `apps/cli/src` (eslint.config.mjs).
 */
async function defaultPeerConnection(
  configuration: WeriftPeerConfiguration,
): Promise<RTCPeerConnection> {
  const werift = await import("werift");
  return new werift.RTCPeerConnection(configuration);
}

async function closePeer(peer: RTCPeerConnection): Promise<void> {
  try {
    await peer.close();
  } catch {
    // A peer connection already closed by a failure path throws on a second
    // close; the caller is on a failure or replacement path either way.
  }
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
    iceTransportPolicy,
    iceServerRenewal,
    rendezvousTimeoutMs = DEFAULT_RENDEZVOUS_TIMEOUT_MS,
    channelOpenTimeoutMs = DEFAULT_CHANNEL_OPEN_TIMEOUT_MS,
    unreportedOfferResendMs = DEFAULT_UNREPORTED_OFFER_RESEND_MS,
    renewalOverlapMs = RENEWAL_OVERLAP_MS,
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

  const buildPeer = async (
    servers: Array<RTCIceServer> | undefined,
    warn?: (message: string) => void,
  ): Promise<RTCPeerConnection> => {
    const configuration = buildPeerConfiguration(
      servers,
      iceTransportPolicy,
      warn,
    );
    return peerConnectionFactory === undefined
      ? await defaultPeerConnection(configuration)
      : peerConnectionFactory(configuration);
  };
  const rebuildPeer = async (waitedMs: number): Promise<RebuiltPeer> => {
    // The first build already warned about this same list.
    if (iceServerRenewal === undefined)
      return { peer: await buildPeer(iceServers, () => {}) };
    const renewed = await iceServerRenewal.resolve(waitedMs);
    return {
      peer: await buildPeer(renewed.iceServers),
      notice: renewed.notice,
    };
  };
  let broker: BrokerClient | undefined;
  let torn = false;

  const negotiation = new Negotiation({
    peer: await buildPeer(iceServers),
    role,
    remoteId,
    rendezvousTimeoutMs,
    channelOpenTimeoutMs,
    unreportedOfferResendMs,
    renewalOverlapMs,
    iceTransportPolicy,
    rebuildPeer,
    ...(iceServerRenewal !== undefined && {
      renewalAfterMs: iceServerRenewal.afterMs,
    }),
    signal,
  });

  const teardown = async (): Promise<void> => {
    if (torn) return;
    torn = true;
    broker?.close();
    await closePeer(negotiation.peer);
  };

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
    const { peer } = negotiation;
    assertSctpDrainSupported(peer);
    await logSelectedCandidatePair(peer, signal);
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
 *
 * Everything below is one debug line, and collecting the statistics is bounded
 * rather than instant, so a level that prints nothing skips the collection: a
 * peer whose `getStats` stalls must not cost the open channel that ceiling for
 * a line no one reads.
 */
async function logSelectedCandidatePair(
  peer: RTCPeerConnection,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (log.getLevel() > logLibrary.levels.DEBUG) return;
  const report = await readIceStats(peer, signal);
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

/**
 * A budget as the operator reads and sets it: `--peer-timeout` takes a
 * `<int><unit>` duration, so an expiry quoting milliseconds names a number the
 * flag does not accept and a supervisor cannot act on.
 */
function budgetSeconds(ms: number): string {
  return `${ms / 1000}s`;
}

interface NegotiationOptions {
  peer: RTCPeerConnection;
  role: RendezvousRole;
  remoteId: string;
  rendezvousTimeoutMs: number;
  channelOpenTimeoutMs: number;
  unreportedOfferResendMs: number;
  renewalOverlapMs: number;
  /** The policy the peer connection was built with; named in a failure. */
  iceTransportPolicy?: IceTransportPolicy;
  /** Builds a replacement for `peer` from the run's current ICE servers. */
  rebuildPeer: (waitedMs: number) => Promise<RebuiltPeer>;
  /** Replace `peer` each `renewalAfterMs` the partner has not engaged. */
  renewalAfterMs?: number;
  signal?: AbortSignal;
}

/** A replacement peer connection, and the line a wait logs when it commits it. */
interface RebuiltPeer {
  peer: RTCPeerConnection;
  notice?: string;
}

/**
 * A connection a renewal or a followed offer replaced, still negotiable until
 * {@link RENEWAL_OVERLAP_MS} ends: the partner's frames naming its id are
 * routed to it, and the first to engage it makes it current again.
 */
interface RetiredConnection {
  peer: RTCPeerConnection;
  connectionId: string;
  channel: RTCDataChannel | undefined;
  localDescriptionSent: boolean;
  remoteDescriptionSet: boolean;
  sentLocalCandidates: Array<Record<string, unknown>>;
  pendingRemoteCandidates: Array<Record<string, unknown>>;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Hold a remote candidate until a remote description can apply it. Bounded,
 * and past the cap the surplus is dropped rather than failing the rendezvous:
 * a legitimate late description still applies the ones held, and a peer that
 * only floods candidates cannot grow this without bound. Dropping is silent --
 * logging per candidate would itself be a log-flood vector, the same reason
 * inboundBounds.ts evicts silently.
 */
function holdRemoteCandidate(
  queue: Array<Record<string, unknown>>,
  candidate: Record<string, unknown>,
): void {
  if (queue.length < MAX_PENDING_REMOTE_CANDIDATES) queue.push(candidate);
}

/** The connection id a broker payload names, if it names one. */
function namedConnectionId(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const named = (payload as { connectionId?: unknown }).connectionId;
  return typeof named === "string" ? named : undefined;
}

/**
 * One rendezvous attempt's state machine, kept as a class because the broker
 * hands messages in at any point and both roles have to survive a frame
 * arriving before the step that consumes it.
 */
class Negotiation {
  private readonly options: NegotiationOptions;
  private currentPeer: RTCPeerConnection;
  private renewalTimer: ReturnType<typeof setInterval> | undefined;
  private renewing = false;
  private broker: BrokerClient | undefined;
  /**
   * The one connection every inbound message is interpreted against: this
   * side's own until the inviter adopts the id of the offer it answers.
   */
  private connectionId = newConnectionId();
  /** The connection the current one replaced, while it is still negotiable. */
  private retired: RetiredConnection | undefined;
  /** Bumped when the inviter changes connection; stale offer handling stops at it. */
  private offerGeneration = 0;
  private lastNewOfferFollowedAt: number | undefined;
  private startedAt = 0;
  /** Local candidates gathered before this side's description reached the broker. */
  private readonly pendingLocalCandidates: Array<Record<string, unknown>> = [];
  /** Every local candidate sent so far, re-sent with each re-sent offer. */
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
    this.currentPeer = options.peer;
  }

  /** The peer connection the negotiation runs on; replaced by a renewal. */
  get peer(): RTCPeerConnection {
    return this.currentPeer;
  }

  /** Whether the partner has sent the description this side must answer or apply. */
  private partnerEngaged(): boolean {
    return this.options.role === "inviter"
      ? this.answered
      : this.answerAccepted;
  }

  private attachPeer(peer: RTCPeerConnection): void {
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
    if (this.options.role === "inviter")
      peer.ondatachannel = ({ channel }) => {
        this.dropRetired();
        this.watchChannel(channel);
      };
  }

  /** Open this side's data channel and offer it; the acceptor's opening move. */
  private async openAndOffer(): Promise<void> {
    const channel = this.currentPeer.createDataChannel(this.connectionId, {
      ordered: true,
    });
    this.watchChannel(channel);
    await this.offer();
  }

  /**
   * Stop listening to the current peer connection and drop everything it
   * produced -- its gathered candidates, its channel, the partner's candidates
   * queued for it -- returning it for the caller to close.
   */
  private discardPeer(): RTCPeerConnection {
    const previous = this.currentPeer;
    previous.onicecandidate = null;
    previous.onconnectionstatechange = null;
    previous.ondatachannel = null;
    if (this.channel !== undefined) {
      this.channel.onopen = undefined;
      this.channel.onclose = undefined;
      this.channel = undefined;
    }
    this.stopChannelOpenDeadline();
    this.localDescriptionSent = false;
    this.remoteDescriptionSet = false;
    this.pendingLocalCandidates.splice(0);
    this.sentLocalCandidates.splice(0);
    this.pendingRemoteCandidates.splice(0);
    return previous;
  }

  private installPeer(peer: RTCPeerConnection): void {
    this.currentPeer = peer;
    this.attachPeer(peer);
  }

  /**
   * Set the current connection aside as {@link retired}, still sending its own
   * candidates and, for the inviter, taking the channel the partner opens on
   * it. The caller installs the replacement and starts the overlap.
   */
  private retirePeer(): RetiredConnection {
    const retired: RetiredConnection = {
      peer: this.currentPeer,
      connectionId: this.connectionId,
      channel: this.channel,
      localDescriptionSent: this.localDescriptionSent,
      remoteDescriptionSet: this.remoteDescriptionSet,
      sentLocalCandidates: [...this.sentLocalCandidates],
      pendingRemoteCandidates: [...this.pendingRemoteCandidates],
      timer: undefined,
    };
    this.discardPeer();
    retired.peer.onicecandidate = ({ candidate }) => {
      if (!candidate || !retired.localDescriptionSent) return;
      const payload = candidateToPayload(candidate);
      this.sendCandidate(payload, retired.connectionId);
      retired.sentLocalCandidates.push(payload);
    };
    if (this.options.role === "inviter")
      retired.peer.ondatachannel = ({ channel }) => {
        if (this.retired !== retired || this.finished) return;
        this.promoteRetired(retired);
        this.watchChannel(channel);
      };
    this.retired = retired;
    return retired;
  }

  private startOverlap(retired: RetiredConnection): void {
    if (this.retired !== retired) return;
    retired.timer = setTimeout(
      () => this.dropRetired(retired),
      this.options.renewalOverlapMs,
    );
  }

  /** Close the retired connection, if it is still `expected` when one is named. */
  private dropRetired(expected?: RetiredConnection): void {
    const retired = this.retired;
    if (retired === undefined) return;
    if (expected !== undefined && retired !== expected) return;
    this.retired = undefined;
    clearTimeout(retired.timer);
    retired.peer.onicecandidate = null;
    retired.peer.ondatachannel = null;
    void closePeer(retired.peer);
  }

  /** Make the retired connection current again, closing its replacement. */
  private promoteRetired(retired: RetiredConnection): void {
    this.retired = undefined;
    clearTimeout(retired.timer);
    this.offerGeneration += 1;
    // An inviter still building the replacement has not installed it yet.
    const replaced = this.discardPeer();
    if (replaced !== retired.peer) void closePeer(replaced);
    this.connectionId = retired.connectionId;
    this.installPeer(retired.peer);
    this.localDescriptionSent = retired.localDescriptionSent;
    this.remoteDescriptionSet = retired.remoteDescriptionSet;
    this.sentLocalCandidates.push(...retired.sentLocalCandidates);
    this.pendingRemoteCandidates.push(...retired.pendingRemoteCandidates);
    if (retired.channel !== undefined) this.watchChannel(retired.channel);
  }

  /**
   * Replace the peer connection with one built from a fresh ICE server list,
   * unless the partner engaged -- or the run settled -- while it was built.
   * The acceptor offers again under a new connection id, the old offer staying
   * answerable until the overlap ends.
   */
  private async renew(): Promise<void> {
    if (this.renewing || this.partnerEngaged()) return;
    this.renewing = true;
    try {
      const { peer: next, notice } = await this.options.rebuildPeer(
        Date.now() - this.startedAt,
      );
      if (
        this.finished ||
        this.failure !== undefined ||
        this.partnerEngaged()
      ) {
        await closePeer(next);
        return;
      }
      if (this.options.role === "acceptor") {
        this.dropRetired();
        const retired = this.retirePeer();
        this.installPeer(next);
        if (notice !== undefined) log.info(notice);
        this.connectionId = newConnectionId();
        await this.openAndOffer();
        this.startOverlap(retired);
      } else {
        const previous = this.discardPeer();
        this.installPeer(next);
        if (notice !== undefined) log.info(notice);
        await closePeer(previous);
      }
    } catch (err) {
      this.fail(
        err instanceof ConnectionError
          ? err
          : new ConnectionError(
              "the WebRTC connection attempt could not be restarted with " +
                "fresh relay servers",
              "transport",
              { cause: err },
            ),
      );
    } finally {
      this.renewing = false;
    }
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
    const report = await readIceStats(this.currentPeer, this.options.signal);
    this.fail(
      new ConnectionError(
        summary,
        "transport",
        report === undefined
          ? undefined
          : {
              cause: chainDetailCauses(
                iceFailureDetails(report, this.options.iceTransportPolicy),
              ),
            },
      ),
    );
  }

  async run(broker: BrokerClient): Promise<RTCDataChannel> {
    this.broker = broker;
    this.startedAt = Date.now();
    const { role, signal, renewalAfterMs } = this.options;
    this.attachPeer(this.currentPeer);

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

    if (role === "acceptor") await this.openAndOffer();
    if (renewalAfterMs !== undefined)
      this.renewalTimer = setInterval(() => void this.renew(), renewalAfterMs);

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
              `${budgetSeconds(this.options.rendezvousTimeoutMs)}; ` +
              "--peer-timeout sets how long to wait for a partner to arrive",
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
      clearInterval(this.renewalTimer);
      this.dropRetired();
      this.stopChannelOpenDeadline();
      this.stopOfferResends();
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
      case BROKER_MESSAGE.expire:
        this.resendOfferOnExpire();
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
    const offeredId = adoptableConnectionId(
      (message.payload as { connectionId?: unknown }).connectionId,
    );
    if (!this.answered) {
      this.answered = true;
      if (offeredId !== undefined) this.connectionId = offeredId;
    } else if (offeredId === undefined || offeredId === this.connectionId) {
      // A repeat means the dialer has not seen this answer yet; re-send rather
      // than rebuild, which would discard the connection already forming.
      if (this.localDescriptionSent) this.resendAnswer();
      return;
    } else {
      // A new id is the dialer's rebuilt connection. The answer already sent
      // may still be taken during the dialer's overlap, so the connection it
      // came from stays open through this side's own.
      if (!this.mayFollowNewOffer()) return;
      const generation = (this.offerGeneration += 1);
      this.dropRetired();
      const retired = this.retirePeer();
      this.connectionId = offeredId;
      this.startOverlap(retired);
      const { peer: next } = await this.options.rebuildPeer(
        Date.now() - this.startedAt,
      );
      if (
        generation !== this.offerGeneration ||
        this.finished ||
        this.failure !== undefined
      ) {
        await closePeer(next);
        return;
      }
      this.installPeer(next);
    }
    const generation = this.offerGeneration;
    const peer = this.currentPeer;
    await peer.setRemoteDescription({ type: "offer", sdp: description.sdp });
    if (generation !== this.offerGeneration) return;
    this.markRemoteDescriptionSet();
    await this.applyPendingRemoteCandidates();
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    if (generation !== this.offerGeneration) return;
    this.sendAnswer();
  }

  /** Whether the bound on following new offers admits one more, counting it if so. */
  private mayFollowNewOffer(): boolean {
    const now = Date.now();
    if (
      this.lastNewOfferFollowedAt !== undefined &&
      now - this.lastNewOfferFollowedAt < MIN_NEW_OFFER_INTERVAL_MS
    )
      return false;
    this.lastNewOfferFollowedAt = now;
    return true;
  }

  /**
   * Whether a payload names a connection other than the current one. A payload
   * naming none is taken as current, and so is any before the inviter has
   * answered, when it holds no partner connection yet.
   */
  private namesOtherConnection(payload: unknown): boolean {
    if (this.options.role === "inviter" && !this.answered) return false;
    const named = namedConnectionId(payload);
    return named !== undefined && named !== this.connectionId;
  }

  /** The retired connection `payload` names, if it names that one. */
  private retiredNamedBy(payload: unknown): RetiredConnection | undefined {
    const retired = this.retired;
    if (retired === undefined) return undefined;
    return namedConnectionId(payload) === retired.connectionId
      ? retired
      : undefined;
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
    // The first connection answered wins, so a partner that answered the
    // offer a renewal replaced keeps it. Any other id answers a closed one.
    const retired = this.retiredNamedBy(message.payload);
    if (retired === undefined && this.namesOtherConnection(message.payload))
      return;
    // Latch synchronously before the first await, mirroring onOffer's
    // `answered`. `remoteDescriptionSet` is only set after setRemoteDescription
    // resolves, so without this latch two ANSWERs delivered in one tick both
    // pass the guard and both call setRemoteDescription; werift's throw on the
    // second is caught as a terminal failure, letting a counterparty fail the
    // acceptor's rendezvous by answering twice.
    this.answerAccepted = true;
    this.stopOfferResends();
    if (retired === undefined) this.dropRetired();
    else this.promoteRetired(retired);
    await this.currentPeer.setRemoteDescription({
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
    const retired = this.retiredNamedBy(message.payload);
    if (retired !== undefined) {
      if (retired.remoteDescriptionSet)
        await this.addRemoteCandidate(candidate, retired.peer);
      else holdRemoteCandidate(retired.pendingRemoteCandidates, candidate);
      return;
    }
    if (this.namesOtherConnection(message.payload)) return;
    if (!this.remoteDescriptionSet) {
      holdRemoteCandidate(this.pendingRemoteCandidates, candidate);
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
    peer: RTCPeerConnection = this.currentPeer,
  ): Promise<void> {
    try {
      await peer.addIceCandidate(candidate);
    } catch {
      // Silent by design: logging per candidate would let a peer that sprays
      // malformed candidates drive the operator's console.
    }
  }

  private async offer(): Promise<void> {
    const peer = this.currentPeer;
    const description = await peer.createOffer();
    await peer.setLocalDescription(description);
    // A renewal or a promotion replaced the peer meanwhile; its own offer is sent.
    if (peer !== this.currentPeer) return;
    const local = peer.localDescription;
    if (local === undefined || local === null) {
      throw new ConnectionError(
        "the local session description was not available after it was set",
        "transport",
      );
    }
    this.sendOffer(local);
  }

  private sendOffer(local: { type: string; sdp: string }): void {
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
    this.stopOfferResends();
    if (this.finished) return;
    this.unreportedOfferResendTimer = setTimeout(
      () => this.resendOffer(),
      this.options.unreportedOfferResendMs,
    );
    this.offerResendIntervalTimer = setTimeout(() => {
      this.offerResendIntervalTimer = undefined;
      if (!this.offerResendOnExpireDue) return;
      this.offerResendOnExpireDue = false;
      this.resendOffer();
    }, MIN_OFFER_RESEND_INTERVAL_MS);
  }

  private sendAnswer(): void {
    const local = this.currentPeer.localDescription;
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

  private unreportedOfferResendTimer: ReturnType<typeof setTimeout> | undefined;
  /** Running for {@link MIN_OFFER_RESEND_INTERVAL_MS} after each offer send. */
  private offerResendIntervalTimer: ReturnType<typeof setTimeout> | undefined;
  private offerResendOnExpireDue = false;

  private resendOfferOnExpire(): void {
    if (this.offerResendIntervalTimer !== undefined) {
      this.offerResendOnExpireDue = true;
      return;
    }
    this.resendOffer();
  }

  /**
   * Send the offer and its candidates again, on the broker's `EXPIRE` (no
   * sooner than {@link MIN_OFFER_RESEND_INTERVAL_MS} after the last send) or
   * once {@link DEFAULT_UNREPORTED_OFFER_RESEND_MS} passes with neither it nor
   * an answer. Never while the broker may still hold the last copy: a browser
   * PeerJS peer handed two copies of one connection id closes the connection
   * its app already took and builds another. An inviter's `EXPIRE` means the
   * acceptor it answered has left, and it waits for that partner's next offer.
   */
  private resendOffer(): void {
    if (
      this.options.role !== "acceptor" ||
      this.answerAccepted ||
      this.finished ||
      !this.localDescriptionSent
    )
      return;
    const local = this.currentPeer.localDescription;
    if (local === undefined || local === null) return;
    this.sendOffer(local);
    for (const candidate of this.sentLocalCandidates) {
      this.sendCandidate(candidate);
    }
  }

  private stopOfferResends(): void {
    clearTimeout(this.unreportedOfferResendTimer);
    this.unreportedOfferResendTimer = undefined;
    clearTimeout(this.offerResendIntervalTimer);
    this.offerResendIntervalTimer = undefined;
    this.offerResendOnExpireDue = false;
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

  private sendCandidate(
    candidate: Record<string, unknown>,
    connectionId: string = this.connectionId,
  ): void {
    this.broker?.send({
      type: BROKER_MESSAGE.candidate,
      dst: this.options.remoteId,
      payload: {
        candidate,
        type: "data",
        connectionId,
      },
    });
  }

  /** Resolve the run once `channel` opens, bounded by the open deadline. */
  private watchChannel(channel: RTCDataChannel): void {
    if (this.channel !== undefined) return;
    this.channel = channel;
    const settleOpen = (): void => {
      this.stopChannelOpenDeadline();
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
            `${budgetSeconds(this.options.channelOpenTimeoutMs)} after the ` +
            "exchange partner's session description arrived; --peer-timeout " +
            "sets that bound",
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
