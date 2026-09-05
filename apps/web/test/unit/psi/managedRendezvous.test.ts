import { afterEach, describe, expect, test, vi } from "vitest";

import { default as EventEmitter } from "eventemitter3";

import {
  deriveRendezvousPeerId,
  generateSharedSecret,
  getDefaultLinkageTerms,
} from "@psilink/core";

import {
  assertManagedRerunDispatchable,
  beginManagedRendezvous,
} from "@psi/managed/managedRendezvous";
import { composeManagedExchangeFile } from "@psi/managed/managedExchangeRecord";

import type {
  ExchangeSpec,
  WebRTCEndpoint,
  WebRTCExchangeLocator,
} from "@psilink/core";
import type { DataConnection } from "peerjs";
import type Peer from "peerjs";

import type { ManagedRendezvousFlows } from "@psi/managed/managedRendezvous";

// The side-dispatched rendezvous, tested in Node with the rendezvous flows faked:
// the record's local `side` selects listenAsInviter vs dialAsAcceptor, the
// current sharedSecret goes to whichever runs (its peer id derives fresh, never
// from storage), and the acceptor's dial endpoint comes from the app's OWN
// location, not the stored document's server locator, which the spec keeps inert
// (docs/spec/MANAGED_EXCHANGE_RECORD.md, "Role: a local side field").

// Every locator field differs from the stubbed app location below, so an
// assertion on the dial endpoint distinguishes the two sources.
const webrtcLocator: WebRTCExchangeLocator = {
  channel: "webrtc",
  host: "signaling.example.org",
  port: 9999,
  path: "/stored-locator/",
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
  acceptorCalls: Array<{
    secret: string;
    endpoint: WebRTCEndpoint;
    options: Parameters<ManagedRendezvousFlows["dialAsAcceptor"]>[2];
  }>;
} {
  const inviterCalls: Array<{ secret: string }> = [];
  const acceptorCalls: Array<{
    secret: string;
    endpoint: WebRTCEndpoint;
    options: Parameters<ManagedRendezvousFlows["dialAsAcceptor"]>[2];
  }> = [];
  const flows: ManagedRendezvousFlows = {
    listenAsInviter: (secret) => {
      inviterCalls.push({ secret });
      return Promise.resolve(fakePeer("inviter"));
    },
    dialAsAcceptor: (secret, endpoint, options) => {
      acceptorCalls.push({ secret, endpoint, options });
      return Promise.resolve([fakePeer("acceptor"), fakeConn()]);
    },
  };
  return { flows, inviterCalls, acceptorCalls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The app's own location, stubbed: what the acceptor's dial endpoint must derive
 * from. */
function stubAppLocation(): void {
  vi.stubGlobal("window", {
    location: {
      origin: "https://app.example.test:3000",
      hostname: "app.example.test",
      port: "3000",
      protocol: "https:",
    },
  });
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

  test("side acceptor runs dialAsAcceptor with the current secret", async () => {
    stubAppLocation();
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
  });

  test("the acceptor dials the app's own location; the stored locator is inert", async () => {
    stubAppLocation();
    const { flows, acceptorCalls } = recordingFlows();

    await beginManagedRendezvous(
      "acceptor",
      generateSharedSecret(),
      exchangeFile(),
      { flows },
    );

    // The dial endpoint derives from the app's own location (origin isolation: a
    // record exists only at the origin it was deposited at), never from the
    // document's persisted server locator, which the spec keeps inert.
    const endpoint = acceptorCalls[0].endpoint;
    expect(endpoint).toEqual({
      channel: "webrtc",
      host: "app.example.test",
      port: 3000,
      path: "/api/",
    });
    expect(endpoint.host).not.toBe(webrtcLocator.host);
    expect(endpoint.port).not.toBe(webrtcLocator.port);
    expect(endpoint.path).not.toBe(webrtcLocator.path);
  });

  test("passes a supplied peer-wait bound into the acceptor's dial budget", async () => {
    stubAppLocation();
    const { flows, acceptorCalls } = recordingFlows();

    await beginManagedRendezvous(
      "acceptor",
      generateSharedSecret(),
      exchangeFile(),
      { flows, peerWaitTimeoutMs: 90_000 },
    );

    expect(acceptorCalls[0].options?.totalTimeoutMs).toBe(90_000);
  });

  test("supplies no dial budget of its own when none is given", async () => {
    stubAppLocation();
    const { flows, acceptorCalls } = recordingFlows();

    await beginManagedRendezvous(
      "acceptor",
      generateSharedSecret(),
      exchangeFile(),
      { flows },
    );

    // Absent rather than an explicit undefined, and absent rather than a bound
    // this module picked: the dial keeps the flows' own shared default, and the
    // only policy that overrides it is the scheduled runner's window clamp.
    expect(acceptorCalls[0].options).not.toHaveProperty("totalTimeoutMs");
  });

  test("a non-webrtc stored connection cannot re-run and fails before any flow", async () => {
    // A record whose connection is not webrtc is not live-coordinated; the dispatch
    // must fail before either flow runs, on either side.
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
    await expect(
      beginManagedRendezvous("inviter", generateSharedSecret(), notWebrtc, {
        flows,
      }),
    ).rejects.toThrow(/webrtc/);
    expect(inviterCalls).toHaveLength(0);
    expect(acceptorCalls).toHaveLength(0);
  });
});

describe("assertManagedRerunDispatchable", () => {
  test("accepts a webrtc record and rejects any other channel", () => {
    expect(() => assertManagedRerunDispatchable(exchangeFile())).not.toThrow();
    const notWebrtc = {
      ...exchangeFile(),
      connection: { channel: "sftp" },
    } as unknown as ExchangeSpec;
    expect(() => assertManagedRerunDispatchable(notWebrtc)).toThrow(/sftp/);
  });
});

// --- Per-run peer-id derivation from the CURRENT secret (real listenAsInviter) --

class FakePeer extends EventEmitter {
  destroy = vi.fn();
  disconnect = vi.fn();
}

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
    const { listenAsInviter } = await import("@psi/transport/rendezvous");
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
