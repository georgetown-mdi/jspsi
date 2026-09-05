import { describe, expect, test } from "vitest";

import {
  displayPartyIdentity,
  redactAndDisplayPartyIdentity,
  UNNAMED_PARTY_LABEL,
} from "../src/partyIdentityDisplay";
import { summarizeInvitation } from "../src/invitationSummary";
import { ESC, hostileTerms, RLO } from "../src/displayEscapingFixtures";

import type { LinkageTerms } from "../src/config/linkageTerms";

/**
 * `linkage_terms.identity` is optional, so every surface that shows a
 * party's name meets a party that supplied none. Neither an empty cell nor
 * `undefined` marks that state -- both display as a fault rather than an
 * absence. `UNNAMED_PARTY_LABEL` is the one marker for it, so two surfaces
 * cannot disagree about what an unnamed party looks like.
 */

const terms: LinkageTerms = {
  version: "1.0.0",
  identity: "Party A",
  date: "2025-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [{ name: "ssn", type: "ssn" }],
  linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
};

describe("a party identity as display text", () => {
  test("a supplied name is escaped, not replaced", () => {
    expect(displayPartyIdentity("Party A")).toBe("Party A");
    // The escape still happens: the marker path must not become a way around it.
    expect(displayPartyIdentity(`Acme${ESC}org`)).not.toContain(ESC);
  });

  test("an absent name reads as an absence, in one wording", () => {
    expect(displayPartyIdentity(undefined)).toBe(UNNAMED_PARTY_LABEL);
    expect(redactAndDisplayPartyIdentity(undefined)).toBe(UNNAMED_PARTY_LABEL);
    // Parenthesized and lower-case so it states an absence rather than filling
    // in a name -- though display cannot separate this marker from a party that
    // named itself the same text -- and printable ASCII so it cannot inject
    // anything into a terminal.
    expect(UNNAMED_PARTY_LABEL).toBe("(no name given)");
    expect(UNNAMED_PARTY_LABEL).toMatch(/^[\x20-\x7e]+$/);
  });

  test("the redacting form still redacts a supplied name", () => {
    expect(
      redactAndDisplayPartyIdentity("-----BEGIN OPENSSH PRIVATE KEY-----"),
    ).toContain("[redacted private key]");
  });
});

describe("the invitation consent surface names the inviter", () => {
  test("an inviter that named itself is shown, escaped", () => {
    expect(summarizeInvitation({ linkageTerms: terms }).invitingParty).toBe(
      "Party A",
    );
    expect(
      summarizeInvitation({
        linkageTerms: { ...terms, identity: hostileTerms.identity },
      }).invitingParty,
    ).not.toContain(RLO);
  });

  test("an inviter that named itself none is shown as unnamed", () => {
    // An acceptor consents to terms from a party it can read: an invitation
    // with no identity says so on the consent screen rather than leaving the
    // heading blank, which would look like a rendering fault.
    const { identity: _unnamed, ...withoutIdentity } = terms;
    expect(
      summarizeInvitation({ linkageTerms: withoutIdentity }).invitingParty,
    ).toBe(UNNAMED_PARTY_LABEL);
  });
});
