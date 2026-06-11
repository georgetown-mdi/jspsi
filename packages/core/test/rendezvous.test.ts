import { describe, expect, test } from "vitest";

import { RENDEZVOUS_ROLES, deriveRendezvousPeerId } from "../src/rendezvous";
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

  test("distinct roles yield distinct ids for the same secret", async () => {
    const secret = generateSharedSecret();
    const inviter = await deriveRendezvousPeerId(secret, "inviter");
    const acceptor = await deriveRendezvousPeerId(secret, "acceptor");
    expect(inviter).not.toBe(acceptor);
  });

  test("distinct secrets yield distinct ids for the same role", async () => {
    const a = await deriveRendezvousPeerId(generateSharedSecret(), "inviter");
    const b = await deriveRendezvousPeerId(generateSharedSecret(), "inviter");
    expect(a).not.toBe(b);
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
      "601d61e6cf24cc5fe9bd1e9d1d5e16a3",
    );
    expect(await deriveRendezvousPeerId(ZERO_SECRET, "acceptor")).toBe(
      "3beccb12918772b6056d128f58191506",
    );
  });

  // Independent re-derivation of the exact construction (HKDF-SHA-256, zero salt,
  // versioned role-specific info, first 16 bytes, lowercase hex). Pins every knob
  // of the contract, so a change to salt/info/length/encoding fails here even if
  // someone updates the literal vectors above to match.
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
          info: new TextEncoder().encode(`psilink-webrtc-peerid-v1:${role}`),
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
