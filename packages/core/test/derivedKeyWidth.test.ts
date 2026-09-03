import { expect, test, describe, vi } from "vitest";

// The width a fuzzy element declares is gated on APPLIED_SETTINGS.fuzzyComparisons,
// false in the shipped build because the expansion it sizes builds nothing there
// (fuzzyComparisons.test.ts pins that inert case). This file drives the flag on,
// so the derivation, its ceiling, and the seam that enforces it are verified
// rather than only reachable in review.
vi.mock("../src/appliedSettings", () => ({
  APPLIED_SETTINGS: { deduplicate: true, fuzzyComparisons: true },
}));

import PSI from "@openmined/psi.js";

import {
  exchangeTerms,
  resolveRole,
  PROTOCOL_VERSION,
} from "../src/protocolSetup";
import {
  declaredEffectiveKeyCount,
  declaredKeyWidth,
  FAN_OUT_CANDIDATES_PER_ELEMENT,
  MAX_KEY_CANDIDATE_WIDTH,
} from "../src/fanOutFunctions";
import {
  expandFuzzyComparisons,
  fuzzyCandidateCeiling,
  MAX_FUZZY_EXPANSION_INPUT_LENGTH,
} from "../src/fuzzyComparisons";
import {
  buildKeyStrings,
  StandardizedDataset,
  StandardizedField,
} from "../src/standardization";
import { prepareForExchange, runExchange } from "../src/exchange";
import type { ResolvedRunShape } from "../src/pairTableProjection";
import { UsageError } from "../src/errors";
import { createMessagePipe } from "../src/connection/messageConnection";
import { recordingConnection } from "./utils/recordingConnection";
import type {
  GenerateFuzzyComparisons,
  LinkageKey,
  LinkageTerms,
  Output,
} from "../src/config/linkageTerms";
import type { Metadata } from "../src/config/metadata";
import type { CSVRow } from "../src/file";
import type { PsiRole } from "../src/types";

const psiLibrary = await PSI();

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

// The longest value each kind accepts, which is where its ceiling is set. A
// repeating value would collapse candidates into each other, so each character
// differs from its neighbours; the date is the one canonical shape
// `adjacent_years` reads, whose expansion does not grow with length.
function longestExpandableValue(kind: GenerateFuzzyComparisons): string {
  if (kind === "adjacent_years") return "19900115";
  return Array.from(
    { length: MAX_FUZZY_EXPANSION_INPUT_LENGTH },
    (_unused, i) => String.fromCodePoint(0x41 + (i % 26)),
  ).join("");
}

describe("the ceiling each fuzzy kind declares", () => {
  test.each(FUZZY_KINDS)(
    "%s never realizes more candidates than its ceiling",
    (kind) => {
      // The ceiling is the factor the key's declared width multiplies in, so an
      // expansion realizing more than it would have an honest row refused at the
      // width seam. Measured against the real expansion at the longest value it
      // accepts rather than restated as a number.
      const realized = expandFuzzyComparisons(
        longestExpandableValue(kind),
        kind,
      ).length;
      expect(realized).toBeLessThanOrEqual(fuzzyCandidateCeiling(kind));
    },
  );

  test("each ceiling is reached, so none of them over-declares", () => {
    // A ceiling above what the expansion can realize spends value slots that stay
    // empty, so each arm is pinned tight from below as well.
    for (const kind of FUZZY_KINDS) {
      const realized = expandFuzzyComparisons(
        longestExpandableValue(kind),
        kind,
      ).length;
      expect(realized).toBe(fuzzyCandidateCeiling(kind));
    }
  });
});

describe("the width a key declares", () => {
  test.each(FUZZY_KINDS)("%s raises only its own key's width", (kind) => {
    const terms = termsWithFuzzyKey(kind);
    expect(declaredKeyWidth(terms.linkageKeys[0])).toBe(
      fuzzyCandidateCeiling(kind),
    );
    expect(declaredKeyWidth(terms.linkageKeys[1])).toBe(1);
    expect(declaredEffectiveKeyCount(terms)).toBe(
      fuzzyCandidateCeiling(kind) + 1,
    );
  });

  test("a key both producers widen declares their product", () => {
    // buildKeyStrings crosses an element's fan-out candidates with its fuzzy
    // ones, so declaring the larger of the two factors would under-declare
    // against what the row builder assembles.
    const terms = termsWithFuzzyKey("adjacent_years");
    terms.linkageKeys[0].elements[0].transform = [fanOutStep];
    expect(declaredKeyWidth(terms.linkageKeys[0])).toBe(
      FAN_OUT_CANDIDATES_PER_ELEMENT * fuzzyCandidateCeiling("adjacent_years"),
    );
  });

  test("a key whose declared width exceeds the ceiling is refused", () => {
    // Two elements at the edit-distance ceiling compound past what one row can be
    // assembled for, so the terms are refused where the width is derived, before
    // any row is read.
    const terms = termsWithFuzzyKey("edit_distances");
    terms.linkageKeys[1] = {
      name: "LN2",
      elements: [
        { field: "last_name", generateFuzzyComparisons: "edit_distances" },
        { field: "ssn", generateFuzzyComparisons: "edit_distances" },
      ],
    };
    expect(fuzzyCandidateCeiling("edit_distances") ** 2).toBeGreaterThan(
      MAX_KEY_CANDIDATE_WIDTH,
    );
    expect(() => declaredKeyWidth(terms.linkageKeys[1], 1)).toThrow(UsageError);
    expect(() => declaredEffectiveKeyCount(terms)).toThrow(
      /linkageKeys\[1\] declares a width of more than the 1024/,
    );
  });

  test("the same ceiling refuses the row build at the width seam", () => {
    // The seam that refuses a fuzzy-widened row is the one that refuses an
    // over-ceiling key: both read the width the terms declare, so an operator
    // meets one message rather than a drop at one bound and a refusal at another.
    const key: LinkageKey = {
      name: "LN2",
      elements: [
        { field: "last_name", generateFuzzyComparisons: "edit_distances" },
        { field: "ssn", generateFuzzyComparisons: "edit_distances" },
      ],
    };
    const row = { last_name: "SMITH", ssn: "123456789" };
    const dataset = new StandardizedDataset([
      new StandardizedField("last_name", "last_name", [], [row]),
      new StandardizedField("ssn", "ssn", [], [row]),
    ]);
    expect(() => buildKeyStrings(key, dataset, 0, true)).toThrow(
      /declares a width of more than the 1024/,
    );
  });
});

describe("both parties derive the same width with no round-trip", () => {
  const FUZZY_TERMS = termsWithFuzzyKey("transpositions");

  test("neither terms frame carries a width, and each side derives the other's", async () => {
    const [connA, connB] = createMessagePipe();
    const { conn: recordingA, sent: initiatorSent } =
      recordingConnection(connA);
    const { conn: recordingB, sent: responderSent } =
      recordingConnection(connB);
    const [a, b] = await Promise.all([
      exchangeTerms(recordingA, "initiator", FUZZY_TERMS, 10),
      exchangeTerms(
        recordingB,
        "responder",
        { ...FUZZY_TERMS, identity: "Partner" },
        50,
      ),
    ]);

    // Nothing on the wire carries a width, in either direction.
    for (const frame of [...initiatorSent, ...responderSent])
      expect(frame).not.toHaveProperty("effectiveKeyCount");

    // Each party derives the partner's width from the terms it was handed, and
    // the two derivations agree with each party's reading of its own.
    const expected = fuzzyCandidateCeiling("transpositions") + 1;
    expect(declaredEffectiveKeyCount(a.partnerTerms)).toBe(expected);
    expect(declaredEffectiveKeyCount(b.partnerTerms)).toBe(expected);
    expect(declaredEffectiveKeyCount(FUZZY_TERMS)).toBe(expected);
    expect([...a.warnings, ...b.warnings]).toEqual([]);
  });

  test.each([
    ["initiator", 10, 50],
    ["responder", 50, 10],
  ] as const)(
    "the derivation is the same whichever party resolves to the receiver (%s)",
    async (receivingRole, initiatorRecords, responderRecords) => {
      // A receiver-only expansion runs on one party alone, but the width is fixed
      // before either party holds the other's record count, so both derive the
      // receiver-case ceiling and neither is sized for a role it does not hold.
      expect(
        resolveRole(
          receivingRole,
          BOTH_OUTPUT,
          BOTH_OUTPUT,
          receivingRole === "initiator" ? initiatorRecords : responderRecords,
          receivingRole === "initiator" ? responderRecords : initiatorRecords,
        ),
      ).toBe("receiver" satisfies PsiRole);
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
      const expected = fuzzyCandidateCeiling("transpositions") + 1;
      expect(declaredEffectiveKeyCount(a.partnerTerms)).toBe(expected);
      expect(declaredEffectiveKeyCount(b.partnerTerms)).toBe(expected);
    },
  );

  test("a frame carrying a width on top of the terms proceeds without reading it", async () => {
    const [connA, connB] = createMessagePipe();
    const responder = exchangeTerms(connB, "responder", FUZZY_TERMS, 200);
    await connA.send({
      linkageTerms: FUZZY_TERMS,
      recordCount: 100,
      effectiveKeyCount: 3,
      protocolVersion: PROTOCOL_VERSION,
    });
    await connA.receive();
    await connA.send({ decision: "proceed" });
    const result = await responder;
    expect(result.partnerRecordCount).toBe(100);
    // The stripped field decides nothing: the width is still the terms'.
    expect(declaredEffectiveKeyCount(result.partnerTerms)).toBe(
      fuzzyCandidateCeiling("transpositions") + 1,
    );
  });
});

describe("a party whose own cleaning fans out", () => {
  const plainTerms: LinkageTerms = {
    version: "1.0.0",
    identity: "Party",
    date: "2026-01-01",
    algorithm: "psi",
    linkageStrategy: "single-pass",
    output: BOTH_OUTPUT,
    deduplicate: false,
    linkageFields: [{ name: "last_name", type: "last_name" }],
    linkageKeys: [{ name: "LN", elements: [{ field: "last_name" }] }],
  };
  const metadata: Metadata = [
    {
      name: "last_name",
      type: "last_name",
      role: "linkage",
      isPayload: false,
    },
  ];
  const columns = ["last_name"];
  const splittingRows: Array<CSVRow> = [
    { last_name: "SMITH JONES" },
    { last_name: "BROWN" },
  ];
  const partnerRows: Array<CSVRow> = [
    { last_name: "JONES" },
    { last_name: "GREEN" },
    { last_name: "WHITE" },
  ];

  async function runPair(
    splitting: boolean,
  ): Promise<{ role: PsiRole; localRecordCount: number }> {
    const [connA, connB] = createMessagePipe();
    let confirmation: { role: PsiRole; localRecordCount: number } | undefined;
    await Promise.all([
      runExchange(
        connA,
        "initiator",
        prepareForExchange(
          {
            linkageTerms: { ...plainTerms, identity: "Splitting Co" },
            metadata,
            ...(splitting
              ? {
                  standardization: [
                    {
                      output: "last_name",
                      input: "last_name",
                      steps: [
                        { function: "split_on", params: { delimiter: " " } },
                      ],
                    },
                  ],
                }
              : {}),
          },
          "Splitting Co",
          splittingRows,
          columns,
        ),
        {
          psiLibrary,
          onProtocolConfirmed: (
            _terms: LinkageTerms,
            role: PsiRole,
            shape: ResolvedRunShape,
          ) => {
            confirmation = { role, localRecordCount: shape.localRecordCount };
          },
        },
      ),
      runExchange(
        connB,
        "responder",
        prepareForExchange(
          { linkageTerms: { ...plainTerms, identity: "Plain Co" }, metadata },
          "Plain Co",
          partnerRows,
          columns,
        ),
        { psiLibrary },
      ),
    ]);
    if (confirmation === undefined)
      throw new Error("the run confirmed no protocol shape");
    return confirmation;
  }

  test("declares the records its cleaning stands for, and role resolution reads them", async () => {
    // Two rows against the partner's three makes the splitting party the smaller
    // dataset -- the receiver -- until its own fan-out is counted, at which point
    // it is the larger and trends to sender. Nothing about the fan-out is on the
    // wire: the count is.
    const plain = await runPair(false);
    expect(plain.localRecordCount).toBe(splittingRows.length);
    expect(plain.role).toBe("receiver" satisfies PsiRole);

    const fanned = await runPair(true);
    expect(fanned.localRecordCount).toBe(
      splittingRows.length * FAN_OUT_CANDIDATES_PER_ELEMENT,
    );
    expect(fanned.role).toBe("sender" satisfies PsiRole);
  });
});

describe("a declared width off single-pass", () => {
  test("runExchange refuses it before anything goes on the wire", async () => {
    // A fuzzy comparison declares a width without naming a fan-out step, so
    // assertFanOutImplemented does not reach it: this is the guard that refuses a
    // candidate set on a strategy that matches one value per record.
    const cascadeTerms: LinkageTerms = {
      ...termsWithFuzzyKey("adjacent_years"),
      linkageStrategy: "cascade",
    };
    const metadata: Metadata = [
      {
        name: "last_name",
        type: "last_name",
        role: "linkage",
        isPayload: false,
      },
      { name: "ssn", type: "ssn", role: "linkage", isPayload: false },
    ];
    const prepared = prepareForExchange(
      { linkageTerms: cascadeTerms, metadata },
      "Party",
      [{ last_name: "SMITH", ssn: "123456789" }],
      ["last_name", "ssn"],
    );
    const failIfUsed = (): never => {
      throw new Error("the connection was used past the width refusal");
    };
    const run = runExchange(
      { send: failIfUsed, receive: failIfUsed, close: failIfUsed },
      "initiator",
      prepared,
      { psiLibrary },
    );
    await expect(run).rejects.toThrow(UsageError);
    await expect(run).rejects.toThrow(/candidate value slot\(s\) per record/);
    await expect(run).rejects.not.toThrow(/partner/);
  });
});
