import { describe, expect, test } from "vitest";

import {
  ACCEPTOR_SEND_FORWARD_REFERENCE,
  acceptorConsentName,
  acceptorConsentReady,
  acceptorDoneLedgerRows,
  acceptorDoneLedgerTag,
  acceptorLedgerRows,
  acceptorLedgerTag,
  acceptorRailFacts,
  acceptorSpine,
  invitingPartyName,
} from "@bench/acceptorModel";

import type { InvitationToken, LinkageTerms, Metadata } from "@psilink/core";

// A self-contained set of linkage terms with two keys, a payload, and a legal
// agreement, so a single ledger render exercises every row. The identity carries
// injection characters JSX escaping does not neutralize, built from escapes
// so the source carries no raw control bytes: an ESC that drives ANSI and a
// right-to-left override.
const ESC = "\u001b";
const RLO = "\u202e";
const EVIL_IDENTITY = `Dana${ESC}[31m${RLO}Okafor`;

const baseTerms: LinkageTerms = {
  version: "1.0.0",
  identity: EVIL_IDENTITY,
  date: "2026-01-15",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [
    { name: "ssn", type: "ssn" },
    { name: "last_name", type: "last_name" },
    { name: "dob", type: "date_of_birth" },
    { name: "zip", type: "zip_code" },
  ],
  linkageKeys: [
    {
      name: "SSN + DOB + last name",
      elements: [{ field: "ssn" }, { field: "dob" }, { field: "last_name" }],
    },
    {
      name: "last name + DOB + ZIP",
      elements: [{ field: "last_name" }, { field: "dob" }, { field: "zip" }],
    },
  ],
  payload: {
    send: [{ name: "enrollment_date" }, { name: "program_code" }],
    receive: [],
  },
  legalAgreement: {
    reference: "MOU-2025-0042",
    purpose: "Program evaluation",
    expirationDate: "2026-12-31",
  },
};

function makeToken(
  termsOverrides: Partial<LinkageTerms> = {},
  tokenOverrides: Partial<InvitationToken> = {},
): InvitationToken {
  return {
    version: "1",
    linkageTerms: { ...baseTerms, ...termsOverrides },
    sharedSecret: "s".repeat(43),
    expires: "2026-07-08T19:32:00.000Z",
    connectionEndpoint: {
      channel: "webrtc",
      host: "127.0.0.1",
      port: 3000,
      path: "/api/",
    },
    ...tokenOverrides,
  };
}

// Acceptor-side metadata as the confirm-columns editor holds it. A linkage key
// column (never disclosed) plus one payload column that transmits. The extra
// payload column's name carries the same injection characters the identity does,
// so the send row's per-name sanitization is exercised on an operator-file string.
const EVIL_COLUMN = `enroll${ESC}[31m${RLO}_date`;
const DISCLOSING_METADATA: Metadata = [
  { name: "ssn", type: "ssn", role: "linkage", isPayload: false },
  { name: EVIL_COLUMN, type: "other", role: "payload", isPayload: true },
];
const NON_DISCLOSING_METADATA: Metadata = [
  { name: "ssn", type: "ssn", role: "linkage", isPayload: false },
];

function rowValue(
  rows: ReturnType<typeof acceptorLedgerRows>,
  label: string,
): string | ReadonlyArray<string> | undefined {
  return rows.find((row) => row.label === label)?.value;
}

function rowMuted(
  rows: ReturnType<typeof acceptorLedgerRows>,
  label: string,
): string | undefined {
  return rows.find((row) => row.label === label)?.muted;
}

describe("acceptor spine derivation", () => {
  test("review-current: the later two steps are pending and not navigable", () => {
    const spine = acceptorSpine("review");
    expect(spine.map((entry) => entry.label)).toEqual([
      "Review terms",
      "Consent & your file",
      "Confirm your columns",
    ]);
    expect(spine.map((entry) => entry.state)).toEqual([
      "current",
      "pending",
      "pending",
    ]);
    expect(spine.map((entry) => entry.navigable)).toEqual([
      false,
      false,
      false,
    ]);
  });

  test("consent-current: review is done and navigable back, columns pending", () => {
    const spine = acceptorSpine("consent");
    expect(spine.map((entry) => entry.state)).toEqual([
      "done",
      "current",
      "pending",
    ]);
    expect(spine.map((entry) => entry.navigable)).toEqual([true, false, false]);
  });

  test("columns-current: both earlier steps are done and navigable back", () => {
    const spine = acceptorSpine("columns");
    expect(spine.map((entry) => entry.state)).toEqual([
      "done",
      "done",
      "current",
    ]);
    expect(spine.map((entry) => entry.navigable)).toEqual([true, true, false]);
  });
});

describe("acceptor rail facts", () => {
  test("the single Customize fact is Cleaning with an em-dash placeholder value", () => {
    const facts = acceptorRailFacts();
    expect(facts).toHaveLength(1);
    expect(facts[0].label).toBe("Cleaning");
    // No fact value yet -- the Rail renders undefined as the em-dash mark.
    expect(facts[0].fact).toBeUndefined();
  });
});

describe("acceptor ledger rows", () => {
  test("the tag names the proposer with the identity sanitized", () => {
    const token = makeToken();
    const tag = acceptorLedgerTag(invitingPartyName(token));
    // The control and bidi characters are neutralized, not rendered raw.
    expect(tag).not.toContain(ESC);
    expect(tag).not.toContain(RLO);
    expect(tag).toContain("Proposed by ");
    expect(tag).toContain("Okafor");
  });

  test("per-key matched-on rows are numbered, one entry per key", () => {
    const rows = acceptorLedgerRows(makeToken());
    expect(rowValue(rows, "Matched on")).toEqual([
      "1. SSN + DOB + last name",
      "2. last name + DOB + ZIP",
    ]);
  });

  test("the expiry row is the absolute decoded moment, not a relative phrase", () => {
    const rows = acceptorLedgerRows(makeToken());
    const expires = rowValue(rows, "Expires");
    expect(typeof expires).toBe("string");
    expect(expires).toMatch(/2026/);
    expect(expires).not.toMatch(/after you share/);
  });

  test("before a file, the send row forward-references the columns step", () => {
    // No metadata yet (review/consent steps): the exact send set is not known, so
    // the row points ahead rather than claiming "No additional columns" -- which
    // would overclaim, since the acceptor's own file, not the invitation, decides
    // what transmits.
    const rows = acceptorLedgerRows(makeToken());
    expect(rowMuted(rows, "You will send")).toBe(
      ACCEPTOR_SEND_FORWARD_REFERENCE,
    );
    expect(rowValue(rows, "You will send")).toBeUndefined();
    // The receive/results/agreement/transport rows read from the invitation.
    expect(rowValue(rows, "You will receive")).toBe(
      "Matched rows + enrollment_date, program_code",
    );
    expect(rowValue(rows, "Results go to")).toBe("You and your partner");
    expect(rowValue(rows, "Agreement")).toBe("MOU-2025-0042");
    expect(rowValue(rows, "Transport")).toBe("Browser");
  });

  test("from the columns step on, the send row names the disclosed metadata columns, sanitized", () => {
    // The acceptor's live metadata discloses a payload column the invitation never
    // requested (the inviter authored no payload.receive). The send row must name
    // it -- the state the security panel proved the old ledger hid.
    const rows = acceptorLedgerRows(makeToken(), DISCLOSING_METADATA);
    const sent = rowValue(rows, "You will send");
    expect(typeof sent).toBe("string");
    expect(sent).toContain("enroll");
    expect(sent).toContain("_date");
    // Sanitized as an operator-file string: the injection bytes never render raw.
    expect(sent).not.toContain(ESC);
    expect(sent).not.toContain(RLO);
    expect(rowMuted(rows, "You will send")).toBeUndefined();
  });

  test("a metadata that discloses nothing reads no additional columns", () => {
    // Once a file exists but its metadata transmits nothing, the honest reading is
    // "No additional columns" -- the empty disclosed set, not the forward-reference.
    const rows = acceptorLedgerRows(makeToken(), NON_DISCLOSING_METADATA);
    expect(rowMuted(rows, "You will send")).toBe("No additional columns");
    expect(rowValue(rows, "You will send")).toBeUndefined();
  });

  test("results go to only-you when the inviter withholds its own receipt", () => {
    const rows = acceptorLedgerRows(
      makeToken({ output: { expectsOutput: false, shareWithPartner: true } }),
    );
    expect(rowValue(rows, "Results go to")).toBe("Only you");
  });

  test("results go to only-your-partner when the acceptor is not shared with", () => {
    const rows = acceptorLedgerRows(
      makeToken({ output: { expectsOutput: true, shareWithPartner: false } }),
    );
    expect(rowValue(rows, "Results go to")).toBe("Only your partner");
  });

  test("an absent legal agreement mutes the Agreement row", () => {
    const rows = acceptorLedgerRows(makeToken({ legalAgreement: undefined }));
    expect(rowMuted(rows, "Agreement")).toBe("None");
  });
});

describe("acceptor completion ledger", () => {
  test("the settled tag names who it was agreed with, identity sanitized", () => {
    const token = makeToken();
    const tag = acceptorDoneLedgerTag(invitingPartyName(token));
    expect(tag).not.toContain(ESC);
    expect(tag).not.toContain(RLO);
    expect(tag).toContain("Agreed with ");
    expect(tag).toContain("Okafor");
  });

  test("rows relabel past tense, drop the expiry, and report the matched count", () => {
    const rows = acceptorDoneLedgerRows(
      makeToken(),
      { matchedRecordCount: 1847 },
      DISCLOSING_METADATA,
    );
    expect(rows.map((row) => row.label)).toEqual([
      "You sent",
      "You received",
      "Matched on",
      "Results went to",
      "Agreement",
      "Transport",
    ]);
    // The "You sent" row names the LAUNCHED metadata's disclosed set -- the frozen
    // pair that actually ran -- sanitized, not the invitation's request.
    const sent = rowValue(rows, "You sent");
    expect(sent).toContain("enroll");
    expect(sent).toContain("_date");
    expect(sent).not.toContain(ESC);
    expect(sent).not.toContain(RLO);
    expect(rowValue(rows, "You received")).toBe(
      "1,847 matched rows + enrollment_date, program_code",
    );
    expect(rowValue(rows, "Results went to")).toBe("You and your partner");
    expect(rowValue(rows, "Agreement")).toBe("MOU-2025-0042");
    expect(rowValue(rows, "Transport")).toBe("Browser");
    // The consumed invitation drops the forward-looking expiry row.
    expect(rows.some((row) => row.label === "Expires")).toBe(false);
  });

  test("a launched metadata that discloses nothing reads no additional columns", () => {
    const rows = acceptorDoneLedgerRows(
      makeToken(),
      { matchedRecordCount: 1847 },
      NON_DISCLOSING_METADATA,
    );
    expect(rowMuted(rows, "You sent")).toBe("No additional columns");
    expect(rowValue(rows, "You sent")).toBeUndefined();
  });

  test("a withheld result states the caveat instead of a count", () => {
    const rows = acceptorDoneLedgerRows(
      makeToken(),
      { resultWithheld: true },
      DISCLOSING_METADATA,
    );
    expect(rowValue(rows, "You received")).toBe(
      "No result table - withheld by the agreed terms",
    );
  });

  test("a zero-count result reads as zero matched rows", () => {
    const rows = acceptorDoneLedgerRows(
      makeToken({ payload: { send: [], receive: [] } }),
      { matchedRecordCount: 0 },
      NON_DISCLOSING_METADATA,
    );
    // No received columns, so no suffix -- just the count.
    expect(rowValue(rows, "You received")).toBe("0 matched rows");
  });
});

describe("acceptor consent gate", () => {
  // A board acceptance criterion: the gate blocks until BOTH the checkbox and a
  // non-empty trimmed name are supplied. Pinned explicitly here, and re-asserted
  // through acceptorConsentReady (the submit-disabled predicate) so the disabled
  // state and the handler re-check cannot diverge.
  test("blocks with neither input", () => {
    expect(acceptorConsentName({ consented: false, name: "" })).toBeUndefined();
    expect(acceptorConsentReady({ consented: false, name: "" })).toBe(false);
  });

  test("blocks with consent but no name", () => {
    expect(
      acceptorConsentName({ consented: true, name: "   " }),
    ).toBeUndefined();
    expect(acceptorConsentReady({ consented: true, name: "   " })).toBe(false);
  });

  test("blocks with a name but no consent", () => {
    expect(
      acceptorConsentName({ consented: false, name: "Sam" }),
    ).toBeUndefined();
    expect(acceptorConsentReady({ consented: false, name: "Sam" })).toBe(false);
  });

  test("passes with both, returning the trimmed name", () => {
    expect(
      acceptorConsentName({ consented: true, name: "  Sam Alvarez  " }),
    ).toBe("Sam Alvarez");
    expect(
      acceptorConsentReady({ consented: true, name: "  Sam Alvarez  " }),
    ).toBe(true);
  });
});
