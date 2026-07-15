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
  buildManagedDeposit,
  composeManagedDocument,
  labelWithinCap,
  maxAgeCadenceNote,
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
// alias map, so it infers a disclosed payload column -- a non-trivial disclosed
// set for composeManagedDocument to derive.
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

function depositInputs(
  overrides: Partial<ManagedDepositInputs> = {},
): ManagedDepositInputs {
  return {
    side: "inviter",
    exchangeFile: composeManagedDocument(
      { linkageTerms: inviterTerms, metadata: inviterMetadata },
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

  test("derives disclosed payload columns from this party's metadata", () => {
    const doc = composeManagedDocument(
      { linkageTerms: inviterTerms, metadata: inviterMetadata },
      webrtcLocatorFromEndpoint(inviterEndpoint),
    );
    expect(doc.disclosedPayloadColumns).toEqual(
      disclosedColumnNames(inviterMetadata),
    );
  });

  test("omits disclosed payload columns when there is no metadata", () => {
    const doc = composeManagedDocument(
      { linkageTerms: inviterTerms },
      webrtcLocatorFromEndpoint(inviterEndpoint),
    );
    expect(doc).not.toHaveProperty("disclosedPayloadColumns");
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
  test("deposits side acceptor composing from the invitation endpoint and derived terms", () => {
    const acceptorColumns = ["ssn", "first_name", "last_name", "dob"];
    const acceptorMetadata = inferMetadata(acceptorColumns);
    // The acceptor's own perspective: identity replaced, output/payload mirrored.
    const acceptorTerms = deriveAcceptedLinkageTerms(inviterTerms, "Clinic A");
    const secret = generateSharedSecret();
    const deposit = buildManagedDeposit(
      {
        side: "acceptor",
        exchangeFile: composeManagedDocument(
          { linkageTerms: acceptorTerms, metadata: acceptorMetadata },
          webrtcLocatorFromEndpoint(invitationEndpoint),
        ),
        sharedSecret: secret,
        choices: { label: "Clinic A partnership" },
      },
      Date.now(),
    );
    expect(deposit.side).toBe("acceptor");
    expect(deposit.sharedSecret).toBe(secret);
    // The connection block is composed from the INVITATION's endpoint.
    expect(deposit.exchangeFile.connection).toEqual(
      connectionFromLocator(webrtcLocatorFromEndpoint(invitationEndpoint)),
    );
    expect(deposit.exchangeFile.linkageTerms.identity).toBe("Clinic A");
    expect(deposit.exchangeFile.authentication).toBeUndefined();
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

describe("the label guidance", () => {
  test("directs the operator to keep sensitive counterparty detail out", () => {
    expect(LABEL_GUIDANCE).toContain("Name the partnership");
    expect(LABEL_GUIDANCE.toLowerCase()).toContain("never sent");
  });
});
