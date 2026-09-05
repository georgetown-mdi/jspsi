import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { default as EventEmitter } from "eventemitter3";

import { ConnectionError } from "@psilink/core";

import {
  dialAsAcceptor,
  listenAsInviter,
} from "../../src/psi/transport/rendezvous.js";
import { HANDSHAKE_ROLE_FOR_SIDE } from "../../src/psi/handshakeRole.js";
import { authenticateExchange } from "../../src/psi/authenticateExchange.js";
import { prepareAcceptedInvitation } from "../../src/psi/acceptInvitation.js";
import { webrtcEndpointFromLocation } from "../../src/psi/invitation.js";

import type { DataConnection, PeerOptions } from "peerjs";
import type {
  HandshakeRole,
  InvitationToken,
  MessageConnection,
  RendezvousRole,
  WebRTCEndpoint,
} from "@psilink/core";
import type Peer from "peerjs";

/**
 * The web half of the CLI<->web WebRTC interop conformance check: the web app
 * and the CLI build the same rendezvous and key-exchange parts independently
 * from a shared core, and this file drives only the web app's own
 * constructions against the known-answer vectors in
 * packages/core/test/vectors/webrtc-interop-vectors.json.
 *
 * The CLI drives the same file from its own suite; the constructions core
 * alone owns are pinned in packages/core/test/webrtcInterop.test.ts.
 * webrtcInteropHooks.test.ts and managedRunDriver.test.ts cover the rest of
 * the web app's half, and test/browser/webrtcInterop.test.ts re-runs the
 * crypto.subtle-borne derivations in real Chromium.
 */

interface InteropVectors {
  inputs: {
    sharedSecret: string;
    signalingLocation: { hostname: string; port: string };
  };
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
      "../../../../packages/core/test/vectors/webrtc-interop-vectors.json",
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

const { sharedSecret, signalingLocation } = vectors.inputs;

/** A PeerJS data channel stand-in: the events and methods the dial touches. */
class FakeConn extends EventEmitter {
  close = vi.fn();
}

/** A PeerJS peer stand-in: the events and methods the rendezvous touches. */
class FakePeer extends EventEmitter {
  destroy = vi.fn();
  disconnect = vi.fn();
  readonly dialed: Array<string> = [];
  connect = vi.fn((id: string) => {
    this.dialed.push(id);
    return new FakeConn() as unknown as DataConnection;
  });
}

/** Capture the (id, options) the rendezvous constructs its Peer with, and open
 * it so the caller's registration resolves. */
function capturingPeerFactory(): {
  factory: (id: string, options: PeerOptions) => Peer;
  peer: FakePeer;
  registeredId: () => string;
  options: () => PeerOptions;
} {
  const peer = new FakePeer();
  let capturedId: string | undefined;
  let capturedOptions: PeerOptions | undefined;
  return {
    peer,
    factory: (id, options) => {
      capturedId = id;
      capturedOptions = options;
      // The rendezvous attaches its listeners synchronously after construction;
      // emit on the next turn so `open` is not lost before they are wired.
      setTimeout(() => peer.emit("open", id), 0);
      return peer as unknown as Peer;
    },
    registeredId: () => {
      if (capturedId === undefined) throw new Error("peer not constructed");
      return capturedId;
    },
    options: () => {
      if (capturedOptions === undefined)
        throw new Error("peer not constructed");
      return capturedOptions;
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("window", {
    location: {
      hostname: signalingLocation.hostname,
      port: signalingLocation.port,
      protocol: "https:",
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the signaling locator the web app mints", () => {
  test("reproduces the endpoint vector from the inviter's browser location", () => {
    // What the CLI acceptor seeds its connection block from. The endpoint names
    // no scheme by design; each side resolves ws vs wss locally.
    expect(webrtcEndpointFromLocation(signalingLocation)).toEqual(
      vectors.signaling.endpoint,
    );
  });

  test("the inviter listens at the locator it minted", async () => {
    // Same browser location on both sides of the mint/listen pair, so an
    // invitation cannot name a broker its own inviter is not registered with.
    const endpoint = vectors.signaling.endpoint;
    const cap = capturingPeerFactory();
    await listenAsInviter(sharedSecret, { peerFactory: cap.factory });
    expect(cap.options()).toMatchObject({
      host: endpoint.host,
      port: endpoint.port,
      path: endpoint.path,
    });
  });
});

describe("the signaling location a web acceptor resolves from a CLI-minted endpoint", () => {
  test.each(vectors.signaling.cliMintedEndpoints)(
    "$inviteUrl resolves to the broker location the CLI itself dials",
    async ({ endpoint, brokerLocation }) => {
      // The CLI-mint -> browser-accept direction. This side resolves an absent
      // endpoint field from a default of its own -- the app's own `/api/` mount
      // for the path, its own page protocol for the port -- so a locator minted
      // by the other application is only met if what it names survives that
      // resolution unchanged. The vector fixes the socket both sides must reach.
      const cap = capturingPeerFactory();
      const dial = dialAsAcceptor(sharedSecret, endpoint, {
        peerFactory: cap.factory,
      });
      await vi.waitFor(() => expect(cap.peer.dialed.length).toBe(1));
      expect(cap.options()).toMatchObject(brokerLocation);
      // The dial never opens here; abandon it so the retry loop stops.
      cap.peer.emit(
        "error",
        Object.assign(new Error("stop"), { type: "fatal" }),
      );
      await expect(dial).rejects.toThrow();
    },
  );
});

describe("the peer ids the web app registers and dials", () => {
  test("the inviter registers on the vector's inviter id", async () => {
    const cap = capturingPeerFactory();
    await listenAsInviter(sharedSecret, { peerFactory: cap.factory });
    expect(cap.registeredId()).toBe(sideVector("inviter").localPeerId);
  });

  test("the acceptor registers on its own id and dials the inviter's", async () => {
    const cap = capturingPeerFactory();
    const dial = dialAsAcceptor(sharedSecret, vectors.signaling.endpoint, {
      peerFactory: cap.factory,
    });
    await vi.waitFor(() => expect(cap.peer.dialed.length).toBe(1));
    const acceptor = sideVector("acceptor");
    expect(cap.registeredId()).toBe(acceptor.localPeerId);
    expect(cap.peer.dialed[0]).toBe(acceptor.remotePeerId);
    // The dial never opens here; abandon it so the retry loop stops.
    cap.peer.emit("error", Object.assign(new Error("stop"), { type: "fatal" }));
    await expect(dial).rejects.toThrow();
  });
});

describe("the invitation the web acceptor consumes", () => {
  test("decoding the pinned invitation yields the vector token and endpoint", async () => {
    const accepted = await prepareAcceptedInvitation(
      vectors.invitation.encoded,
      { profile: "hosted" },
    );
    expect(accepted.token).toEqual(vectors.invitation.token);
    expect(accepted.endpoint).toEqual(vectors.signaling.endpoint);
  });

  test("the token's secret derives the rendezvous ids the acceptor dials", async () => {
    const accepted = await prepareAcceptedInvitation(
      vectors.invitation.encoded,
      { profile: "hosted" },
    );
    const cap = capturingPeerFactory();
    const dial = dialAsAcceptor(
      accepted.token.sharedSecret,
      accepted.endpoint as WebRTCEndpoint,
      { peerFactory: cap.factory },
    );
    await vi.waitFor(() => expect(cap.peer.dialed.length).toBe(1));
    expect(cap.registeredId()).toBe(vectors.rendezvous.peerIds.acceptor);
    expect(cap.peer.dialed[0]).toBe(vectors.rendezvous.peerIds.inviter);
    cap.peer.emit("error", Object.assign(new Error("stop"), { type: "fatal" }));
    await expect(dial).rejects.toThrow();
  });
});

/** A message connection under the test's control: what the handshake sent, and
 * what it is handed back, with an `end` that unwinds a parked receive. */
function scriptedConnection(): {
  conn: MessageConnection;
  sent: Array<Record<string, unknown>>;
  receives: () => number;
  reply: (value: unknown) => void;
  end: () => void;
} {
  const sent: Array<Record<string, unknown>> = [];
  const queue: Array<unknown> = [];
  const waiters: Array<{
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }> = [];
  let receiveCount = 0;
  let ended = false;
  const closed = (): ConnectionError =>
    new ConnectionError("the scripted connection ended", "closed");
  return {
    sent,
    receives: () => receiveCount,
    reply: (value) => {
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(value);
      else queue.push(value);
    },
    end: () => {
      ended = true;
      for (const waiter of waiters.splice(0)) waiter.reject(closed());
    },
    conn: {
      send: (value: unknown) => {
        sent.push(value as Record<string, unknown>);
        return Promise.resolve();
      },
      receive: async () => {
        receiveCount += 1;
        if (ended) throw closed();
        const queued = queue.shift();
        if (queued !== undefined) return queued;
        return new Promise((resolve, reject) => {
          waiters.push({ resolve, reject });
        });
      },
      close: async () => {},
      setInboundFrameCap: () => {},
    },
  };
}

/** A base64url SEC1 uncompressed P-256 point, the only ephemeral share encoding
 * the key exchange accepts on the wire. */
async function ephemeralShare(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const raw = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  return Buffer.from(raw).toString("base64url");
}

describe("the handshake role and encryption request the web app puts on the wire", () => {
  test("the side-to-role table matches the vector for every rendezvous side", () => {
    // The one table all three web flows read (the one-shot inviter and acceptor
    // and the managed re-run). Necessary and not sufficient: a flow that read
    // the wrong side out of a correct table would still take a role the CLI does
    // not pair with, so which KEY each one reads is pinned at its own call site
    // (webrtcInteropHooks.test.ts, managedRunDriver.test.ts).
    for (const side of vectors.rendezvous.sides)
      expect(HANDSHAKE_ROLE_FOR_SIDE[side.side]).toBe(side.handshakeRole);
  });

  test("the acceptor's role sends the first message, declining the AEAD wrap", async () => {
    const acceptor = sideVector("acceptor");
    const scripted = scriptedConnection();
    const run = authenticateExchange(
      scripted.conn,
      HANDSHAKE_ROLE_FOR_SIDE[acceptor.side],
      sharedSecret,
    );
    await vi.waitFor(() => expect(scripted.sent.length).toBe(1));
    expect(scripted.sent[0]).toMatchObject({
      kexMsg: "1",
      reqEnc: acceptor.requestEncryption,
    });
    scripted.end();
    await expect(run).rejects.toThrow();
  });

  test("the inviter's role answers rather than opening, declining the wrap too", async () => {
    const inviter = sideVector("inviter");
    const scripted = scriptedConnection();
    const run = authenticateExchange(
      scripted.conn,
      HANDSHAKE_ROLE_FOR_SIDE[inviter.side],
      sharedSecret,
    );
    // Parked on a receive with nothing sent: this side waits for its partner's
    // first message, which is what makes the pair complementary.
    await vi.waitFor(() => expect(scripted.receives()).toBe(1));
    expect(scripted.sent).toEqual([]);

    scripted.reply({
      kexMsg: "1",
      e: await ephemeralShare(),
      reqEnc: false,
    });
    await vi.waitFor(() => expect(scripted.sent.length).toBe(1));
    expect(scripted.sent[0]).toMatchObject({
      kexMsg: "2",
      reqEnc: inviter.requestEncryption,
    });
    scripted.end();
    await expect(run).rejects.toThrow();
  });
});
