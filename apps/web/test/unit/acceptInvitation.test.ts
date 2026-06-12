import { describe, expect, test } from "vitest";

import {
  encodeInvitation,
  generateSharedSecret,
  getDefaultLinkageTerms,
  prepareForExchange,
} from "@psilink/core";

import {
  acceptorExchangeDataSpec,
  prepareAcceptedInvitation,
} from "../../src/psi/acceptInvitation.js";

import type {
  ConnectionEndpoint,
  InvitationToken,
  LinkageTerms,
} from "@psilink/core";

const webrtcEndpoint: ConnectionEndpoint = {
  channel: "webrtc",
  host: "127.0.0.1",
  port: 3000,
  path: "/api/",
};

async function encode(
  overrides: Partial<InvitationToken> = {},
): Promise<string> {
  const token: InvitationToken = {
    version: "1",
    linkageTerms: getDefaultLinkageTerms("Inviter"),
    sharedSecret: generateSharedSecret(),
    connectionEndpoint: webrtcEndpoint,
    ...overrides,
  };
  return encodeInvitation(token);
}

describe("prepareAcceptedInvitation", () => {
  test("accepts a valid, unexpired invitation with a WebRTC endpoint", async () => {
    const secret = generateSharedSecret();
    const encoded = await encode({ sharedSecret: secret });

    const { token, endpoint } = await prepareAcceptedInvitation(encoded);

    expect(token.sharedSecret).toBe(secret);
    expect(endpoint.channel).toBe("webrtc");
    expect(endpoint.host).toBe("127.0.0.1");
  });

  test("rejects an expired invitation (before any connect)", async () => {
    // encodeInvitation refuses a past `expires`, so encode with a future expiry
    // and evaluate acceptance at an instant after it -- the same fail-closed
    // check the accept page runs before rendering the connecting UI.
    const expires = "2030-01-01T00:00:00.000Z";
    const encoded = await encode({ expires });

    await expect(
      prepareAcceptedInvitation(encoded, new Date("2030-01-01T00:00:01.000Z")),
    ).rejects.toThrow(/expired/i);
  });

  test("accepts an invitation that has not yet expired", async () => {
    const expires = "2030-01-01T00:00:00.000Z";
    const encoded = await encode({ expires });

    await expect(
      prepareAcceptedInvitation(encoded, new Date("2029-12-31T23:59:59.000Z")),
    ).resolves.toMatchObject({ endpoint: { channel: "webrtc" } });
  });

  test("rejects an invitation with no connection endpoint", async () => {
    const encoded = await encode({ connectionEndpoint: undefined });

    await expect(prepareAcceptedInvitation(encoded)).rejects.toThrow(/WebRTC/i);
  });

  test("rejects an invitation whose endpoint is not WebRTC", async () => {
    const encoded = await encode({
      connectionEndpoint: {
        channel: "sftp",
        host: "sftp.example.com",
        port: 22,
      },
    });

    await expect(prepareAcceptedInvitation(encoded)).rejects.toThrow(/WebRTC/i);
  });

  test("rejects a malformed invitation string", async () => {
    await expect(
      prepareAcceptedInvitation("not-a-real-invitation"),
    ).rejects.toThrow();
  });
});

describe("acceptorExchangeDataSpec", () => {
  // A distinctive single-key terms set whose key name appears in no default
  // template, so its presence in a prepared exchange is unambiguous proof the
  // inviter's terms governed rather than the acceptor's CSV-inferred defaults.
  const inviterTerms: LinkageTerms = {
    version: "1.0.0",
    identity: "Inviting Org",
    date: "2025-01-01",
    algorithm: "psi",
    output: { expectsOutput: true, shareWithPartner: true },
    deduplicate: false,
    linkageFields: [
      { name: "lastName", type: "lastName" },
      { name: "dateOfBirth", type: "dateOfBirth" },
    ],
    linkageKeys: [
      {
        name: "INVITER-ONLY KEY",
        elements: [{ field: "lastName" }, { field: "dateOfBirth" }],
      },
    ],
  };

  test("adopts the inviter's terms but substitutes the acceptor's identity", () => {
    const spec = acceptorExchangeDataSpec(inviterTerms, "Accepting Org");

    // The inviter's keys are carried verbatim...
    expect(spec.linkageTerms?.linkageKeys).toEqual(inviterTerms.linkageKeys);
    // ...but the acceptor's identity replaces the inviter's, so the inviter's
    // identity does not leak into the acceptor's prepared terms.
    expect(spec.linkageTerms?.identity).toBe("Accepting Org");
    expect(spec.linkageTerms?.identity).not.toBe(inviterTerms.identity);
    // The source terms are left untouched (the substitution is a copy).
    expect(inviterTerms.identity).toBe("Inviting Org");
  });

  test("prepares an exchange on the inviter's keys while metadata derives from the acceptor's CSV", () => {
    // The acceptor's CSV column shape differs from the inviter's terms: it adds
    // ssn/first_name the terms never reference, so its CSV-inferred default
    // terms would not be the inviter's single key.
    const rawRows = [
      {
        ssn: "123121234",
        first_name: "Ada",
        last_name: "Lovelace",
        dob: "1990-01-01",
      },
    ];
    const fields = ["ssn", "first_name", "last_name", "dob"];

    const spec = acceptorExchangeDataSpec(inviterTerms, "Accepting Org");
    const prepared = prepareForExchange(spec, "Accepting Org", rawRows, fields);

    // The run is governed by the inviter's keys, not the acceptor's defaults.
    expect(prepared.linkageTerms.linkageKeys.map((k) => k.name)).toEqual([
      "INVITER-ONLY KEY",
    ]);
    expect(prepared.linkageTerms.identity).toBe("Accepting Org");

    // The acceptor's CSV columns would infer a different (multi-key) default set
    // -- confirming the adopted terms genuinely diverge from CSV inference.
    const csvInferred = getDefaultLinkageTerms(
      "Accepting Org",
      prepared.metadata,
    );
    expect(csvInferred.linkageKeys.length).toBeGreaterThan(1);
    expect(csvInferred.linkageKeys.map((k) => k.name)).not.toContain(
      "INVITER-ONLY KEY",
    );

    // Metadata still derives from the acceptor's CSV columns, not the inviter's
    // linkage fields.
    expect(prepared.metadata.map((m) => m.name)).toEqual(fields);
    expect(prepared.metadata.map((m) => m.type)).toEqual([
      "ssn",
      "firstName",
      "lastName",
      "dateOfBirth",
    ]);
  });
});
