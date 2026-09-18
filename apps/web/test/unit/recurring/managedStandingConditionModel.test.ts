import { describe, expect, test } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@psilink/core";

import {
  MANAGED_EXCHANGE_SCHEMA_VERSION,
  NO_STANDING_CONDITION,
  composeManagedExchangeFile,
} from "@psi/managed/managedExchangeRecord";
import {
  STANDING_CONDITION_CLEAR_LABEL,
  managedStandingConditionView,
} from "@recurring/managedStandingConditionModel";
import {
  composeManagedFailureConfirmation,
  routeConfirmationReply,
} from "@psi/managed/managedFailureConfirmation";

import type { ManagedExchangeRecord } from "@psi/managed/managedExchangeRecord";
import type { ManagedLocalState } from "@psi/managed/managedLocalState";

// The standing condition's own surface, tested in Node: it renders off the
// condition rather than off the last run, so a record whose last run was a no-show
// or a success still states what nobody has answered -- and which clearance
// applies, since the tiers the record already explains get no attack checklist.

const RAISED_AT = "2026-07-10T09:00:00.000Z";
const LATER_AT = "2026-07-12T09:00:00.000Z";

function record(
  overrides: Partial<ManagedExchangeRecord> = {},
): ManagedExchangeRecord {
  return {
    schemaVersion: MANAGED_EXCHANGE_SCHEMA_VERSION,
    id: "abc",
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: { channel: "webrtc", host: "signaling.example.org" },
      linkageTerms: getDefaultLinkageTerms("County Health Dept"),
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
    standingCondition: NO_STANDING_CONDITION,
    ...overrides,
  };
}

describe("managedStandingConditionView", () => {
  test("a record holding no condition renders nothing", () => {
    expect(
      managedStandingConditionView(
        record({ lastRun: { at: LATER_AT, outcome: "missed" } }),
        undefined,
      ),
    ).toBeUndefined();
  });

  test("an unexplained handshake failure routes clearance through the gate", () => {
    const view = managedStandingConditionView(
      record({
        lastRun: { at: LATER_AT, outcome: "missed" },
        standingCondition: { since: RAISED_AT, kind: "auth" },
      }),
      undefined,
    );
    expect(view?.clearance).toBe("confirmation");
    expect(view?.message).toMatch(/could not verify your partner/);
    // It states that the runs after it settle nothing, so the operator does not
    // read a green run as the all-clear.
    expect(view?.message).toMatch(/do not settle it/);
  });

  test("a persist failure gets the re-invite recovery and no attack checklist", () => {
    const view = managedStandingConditionView(
      record({
        lastRun: { at: LATER_AT, outcome: "succeeded" },
        standingCondition: { since: RAISED_AT, kind: "storage" },
      }),
      undefined,
    );
    expect(view?.clearance).toBe("acknowledge");
    expect(view?.message).toMatch(/Re-invite your partner to reconnect/);
  });

  test("a restore since the last success explains a standing handshake failure", () => {
    const restored: ManagedLocalState = {
      imported: { importedAt: "2026-07-09T00:00:00.000Z" },
    };
    const view = managedStandingConditionView(
      record({
        lastRun: { at: LATER_AT, outcome: "missed" },
        standingCondition: { since: RAISED_AT, kind: "auth" },
      }),
      restored,
    );
    expect(view?.clearance).toBe("acknowledge");
    expect(view?.title).toBe(
      "This exchange was restored from a backup or key file, or taken " +
        "back from the command line",
    );
  });

  test("the copy names the condition's instant, not the last run's", () => {
    const view = managedStandingConditionView(
      record({
        lastRun: { at: LATER_AT, outcome: "missed" },
        standingCondition: { since: RAISED_AT, kind: "auth" },
      }),
      undefined,
    );
    const raisedYear = new Date(RAISED_AT).getFullYear().toString();
    expect(view?.message).toContain(raisedYear);
    // The no-show instant falls on a different day, and the copy names one run.
    expect(view?.message.match(/A run on /g)).toHaveLength(1);
  });

  test("the acknowledge control's label is short and states what the click does", () => {
    expect(STANDING_CONDITION_CLEAR_LABEL).toBe("Clear this");
  });
});

describe("the gate the confirmation clearance presents", () => {
  test("a confirmed partner-side failure clears, and anything else does not", () => {
    // The clearance reuses the documented two-outcome gate rather than a second
    // one of its own, so the two surfaces route a reply identically.
    expect(routeConfirmationReply("confirmed-partner-failure")).toBe(
      "reinvite",
    );
    expect(routeConfirmationReply("does-not-add-up")).toBe(
      "compromise-response",
    );
  });

  test("the forwardable message asks about the run that raised the condition", () => {
    const withCondition = record({
      lastRun: { at: LATER_AT, outcome: "missed" },
      standingCondition: { since: RAISED_AT, kind: "auth" },
    });
    const raised = record({
      lastRun: { at: RAISED_AT, outcome: "failed", failureKind: "auth" },
    });
    expect(composeManagedFailureConfirmation(withCondition).message).toBe(
      composeManagedFailureConfirmation(raised).message,
    );
  });

  test("its confirming label states the attestation, not that a reply arrived", () => {
    // The click this label sits on clears the condition and puts a fresh secret on
    // the out-of-band channel, so the label has to name what the operator is
    // attesting to: a real failure on the partner's own side.
    const confirmation = composeManagedFailureConfirmation(record());
    expect(confirmation.confirmedOption).toBe(
      "Partner confirmed their own failure",
    );
    expect(confirmation.doesNotAddUpOption).toBe("Something does not add up");
  });
});
