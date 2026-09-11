import dns from "node:dns";

import { RTCPeerConnection } from "werift";
import { beforeAll, expect, test } from "vitest";

import { safeParseConnectionConfig } from "@psilink/core";

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
 *
 * The table at the bottom drives the same question over the `transport`
 * parameter of a TURN url: which values leave the entry standing, and so which
 * ones the connection schema may accept without the relay-only policy quietly
 * ceasing to hold.
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
 * How long the whole TRANSPORT_FORMS table may take. Its forms gather at
 * once rather than one after another, so this is a run of the same werift
 * timer as a single arm, with room for the slowest machine that runs it.
 */
const TRANSPORT_TABLE_TIMEOUT_MS = 90_000;

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

// --- which TURN transport parameters werift keeps ----------------------------

/**
 * A TURN url's `transport` parameter, and whether werift keeps the entry it
 * sits on. werift reads the parameter itself and refuses the whole entry over a
 * value it does not support, continuing without it; under a relay-only policy
 * that leaves the connection with no relay, so it gathers the host candidate
 * the policy exists to keep off the wire. The rows are what the connection
 * schema's grammar is drawn from (`packages/core/src/config/connection.ts`),
 * measured here rather than read out of the library.
 */
const TRANSPORT_FORMS: Array<{ url: string; kept: boolean }> = [
  { url: "turn:127.0.0.1:3478", kept: true },
  { url: "turn:127.0.0.1:3478?transport=tcp", kept: true },
  { url: "turn:127.0.0.1:3478?transport=udp", kept: true },
  { url: "turn:127.0.0.1:3478?transport=tcp&foo=bar", kept: true },
  { url: "turn:127.0.0.1:3478?foo=bar", kept: true },
  { url: "turn:127.0.0.1:3478?Transport=tcp", kept: true },
  { url: "turn:127.0.0.1:3478?transport=tcp&transport=udp", kept: true },
  { url: "turns:127.0.0.1:5349", kept: true },
  { url: "turns:127.0.0.1:5349?transport=tcp", kept: true },
  { url: "turns:127.0.0.1:5349?transport=tcp&transport=udp", kept: true },
  { url: "turn:127.0.0.1:3478?transport=UDP", kept: false },
  { url: "turn:127.0.0.1:3478?transport=TCP", kept: false },
  { url: "turn:127.0.0.1:3478?transport=quic", kept: false },
  { url: "turn:127.0.0.1:3478?transport=", kept: false },
  { url: "turn:127.0.0.1:3478?transport=tcp;x", kept: false },
  { url: "turn:127.0.0.1:3478?transport=quic&transport=tcp", kept: false },
  { url: "turns:127.0.0.1:5349?transport=udp", kept: false },
  { url: "turns:127.0.0.1:5349?transport=quic", kept: false },
  { url: "turns:127.0.0.1:5349?transport=TCP", kept: false },
];

/** What each form of TRANSPORT_FORMS gathered, keyed by its url. */
const gatheredPerForm = new Map<string, Array<string>>();

/**
 * Every form of TRANSPORT_FORMS gathers in one window, before the arms below
 * read the results: gathering is what takes the time, the forms are
 * independent, and one window keeps the resolver intercepted until the last
 * peer has closed. A form werift refuses leaves the connection with no server
 * it can parse, which is the case that reaches for the built-in Google STUN
 * default.
 */
beforeAll(async () => {
  const gathered = await withResolverIntercepted(() =>
    Promise.all(
      TRANSPORT_FORMS.map(({ url }) =>
        gatheredCandidates({
          iceServers: [{ ...UNREACHABLE_TURN, urls: url }],
          iceTransportPolicy: "relay",
        }),
      ),
    ),
  );
  TRANSPORT_FORMS.forEach(({ url }, index) => {
    gatheredPerForm.set(url, gathered[index] ?? []);
  });
}, TRANSPORT_TABLE_TIMEOUT_MS);

test.each(TRANSPORT_FORMS)(
  'under relay, werift keeps the entry "$url": $kept',
  ({ url, kept }) => {
    const candidates = gatheredPerForm.get(url);
    expect(candidates, `nothing was gathered for ${url}`).toBeDefined();
    expect(
      (candidates ?? []).some((candidate) => candidate.includes("typ host")),
    ).toBe(!kept);
  },
);

/**
 * The forms the schema refuses although werift keeps them. The schema holds
 * every occurrence of `transport` to the rule instead of resting on werift
 * reading the first, so a url setting it twice is refused where the two values
 * disagree. Listing them here keeps the correspondence below exact in both
 * directions: any other divergence fails an arm.
 */
const REFUSED_THOUGH_KEPT = new Set([
  "turns:127.0.0.1:5349?transport=tcp&transport=udp",
]);

test.each(TRANSPORT_FORMS)(
  'the connection schema accepts "$url" only where werift keeps it',
  ({ url, kept }) => {
    const parsed = safeParseConnectionConfig({
      channel: "webrtc",
      server: { host: "peers.example.org" },
      ice_transport_policy: "relay",
      turn: [
        {
          url,
          username: UNREACHABLE_TURN.username,
          credential: UNREACHABLE_TURN.credential,
        },
      ],
    });
    expect(parsed.success).toBe(kept && !REFUSED_THOUGH_KEPT.has(url));
  },
);
