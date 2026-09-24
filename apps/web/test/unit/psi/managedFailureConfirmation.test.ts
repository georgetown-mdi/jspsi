import { describe, expect, test } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@alcove/core";

import {
  MANAGED_EXCHANGE_SCHEMA_VERSION,
  NO_STANDING_CONDITION,
  composeManagedExchangeFile,
} from "@psi/managed/managedExchangeRecord";
import {
  composeConfirmationMessage,
  composeManagedFailureConfirmation,
  routeConfirmationReply,
} from "@psi/managed/managedFailureConfirmation";

import { dateTimeLabel } from "@psi/formatting";

import type { ManagedExchangeRecord } from "@psi/managed/managedExchangeRecord";

// The Tier-2 out-of-band confirmation, tested in Node: the forwardable message includes
// the doc's three asks and interpolates only this record's OWN local fields, and the
// two-outcome gate routes a confirmed partner-side failure to re-invite and anything
// else to the compromise response.

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
    lastRun: {
      at: "2026-07-14T09:00:00.000Z",
      outcome: "failed",
      failureKind: "auth",
    },
    standingCondition: NO_STANDING_CONDITION,
    ...overrides,
  };
}

describe("composeConfirmationMessage", () => {
  const message = composeConfirmationMessage(record());

  test("asks the partner to confirm identity on the out-of-band channel, not just reply", () => {
    expect(message).toMatch(/really you/i);
    expect(message).toMatch(/not just\s+reply/i);
  });

  test("asks what the partner's own tool reported and when", () => {
    expect(message).toMatch(/your own Alcove reported/i);
    expect(message).toMatch(/real\s+failure happened on your side/i);
  });

  test("asks whether they ran from more than one place", () => {
    expect(message).toMatch(/more than one place/i);
    expect(message).toMatch(
      /second\s+browser or profile|another device|restored backup/i,
    );
  });

  test("interpolates only this record's own local fields (the label and time)", () => {
    expect(message).toMatch(/Riverbend quarterly/);
    // The failure time is named (the exact rendering is locale/timezone formatting).
    expect(message).toMatch(/2026/);
  });

  test("names no benign cause and does not lead with 'you also saw a failure'", () => {
    // The message must not pre-suggest the benign reading the impersonator wants.
    expect(message).not.toMatch(/desync|rotation|out of sync/i);
    expect(message).not.toMatch(/you also saw|did you also/i);
  });

  test("an unlabeled exchange falls back to a neutral partnership phrase", () => {
    const unlabeled = composeConfirmationMessage(record({ label: "" }));
    expect(unlabeled).toMatch(/our recurring data exchange/);
    // No stray empty quotes from an empty label.
    expect(unlabeled).not.toMatch(/""/);
  });
});

// Which instants the message names. A standing condition is raised first-raise-wins,
// so its `since` stays at the occasion that raised it while `lastRun` moves on: the
// message has to name the failure the operator just watched as well as the first one,
// or the partner checks their logs for the wrong occasion.
describe("the instants composeConfirmationMessage names", () => {
  const firstAt = "2026-07-14T09:00:00.000Z";
  const laterAt = "2026-07-20T09:00:00.000Z";

  function labelOf(at: string): string {
    return dateTimeLabel(new Date(at));
  }

  test("names the standing condition's instant alone where the last run is the one that raised it", () => {
    const message = composeConfirmationMessage(
      record({
        lastRun: { at: firstAt, outcome: "failed", failureKind: "auth" },
        standingCondition: { since: firstAt, kind: "auth" },
      }),
    );

    expect(message).toContain(`on ${labelOf(firstAt)}.`);
    expect(message).not.toMatch(/and again on/);
  });

  test("names both instants where a later run failed the same way", () => {
    const message = composeConfirmationMessage(
      record({
        lastRun: { at: laterAt, outcome: "failed", failureKind: "auth" },
        standingCondition: { since: firstAt, kind: "auth" },
      }),
    );

    expect(message).toContain(
      `on ${labelOf(firstAt)}, and again on ${labelOf(laterAt)}.`,
    );
  });

  test("names the standing instant alone where the later run failed another way", () => {
    const message = composeConfirmationMessage(
      record({
        lastRun: { at: laterAt, outcome: "failed", failureKind: "storage" },
        standingCondition: { since: firstAt, kind: "auth" },
      }),
    );

    expect(message).toContain(`on ${labelOf(firstAt)}.`);
    expect(message).not.toContain(labelOf(laterAt));
  });

  test("names the standing instant alone where the later run was a no-show", () => {
    const message = composeConfirmationMessage(
      record({
        lastRun: { at: laterAt, outcome: "missed" },
        standingCondition: { since: firstAt, kind: "auth" },
      }),
    );

    expect(message).toContain(`on ${labelOf(firstAt)}.`);
    expect(message).not.toContain(labelOf(laterAt));
  });

  test("names the last run's instant where no condition stands", () => {
    const message = composeConfirmationMessage(
      record({
        lastRun: { at: laterAt, outcome: "failed", failureKind: "auth" },
      }),
    );

    expect(message).toContain(`on ${labelOf(laterAt)}.`);
    expect(message).not.toMatch(/and again on/);
  });

  test("names no instant for a record that has never run", () => {
    const never = record();
    delete never.lastRun;

    const message = composeConfirmationMessage(never);

    expect(message).toMatch(/failed to authenticate on my side\.$/m);
  });
});

describe("composeManagedFailureConfirmation", () => {
  test("has the message and the two labeled gate options", () => {
    const confirmation = composeManagedFailureConfirmation(record());
    expect(confirmation.message).toBe(composeConfirmationMessage(record()));
    expect(confirmation.confirmedOption).toMatch(/confirmed/i);
    expect(confirmation.doesNotAddUpOption).toMatch(/does not add up/i);
  });
});

describe("routeConfirmationReply: the two-outcome gate", () => {
  test("a confirmed real partner-side failure proceeds to re-invite", () => {
    expect(routeConfirmationReply("confirmed-partner-failure")).toBe(
      "reinvite",
    );
  });

  test("anything that does not add up routes to the compromise response", () => {
    expect(routeConfirmationReply("does-not-add-up")).toBe(
      "compromise-response",
    );
  });
});
