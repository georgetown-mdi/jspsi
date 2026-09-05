import { describe, expect, test } from "vitest";

import { APPLIED_SETTINGS } from "../src/appliedSettings.js";
import {
  CONSENT_FACTS,
  COUNT_ONLY_DISCLOSURE_STATEMENT,
  PROPOSED_NOT_APPLIED_NOTES,
} from "../src/consentFacts.js";
import { parseLinkageTerms } from "../src/config/linkageTerms.js";
import {
  COUNT_ONLY_PROBE_TERMS,
  consentRepresentationProbes,
} from "../src/linkageTermConsentCoverage.js";
import { summarizeInvitation } from "../src/invitationSummary.js";

import type {
  ConsentFact,
  ConsentFactBasis,
  ConsentFactId,
} from "../src/consentFacts.js";

/**
 * The basis each count-only fact has, checked against the per-party
 * learn-basis rows of docs/spec/PROTOCOL.md's PSI-C section rather than
 * against what the table happens to say. Stated as a literal expectation
 * so a row reclassified in the table alone -- an enforced marker put on a
 * half that rests on the partner -- fails here rather than reaching an
 * acceptor.
 */
const SPEC_ASSIGNED_BASIS: Partial<Record<ConsentFactId, ConsentFactBasis>> = {
  // "A party's own count-only outcome is enforced", and "a party's view of what
  // its PARTNER receives is enforced at the wire": neither asks for the partner's
  // cooperation or its honesty.
  countOnlyResult: "enforced",
  // "What the rounds still disclose": the record count on the terms exchange and
  // the element count on the frame are disclosed however either party behaves.
  countOnlyRoundDisclosures: "enforced",
  // "The sender's knowledge of the count is trust-contingent": in the
  // both-entitled case the number it holds is the receiver's report.
  countOnlyReportedCount: "trust-contingent",
  // The threat-model scope: the claim protects a party against a partner that
  // contributes a genuine dataset, and a crafted or differenced input set is
  // accepted rather than prevented.
  countOnlyInputChoice: "trust-contingent",
  // The refusals: payload in either direction is refused at authoring, at prepare,
  // and at the agreed-terms run boundary, fail-closed at all three.
  countOnlyNoPayload: "enforced",
};

describe("the count-only consent tier", () => {
  test("carries the basis the protocol assigns each half of the claim", () => {
    for (const [id, basis] of Object.entries(SPEC_ASSIGNED_BASIS)) {
      const fact: ConsentFact = CONSENT_FACTS[id as ConsentFactId];
      expect(fact, `${id} is not a classified consent fact`).toBeDefined();
      expect(fact.basis, `${id} carries the wrong basis`).toBe(basis);
    }
  });

  test("states every sentence a surface renders, so no surface composes one", () => {
    // A tier entry with no caveat sentence leaves the surface that needs
    // one to author it, which is the drift the shared table exists to
    // make unrepresentable. Every count-only fact is rendered as a
    // sentence, so every one of them has it here.
    for (const id of Object.keys(SPEC_ASSIGNED_BASIS)) {
      const fact: ConsentFact = CONSENT_FACTS[id as ConsentFactId];
      expect(fact.note, `${id} carries no rendered sentence`).toBeTruthy();
    }
    expect(COUNT_ONLY_DISCLOSURE_STATEMENT.length).toBeGreaterThan(0);
  });

  test("carries no proposed-but-not-applied caveat, since the exchange conducts the run", () => {
    // The count-only tier is reached from the algorithm alone: what a surface
    // renders for a psi-c invitation is the tier, never a caveat qualifying it away.
    // A caveat keyed to the algorithm would be the drift this pins -- it would state
    // a refusal the exchange no longer performs, over sentences that are true.
    expect(PROPOSED_NOT_APPLIED_NOTES).not.toHaveProperty("psiC");
    expect(Object.keys(APPLIED_SETTINGS)).not.toContain("psiC");
    expect(
      summarizeInvitation({ linkageTerms: COUNT_ONLY_PROBE_TERMS }).algorithm,
    ).toBe("psi-c");
  });

  test("is measured by the consent-coverage probe on terms a count-only run accepts", () => {
    // The algorithm probe's psi-c side is the shape psi-c admits -- one linkage
    // key, cascade, no deduplication, and no payload in either direction -- so
    // what the coverage check measures each surface on is the count-only tier and
    // not a document the algorithm refuses.
    expect(COUNT_ONLY_PROBE_TERMS.algorithm).toBe("psi-c");
    expect(COUNT_ONLY_PROBE_TERMS.linkageKeys).toHaveLength(1);
    expect(COUNT_ONLY_PROBE_TERMS.linkageStrategy).toBe("cascade");
    expect(COUNT_ONLY_PROBE_TERMS.deduplicate).toBe(false);
    expect(COUNT_ONLY_PROBE_TERMS.payload?.send).toEqual([]);
    expect(COUNT_ONLY_PROBE_TERMS.payload?.receive).toEqual([]);

    const algorithmProbe = consentRepresentationProbes().find(
      (probe) => probe.path === "algorithm",
    );
    expect(algorithmProbe).toBeDefined();
    expect(algorithmProbe?.variant).toEqual(
      parseLinkageTerms(COUNT_ONLY_PROBE_TERMS),
    );
  });
});
