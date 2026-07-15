import { afterEach, describe, expect, test, vi } from "vitest";

import { default as EventEmitter } from "eventemitter3";

import {
  deriveRendezvousPeerId,
  generateSharedSecret,
  getDefaultLinkageTerms,
} from "@psilink/core";

import {
  acceptorEndpointFromRecord,
  beginManagedRendezvous,
} from "@psi/managedRendezvous";
import { composeManagedExchangeFile } from "@psi/managedExchangeRecord";

import type {
  ExchangeSpec,
  WebRTCEndpoint,
  WebRTCExchangeLocator,
} from "@psilink/core";
import type { DataConnection } from "peerjs";
import type Peer from "peerjs";

import type { ManagedRendezvousFlows } from "@psi/managedRendezvous";

// The side-dispatched rendezvous, tested in Node with the rendezvous flows faked:
// the record's local `side` selects listenAsInviter vs dialAsAcceptor, and the
// record's CURRENT sharedSecret is passed to whichever runs (so its peer id
// derives fresh, never from storage). One test drives the REAL listenAsInviter
// through an injected peer factory to prove the constructed id is
// deriveRendezvousPeerId over the current secret -- the "derived, never stored"
// property by construction.

const webrtcLocator: WebRTCExchangeLocator = {
  channel: "webrtc",
  host: "signaling.example.org",
  port: 3000,
  path: "/api/",
};

function exchangeFile(
  locator: WebRTCExchangeLocator = webrtcLocator,
): ExchangeSpec {
  return composeManagedExchangeFile({
    connection: locator,
    linkageTerms: getDefaultLinkageTerms("County Health Dept"),
  });
}

/** A fake peer the flows resolve, distinct per flow so a test can tell which ran. */
function fakePeer(tag: string): Peer {
  return { tag } as unknown as Peer;
}

function fakeConn(): DataConnection {
  return {} as unknown as DataConnection;
}

/** Recording flows: capture the (secret, endpoint) each flow was called with, so a
 * test asserts the side dispatch and the current-secret pass-through. */
function recordingFlows(): {
  flows: ManagedRendezvousFlows;
  inviterCalls: Array<{ secret: string }>;
  acceptorCalls: Array<{ secret: string; endpoint: WebRTCEndpoint }>;
} {
  const inviterCalls: Array<{ secret: string }> = [];
  const acceptorCalls: Array<{ secret: string; endpoint: WebRTCEndpoint }> = [];
  const flows: ManagedRendezvousFlows = {
    listenAsInviter: (secret) => {
      inviterCalls.push({ secret });
      return Promise.resolve(fakePeer("inviter"));
    },
    dialAsAcceptor: (secret, endpoint) => {
      acceptorCalls.push({ secret, endpoint });
      return Promise.resolve([fakePeer("acceptor"), fakeConn()]);
    },
  };
  return { flows, inviterCalls, acceptorCalls };
}

describe("beginManagedRendezvous: side dispatch", () => {
  test("side inviter runs listenAsInviter with the current secret, not dialAsAcceptor", async () => {
    const secret = generateSharedSecret();
    const { flows, inviterCalls, acceptorCalls } = recordingFlows();

    const acquisition = await beginManagedRendezvous(
      "inviter",
      secret,
      exchangeFile(),
      { flows },
    );

    expect(acquisition.side).toBe("inviter");
    expect(inviterCalls).toEqual([{ secret }]);
    // The acceptor flow was never reached: the dispatch is on `side`.
    expect(acceptorCalls).toHaveLength(0);
  });

  test("side acceptor runs dialAsAcceptor with the current secret and the record endpoint", async () => {
    const secret = generateSharedSecret();
    const { flows, inviterCalls, acceptorCalls } = recordingFlows();

    const acquisition = await beginManagedRendezvous(
      "acceptor",
      secret,
      exchangeFile(),
      { flows },
    );

    expect(acquisition.side).toBe("acceptor");
    expect(inviterCalls).toHaveLength(0);
    expect(acceptorCalls).toHaveLength(1);
    expect(acceptorCalls[0].secret).toBe(secret);
    // The dial endpoint is the record's persisted webrtc connection block.
    expect(acceptorCalls[0].endpoint).toEqual({
      channel: "webrtc",
      host: webrtcLocator.host,
      port: webrtcLocator.port,
      path: webrtcLocator.path,
    });
  });

  test("a non-webrtc stored connection cannot re-run and fails before any flow", async () => {
    // A record whose connection is not webrtc is not live-coordinated; the dispatch
    // must fail before either flow runs.
    const notWebrtc = {
      ...exchangeFile(),
      connection: { channel: "filedrop" },
    } as unknown as ExchangeSpec;
    const { flows, inviterCalls, acceptorCalls } = recordingFlows();
    await expect(
      beginManagedRendezvous("acceptor", generateSharedSecret(), notWebrtc, {
        flows,
      }),
    ).rejects.toThrow(/webrtc/);
    expect(inviterCalls).toHaveLength(0);
    expect(acceptorCalls).toHaveLength(0);
  });
});

describe("acceptorEndpointFromRecord", () => {
  test("reshapes the persisted connection block, dropping an absent optional", () => {
    const hostOnly = exchangeFile({ channel: "webrtc", host: "peer.example" });
    expect(acceptorEndpointFromRecord(hostOnly)).toEqual({
      channel: "webrtc",
      host: "peer.example",
    });
  });
});

// --- Per-run peer-id derivation from the CURRENT secret (real listenAsInviter) --

class FakePeer extends EventEmitter {
  destroy = vi.fn();
  disconnect = vi.fn();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("per-run peer id derives fresh from the current secret", () => {
  test("the inviter registers on deriveRendezvousPeerId(currentSecret, inviter)", async () => {
    vi.stubGlobal("window", {
      location: { hostname: "localhost", port: "3000", protocol: "http:" },
    });
    const secret = generateSharedSecret();
    const expected = await deriveRendezvousPeerId(secret, "inviter");

    // The real listenAsInviter with an injected peer factory: capture the id it
    // registers, which must be the derivation over THIS secret (never a stored id).
    let constructedId: string | undefined;
    const { listenAsInviter } = await import("@psi/rendezvous");
    const flows: ManagedRendezvousFlows = {
      listenAsInviter: (s, options) =>
        listenAsInviter(s, {
          ...options,
          peerFactory: (id) => {
            constructedId = id;
            const peer = new FakePeer();
            queueMicrotask(() => peer.emit("open"));
            return peer as unknown as Peer;
          },
        }),
      dialAsAcceptor: () => {
        throw new Error("acceptor flow must not run for side inviter");
      },
    };

    await beginManagedRendezvous("inviter", secret, exchangeFile(), { flows });
    expect(constructedId).toBe(expected);

    // A different secret derives a different id: the id is not read from storage.
    const otherSecret = generateSharedSecret();
    const otherExpected = await deriveRendezvousPeerId(otherSecret, "inviter");
    expect(otherExpected).not.toBe(expected);
  });
});
