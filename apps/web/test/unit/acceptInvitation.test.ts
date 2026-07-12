import { describe, expect, test } from "vitest";

import {
  encodeInvitation,
  generateSharedSecret,
  getDefaultLinkageTerms,
  prepareForExchange,
  validateCompatibility,
} from "@psilink/core";

import {
  acceptorExchangeDataSpec,
  prepareAcceptedInvitation,
} from "../../src/psi/acceptInvitation.js";
import { selectExchangeDriver } from "../../src/bench/exchangeDriverSelection.js";

import type {
  ConnectionEndpoint,
  InvitationToken,
  LinkageTerms,
} from "@psilink/core";
import type { DeploymentProfile } from "@utils/clientConfig";

const webrtcEndpoint: ConnectionEndpoint = {
  channel: "webrtc",
  host: "127.0.0.1",
  port: 3000,
  path: "/api/",
};

const filedropEndpoint: ConnectionEndpoint = {
  channel: "filedrop",
  path: "/srv/exchange",
};

const sftpEndpoint: ConnectionEndpoint = {
  channel: "sftp",
  host: "sftp.example.com",
  port: 22,
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

    const { token, endpoint } = await prepareAcceptedInvitation(encoded, {
      profile: "hosted",
    });

    expect(token.sharedSecret).toBe(secret);
    // A WebRTC endpoint is admitted on any profile, and only it carries `host`.
    expect(endpoint.channel).toBe("webrtc");
    if (endpoint.channel === "webrtc") expect(endpoint.host).toBe("127.0.0.1");
  });

  test("rejects an expired invitation (before any connect)", async () => {
    // encodeInvitation refuses a past `expires`, so encode with a future expiry
    // and evaluate acceptance at an instant after it -- the same fail-closed
    // check the accept page runs before rendering the connecting UI.
    const expires = "2030-01-01T00:00:00.000Z";
    const encoded = await encode({ expires });

    await expect(
      prepareAcceptedInvitation(encoded, {
        now: new Date("2030-01-01T00:00:01.000Z"),
        profile: "hosted",
      }),
    ).rejects.toThrow(/expired/i);
  });

  test("accepts an invitation that has not yet expired", async () => {
    const expires = "2030-01-01T00:00:00.000Z";
    const encoded = await encode({ expires });

    await expect(
      prepareAcceptedInvitation(encoded, {
        now: new Date("2029-12-31T23:59:59.000Z"),
        profile: "hosted",
      }),
    ).resolves.toMatchObject({ endpoint: { channel: "webrtc" } });
  });

  test("rejects an invitation with no connection endpoint", async () => {
    const encoded = await encode({ connectionEndpoint: undefined });

    await expect(
      prepareAcceptedInvitation(encoded, { profile: "console" }),
    ).rejects.toThrow(/cannot/i);
  });

  test("admits a filedrop endpoint on a console build", async () => {
    const encoded = await encode({ connectionEndpoint: filedropEndpoint });

    await expect(
      prepareAcceptedInvitation(encoded, { profile: "console" }),
    ).resolves.toMatchObject({ endpoint: { channel: "filedrop" } });
  });

  test("rejects a filedrop endpoint off a console build (fails closed)", async () => {
    const encoded = await encode({ connectionEndpoint: filedropEndpoint });

    await expect(
      prepareAcceptedInvitation(encoded, { profile: "hosted" }),
    ).rejects.toThrow(/cannot/i);
  });

  test("always rejects an SFTP endpoint, on either profile", async () => {
    const encoded = await encode({ connectionEndpoint: sftpEndpoint });

    for (const profile of ["hosted", "console"] as const)
      await expect(
        prepareAcceptedInvitation(encoded, { profile }),
      ).rejects.toThrow(/cannot/i);
  });

  test("rejects a malformed invitation string", async () => {
    await expect(
      prepareAcceptedInvitation("not-a-real-invitation", {
        profile: "console",
      }),
    ).rejects.toThrow();
  });

  // The guard's admit decision must AGREE with what selectExchangeDriver would
  // drive: an admitted endpoint's channel (mapped to a Transport) resolves to a
  // live driver kind, and a rejected one either has no drivable channel or maps
  // to the save-file kind that cannot run in the accept flow. Pinned so the two
  // decisions cannot drift.
  const PROFILES: ReadonlyArray<DeploymentProfile> = ["hosted", "console"];
  const ENDPOINT_TRANSPORT = {
    webrtc: "browser",
    filedrop: "filedrop",
  } as const;
  const CASES = [
    { channel: "webrtc" as const, endpoint: webrtcEndpoint },
    { channel: "filedrop" as const, endpoint: filedropEndpoint },
    { channel: "sftp" as const, endpoint: sftpEndpoint },
  ];

  for (const profile of PROFILES) {
    for (const { channel, endpoint } of CASES) {
      test(`guard admit for ${channel} on ${profile} matches selectExchangeDriver`, async () => {
        const encoded = await encode({ connectionEndpoint: endpoint });
        const admitted = await prepareAcceptedInvitation(encoded, { profile })
          .then(() => true)
          .catch(() => false);

        // sftp has no accept-drivable transport at all; webrtc and filedrop map
        // to a Transport whose selection kind decides drivability. The remotes
        // flag is false as the accept path passes it: it gates only the sftp
        // channel, which never reaches the selector from an accept.
        const drivenLive =
          channel !== "sftp" &&
          selectExchangeDriver(ENDPOINT_TRANSPORT[channel], profile, false)
            .kind !== "save-file";
        expect(admitted).toBe(drivenLive);
      });
    }
  }
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
    linkageStrategy: "cascade",
    output: { expectsOutput: true, shareWithPartner: true },
    deduplicate: false,
    linkageFields: [
      { name: "lastName", type: "last_name" },
      { name: "dateOfBirth", type: "date_of_birth" },
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

  // The acceptor's output is the MIRROR of the inviter's, not a verbatim copy, so a
  // one-sided invitation produces terms that pass validateCompatibility (the
  // engine now honors one-sided output end-to-end). The symmetric both-receive
  // case is unchanged. Pinned for each of the three output directions.
  test.each([
    {
      direction: "both",
      inviter: { expectsOutput: true, shareWithPartner: true },
      acceptor: { expectsOutput: true, shareWithPartner: true },
    },
    {
      direction: "inviter-only",
      inviter: { expectsOutput: true, shareWithPartner: false },
      acceptor: { expectsOutput: false, shareWithPartner: true },
    },
    {
      direction: "partner-only",
      inviter: { expectsOutput: false, shareWithPartner: true },
      acceptor: { expectsOutput: true, shareWithPartner: false },
    },
  ])(
    "derives the acceptor's output as the mirror of the inviter's ($direction)",
    ({ inviter, acceptor }) => {
      const oneSided: LinkageTerms = { ...inviterTerms, output: inviter };
      const spec = acceptorExchangeDataSpec(oneSided, "Accepting Org");

      expect(spec.linkageTerms?.output).toStrictEqual(acceptor);
      // The derived terms agree with the inviter's under the cross-party mirror
      // check, so the exchange would not abort on an output mismatch.
      expect(
        validateCompatibility(oneSided, spec.linkageTerms!).errors,
      ).toEqual([]);
    },
  );

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
      "first_name",
      "last_name",
      "date_of_birth",
    ]);
  });
});
