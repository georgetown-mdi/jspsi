import { ZodError } from "zod";
import { describe, expect, test } from "vitest";

import {
  decodeInvitation,
  encodeInvitation,
  relayLocatorFromOwnRelay,
} from "../../src/config/invitation";
import {
  MAX_RELAY_LOCATOR_URL_LENGTH,
  MAX_RELAY_LOCATOR_URLS,
  parseConnectionConfig,
} from "../../src/config/connection";
import { endpointFromConnection } from "../../src/config/endpointProducer";
import { connectionFromLocator } from "../../src/config/exchangeFile";
import { summarizeInvitation } from "../../src/consent/invitationSummary";

import type { InvitationToken } from "../../src/config/invitation";
import type { WebRTCConnectionConfig } from "../../src/config/connection";

const VALID_SECRET = "A".repeat(43);

const baseTerms = {
  version: "1.0.0",
  identity: "Test Party",
  date: "2025-01-01",
  algorithm: "psi" as const,
  linkageStrategy: "cascade" as const,
  output: { expectsOutput: true, shareWithPartner: false },
  deduplicate: false,
  linkageFields: [{ name: "ssn", type: "ssn" as const }],
  linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
};

const RELAY = {
  turn: ["turns:relay.example.org:443?transport=tcp"],
  stun: ["stun:relay.example.org:3478"],
};

function tokenWithEndpoint(endpoint: unknown): InvitationToken {
  return {
    version: "1",
    linkageTerms: baseTerms,
    sharedSecret: VALID_SECRET,
    connectionEndpoint: endpoint as InvitationToken["connectionEndpoint"],
  };
}

// The encoding without schema validation, so a decode test can hand
// decodeInvitation a token encodeInvitation would refuse to produce.
async function encodeRaw(obj: unknown): Promise<string> {
  const toBase64Url = (b: Uint8Array): string =>
    btoa(Array.from(b, (byte) => String.fromCharCode(byte)).join(""))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return toBase64Url(bytes) + toBase64Url(new Uint8Array(hash).slice(0, 4));
}

describe("the invitation's relay locator", () => {
  test("round-trips through mint and decode", async () => {
    const endpoint = {
      channel: "webrtc",
      host: "signal.example",
      relay: RELAY,
    };
    const decoded = await decodeInvitation(
      await encodeInvitation(tokenWithEndpoint(endpoint)),
    );
    expect(decoded.connectionEndpoint).toEqual(endpoint);
  });

  test("a locator naming only one kind of url round-trips", async () => {
    const endpoint = {
      channel: "webrtc",
      host: "signal.example",
      relay: { stun: ["stun:relay.example.org"] },
    };
    const decoded = await decodeInvitation(
      await encodeInvitation(tokenWithEndpoint(endpoint)),
    );
    expect(decoded.connectionEndpoint).toEqual(endpoint);
  });

  test("an endpoint with no relay decodes with none", async () => {
    const endpoint = { channel: "webrtc", host: "signal.example" };
    const decoded = await decodeInvitation(
      await encodeInvitation(tokenWithEndpoint(endpoint)),
    );
    expect(decoded.connectionEndpoint).toEqual(endpoint);
    expect(summarizeInvitation(decoded).relay).toBeUndefined();
  });

  test.each([
    ["a credential", { ...RELAY, credential: "hunter2" }],
    ["a username", { ...RELAY, username: "1767229200:psilink" }],
    ["an unknown key", { ...RELAY, credentialType: "hmac-sha1" }],
  ])(
    "a locator holding %s is refused at decode and at mint",
    async (_, relay) => {
      const token = tokenWithEndpoint({
        channel: "webrtc",
        host: "signal.example",
        relay,
      });
      await expect(decodeInvitation(await encodeRaw(token))).rejects.toThrow(
        /relay may carry only turn and stun url lists/,
      );
      await expect(encodeInvitation(token)).rejects.toThrow(ZodError);
    },
  );

  test("a turn entry written as a server with a credential is refused, not stripped", async () => {
    const token = tokenWithEndpoint({
      channel: "webrtc",
      host: "signal.example",
      relay: {
        turn: [
          {
            url: "turns:relay.example.org:443",
            username: "user",
            credential: "secret",
          },
        ],
      },
    });
    await expect(decodeInvitation(await encodeRaw(token))).rejects.toThrow(
      ZodError,
    );
  });

  test.each([
    ["an empty locator", {}],
    ["an empty turn list", { turn: [] }],
    ["a turn url naming no host", { turn: ["turn:"] }],
    [
      "a turn url whose transport the ICE layer drops",
      { turn: ["turns:r.example:443?transport=udp"] },
    ],
    ["a stun url under the turn scheme", { stun: ["turn:r.example"] }],
    ["an http url", { turn: ["https://r.example"] }],
    [
      "more urls than the bound",
      {
        stun: Array.from(
          { length: MAX_RELAY_LOCATOR_URLS + 1 },
          () => "stun:r.example",
        ),
      },
    ],
  ])("%s is refused at decode", async (_, relay) => {
    const token = tokenWithEndpoint({
      channel: "webrtc",
      host: "signal.example",
      relay,
    });
    await expect(decodeInvitation(await encodeRaw(token))).rejects.toThrow(
      ZodError,
    );
  });

  test("a url of exactly the length bound decodes, and one code unit over is refused", async () => {
    const urlOfLength = (length: number): string =>
      "turn:" + "r".repeat(length - "turn:".length);
    const atBound = tokenWithEndpoint({
      channel: "webrtc",
      host: "signal.example",
      relay: { turn: [urlOfLength(MAX_RELAY_LOCATOR_URL_LENGTH)] },
    });
    const decoded = await decodeInvitation(await encodeRaw(atBound));
    expect(decoded.connectionEndpoint).toEqual(atBound.connectionEndpoint);
    const overBound = tokenWithEndpoint({
      channel: "webrtc",
      host: "signal.example",
      relay: { turn: [urlOfLength(MAX_RELAY_LOCATOR_URL_LENGTH + 1)] },
    });
    await expect(decodeInvitation(await encodeRaw(overBound))).rejects.toThrow(
      ZodError,
    );
  });

  test("a url naming a user before its host is refused at decode", async () => {
    const token = tokenWithEndpoint({
      channel: "webrtc",
      host: "signal.example",
      relay: { turn: ["turns:psilink:secret@relay.example.org:443"] },
    });
    await expect(decodeInvitation(await encodeRaw(token))).rejects.toThrow(
      /turns:\.\.\.@relay\.example\.org:443 names a user before its host/,
    );
  });

  test("a relay on a file-sync endpoint is refused", async () => {
    const token = tokenWithEndpoint({
      channel: "sftp",
      host: "sftp.example",
      relay: RELAY,
    });
    await expect(decodeInvitation(await encodeRaw(token))).rejects.toThrow(
      /Remove unexpected field\(s\): relay/,
    );
  });

  test("the consent summary names the relay's urls, escaped", async () => {
    const summary = summarizeInvitation(
      tokenWithEndpoint({
        channel: "webrtc",
        host: "signal.example",
        relay: { turn: ["turns:relay.example.org:443?x=\u001b[31m"] },
      }),
    );
    expect(summary.relay).toEqual({
      turn: ["turns:relay.example.org:443?x=\\x1b[31m"],
      stun: [],
    });
  });
});

describe("relayLocatorFromOwnRelay", () => {
  test("composes the urls given, and nothing else", () => {
    expect(relayLocatorFromOwnRelay(RELAY)).toEqual(RELAY);
    expect(relayLocatorFromOwnRelay({ turn: RELAY.turn, stun: [] })).toEqual({
      turn: RELAY.turn,
    });
  });

  test("names no relay when there is none", () => {
    expect(relayLocatorFromOwnRelay(undefined)).toBeUndefined();
    expect(relayLocatorFromOwnRelay({ turn: [], stun: [] })).toBeUndefined();
  });
});

describe("the inviter's endpoint", () => {
  const base: WebRTCConnectionConfig = {
    channel: "webrtc",
    server: { host: "signal.example", path: "/" },
  };

  test("composes the relay from the connection's own turn and stun urls, with no credential", () => {
    const endpoint = endpointFromConnection({
      ...base,
      stun: RELAY.stun,
      turn: [
        {
          url: RELAY.turn[0],
          username: "operator",
          credential: "turn-secret",
        },
      ],
    });
    expect(endpoint).toEqual({
      channel: "webrtc",
      host: "signal.example",
      path: "/",
      relay: RELAY,
    });
    expect(JSON.stringify(endpoint)).not.toMatch(/operator|turn-secret/);
  });

  test("names no relay for a connection with none", () => {
    expect(endpointFromConnection(base)).not.toHaveProperty("relay");
  });
});

describe("the accepting side's connection", () => {
  test("keeps the invitation's relay as invitation_relay, beside its own turn and stun", () => {
    const connection = connectionFromLocator({
      channel: "webrtc",
      host: "signal.example",
      relay: RELAY,
    });
    expect(connection).toEqual({
      channel: "webrtc",
      server: { host: "signal.example" },
      invitationRelay: RELAY,
    });
  });

  test("an invitation with no relay composes the connection it always did", () => {
    expect(
      connectionFromLocator({ channel: "webrtc", host: "signal.example" }),
    ).toEqual({ channel: "webrtc", server: { host: "signal.example" } });
  });

  test("invitation_relay parses from a configuration file, and refuses a credential", () => {
    const parsed = parseConnectionConfig({
      channel: "webrtc",
      server: { host: "signal.example" },
      invitation_relay: RELAY,
    });
    expect(parsed).toMatchObject({ invitationRelay: RELAY });
    expect(() =>
      parseConnectionConfig({
        channel: "webrtc",
        server: { host: "signal.example" },
        invitation_relay: { ...RELAY, credential: "x" },
      }),
    ).toThrow(/invitation_relay has no key credential/);
  });

  test("a relay-only policy is satisfied by the invitation's TURN urls", () => {
    expect(() =>
      parseConnectionConfig({
        channel: "webrtc",
        server: { host: "signal.example" },
        ice_transport_policy: "relay",
        invitation_relay: { turn: RELAY.turn },
      }),
    ).not.toThrow();
    expect(() =>
      parseConnectionConfig({
        channel: "webrtc",
        server: { host: "signal.example" },
        ice_transport_policy: "relay",
        invitation_relay: { stun: RELAY.stun },
      }),
    ).toThrow(/requires at least one turn entry/);
  });
});
