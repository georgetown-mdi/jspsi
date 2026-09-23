import { afterEach, describe, expect, test, vi } from "vitest";

import { default as EventEmitter } from "eventemitter3";

import {
  RELAY_CREDENTIAL_MAX_TTL_SECONDS,
  deriveRelayKey,
  generateSharedSecret,
  mintRelayCredential,
} from "@psilink/core";

import {
  RELAY_CREDENTIAL_TTL_SECONDS,
  buildIceServers,
  dialAsAcceptor,
  listenAsInviter,
} from "../../../src/psi/transport/rendezvous.js";
import { DEFAULT_PEER_WAIT_TIMEOUT_MS } from "../../../src/psi/transport/waitForConnection.js";
import { relayForRun } from "../../../src/psi/transport/ownRelaySetting.js";

import type { OwnRelayRead } from "../../../src/psi/transport/ownRelaySetting.js";
import type Peer from "peerjs";
import type { PeerOptions } from "peerjs";
import type { RelayLocator } from "../../../src/psi/transport/rendezvous.js";
import type { WebRTCEndpoint } from "@psilink/core";

// The ICE configuration the browser's peer connection is built with: the
// default STUN pair alone with no relay, and with a relay its own urls in
// place of that pair, the TURN entry holding a credential minted for this run
// from the exchange's shared secret.

/** The configuration every run used before a relay could be supplied. */
const NO_RELAY_CONFIG = {
  iceServers: [
    { urls: ["stun:stun.l.google.com:19302", "stun:44.247.30.68:443"] },
  ],
  sdpSemantics: "unified-plan",
  iceTransportPolicy: "all",
};

const RELAY: RelayLocator = {
  turn: ["turns:relay.example.org:443?transport=tcp"],
  stun: [],
};

const NOW = new Date("2026-09-22T12:00:00Z");

class FakePeer extends EventEmitter {
  destroy = vi.fn();
  connect = vi.fn();
}

/** Construct a peer through the rendezvous and return the options it was
 * built with; the peer never opens, so the call is left pending. */
async function peerOptionsOf(
  start: (factory: (id: string, options: PeerOptions) => Peer) => unknown,
): Promise<PeerOptions> {
  let captured: PeerOptions | undefined;
  const fake = new FakePeer();
  void start((_id, options) => {
    captured = options;
    return fake as unknown as Peer;
  });
  await vi.waitFor(() => expect(captured).toBeDefined());
  return captured as PeerOptions;
}

const endpoint: WebRTCEndpoint = {
  channel: "webrtc",
  host: "127.0.0.1",
  port: 3000,
  path: "/api/",
};

function stubWindow(): void {
  vi.stubGlobal("window", {
    location: { hostname: "localhost", port: "3000", protocol: "http:" },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("buildIceServers", () => {
  test("with no relay is the default STUN pair alone", async () => {
    expect(
      await buildIceServers(undefined, generateSharedSecret(), NOW),
    ).toEqual(NO_RELAY_CONFIG.iceServers);
  });

  test("with a relay naming no url is the default STUN pair alone", async () => {
    expect(
      await buildIceServers(
        { turn: [], stun: [] },
        generateSharedSecret(),
        NOW,
      ),
    ).toEqual(NO_RELAY_CONFIG.iceServers);
  });

  test("with TURN urls alone is the TURN entry alone, with no STUN entry", async () => {
    const secret = generateSharedSecret();
    const expected = await mintRelayCredential({
      key: await deriveRelayKey(secret),
      label: "psilink",
      ttlSeconds: RELAY_CREDENTIAL_TTL_SECONDS,
      now: NOW,
    });

    const iceServers = await buildIceServers(RELAY, secret, NOW);
    expect(iceServers).toEqual([
      {
        urls: RELAY.turn,
        username: expected.username,
        credential: expected.credential,
      },
    ]);
    expect(
      iceServers
        .flatMap((server) => server.urls)
        .filter((url) => url.startsWith("stun")),
    ).toEqual([]);
  });

  test("with TURN and STUN urls holds the relay's STUN entry and the TURN entry", async () => {
    const relay: RelayLocator = {
      turn: RELAY.turn,
      stun: ["stun:stun.example.org:3478"],
    };
    const iceServers = await buildIceServers(
      relay,
      generateSharedSecret(),
      NOW,
    );
    expect(iceServers).toHaveLength(2);
    expect(iceServers[0]).toEqual({ urls: ["stun:stun.example.org:3478"] });
    expect(iceServers[1].urls).toEqual(RELAY.turn);
  });

  test("the relay's STUN urls replace the default pair", async () => {
    const relay: RelayLocator = {
      turn: [],
      stun: ["stun:stun.example.org:3478"],
    };
    expect(await buildIceServers(relay, generateSharedSecret(), NOW)).toEqual([
      { urls: ["stun:stun.example.org:3478"] },
    ]);
  });

  test("the credential expires one lifetime after the run starts", async () => {
    const [turn] = await buildIceServers(RELAY, generateSharedSecret(), NOW);
    const expiry = Number(turn.username?.split(":")[0]);
    expect(expiry).toBe(NOW.getTime() / 1000 + RELAY_CREDENTIAL_TTL_SECONDS);
  });

  test("each run mints its own credential rather than reusing one", async () => {
    const secret = generateSharedSecret();
    const first = await buildIceServers(RELAY, secret, NOW);
    const later = await buildIceServers(
      RELAY,
      secret,
      new Date(NOW.getTime() + 60_000),
    );
    const otherExchange = await buildIceServers(
      RELAY,
      generateSharedSecret(),
      NOW,
    );
    expect(later[0].username).not.toBe(first[0].username);
    expect(otherExchange[0].credential).not.toBe(first[0].credential);
  });
});

test("the credential lifetime covers the peer wait and stays within an hour", () => {
  expect(RELAY_CREDENTIAL_TTL_SECONDS).toBeGreaterThan(
    DEFAULT_PEER_WAIT_TIMEOUT_MS / 1000,
  );
  expect(RELAY_CREDENTIAL_TTL_SECONDS).toBeLessThanOrEqual(
    RELAY_CREDENTIAL_MAX_TTL_SECONDS,
  );
  expect(RELAY_CREDENTIAL_MAX_TTL_SECONDS).toBe(3600);
});

describe.each([
  {
    seat: "inviter",
    start: (
      secret: string,
      relay: RelayLocator | undefined,
      factory: (id: string, options: PeerOptions) => Peer,
    ) => listenAsInviter(secret, { relay, peerFactory: factory }),
  },
  {
    seat: "acceptor",
    start: (
      secret: string,
      relay: RelayLocator | undefined,
      factory: (id: string, options: PeerOptions) => Peer,
    ) => dialAsAcceptor(secret, endpoint, { relay, peerFactory: factory }),
  },
])("the $seat's peer", ({ start }) => {
  test("with no relay is built with the unchanged configuration", async () => {
    stubWindow();
    const options = await peerOptionsOf((factory) =>
      start(generateSharedSecret(), undefined, factory),
    );
    expect(options.config).toStrictEqual(NO_RELAY_CONFIG);
  });

  test("with a TURN-only relay holds the TURN entry minted for this run alone", async () => {
    stubWindow();
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    const secret = generateSharedSecret();
    const expected = await mintRelayCredential({
      key: await deriveRelayKey(secret),
      label: "psilink",
      ttlSeconds: RELAY_CREDENTIAL_TTL_SECONDS,
      now: NOW,
    });
    const options = await peerOptionsOf((factory) =>
      start(secret, RELAY, factory),
    );
    expect(options.config).toStrictEqual({
      ...NO_RELAY_CONFIG,
      iceServers: [
        {
          urls: RELAY.turn,
          username: expected.username,
          credential: expected.credential,
        },
      ],
    });
  });
});

// The acceptor seat dials the invitation's endpoint with the relay
// `relayForRun(endpoint.relay)` selects (useAcceptorExchange, managed re-run).
describe("the acceptor seat's dial of an invitation endpoint", () => {
  const OWN: RelayLocator = {
    turn: ["turns:own-relay.example.org:443?transport=tcp"],
    stun: ["stun:own-relay.example.org:3478"],
  };
  const NAMED = {
    turn: ["turns:partner-relay.example.org:443?transport=tcp"],
    stun: ["stun:partner-relay.example.org:3478"],
  };

  async function dialConfig(
    invited: WebRTCEndpoint,
    readOwn: () => OwnRelayRead,
    secret: string,
  ): Promise<RTCConfiguration> {
    const options = await peerOptionsOf((factory) =>
      dialAsAcceptor(secret, invited, {
        relay: relayForRun(invited.relay, readOwn),
        peerFactory: factory,
      }),
    );
    return options.config as RTCConfiguration;
  }

  test("prefers the invitation's relay over this browser's own", async () => {
    stubWindow();
    const secret = generateSharedSecret();
    const config = await dialConfig(
      { ...endpoint, relay: NAMED },
      () => ({
        kind: "set",
        relay: OWN,
      }),
      secret,
    );
    const urls = config.iceServers?.flatMap((server) => server.urls);
    expect(urls).toEqual([...NAMED.stun, ...NAMED.turn]);
  });

  test("falls back to this browser's own relay when the invitation names none", async () => {
    stubWindow();
    const config = await dialConfig(
      endpoint,
      () => ({ kind: "set", relay: OWN }),
      generateSharedSecret(),
    );
    const urls = config.iceServers?.flatMap((server) => server.urls);
    expect(urls).toEqual([...OWN.stun, ...OWN.turn]);
  });

  test("with neither is built with the unchanged configuration", async () => {
    stubWindow();
    const config = await dialConfig(
      endpoint,
      () => ({ kind: "none" }),
      generateSharedSecret(),
    );
    expect(config).toStrictEqual(NO_RELAY_CONFIG);
  });
});
