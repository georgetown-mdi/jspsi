import dns from "node:dns";

import { RTCPeerConnection } from "werift";
import { expect, test } from "vitest";

import { buildPeerConfiguration } from "../../../src/connection/webrtc/weriftPeer";

import type { WeriftPeerConfiguration } from "../../../src/connection/webrtc/weriftPeer";
import type { RTCIceCandidate } from "werift";

/**
 * `connection.ice_transport_policy`, from the configuration through to what
 * werift gathers.
 *
 * The library half is driven rather than read: the whole point of the setting
 * is that werift honors it, so the arms below construct real peer connections
 * and compare what each gathers. No arm reaches the network. Every server named
 * here is a loopback address with nothing listening, so the relay arm gathers
 * nothing and the default arm gathers the host candidate it always would; the
 * arm that names no server werift can parse falls back to werift's built-in
 * Google STUN default, so it runs with the resolver intercepted, as the sibling
 * transport suite does for the same case (transport.test.ts).
 */

/** Nothing listens here; naming it keeps every arm on loopback. */
const UNREACHABLE_TURN = {
  urls: "turn:127.0.0.1:3478",
  username: "psilink",
  credential: "placeholder-not-a-secret",
};
const UNREACHABLE_STUN = { urls: "stun:127.0.0.1:3478" };

/**
 * A TURN entry naming no host, the shape an empty environment substitution
 * leaves behind. The connection schema refuses it
 * (`packages/core/src/config/connection.ts`); the arm below is what that
 * refusal keeps out, so it is built here rather than parsed.
 */
const HOSTLESS_TURN = {
  urls: "turn:",
  username: "psilink",
  credential: "placeholder-not-a-secret",
};

/**
 * How long a gathering arm may take. An unreachable ICE server is abandoned on
 * werift's own timer, which is what each arm waits out, so this sits well above
 * the six or seven seconds that takes.
 */
const GATHERING_TIMEOUT_MS = 30_000;

/**
 * Run `gather` with DNS resolution short-circuited, so a peer left with no
 * server it can parse cannot reach werift's built-in Google STUN default: the
 * lookup that fallback needs fails at once and no packet leaves the machine.
 * werift resolves through `dns.promises.lookup`; the callback form is hooked
 * too so a future switch does not silently reach the network.
 */
async function withResolverIntercepted<T>(
  gather: () => Promise<T>,
): Promise<T> {
  const intercepted = new Error("resolver intercepted by the ICE policy suite");
  const realPromiseLookup = dns.promises.lookup;
  const realCallbackLookup = dns.lookup;
  (dns.promises as { lookup: unknown }).lookup = async (): Promise<never> => {
    throw intercepted;
  };
  (dns as { lookup: unknown }).lookup = (
    _hostname: string,
    options: unknown,
    callback: unknown,
  ): void => {
    const cb = (typeof options === "function" ? options : callback) as (
      err: Error,
    ) => void;
    cb(intercepted);
  };
  try {
    return await gather();
  } finally {
    (dns.promises as { lookup: unknown }).lookup = realPromiseLookup;
    (dns as { lookup: unknown }).lookup = realCallbackLookup;
  }
}

/** Candidates one peer connection gathered by the time gathering completed. */
async function gatheredCandidates(
  configuration: WeriftPeerConfiguration,
): Promise<Array<string>> {
  const peer = new RTCPeerConnection(configuration);
  const candidates: Array<string> = [];
  peer.onicecandidate = ({ candidate }: { candidate?: RTCIceCandidate }) => {
    if (candidate !== undefined) candidates.push(candidate.candidate);
  };
  try {
    peer.createDataChannel("policy-probe");
    await peer.setLocalDescription(await peer.createOffer());
    while (peer.iceGatheringState !== "complete") {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return candidates;
  } finally {
    await peer.close();
  }
}

// --- the configuration the peer connection is built with --------------------

test("a configured relay-only policy joins the ICE servers in the configuration", () => {
  const iceServers = [
    { urls: "turn:relay.example:3478", username: "u", credential: "c" },
  ];
  expect(buildPeerConfiguration(iceServers, "relay")).toEqual({
    iceServers,
    iceTransportPolicy: "relay",
  });
});

test("an unset policy leaves the configuration exactly as it was", () => {
  // The library's own default decides when nothing is configured, so the
  // configuration must not spell out an equivalent value: an unconfigured
  // connection is constructed with the same object it always was.
  const iceServers = [{ urls: ["stun:stun.example:3478"] }];
  const configuration = buildPeerConfiguration(iceServers, undefined);
  expect(configuration).toEqual({ iceServers });
  expect(configuration).not.toHaveProperty("iceTransportPolicy");
});

test("an explicit all policy is passed through rather than dropped", () => {
  // It names the same behaviour the library defaults to, and an operator who
  // wrote it down is told the truth by `getConfiguration()` either way.
  expect(buildPeerConfiguration([UNREACHABLE_STUN], "all")).toEqual({
    iceServers: [UNREACHABLE_STUN],
    iceTransportPolicy: "all",
  });
});

// --- what werift does with it -----------------------------------------------

test("werift reports the configured policy back, and defaults to all", () => {
  const relay = new RTCPeerConnection(
    buildPeerConfiguration([UNREACHABLE_TURN], "relay"),
  );
  const unset = new RTCPeerConnection(
    buildPeerConfiguration([UNREACHABLE_STUN], undefined),
  );
  try {
    expect(relay.getConfiguration().iceTransportPolicy).toBe("relay");
    expect(unset.getConfiguration().iceTransportPolicy).toBe("all");
  } finally {
    void relay.close();
    void unset.close();
  }
});

test(
  "a relay-only policy gathers no candidate where the default gathers a host one",
  { timeout: GATHERING_TIMEOUT_MS },
  async () => {
    // The stronger half of the claim: the policy is honored by the ICE layer
    // rather than merely retained by the configuration. Under `relay` an
    // unreachable relay leaves the connection with nothing to offer, so no host
    // or server-reflexive address is gathered -- which is what makes the setting
    // a way to keep a run off any direct path.
    const [relayOnly, unset] = await Promise.all([
      gatheredCandidates(buildPeerConfiguration([UNREACHABLE_TURN], "relay")),
      gatheredCandidates(buildPeerConfiguration([UNREACHABLE_STUN], undefined)),
    ]);
    expect(relayOnly).toEqual([]);
    expect(unset.some((candidate) => candidate.includes("typ host"))).toBe(
      true,
    );
  },
);

test(
  "a relay-only policy with no relay server gathers a host candidate",
  { timeout: GATHERING_TIMEOUT_MS },
  async () => {
    // What makes the schema's two refusals required rather than tidy: werift
    // applies the policy only where a TURN server it can parse reaches it, so
    // a relay-only connection with no `turn` entry, or one whose url names no
    // host, offers the partner the very host address the setting exists to
    // keep off the wire. Neither shape parses, so both are built here. Both
    // also leave werift with nothing but its built-in default to fall back to,
    // which is what the intercepted resolver keeps off the network.
    const [noServers, hostlessTurn] = await withResolverIntercepted(() =>
      Promise.all([
        gatheredCandidates({ iceTransportPolicy: "relay" }),
        gatheredCandidates({
          iceServers: [HOSTLESS_TURN],
          iceTransportPolicy: "relay",
        }),
      ]),
    );
    expect(noServers.some((candidate) => candidate.includes("typ host"))).toBe(
      true,
    );
    expect(
      hostlessTurn.some((candidate) => candidate.includes("typ host")),
    ).toBe(true);
  },
);
