import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";

import {
  ConnectionError,
  deriveRendezvousPeerId,
  generateSharedSecret,
  getDiagnosticSink,
  getLogger,
  setDiagnosticSink,
} from "@psilink/core";

import {
  BROKER_MESSAGE,
  connectToBroker,
} from "../../../src/connection/webrtc/brokerClient";
import { startBrokerProcess } from "../../signaling/brokerProcess";

import type {
  BrokerClient,
  BrokerLocation,
  BrokerMessage,
} from "../../../src/connection/webrtc/brokerClient";
import type { BrokerProcess } from "../../signaling/brokerProcess";

/**
 * Tests the CLI's signaling client against the repository's real vendored
 * PeerJS broker, spawned as a process. The client's wire format comes from
 * facts measured against the broker, not read from its source, so this suite
 * catches an envelope detail that drifted before a browser peer would.
 *
 * Stops at signaling: no RTCPeerConnection, ICE, or data channel -- those are
 * the transport suite's job.
 */

let broker: BrokerProcess;
/** Every client a test registered, closed after that test. */
const opened: Array<BrokerClient> = [];

/**
 * A fresh rendezvous id pair. Each test derives its own from a new secret, so
 * one test's registration can never be the reason another sees a collision --
 * the collision case below has to be the only place two peers claim one id.
 */
async function freshIds(): Promise<{ inviterId: string; acceptorId: string }> {
  const secret = generateSharedSecret();
  const [inviterId, acceptorId] = await Promise.all([
    deriveRendezvousPeerId(secret, "inviter"),
    deriveRendezvousPeerId(secret, "acceptor"),
  ]);
  return { inviterId, acceptorId };
}

/** The logger name the broker's reports are written under, in the runner
 * (packages/peerjs-broker/src/standalone.ts) and in the web app's mount alike. */
const BROKER_LOG_CONTEXT = "peerjs-broker";

/**
 * The prefix core's prefixed logger builds for a warning from the broker at
 * `at`, read off the sink a consumer installs. The clock is fixed to the
 * instant the line under test was written, so what is left to compare is the
 * prefix itself.
 */
function corePrefixAt(at: Date): string {
  const previousSink = getDiagnosticSink();
  let captured: string | undefined;
  setDiagnosticSink((_methodName, prefix) => {
    captured = prefix;
  });
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(at);
    getLogger(BROKER_LOG_CONTEXT).warn("");
  } finally {
    vi.useRealTimers();
    setDiagnosticSink(previousSink);
  }
  if (captured === undefined)
    throw new Error("core's prefixed logger wrote no warning to the sink");
  return captured;
}

function location(overrides?: Partial<BrokerLocation>): BrokerLocation {
  return {
    host: "127.0.0.1",
    port: broker.port,
    path: broker.path,
    key: broker.key,
    secure: false,
    ...overrides,
  };
}

/** Register a peer, collecting everything the broker sends it. */
async function register(id: string): Promise<{
  client: BrokerClient;
  inbox: Array<BrokerMessage>;
  closes: Array<ConnectionError>;
  /** Resolve with the first inbound frame of `type`, or reject on a timeout. */
  awaitMessage: (type: string, timeoutMs?: number) => Promise<BrokerMessage>;
}> {
  const inbox: Array<BrokerMessage> = [];
  const closes: Array<ConnectionError> = [];
  const waiters: Array<{
    type: string;
    resolve: (message: BrokerMessage) => void;
  }> = [];
  const client = await connectToBroker({
    location: location(),
    id,
    handlers: {
      onMessage: (message) => {
        inbox.push(message);
        for (const waiter of waiters.splice(0)) {
          if (waiter.type === message.type) waiter.resolve(message);
          else waiters.push(waiter);
        }
      },
      onClose: (error) => closes.push(error),
    },
  });
  opened.push(client);
  const awaitMessage = (type: string, timeoutMs = 10_000) =>
    new Promise<BrokerMessage>((resolve, reject) => {
      const already = inbox.find((message) => message.type === type);
      if (already !== undefined) {
        resolve(already);
        return;
      }
      const timer = setTimeout(
        () => reject(new Error(`no ${type} arrived within ${timeoutMs}ms`)),
        timeoutMs,
      );
      waiters.push({
        type,
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      });
    });
  return { client, inbox, closes, awaitMessage };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

beforeAll(async () => {
  broker = await startBrokerProcess();
}, 60_000);

afterEach(() => {
  for (const client of opened.splice(0)) client.close();
});

afterAll(async () => {
  await broker?.stop();
});

test("a CLI peer registers under its derived rendezvous id", async () => {
  const { inviterId } = await freshIds();
  const { client } = await register(inviterId);
  expect(client.localId).toBe(inviterId);
});

test("two CLI peers complete an OFFER/ANSWER round trip through the broker", async () => {
  const { inviterId, acceptorId } = await freshIds();
  const inviter = await register(inviterId);
  const acceptor = await register(acceptorId);

  // The dialer's OFFER, in the payload shape a browser PeerJS peer parses: the
  // SDP, the connection type, the connection id, and the DataConnection's
  // metadata/label/reliable/serialization.
  acceptor.client.send({
    type: BROKER_MESSAGE.offer,
    dst: inviterId,
    payload: {
      sdp: { type: "offer", sdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n" },
      type: "data",
      connectionId: "dc_roundtrip",
      metadata: null,
      label: "dc_roundtrip",
      reliable: true,
      serialization: "binary",
    },
  });

  const offer = await inviter.awaitMessage(BROKER_MESSAGE.offer);
  // The broker stamps `src` itself from the sending socket's registered id, so
  // the answerer learns who to reply to without the dialer asserting it.
  expect(offer.src).toBe(acceptorId);
  expect(offer.dst).toBe(inviterId);
  const offerPayload = offer.payload as Record<string, unknown>;
  expect(offerPayload.connectionId).toBe("dc_roundtrip");
  expect(offerPayload.serialization).toBe("binary");

  inviter.client.send({
    type: BROKER_MESSAGE.answer,
    dst: acceptorId,
    payload: {
      sdp: { type: "answer", sdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n" },
      type: "data",
      connectionId: "dc_roundtrip",
    },
  });

  const answer = await acceptor.awaitMessage(BROKER_MESSAGE.answer);
  expect(answer.src).toBe(inviterId);
  expect((answer.payload as Record<string, unknown>).connectionId).toBe(
    "dc_roundtrip",
  );

  // And a trickled candidate travels the same route.
  inviter.client.send({
    type: BROKER_MESSAGE.candidate,
    dst: acceptorId,
    payload: {
      candidate: {
        candidate: "candidate:1 1 udp 2130706431 127.0.0.1 5000 typ host",
        sdpMid: "0",
        sdpMLineIndex: 0,
      },
      type: "data",
      connectionId: "dc_roundtrip",
    },
  });
  const candidate = await acceptor.awaitMessage(BROKER_MESSAGE.candidate);
  expect(candidate.src).toBe(inviterId);
}, 60_000);

test("both parties on the same role collide at the broker with an actionable error", async () => {
  // The symmetric misconfiguration: two peers each computing the inviter id.
  const { inviterId } = await freshIds();
  await register(inviterId);
  const collision = await connectToBroker({
    location: location(),
    id: inviterId,
    handlers: { onMessage: () => {}, onClose: () => {} },
  }).then(
    (client) => {
      opened.push(client);
      return undefined;
    },
    (err: unknown) => err as ConnectionError,
  );
  expect(collision).toBeInstanceOf(ConnectionError);
  // Not a generic timeout: the operator is told what to change.
  expect(collision?.kind).toBe("usage");
  expect(collision?.message).toContain("already registered");
  expect(collision?.message).toContain("role");
  // And the derived ids stay out of it.
  expect(collision?.message).not.toContain(inviterId);
}, 60_000);

test("a wrong API key is refused with the field to fix", async () => {
  const { acceptorId } = await freshIds();
  const refusal = await connectToBroker({
    location: location({ key: "not-the-key" }),
    id: acceptorId,
    handlers: { onMessage: () => {}, onClose: () => {} },
  }).then(
    (client) => {
      opened.push(client);
      return undefined;
    },
    (err: unknown) => err as ConnectionError,
  );
  expect(refusal).toBeInstanceOf(ConnectionError);
  expect(refusal?.message).toContain("key");
}, 60_000);

test("a broker diagnostic reaches stderr, leaving the ready-line stdout alone", async () => {
  // The harness parses the port from a single stdout line; a diagnostic must
  // go to stderr instead. Sending bytes that are not JSON is the one
  // diagnostic a peer can force on demand, so the stdout check below means
  // something.
  const { inviterId } = await freshIds();
  let socket: WebSocket | undefined;
  const client = await connectToBroker({
    location: location(),
    id: inviterId,
    handlers: { onMessage: () => {}, onClose: () => {} },
    socketFactory: (url) => (socket = new WebSocket(url)),
  });
  opened.push(client);

  const stderrBefore = broker.stderr().length;
  socket?.send("not json at all");

  await waitFor(() =>
    broker.stderr().slice(stderrBefore).includes("[client-frame]"),
  );
  expect(broker.stdout()).toMatch(/^psilink-broker \d+\n$/);
}, 60_000);

test("a broker diagnostic opens with the prefix core would have written", async () => {
  // The runner writes its stderr lines itself rather than through core's
  // logger, so one embedding's line shape can move without the other's. The
  // web app hands the same reports to a prefixed core logger under the same
  // context (apps/web/src/signalingDiagnostics.ts), and an operator reading a
  // stream both write to sees one line shape, so the two are held equal here.
  const { inviterId } = await freshIds();
  let socket: WebSocket | undefined;
  const client = await connectToBroker({
    location: location(),
    id: inviterId,
    handlers: { onMessage: () => {}, onClose: () => {} },
    socketFactory: (url) => (socket = new WebSocket(url)),
  });
  opened.push(client);

  const stderrBefore = broker.stderr().length;
  const sentAt = Date.now();
  socket?.send("not json at all");
  await waitFor(() =>
    broker.stderr().slice(stderrBefore).includes("[client-frame]"),
  );
  const observedAt = Date.now();

  const line = broker
    .stderr()
    .slice(stderrBefore)
    .split("\n")
    .find((written) => written.includes("[client-frame]"));
  const opening = /^\[([^\]]+)\] /.exec(line ?? "");
  if (opening === null)
    throw new Error(
      `the diagnostic opened with no bracketed field: ${JSON.stringify(line)}`,
    );

  // The timestamp is read off the line so the rest can be compared byte for
  // byte; that it is the instant of the write, in the ISO form core renders,
  // is what the two assertions below hold.
  const timestamp = opening[1];
  expect(new Date(timestamp).toISOString()).toBe(timestamp);
  expect(Date.parse(timestamp)).toBeGreaterThanOrEqual(sentAt);
  expect(Date.parse(timestamp)).toBeLessThanOrEqual(observedAt);

  const prefix = corePrefixAt(new Date(timestamp));
  expect(line?.slice(0, prefix.length + 1)).toBe(`${prefix} `);
}, 60_000);

test("a registered peer stays registered past the broker's silent-socket reaper", async () => {
  // The broker closes a registered socket that has sent nothing for about
  // twenty seconds. A heartbeat keeps the connection alive across a peer's
  // long single-threaded PSI computation.
  const { inviterId, acceptorId } = await freshIds();
  const peer = await register(acceptorId);
  await new Promise((resolve) => setTimeout(resolve, 25_000));
  expect(peer.closes).toEqual([]);
  // Still routable: a live registration, not merely an unclosed socket.
  const inviter = await register(inviterId);
  peer.client.send({
    type: BROKER_MESSAGE.offer,
    dst: inviterId,
    payload: { type: "data", connectionId: "dc_afterreap" },
  });
  const offer = await inviter.awaitMessage(BROKER_MESSAGE.offer);
  expect(offer.src).toBe(acceptorId);
}, 90_000);
