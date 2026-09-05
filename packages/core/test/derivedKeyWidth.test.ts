import { expect, test, describe, vi } from "vitest";

// The width a fuzzy element declares is gated on
// APPLIED_SETTINGS.fuzzyComparisons, false in the shipped build because the
// expansion it sizes builds nothing there (fuzzyComparisons.test.ts pins that
// inert case). This file drives the flag on, so the derivation, its ceiling,
// and the boundary that enforces it are verified rather than only reachable in
// review.
vi.mock("../src/consent/appliedSettings", () => ({
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
  SWAP_VARIANT_WIDTH_FACTOR,
} from "../src/fanOutFunctions";
import {
  expandFuzzyComparisons,
  fuzzyCandidateCeiling,
  MAX_FUZZY_EXPANSION_INPUT_LENGTH,
} from "../src/fuzzyComparisons";
import { elementValueWidthBound } from "../src/keyElementWidth";
import {
  buildKeyStrings,
  STANDARDIZATION_FUNCTION_NAMES,
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
  TransformStep,
} from "../src/config/linkageTermsSchema";
import type { Metadata } from "../src/config/metadata";
import type { Standardization } from "../src/config/standardizationSchema";
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

// A `transpositions` element declares one candidate per PAIR of its value's
// positions, so an element whose transforms bound no width declares more than
// MAX_KEY_CANDIDATE_WIDTH and is refused where the width is derived. Every
// fixture below that must be admissible bounds that value the way
// EXCHANGE_REFERENCE.md tells an author to, and reads its ceiling at the bound.
const TRANSPOSITION_VALUE_BOUND = 10;

const boundToTranspositionWidth: TransformStep[] = [
  {
    function: "substring",
    params: { start: 1, length: TRANSPOSITION_VALUE_BOUND },
  },
];

function declaredCeiling(kind: GenerateFuzzyComparisons): number {
  return kind === "transpositions"
    ? fuzzyCandidateCeiling(kind, TRANSPOSITION_VALUE_BOUND)
    : fuzzyCandidateCeiling(kind);
}

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
        elements: [
          {
            field: "last_name",
            generateFuzzyComparisons: kind,
            ...(kind === "transpositions"
              ? { transform: boundToTranspositionWidth }
              : {}),
          },
        ],
      },
      { name: "SSN", elements: [{ field: "ssn" }] },
    ],
  };
}

// The longest value each kind accepts, which is where its ceiling is set. A
// repeated character would collapse candidates into each other -- a transposition
// of two equal characters emits none at all -- so every character is distinct;
// the date is the one canonical shape `adjacent_years` reads, whose expansion
// does not grow with length.
function longestExpandableValue(kind: GenerateFuzzyComparisons): string {
  if (kind === "adjacent_years") return "19900115";
  return Array.from(
    { length: MAX_FUZZY_EXPANSION_INPUT_LENGTH },
    (_unused, i) => String.fromCodePoint(0x41 + i),
  ).join("");
}

describe("the ceiling each fuzzy kind declares", () => {
  test.each(FUZZY_KINDS)(
    "%s never realizes more candidates than its ceiling",
    (kind) => {
      // The ceiling is the factor the key's declared width multiplies in, so an
      // expansion realizing more than it would have an honest row refused at
      // the width bound. Measured against the real expansion at the longest
      // value it accepts rather than restated as a number.
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

// The one-step chains whose declared params fix an output width, with the
// width each fixes. Every other function core knows derives none, which the
// enumeration below holds to the registry rather than to this list.
const WIDTH_SHAPING_STEPS: ReadonlyArray<[string, TransformStep, number]> = [
  [
    "substring",
    { function: "substring", params: { start: 1, length: 10 } },
    10,
  ],
  ["phonetic", { function: "phonetic" }, 4],
  ["parse_date", { function: "parse_date" }, 8],
  [
    "parse_date with its own output layout",
    { function: "parse_date", params: { outputFormat: "YYYY-MM-DD" } },
    10,
  ],
];

describe("the width an element's transforms bound its value to", () => {
  test.each(WIDTH_SHAPING_STEPS)("%s fixes a width", (_label, step, width) => {
    expect(elementValueWidthBound([step])).toBe(width);
  });

  test("every other function core knows fixes none", () => {
    // Held to the registry rather than to a list beside it, so a function added
    // to core falls back to the global cap until it is classified here -- the
    // safe direction, since a width derived too small refuses an honest row.
    const settling = new Set(
      WIDTH_SHAPING_STEPS.map(([, step]) => step.function),
    );
    for (const name of STANDARDIZATION_FUNCTION_NAMES) {
      if (settling.has(name)) continue;
      expect(elementValueWidthBound([{ function: name }])).toBeUndefined();
    }
  });

  test("a pad fills up to its length and fixes no width on its own", () => {
    expect(
      elementValueWidthBound([{ function: "pad_left", params: { length: 9 } }]),
    ).toBeUndefined();
    // It raises one the chain already holds, since a value shorter than the
    // pad leaves it at the pad's own length.
    expect(
      elementValueWidthBound([
        { function: "substring", params: { start: 1, length: 4 } },
        { function: "pad_left", params: { length: 9 } },
      ]),
    ).toBe(9);
    // A pad below the width already flowing into it moves nothing.
    expect(
      elementValueWidthBound([
        { function: "substring", params: { start: 1, length: 9 } },
        { function: "pad_left", params: { length: 4 } },
      ]),
    ).toBe(9);
  });

  test("the last step to fix a width governs", () => {
    expect(
      elementValueWidthBound([
        { function: "pad_left", params: { length: 40 } },
        { function: "substring", params: { start: 1, length: 10 } },
      ]),
    ).toBe(10);
    expect(
      elementValueWidthBound([
        { function: "substring", params: { start: 1, length: 10 } },
        { function: "phonetic" },
      ]),
    ).toBe(4);
    // A step whose output width its params do not determine clears the width:
    // an upper-casing can emit more characters than it was handed.
    expect(
      elementValueWidthBound([
        { function: "substring", params: { start: 1, length: 10 } },
        { function: "to_upper_case" },
      ]),
    ).toBeUndefined();
    // A step that returns the value it was handed, or drops it, leaves the
    // width unchanged.
    expect(
      elementValueWidthBound([
        { function: "substring", params: { start: 1, length: 10 } },
        { function: "null_if", params: { values: ["UNKNOWN"] } },
        { function: "filter_regex", params: { pattern: "[A-Z]" } },
      ]),
    ).toBe(10);
  });

  test("a derived width of zero is floored at one", () => {
    // A value always yields at least itself, so the narrowest honest bound is
    // one character. `parse_date` with an empty output layout is the one shape
    // whose params fix the width at zero, declaring a key narrower than the
    // single candidate the row builder emits for it. The terms schema already
    // refuses the shape (linkageTermsSchema.test.ts); this floor covers a
    // chain reaching the derivation another way.
    expect(
      elementValueWidthBound([
        { function: "parse_date", params: { outputFormat: "" } },
      ]),
    ).toBe(1);
    // And through a chain that holds it: a pad reads the floored width, not a
    // zero.
    expect(
      elementValueWidthBound([
        { function: "parse_date", params: { outputFormat: "" } },
        { function: "null_if", params: { values: ["UNKNOWN"] } },
      ]),
    ).toBe(1);
  });

  test("a floored width keeps the effective key count at or above the key count", () => {
    // The consequence the floor exists for: a key's declared width is the product
    // of its elements' factors, so a zero factor would drive the sum below the
    // plain key count -- understating the sender's own slot bound and refusing its
    // honest rows.
    const key: LinkageKey = {
      name: "DOB",
      elements: [
        {
          field: "last_name",
          generateFuzzyComparisons: "transpositions",
          transform: [{ function: "parse_date", params: { outputFormat: "" } }],
        },
      ],
    };
    expect(fuzzyCandidateCeiling("transpositions", 1)).toBe(1);
    expect(declaredKeyWidth(key)).toBe(1);
    const terms = termsWithFuzzyKey("transpositions");
    terms.linkageKeys[0] = key;
    expect(declaredEffectiveKeyCount(terms)).toBe(terms.linkageKeys.length);
  });

  test("a substring whose bounds do not fix a width derives none", () => {
    // A negative length measures its end from the end of the VALUE, so the
    // window it opens grows with the value; a degenerate bound reads nothing at
    // all, which the row build drops.
    expect(
      elementValueWidthBound([
        { function: "substring", params: { start: 1, length: -2 } },
      ]),
    ).toBeUndefined();
    expect(
      elementValueWidthBound([
        { function: "substring", params: { start: 0, length: 5 } },
      ]),
    ).toBeUndefined();
  });

  test("the real row build never produces a value wider than the derived bound", () => {
    // The bound decides how many candidates a fuzzy element may declare, so a
    // reading above what the pipeline emits is what would refuse an honest row.
    // Driven through the shipped key builder rather than restated.
    const chains: TransformStep[][] = [
      [{ function: "substring", params: { start: 1, length: 10 } }],
      [{ function: "substring", params: { start: -5, length: 5 } }],
      [
        { function: "substring", params: { start: 1, length: 4 } },
        { function: "pad_left", params: { length: 9 } },
      ],
      [
        { function: "pad_left", params: { length: 40 } },
        { function: "substring", params: { start: 1, length: 10 } },
      ],
      [{ function: "phonetic" }],
      [{ function: "parse_date" }],
      [{ function: "parse_date", params: { outputFormat: "YYYY-MM-DD" } }],
      // The floored chain: the builder emits one empty candidate for it, which
      // the floor of 1 covers where a derived 0 would not.
      [{ function: "parse_date", params: { outputFormat: "" } }],
      [
        { function: "substring", params: { start: 1, length: 10 } },
        { function: "null_if", params: { values: ["UNKNOWN"] } },
      ],
    ];
    const values = [
      "SMITH",
      "01/02/1990",
      "A".repeat(300),
      // A combining sequence whose composed form is WIDER than the sequence
      // itself, which is what a width read off the input alone would miss.
      "\u0344".repeat(40),
      "Ki\u0301ng-Ferna\u0301ndez y Guitie\u0301rrez",
    ];
    for (const transform of chains) {
      const bound = elementValueWidthBound(transform);
      expect(bound).toBeDefined();
      for (const value of values) {
        const row = { last_name: value };
        const key = {
          name: "LN",
          elements: [{ field: "last_name", transform }],
        };
        const dataset = new StandardizedDataset(
          [new StandardizedField("last_name", "last_name", [], [row])],
          [key],
        );
        const built = buildKeyStrings(key, dataset, 0);
        for (const candidate of built ?? [])
          expect(candidate.length).toBeLessThanOrEqual(bound!);
      }
    }
  });
});

describe("the width a key declares", () => {
  test.each(FUZZY_KINDS)("%s raises only its own key's width", (kind) => {
    const terms = termsWithFuzzyKey(kind);
    expect(declaredKeyWidth(terms.linkageKeys[0])).toBe(declaredCeiling(kind));
    expect(declaredKeyWidth(terms.linkageKeys[1])).toBe(1);
    expect(declaredEffectiveKeyCount(terms)).toBe(declaredCeiling(kind) + 1);
  });

  test("a key declaring swap doubles the product of its elements' factors", () => {
    // The receiver assembles the key in both orders, so a record contributes
    // twice what its elements' factors alone would total, and the sender
    // declares the same number for the role it may not hold.
    const key: LinkageKey = {
      name: "FN+LN",
      elements: [{ field: "last_name" }, { field: "ssn" }],
    };
    expect(declaredKeyWidth(key)).toBe(1);
    expect(declaredKeyWidth({ ...key, swap: ["last_name", "ssn"] })).toBe(
      SWAP_VARIANT_WIDTH_FACTOR,
    );
    const fuzzy: LinkageKey = {
      name: "FN+LN",
      elements: key.elements.map((element) => ({
        ...element,
        generateFuzzyComparisons: "adjacent_years" as const,
      })),
      swap: ["last_name", "ssn"],
    };
    expect(declaredKeyWidth(fuzzy)).toBe(
      SWAP_VARIANT_WIDTH_FACTOR * fuzzyCandidateCeiling("adjacent_years") ** 2,
    );
  });

  test("an unbounded transpositions element declares more than one key may hold", () => {
    // The stated limit of the all-pairs enumeration: the pair count of the
    // 128-character expansion limit is far above MAX_KEY_CANDIDATE_WIDTH, so an
    // element whose transforms bound no width is refused where the width is
    // derived rather than at a row. Bounding the value to 45 characters is the
    // widest an author can declare.
    const unbounded: LinkageKey = {
      name: "LN",
      elements: [
        { field: "last_name", generateFuzzyComparisons: "transpositions" },
      ],
    };
    expect(
      fuzzyCandidateCeiling("transpositions", MAX_FUZZY_EXPANSION_INPUT_LENGTH),
    ).toBeGreaterThan(MAX_KEY_CANDIDATE_WIDTH);
    expect(() => declaredKeyWidth(unbounded)).toThrow(UsageError);
    expect(() => declaredKeyWidth(unbounded, 0)).toThrow(
      /linkageKeys\[0\] declares a width of more than the 1024/,
    );
    expect(fuzzyCandidateCeiling("transpositions", 45)).toBeLessThanOrEqual(
      MAX_KEY_CANDIDATE_WIDTH,
    );
    expect(fuzzyCandidateCeiling("transpositions", 46)).toBeGreaterThan(
      MAX_KEY_CANDIDATE_WIDTH,
    );
  });

  test("two all-pairs elements in one key compound past the ceiling at nine characters each", () => {
    // The stacked case the reference states: each element alone is admissible
    // at a nine-character bound, and the two together are not. It is determined
    // from the terms, so no row is read and no machinery beyond the width
    // derivation is involved.
    const boundTo = (length: number): TransformStep[] => [
      { function: "substring", params: { start: 1, length } },
    ];
    const stacked = (length: number): LinkageKey => ({
      name: "LN+SSN",
      elements: ["last_name", "ssn"].map((field) => ({
        field,
        transform: boundTo(length),
        generateFuzzyComparisons: "transpositions" as const,
      })),
    });
    expect(declaredKeyWidth(stacked(8))).toBe(
      fuzzyCandidateCeiling("transpositions", 8) ** 2,
    );
    expect(fuzzyCandidateCeiling("transpositions", 9) ** 2).toBeGreaterThan(
      MAX_KEY_CANDIDATE_WIDTH,
    );
    expect(() => declaredKeyWidth(stacked(9))).toThrow(UsageError);
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

  test("an element whose transforms bound its value declares that width's ceiling", () => {
    // The ceiling is the count the expansion can realize from a value of the
    // bounded width, measured against the real expansion rather than restated.
    const bounded: TransformStep[] = [
      { function: "substring", params: { start: 1, length: 10 } },
    ];
    const terms = termsWithFuzzyKey("edit_distances");
    terms.linkageKeys[0].elements[0].transform = bounded;
    expect(declaredKeyWidth(terms.linkageKeys[0])).toBe(11);
    expect(
      expandFuzzyComparisons("ABCDEFGHIJ", "edit_distances").length,
    ).toBeLessThanOrEqual(11);

    const transposed = termsWithFuzzyKey("transpositions");
    transposed.linkageKeys[0].elements[0].transform = bounded;
    expect(declaredKeyWidth(transposed.linkageKeys[0])).toBe(46);
    expect(
      expandFuzzyComparisons("ABCDEFGHIJ", "transpositions").length,
    ).toBeLessThanOrEqual(46);

    // The date expansion emits the year either side whatever the value's width,
    // so a bound moves nothing for it.
    const dated = termsWithFuzzyKey("adjacent_years");
    dated.linkageKeys[0].elements[0].transform = [{ function: "parse_date" }];
    expect(declaredKeyWidth(dated.linkageKeys[0])).toBe(3);
  });

  test("two bounded elements compound to a width the ceiling admits", () => {
    // The same pair of elements unbounded declares 129 * 129, which the per-key
    // ceiling refuses; bounding each element's value is what admits the key.
    const key: LinkageKey = {
      name: "LN2",
      elements: [
        {
          field: "last_name",
          generateFuzzyComparisons: "edit_distances",
          transform: [
            { function: "substring", params: { start: 1, length: 10 } },
          ],
        },
        {
          field: "ssn",
          generateFuzzyComparisons: "edit_distances",
          transform: [
            { function: "substring", params: { start: 1, length: 10 } },
          ],
        },
      ],
    };
    expect(declaredKeyWidth(key)).toBe(121);
    expect(121).toBeLessThanOrEqual(MAX_KEY_CANDIDATE_WIDTH);
  });

  test("an element only a pad shapes takes the global cap", () => {
    // A pad fixes no maximum on its own, so the element declares what a value
    // of any admissible width can realize.
    const terms = termsWithFuzzyKey("edit_distances");
    terms.linkageKeys[0].elements[0].transform = [
      { function: "pad_left", params: { length: 9 } },
    ];
    expect(declaredKeyWidth(terms.linkageKeys[0])).toBe(
      MAX_FUZZY_EXPANSION_INPUT_LENGTH + 1,
    );
  });

  test("a bound above the expansion's own limit is clamped to it", () => {
    // A value wider than the limit is refused rather than expanded, so no
    // element declares more candidates than the limit's own ceiling.
    const terms = termsWithFuzzyKey("edit_distances");
    terms.linkageKeys[0].elements[0].transform = [
      {
        function: "substring",
        params: { start: 1, length: MAX_FUZZY_EXPANSION_INPUT_LENGTH * 3 },
      },
    ];
    expect(declaredKeyWidth(terms.linkageKeys[0])).toBe(
      MAX_FUZZY_EXPANSION_INPUT_LENGTH + 1,
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

  test("the same ceiling refuses the row build at the width boundary", () => {
    // The check that refuses a fuzzy-widened row is the one that refuses an
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
    const dataset = new StandardizedDataset(
      [
        new StandardizedField("last_name", "last_name", [], [row]),
        new StandardizedField("ssn", "ssn", [], [row]),
      ],
      [key],
    );
    expect(() => buildKeyStrings(key, dataset, 0, true)).toThrow(
      /declares a width of more than the 1024/,
    );
  });
});

describe("both parties derive the same width with no round-trip", () => {
  const FUZZY_TERMS = termsWithFuzzyKey("transpositions");

  test("neither terms frame holds a width, and each side derives the other's", async () => {
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

    // Nothing on the wire holds a width, in either direction.
    for (const frame of [...initiatorSent, ...responderSent])
      expect(frame).not.toHaveProperty("effectiveKeyCount");

    // Each party derives the partner's width from the terms it was handed, and
    // the two derivations agree with each party's reading of its own.
    const expected = declaredCeiling("transpositions") + 1;
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
      const expected = declaredCeiling("transpositions") + 1;
      expect(declaredEffectiveKeyCount(a.partnerTerms)).toBe(expected);
      expect(declaredEffectiveKeyCount(b.partnerTerms)).toBe(expected);
    },
  );

  test("a frame holding a width on top of the terms proceeds without reading it", async () => {
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
      declaredCeiling("transpositions") + 1,
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

  // What both parties run: the same agreed terms over the same columns, with the
  // splitting party's own rows and its partner's.
  interface PairShape {
    terms: LinkageTerms;
    metadata: Metadata;
    columns: string[];
    localRows: Array<CSVRow>;
    partnerRows: Array<CSVRow>;
  }

  const keyReadsTheSplitField: PairShape = {
    terms: plainTerms,
    metadata,
    columns,
    localRows: splittingRows,
    partnerRows,
  };

  // The same cleaning over terms whose only key reads a DIFFERENT field:
  // `last_name` is a declared linkage field the standardization splits, and no
  // key element names it.
  const keyReadsAnotherField: PairShape = {
    terms: {
      ...plainTerms,
      linkageFields: [
        { name: "ssn", type: "ssn" },
        { name: "last_name", type: "last_name" },
      ],
      linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
    },
    metadata: [
      { name: "ssn", type: "ssn", role: "linkage", isPayload: false },
      ...metadata,
    ],
    columns: ["ssn", "last_name"],
    localRows: [
      { ssn: "559811301", last_name: "SMITH JONES" },
      { ssn: "322842281", last_name: "BROWN" },
    ],
    partnerRows: [
      { ssn: "559811301", last_name: "JONES" },
      { ssn: "111223333", last_name: "GREEN" },
      { ssn: "444556666", last_name: "WHITE" },
    ],
  };

  const splitOn = (field: string): Standardization => [
    {
      output: field,
      input: field,
      steps: [{ function: "split_on", params: { delimiter: " " } }],
    },
  ];

  interface Confirmation {
    role: PsiRole;
    localRecordCount: number;
    localDeclaredRecordCount: number;
  }

  async function runPair(
    shape: PairShape,
    standardization?: Standardization,
  ): Promise<Confirmation> {
    const [connA, connB] = createMessagePipe();
    let confirmation: Confirmation | undefined;
    await Promise.all([
      runExchange(
        connA,
        "initiator",
        prepareForExchange(
          {
            linkageTerms: { ...shape.terms, identity: "Splitting Co" },
            metadata: shape.metadata,
            ...(standardization !== undefined && { standardization }),
          },
          "Splitting Co",
          shape.localRows,
          shape.columns,
        ),
        {
          psiLibrary,
          onProtocolConfirmed: (
            _terms: LinkageTerms,
            role: PsiRole,
            shape: ResolvedRunShape,
          ) => {
            confirmation = {
              role,
              localRecordCount: shape.localRecordCount,
              localDeclaredRecordCount: shape.localDeclaredRecordCount,
            };
          },
        },
      ),
      runExchange(
        connB,
        "responder",
        prepareForExchange(
          {
            linkageTerms: { ...shape.terms, identity: "Plain Co" },
            metadata: shape.metadata,
          },
          "Plain Co",
          shape.partnerRows,
          shape.columns,
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
    const plain = await runPair(keyReadsTheSplitField);
    expect(plain.localRecordCount).toBe(splittingRows.length);
    expect(plain.localDeclaredRecordCount).toBe(splittingRows.length);
    expect(plain.role).toBe("receiver" satisfies PsiRole);

    const fanned = await runPair(keyReadsTheSplitField, splitOn("last_name"));
    expect(fanned.localDeclaredRecordCount).toBe(
      splittingRows.length * FAN_OUT_CANDIDATES_PER_ELEMENT,
    );
    // The shape's raw count stays this party's own rows: the fanned figure is
    // what it declared and what resolved the role, not what its file holds.
    expect(fanned.localRecordCount).toBe(splittingRows.length);
    expect(fanned.role).toBe("sender" satisfies PsiRole);
  });

  test("cleaning a field no linkage key reads declares nothing", async () => {
    // The same split, over terms whose only key reads another field. Nothing it
    // realizes reaches a key's round, so it stands for no extra record: the
    // party declares its rows and stays the smaller -- the receiver -- where
    // counting the split would have declared 20 times its rows and flipped it.
    const unread = await runPair(keyReadsAnotherField, splitOn("last_name"));
    expect(unread.localDeclaredRecordCount).toBe(unread.localRecordCount);
    expect(unread.localRecordCount).toBe(2);
    expect(unread.role).toBe("receiver" satisfies PsiRole);

    // The control on the same terms: split the field the key DOES read and the
    // declaration returns.
    const read = await runPair(keyReadsAnotherField, splitOn("ssn"));
    expect(read.localDeclaredRecordCount).toBe(
      read.localRecordCount * FAN_OUT_CANDIDATES_PER_ELEMENT,
    );
    expect(read.role).toBe("sender" satisfies PsiRole);
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
