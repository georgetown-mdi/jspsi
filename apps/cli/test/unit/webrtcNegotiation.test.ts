import { afterEach, expect, test } from "vitest";

import { deriveRendezvousPeerId, generateSharedSecret } from "@psilink/core";

import { BROKER_MESSAGE } from "../../src/connection/webrtc/brokerClient";
import { openWebRtcPeerSession } from "../../src/connection/webrtc/weriftPeer";

import type { WebRtcPeerSession } from "../../src/connection/webrtc/weriftPeer";
import type { RTCPeerConnection } from "werift";

/**
 * The negotiation state machine against a scripted broker and a scripted peer
 * connection: which signaling frame goes out, in what order, and in response to
 * what.
 *
 * These orderings are the ones a live run cannot show. werift inlines its ICE
 * candidates in the SDP, so a peer whose trickled candidates are all dropped
 * still connects on loopback -- the candidate-queue rule the transport exists to
 * honour is invisible to an end-to-end test and fails only in the field, on the
 * day the inlined set is not enough. The live path is exercised in
 * test/integration/webrtcTransport.test.ts; this is where the wire ORDER is
 * held.
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
 * method, so a scripted candidate has to carry it too.
 */
function asIceCandidate(fields: Record<string, unknown>): unknown {
  return { ...fields, toJSON: () => fields };
}

/** A broker socket that records what the client sent and replays what a test says. */
class ScriptedSocket {
  static readonly OPEN = 1;
  readyState = 0;
  readonly sent: Array<Record<string, unknown>> = [];
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
  // The SCTP queues the session's drain premise asserts on.
  readonly sctp = { sctp: { outboundQueue: [], sentQueue: [] } };
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

  close(): Promise<void> {
    this.connectionState = "closed";
    return Promise.resolve();
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
  socket.register();
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

test("the acceptor's OFFER carries the payload a browser PeerJS peer parses", async () => {
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
  // Each repeat carries the candidates again: the ones already sent were
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
 * The two ceilings measure different things, and only unequal values tell them
 * apart: the rendezvous budget covers a partner who has not arrived (human
 * timescale, ten minutes), the channel-open ceiling a partner who is present
 * and negotiating but whose channel never comes up (thirty seconds). The dialer
 * creates its channel before it has offered, so the two are trivially confused
 * there -- and confusing them cuts a ten-minute rendezvous to thirty seconds and
 * blames a network path for an operator who started late.
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
  // The answer carries no label/reliable/serialization -- the offer settled all
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

test("the partner leaving the broker fails the rendezvous", async () => {
  const { socket, session, inviterId } = await startRendezvous({
    role: "acceptor",
  });
  socket.deliver({ type: BROKER_MESSAGE.leave, src: inviterId, payload: {} });
  await expect(session).rejects.toThrow(/left the signaling server/);
});
