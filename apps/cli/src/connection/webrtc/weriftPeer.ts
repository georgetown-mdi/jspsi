import { RTCPeerConnection } from "werift";

import {
  ConnectionError,
  UsageError,
  deriveRendezvousPeerId,
  getLogger,
} from "@psilink/core";

import { BROKER_MESSAGE, connectToBroker } from "./brokerClient";
import { PEERJS_SERIALIZATION } from "./peerjsWire";

import type {
  BrokerClient,
  BrokerLocation,
  BrokerMessage,
} from "./brokerClient";
import type { RendezvousRole, WebRTCConnectionConfig } from "@psilink/core";
import type { RTCDataChannel, RTCIceCandidate, RTCIceServer } from "werift";

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
 * Three measured werift behaviours shape this module; the pin's premises and
 * their re-verification are in docs/spec/DEPENDENCY_PINS.md.
 *
 * - Candidates start firing DURING `setLocalDescription`, before the local
 *   description can have reached the broker, and a browser PeerJS peer discards
 *   a candidate it cannot yet apply -- silently, from the sender's side. So
 *   local candidates are queued until this side's description is sent. werift
 *   also inlines its candidates in the SDP, which masks the loss: a connection
 *   built without the queue works until the inlined set is not enough.
 * - A configured `iceServers` list REPLACES werift's built-in Google STUN
 *   default rather than adding to it, which is what makes a deliberately
 *   configured list the list actually used.
 * - The broker does not hold a message for a peer that has not registered yet
 *   and sends nothing back to say so, so the dialer's only route is to re-offer
 *   on a timer until it is answered.
 */

const log = getLogger("webrtc");

/** Prefix PeerJS gives a DataConnection id, matched so a browser peer's logs read normally. */
const CONNECTION_ID_PREFIX = "dc_";

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

/** The warning line emitted when no ICE servers are configured (see below). */
export const NO_ICE_SERVERS_WARNING =
  "no ICE servers are configured for this webrtc connection, so the built-in " +
  "default (stun:stun.l.google.com:19302) will be used to discover this " +
  "host's public address. That address, and the fact of a session, are " +
  "disclosed to that server; no exchange content is. Set `stun` (or `turn`) " +
  "on the connection to use your own server instead, or set a single " +
  "unreachable `stun` entry to gather host candidates only, which costs about " +
  "five seconds of gathering and works only where both parties share a network.";

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
 * data.
 *
 * This reaches past werift's public API, which is why werift is exact-pinned
 * (docs/spec/DEPENDENCY_PINS.md). It is not a refinement of the channel's
 * `bufferedAmount`: that counter reaches zero while chunks are still
 * unacknowledged, and closing on it loses them -- measured at roughly one frame
 * in three, nine datagrams of sixty-two, on a loopback channel with no packet
 * loss at all. The premise is asserted at every session, so a werift release
 * that renames or restructures these fails loud rather than silently restoring
 * that data loss.
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
 * Encodes the dependency premise as a check rather than a comment: without
 * these the clean close has no acknowledgement to wait on, and a final frame is
 * lost silently. Called once the channel is open, where the association exists.
 *
 * @throws {ConnectionError} of kind `usage` if the internals are not as expected.
 */
export function assertSctpDrainSupported(peer: RTCPeerConnection): void {
  if (sctpQueues(peer) !== undefined) return;
  throw new ConnectionError(
    "the installed werift does not expose the SCTP send queues the WebRTC " +
      "transport's flushing close depends on (sctp.sctp.outboundQueue / " +
      "sentQueue); without them a final frame can be lost on close. " +
      "Re-verify against the installed werift version.",
    "usage",
  );
}

/** Has the peer acknowledged everything handed to the channel? */
function sctpOutboundAcknowledged(peer: RTCPeerConnection): boolean {
  const queues = sctpQueues(peer);
  // Unreachable while the session is alive -- assertSctpDrainSupported ran at
  // open -- except once the association is torn down, where "nothing left to
  // acknowledge" is the right answer anyway.
  if (queues === undefined) return true;
  return queues.outbound === 0 && queues.sent === 0;
}

/** Has everything handed to the channel at least been put on the wire? */
function sctpOutboundTransmitted(peer: RTCPeerConnection): boolean {
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
 * omitting it keeps the two indistinguishable rather than implying a
 * suppression that does not happen. A non-empty list is passed verbatim, which
 * is what makes it -- and not the default -- the list actually used.
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

/** A fresh PeerJS-shaped DataConnection id. */
function newConnectionId(): string {
  return `${CONNECTION_ID_PREFIX}${Math.random().toString(36).slice(2)}`;
}

/** The `{type, sdp}` a broker payload carries, if it carries one. */
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
 * payload carries it. werift's `RTCIceCandidate` is a class instance whose
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

/** The candidate object a CANDIDATE payload carries, if it carries one. */
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
    peerConnectionFactory = (configuration) =>
      new RTCPeerConnection(configuration),
    socketFactory,
  } = options;

  const [inviterId, acceptorId] = await Promise.all([
    deriveRendezvousPeerId(sharedSecret, "inviter"),
    deriveRendezvousPeerId(sharedSecret, "acceptor"),
  ]);
  const localId = role === "inviter" ? inviterId : acceptorId;
  const remoteId = role === "inviter" ? acceptorId : inviterId;

  const peer = peerConnectionFactory(buildPeerConfiguration(iceServers));
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
  private channel: RTCDataChannel | undefined;
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

  async run(broker: BrokerClient): Promise<RTCDataChannel> {
    this.broker = broker;
    const { peer, role, signal } = this.options;

    peer.onicecandidate = ({ candidate }) => {
      // An end-of-candidates event carries no candidate and needs no frame: the
      // remote learns gathering is done from the description it already has.
      if (!candidate) return;
      this.emitLocalCandidate(candidateToPayload(candidate));
    };
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === "failed") {
        this.fail(
          new ConnectionError(
            "the peer connection failed before the data channel opened; no " +
              "network path between the two parties could be established",
            "transport",
          ),
        );
      }
    };

    const opened = new Promise<RTCDataChannel>((resolve, reject) => {
      this.settle = { resolve, reject };
      if (this.failure !== undefined) reject(this.failure);
    });

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
            `the exchange partner did not answer within ` +
              `${this.options.rendezvousTimeoutMs}ms`,
            "transport",
          ),
        ),
      this.options.rendezvousTimeoutMs,
    );

    try {
      return await opened;
    } finally {
      clearTimeout(rendezvousTimer);
      this.stopOfferRetries();
      signal?.removeEventListener("abort", abort);
    }
  }

  onBrokerMessage(message: BrokerMessage): void {
    if (this.failure !== undefined) return;
    // Only the derived peer id is a legitimate source. A third party would have
    // to know an id derived from the invitation secret to reach here at all, so
    // this is depth rather than the primary control -- but it means a stray or
    // planted frame cannot perturb a live negotiation.
    if (message.src !== undefined && message.src !== this.options.remoteId)
      return;
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
    const offeredId = (message.payload as { connectionId?: unknown })
      .connectionId;
    if (typeof offeredId === "string") this.connectionId = offeredId;
    const { peer } = this.options;
    await peer.setRemoteDescription({ type: "offer", sdp: description.sdp });
    this.remoteDescriptionSet = true;
    await this.applyPendingRemoteCandidates();
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    this.sendAnswer();
  }

  private async onAnswer(message: BrokerMessage): Promise<void> {
    if (this.options.role !== "acceptor" || this.remoteDescriptionSet) return;
    const description = sessionDescriptionFrom(message.payload);
    if (description === undefined || description.type !== "answer") return;
    this.stopOfferRetries();
    await this.options.peer.setRemoteDescription({
      type: "answer",
      sdp: description.sdp,
    });
    this.remoteDescriptionSet = true;
    await this.applyPendingRemoteCandidates();
  }

  private async onCandidate(message: BrokerMessage): Promise<void> {
    const candidate = candidateFrom(message.payload);
    if (candidate === undefined) return;
    if (!this.remoteDescriptionSet) {
      this.pendingRemoteCandidates.push(candidate);
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
      // Deliberately silent: logging per candidate would let a peer that sprays
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
   * repeat carries the same connection id, which a browser PeerJS peer that
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
    const openTimer = setTimeout(
      () =>
        this.fail(
          new ConnectionError(
            `the data channel did not open within ` +
              `${this.options.channelOpenTimeoutMs}ms after the exchange ` +
              "partner answered",
            "transport",
          ),
        ),
      this.options.channelOpenTimeoutMs,
    );
    const settleOpen = (): void => {
      clearTimeout(openTimer);
      this.stopOfferRetries();
      this.settle?.resolve(channel);
    };
    if (channel.readyState === "open") {
      settleOpen();
      return;
    }
    channel.onopen = settleOpen;
    channel.onclose = () => {
      clearTimeout(openTimer);
      this.fail(
        new ConnectionError(
          "the data channel closed before it opened",
          "transport",
        ),
      );
    };
  }
}
