import { describe, expect, test } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@psilink/core";

import {
  MANAGED_RUN_HANDED_OFF_ATTESTATION,
  MANAGED_RUN_NON_DISCLOSURE_ATTESTATION,
  classifyManagedRunFailure,
  managedRunTierFailure,
} from "@recurring/managedRunLaunchModel";

import {
  MANAGED_EXCHANGE_SCHEMA_VERSION,
  composeManagedExchangeFile,
} from "@psi/managed/managedExchangeRecord";
import { deriveManagedFailureTier } from "@psi/managed/managedFailureTiers";

import type { ManagedExchangeRecord } from "@psi/managed/managedExchangeRecord";
import type { ManagedFailureTier } from "@psi/managed/managedFailureTiers";
import type { ManagedLocalState } from "@psi/managed/managedLocalState";

// Binds the non-disclosure gate to the copy it gates: a tier whose copy tells the
// operator this run stopped before reading the input file and before connecting
// must give way to the generic tier once the data exchange has started, and a
// tier stating nothing about it must keep its own reading and recovery.
//
// The limit: the scan knows the phrasings today's copy uses and nothing more, so
// a future tier attesting in new words passes it. What catches that tier is the
// table the scan checks -- MANAGED_RUN_NON_DISCLOSURE_ATTESTATION is a Record
// over the tier union, so a new tier does not typecheck until it is classified
// by hand, and the scan then holds that classification to the words it knows.

const NOW = Date.parse("2026-07-14T12:00:00.000Z");

/** Every tier, taken from the classification table so the sweep cannot fall
 * behind the union: the table is exhaustive over it by its own type. */
const TIERS = Object.keys(
  MANAGED_RUN_NON_DISCLOSURE_ATTESTATION,
) as Array<ManagedFailureTier>;

/** The phrasings today's copy uses to attest what this run disclosed. Matched
 * against a tier's whole rendered copy, so a phrase must be specific enough not
 * to fire on a tier that only mentions the device -- the unexplained tier's
 * "nothing on this device explains why" is not an attestation. */
const NON_DISCLOSURE_PHRASES: ReadonlyArray<RegExp> = [
  /nothing left this device/i,
  /nothing was exchanged/i,
  /partner was not contacted/i,
  /stopped before (reading|connecting)/i,
];

function attestsNonDisclosure(copy: string): boolean {
  return NON_DISCLOSURE_PHRASES.some((phrase) => phrase.test(copy));
}

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
    ...overrides,
  };
}

function failed(
  failureKind: NonNullable<ManagedExchangeRecord["lastRun"]>["failureKind"],
): NonNullable<ManagedExchangeRecord["lastRun"]> {
  return { at: "2026-07-14T09:00:00.000Z", outcome: "failed", failureKind };
}

const RESTORED: ManagedLocalState = {
  imported: { importedAt: "2026-07-13T00:00:00.000Z" },
};

/** A record and its sibling state that derive to each tier, exhaustive over the
 * union so a new tier is driven through the gate rather than skipped. */
const TIER_EVIDENCE: Record<
  ManagedFailureTier,
  [ManagedExchangeRecord, ManagedLocalState | undefined]
> = {
  expired: [record({ expires: "2026-07-01T00:00:00.000Z" }), undefined],
  input: [record({ lastRun: failed("input") }), undefined],
  "terms-shortfall": [
    record({ lastRun: failed("terms-shortfall") }),
    undefined,
  ],
  consent: [record({ lastRun: failed("consent") }), undefined],
  "handed-off": [record({ lastRun: failed("handed-off") }), undefined],
  "custody-unreadable": [
    record({ lastRun: failed("custody-unreadable") }),
    undefined,
  ],
  missed: [
    record({ lastRun: { at: "2026-07-14T09:00:00.000Z", outcome: "missed" } }),
    undefined,
  ],
  storage: [record({ lastRun: failed("storage") }), undefined],
  imported: [record({ lastRun: failed("auth") }), RESTORED],
  transport: [record({ lastRun: failed("transport") }), undefined],
  unexplained: [record({ lastRun: failed("auth") }), undefined],
  none: [record(), undefined],
};

/** What an operator reads for a tier, split by where they read it: an alert
 * state's title and message, or -- for the hand-off state, which has no alert
 * copy -- the line the stored spent state adds for a run the hand-off refused.
 * Resolved from the classified state's own shape, never from the table under
 * test, so a mis-declared site cannot steer the scan to the copy that would
 * agree with it. */
function copyForTier(tier: ManagedFailureTier): {
  alertCopy: string;
  spentState: string;
} {
  const failure = managedRunTierFailure(
    tier,
    record({ expires: "2026-07-01T00:00:00.000Z" }),
  );
  return failure.kind === "handed-off"
    ? { alertCopy: "", spentState: MANAGED_RUN_HANDED_OFF_ATTESTATION }
    : {
        alertCopy: `${failure.title} ${failure.message}`,
        spentState: "",
      };
}

/** Classify one tier's evidence at a phase boundary, with a live error that
 * has no benign reading of its own, so the record's tier is what decides. */
function classifyAt(
  tier: ManagedFailureTier,
  dataExchangeStarted: boolean,
): string {
  const [stamped, local] = TIER_EVIDENCE[tier];
  return classifyManagedRunFailure(
    new Error("data channel dropped"),
    { atLaunch: stamped, afterRun: stamped },
    local,
    NOW,
    dataExchangeStarted,
  ).kind;
}

describe("the non-disclosure gate is bound to the copy it gates", () => {
  test("each tier's declared attestation site is where its copy attests", () => {
    for (const tier of TIERS) {
      const { alertCopy, spentState } = copyForTier(tier);
      const site = attestsNonDisclosure(alertCopy)
        ? "alert-copy"
        : attestsNonDisclosure(spentState)
          ? "spent-state"
          : "none";
      expect(MANAGED_RUN_NON_DISCLOSURE_ATTESTATION[tier], tier).toBe(site);
    }
  });

  test("a tier gives way past the data-exchange boundary exactly when it attests", () => {
    for (const tier of TIERS) {
      const { alertCopy, spentState } = copyForTier(tier);
      const attests =
        attestsNonDisclosure(alertCopy) || attestsNonDisclosure(spentState);
      const before = classifyAt(tier, false);
      const past = classifyAt(tier, true);
      // Gated means the boundary replaced the tier with the generic transport
      // reading; the tiers that render that copy already are unchanged by it.
      expect(past !== before && past === "transport", tier).toBe(attests);
    }
  });

  test("each tier's evidence derives to that tier", () => {
    // The fixtures above are only as good as the tiers they reach: a fixture that
    // stopped deriving to its tier would drive the two sweeps through some other
    // tier's copy and gate, and both would still pass.
    for (const tier of TIERS) {
      const [stamped, local] = TIER_EVIDENCE[tier];
      expect(deriveManagedFailureTier(stamped, local, NOW), tier).toBe(tier);
    }
  });
});
