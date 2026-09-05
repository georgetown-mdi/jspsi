import {
  connectionFromLocator,
  deriveAcceptedLinkageTerms,
  disclosedColumnNames,
  generateSharedSecret,
  getDefaultLinkageTerms,
  inferMetadata,
  parseExchangeSpec,
  snakeizeKeys,
} from "@psilink/core";
import { describe, expect, test } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  LABEL_GUIDANCE,
  MAX_LABEL_LENGTH,
  MAX_TOKEN_MAX_AGE_DAYS,
  buildManagedDeposit,
  composeManagedDocument,
  labelWithinCap,
  maxAgeCadenceNote,
  maxAgeDaysError,
  webrtcLocatorFromEndpoint,
} from "@exchange/manageOfferModel";

import type {
  ManagedDepositInputs,
  ManagedExchangeDocumentParts,
} from "@exchange/manageOfferModel";
import type { WebRTCEndpoint } from "@psilink/core";

// The inviter's own signaling location (window.location-derived) is already the
// invitation's endpoint shape; the acceptor's endpoint is the invitation's own.
const inviterEndpoint: WebRTCEndpoint = {
  channel: "webrtc",
  host: "signaling.example.org",
  port: 3000,
  path: "/api/",
};

// The acceptor composes from THIS endpoint (the inviter's signaling location
// held in the invitation), not from its own browser location.
const invitationEndpoint: WebRTCEndpoint = {
  channel: "webrtc",
  host: "inviter.example.net",
  port: 8443,
  path: "/api/",
};

// ssn/first_name/last_name/dob infer matching keys; program_code is not in the
// alias map, so it infers a disclosed payload column -- a non-trivial published
// set for the inviter deposit to hold.
const inviterColumns = [
  "ssn",
  "first_name",
  "last_name",
  "dob",
  "program_code",
];
const inviterMetadata = inferMetadata(inviterColumns);
const inviterTerms = getDefaultLinkageTerms(
  "County Health Dept",
  inviterMetadata,
);

// The set the token publishes -- generateInvitation derives it from this same
// metadata, so the fixture mirrors the mint (["program_code"] here).
const tokenDisclosedColumns = disclosedColumnNames(inviterMetadata);

function depositInputs(
  overrides: Partial<ManagedDepositInputs> = {},
): ManagedDepositInputs {
  return {
    documentParts: {
      side: "inviter",
      linkageTerms: inviterTerms,
      metadata: inviterMetadata,
      disclosedPayloadColumns: tokenDisclosedColumns,
    },
    connection: webrtcLocatorFromEndpoint(inviterEndpoint),
    sharedSecret: generateSharedSecret(),
    choices: { label: "Riverbend quarterly" },
    ...overrides,
  };
}

describe("webrtcLocatorFromEndpoint", () => {
  test("re-shapes a webrtc endpoint into a credential-free locator", () => {
    expect(webrtcLocatorFromEndpoint(inviterEndpoint)).toEqual({
      channel: "webrtc",
      host: "signaling.example.org",
      port: 3000,
      path: "/api/",
    });
  });

  test("drops an absent optional rather than holding an explicit undefined", () => {
    const bare: WebRTCEndpoint = { channel: "webrtc", host: "peer.example" };
    const locator = webrtcLocatorFromEndpoint(bare);
    expect(locator).not.toHaveProperty("port");
    expect(locator).not.toHaveProperty("path");
    // The composer's strict parse must accept it, so an absent optional cannot be
    // an explicit `undefined` key.
    expect(() =>
      composeManagedDocument(
        { side: "inviter", linkageTerms: inviterTerms },
        locator,
      ),
    ).not.toThrow();
  });
});

describe("composeManagedDocument", () => {
  test("composes a credential-free webrtc document with no authentication block", () => {
    const doc = composeManagedDocument(
      {
        side: "inviter",
        linkageTerms: inviterTerms,
        metadata: inviterMetadata,
      },
      webrtcLocatorFromEndpoint(inviterEndpoint),
    );
    expect(doc.connection).toEqual(
      connectionFromLocator(webrtcLocatorFromEndpoint(inviterEndpoint)),
    );
    expect(doc.authentication).toBeUndefined();
    // No credential is representable: the webrtc server holds only host/port/path.
    expect(JSON.stringify(doc)).not.toContain("username");
    expect(JSON.stringify(doc)).not.toContain('"key"');
  });

  test("holds caller-supplied payload commitments verbatim, never re-derived", () => {
    const doc = composeManagedDocument(
      {
        side: "inviter",
        linkageTerms: inviterTerms,
        metadata: inviterMetadata,
        // NOT what this metadata would derive, so the assertion proves the
        // caller's set is held as-is (one source: the token).
        disclosedPayloadColumns: ["program_code", "extra_committed"],
        expectedPayloadColumns: ["partner_col"],
      },
      webrtcLocatorFromEndpoint(inviterEndpoint),
    );
    expect(doc.disclosedPayloadColumns).toEqual([
      "program_code",
      "extra_committed",
    ]);
    expect(doc.expectedPayloadColumns).toEqual(["partner_col"]);
  });

  test("preserves an EMPTY commitment (strict), distinct from an absent one (lazy)", () => {
    const strict = composeManagedDocument(
      {
        side: "inviter",
        linkageTerms: inviterTerms,
        disclosedPayloadColumns: [],
        expectedPayloadColumns: [],
      },
      webrtcLocatorFromEndpoint(inviterEndpoint),
    );
    expect(strict.disclosedPayloadColumns).toEqual([]);
    expect(strict.expectedPayloadColumns).toEqual([]);

    const lazy = composeManagedDocument(
      {
        side: "inviter",
        linkageTerms: inviterTerms,
        metadata: inviterMetadata,
      },
      webrtcLocatorFromEndpoint(inviterEndpoint),
    );
    expect(lazy).not.toHaveProperty("disclosedPayloadColumns");
    expect(lazy).not.toHaveProperty("expectedPayloadColumns");
  });

  test("holds the caller's terms-side commitment verbatim, absent when none binds", () => {
    // The declaration is the token's, never re-derived from the terms composed
    // beside it: an acceptor's own `deduplicate` is the mirror's false whatever
    // the inviter declared, so deriving it here would bind the wrong value.
    for (const declared of [false, true]) {
      const doc = composeManagedDocument(
        {
          side: "acceptor",
          linkageTerms: deriveAcceptedLinkageTerms(inviterTerms, "Clinic A"),
          expectedPartnerDeduplicate: declared,
        },
        webrtcLocatorFromEndpoint(inviterEndpoint),
      );
      expect(doc.expectedPartnerDeduplicate).toBe(declared);
      expect(doc.linkageTerms.deduplicate).toBe(false);
    }
    const none = composeManagedDocument(
      { side: "inviter", linkageTerms: inviterTerms },
      webrtcLocatorFromEndpoint(inviterEndpoint),
    );
    expect(none).not.toHaveProperty("expectedPartnerDeduplicate");
  });
});

// The acceptor's own perspective of the inviter's terms: identity replaced,
// output and payload mirrored -- what the accept flow composes its document from.
const acceptedTerms = deriveAcceptedLinkageTerms(inviterTerms, "Clinic A");
// The acceptor's own file: ssn/first_name/last_name/dob infer linkage columns and
// visit_id infers a disclosed payload column, so the set it would send is
// non-empty and derived, not authored.
const acceptorMetadataFixture = inferMetadata([
  "ssn",
  "first_name",
  "last_name",
  "dob",
  "visit_id",
]);

describe("the acceptor's outbound-payload consent record", () => {
  test("records the resolved set as confirmed -- exactly what the columns step showed", () => {
    const doc = composeManagedDocument(
      {
        side: "acceptor",
        linkageTerms: acceptedTerms,
        metadata: acceptorMetadataFixture,
      },
      webrtcLocatorFromEndpoint(invitationEndpoint),
    );
    // The shown set is disclosedColumnNames over the same metadata the columns
    // step held, which is the metadata this document persists -- so the record and
    // the document's own metadata cannot state different disclosures.
    expect(doc.outboundPayloadConsent).toEqual({
      status: "confirmed",
      columns: disclosedColumnNames(acceptorMetadataFixture),
    });
    // Pinned literally too, so the assertion above cannot pass on a derivation
    // that drifted in step with the record.
    expect(doc.outboundPayloadConsent).toEqual({
      status: "confirmed",
      columns: ["visit_id"],
    });
  });

  test("records confirmed with an EMPTY set when the file discloses nothing, distinct from no record", () => {
    const keysOnly = inferMetadata(["ssn", "first_name", "last_name", "dob"]);
    const doc = composeManagedDocument(
      {
        side: "acceptor",
        linkageTerms: acceptedTerms,
        metadata: keysOnly,
      },
      webrtcLocatorFromEndpoint(invitationEndpoint),
    );
    expect(doc.outboundPayloadConsent).toEqual({
      status: "confirmed",
      columns: [],
    });
  });

  test("records pending when the acceptance resolved no set to show", () => {
    const doc = composeManagedDocument(
      { side: "acceptor", linkageTerms: acceptedTerms },
      webrtcLocatorFromEndpoint(invitationEndpoint),
    );
    // Pending, never absent: an absent record passes silently at every later run,
    // while pending makes the first run that CAN resolve the set show and confirm
    // it (and an unattended one refuse).
    expect(doc.outboundPayloadConsent).toEqual({ status: "pending" });
  });

  test("records nothing when the exchange transmits nothing to the partner", () => {
    // An invitation whose inviting party wants no result: the mirror leaves this
    // acceptor sharing nothing, so the payload step transmits nothing whatever the
    // input holds and there is no disclosure to consent to.
    const sendsNothing = deriveAcceptedLinkageTerms(
      {
        ...inviterTerms,
        output: { expectsOutput: false, shareWithPartner: true },
      },
      "Clinic A",
    );
    expect(sendsNothing.output.shareWithPartner).toBe(false);
    const doc = composeManagedDocument(
      {
        side: "acceptor",
        linkageTerms: sendsNothing,
        metadata: acceptorMetadataFixture,
      },
      webrtcLocatorFromEndpoint(invitationEndpoint),
    );
    expect(doc).not.toHaveProperty("outboundPayloadConsent");
  });

  test("the inviter records none: its own set was authored at mint", () => {
    const doc = composeManagedDocument(
      {
        side: "inviter",
        linkageTerms: inviterTerms,
        metadata: inviterMetadata,
      },
      webrtcLocatorFromEndpoint(inviterEndpoint),
    );
    expect(doc).not.toHaveProperty("outboundPayloadConsent");
  });

  test("survives a round trip through the CLI config schema, record intact", () => {
    const doc = composeManagedDocument(
      {
        side: "acceptor",
        linkageTerms: acceptedTerms,
        metadata: acceptorMetadataFixture,
        expectedPayloadColumns: tokenDisclosedColumns,
      },
      webrtcLocatorFromEndpoint(invitationEndpoint),
    );
    // The document as the CLI would receive it: snake_case keys, serialized and
    // read back through the schema a `psilink.yaml` is parsed with.
    const serialized = stringifyYaml(snakeizeKeys(doc));
    expect(serialized).toContain("outbound_payload_consent");
    const reloaded = parseExchangeSpec(parseYaml(serialized));
    expect(reloaded.outboundPayloadConsent).toEqual(doc.outboundPayloadConsent);
    expect(reloaded.metadata).toEqual(doc.metadata);
  });
});

describe("buildManagedDeposit (inviter)", () => {
  test("deposits side inviter with the invitation's secret and composed document", () => {
    const secret = generateSharedSecret();
    const deposit = buildManagedDeposit(
      depositInputs({ sharedSecret: secret }),
      Date.UTC(2026, 6, 15, 12, 0, 0),
    );
    expect(deposit.side).toBe("inviter");
    expect(deposit.sharedSecret).toBe(secret);
    expect(deposit.exchangeFile.connection.channel).toBe("webrtc");
    expect(deposit.exchangeFile.authentication).toBeUndefined();
    expect(deposit.label).toBe("Riverbend quarterly");
    // The persisted send-side commitment is the token's published set; the
    // received set is unknowable at mint, so no receive commitment is persisted.
    expect(deposit.exchangeFile.disclosedPayloadColumns).toEqual(
      tokenDisclosedColumns,
    );
    expect(deposit.exchangeFile).not.toHaveProperty("expectedPayloadColumns");
  });

  test("holds an input handle and no schedule: the offer has no schedule to make", () => {
    // The unattended runner fires on a record holding BOTH a schedule and a
    // persisted input handle. The deposit writes the handle and no schedule --
    // the offer has none to make -- so this path cannot assemble that pair; the
    // import path, which can hold a schedule and reconstructs no handle, is its
    // converse (test/unit/psi/managedExchangeImport.test.ts). Neither is a claim a
    // comment could hold.
    const handle = {} as FileSystemFileHandle;
    const deposit = buildManagedDeposit(
      depositInputs({ inputFileHandle: handle }),
      Date.UTC(2026, 6, 15, 12, 0, 0),
    );
    expect(deposit.inputFileHandle).toBe(handle);
    expect(deposit).not.toHaveProperty("schedule");
  });

  test("tokenMaxAgeDays and expires are absent unless the operator opts in", () => {
    const deposit = buildManagedDeposit(
      depositInputs(),
      Date.UTC(2026, 6, 15, 12, 0, 0),
    );
    expect(deposit).not.toHaveProperty("tokenMaxAgeDays");
    expect(deposit).not.toHaveProperty("expires");
  });

  test("an opted-in max age stamps expires N days out (not the invitation lifetime)", () => {
    const now = Date.UTC(2026, 6, 15, 12, 0, 0);
    const deposit = buildManagedDeposit(
      depositInputs({ choices: { label: "labelled", tokenMaxAgeDays: 30 } }),
      now,
    );
    expect(deposit.tokenMaxAgeDays).toBe(30);
    // The stamp is now + 30 days, from the max-age policy alone; the invitation's
    // setup lifetime never flows into the record's expires.
    expect(deposit.expires).toBe(new Date(now + 30 * 86_400_000).toISOString());
  });

  test("holds an input-file handle only when one is captured", () => {
    const handle = { name: "records.csv" } as unknown as FileSystemFileHandle;
    const withHandle = buildManagedDeposit(
      depositInputs({ inputFileHandle: handle }),
      Date.now(),
    );
    expect(withHandle.inputFileHandle).toBe(handle);

    const without = buildManagedDeposit(depositInputs(), Date.now());
    expect(without).not.toHaveProperty("inputFileHandle");
  });
});

describe("buildManagedDeposit (acceptor)", () => {
  const acceptorColumns = ["ssn", "first_name", "last_name", "dob", "visit_id"];
  const acceptorMetadata = inferMetadata(acceptorColumns);
  // The acceptor's own perspective: identity replaced, output/payload mirrored.
  const acceptorTerms = deriveAcceptedLinkageTerms(inviterTerms, "Clinic A");

  function acceptorDeposit(
    tokenSet: Array<string> | undefined,
    declaredDeduplicate?: boolean,
  ) {
    return buildManagedDeposit(
      {
        documentParts: {
          side: "acceptor",
          linkageTerms: acceptorTerms,
          metadata: acceptorMetadata,
          ...(tokenSet !== undefined
            ? { expectedPayloadColumns: tokenSet }
            : {}),
          ...(declaredDeduplicate !== undefined
            ? { expectedPartnerDeduplicate: declaredDeduplicate }
            : {}),
        },
        connection: webrtcLocatorFromEndpoint(invitationEndpoint),
        sharedSecret: generateSharedSecret(),
        choices: { label: "Clinic A partnership" },
      },
      Date.now(),
    );
  }

  test("deposits side acceptor composing from the invitation endpoint and derived terms", () => {
    const deposit = acceptorDeposit(tokenDisclosedColumns);
    expect(deposit.side).toBe("acceptor");
    // The connection block is composed from the INVITATION's endpoint.
    expect(deposit.exchangeFile.connection).toEqual(
      connectionFromLocator(webrtcLocatorFromEndpoint(invitationEndpoint)),
    );
    expect(deposit.exchangeFile.linkageTerms.identity).toBe("Clinic A");
    expect(deposit.exchangeFile.authentication).toBeUndefined();
  });

  test("commits the token's disclosed set as expectedPayloadColumns", () => {
    const deposit = acceptorDeposit(tokenDisclosedColumns);
    expect(deposit.exchangeFile.expectedPayloadColumns).toEqual(
      tokenDisclosedColumns,
    );
    // The acceptor persists no send-side commitment field: its send commitment
    // rides the mirrored payload.send (docs/spec/FILE_SYNC.md).
    expect(deposit.exchangeFile).not.toHaveProperty("disclosedPayloadColumns");
  });

  test("the deposited document records this party's own outbound set as confirmed", () => {
    const deposit = acceptorDeposit(tokenDisclosedColumns);
    expect(deposit.exchangeFile.outboundPayloadConsent).toEqual({
      status: "confirmed",
      columns: disclosedColumnNames(acceptorMetadata),
    });
    expect(disclosedColumnNames(acceptorMetadata)).toEqual(["visit_id"]);
  });

  test("an EMPTY token set persists as a strict receive-nothing commitment", () => {
    const deposit = acceptorDeposit([]);
    expect(deposit.exchangeFile.expectedPayloadColumns).toEqual([]);
  });

  test("a token with no set leaves the commitment absent (lazy)", () => {
    const deposit = acceptorDeposit(undefined);
    expect(deposit.exchangeFile).not.toHaveProperty("expectedPayloadColumns");
  });

  test("commits the token's declared deduplicate for later re-runs", () => {
    // A managed re-run runs from this document alone, with no token in hand, so
    // the declaration the acceptance consented to has to be in it or every re-run
    // after the one-shot runs unbound.
    for (const declared of [false, true]) {
      const deposit = acceptorDeposit(tokenDisclosedColumns, declared);
      expect(deposit.exchangeFile.expectedPartnerDeduplicate).toBe(declared);
    }
  });
});

// A deposit whose stored side disagrees with the side its document was composed
// for stores an acceptor record holding no consent record -- the silent pass the
// field exists to prevent. The record's side and the document both come from the
// one `side` in the deposit's parts, which is the single statement each screen
// makes at its deposit call.
describe("the deposit's side and its document", () => {
  const connection = webrtcLocatorFromEndpoint(invitationEndpoint);

  function depositFor(parts: ManagedExchangeDocumentParts) {
    return buildManagedDeposit(
      {
        documentParts: parts,
        connection,
        sharedSecret: generateSharedSecret(),
        choices: { label: "Clinic A partnership" },
      },
      Date.now(),
    );
  }

  const acceptorParts: ManagedExchangeDocumentParts = {
    side: "acceptor",
    linkageTerms: acceptedTerms,
    metadata: acceptorMetadataFixture,
  };

  test("an acceptor deposit stores side acceptor and a document that records its consent", () => {
    const deposit = depositFor(acceptorParts);
    expect(deposit.side).toBe("acceptor");
    expect(deposit.exchangeFile.outboundPayloadConsent).toEqual({
      status: "confirmed",
      columns: ["visit_id"],
    });
  });

  test("an inviter deposit stores side inviter and a document that records none", () => {
    const deposit = depositFor({ ...acceptorParts, side: "inviter" });
    expect(deposit.side).toBe("inviter");
    expect(deposit.exchangeFile).not.toHaveProperty("outboundPayloadConsent");
  });

  test("the stored document is what the stored side composes, and only that", () => {
    const deposit = depositFor(acceptorParts);
    expect(deposit.exchangeFile).toEqual(
      composeManagedDocument(acceptorParts, connection),
    );
    // The two sides compose different documents, so the agreement above is a
    // property of the deposit rather than a shape both sides happen to share.
    expect(deposit.exchangeFile).not.toEqual(
      composeManagedDocument({ ...acceptorParts, side: "inviter" }, connection),
    );
  });
});

describe("the label cap", () => {
  test("labelWithinCap accepts a label at the cap and rejects one past it", () => {
    expect(labelWithinCap("x".repeat(MAX_LABEL_LENGTH))).toBe(true);
    expect(labelWithinCap("x".repeat(MAX_LABEL_LENGTH + 1))).toBe(false);
    expect(labelWithinCap("")).toBe(true);
  });

  test("buildManagedDeposit produces a record the store's cap accepts, and rejects an over-long one", () => {
    const atCap = "x".repeat(MAX_LABEL_LENGTH);
    expect(() =>
      buildManagedDeposit(
        depositInputs({ choices: { label: atCap } }),
        Date.now(),
      ),
    ).not.toThrow();
    // The deposit itself does not throw on an over-long label (the store's build
    // enforces the cap), but the field holds it verbatim for that check.
    const overCap = "x".repeat(MAX_LABEL_LENGTH + 1);
    const deposit = buildManagedDeposit(
      depositInputs({ choices: { label: overCap } }),
      Date.now(),
    );
    expect(deposit.label.length).toBe(MAX_LABEL_LENGTH + 1);
    expect(labelWithinCap(deposit.label)).toBe(false);
  });
});

describe("maxAgeCadenceNote", () => {
  test("names the cadence implication when a policy is set", () => {
    const note = maxAgeCadenceNote(30);
    expect(note).toContain("30 days");
    expect(note).toContain("run or be renewed");
  });

  test("singularizes one day", () => {
    expect(maxAgeCadenceNote(1)).toContain("1 day");
    expect(maxAgeCadenceNote(1)).not.toContain("1 days");
  });

  test("returns undefined when no policy is set (the default)", () => {
    expect(maxAgeCadenceNote(undefined)).toBeUndefined();
  });
});

describe("maxAgeDaysError", () => {
  test("accepts a positive whole day count up to the schema's cap", () => {
    expect(maxAgeDaysError(1)).toBeUndefined();
    expect(maxAgeDaysError(90)).toBeUndefined();
    expect(maxAgeDaysError(MAX_TOKEN_MAX_AGE_DAYS)).toBeUndefined();
  });

  test("rejects a cleared field (the input reports a string), not silently no-bound", () => {
    expect(maxAgeDaysError("")).toBeDefined();
    expect(maxAgeDaysError("12.")).toBeDefined();
  });

  test("rejects zero, negatives, and fractions", () => {
    expect(maxAgeDaysError(0)).toBeDefined();
    expect(maxAgeDaysError(-7)).toBeDefined();
    expect(maxAgeDaysError(2.5)).toBeDefined();
  });

  test("rejects a value past the record schema's cap, naming the bound", () => {
    const error = maxAgeDaysError(MAX_TOKEN_MAX_AGE_DAYS + 1);
    expect(error).toContain(String(MAX_TOKEN_MAX_AGE_DAYS));
  });
});

describe("the label guidance", () => {
  test("directs the operator to keep sensitive counterparty detail out", () => {
    expect(LABEL_GUIDANCE).toContain("Name the partnership");
    expect(LABEL_GUIDANCE.toLowerCase()).toContain("never sent");
  });
});
