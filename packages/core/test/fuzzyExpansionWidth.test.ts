import { expect, test, describe, vi } from "vitest";

// The width a fuzzy key declares is gated on APPLIED_SETTINGS.fuzzyComparisons,
// false in the shipped build because the expansion it sizes builds nothing there
// (fuzzyComparisons.test.ts pins that inert case). This file drives the flag on,
// so the advertisement, its admissibility on the partner's side, and the role it
// is sized for are verified rather than only reachable in review.
vi.mock("../src/appliedSettings", () => ({
  APPLIED_SETTINGS: { deduplicate: true, fuzzyComparisons: true },
}));

import {
  exchangeTerms,
  resolveRole,
  PROTOCOL_VERSION,
} from "../src/protocolSetup";
import {
  declaredEffectiveKeyCount,
  MAX_KEY_CANDIDATES_PER_ROW,
} from "../src/fanOutFunctions";
import { createMessagePipe } from "../src/connection/messageConnection";
import type {
  GenerateFuzzyComparisons,
  LinkageTerms,
  Output,
} from "../src/config/linkageTerms";

const FUZZY_KINDS: readonly GenerateFuzzyComparisons[] = [
  "transpositions",
  "edit_distances",
  "adjacent_years",
];

const BOTH_OUTPUT: Output = { expectsOutput: true, shareWithPartner: true };

const fanOutStep = { function: "split_on", params: { delimiter: "/" } };

// Two keys: the first declares the expansion under test, the second declares
// nothing, so a factor that landed on the wrong key is visible in the sum.
function termsWithFuzzyKey(kind: GenerateFuzzyComparisons): LinkageTerms {
  return {
    version: "1.0.0",
    identity: "Party",
    date: "2026-01-01",
    algorithm: "psi",
    linkageStrategy: "single-pass",
    output: BOTH_OUTPUT,
    deduplicate: false,
    linkageFields: [
      { name: "last_name", type: "last_name" },
      { name: "ssn", type: "ssn" },
    ],
    linkageKeys: [
      {
        name: "LN",
        elements: [{ field: "last_name", generateFuzzyComparisons: kind }],
      },
      { name: "SSN", elements: [{ field: "ssn" }] },
    ],
  };
}

const FUZZY_TERMS = termsWithFuzzyKey("transpositions");
const FUZZY_WIDTH = MAX_KEY_CANDIDATES_PER_ROW + 1;

describe("the width a fuzzy key declares", () => {
  test("every kind declares the per-record candidate cap", () => {
    // Including a kind only one party expands: the advertisement rides message 1
    // of the terms exchange, before the initiator holds the partner's record
    // count, so no party knows its role when this number is fixed and each
    // declares the receiver-case ceiling.
    for (const kind of FUZZY_KINDS)
      expect(declaredEffectiveKeyCount(termsWithFuzzyKey(kind))).toBe(
        FUZZY_WIDTH,
      );
  });

  test("a key both producers widen declares that cap once", () => {
    // The cap is what one record may contribute to one key, however many
    // producers built the set, so the two factors do not compound.
    const terms = termsWithFuzzyKey("transpositions");
    terms.linkageKeys[0].elements[0].transform = [fanOutStep];
    expect(declaredEffectiveKeyCount(terms)).toBe(FUZZY_WIDTH);
  });

  test("the declared width sits inside the admissible grammar", () => {
    // The two shape rules a partner holds the advertisement to
    // (assertPartnerEffectiveKeyCount): inside the range a sum of per-key factors
    // can occupy, and a whole number of widened keys past the plain count.
    const keyCount = FUZZY_TERMS.linkageKeys.length;
    const advertised = declaredEffectiveKeyCount(FUZZY_TERMS);
    expect(advertised).toBeGreaterThanOrEqual(keyCount);
    expect(advertised).toBeLessThanOrEqual(
      keyCount * MAX_KEY_CANDIDATES_PER_ROW,
    );
    expect((advertised - keyCount) % (MAX_KEY_CANDIDATES_PER_ROW - 1)).toBe(0);
  });
});

describe("the partner's advertisement for a fuzzy key", () => {
  // Whichever party resolves to the receiver, both advertise the same width from
  // the same agreed terms, so each validates against a floor equal to what the
  // other sent: the exchange proceeds and neither party is warned about a width
  // above the agreed terms.
  async function exchange(
    initiatorRecords: number,
    responderRecords: number,
  ): Promise<{ initiator: number; responder: number; warnings: string[] }> {
    const [connA, connB] = createMessagePipe();
    const [a, b] = await Promise.all([
      exchangeTerms(connA, "initiator", FUZZY_TERMS, initiatorRecords),
      exchangeTerms(
        connB,
        "responder",
        { ...FUZZY_TERMS, identity: "Partner" },
        responderRecords,
      ),
    ]);
    return {
      initiator: a.partnerEffectiveKeyCount,
      responder: b.partnerEffectiveKeyCount,
      warnings: [...a.warnings, ...b.warnings],
    };
  }

  test("validates with the initiator as the resolved receiver", async () => {
    expect(resolveRole("initiator", BOTH_OUTPUT, BOTH_OUTPUT, 10, 50)).toBe(
      "receiver",
    );
    const { initiator, responder, warnings } = await exchange(10, 50);
    expect(initiator).toBe(FUZZY_WIDTH);
    expect(responder).toBe(FUZZY_WIDTH);
    expect(warnings).toHaveLength(0);
  });

  test("validates with the responder as the resolved receiver", async () => {
    expect(resolveRole("responder", BOTH_OUTPUT, BOTH_OUTPUT, 10, 50)).toBe(
      "receiver",
    );
    const { initiator, responder, warnings } = await exchange(50, 10);
    expect(initiator).toBe(FUZZY_WIDTH);
    expect(responder).toBe(FUZZY_WIDTH);
    expect(warnings).toHaveLength(0);
  });
});

describe("the role the expanding side is selected from", () => {
  test("equal record counts resolve complementary roles", () => {
    // The tie-break is deterministic and the two parties read it from opposite
    // sides, so exactly one of them expands a receiver-only kind.
    expect(resolveRole("initiator", BOTH_OUTPUT, BOTH_OUTPUT, 100, 100)).toBe(
      "receiver",
    );
    expect(resolveRole("responder", BOTH_OUTPUT, BOTH_OUTPUT, 100, 100)).toBe(
      "sender",
    );
  });

  test("a one-sided-output exchange resolves without consulting the counts", () => {
    const entitled: Output = { expectsOutput: true, shareWithPartner: false };
    const helper: Output = { expectsOutput: false, shareWithPartner: true };
    for (const [local, partner] of [
      [1, 1_000_000],
      [1_000_000, 1],
    ] as const) {
      expect(resolveRole("initiator", entitled, helper, local, partner)).toBe(
        "receiver",
      );
      expect(resolveRole("responder", helper, entitled, local, partner)).toBe(
        "sender",
      );
    }
  });
});

test("the terms exchange carries the fuzzy width on both messages", async () => {
  const [connA, connB] = createMessagePipe();
  const responder = exchangeTerms(connB, "responder", FUZZY_TERMS, 200);
  await connA.send({
    linkageTerms: FUZZY_TERMS,
    recordCount: 100,
    effectiveKeyCount: FUZZY_WIDTH,
    protocolVersion: PROTOCOL_VERSION,
  });
  const reply = (await connA.receive()) as { effectiveKeyCount: number };
  await connA.send({ decision: "proceed" });
  expect(reply.effectiveKeyCount).toBe(FUZZY_WIDTH);
  expect((await responder).partnerEffectiveKeyCount).toBe(FUZZY_WIDTH);
});
