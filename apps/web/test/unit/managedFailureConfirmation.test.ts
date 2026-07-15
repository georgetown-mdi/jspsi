import { describe, expect, test } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@psilink/core";

import {
  MANAGED_EXCHANGE_SCHEMA_VERSION,
  composeManagedExchangeFile,
} from "@psi/managedExchangeRecord";
import {
  composeConfirmationMessage,
  composeManagedFailureConfirmation,
  routeConfirmationReply,
} from "@psi/managedFailureConfirmation";

import type { ManagedExchangeRecord } from "@psi/managedExchangeRecord";

// The Tier-2 out-of-band confirmation, tested in Node: the forwardable message carries
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
    expect(message).toMatch(/your own psilink reported/i);
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

describe("composeManagedFailureConfirmation", () => {
  test("carries the message and the two labeled gate options", () => {
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
