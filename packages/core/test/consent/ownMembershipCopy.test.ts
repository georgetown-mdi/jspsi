import { describe, expect, test } from "vitest";

import {
  CONSENT_FACTS,
  SELF_AUTHORED_EXCHANGE_FACTS,
} from "../../src/consent/consentFacts.js";
import { getDefaultLinkageTerms } from "../../src/defaults/builtInLinkageTerms.js";
import { inferMetadata } from "../../src/config/metadata.js";
import {
  summarizeInvitation,
  withholdsAcceptorAssociationTable,
  withholdsInviterAssociationTable,
  withholdsPartnerAssociationTable,
} from "../../src/consent/invitationSummary.js";

import type { LinkageTerms } from "../../src/config/linkageTermsSchema.js";

// The two sentences a surface picks between for what a non-receiving partner
// learns about its own records, and the verdict the pick reads. The claim is
// intrinsic to an identifier-revealing match only where the run returns that
// party its half of the association table; the single-pass combination that
// withholds the half leaves it nothing to learn, so the same line owes the
// other sentence there.

const LINKAGE_COLUMNS = ["ssn", "first_name", "last_name", "dob"];

/** Terms whose non-receiving party -- the helper the fact speaks about -- is
 * the INVITING party, read at the accept seat. */
function inviterIsTheHelper(overrides: Partial<LinkageTerms>): LinkageTerms {
  return {
    ...getDefaultLinkageTerms("Inviter", inferMetadata(LINKAGE_COLUMNS, [])),
    output: { expectsOutput: false, shareWithPartner: true },
    payload: { send: [{ name: "risk_score" }], receive: [] },
    ...overrides,
  };
}

/** The same shape mirrored: the ACCEPTING party is the helper, which is what
 * the seat where this party proposes its own terms reads. */
function acceptorIsTheHelper(overrides: Partial<LinkageTerms>): LinkageTerms {
  return {
    ...getDefaultLinkageTerms("Inviter", inferMetadata(LINKAGE_COLUMNS, [])),
    output: { expectsOutput: true, shareWithPartner: false },
    payload: { send: [], receive: [{ name: "program_outcome" }] },
    ...overrides,
  };
}

describe("the own-membership consent pair", () => {
  test("holds one basis and two sentences, neither standing in for the other", () => {
    // Both halves are the run's rather than the partner's: one is intrinsic to
    // the match and the other is suppressed at the wire, and neither asks for
    // the partner's cooperation.
    expect(CONSENT_FACTS.partnerLearnsOwnMembership.basis).toBe("enforced");
    expect(CONSENT_FACTS.partnerOwnMembershipWithheld.basis).toBe("enforced");
    const disclosure = CONSENT_FACTS.partnerLearnsOwnMembership.note;
    const withheld = CONSENT_FACTS.partnerOwnMembershipWithheld.note;
    expect(disclosure).toBeTruthy();
    expect(withheld).toBeTruthy();
    expect(withheld).not.toBe(disclosure);
  });

  test("states a disclosure in one sentence and its absence in the other", () => {
    // The whole point of the pair: a reader whose partner is left blind must
    // not be told the partner learns its own records' membership, and a reader
    // whose partner does learn it must not be told the exchange withholds it.
    expect(CONSENT_FACTS.partnerLearnsOwnMembership.note).toContain(
      "your partner learns which of its own records are in your data",
    );
    expect(CONSENT_FACTS.partnerOwnMembershipWithheld.note).toContain(
      "never sent which of its own records are in your data",
    );
    // And the withheld sentence puts the withholding on the exchange rather
    // than on the software the partner runs, which is what its enforced basis
    // claims.
    expect(CONSENT_FACTS.partnerOwnMembershipWithheld.note).toContain(
      "a limit of the exchange rather than a choice",
    );
  });

  test("is picked by the run's own verdict on the inviting party's half", () => {
    // The false branch: a cascade returns the helper its matched positions as
    // the rounds go, so the disclosure sentence is the accurate one.
    const exchanged = inviterIsTheHelper({ linkageStrategy: "cascade" });
    expect(withholdsInviterAssociationTable(exchanged)).toBe(false);
    expect(
      summarizeInvitation({ linkageTerms: exchanged }).inviterTableWithheld,
    ).toBe(false);

    // The true branch: single-pass, and the inviting party declares no column
    // of its own to send, so it needs nothing back and is sent nothing.
    const suppressed = inviterIsTheHelper({
      linkageStrategy: "single-pass",
      payload: { send: [], receive: [] },
    });
    expect(withholdsInviterAssociationTable(suppressed)).toBe(true);
    expect(
      summarizeInvitation({ linkageTerms: suppressed }).inviterTableWithheld,
    ).toBe(true);
  });

  test("is picked by the mirrored verdict where the accepting party is the helper", () => {
    // The seat proposing its own terms reads the other half's verdict for the
    // same pair of sentences, so both branches are measured there too.
    const exchanged = acceptorIsTheHelper({ linkageStrategy: "cascade" });
    expect(withholdsAcceptorAssociationTable(exchanged)).toBe(false);
    expect(
      summarizeInvitation({ linkageTerms: exchanged }).acceptorTableWithheld,
    ).toBe(false);

    const suppressed = acceptorIsTheHelper({
      linkageStrategy: "single-pass",
      payload: { send: [], receive: [] },
    });
    expect(withholdsAcceptorAssociationTable(suppressed)).toBe(true);
    expect(
      summarizeInvitation({ linkageTerms: suppressed }).acceptorTableWithheld,
    ).toBe(true);
  });

  test("says at the self-authored seat when a partner disclosing anyway is caught", () => {
    // That seat's verdict reads the partner's DECLARED payload direction, and a
    // partner config with no payload block passes compatibility while its
    // metadata still discloses a column: the reconciliation that catches it
    // runs after the exchange, so the sentence cannot promise a stop before
    // this party's half moves.
    const fact = CONSENT_FACTS.partnerOwnMembershipWithheldSelfAuthored;
    expect(fact.basis).toBe("trust-contingent");
    expect(fact.note).toContain("By agreement, not enforced");
    expect(fact.note).toContain(
      "its process is sent that half while the exchange runs, and the run " +
        "stops only afterwards",
    );
    // The enforced sibling's claim is what this one must not make.
    expect(fact.note).not.toContain(
      CONSENT_FACTS.partnerOwnMembershipWithheld.note,
    );
  });

  test("lists every self-authored restatement in the set that excludes them", () => {
    // A fact added for this seat and left out of the set is one the acceptance
    // coverage checks would then demand of a prompt that cannot state it, so
    // the naming convention the set's documentation states is checked here
    // rather than remembered.
    const named = Object.keys(CONSENT_FACTS).filter((id) =>
      id.endsWith("SelfAuthored"),
    );
    expect(named.length).toBeGreaterThan(0);
    expect([...SELF_AUTHORED_EXCHANGE_FACTS].sort()).toEqual(named.sort());
  });

  test("is picked at the seat reading terms it wrote itself", () => {
    // A party that authored its own configuration reads the same pair off its
    // own document, where the helper is simply its partner.
    const exchanged = acceptorIsTheHelper({ linkageStrategy: "cascade" });
    expect(withholdsPartnerAssociationTable(exchanged)).toBe(false);

    const suppressed = acceptorIsTheHelper({
      linkageStrategy: "single-pass",
      payload: { send: [], receive: [] },
    });
    expect(withholdsPartnerAssociationTable(suppressed)).toBe(true);

    // Requesting a column from the partner is what makes the partner a helper
    // that needs its half back, so the run returns it.
    expect(
      withholdsPartnerAssociationTable(
        acceptorIsTheHelper({ linkageStrategy: "single-pass" }),
      ),
    ).toBe(false);
    // And an absent request binds the partner to nothing, so it reads as
    // disclosure rather than as an empty declaration.
    expect(
      withholdsPartnerAssociationTable(
        acceptorIsTheHelper({
          linkageStrategy: "single-pass",
          payload: { send: [] },
        }),
      ),
    ).toBe(false);
  });

  test("reads this party's own send out of the verdict at that seat", () => {
    // A document sharing no result with the partner sends nothing whatever it
    // declares, so its own send cannot decide whether the PARTNER's half is
    // withheld -- the acceptance reading refuses that document instead, which
    // is the case this seat does not share.
    const declaringASend = acceptorIsTheHelper({
      linkageStrategy: "single-pass",
      payload: { send: [{ name: "risk_score" }], receive: [] },
    });
    expect(withholdsPartnerAssociationTable(declaringASend)).toBe(true);
    expect(withholdsAcceptorAssociationTable(declaringASend)).toBe(false);
  });
});
