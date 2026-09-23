import { expect, test } from "vitest";

import { UsageError, mintRunRelayCredential } from "@psilink/core";

import {
  NO_ICE_SERVERS_WARNING,
  PLAINTEXT_SIGNALING_WARNING,
  WERIFT_BUILT_IN_STUN_URI,
  brokerLocationFromConnection,
  buildPeerConfiguration,
  iceServersFromConnection,
  relayCredentialForRun,
  relayCredentialNotice,
  turnEntryNeedsSecretMessage,
} from "../../../src/connection/webrtc/weriftPeer";

// --- config -> ICE server list ----------------------------------------------

test("configured STUN URIs become a single ICE server entry", () => {
  expect(
    iceServersFromConnection({
      stun: ["stun:stun.example:3478", "stuns:stun.example:5349"],
    }),
  ).toEqual([{ urls: ["stun:stun.example:3478", "stuns:stun.example:5349"] }]);
});

test("each TURN server becomes its own credentialed entry", () => {
  expect(
    iceServersFromConnection({
      turn: [
        {
          url: "turn:relay.example:3478",
          username: "psilink",
          credential: "secret-one",
        },
        {
          url: "turns:relay.example:443?transport=tcp",
          username: "psilink",
          credential: "secret-two",
          credentialType: "hmac-sha1",
        },
      ],
    }),
  ).toEqual([
    {
      urls: "turn:relay.example:3478",
      username: "psilink",
      credential: "secret-one",
    },
    {
      urls: "turns:relay.example:443?transport=tcp",
      username: "psilink",
      credential: "secret-two",
    },
  ]);
});

// --- the invitation's relay -------------------------------------------------

const OWN_TURN = [
  {
    url: "turns:own.example:443?transport=tcp",
    username: "operator",
    credential: "own-secret",
  },
];
const INVITATION_RELAY = {
  turn: [
    "turns:partner.example:443?transport=tcp",
    "turn:partner.example:3478",
  ],
  stun: ["stun:partner.example:3478"],
};
const RUN_CREDENTIAL = {
  username: "1767229200:psilink",
  credential: "bWludGVk",
  expiresAt: new Date("2026-01-01T01:00:00Z"),
};

test("the invitation's relay is used in place of the connection's own, with the run's credential", () => {
  expect(
    iceServersFromConnection(
      {
        stun: ["stun:own.example:3478"],
        turn: OWN_TURN,
        invitationRelay: INVITATION_RELAY,
      },
      RUN_CREDENTIAL,
    ),
  ).toEqual([
    { urls: INVITATION_RELAY.stun },
    ...INVITATION_RELAY.turn.map((url) => ({
      urls: url,
      username: RUN_CREDENTIAL.username,
      credential: RUN_CREDENTIAL.credential,
    })),
  ]);
});

test("a connection falls back to its own TURN where the invitation's relay names none", () => {
  expect(
    iceServersFromConnection({
      turn: OWN_TURN,
      invitationRelay: { stun: INVITATION_RELAY.stun },
    }),
  ).toEqual([
    { urls: INVITATION_RELAY.stun },
    {
      urls: OWN_TURN[0].url,
      username: OWN_TURN[0].username,
      credential: OWN_TURN[0].credential,
    },
  ]);
});

test("the invitation's TURN urls with no minted credential is a fault, not an unauthenticated entry", () => {
  expect(() =>
    iceServersFromConnection({ invitationRelay: INVITATION_RELAY }),
  ).toThrow(/no relay credential was minted/);
});

test("a run mints a credential only when it uses the invitation's TURN urls", async () => {
  const secret = "A".repeat(43);
  const now = new Date("2026-01-01T00:00:00Z");
  const minted = await relayCredentialForRun(
    { invitationRelay: INVITATION_RELAY },
    secret,
    now,
  );
  expect(minted).toEqual(await mintRunRelayCredential(secret, now));
  expect(
    await relayCredentialForRun(
      { turn: OWN_TURN, invitationRelay: { stun: INVITATION_RELAY.stun } },
      secret,
      now,
    ),
  ).toBeUndefined();
  expect(
    await relayCredentialForRun({ turn: OWN_TURN }, secret, now),
  ).toBeUndefined();
  expect(
    await relayCredentialForRun(
      { invitationRelay: INVITATION_RELAY },
      undefined,
      now,
    ),
  ).toBeUndefined();
});

// --- an own turn entry with no username or credential -----------------------

// Bytes 0x00..0x1f, base64url-encoded.
const FIXED_SECRET = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
// Computed outside this code, by OpenSSL 3.0, under the relay key HKDF-derived
// from FIXED_SECRET (packages/core/test/relayCredential.test.ts):
//   printf '%s' 1767229200:psilink \
//     | openssl dgst -sha1 -hmac <FIXED_RELAY_KEY> -binary | openssl base64
const FIXED_RUN_CREDENTIAL = "nkjUDyQQCYrMnLaZzMzT6F0mwpY=";
const FIXED_NOW = new Date("2026-01-01T00:00:00Z");
const URL_ONLY_TURN = [{ url: "turns:minted.example:443?transport=tcp" }];

test("an own turn entry with no username or credential is presented the credential minted from the shared secret", async () => {
  const minted = await relayCredentialForRun(
    { turn: URL_ONLY_TURN },
    FIXED_SECRET,
    FIXED_NOW,
  );
  expect(minted).toEqual({
    username: "1767229200:psilink",
    credential: FIXED_RUN_CREDENTIAL,
    expiresAt: new Date("2026-01-01T01:00:00Z"),
  });
  expect(
    iceServersFromConnection({ turn: [...URL_ONLY_TURN, ...OWN_TURN] }, minted),
  ).toEqual([
    {
      urls: URL_ONLY_TURN[0].url,
      username: "1767229200:psilink",
      credential: FIXED_RUN_CREDENTIAL,
    },
    {
      urls: OWN_TURN[0].url,
      username: OWN_TURN[0].username,
      credential: OWN_TURN[0].credential,
    },
  ]);
});

test("a static turn entry is presented its own credential even when the run mints one", () => {
  expect(iceServersFromConnection({ turn: OWN_TURN }, RUN_CREDENTIAL)).toEqual([
    {
      urls: OWN_TURN[0].url,
      username: OWN_TURN[0].username,
      credential: OWN_TURN[0].credential,
    },
  ]);
});

test("the invitation's TURN urls replace an own url-only entry, with one minted credential", async () => {
  const connection = {
    turn: URL_ONLY_TURN,
    invitationRelay: { turn: INVITATION_RELAY.turn },
  };
  const minted = await relayCredentialForRun(
    connection,
    FIXED_SECRET,
    FIXED_NOW,
  );
  expect(minted?.credential).toBe(FIXED_RUN_CREDENTIAL);
  expect(
    iceServersFromConnection(connection, minted).map(({ urls }) => urls),
  ).toEqual(INVITATION_RELAY.turn);
});

test("an own url-only turn entry with no shared secret is refused naming the entry", async () => {
  const run = relayCredentialForRun(
    { turn: [...OWN_TURN, ...URL_ONLY_TURN] },
    undefined,
    FIXED_NOW,
  );
  await expect(run).rejects.toThrow(UsageError);
  await expect(run).rejects.toThrow(
    turnEntryNeedsSecretMessage(URL_ONLY_TURN[0].url),
  );
  expect(turnEntryNeedsSecretMessage(URL_ONLY_TURN[0].url)).toContain(
    "turns:minted.example:443?transport=tcp",
  );
});

test("an own url-only turn entry with no minted credential is a fault, not an unauthenticated entry", () => {
  expect(() => iceServersFromConnection({ turn: URL_ONLY_TURN })).toThrow(
    /no relay credential was minted/,
  );
});

test("the minted credential's notice names the relay, its lifetime, and its expiry", () => {
  expect(relayCredentialNotice({ turn: URL_ONLY_TURN }, RUN_CREDENTIAL)).toBe(
    "relaying through turns:minted.example:443?transport=tcp, with a " +
      "credential derived from the exchange's shared secret that is valid " +
      "for 60 minutes and expires at 2026-01-01T01:00:00.000Z",
  );
  expect(
    relayCredentialNotice(
      { invitationRelay: INVITATION_RELAY },
      RUN_CREDENTIAL,
    ),
  ).toMatch(
    /^relaying through the TURN server your partner's invitation named/,
  );
  const mixed = relayCredentialNotice(
    { turn: [...OWN_TURN, ...URL_ONLY_TURN] },
    RUN_CREDENTIAL,
  );
  expect(mixed).toContain("turns:minted.example:443?transport=tcp");
  expect(mixed).not.toContain("own.example");
});

test("a connection with neither STUN nor TURN resolves to no servers", () => {
  expect(iceServersFromConnection({})).toEqual([]);
  expect(iceServersFromConnection({ stun: [], turn: [] })).toEqual([]);
});

test("an ice_provision block is refused rather than silently ignored", () => {
  // Ignoring it would fall back to the built-in default -- a downgrade the
  // operator did not choose, on the one field that says they chose otherwise.
  expect(() =>
    iceServersFromConnection({ iceProvision: { host: "ice.example" } }),
  ).toThrow(UsageError);
  expect(() =>
    iceServersFromConnection({ iceProvision: { host: "ice.example" } }),
  ).toThrow(/ice_provision/);
});

// --- the configuration the peer connection is built with --------------------

test("a configured list is passed through verbatim, with no warning", () => {
  const warnings: Array<string> = [];
  const iceServers = [
    { urls: ["stun:stun.example:3478"] },
    { urls: "turn:relay.example:3478", username: "u", credential: "c" },
  ];
  expect(
    buildPeerConfiguration(iceServers, undefined, (m) => warnings.push(m)),
  ).toEqual({
    iceServers,
  });
  expect(warnings).toEqual([]);
});

test.each([
  ["no list at all", undefined],
  ["an empty list", []],
])("%s warns and leaves the built-in default selected", (_label, servers) => {
  const warnings: Array<string> = [];
  const configuration = buildPeerConfiguration(servers, undefined, (m) =>
    warnings.push(m),
  );
  // An empty list is NOT passed through: to werift an empty `iceServers` and an
  // absent one both mean "use the built-in default", so omitting it keeps the
  // two from looking different when they are not.
  expect(configuration).toEqual({});
  expect(warnings).toEqual([NO_ICE_SERVERS_WARNING]);
});

test("the warning names the default, what it discloses, and how to override", () => {
  // An operator reading one line has to be able to act on it, so this pins the
  // content rather than merely that something was logged. The endpoint it names
  // is the measured one -- what werift actually falls back to is held by the
  // integration suite, and this holds the warning to that value.
  expect(NO_ICE_SERVERS_WARNING).toContain(WERIFT_BUILT_IN_STUN_URI);
  expect(NO_ICE_SERVERS_WARNING).toContain("public address");
  expect(NO_ICE_SERVERS_WARNING).toContain("`stun`");
  expect(NO_ICE_SERVERS_WARNING).toContain("`turn`");
  expect(NO_ICE_SERVERS_WARNING).toContain("unreachable");
  // And it must not overstate the disclosure: connection metadata, not content.
  expect(NO_ICE_SERVERS_WARNING).toContain("no exchange content is");
});

// --- plaintext signaling ----------------------------------------------------

test("a plaintext broker warns and still resolves to a dialable location", () => {
  const warnings: Array<string> = [];
  const location = brokerLocationFromConnection(
    { host: "127.0.0.1", port: 9000, secure: false },
    (message) => warnings.push(message),
  );
  // Warn and guide: plaintext is the operator's own choice, and a broker on the
  // same machine is what it is for, so the location is still returned whole.
  expect(location).toEqual({
    host: "127.0.0.1",
    port: 9000,
    path: "/",
    key: "peerjs",
    secure: false,
  });
  expect(warnings).toEqual([PLAINTEXT_SIGNALING_WARNING]);
});

test.each([
  ["secure: true", true],
  ["an omitted secure", undefined],
])("%s resolves to TLS with no warning", (_label, secure) => {
  const warnings: Array<string> = [];
  const location = brokerLocationFromConnection(
    { host: "peers.example.org", ...(secure !== undefined && { secure }) },
    (message) => warnings.push(message),
  );
  expect(location.secure).toBe(true);
  expect(warnings).toEqual([]);
});

test("a connection refused for shape warns about nothing", () => {
  // The refusal is the whole outcome: nothing will be dialed, so a warning about
  // the socket's scheme would only compete with the line the operator acts on.
  const warnings: Array<string> = [];
  expect(() =>
    brokerLocationFromConnection(
      { host: "broker.example@attacker.example", secure: false },
      (message) => warnings.push(message),
    ),
  ).toThrow(UsageError);
  expect(warnings).toEqual([]);
});

test("the warning names what is disclosed, the remedy, and the legitimate use", () => {
  expect(PLAINTEXT_SIGNALING_WARNING).toContain("`secure: false`");
  expect(PLAINTEXT_SIGNALING_WARNING).toContain("ws:");
  expect(PLAINTEXT_SIGNALING_WARNING).toContain("rendezvous ids");
  expect(PLAINTEXT_SIGNALING_WARNING).toContain("session descriptions");
  expect(PLAINTEXT_SIGNALING_WARNING).toContain("candidate addresses");
  expect(PLAINTEXT_SIGNALING_WARNING).toContain("TLS");
  expect(PLAINTEXT_SIGNALING_WARNING).toContain("the default");
  expect(PLAINTEXT_SIGNALING_WARNING).toContain("same machine");
  // And it must not overstate the disclosure: the parties authenticate each
  // other over the data channel, which a plaintext signaling path does not reach.
  expect(PLAINTEXT_SIGNALING_WARNING).toContain("No exchange content");
});
