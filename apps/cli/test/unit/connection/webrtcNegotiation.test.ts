import { afterEach, expect, test, vi } from "vitest";
import logLibrary from "loglevel";

import {
  ConnectionError,
  deriveRendezvousPeerId,
  generateSharedSecret,
  sanitizeErrorForDisplay,
  setDiagnosticSink,
  setLogLevel,
} from "@psilink/core";

import { snapshotDiagnosticSinkAndLevel } from "../../loggingTestSupport";
import { BROKER_MESSAGE } from "../../../src/connection/webrtc/brokerClient";
import { ICE_STATS_TIMEOUT_MS } from "../../../src/connection/webrtc/iceDiagnostics";
import {
  MAX_CONNECTION_ID_LENGTH,
  MAX_PENDING_REMOTE_CANDIDATES,
  openWebRtcPeerSession,
} from "../../../src/connection/webrtc/weriftPeer";

import type { WebRtcPeerSession } from "../../../src/connection/webrtc/weriftPeer";
import type { RTCPeerConnection } from "werift";

/**
 * The negotiation state machine against a scripted broker and a scripted peer
 * connection: which signaling frame goes out, in what order, and in response
 * to what. werift inlines its ICE candidates in the SDP, so a peer whose
 * trickled candidates are all dropped still connects on loopback -- the
 * candidate-queue rule is invisible to an end-to-end test and only fails in
 * the field. The live path is test/integration/webrtc/transport.test.ts.
 */

const CANDIDATE_A = {
  candidate: "candidate:1 1 udp 2130706431 10.0.0.1 5000 typ host",
  sdpMid: "0",
  sdpMLineIndex: 0,
};
const CANDIDATE_B = {
  candidate: "candidate:2 1 udp 2130706430 10.0.0.2 5001 typ host",
  sdpMid: "0",
  sdpMLineIndex: 0,
};

/**
 * werift hands the negotiation an `RTCIceCandidate` instance whose `toJSON`
 * produces the browser-shaped payload; the transport converts through that
 * method, so a scripted candidate has to include it too.
 */
function asIceCandidate(fields: Record<string, unknown>): unknown {
  return { ...fields, toJSON: () => fields };
}

/** A broker socket that records what the client sent and replays what a test says. */
class ScriptedSocket {
  static readonly OPEN = 1;
  readyState = 0;
  readonly sent: Array<Record<string, unknown>> = [];
  /** How many times the client closed this socket; the registered id's release. */
  closeCalls = 0;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(handler);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, handler: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(handler);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = 3;
  }

  register(): void {
    this.readyState = ScriptedSocket.OPEN;
    this.emit("open", {});
    this.deliver({ type: BROKER_MESSAGE.open });
  }

  deliver(message: Record<string, unknown>): void {
    this.emit("message", { data: JSON.stringify(message) });
  }

  /** The frames of one type the client sent, in order. */
  ofType(type: string): Array<Record<string, unknown>> {
    return this.sent.filter((frame) => frame.type === type);
  }

  /** Index of the first frame of `type`, or -1. */
  firstIndexOf(type: string): number {
    return this.sent.findIndex((frame) => frame.type === type);
  }

  /** Has the client attached its listeners yet? */
  wired(): boolean {
    return (this.listeners.get("message")?.size ?? 0) > 0;
  }

  private emit(type: string, event: unknown): void {
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event);
  }
}

/** A peer connection stand-in: no ICE, no DTLS, candidates fired on command. */
class ScriptedPeer {
  onicecandidate: ((event: { candidate?: unknown }) => void) | undefined;
  onconnectionstatechange: (() => void) | undefined;
  ondatachannel: ((event: { channel: unknown }) => void) | undefined;
  connectionState = "connected";
  localDescription: { type: string; sdp: string } | undefined;
  readonly remoteDescriptions: Array<{ type: string; sdp: string }> = [];
  readonly remoteCandidates: Array<unknown> = [];
  readonly channels: Array<FakeChannel> = [];
  /** How many times the session closed this connection. */
  closeCalls = 0;
  // The SCTP queues the session's drain assumption asserts on.
  readonly sctp = { sctp: { outboundQueue: [], sentQueue: [] } };
  /** ICE statistics `getStats()` answers with; a test scripts what it holds. */
  stats = new Map<string, unknown>();
  /**
   * How `getStats()` answers at all: a peer connection already torn down
   * throws, and a collection that overruns {@link ICE_STATS_TIMEOUT_MS} never
   * settles. Both leave a failure with no candidate report to attach.
   */
  statsAnswer: "resolves" | "throws" | "never-settles" = "resolves";
  /** How many times the session collected them. */
  statsCalls = 0;
  /** Fired during setLocalDescription, as werift does. */
  candidatesDuringSetLocal: Array<Record<string, unknown>> = [];

  createDataChannel(label: string): FakeChannel {
    const channel = new FakeChannel(label);
    this.channels.push(channel);
    return channel;
  }

  createOffer(): Promise<{ type: string; sdp: string }> {
    return Promise.resolve({ type: "offer", sdp: "v=0\r\noffer\r\n" });
  }

  createAnswer(): Promise<{ type: string; sdp: string }> {
    return Promise.resolve({ type: "answer", sdp: "v=0\r\nanswer\r\n" });
  }

  setLocalDescription(description: {
    type: string;
    sdp: string;
  }): Promise<void> {
    this.localDescription = description;
    // werift begins firing candidates here, before the description can have
    // reached the broker: the whole reason the transport queues them.
    for (const candidate of this.candidatesDuringSetLocal) {
      this.onicecandidate?.({ candidate: asIceCandidate(candidate) });
    }
    return Promise.resolve();
  }

  setRemoteDescription(description: {
    type: string;
    sdp: string;
  }): Promise<void> {
    this.remoteDescriptions.push(description);
    return Promise.resolve();
  }

  addIceCandidate(candidate: unknown): Promise<void> {
    this.remoteCandidates.push(candidate);
    return Promise.resolve();
  }

  getStats(): Promise<Map<string, unknown>> {
    this.statsCalls += 1;
    if (this.statsAnswer === "throws")
      throw new Error("the peer connection is closed");
    if (this.statsAnswer === "never-settles")
      return new Promise<Map<string, unknown>>(() => {});
    return Promise.resolve(this.stats);
  }

  close(): Promise<void> {
    this.closeCalls += 1;
    this.connectionState = "closed";
    return Promise.resolve();
  }

  /** Report the state werift reports when no candidate pair ever worked. */
  failConnection(): void {
    this.connectionState = "failed";
    this.onconnectionstatechange?.();
  }
}

class FakeChannel {
  readyState = "connecting";
  bufferedAmount = 0;
  onopen: (() => void) | undefined;
  onclose: (() => void) | undefined;
  onmessage: ((event: { data: unknown }) => void) | undefined;
  onerror: ((event: { error: unknown }) => void) | undefined;

  constructor(readonly label: string) {}

  open(): void {
    this.readyState = "open";
    this.onopen?.();
  }

  send(): void {}
  close(): void {}
}

const sessions: Array<WebRtcPeerSession> = [];

snapshotDiagnosticSinkAndLevel();

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
});

/** Start a rendezvous with scripted transports; resolve once both are wired. */
async function startRendezvous(options: {
  role: "inviter" | "acceptor";
  candidatesDuringSetLocal?: Array<Record<string, unknown>>;
  offerRetryIntervalMs?: number;
  rendezvousTimeoutMs?: number;
  channelOpenTimeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Whether the broker confirms the registration with `OPEN`. A test of the
   * window before registration completes says no and leaves it unconfirmed.
   */
  confirmRegistration?: boolean;
}): Promise<{
  socket: ScriptedSocket;
  peer: ScriptedPeer;
  session: Promise<WebRtcPeerSession>;
  inviterId: string;
  acceptorId: string;
}> {
  const sharedSecret = generateSharedSecret();
  const [inviterId, acceptorId] = await Promise.all([
    deriveRendezvousPeerId(sharedSecret, "inviter"),
    deriveRendezvousPeerId(sharedSecret, "acceptor"),
  ]);
  const socket = new ScriptedSocket();
  const peer = new ScriptedPeer();
  peer.candidatesDuringSetLocal = options.candidatesDuringSetLocal ?? [];
  const session = openWebRtcPeerSession({
    location: {
      host: "127.0.0.1",
      port: 9000,
      path: "/api",
      key: "peerjs",
      secure: false,
    },
    role: options.role,
    sharedSecret,
    iceServers: [{ urls: "stun:127.0.0.1:3478" }],
    offerRetryIntervalMs: options.offerRetryIntervalMs ?? 60_000,
    rendezvousTimeoutMs: options.rendezvousTimeoutMs ?? 10_000,
    channelOpenTimeoutMs: options.channelOpenTimeoutMs ?? 10_000,
    signal: options.signal,
    peerConnectionFactory: () => peer as unknown as RTCPeerConnection,
    socketFactory: () => socket as unknown as WebSocket,
  });
  session.then(
    (value) => sessions.push(value),
    () => {
      // A test that expects the rendezvous to fail owns the rejection.
    },
  );
  // The rendezvous derives both ids before it opens the socket, so wait for the
  // client to attach its listeners rather than guessing how long that takes.
  for (let attempt = 0; attempt < 200 && !socket.wired(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (options.confirmRegistration !== false) socket.register();
  await new Promise((resolve) => setTimeout(resolve, 10));
  return { socket, peer, session, inviterId, acceptorId };
}

/**
 * Whether a rendezvous has settled yet. A rendezvous still waiting is the
 * assertion in the tests below, so the answer has to come back rather than
 * block on a promise that is not meant to settle at all.
 */
async function settlementOf(
  session: Promise<WebRtcPeerSession>,
): Promise<"waiting" | "resolved" | "rejected"> {
  return await Promise.race([
    session.then(
      () => "resolved" as const,
      () => "rejected" as const,
    ),
    new Promise<"waiting">((resolve) =>
      setTimeout(() => resolve("waiting"), 20),
    ),
  ]);
}

// --- the dialer's offer -----------------------------------------------------

test("the acceptor's OFFER contains the payload a browser PeerJS peer parses", async () => {
  const { socket, peer, session, inviterId } = await startRendezvous({
    role: "acceptor",
  });
  const [offer] = socket.ofType(BROKER_MESSAGE.offer);
  expect(offer.dst).toBe(inviterId);
  const payload = offer.payload as Record<string, unknown>;
  expect(payload.sdp).toEqual({ type: "offer", sdp: "v=0\r\noffer\r\n" });
  expect(payload.type).toBe("data");
  // The receiving PeerJS peer selects its DataConnection subclass from this
  // field, so a mismatch is a protocol break rather than a preference.
  expect(payload.serialization).toBe("binary");
  expect(payload.reliable).toBe(true);
  expect(payload.label).toBe(payload.connectionId);
  expect(String(payload.connectionId)).toMatch(/^dc_/);
  // The dialer creates the channel, and its label matches the connection id.
  expect(peer.channels).toHaveLength(1);
  expect(peer.channels[0].label).toBe(payload.connectionId);
  peer.channels[0].open();
  await session;
});

// --- the candidate queue ----------------------------------------------------

test("no candidate is sent before the local description reaches the broker", async () => {
  const { socket, peer, session } = await startRendezvous({
    role: "acceptor",
    candidatesDuringSetLocal: [CANDIDATE_A, CANDIDATE_B],
  });
  const offerAt = socket.firstIndexOf(BROKER_MESSAGE.offer);
  const candidateAt = socket.firstIndexOf(BROKER_MESSAGE.candidate);
  expect(offerAt).toBeGreaterThanOrEqual(0);
  expect(candidateAt).toBeGreaterThan(offerAt);
  // Both queued candidates are flushed once the offer is out; none is dropped.
  expect(
    socket
      .ofType(BROKER_MESSAGE.candidate)
      .map((frame) => (frame.payload as { candidate: unknown }).candidate),
  ).toEqual([CANDIDATE_A, CANDIDATE_B]);
  peer.channels[0].open();
  await session;
});

test("a candidate gathered after the description is sent goes out at once", async () => {
  const { socket, peer, session } = await startRendezvous({ role: "acceptor" });
  expect(socket.ofType(BROKER_MESSAGE.candidate)).toHaveLength(0);
  peer.onicecandidate?.({ candidate: asIceCandidate(CANDIDATE_A) });
  expect(
    socket
      .ofType(BROKER_MESSAGE.candidate)
      .map((frame) => (frame.payload as { candidate: unknown }).candidate),
  ).toEqual([CANDIDATE_A]);
  peer.channels[0].open();
  await session;
});

test("an end-of-candidates event sends nothing", async () => {
  const { socket, peer, session } = await startRendezvous({ role: "acceptor" });
  peer.onicecandidate?.({ candidate: undefined });
  expect(socket.ofType(BROKER_MESSAGE.candidate)).toHaveLength(0);
  peer.channels[0].open();
  await session;
});

// --- the retry the broker's silence forces ----------------------------------

test("the offer is re-sent while the partner has not answered", async () => {
  // The broker neither queues a message for an unregistered peer nor reports
  // that it dropped one, so a repeat is the dialer's only route.
  const { socket, peer, session } = await startRendezvous({
    role: "acceptor",
    candidatesDuringSetLocal: [CANDIDATE_A],
    offerRetryIntervalMs: 20,
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(socket.ofType(BROKER_MESSAGE.offer).length).toBeGreaterThan(1);
  // Each repeat includes the candidates again: the ones already sent were
  // dropped along with the offer they belonged to.
  expect(socket.ofType(BROKER_MESSAGE.candidate).length).toBeGreaterThan(1);
  // Same connection id throughout, which a peer that already has the
  // connection ignores rather than renegotiating.
  const ids = new Set(
    socket
      .ofType(BROKER_MESSAGE.offer)
      .map((frame) => (frame.payload as { connectionId: string }).connectionId),
  );
  expect(ids.size).toBe(1);
  peer.channels[0].open();
  await session;
});

test("the retry stops once the answer lands", async () => {
  const { socket, peer, session, inviterId } = await startRendezvous({
    role: "acceptor",
    offerRetryIntervalMs: 20,
  });
  socket.deliver({
    type: BROKER_MESSAGE.answer,
    src: inviterId,
    payload: { sdp: { type: "answer", sdp: "v=0\r\nanswer\r\n" } },
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const afterAnswer = socket.ofType(BROKER_MESSAGE.offer).length;
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(socket.ofType(BROKER_MESSAGE.offer)).toHaveLength(afterAnswer);
  expect(peer.remoteDescriptions).toEqual([
    { type: "answer", sdp: "v=0\r\nanswer\r\n" },
  ]);
  peer.channels[0].open();
  await session;
});

// --- which ceiling governs which wait ---------------------------------------

/**
 * The two ceilings measure different things, and only unequal values tell
 * them apart: the rendezvous budget covers a partner who has not arrived (ten
 * minutes), the channel-open ceiling a partner present and negotiating whose
 * channel never comes up (thirty seconds). The dialer creates its channel
 * before it has offered, so confusing the two cuts a ten-minute rendezvous to
 * thirty seconds and blames a network path for an operator who started late.
 */

test("the dialer's channel-open ceiling does not run before it is answered", async () => {
  const { socket, peer, session, inviterId } = await startRendezvous({
    role: "acceptor",
    channelOpenTimeoutMs: 100,
    rendezvousTimeoutMs: 30_000,
  });
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(await settlementOf(session)).toBe("waiting");

  socket.deliver({
    type: BROKER_MESSAGE.answer,
    src: inviterId,
    payload: { sdp: { type: "answer", sdp: "v=0\r\nanswer\r\n" } },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  peer.channels[0].open();
  await expect(session).resolves.toBeDefined();
});

test("an unanswered dialer fails on the rendezvous budget, and says so", async () => {
  const { session } = await startRendezvous({
    role: "acceptor",
    channelOpenTimeoutMs: 100,
    rendezvousTimeoutMs: 150,
  });
  await expect(session).rejects.toThrow(/did not answer within 150ms/);
});

test("a channel that never opens after the answer fails at the open ceiling", async () => {
  const { socket, session, inviterId } = await startRendezvous({
    role: "acceptor",
    channelOpenTimeoutMs: 100,
    rendezvousTimeoutMs: 30_000,
  });
  socket.deliver({
    type: BROKER_MESSAGE.answer,
    src: inviterId,
    payload: { sdp: { type: "answer", sdp: "v=0\r\nanswer\r\n" } },
  });
  await expect(session).rejects.toThrow(/did not open within 100ms/);
});

// --- the listener's answer --------------------------------------------------

test("the inviter answers an offer and adopts its connection id", async () => {
  const { socket, peer, session, acceptorId } = await startRendezvous({
    role: "inviter",
  });
  expect(socket.ofType(BROKER_MESSAGE.offer)).toHaveLength(0);
  socket.deliver({
    type: BROKER_MESSAGE.offer,
    src: acceptorId,
    payload: {
      sdp: { type: "offer", sdp: "v=0\r\noffer\r\n" },
      type: "data",
      connectionId: "dc_fromtheirside",
      serialization: "binary",
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const [answer] = socket.ofType(BROKER_MESSAGE.answer);
  expect(answer.dst).toBe(acceptorId);
  const payload = answer.payload as Record<string, unknown>;
  expect(payload.sdp).toEqual({ type: "answer", sdp: "v=0\r\nanswer\r\n" });
  // The answer contains no label/reliable/serialization -- the offer settled all
  // three -- and reuses the id the dialer chose.
  expect(payload.connectionId).toBe("dc_fromtheirside");
  expect(payload).not.toHaveProperty("serialization");
  // The listener takes the channel the remote created rather than making one.
  expect(peer.channels).toHaveLength(0);
  const channel = new FakeChannel("dc_fromtheirside");
  peer.ondatachannel?.({ channel });
  channel.open();
  await session;
});

test("an over-long connection id in an offer is neither adopted nor echoed", async () => {
  const { socket, peer, session, acceptorId } = await startRendezvous({
    role: "inviter",
  });
  // Larger than the bound but still inside the broker's 256 KiB frame, so it
  // reaches onOffer; adopting it would push every outbound answer/candidate past
  // the broker's inbound limit.
  const oversized = `dc_${"x".repeat(MAX_CONNECTION_ID_LENGTH * 4)}`;
  socket.deliver({
    type: BROKER_MESSAGE.offer,
    src: acceptorId,
    payload: {
      sdp: { type: "offer", sdp: "v=0\r\noffer\r\n" },
      type: "data",
      connectionId: oversized,
      serialization: "binary",
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const [answer] = socket.ofType(BROKER_MESSAGE.answer);
  const echoed = (answer.payload as { connectionId: string }).connectionId;
  // The over-long id is refused; this side keeps its own short generated id.
  expect(echoed).not.toBe(oversized);
  expect(echoed.length).toBeLessThanOrEqual(MAX_CONNECTION_ID_LENGTH);
  expect(echoed).toMatch(/^dc_/);
  // And the rendezvous still completes on the channel the remote created.
  const channel = new FakeChannel("dc_ok");
  peer.ondatachannel?.({ channel });
  channel.open();
  await session;
});

test("a repeated offer is re-answered rather than renegotiated", async () => {
  const { socket, peer, session, acceptorId } = await startRendezvous({
    role: "inviter",
  });
  const offer = {
    type: BROKER_MESSAGE.offer,
    src: acceptorId,
    payload: {
      sdp: { type: "offer", sdp: "v=0\r\noffer\r\n" },
      type: "data",
      connectionId: "dc_repeat",
    },
  };
  socket.deliver(offer);
  await new Promise((resolve) => setTimeout(resolve, 10));
  socket.deliver(offer);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(socket.ofType(BROKER_MESSAGE.answer).length).toBeGreaterThan(1);
  // One remote description: the repeat did not rebuild the connection already
  // forming.
  expect(peer.remoteDescriptions).toHaveLength(1);
  const channel = new FakeChannel("dc_repeat");
  peer.ondatachannel?.({ channel });
  channel.open();
  await session;
});

// --- what the negotiation refuses to act on ---------------------------------

test("a signaling frame from any id but the derived partner is ignored", async () => {
  const { socket, peer, session } = await startRendezvous({ role: "inviter" });
  socket.deliver({
    type: BROKER_MESSAGE.offer,
    src: "ffff9999ffff9999ffff9999ffff9999",
    payload: {
      sdp: { type: "offer", sdp: "v=0\r\nintruder\r\n" },
      connectionId: "dc_intruder",
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(socket.ofType(BROKER_MESSAGE.answer)).toHaveLength(0);
  expect(peer.remoteDescriptions).toHaveLength(0);
  const channel = new FakeChannel("dc_ok");
  peer.ondatachannel?.({ channel });
  channel.open();
  await session;
});

test("a signaling frame containing no src is dropped", async () => {
  // The honest broker stamps src on every relayed frame, so a src-less frame is
  // not peer traffic; the one party that can plant one is a hostile signaling
  // server, and it must not be able to apply an offer.
  const { socket, peer, session } = await startRendezvous({ role: "inviter" });
  socket.deliver({
    type: BROKER_MESSAGE.offer,
    payload: {
      sdp: { type: "offer", sdp: "v=0\r\nnosrc\r\n" },
      connectionId: "dc_nosrc",
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(socket.ofType(BROKER_MESSAGE.answer)).toHaveLength(0);
  expect(peer.remoteDescriptions).toHaveLength(0);
  const channel = new FakeChannel("dc_ok");
  peer.ondatachannel?.({ channel });
  channel.open();
  await session;
});

test("a remote candidate is held until a remote description can apply it", async () => {
  const { socket, peer, session, inviterId } = await startRendezvous({
    role: "acceptor",
  });
  socket.deliver({
    type: BROKER_MESSAGE.candidate,
    src: inviterId,
    payload: { candidate: CANDIDATE_A },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(peer.remoteCandidates).toHaveLength(0);

  socket.deliver({
    type: BROKER_MESSAGE.answer,
    src: inviterId,
    payload: { sdp: { type: "answer", sdp: "v=0\r\nanswer\r\n" } },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(peer.remoteCandidates).toEqual([CANDIDATE_A]);
  peer.channels[0].open();
  await session;
});

test("a flood of remote candidates before the description is capped, and a late description still applies the ones held", async () => {
  const { socket, peer, session, inviterId } = await startRendezvous({
    role: "acceptor",
  });
  // A partner (or hostile broker) that never answers could stream candidates for
  // the whole rendezvous budget; the queue that holds them is capped.
  for (let i = 0; i < MAX_PENDING_REMOTE_CANDIDATES + 25; i += 1) {
    socket.deliver({
      type: BROKER_MESSAGE.candidate,
      src: inviterId,
      payload: { candidate: CANDIDATE_A },
    });
  }
  // None is applied while the description has not arrived.
  expect(peer.remoteCandidates).toHaveLength(0);

  socket.deliver({
    type: BROKER_MESSAGE.answer,
    src: inviterId,
    payload: { sdp: { type: "answer", sdp: "v=0\r\nanswer\r\n" } },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  // Exactly the cap was retained; the surplus was dropped, not queued -- and the
  // late description still completed the rendezvous.
  expect(peer.remoteCandidates).toHaveLength(MAX_PENDING_REMOTE_CANDIDATES);
  peer.channels[0].open();
  await session;
});

test("two answers delivered in one tick set the remote description once", async () => {
  const { socket, peer, session, inviterId } = await startRendezvous({
    role: "acceptor",
  });
  const answer = {
    type: BROKER_MESSAGE.answer,
    src: inviterId,
    payload: { sdp: { type: "answer", sdp: "v=0\r\nanswer\r\n" } },
  };
  // Same tick, before the first setRemoteDescription resolves: the synchronous
  // latch must stop the second from re-applying and failing the rendezvous.
  socket.deliver(answer);
  socket.deliver(answer);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(peer.remoteDescriptions).toHaveLength(1);
  peer.channels[0].open();
  await session;
});

test("the partner leaving the broker fails the rendezvous", async () => {
  const { socket, session, inviterId } = await startRendezvous({
    role: "acceptor",
  });
  socket.deliver({ type: BROKER_MESSAGE.leave, src: inviterId, payload: {} });
  await expect(session).rejects.toThrow(/left the signaling server/);
});

// --- broker traffic after the session is established ------------------------

test("broker signaling after the channel opens is ignored", async () => {
  const { socket, peer, session, acceptorId } = await startRendezvous({
    role: "inviter",
  });
  const offer = {
    type: BROKER_MESSAGE.offer,
    src: acceptorId,
    payload: {
      sdp: { type: "offer", sdp: "v=0\r\noffer\r\n" },
      type: "data",
      connectionId: "dc_open",
    },
  };
  socket.deliver(offer);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const channel = new FakeChannel("dc_open");
  peer.ondatachannel?.({ channel });
  channel.open();
  await session;

  const answersBefore = socket.ofType(BROKER_MESSAGE.answer).length;
  // Post-open, a repeated offer is not reflected as a fresh full-SDP answer
  // through the broker, and a late candidate is not fed to the peer.
  socket.deliver(offer);
  socket.deliver({
    type: BROKER_MESSAGE.candidate,
    src: acceptorId,
    payload: { candidate: CANDIDATE_A },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(socket.ofType(BROKER_MESSAGE.answer)).toHaveLength(answersBefore);
  expect(peer.remoteCandidates).toHaveLength(0);
});

// --- what an abort leaves behind --------------------------------------------

/**
 * The rendezvous can wait up to ten minutes, so `runProtocol` hands it the
 * interrupt signal for a quick Ctrl-C. Ending it early closes the broker
 * socket (releasing the derived id) and the peer connection, asserted against
 * the real session where that wiring lives. A webrtc open is two phases --
 * registering, then waiting for the partner -- each with its own cancellation
 * wording; the three tests below cover the three windows an abort can land in.
 */

test("an abort after registration names the rendezvous and tears both down", async () => {
  const controller = new AbortController();
  const { socket, peer, session } = await startRendezvous({
    role: "acceptor",
    signal: controller.signal,
  });
  // Registered and negotiating: the dialer's offer is already on the wire.
  expect(socket.ofType(BROKER_MESSAGE.offer).length).toBeGreaterThan(0);
  expect(socket.closeCalls).toBe(0);
  expect(peer.closeCalls).toBe(0);

  controller.abort();
  // The registration released the signal when the broker confirmed it, so what
  // reaches the operator names the phase they actually interrupted -- the wait
  // for the partner, not a connection to the signaling server that succeeded
  // minutes ago.
  await expect(session).rejects.toThrow(/the WebRTC rendezvous was cancelled/);
  // Exactly once each: an abandoned rendezvous leaves no registered id on the
  // broker and no half-open peer connection behind.
  expect(socket.closeCalls).toBe(1);
  expect(peer.closeCalls).toBe(1);
});

test("an abort inside the dialer's offer does not wait out the rendezvous", async () => {
  // The window between the two phases' listeners: the registration has released
  // the signal, and the negotiation cannot install its own until the acceptor's
  // offer resolves -- werift gathers as it describes, so that offer spans timer
  // turns. An abort landing here reaches no listener at all, and only the
  // negotiation's re-check keeps the run from sitting out its whole rendezvous
  // budget after the operator has already interrupted it.
  const controller = new AbortController();
  const { socket, peer, session } = await startRendezvous({
    role: "acceptor",
    signal: controller.signal,
    confirmRegistration: false,
    // Short enough that a missed abort fails as a timeout here rather than
    // spending the suite's own ceiling on it.
    rendezvousTimeoutMs: 500,
  });
  peer.createOffer = async () => {
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { type: "offer", sdp: "v=0\r\noffer\r\n" };
  };
  socket.register();

  await expect(session).rejects.toThrow(/the WebRTC rendezvous was cancelled/);
  expect(socket.closeCalls).toBe(1);
  expect(peer.closeCalls).toBe(1);
});

test("a broker failure inside the acceptor's offer rejects rather than going unhandled", async () => {
  // The acceptor awaits its own offer before it awaits the rendezvous, so a
  // failure latched in that window rejects a promise nothing is waiting on
  // yet. Unhandled, that terminates the process at exit 1 instead of failing
  // the exchange the ordinary way. A terminal broker ERROR delivered while
  // createOffer is in flight is one of several failures that reach fail()
  // there.
  const unhandled: unknown[] = [];
  const record = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", record);
  try {
    const { socket, peer, session } = await startRendezvous({
      role: "acceptor",
      confirmRegistration: false,
    });
    peer.createOffer = async () => {
      socket.deliver({ type: BROKER_MESSAGE.error, payload: "server sank" });
      // The real offer does I/O (werift gathers as it describes), so the window
      // it holds open spans timer turns rather than resolving in the microtask
      // the failure landed in -- which is what leaves the rejection unhandled
      // long enough to be reported.
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { type: "offer", sdp: "v=0\r\noffer\r\n" };
    };
    socket.register();

    await expect(session).rejects.toThrow(/signaling server reported an error/);
    // The teardown the classified path owes, which an unhandled rejection skips.
    expect(peer.closeCalls).toBe(1);
    // A turn for the rejection to be reported if it was never handled.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", record);
  }
});

test("an abort before registration tears down the same, having sent nothing", async () => {
  // The earliest window: the socket exists but the broker has not confirmed it,
  // so the abort is the registration's, and its wording is what the operator
  // gets. The peer connection is already built by this point, and is what would
  // be left running if only the registration unwound itself.
  const controller = new AbortController();
  const { socket, peer, session } = await startRendezvous({
    role: "acceptor",
    signal: controller.signal,
    confirmRegistration: false,
  });

  controller.abort();
  await expect(session).rejects.toThrow(
    /connecting to the signaling server was cancelled/,
  );
  expect(socket.sent).toHaveLength(0);
  expect(socket.closeCalls).toBe(1);
  expect(peer.closeCalls).toBe(1);
});

// --- what a run reports about the path it found -----------------------------

/** A stats report in the map shape werift's `getStats()` resolves to. */
function iceStats(
  entries: Array<Record<string, unknown>>,
): Map<string, unknown> {
  return new Map(entries.map((entry) => [String(entry.id), entry]));
}

/** Statistics naming one nominated pair, the shape a live channel reports. */
function connectedStats(remoteType: string): Map<string, unknown> {
  return iceStats([
    { type: "local-candidate", id: "L1", candidateType: "host" },
    { type: "remote-candidate", id: "R1", candidateType: remoteType },
    {
      type: "candidate-pair",
      id: "P1",
      localCandidateId: "L1",
      remoteCandidateId: "R1",
      state: "succeeded",
      nominated: true,
    },
  ]);
}

/** Collect every diagnostic line the run emits, with debug lines admitted. */
function captureDiagnostics(): Array<string> {
  const lines: Array<string> = [];
  setDiagnosticSink((_method, _prefix, args) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  });
  setLogLevel(logLibrary.levels.DEBUG);
  return lines;
}

/** The rendezvous failure, rendered as the operator is shown it. */
async function renderedFailure(
  session: Promise<WebRtcPeerSession>,
): Promise<string> {
  return sanitizeErrorForDisplay(
    await session.then(
      () => new Error("the rendezvous was expected to fail"),
      (err: unknown) => err,
    ),
  );
}

test("the open channel reports the candidate pair it runs over", async () => {
  const lines = captureDiagnostics();
  const { peer, session } = await startRendezvous({ role: "acceptor" });
  peer.stats = connectedStats("relay");
  peer.channels[0].open();
  await session;
  expect(lines.join("\n")).toContain(
    "the data channel opened over candidate pair local host, remote relay",
  );
});

test("a run at a level that prints no debug line collects no statistics", async () => {
  // The pair line is the whole of what the collection is for, and collecting is
  // bounded rather than instant, so a run that would print nothing must not
  // spend the open channel's time on a peer whose getStats stalls.
  setLogLevel(logLibrary.levels.INFO);
  const { peer, session } = await startRendezvous({ role: "acceptor" });
  peer.statsAnswer = "never-settles";
  peer.stats = connectedStats("relay");
  const startedAt = Date.now();
  peer.channels[0].open();
  await session;
  expect(peer.statsCalls).toBe(0);
  expect(Date.now() - startedAt).toBeLessThan(ICE_STATS_TIMEOUT_MS);
});

test("a debug run collects them once", async () => {
  captureDiagnostics();
  const { peer, session } = await startRendezvous({ role: "acceptor" });
  peer.stats = connectedStats("relay");
  peer.channels[0].open();
  await session;
  expect(peer.statsCalls).toBe(1);
});

test("a run whose statistics name no pair says so rather than nothing", async () => {
  const lines = captureDiagnostics();
  const { peer, session } = await startRendezvous({ role: "acceptor" });
  peer.channels[0].open();
  await session;
  expect(lines.join("\n")).toContain("ICE reported no selected candidate pair");
});

test("a partner's candidate type cannot drive the operator's terminal", async () => {
  const lines = captureDiagnostics();
  const { peer, session } = await startRendezvous({ role: "acceptor" });
  peer.stats = connectedStats("relay\u001b[31m\nFAKE: exchange complete");
  peer.channels[0].open();
  await session;
  const reported = lines.find((line) => line.includes("candidate pair"));
  expect(reported).toContain(
    "remote relay\\x1b[31m\\x0aFAKE: exchange complete",
  );
  expect(reported).not.toContain("\u001b");
  expect(reported).not.toContain("\n");
});

test("an ICE failure names what was gathered, received and tried", async () => {
  const { peer, session } = await startRendezvous({ role: "acceptor" });
  peer.stats = iceStats([
    { type: "local-candidate", id: "L1", candidateType: "host" },
    { type: "local-candidate", id: "L2", candidateType: "srflx" },
  ]);
  peer.failConnection();
  const rendered = await renderedFailure(session);
  expect(rendered).toContain(
    "no network path between the two parties could be established",
  );
  expect(rendered).toContain(
    "local candidates gathered: no relay candidate gathered; 2 (host, srflx)",
  );
  expect(rendered).toContain("remote candidates received: none");
  expect(rendered).toContain("candidate pairs: none formed");
});

test("a relay gathered that still found no path is reported apart", async () => {
  const { peer, session } = await startRendezvous({ role: "acceptor" });
  peer.stats = iceStats([
    { type: "local-candidate", id: "L1", candidateType: "relay" },
    { type: "remote-candidate", id: "R1", candidateType: "host" },
    {
      type: "candidate-pair",
      id: "P1",
      localCandidateId: "L1",
      remoteCandidateId: "R1",
      state: "failed",
    },
  ]);
  peer.failConnection();
  const rendered = await renderedFailure(session);
  expect(rendered).toContain(
    "local candidates gathered: relay candidate gathered; 1 (relay)",
  );
  expect(rendered).toContain("remote candidates received: 1 (host)");
  expect(rendered).toContain("candidate pairs: 1 tried, none succeeded");
});

test("the channel-open ceiling reports the same diagnosis", async () => {
  const { socket, peer, session, inviterId } = await startRendezvous({
    role: "acceptor",
    channelOpenTimeoutMs: 100,
    rendezvousTimeoutMs: 30_000,
  });
  peer.stats = iceStats([
    { type: "local-candidate", id: "L1", candidateType: "host" },
  ]);
  socket.deliver({
    type: BROKER_MESSAGE.answer,
    src: inviterId,
    payload: { sdp: { type: "answer", sdp: "v=0\r\nanswer\r\n" } },
  });
  const rendered = await renderedFailure(session);
  expect(rendered).toContain("did not open within 100ms");
  expect(rendered).toContain(
    "local candidates gathered: no relay candidate gathered; 1 (host)",
  );
});

/**
 * Drive one of the two diagnosed failures against a peer whose statistics
 * cannot be read, timing the failure itself: the diagnosis is bounded, so what
 * a report that never arrives may cost is the description, not the outcome.
 * The never-settles mode lives in {@link neverSettlingStatsFailure} instead,
 * since a real clock can beat the ceiling by a millisecond.
 */
async function failureWithUnreadableStats(options: {
  statsAnswer: Exclude<ScriptedPeer["statsAnswer"], "never-settles">;
  path: "connection-failed" | "channel-open-ceiling";
}): Promise<{ error: ConnectionError; elapsedMs: number }> {
  const { socket, peer, session, inviterId } = await startRendezvous({
    role: "acceptor",
    channelOpenTimeoutMs: 100,
    rendezvousTimeoutMs: 30_000,
  });
  peer.statsAnswer = options.statsAnswer;
  const startedAt = Date.now();
  if (options.path === "connection-failed") peer.failConnection();
  else
    socket.deliver({
      type: BROKER_MESSAGE.answer,
      src: inviterId,
      payload: { sdp: { type: "answer", sdp: "v=0\r\nanswer\r\n" } },
    });
  const error = await session.then(
    () => new Error("the rendezvous was expected to fail"),
    (err: unknown) => err,
  );
  return { error: error as ConnectionError, elapsedMs: Date.now() - startedAt };
}

/** What every failure reporting no candidate report at all has in common. */
function expectUndiagnosedFailure(
  error: ConnectionError,
  summary: string,
): void {
  expect(error).toBeInstanceOf(ConnectionError);
  expect(error.kind).toBe("transport");
  expect(error.message).toContain(summary);
  expect(error.cause).toBeUndefined();
  expect(sanitizeErrorForDisplay(error)).not.toContain("candidates gathered");
}

test("a failed connection whose statistics throw reports the failure alone", async () => {
  const { error, elapsedMs } = await failureWithUnreadableStats({
    statsAnswer: "throws",
    path: "connection-failed",
  });
  expectUndiagnosedFailure(
    error,
    "no network path between the two parties could be established",
  );
  // A peer that answers at once is not waited on: the ceiling below is what
  // bounds one that does not.
  expect(elapsedMs).toBeLessThan(ICE_STATS_TIMEOUT_MS);
});

/**
 * Drive one of the two diagnosed failures against a peer whose statistics
 * never settle, under fake timers: {@link ICE_STATS_TIMEOUT_MS} is a
 * `setTimeout` a test can advance deterministically, unlike a `Date.now()`
 * measurement, which a real timer can fire a millisecond ahead of on a
 * loaded runner.
 */
async function neverSettlingStatsFailure(options: {
  path: "connection-failed" | "channel-open-ceiling";
}): Promise<ConnectionError> {
  const { socket, peer, session, inviterId } = await startRendezvous({
    role: "acceptor",
    channelOpenTimeoutMs: 100,
    rendezvousTimeoutMs: 30_000,
  });
  peer.statsAnswer = "never-settles";
  const settlement = session.then(
    () => new Error("the rendezvous was expected to fail"),
    (err: unknown) => err,
  );
  let settled = false;
  void settlement.then(() => {
    settled = true;
  });
  vi.useFakeTimers();
  try {
    if (options.path === "connection-failed") peer.failConnection();
    else
      socket.deliver({
        type: BROKER_MESSAGE.answer,
        src: inviterId,
        payload: { sdp: { type: "answer", sdp: "v=0\r\nanswer\r\n" } },
      });
    const ceilingMs =
      (options.path === "channel-open-ceiling" ? 100 : 0) +
      ICE_STATS_TIMEOUT_MS;
    // One ms short of the ceiling must still be pending, and the ceiling
    // itself must settle: fake time has none of a real timer's early-fire
    // slack, so this pins the ceiling exactly instead of a lower bound.
    await vi.advanceTimersByTimeAsync(ceilingMs - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
  } finally {
    vi.useRealTimers();
  }
  return (await settlement) as ConnectionError;
}

test("a failed connection whose statistics never arrive fails on the ICE ceiling", async () => {
  const error = await neverSettlingStatsFailure({ path: "connection-failed" });
  expectUndiagnosedFailure(
    error,
    "no network path between the two parties could be established",
  );
});

test("a channel-open ceiling whose statistics throw reports the failure alone", async () => {
  const { error, elapsedMs } = await failureWithUnreadableStats({
    statsAnswer: "throws",
    path: "channel-open-ceiling",
  });
  expectUndiagnosedFailure(error, "did not open within 100ms");
  expect(elapsedMs).toBeLessThan(ICE_STATS_TIMEOUT_MS);
});

test("a channel-open ceiling whose statistics never arrive still reports", async () => {
  const error = await neverSettlingStatsFailure({
    path: "channel-open-ceiling",
  });
  expectUndiagnosedFailure(error, "did not open within 100ms");
});
