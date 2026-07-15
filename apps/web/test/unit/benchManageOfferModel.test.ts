import {
  connectionFromLocator,
  deriveAcceptedLinkageTerms,
  disclosedColumnNames,
  generateSharedSecret,
  getDefaultLinkageTerms,
  inferMetadata,
} from "@psilink/core";
import { describe, expect, test } from "vitest";

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
} from "@bench/manageOfferModel";

import type { ManagedDepositInputs } from "@bench/manageOfferModel";
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
// carried on the invitation), not from its own browser location.
const invitationEndpoint: WebRTCEndpoint = {
  channel: "webrtc",
  host: "inviter.example.net",
  port: 8443,
  path: "/api/",
};

// ssn/first_name/last_name/dob infer matching keys; program_code is not in the
// alias map, so it infers a disclosed payload column -- a non-trivial published
// set for the inviter deposit to carry.
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
    side: "inviter",
    exchangeFile: composeManagedDocument(
      {
        linkageTerms: inviterTerms,
        metadata: inviterMetadata,
        disclosedPayloadColumns: tokenDisclosedColumns,
      },
      webrtcLocatorFromEndpoint(inviterEndpoint),
    ),
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

  test("drops an absent optional rather than carrying an explicit undefined", () => {
    const bare: WebRTCEndpoint = { channel: "webrtc", host: "peer.example" };
    const locator = webrtcLocatorFromEndpoint(bare);
    expect(locator).not.toHaveProperty("port");
    expect(locator).not.toHaveProperty("path");
    // The composer's strict parse must accept it, so an absent optional cannot be
    // an explicit `undefined` key.
    expect(() =>
      composeManagedDocument({ linkageTerms: inviterTerms }, locator),
    ).not.toThrow();
  });
});

describe("composeManagedDocument", () => {
  test("composes a credential-free webrtc document with no authentication block", () => {
    const doc = composeManagedDocument(
      { linkageTerms: inviterTerms, metadata: inviterMetadata },
      webrtcLocatorFromEndpoint(inviterEndpoint),
    );
    expect(doc.connection).toEqual(
      connectionFromLocator(webrtcLocatorFromEndpoint(inviterEndpoint)),
    );
    expect(doc.authentication).toBeUndefined();
    // No credential is representable: the webrtc server carries only host/port/path.
    expect(JSON.stringify(doc)).not.toContain("username");
    expect(JSON.stringify(doc)).not.toContain('"key"');
  });

  test("carries caller-supplied payload commitments verbatim, never re-derived", () => {
    const doc = composeManagedDocument(
      {
        linkageTerms: inviterTerms,
        metadata: inviterMetadata,
        // Deliberately NOT what this metadata would derive, so the assertion
        // proves the caller's set is carried as-is (one source: the token).
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
        linkageTerms: inviterTerms,
        disclosedPayloadColumns: [],
        expectedPayloadColumns: [],
      },
      webrtcLocatorFromEndpoint(inviterEndpoint),
    );
    expect(strict.disclosedPayloadColumns).toEqual([]);
    expect(strict.expectedPayloadColumns).toEqual([]);

    const lazy = composeManagedDocument(
      { linkageTerms: inviterTerms, metadata: inviterMetadata },
      webrtcLocatorFromEndpoint(inviterEndpoint),
    );
    expect(lazy).not.toHaveProperty("disclosedPayloadColumns");
    expect(lazy).not.toHaveProperty("expectedPayloadColumns");
  });
});

describe("buildManagedDeposit (inviter)", () => {
  test("deposits side inviter with the invitation's secret and composed document", () => {
    const secret = generateSharedSecret();
    const deposit = buildManagedDeposit(
      depositInputs({ side: "inviter", sharedSecret: secret }),
      Date.UTC(2026, 6, 15, 12, 0, 0),
    );
    expect(deposit.side).toBe("inviter");
    expect(deposit.sharedSecret).toBe(secret);
    expect(deposit.exchangeFile.connection.channel).toBe("webrtc");
    expect(deposit.exchangeFile.authentication).toBeUndefined();
    expect(deposit.label).toBe("Riverbend quarterly");
    // The persisted send-side commitment is the token's published set; the
    // received set is unknowable at mint, so no receive lock-in is persisted.
    expect(deposit.exchangeFile.disclosedPayloadColumns).toEqual(
      tokenDisclosedColumns,
    );
    expect(deposit.exchangeFile).not.toHaveProperty("expectedPayloadColumns");
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

  test("carries an input-file handle only when one is captured", () => {
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
  const acceptorColumns = ["ssn", "first_name", "last_name", "dob"];
  const acceptorMetadata = inferMetadata(acceptorColumns);
  // The acceptor's own perspective: identity replaced, output/payload mirrored.
  const acceptorTerms = deriveAcceptedLinkageTerms(inviterTerms, "Clinic A");

  function acceptorDeposit(tokenSet: Array<string> | undefined) {
    return buildManagedDeposit(
      {
        side: "acceptor",
        exchangeFile: composeManagedDocument(
          {
            linkageTerms: acceptorTerms,
            metadata: acceptorMetadata,
            ...(tokenSet !== undefined
              ? { expectedPayloadColumns: tokenSet }
              : {}),
          },
          webrtcLocatorFromEndpoint(invitationEndpoint),
        ),
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

  test("locks in the token's disclosed set as expectedPayloadColumns", () => {
    const deposit = acceptorDeposit(tokenDisclosedColumns);
    expect(deposit.exchangeFile.expectedPayloadColumns).toEqual(
      tokenDisclosedColumns,
    );
    // The acceptor persists no send-side commitment field: its send commitment
    // rides the mirrored payload.send (docs/spec/FILE_SYNC.md).
    expect(deposit.exchangeFile).not.toHaveProperty("disclosedPayloadColumns");
  });

  test("an EMPTY token set persists as a strict receive-nothing lock-in", () => {
    const deposit = acceptorDeposit([]);
    expect(deposit.exchangeFile.expectedPayloadColumns).toEqual([]);
  });

  test("a token with no set leaves the lock-in absent (lazy)", () => {
    const deposit = acceptorDeposit(undefined);
    expect(deposit.exchangeFile).not.toHaveProperty("expectedPayloadColumns");
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
    // enforces the cap), but the field carries it verbatim for that check.
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
