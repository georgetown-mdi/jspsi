import { describe, expect, test } from "vitest";

import {
  deriveRelayKey,
  mintRelayCredential,
  mintRunRelayCredential,
  RELAY_CREDENTIAL_MAX_TTL_SECONDS,
  RUN_RELAY_CREDENTIAL_LABEL,
  selectRunRelay,
} from "../src/relayCredential";
import { generateSharedSecret } from "../src/config/connection";

// Bytes 0x00..0x1f, base64url-encoded.
const FIXED_SECRET = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

// Computed outside this code, by OpenSSL 3.0:
//   openssl kdf -keylen 32 -kdfopt digest:SHA256 \
//     -kdfopt hexkey:000102...1f -kdfopt hexsalt:<64 zeros> \
//     -kdfopt info:psilink-relay-key-v1 HKDF
const FIXED_RELAY_KEY =
  "712c3a8a678ed344c663d2c99457553c06e76dbb0a464b68cd08bed36b338fab";

// Computed by the pipeline infra/relay/mint-credential.sh runs:
//   printf '%s' 1767229200:exchange-1 \
//     | openssl dgst -sha1 -hmac <FIXED_RELAY_KEY> -binary | openssl base64
const FIXED_CREDENTIAL = "LzEyv5TTLqdm0AzvTKrvmPQY7YU=";

const NOW = new Date("2026-01-01T00:00:00Z");

describe("deriveRelayKey", () => {
  test("matches the known-answer key for a fixed secret", async () => {
    expect(await deriveRelayKey(FIXED_SECRET)).toBe(FIXED_RELAY_KEY);
  });

  test("is 32 bytes of lowercase hex, the same for the same secret", async () => {
    const secret = generateSharedSecret();
    const first = await deriveRelayKey(secret);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(await deriveRelayKey(secret)).toBe(first);
    expect(await deriveRelayKey(generateSharedSecret())).not.toBe(first);
  });

  test("refuses a value that is not a 32-byte base64url secret", async () => {
    await expect(deriveRelayKey("not-a-secret")).rejects.toThrow(
      /SHARED_SECRET_REGEX/,
    );
    await expect(deriveRelayKey(FIXED_SECRET.slice(1))).rejects.toThrow(
      /SHARED_SECRET_REGEX/,
    );
  });
});

describe("mintRelayCredential", () => {
  test("matches the relay's own credential arithmetic", async () => {
    const minted = await mintRelayCredential({
      key: FIXED_RELAY_KEY,
      label: "exchange-1",
      ttlSeconds: 3600,
      now: NOW,
    });
    expect(minted).toEqual({
      username: "1767229200:exchange-1",
      credential: FIXED_CREDENTIAL,
      expiresAt: new Date("2026-01-01T01:00:00Z"),
    });
  });

  test("counts the lifetime from the whole second", async () => {
    const minted = await mintRelayCredential({
      key: FIXED_RELAY_KEY,
      label: "exchange-1",
      ttlSeconds: 3600,
      now: new Date(NOW.getTime() + 999),
    });
    expect(minted.username).toBe("1767229200:exchange-1");
    expect(minted.credential).toBe(FIXED_CREDENTIAL);
  });

  test("the label is a parameter", async () => {
    const minted = await mintRelayCredential({
      key: FIXED_RELAY_KEY,
      label: "other",
      ttlSeconds: 60,
      now: NOW,
    });
    expect(minted.username).toBe("1767225660:other");
    expect(minted.credential).not.toBe(FIXED_CREDENTIAL);
  });

  const valid = {
    key: FIXED_RELAY_KEY,
    label: "exchange-1",
    ttlSeconds: 60,
    now: NOW,
  };

  test.each([
    ["a label containing ':'", { label: "a:b" }, /must not contain ':'/],
    ["an empty label", { label: "" }, /must be non-empty/],
    ["an empty key", { key: "" }, /key is empty/],
    ["a fractional ttl", { ttlSeconds: 1.5 }, /whole seconds/],
    ["a zero ttl", { ttlSeconds: 0 }, /whole seconds/],
    [
      "a ttl above the ceiling",
      { ttlSeconds: RELAY_CREDENTIAL_MAX_TTL_SECONDS + 1 },
      /whole seconds/,
    ],
    ["an invalid date", { now: new Date(Number.NaN) }, /not a valid date/],
  ])("refuses %s", async (_name, override, message) => {
    await expect(
      mintRelayCredential({ ...valid, ...override }),
    ).rejects.toThrow(message);
  });

  test("accepts a ttl at the ceiling", async () => {
    const minted = await mintRelayCredential({
      ...valid,
      ttlSeconds: RELAY_CREDENTIAL_MAX_TTL_SECONDS,
    });
    expect(minted.expiresAt).toEqual(new Date("2026-01-01T01:00:00Z"));
  });
});

describe("selectRunRelay", () => {
  const ownTurn = [
    {
      url: "turns:own.example:443?transport=tcp",
      username: "operator",
      credential: "own-secret",
    },
  ];
  const ownStun = ["stun:own.example:3478"];
  const invitationRelay = {
    turn: ["turns:partner.example:443?transport=tcp"],
    stun: ["stun:partner.example:3478"],
  };

  test("prefers the invitation's relay over the connection's own", () => {
    expect(
      selectRunRelay({ turn: ownTurn, stun: ownStun, invitationRelay }),
    ).toEqual({
      turn: { source: "invitation", urls: invitationRelay.turn },
      stun: { source: "invitation", urls: invitationRelay.stun },
    });
  });

  test("falls back to its own relay, per kind, where the invitation names none", () => {
    expect(
      selectRunRelay({
        turn: ownTurn,
        stun: ownStun,
        invitationRelay: { stun: invitationRelay.stun },
      }),
    ).toEqual({
      turn: { source: "own", servers: ownTurn },
      stun: { source: "invitation", urls: invitationRelay.stun },
    });
    expect(
      selectRunRelay({
        turn: ownTurn,
        stun: ownStun,
        invitationRelay: { turn: invitationRelay.turn },
      }),
    ).toEqual({
      turn: { source: "invitation", urls: invitationRelay.turn },
      stun: { source: "own", urls: ownStun },
    });
  });

  test("with no invitation relay, selects exactly the connection's own", () => {
    expect(selectRunRelay({ turn: ownTurn, stun: ownStun })).toEqual({
      turn: { source: "own", servers: ownTurn },
      stun: { source: "own", urls: ownStun },
    });
    expect(selectRunRelay({ stun: [] })).toEqual({
      stun: { source: "own", urls: [] },
    });
    expect(selectRunRelay({})).toEqual({});
  });
});

describe("mintRunRelayCredential", () => {
  test("signs under the key derived from the secret, for the ceiling, with the fixed label", async () => {
    const minted = await mintRunRelayCredential(FIXED_SECRET, NOW);
    expect(minted).toEqual(
      await mintRelayCredential({
        key: FIXED_RELAY_KEY,
        label: RUN_RELAY_CREDENTIAL_LABEL,
        ttlSeconds: RELAY_CREDENTIAL_MAX_TTL_SECONDS,
        now: NOW,
      }),
    );
    expect(minted.username).toBe(`1767229200:${RUN_RELAY_CREDENTIAL_LABEL}`);
  });

  test("refuses a value that is not a shared secret", async () => {
    await expect(mintRunRelayCredential("nope", NOW)).rejects.toThrow(
      /SHARED_SECRET_REGEX/,
    );
  });
});
