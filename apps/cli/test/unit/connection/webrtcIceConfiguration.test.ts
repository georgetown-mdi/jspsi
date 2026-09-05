import { expect, test } from "vitest";

import { UsageError } from "@psilink/core";

import {
  NO_ICE_SERVERS_WARNING,
  PLAINTEXT_SIGNALING_WARNING,
  WERIFT_BUILT_IN_STUN_URI,
  brokerLocationFromConnection,
  buildPeerConfiguration,
  iceServersFromConnection,
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
  expect(buildPeerConfiguration(iceServers, (m) => warnings.push(m))).toEqual({
    iceServers,
  });
  expect(warnings).toEqual([]);
});

test.each([
  ["no list at all", undefined],
  ["an empty list", []],
])("%s warns and leaves the built-in default selected", (_label, servers) => {
  const warnings: Array<string> = [];
  const configuration = buildPeerConfiguration(servers, (m) =>
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
