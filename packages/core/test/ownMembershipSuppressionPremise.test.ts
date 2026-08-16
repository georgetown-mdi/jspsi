import { describe, expect, test } from "vitest";

import { resolveRole } from "../src/protocolSetup.js";

import type { Output } from "../src/config/linkageTerms.js";
import type { PsiRole } from "../src/types.js";

// Both acceptance surfaces withhold the `partnerLearnsOwnMembership` fact from a
// `psi-c` invitation on a fact of role resolution, not on a judgment about copy: on
// a one-sided exchange the party NOT entitled to the result is the sender, and the
// sender of a count-only round computes nothing from it and is sent no count-report
// frame (docs/spec/PROTOCOL.md, PSI-C), so it learns no membership for the surfaces
// to state. Were that branch of `resolveRole` to change -- a non-entitled party that
// can come out the receiver -- both surfaces would go on suppressing a warning about
// a disclosure that then happens, and every render test pinning the suppression
// would stay green. The premise is checked here so that change reds a test instead.

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
