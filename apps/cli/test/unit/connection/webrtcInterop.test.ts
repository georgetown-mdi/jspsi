import { readFileSync } from "node:fs";

import { afterEach, describe, expect, test, vi } from "vitest";

import { BROKER_MESSAGE } from "../../../src/connection/webrtc/brokerClient";
import {
  connectionFromEndpoint,
  endpointFromConnection,
} from "../../../src/onlineBootstrap";
import { decodeAndValidateInvitation } from "../../../src/invitationDecode";
import { inviterConnectionFromURL } from "../../../src/connectionFromUrl";
import { openWebRtcPeerSession } from "../../../src/connection/webrtc/weriftPeer";
import { webRtcDialFrom } from "../../../src/protocol";
import { withWebRTCPeerRole } from "../../../src/webrtcPeerRole";

import type { RTCPeerConnection } from "werift";
import type {
  HandshakeRole,
  InvitationToken,
  RendezvousRole,
  WebRTCConnectionConfig,
  WebRTCEndpoint,
} from "@psilink/core";

/**
 * The CLI half of the CLI<->web WebRTC interop conformance check.
 *
 * A CLI peer and a browser peer drive the same rendezvous and authenticated key
 * exchange from a shared core, independently, so what each app constructs for
 * itself is where the two can diverge while both apps' own suites stay green:
 * the invitation it consumes, the connection it seeds from that invitation's
 * locator, the peer id it registers under and the one it addresses, and the
 * handshake role it takes. This file drives only the CLI's own constructions,
 * against the shared known-answer vectors in
 * packages/core/test/vectors/webrtc-interop-vectors.json. Both mint directions
 * are covered: the vectors' invitation is minted in the shape the WEB app emits,
 * for a CLI acceptor consuming it, and `signaling.cliMintedEndpoints` fixes the
 * locator a CLI inviter emits from a ws/wss URL for a browser acceptor to
 * consume. The web-side halves of both are driven in
 * apps/web/test/unit/psi/webrtcInterop.test.ts. (What the CLI's mint has BESIDE
 * the locator -- that no credential rides along -- is asserted in
 * invite.test.ts, against the connection it will run.)
 *
 * The remaining CLI element, the request-encryption flag each party puts on the
 * handshake wire, is asserted against the same vectors in webrtcDispatch.test.ts,
 * which already drives a real handshake through `runProtocol`. The web app's
 * constructions are driven in apps/web/test/unit/psi/webrtcInterop.test.ts, and the
 * constructions core alone owns are pinned in
 * packages/core/test/config/webrtcInterop.test.ts.
 */

interface InteropVectors {
  inputs: { sharedSecret: string };
  rendezvous: {
    peerIds: Record<RendezvousRole, string>;
    sides: Array<{
      side: RendezvousRole;
      localPeerId: string;
      remotePeerId: string;
      handshakeRole: HandshakeRole;
      requestEncryption: boolean;
    }>;
  };
  signaling: {
    endpoint: WebRTCEndpoint;
    brokerHost: string;
    brokerPathname: string;
    cliMintedEndpoints: Array<{
      inviteUrl: string;
      endpoint: WebRTCEndpoint;
      brokerLocation: { host: string; port: number; path: string };
    }>;
  };
  invitation: { token: InvitationToken; encoded: string };
}

const vectors = JSON.parse(
  readFileSync(
    new URL(
      "../../../../../packages/core/test/vectors/webrtc-interop-vectors.json",
      import.meta.url,
    ),
    { encoding: "utf8" },
  ),
) as InteropVectors;

const sideVector = (side: RendezvousRole) => {
  const found = vectors.rendezvous.sides.find((s) => s.side === side);
  if (found === undefined) throw new Error(`no vector for side ${side}`);
  return found;
};

const { sharedSecret } = vectors.inputs;

// --- consuming the web app's invitation --------------------------------------

describe("the invitation a CLI acceptor consumes", () => {
  test("the CLI's decode gate yields the vector token", async () => {
    expect(
      await decodeAndValidateInvitation(vectors.invitation.encoded),
    ).toEqual(vectors.invitation.token);
  });

  test("the seeded connection has the locator the invitation named", async () => {
    const token = await decodeAndValidateInvitation(vectors.invitation.encoded);
    const { connection, seeded } = connectionFromEndpoint(
      token.connectionEndpoint,
    );
    expect(seeded).toBe(true);
    expect(connection).toEqual({
      channel: "webrtc",
      server: {
        host: vectors.signaling.endpoint.host,
        port: vectors.signaling.endpoint.port,
        path: vectors.signaling.endpoint.path,
      },
    });
  });

  test("the accept path stamps the acceptor role the invitation cannot hold", async () => {
    const token = await decodeAndValidateInvitation(vectors.invitation.encoded);
    const { connection } = connectionFromEndpoint(token.connectionEndpoint);
    expect(withWebRTCPeerRole(connection, "acceptor")).toMatchObject({
      role: "acceptor",
    });
  });
});

// --- minting the invitation a web acceptor consumes ---------------------------

describe("the locator a CLI inviter mints from its URL", () => {
  test.each(vectors.signaling.cliMintedEndpoints)(
    "$inviteUrl emits the endpoint vector",
    ({ inviteUrl, endpoint }) => {
      // The whole of what the partner is handed. A field left off here is one
      // the partner's own client fills in from a default of its own, which is
      // exactly the divergence a shared vector exists to pin -- so the mint is
      // compared as a whole object, not field by field.
      expect(
        endpointFromConnection(
          inviterConnectionFromURL(new URL(inviteUrl), {}),
        ),
      ).toEqual(endpoint);
    },
  );

  test.each(vectors.signaling.cliMintedEndpoints)(
    "$inviteUrl dials the broker location the vector fixes",
    ({ inviteUrl, brokerLocation }) => {
      // The other side of the same coin: what THIS party's own run resolves the
      // connection to. The endpoint above is only a locator the partner can meet
      // if it names the socket this side is actually registered on.
      const connection = withWebRTCPeerRole(
        inviterConnectionFromURL(new URL(inviteUrl), {}),
        "inviter",
      );
      if (connection.channel !== "webrtc") throw new Error("expected webrtc");
      expect(
        webRtcDialFrom(connection, sharedSecret).options.location,
      ).toMatchObject(brokerLocation);
    },
  );
});

// --- the dial plan each configured role resolves to ---------------------------

/**
 * The connection an accepted (or hand-authored) webrtc config has for
 * `side`: the invitation's locator plus the role the accept path stamps. The
 * explicit `stun` entry is not part of the seeded shape asserted above; it is
 * here only so driving a rendezvous below does not emit the built-in-default ICE
 * advisory, which nothing in this file is about.
 */
function connectionFor(side: RendezvousRole): WebRTCConnectionConfig {
  return {
    channel: "webrtc",
    server: {
      host: vectors.signaling.endpoint.host,
      port: vectors.signaling.endpoint.port,
      path: vectors.signaling.endpoint.path,
    },
    role: side,
    stun: ["stun:127.0.0.1:3478"],
  };
}

describe("the dial plan the CLI resolves from its configured role", () => {
  test.each(vectors.rendezvous.sides)(
    "the $side connection takes the $handshakeRole handshake role",
    (side) => {
      const dial = webRtcDialFrom(connectionFor(side.side), sharedSecret);
      expect(dial.handshakeRole).toBe(side.handshakeRole);
      expect(dial.options.role).toBe(side.side);
    },
  );

  test("the broker location resolves to the endpoint the invitation named", () => {
    const dial = webRtcDialFrom(connectionFor("acceptor"), sharedSecret);
    expect(dial.options.location).toMatchObject({
      host: vectors.signaling.endpoint.host,
      port: vectors.signaling.endpoint.port,
      path: vectors.signaling.endpoint.path,
    });
  });
});

// --- the ids the CLI registers under and addresses -----------------------------

/** A broker socket the test drives: what the client sent, and what it is handed. */
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

  /** Confirm the registration, as the broker does with OPEN. */
  register(): void {
    this.readyState = ScriptedSocket.OPEN;
    this.emit("open", {});
    this.deliver({ type: BROKER_MESSAGE.open });
  }

  deliver(message: Record<string, unknown>): void {
    this.emit("message", { data: JSON.stringify(message) });
  }

  /** Has the client attached its listeners yet? */
  wired(): boolean {
    return (this.listeners.get("message")?.size ?? 0) > 0;
  }

  ofType(type: string): Array<Record<string, unknown>> {
    return this.sent.filter((frame) => frame.type === type);
  }

  private emit(type: string, event: unknown): void {
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event);
  }
}

/** A data channel that never opens: enough for the negotiation to watch it. */
class FakeChannel {
  readyState = "connecting";
  onopen: (() => void) | undefined;
  onclose: (() => void) | undefined;
  onmessage: ((event: unknown) => void) | undefined;
  onerror: ((event: unknown) => void) | undefined;
  close(): void {}
}

/** A peer connection stand-in: no ICE, no DTLS, no channel that ever opens. */
class ScriptedPeer {
  onicecandidate: ((event: { candidate?: unknown }) => void) | undefined;
  onconnectionstatechange: (() => void) | undefined;
  ondatachannel: ((event: { channel: unknown }) => void) | undefined;
  connectionState = "connecting";
  localDescription: { type: string; sdp: string } | undefined;
  readonly sctp = { sctp: { outboundQueue: [], sentQueue: [] } };

  createDataChannel(): FakeChannel {
    return new FakeChannel();
  }

  createOffer(): { type: string; sdp: string } {
    return { type: "offer", sdp: "v=0\r\n" };
  }

  setLocalDescription(description: { type: string; sdp: string }): void {
    this.localDescription = description;
  }

  close(): void {}
}

const running: Array<AbortController> = [];

/**
 * Start one rendezvous for `side` on the vector's shared secret and broker
 * location, registered with a scripted broker socket. The returned session is
 * never expected to open; each test aborts it.
 */
async function startRendezvous(side: RendezvousRole): Promise<{
  socket: ScriptedSocket;
  session: Promise<unknown>;
}> {
  const socket = new ScriptedSocket();
  const peer = new ScriptedPeer();
  const controller = new AbortController();
  running.push(controller);
  const session = openWebRtcPeerSession({
    ...webRtcDialFrom(connectionFor(side), sharedSecret).options,
    offerRetryIntervalMs: 60_000,
    rendezvousTimeoutMs: 60_000,
    channelOpenTimeoutMs: 60_000,
    signal: controller.signal,
    peerConnectionFactory: () => peer as unknown as RTCPeerConnection,
    socketFactory: () => socket as unknown as WebSocket,
  });
  // The rejection is the expected outcome of every test here; keep it handled
  // from the start so an abort landing before the assertion cannot show up as an
  // unhandled rejection.
  session.catch(() => {});
  // The rendezvous derives both ids before it opens the socket, so wait for the
  // client to attach its listeners rather than guessing how long that takes.
  await vi.waitFor(() => expect(socket.wired()).toBe(true));
  socket.register();
  return { socket, session };
}

afterEach(async () => {
  for (const controller of running.splice(0)) controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

describe("the rendezvous ids the CLI registers and addresses", () => {
  test.each(vectors.rendezvous.sides)(
    "the $side registers under the vector's $side id, at the invitation's broker",
    async (side) => {
      const socket = new ScriptedSocket();
      const peer = new ScriptedPeer();
      const controller = new AbortController();
      running.push(controller);
      const dialed: Array<string> = [];
      const session = openWebRtcPeerSession({
        ...webRtcDialFrom(connectionFor(side.side), sharedSecret).options,
        signal: controller.signal,
        peerConnectionFactory: () => peer as unknown as RTCPeerConnection,
        socketFactory: (url: string) => {
          dialed.push(url);
          return socket as unknown as WebSocket;
        },
      });
      session.catch(() => {});
      await vi.waitFor(() => expect(dialed.length).toBe(1));
      const url = new URL(dialed[0] as string);
      expect(url.searchParams.get("id")).toBe(side.localPeerId);
      expect(url.host).toBe(vectors.signaling.brokerHost);
      expect(url.pathname).toBe(vectors.signaling.brokerPathname);
    },
  );

  test("the acceptor offers to the inviter's derived id", async () => {
    const acceptor = sideVector("acceptor");
    const { socket } = await startRendezvous("acceptor");
    await vi.waitFor(() =>
      expect(socket.ofType(BROKER_MESSAGE.offer).length).toBe(1),
    );
    expect(socket.ofType(BROKER_MESSAGE.offer)[0]?.dst).toBe(
      acceptor.remotePeerId,
    );
  });

  test.each(vectors.rendezvous.sides)(
    "the $side acts only on frames from the id it expects its partner on",
    async (side) => {
      const { socket, session } = await startRendezvous(side.side);
      const settlement = watchSettlement(session);

      // A LEAVE from anyone else is not the partner and must not perturb the
      // rendezvous; the derived remote id is what tells the two apart.
      socket.deliver({
        type: BROKER_MESSAGE.leave,
        src: "0".repeat(vectors.rendezvous.peerIds.inviter.length),
      });
      await drainPendingWork();
      expect(settlement()).toBe("waiting");

      // The same delivery and the same drain, with the partner's id: a
      // settlement the drain CAN observe, which is what makes the reading above
      // a rejection that did not happen rather than one that had not arrived.
      socket.deliver({ type: BROKER_MESSAGE.leave, src: side.remotePeerId });
      await drainPendingWork();
      expect(settlement()).toBe("rejected");

      await expect(session).rejects.toThrow(
        /left the signaling server before the connection was established/,
      );
    },
  );
});

/** Record how a rendezvous settles, without waiting on a promise that may be
 * meant never to settle at all. */
function watchSettlement(
  session: Promise<unknown>,
): () => "waiting" | "resolved" | "rejected" {
  let state: "waiting" | "resolved" | "rejected" = "waiting";
  void session.then(
    () => {
      state = "resolved";
    },
    () => {
      state = "rejected";
    },
  );
  return () => state;
}

/**
 * Let every job the delivery just queued run to completion: the negotiation
 * latches a terminal failure synchronously inside the socket's message
 * dispatch, so a chain of microtasks is what stands between that latch and the
 * settlement this test reads; `setImmediate` resolves once it has drained. Not
 * a wall-clock wait: a timed one would let a slow runner report "still
 * waiting" for a rejection that had merely not arrived yet.
 */
function drainPendingWork(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}
