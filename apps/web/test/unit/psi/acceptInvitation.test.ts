import { describe, expect, test } from "vitest";

import {
  deriveAcceptedLinkageTerms,
  encodeInvitation,
  generateSharedSecret,
  getDefaultLinkageTerms,
  prepareForExchange,
  resolveLinkageCardinality,
  validateCompatibility,
} from "@psilink/core";

import {
  acceptorDeduplicateRefusal,
  acceptorExchangeDataSpec,
  acceptorMaySetDeduplicate,
  prepareAcceptedInvitation,
} from "../../../src/psi/acceptInvitation.js";
import { selectExchangeDriver } from "../../../src/psi/exchangeDriverSelection.js";

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
    // A WebRTC endpoint is admitted on any profile, and only it has `host`.
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

  test("admits an SFTP endpoint on a console build (its credential-free locator)", async () => {
    const encoded = await encode({ connectionEndpoint: sftpEndpoint });

    const { endpoint } = await prepareAcceptedInvitation(encoded, {
      profile: "console",
    });
    expect(endpoint).toEqual(sftpEndpoint);
  });

  test("rejects an SFTP endpoint off a console build (fails closed)", async () => {
    const encoded = await encode({ connectionEndpoint: sftpEndpoint });

    await expect(
      prepareAcceptedInvitation(encoded, { profile: "hosted" }),
    ).rejects.toThrow(/cannot/i);
  });

  test("rejects a malformed invitation string", async () => {
    await expect(
      prepareAcceptedInvitation("not-a-real-invitation", {
        profile: "console",
      }),
    ).rejects.toThrow();
  });

  // The guard reads core's own verdict, and both strategies this build ships
  // match a deduplicating term, so both are admitted.
  test.each(["cascade", "single-pass"] as const)(
    "admits a deduplicating term under %s",
    async (linkageStrategy) => {
      const terms = getDefaultLinkageTerms("Inviter");
      const encoded = await encode({
        linkageTerms: { ...terms, deduplicate: true, linkageStrategy },
      });

      await expect(
        prepareAcceptedInvitation(encoded, { profile: "hosted" }),
      ).resolves.toMatchObject({ endpoint: { channel: "webrtc" } });
    },
  );

  // The guard's admit decision must AGREE with what selectExchangeDriver would
  // drive: an admitted endpoint's channel (mapped to a Transport) resolves to a
  // live driver kind, and a rejected one either has no drivable channel or maps
  // to the save-file kind that cannot run in the accept flow. Pinned so the two
  // decisions cannot drift.
  const PROFILES: ReadonlyArray<DeploymentProfile> = ["hosted", "console"];
  const ENDPOINT_TRANSPORT = {
    webrtc: "browser",
    filedrop: "filedrop",
    sftp: "sftp",
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

        // Each channel maps to a Transport whose selection kind decides
        // drivability: an admitted endpoint runs live (browser or server-job), a
        // rejected one maps to the save-file kind that cannot run in the accept
        // flow. The sftp-configured flag is false as the accept path passes it: an
        // accepted sftp endpoint still resolves to server-job (the connection is
        // authored before launch), so this stays in lockstep with the guard.
        const drivenLive =
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

    // The inviter's keys are kept verbatim...
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
    // -- confirming the adopted terms diverge from CSV inference.
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

describe("the accepting party's own deduplicate at the seat", () => {
  // The invitation's terms as the seat holds them: a single key, the inviting
  // party's own `deduplicate` declared on them, and a strategy both parties
  // adopt.
  const invitationTerms: LinkageTerms = {
    version: "1.0.0",
    identity: "Inviting Org",
    date: "2025-01-01",
    algorithm: "psi",
    linkageStrategy: "cascade",
    output: { expectsOutput: true, shareWithPartner: true },
    deduplicate: false,
    linkageFields: [{ name: "lastName", type: "last_name" }],
    linkageKeys: [{ name: "LAST", elements: [{ field: "lastName" }] }],
  };

  test.each([false, true])(
    "the value the operator sets reaches the terms this party presents (invitation declares %s)",
    (declared) => {
      // The operator's own value survives into the spec the run prepares from,
      // while the invitation's own side is untouched.
      const terms: LinkageTerms = { ...invitationTerms, deduplicate: declared };
      const spec = acceptorExchangeDataSpec(
        terms,
        "Accepting Org",
        undefined,
        true,
      );
      expect(spec.linkageTerms?.deduplicate).toBe(true);
      expect(terms.deduplicate).toBe(declared);
    },
  );

  test("an omitted value stays the closed false an accept with no control derives", () => {
    expect(
      acceptorExchangeDataSpec(invitationTerms, "Accepting Org").linkageTerms
        ?.deduplicate,
    ).toBe(false);
    expect(
      acceptorExchangeDataSpec({ ...invitationTerms, deduplicate: true }, "Org")
        .linkageTerms?.deduplicate,
    ).toBe(false);
  });

  test.each([
    { inviter: false, acceptor: false },
    { inviter: true, acceptor: false },
    { inviter: false, acceptor: true },
    { inviter: true, acceptor: true },
  ])(
    "the pair ($inviter, $acceptor) runs under the cascade",
    ({ inviter, acceptor }) => {
      // Every combination the schema admits resolves rather than refusing, under
      // the strategy that pairs the both-sided cardinality.
      expect(
        acceptorDeduplicateRefusal(
          { ...invitationTerms, deduplicate: inviter },
          acceptor,
        ),
      ).toBeUndefined();
    },
  );

  test("the both-sided pair under single-pass is refused at the seat", () => {
    // Refused where the operator sets it, before the run and before any key or
    // payload moves, rather than surfacing as a mid-run failure. The message is
    // the run boundary's own, so it names the strategy to change and the
    // one-sided pair to fall back to.
    const singlePass: LinkageTerms = {
      ...invitationTerms,
      linkageStrategy: "single-pass",
      deduplicate: true,
    };
    const refusal = acceptorDeduplicateRefusal(singlePass, true);
    expect(refusal?.scope).toBe("pair");
    expect(refusal?.message).toContain("cascade");
    expect(refusal?.message).toContain(
      "deduplicate to false on one of the two",
    );
    // One-sided under the same strategy runs, and so does the both-sided pair
    // under the strategy that pairs it -- the combination is refused, not the
    // setting.
    expect(acceptorDeduplicateRefusal(singlePass, false)).toBeUndefined();
    expect(
      acceptorDeduplicateRefusal(
        { ...singlePass, linkageStrategy: "cascade" },
        true,
      ),
    ).toBeUndefined();
  });

  test("a count-only invitation refuses this party's own deduplicate at the seat", () => {
    // The count-only shape holds neither party's value open, so the seat states
    // the same refusal the derivation applies rather than letting it reach the
    // launch.
    const countOnly: LinkageTerms = { ...invitationTerms, algorithm: "psi-c" };
    expect(acceptorDeduplicateRefusal(countOnly, false)).toBeUndefined();
    expect(acceptorDeduplicateRefusal(countOnly, true)?.message).toContain(
      "must set deduplicate to false",
    );
  });

  test("a count-only invitation offers no control at all", () => {
    // The shape rule refuses the accepting party's value on a psi-c document as
    // firmly as the mirror rule does on a sole-receiver one, so the seat asks
    // both before offering a control: a count-only invitation that shares the
    // result satisfies the output test alone, and the operator would meet a
    // checkbox whose only admissible value is the one it starts at.
    const countOnly: LinkageTerms = {
      ...invitationTerms,
      algorithm: "psi-c",
      linkageStrategy: "cascade",
    };
    expect(countOnly.output.shareWithPartner).toBe(true);
    expect(acceptorMaySetDeduplicate(countOnly)).toBe(false);
    // And the rule it asks is the schema's own: the same document under `psi`
    // does offer one.
    expect(acceptorMaySetDeduplicate({ ...countOnly, algorithm: "psi" })).toBe(
      true,
    );
  });

  test("the seat's refusal agrees with the run boundary over the same pair", () => {
    // The seat reads `resolveLinkageCardinality`, the boundary the run resolves
    // the joint cardinality at, so it refuses exactly the pairs the run refuses.
    const singlePass: LinkageTerms = {
      ...invitationTerms,
      linkageStrategy: "single-pass",
      deduplicate: true,
    };
    const acceptorTerms = deriveAcceptedLinkageTerms(
      singlePass,
      "Accepting Org",
      true,
    );
    let boundary: string | undefined;
    try {
      resolveLinkageCardinality(acceptorTerms, singlePass);
    } catch (error) {
      boundary = (error as Error).message;
    }
    expect(acceptorDeduplicateRefusal(singlePass, true)?.message).toBe(
      boundary,
    );
  });

  test("a refusal the invitation's own document raises blocks the accept", () => {
    // The derivation refuses a count-only invitation outside the specified
    // shape over the INVITATION's own terms, before this party's value is
    // applied: the closed default meets it too, so no control at this seat
    // clears it and it blocks the accept rather than pointing at one.
    const countOnlyOffCascade: LinkageTerms = {
      ...invitationTerms,
      algorithm: "psi-c",
      linkageStrategy: "single-pass",
    };
    for (const deduplicate of [false, true]) {
      const refusal = acceptorDeduplicateRefusal(
        countOnlyOffCascade,
        deduplicate,
      );
      expect(refusal?.scope).toBe("terms");
      expect(refusal?.message).toContain("must set the linkage strategy to");
    }
  });
});

describe("an invitation whose mirror admits no deduplicate from this party", () => {
  // A sole-receiver invitation: the inviting party keeps the result, so the
  // accepting party mirrors to expectsOutput false -- which the schema takes no
  // deduplicate from.
  const soleReceiver: LinkageTerms = {
    version: "1.0.0",
    identity: "Inviting Org",
    date: "2025-01-01",
    algorithm: "psi",
    linkageStrategy: "cascade",
    output: { expectsOutput: true, shareWithPartner: false },
    deduplicate: false,
    linkageFields: [{ name: "lastName", type: "last_name" }],
    linkageKeys: [{ name: "LAST", elements: [{ field: "lastName" }] }],
  };

  test("offers this party no side of its own to set", () => {
    // What the seat reads before rendering a control: the value would be refused
    // by the derivation, so no control is offered for it.
    expect(acceptorMaySetDeduplicate(soleReceiver)).toBe(false);
    expect(
      acceptorMaySetDeduplicate({
        ...soleReceiver,
        output: { expectsOutput: true, shareWithPartner: true },
      }),
    ).toBe(true);
  });

  test("refuses rather than throws when the derivation refuses the mirror", () => {
    // The accept screen reads this in its render body, where a throw takes the
    // whole route to its error boundary instead of a refusal the operator can
    // read. Both shapes the derivation refuses come back as values: this party's
    // own deduplicate against a sole-receiver invitation, and a sole-receiver
    // invitation that also declares a payload.send -- which mirrors to a receive
    // this party may not hold, on decode, with no operator action at all.
    const ownSide = acceptorDeduplicateRefusal(soleReceiver, true);
    expect(ownSide?.scope).toBe("terms");
    expect(ownSide?.message).toContain(
      "expectsOutput must be true when deduplicate is true",
    );
    const payloadToNonReceiver = acceptorDeduplicateRefusal(
      { ...soleReceiver, payload: { send: [{ name: "dose" }] } },
      false,
    );
    expect(payloadToNonReceiver?.scope).toBe("terms");
    expect(payloadToNonReceiver?.message).toContain(
      "payload.receive must be empty when expectsOutput is false",
    );
  });

  test("runs the closed default the derivation applies", () => {
    // The invitation itself is acceptable; only a value this party cannot hold
    // is refused, so the accept with no control at all goes on.
    expect(acceptorDeduplicateRefusal(soleReceiver, false)).toBeUndefined();
    expect(
      acceptorExchangeDataSpec(soleReceiver, "Accepting Org").linkageTerms
        ?.deduplicate,
    ).toBe(false);
  });
});
