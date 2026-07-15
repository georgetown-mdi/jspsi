import {
  decodeInvitation,
  deriveAcceptedLinkageTerms,
  encodeInvitation,
  generateSharedSecret,
  getDefaultLinkageTerms,
} from "@psilink/core";
import { describe, expect, test } from "vitest";

import {
  MANAGED_EXCHANGE_SCHEMA_VERSION,
  composeManagedExchangeFile,
} from "@psi/managedExchangeRecord";
import {
  buildReinviteRotation,
  canReinviteFromRecord,
  composeManagedReinvite,
} from "@psi/managedReinvite";

import type { InvitationLocation } from "@psi/invitation";
import type { InvitationToken } from "@psilink/core";
import type { ManagedExchangeRecord } from "@psi/managedExchangeRecord";

// Fast re-invite from a stored record, tested in Node: the fresh invitation is
// composed from the record's OWN document (terms + committed send set), mints only a
// fresh secret, and its endpoint comes from the current location -- so the partner's
// accept re-derives its perspective and re-locks the same disclosed set, and the
// operator re-authors nothing. Only the inviter side re-mints.

// `encodeInvitation` re-checks the token's `expires` against the real wall clock, so
// NOW must be ahead of it for the setup lifetime to encode; anchored to the actual run
// instant rather than a fixed past date.
const NOW = Date.now() + 60_000;
const STORED_SECRET = generateSharedSecret();
// A fresh secret distinct from the stored one (regenerate until it differs -- the odds
// of a collision are negligible, but the loop makes the "fresh, not stored" assertion
// deterministic).
function freshDistinctSecret(): string {
  let secret = generateSharedSecret();
  while (secret === STORED_SECRET) secret = generateSharedSecret();
  return secret;
}
const FRESH_SECRET = freshDistinctSecret();

const location: InvitationLocation = {
  origin: "https://example.org:3000",
  hostname: "example.org",
  port: "3000",
};

function inviterRecord(
  overrides: Partial<ManagedExchangeRecord> = {},
): ManagedExchangeRecord {
  return {
    schemaVersion: MANAGED_EXCHANGE_SCHEMA_VERSION,
    id: "abc",
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: {
        channel: "webrtc",
        host: "stale-signaling.example.org",
        port: 9999,
      },
      linkageTerms: getDefaultLinkageTerms("County Health Dept"),
      disclosedPayloadColumns: ["diagnosis_code"],
    }),
    side: "inviter",
    sharedSecret: STORED_SECRET,
    ...overrides,
  };
}

const seams = {
  generateSecret: () => FRESH_SECRET,
  encode: encodeInvitation,
  now: () => NOW,
};

describe("composeManagedReinvite", () => {
  test("mints a fresh secret and reuses the stored document's terms verbatim", async () => {
    const record = inviterRecord();
    const reinvite = await composeManagedReinvite(record, location, seams);

    expect(reinvite.sharedSecret).toBe(FRESH_SECRET);
    expect(reinvite.sharedSecret).not.toBe(record.sharedSecret);

    const token = await decodeInvitation(reinvite.encoded);
    expect(token.sharedSecret).toBe(FRESH_SECRET);
    // The document's terms ride verbatim: the partner adopts the same set.
    expect(token.linkageTerms).toEqual(record.exchangeFile.linkageTerms);
  });

  test("the token carries the document's committed send set, so the partner's accept re-locks the same receive set", async () => {
    const record = inviterRecord();
    const reinvite = await composeManagedReinvite(record, location, seams);
    const token = await decodeInvitation(reinvite.encoded);

    // The partner's receive lock-in derives from the token's disclosed set (see
    // core's runtime lock-in); it must equal the record's own committed send set.
    expect(token.disclosedPayloadColumns).toEqual(["diagnosis_code"]);

    // The accept re-derives the acceptor's perspective from the same terms it did
    // originally, without error -- the round-trip locks in.
    expect(() =>
      deriveAcceptedLinkageTerms(token.linkageTerms, "Partner Org"),
    ).not.toThrow();
  });

  test("the endpoint is built FRESH from the current location, not the stored locator", async () => {
    const record = inviterRecord();
    const reinvite = await composeManagedReinvite(record, location, seams);
    const token = await decodeInvitation(reinvite.encoded);

    expect(token.connectionEndpoint).toMatchObject({
      channel: "webrtc",
      host: "example.org",
      port: 3000,
    });
    // The stale stored locator did not leak into the fresh invitation.
    expect(JSON.stringify(token.connectionEndpoint)).not.toMatch(
      /stale-signaling/,
    );
  });

  test("the deep link carries the encoded token in its fragment", async () => {
    const reinvite = await composeManagedReinvite(
      inviterRecord(),
      location,
      seams,
    );
    expect(reinvite.deepLink).toBe(
      `https://example.org:3000/accept#${reinvite.encoded}`,
    );
  });

  test("a strict empty send commitment is preserved (never dropped)", async () => {
    const record = inviterRecord({
      exchangeFile: composeManagedExchangeFile({
        connection: { channel: "webrtc", host: "signaling.example.org" },
        linkageTerms: getDefaultLinkageTerms("County Health Dept"),
        disclosedPayloadColumns: [],
      }),
    });
    const token = await decodeInvitation(
      (await composeManagedReinvite(record, location, seams)).encoded,
    );
    expect(token.disclosedPayloadColumns).toEqual([]);
  });

  test("a document with no send commitment mints no disclosed set", async () => {
    const record = inviterRecord({
      exchangeFile: composeManagedExchangeFile({
        connection: { channel: "webrtc", host: "signaling.example.org" },
        linkageTerms: getDefaultLinkageTerms("County Health Dept"),
      }),
    });
    const token = await decodeInvitation(
      (await composeManagedReinvite(record, location, seams)).encoded,
    );
    expect(token.disclosedPayloadColumns).toBeUndefined();
  });

  test("the acceptor side cannot re-mint from its mirrored document", async () => {
    const record = inviterRecord({ side: "acceptor" });
    expect(canReinviteFromRecord(record)).toBe(false);
    await expect(
      composeManagedReinvite(record, location, seams),
    ).rejects.toThrow(/only the inviter/i);
  });
});

describe("buildReinviteRotation: the record's own expires provenance", () => {
  test("no max-age policy clears any standing bound (the setup lifetime never leaks in)", () => {
    const rotation = buildReinviteRotation(FRESH_SECRET, undefined, NOW);
    expect(rotation.sharedSecret).toBe(FRESH_SECRET);
    expect(rotation.expires).toBeNull();
  });

  test("a max-age policy restamps the record's expires now + N days", () => {
    const rotation = buildReinviteRotation(FRESH_SECRET, 30, NOW);
    expect(rotation.sharedSecret).toBe(FRESH_SECRET);
    // 30 days after NOW.
    expect(rotation.expires).toBe(
      new Date(NOW + 30 * 86_400_000).toISOString(),
    );
  });

  test("the composed re-invite's rotation reflects the record's max-age policy", async () => {
    const record = inviterRecord({ tokenMaxAgeDays: 30 });
    const reinvite = await composeManagedReinvite(record, location, seams);
    expect(reinvite.rotation.expires).toBe(
      new Date(NOW + 30 * 86_400_000).toISOString(),
    );
    // The token's own setup expiry is the short bounded lifetime, distinct from the
    // record's max-age stamp -- the setup lifetime rides the token, not the record.
    const token: InvitationToken = await decodeInvitation(reinvite.encoded);
    expect(token.expires).toBe(reinvite.tokenExpires);
    expect(token.expires).not.toBe(reinvite.rotation.expires);
  });
});
