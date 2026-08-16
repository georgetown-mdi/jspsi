import { expect, test, vi } from "vitest";

import { CONSENT_FACTS, getLogger } from "@psilink/core";
import {
  CONSENT_PROBE_TERMS,
  COUNT_ONLY_PROBE_TERMS,
} from "@psilink/core/testing";

import type * as PsilinkCore from "@psilink/core";
import type { InvitationToken, LinkageTerms } from "@psilink/core";

// The accept prompt renders the count-only tier behind the summary's
// `psiCApplied`, which `APPLIED_SETTINGS.psiC` holds false until the count-only
// run path lands -- so a live count-only rendering is unreachable from the terms
// alone. The flag is moved where the renderer reads it, by wrapping the summarizer
// it renders from: core's own binding is internal to the built bundle this app
// consumes, so overriding an export would not reach the read. The mock is
// file-scoped, which is why this rendering lives in its own file and the refused
// invitation's stays on the unmocked path in accept.test.ts.
//
// What that leaves this file measuring is the state after the ungate: the one
// moment there IS a count-only run for the honest-helper membership claim to be
// wrong about, and the moment the refusal caveat that blunts it today is gone.
vi.mock("@psilink/core", async (importOriginal) => {
  const actual = await importOriginal<typeof PsilinkCore>();
  return {
    ...actual,
    summarizeInvitation: (
      params: Parameters<typeof actual.summarizeInvitation>[0],
    ) => ({ ...actual.summarizeInvitation(params), psiCApplied: true }),
  };
});

import { displayInvitation } from "../../src/invitationDisplay";

const MEMBERSHIP_LABEL = "what your partner learns either way";

/**
 * The output pair that puts the inviting party in the non-receiving seat: the
 * acceptor receives, its partner does not. It is the only shape either surface
 * states the honest-helper membership fact for.
 */
const PARTNER_WITHHELD: LinkageTerms["output"] = {
  expectsOutput: false,
  shareWithPartner: true,
};

function render(linkageTerms: LinkageTerms): string {
  const log = getLogger("accept-count-only-membership-test");
  log.setLevel("silent");
  const lines: Array<string> = [];
  const token: InvitationToken = {
    version: "1",
    linkageTerms,
    sharedSecret: "probe-shared-secret",
  };
  displayInvitation({
    token,
    ownOutboundSend: [],
    emit: (line) => {
      lines.push(line);
    },
    promptFollows: true,
  });
  return lines.join("\n");
}

test("a live count-only exchange does not tell the acceptor its partner learns its own records' membership", () => {
  // The claim is false for a count-only run: by the role rule the entitled party
  // IS the receiver, so a non-receiving partner is the SENDER, which computes
  // nothing from the round and is sent no count-report frame
  // (docs/spec/PROTOCOL.md, PSI-C). Read with the flag forced on, so what is
  // measured is the state the ungate produces rather than the refusal caveat
  // standing in front of it.
  const countOnly = render({
    ...COUNT_ONLY_PROBE_TERMS,
    output: PARTNER_WITHHELD,
  });
  expect(countOnly).toContain("  PSI algorithm (enforced): psi-c");
  expect(countOnly).not.toContain("does not yet apply it");
  expect(countOnly).not.toContain(MEMBERSHIP_LABEL);
  expect(countOnly).not.toContain(
    CONSENT_FACTS.partnerLearnsOwnMembership.note,
  );
  // Not the whole block going missing: the partner's non-receipt is still stated,
  // on its own register, which is the line the membership fact sits beneath.
  expect(countOnly).toContain(
    "  the inviting party will receive the result (your partner's word): no",
  );
  // What replaces it, from docs/spec/PROTOCOL.md's PSI-C learn-basis rows rather
  // than from a softened version of the claim: the enforced half that hands
  // neither party a pairing, and what the rounds disclose beside the count.
  expect(countOnly).toContain(`    ${CONSENT_FACTS.countOnlyResult.note}`);
  expect(countOnly).toContain(
    `    ${CONSENT_FACTS.countOnlyRoundDisclosures.note}`,
  );
});

test("the same one-sided invitation under psi still carries the membership fact", () => {
  // Non-vacuous the other way, and read through the same forced flag: the absence
  // above is the algorithm's doing, not the mock's or the output pair's. `psi` is
  // the algorithm the fact is true of, so it is stated in full.
  const revealing = render({
    ...CONSENT_PROBE_TERMS,
    output: PARTNER_WITHHELD,
    payload: { ...CONSENT_PROBE_TERMS.payload, receive: [] },
  });
  expect(revealing).toContain(`  ${MEMBERSHIP_LABEL} (enforced):`);
  expect(revealing).toContain(
    `    ${CONSENT_FACTS.partnerLearnsOwnMembership.note}`,
  );
});
