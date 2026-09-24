import { describe, expect, test } from "vitest";

import {
  RENDEZVOUS_ROLES,
  authorityMovingSignalingField,
  deriveRendezvousPeerId,
} from "../src/rendezvous";
import { generateSharedSecret } from "../src/config/connection";
import { fromBase64Url, toHex } from "../src/utils/crypto";

// A fixed, valid SHARED_SECRET_REGEX secret: 43 base64url chars, all "A", which
// decodes to 32 zero bytes. Used for the stable vectors below so the construction
// cannot change unnoticed.
const ZERO_SECRET = "A".repeat(43);

describe("deriveRendezvousPeerId", () => {
  test("is deterministic: same secret + role yields the same id", async () => {
    const secret = generateSharedSecret();
    const first = await deriveRendezvousPeerId(secret, "inviter");
    const second = await deriveRendezvousPeerId(secret, "inviter");
    expect(first).toBe(second);
  });

  test("the id is lowercase hex (a valid PeerJS id)", async () => {
    const secret = generateSharedSecret();
    for (const role of RENDEZVOUS_ROLES) {
      const id = await deriveRendezvousPeerId(secret, role);
      // 16 bytes -> 32 hex chars; hex always satisfies the PeerJS client's id
      // validator /^[A-Za-z0-9]+(?:[ _-][A-Za-z0-9]+)*$/.
      expect(id).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  // Stable cross-implementation contract vectors. The CLI WebRTC transport must
  // compute the same ids from the same secret; if this construction ever changes,
  // both these literals and the CLI side change in lockstep (and the version
  // bumps). A surprise diff here is the guard against silent drift.
  test("matches the fixed contract vectors for the zero secret", async () => {
    expect(await deriveRendezvousPeerId(ZERO_SECRET, "inviter")).toBe(
      "c560243e42578f65efd207df4039611e",
    );
    expect(await deriveRendezvousPeerId(ZERO_SECRET, "acceptor")).toBe(
      "df2e987f2bf566ef71b636ede2d5957e",
    );
  });

  // Independent re-derivation of the exact construction (HKDF-SHA-256, zero
  // salt, versioned role-specific info, first 16 bytes, lowercase hex). Pins
  // every setting of the contract, so a change to salt/info/length/encoding
  // fails here even if someone updates the literal vectors above to match.
  test("equals an independent HKDF-SHA-256 derivation", async () => {
    const secret = generateSharedSecret();
    for (const role of RENDEZVOUS_ROLES) {
      const key = await crypto.subtle.importKey(
        "raw",
        fromBase64Url(secret),
        { name: "HKDF" },
        false,
        ["deriveBits"],
      );
      const bits = await crypto.subtle.deriveBits(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: new Uint8Array(32),
          info: new TextEncoder().encode(`alcove-webrtc-peerid-v2:${role}`),
        },
        key,
        16 * 8,
      );
      const expected = toHex(new Uint8Array(bits));
      expect(await deriveRendezvousPeerId(secret, role)).toBe(expected);
    }
  });

  test("rejects a malformed shared secret", async () => {
    await expect(
      deriveRendezvousPeerId("not-a-secret", "inviter"),
    ).rejects.toThrow(/SHARED_SECRET_REGEX/);
  });

  test("rejects an unknown role", async () => {
    await expect(
      // @ts-expect-error -- exercising the runtime guard for an untyped caller
      deriveRendezvousPeerId(generateSharedSecret(), "responder"),
    ).rejects.toThrow(/unknown role/);
  });
});

describe("authorityMovingSignalingField", () => {
  const HOST = "broker.example.org";
  const PATH = "/api/";

  test("passes a plain hostname and mount point", () => {
    expect(authorityMovingSignalingField({ host: HOST, path: PATH })).toBe(
      undefined,
    );
  });

  test("passes an IPv6 literal and a root mount point", () => {
    expect(
      authorityMovingSignalingField({ host: "[::1]", path: "/" }),
    ).toBeUndefined();
  });

  // Every delimiter the CLI and the browser acceptor refuse in a host, one
  // case each, so a set narrowed by a later edit fails here.
  test.each([
    ["userinfo", `${HOST}@evil.example.org`],
    ["a path of its own", `${HOST}/x`],
    ["a query", `${HOST}?x`],
    ["a fragment", `${HOST}#x`],
    ["a backslash", `${HOST}\\evil.example.org`],
    ["a space", `${HOST} evil.example.org`],
    ["a tab", `${HOST}\tevil.example.org`],
    ["a newline", `${HOST}\nevil.example.org`],
  ])("refuses a host with %s", (_shape, host) => {
    expect(authorityMovingSignalingField({ host, path: PATH })).toBe("host");
  });

  test.each([
    ["userinfo", "/api/@evil.example.org"],
    ["a query", "/api/?x"],
    ["a fragment", "/api/#x"],
    ["a backslash", "/api\\evil.example.org"],
    ["a space", "/api /"],
    ["a tab", "/api\t/"],
    ["a newline", "/api\n/"],
    ["no leading separator", "api/"],
  ])("refuses a path with %s", (_shape, path) => {
    expect(authorityMovingSignalingField({ host: HOST, path })).toBe("path");
  });

  // A path keeps the separator it is made of, which the host refusal rejects:
  // the two fields take different rules and neither is applied to the other.
  test("passes a path with interior separators", () => {
    expect(
      authorityMovingSignalingField({ host: HOST, path: "/psi/api/" }),
    ).toBeUndefined();
  });

  test("names the host when both fields are refusable", () => {
    expect(
      authorityMovingSignalingField({
        host: `${HOST}@evil.example.org`,
        path: "api/",
      }),
    ).toBe("host");
  });
});
