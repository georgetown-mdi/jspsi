import { expect, test } from "vitest";

import { UsageError } from "@psilink/core";

import {
  NO_ICE_SERVERS_WARNING,
  buildPeerConfiguration,
  iceServersFromConnection,
} from "../../src/connection/webrtc/weriftPeer";

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
  // content rather than merely that something was logged.
  expect(NO_ICE_SERVERS_WARNING).toContain("stun.l.google.com:19302");
  expect(NO_ICE_SERVERS_WARNING).toContain("public address");
  expect(NO_ICE_SERVERS_WARNING).toContain("`stun`");
  expect(NO_ICE_SERVERS_WARNING).toContain("`turn`");
  expect(NO_ICE_SERVERS_WARNING).toContain("unreachable");
  // And it must not overstate the disclosure: connection metadata, not content.
  expect(NO_ICE_SERVERS_WARNING).toContain("no exchange content is");
});
