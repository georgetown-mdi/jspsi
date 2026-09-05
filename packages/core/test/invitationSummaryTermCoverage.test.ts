import { describe, expect, test } from "vitest";

import { consentRepresentationProbes } from "../src/consent/linkageTermConsentCoverage.js";
import { summarizeInvitation } from "../src/consent/invitationSummary.js";

import type { LinkageTerms } from "../src/config/linkageTerms.js";

/**
 * The consent summary built from a set of linkage terms, as a comparable string.
 *
 * The token fields around the terms are held constant so only the terms move. In
 * particular `disclosedPayloadColumns` is left absent: it is a token field the
 * inviter derives from its own metadata rather than a linkage term, and
 * supplying one would answer the question about it instead of about the authored
 * `payload.send` the terms declare.
 */
function renderSummary(linkageTerms: LinkageTerms): string {
  return JSON.stringify(summarizeInvitation({ linkageTerms }));
}

describe("the consent summary's coverage of the linkage terms", () => {
  test("represents every consent-relevant term, bar the recorded gaps", () => {
    // Which terms an acceptor's consent turns on is judged once, in core's shared
    // classification, so this summary and the CLI accept prompt cannot drift on
    // the answer. A term is represented here when two sets of terms differing at
    // that term alone summarize differently; one the summary omits produces an
    // identical summary and has to be recorded as a gap in that same
    // classification.
    const probes = consentRepresentationProbes();
    expect(probes.length).toBeGreaterThan(0);
    expect(
      probes
        .filter(
          (probe) => renderSummary(probe.base) === renderSummary(probe.variant),
        )
        .map((probe) => probe.path)
        .sort(),
    ).toEqual(
      probes
        .filter((probe) => probe.unrepresented.web !== undefined)
        .map((probe) => probe.path)
        .sort(),
    );
  });
});
