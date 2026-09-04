import { describe, expect, test } from "vitest";

import { resolveRole } from "../src/protocolSetup.js";

import type { Output } from "../src/config/linkageTerms.js";
import type { PsiRole } from "../src/types.js";

// Both acceptance surfaces withhold `partnerLearnsOwnMembership` from a
// psi-c invitation on a fact of role resolution, not a copy judgment: on a
// one-sided exchange the non-entitled party is always the sender, and a
// count-only sender computes nothing and gets no count-report frame
// (docs/spec/PROTOCOL.md, PSI-C), so it has no membership to disclose. This
// test pins that role-resolution assumption directly, since the render
// tests that assert the suppression cannot see a regression in it.

/** The entitled side of a one-sided pair: the only party the run delivers to. */
const ENTITLED: Output = { expectsOutput: true, shareWithPartner: false };

/** Its partner, and the party the suppressed fact speaks about. */
const NOT_ENTITLED: Output = { expectsOutput: false, shareWithPartner: true };

function rolesFromBothSides(
  initiatorOutput: Output,
  responderOutput: Output,
  initiatorRecordCount: number,
  responderRecordCount: number,
): { initiator: PsiRole; responder: PsiRole } {
  return {
    initiator: resolveRole(
      "initiator",
      initiatorOutput,
      responderOutput,
      initiatorRecordCount,
      responderRecordCount,
    ),
    responder: resolveRole(
      "responder",
      responderOutput,
      initiatorOutput,
      responderRecordCount,
      initiatorRecordCount,
    ),
  };
}

describe("the role premise the consent surfaces' psi-c own-membership suppression rests on", () => {
  // Each shape gives the non-entitled party the smaller dataset, which is what the
  // work-minimizing branch makes the RECEIVER: an assignment that stopped taking
  // the one-sided branch would fail here rather than coincide with it.
  test("seats the non-entitled party as the sender when the initiator holds the entitlement", () => {
    const roles = rolesFromBothSides(ENTITLED, NOT_ENTITLED, 5000, 1);
    expect(roles.responder).toBe("sender");
    expect(roles.initiator).toBe("receiver");
  });

  test("seats the non-entitled party as the sender when the responder holds the entitlement", () => {
    const roles = rolesFromBothSides(NOT_ENTITLED, ENTITLED, 1, 5000);
    expect(roles.initiator).toBe("sender");
    expect(roles.responder).toBe("receiver");
  });
});
