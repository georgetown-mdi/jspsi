import { createHash } from "node:crypto";
import { createSocket } from "node:dgram";
import dns from "node:dns";

import { RTCPeerConnection } from "werift";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";

import { ConnectionError, generateSharedSecret } from "@psilink/core";

import { openWebRtcMessageConnection } from "../../../src/connection/webrtc/webrtcMessageConnection";
import {
  describeSelectedCandidatePair,
  readIceStats,
} from "../../../src/connection/webrtc/iceDiagnostics";
import {
  WERIFT_BUILT_IN_STUN_URI,
  openWebRtcPeerSession,
} from "../../../src/connection/webrtc/weriftPeer";
import { PEERJS_CHUNK_MTU } from "../../../src/connection/webrtc/peerjsWire";
import { startBrokerProcess } from "../../signaling/brokerProcess";

import type { BrokerLocation } from "../../../src/connection/webrtc/brokerClient";
import type { RTCIceServer } from "werift";
import type { BrokerProcess } from "../../signaling/brokerProcess";
import type { MessageConnection } from "@psilink/core";

/**
 * The CLI WebRTC transport end to end: two real werift peers, real ICE, real
 * DTLS/SCTP, meeting through the repository's real vendored PeerJS broker --
 * measuring behavior no type signature states, like when candidates fire and
 * what a close with bytes still buffered delivers.
 *
 * ICE stays host-candidates-only, the only workable choice in a firewalled
 * container; an empty `iceServers` list would select werift's built-in
 * Google default instead. The two tests that must drive that default
 * intercept the DNS resolver, so it runs without a packet leaving the
 * machine.
 */

/**
 * An unreachable STUN entry: nothing listens on this loopback port, so werift
 * gathers host candidates only. It is a real configured list, which is what
 * makes it the list actually used rather than the built-in default.
 */
const HOST_ONLY_ICE = [{ urls: "stun:127.0.0.1:3478" }];

/**
 * The two halves of the endpoint the transport names as werift's built-in
 * default, split out of the one constant that holds it so the measurements below
 * cannot drift from what an operator is told.
 */
const BUILT_IN_STUN = ((uri: string) => {
  const parsed = /^stun:(?<host>[^:]+):(?<port>\d+)$/.exec(uri)?.groups;
  if (parsed === undefined)
    throw new Error(`built-in STUN URI is not a stun:host:port URI: ${uri}`);
  return { host: parsed.host, port: Number(parsed.port) };
})(WERIFT_BUILT_IN_STUN_URI);

let broker: BrokerProcess;
const openConnections: Array<MessageConnection> = [];

function location(): BrokerLocation {
  return {
    host: "127.0.0.1",
    port: broker.port,
    path: broker.path,
    key: broker.key,
    secure: false,
  };
}

/**
 * Shared per-party options. `closeFlushTimeoutMs` is cut well below the
 * shipped default so a test whose partner is already gone -- werift takes about
 * thirty seconds to notice -- tears down on the ceiling instead of on the
 * suite's patience.
 */
function partyOptions(sharedSecret: string) {
  return {
    location: location(),
    sharedSecret,
    iceServers: HOST_ONLY_ICE,
    offerRetryIntervalMs: 250,
    rendezvousTimeoutMs: 60_000,
    channelOpenTimeoutMs: 30_000,
    closeFlushTimeoutMs: 5_000,
  };
}

/** Bring both parties up on one fresh secret and wait for both channels. */
async function connectedPair(): Promise<{
  inviter: MessageConnection;
  acceptor: MessageConnection;
}> {
  const common = partyOptions(generateSharedSecret());
  const [inviter, acceptor] = await Promise.all([
    openWebRtcMessageConnection({ ...common, role: "inviter" }),
    openWebRtcMessageConnection({ ...common, role: "acceptor" }),
  ]);
  openConnections.push(inviter, acceptor);
  return { inviter, acceptor };
}

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

beforeAll(async () => {
  broker = await startBrokerProcess();
}, 60_000);

afterEach(async () => {
  for (const connection of openConnections.splice(0)) {
    await connection.close().catch(() => {
      // Already terminal: the test that owned it closed or failed it.
    });
  }
}, 60_000);

afterAll(async () => {
  await broker?.stop();
});

test("two CLI peers exchange frames in both directions over a real channel", async () => {
  const { inviter, acceptor } = await connectedPair();

  await acceptor.send({ step: "hello", from: "acceptor" });
  expect(await inviter.receive()).toEqual({ step: "hello", from: "acceptor" });

  await inviter.send({ step: "hello-back", from: "inviter" });
  expect(await acceptor.receive()).toEqual({
    step: "hello-back",
    from: "inviter",
  });
}, 120_000);

test("a frame past the chunk threshold arrives byte-identical in both directions", async () => {
  const { inviter, acceptor } = await connectedPair();
  const body = new Uint8Array(PEERJS_CHUNK_MTU * 5 + 137);
  for (let i = 0; i < body.length; i += 1) body[i] = (i * 31) % 251;
  const digest = sha256(body);

  await acceptor.send({ tag: "set", body });
  const forward = (await inviter.receive()) as {
    tag: string;
    body: Uint8Array;
  };
  expect(forward.tag).toBe("set");
  expect(sha256(forward.body)).toBe(digest);

  await inviter.send({ tag: "reply", body });
  const back = (await acceptor.receive()) as { tag: string; body: Uint8Array };
  expect(back.tag).toBe("reply");
  expect(sha256(back.body)).toBe(digest);
}, 120_000);

test("the final frame is delivered before the clean close", async () => {
  // The delivery contract's critical half: `send` resolves on local
  // hand-off, so a close that tore the channel down without draining would lose
  // a frame this size outright. The receiver reads AFTER the sender has closed,
  // so nothing but the drain can have delivered it.
  const { inviter, acceptor } = await connectedPair();
  const body = new Uint8Array(PEERJS_CHUNK_MTU * 60);
  body.fill(0xa5);
  const digest = sha256(body);

  await acceptor.send({ tag: "final", body });
  await acceptor.close();

  const final = (await inviter.receive()) as { tag: string; body: Uint8Array };
  expect(final.tag).toBe("final");
  expect(sha256(final.body)).toBe(digest);

  // And the close itself lands behind that frame, as a terminal transport error
  // rather than a hang.
  const after = await inviter.receive().then(
    () => undefined,
    (err: unknown) => err as ConnectionError,
  );
  expect(after).toBeInstanceOf(ConnectionError);
  expect(after?.kind).toBe("transport");
}, 180_000);

test("a configured iceServers list is the list the peer connection is built with", async () => {
  // `getConfiguration()` echoes its input, so this asserts PASS-THROUGH -- that
  // a configured list reaches werift unchanged -- not suppression of the
  // built-in default, which no readable API can show.
  const sharedSecret = generateSharedSecret();
  const configured = [
    { urls: ["stun:127.0.0.1:3478", "stun:127.0.0.1:3479"] },
    {
      urls: "turn:127.0.0.1:3480",
      username: "psilink",
      credential: "not-a-real-credential",
    },
  ];
  const seen: Array<unknown> = [];
  const attempt = openWebRtcMessageConnection({
    location: location(),
    sharedSecret,
    role: "acceptor",
    iceServers: configured,
    rendezvousTimeoutMs: 1_500,
    peerConnectionFactory: (configuration) => {
      seen.push(configuration.iceServers);
      // Build the real peer connection with what it was handed, then read the
      // configuration back off it: the assertion is about what werift received,
      // not about what this factory was called with.
      const peer = new RTCPeerConnection(configuration);
      seen.push(peer.getConfiguration().iceServers);
      return peer;
    },
  });
  // No partner is listening, so the rendezvous times out; the configuration was
  // already captured on the way in.
  await expect(attempt).rejects.toThrow(ConnectionError);
  expect(seen[0]).toEqual(configured);
  expect(seen[1]).toEqual(configured);
}, 60_000);

/**
 * Gather ICE on a real werift peer built with `config`, recording every hostname
 * werift resolves through DNS while it does so. The lookups are short-circuited
 * to fail fast, so nothing reaches the network and the built-in default's own
 * STUN resolution never completes; only the fact that it was attempted matters.
 * werift resolves through `dns.promises.lookup` (measured); the callback form is
 * hooked too so a future switch does not silently blind this check.
 */
async function stunHostsLookedUp(
  config: ConstructorParameters<typeof RTCPeerConnection>[0],
): Promise<Set<string>> {
  const lookedUp = new Set<string>();
  const realPromiseLookup = dns.promises.lookup;
  const realCallbackLookup = dns.lookup;
  (dns.promises as { lookup: unknown }).lookup = async (
    hostname: string,
  ): Promise<never> => {
    lookedUp.add(hostname);
    throw new Error("suppressed by the STUN-suppression check");
  };
  (dns as { lookup: unknown }).lookup = (
    hostname: string,
    options: unknown,
    callback: unknown,
  ): void => {
    lookedUp.add(hostname);
    const cb = (typeof options === "function" ? options : callback) as (
      err: Error,
    ) => void;
    cb(new Error("suppressed by the STUN-suppression check"));
  };
  const peer = new RTCPeerConnection(config);
  try {
    peer.createDataChannel("dc_suppression", { ordered: true });
    await peer.setLocalDescription(await peer.createOffer());
    // The default's lookup fires within milliseconds of gathering starting; this
    // window is orders of magnitude above that, so its absence is suppression,
    // not a race.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  } finally {
    (dns.promises as { lookup: unknown }).lookup = realPromiseLookup;
    (dns as { lookup: unknown }).lookup = realCallbackLookup;
    await peer.close();
  }
  return lookedUp;
}

test("a configured iceServers list suppresses werift's built-in Google STUN default", async () => {
  // The privacy-relevant half of the replace-not-add assumption, which
  // `getConfiguration()` cannot show: an operator who configures their own STUN
  // is not also silently disclosing their public IP to Google's default. Held by
  // werift's own DNS resolution -- the default resolves stun.l.google.com, a
  // configured list does not.
  const withDefault = await stunHostsLookedUp({});
  expect([...withDefault]).toContain(BUILT_IN_STUN.host);

  const withConfigured = await stunHostsLookedUp({
    iceServers: [{ urls: "stun:127.0.0.1:3478" }],
  });
  expect([...withConfigured]).not.toContain(BUILT_IN_STUN.host);
}, 60_000);

/**
 * Every STUN binding request a peer built with no `iceServers` sends to the
 * endpoint {@link WERIFT_BUILT_IN_STUN_URI} names, observed on a loopback socket
 * bound to that port. The default's hostname resolves to loopback for the
 * duration, so both halves of the endpoint are measured -- the host through the
 * resolver werift asks, the port through the datagram it addresses -- and no
 * packet leaves the machine.
 */
async function builtInStunRequests(): Promise<Array<Buffer>> {
  const received: Array<Buffer> = [];
  const realPromiseLookup = dns.promises.lookup;
  const realCallbackLookup = dns.lookup;
  (dns.promises as { lookup: unknown }).lookup = async (
    hostname: string,
  ): Promise<{ address: string; family: number }> => {
    if (hostname !== BUILT_IN_STUN.host)
      throw new Error(`unexpected lookup of ${hostname}`);
    return { address: "127.0.0.1", family: 4 };
  };
  (dns as { lookup: unknown }).lookup = (
    hostname: string,
    options: unknown,
    callback: unknown,
  ): void => {
    const cb = (typeof options === "function" ? options : callback) as (
      err: Error | null,
      address?: string,
      family?: number,
    ) => void;
    if (hostname !== BUILT_IN_STUN.host)
      cb(new Error(`unexpected lookup of ${hostname}`));
    else cb(null, "127.0.0.1", 4);
  };
  const socket = createSocket("udp4");
  socket.on("message", (message) => received.push(message));
  await new Promise<void>((resolve) =>
    socket.bind(BUILT_IN_STUN.port, "127.0.0.1", resolve),
  );
  const peer = new RTCPeerConnection({});
  try {
    peer.createDataChannel("dc_default_endpoint", { ordered: true });
    await peer.setLocalDescription(await peer.createOffer());
    // The first request goes out within milliseconds of gathering starting, and
    // werift retransmits; this window is orders of magnitude above that, so an
    // empty result means the endpoint moved, not that the test was impatient.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  } finally {
    (dns.promises as { lookup: unknown }).lookup = realPromiseLookup;
    (dns as { lookup: unknown }).lookup = realCallbackLookup;
    await peer.close();
    socket.close();
  }
  return received;
}

test("the built-in default is the endpoint the warning and the export panel name", async () => {
  // WERIFT_BUILT_IN_STUN_URI is a first-party copy of a library fact, and the
  // operator reads it as a confidentiality statement before handing a secret to a
  // scheduler. Driving the library is the only correct way to hold it: a peer with
  // no configured list must address its binding requests to exactly this host and
  // this port.
  const requests = await builtInStunRequests();
  expect(requests.length).toBeGreaterThan(0);
  // Message type 0x0001 (binding request) and the RFC 5389 magic cookie, so an
  // unrelated datagram arriving on the port cannot stand in for the measurement.
  for (const request of requests) {
    expect(request.readUInt16BE(0)).toBe(0x0001);
    expect(request.readUInt32BE(4)).toBe(0x2112a442);
  }
}, 60_000);

/**
 * The candidate types ICE defines. The diagnostics read werift's own entries by
 * field name, so a selected type outside this set is a field that moved rather
 * than an unusual network path.
 */
const ICE_CANDIDATE_TYPES = ["host", "srflx", "prflx", "relay"];

test("the ICE report reads the statistics real werift produces", async () => {
  // The reader itself is exercised against hand-written reports in
  // test/unit/connection/webrtcIceDiagnostics.test.ts. What only a live pair
  // holds is that the entries werift emits still carry the field names it keys
  // on -- `candidateType`, `localCandidateId`, `remoteCandidateId`, `state`,
  // `nominated` -- so a bump that renames one reddens here rather than reaching
  // an operator as a report that quietly names nothing.
  const common = partyOptions(generateSharedSecret());
  const peers: Array<RTCPeerConnection> = [];
  const capturePeer = (configuration: {
    iceServers?: Array<RTCIceServer>;
  }): RTCPeerConnection => {
    const peer = new RTCPeerConnection(configuration);
    peers.push(peer);
    return peer;
  };
  const [inviter, acceptor] = await Promise.all([
    openWebRtcMessageConnection({
      ...common,
      role: "inviter",
      peerConnectionFactory: capturePeer,
    }),
    openWebRtcMessageConnection({
      ...common,
      role: "acceptor",
      peerConnectionFactory: capturePeer,
    }),
  ]);
  openConnections.push(inviter, acceptor);
  // One frame each way first, so the pair the report names is one that carried
  // the exchange rather than one that had only been probed.
  await acceptor.send({ step: "hello" });
  expect(await inviter.receive()).toEqual({ step: "hello" });

  expect(peers).toHaveLength(2);
  for (const peer of peers) {
    const report = await readIceStats(peer);
    if (report === undefined)
      throw new Error("the open channel reported no ICE statistics");
    expect(report.local.count).toBeGreaterThan(0);
    expect(report.remote.count).toBeGreaterThan(0);
    expect(report.succeededPairCount).toBeGreaterThan(0);
    expect(ICE_CANDIDATE_TYPES).toContain(report.selected?.localType);
    expect(ICE_CANDIDATE_TYPES).toContain(report.selected?.remoteType);
    expect(describeSelectedCandidatePair(report)).toMatch(
      /^local [a-z]+, remote [a-z]+$/,
    );
  }
}, 120_000);

test("an over-cap inbound frame fails the connection closed", async () => {
  // The bound is driven over the real channel rather than at the reassembler,
  // so what is exercised is the whole receive path: datagram, bound, unpack.
  const common = partyOptions(generateSharedSecret());
  const [inviter, acceptor] = await Promise.all([
    openWebRtcMessageConnection({
      ...common,
      role: "inviter",
      // A cap far below any real frame, so a modest send trips it.
      inboundBounds: { maxFrameBytes: 4_096 },
    }),
    openWebRtcMessageConnection({ ...common, role: "acceptor" }),
  ]);
  openConnections.push(inviter, acceptor);

  await acceptor.send({ tag: "over-cap", body: new Uint8Array(64 * 1024) });
  const refusal = await inviter.receive().then(
    () => undefined,
    (err: unknown) => err as ConnectionError,
  );
  expect(refusal).toBeInstanceOf(ConnectionError);
  expect(refusal?.kind).toBe("protocol");
  expect(refusal?.message).toContain("4096");
}, 120_000);

test("closing after the partner has vanished still returns, on the flush ceiling", async () => {
  // The drain waits for the peer to acknowledge, and a peer that is simply
  // gone never does: werift keeps reporting the connection up for about
  // thirty seconds, with `bufferedAmount` pinned at its peak. The ceiling is
  // what ends the close instead of the peer-loss signal.
  //
  // The partner is torn down at the session, not through its message
  // connection, so no close sentinel reaches this side -- otherwise the peer
  // would not have vanished at all.
  const common = partyOptions(generateSharedSecret());
  const [vanishing, acceptor] = await Promise.all([
    openWebRtcPeerSession({ ...common, role: "inviter" }),
    openWebRtcMessageConnection({
      ...common,
      role: "acceptor",
      closeFlushTimeoutMs: 2_000,
    }),
  ]);

  // Buffer far more than can drain in the window, then take the partner away.
  await acceptor.send({
    tag: "stranded",
    body: new Uint8Array(4 * 1024 * 1024),
  });
  await vanishing.close();

  const started = Date.now();
  await acceptor.close();
  const elapsed = Date.now() - started;
  expect(elapsed).toBeGreaterThanOrEqual(2_000);
  // Comfortably inside werift's ~30s consent-freshness detection, so it is the
  // ceiling that ended the wait and not the peer-loss signal.
  expect(elapsed).toBeLessThan(20_000);
}, 120_000);
