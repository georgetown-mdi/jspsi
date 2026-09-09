import { expect, test, describe, vi } from "vitest";

// A `swap` key's second order and a `generate_fuzzy_comparisons` expansion are
// gated on APPLIED_SETTINGS.fuzzyComparisons, false in the shipped build. This
// file drives the flag on so those two candidate-set producers run end to end
// under the cascade beside `split_on`, which needs no flag.
vi.mock("../src/consent/appliedSettings", () => ({
  APPLIED_SETTINGS: { deduplicate: true, fuzzyComparisons: true },
}));

import PSI from "@openmined/psi.js";

import {
  prepareForExchange,
  runExchange,
  type ExchangeResult,
} from "../src/exchange";
import {
  declaredKeyWidth,
  FAN_OUT_CANDIDATES_PER_ELEMENT,
} from "../src/fanOutFunctions";
import { createMessagePipe } from "../src/connection/messageConnection";
import {
  StandardizedDataset,
  StandardizedField,
  StandardizedKeyIterable,
} from "../src/standardization";
import { getLogger } from "../src/utils/logger";
import type {
  GenerateFuzzyComparisons,
  LinkageKey,
  LinkageTerms,
} from "../src/config/linkageTermsSchema";
import type { Standardization } from "../src/config/standardizationSchema";

const psiLibrary = await PSI();

// The cascade's realization of a candidate set, driven from the end an operator
// authors: linkage terms declaring one of the three producers, prepared over raw
// rows by prepareForExchange, exchanged by runExchange over a message pipe, and
// resolved into the table each party is handed. The unit-level rules the round
// applies are in psi/cascadeCandidateSets.test.ts; what these add is that an
// authored configuration reaches them.

const NAME_COLUMNS = ["last_name", "first_name"];

function cascadeTerms(
  keys: LinkageTerms["linkageKeys"],
  fields: LinkageTerms["linkageFields"] = [
    { name: "last_name", type: "last_name" },
    { name: "first_name", type: "first_name" },
  ],
): LinkageTerms {
  return {
    version: "1.0.0",
    identity: "Cascade Fan-out Test",
    date: "2026-01-01",
    algorithm: "psi",
    linkageStrategy: "cascade",
    output: { expectsOutput: true, shareWithPartner: true },
    deduplicate: false,
    linkageFields: fields,
    linkageKeys: keys,
  };
}

async function runBothParties(
  terms: LinkageTerms,
  initiatorRows: Array<Record<string, string>>,
  responderRows: Array<Record<string, string>>,
  columns: Array<string> = NAME_COLUMNS,
  standardization?: Standardization,
): Promise<[ExchangeResult, ExchangeResult]> {
  const [initiatorConn, responderConn] = createMessagePipe();
  const prepare = (identity: string, rows: Array<Record<string, string>>) =>
    prepareForExchange(
      { linkageTerms: { ...terms, identity }, standardization },
      identity,
      rows,
      columns,
    );
  return Promise.all([
    runExchange(
      initiatorConn,
      "initiator",
      prepare("Initiator Co", initiatorRows),
      { psiLibrary },
    ),
    runExchange(
      responderConn,
      "responder",
      prepare("Responder Co", responderRows),
      { psiLibrary },
    ),
  ]);
}

// --- split_on, end to end ----------------------------------------------------

// Two keys, most precise first. The last-name element splits on the space the
// default name pipeline leaves where a hyphen was ("Smith-Jones" standardizes to
// "SMITH JONES"), so a hyphenated surname enters its round as both parts; the
// first-name key is the less precise round the removal rule protects.
const SPLIT_ON_KEYS: LinkageTerms["linkageKeys"] = [
  {
    name: "last name",
    elements: [
      {
        field: "last_name",
        transform: [{ function: "split_on", params: { delimiter: " " } }],
      },
    ],
  },
  { name: "first name", elements: [{ field: "first_name" }] },
];

const splitOnInitiatorRows = [
  // Matches through one of its two candidates: no partner record holds the whole
  // "SMITH JONES". Its first name matches a DIFFERENT partner record in the
  // later round, which is the removal rule's fixture.
  { last_name: "Smith-Jones", first_name: "Alice" },
  { last_name: "Brown", first_name: "Carol" },
  // Reaches the second round with its candidacy intact, so the round the
  // removal keeps the first record out of is one that demonstrably runs.
  { last_name: "Taylor", first_name: "Frank" },
];

const splitOnResponderRows = [
  { last_name: "Jones", first_name: "Zoe" },
  // The record the first initiator row would meet on first name, had matching
  // on a last-name candidate not taken it out of that round.
  { last_name: "Green", first_name: "Alice" },
  { last_name: "Brown", first_name: "Dan" },
  { last_name: "Wilson", first_name: "Frank" },
];

test("a split_on configuration matches on each candidate under the cascade", async () => {
  const [initiator, responder] = await runBothParties(
    cascadeTerms(SPLIT_ON_KEYS),
    splitOnInitiatorRows,
    splitOnResponderRows,
  );

  // Initiator row 0 matches responder row 0 on the "JONES" candidate its surname
  // split off -- a pairing no single-valued realization of that surname
  // produces. Rows 1 and 2 are the ordinary single-valued matches beside it, one
  // per key round.
  expect(initiator.associationTable).toEqual([
    [0, 1, 2],
    [0, 2, 3],
  ]);
  // The same three pairs from the other side, each party naming its own rows
  // first.
  expect(responder.associationTable).toEqual([
    [0, 2, 3],
    [0, 1, 2],
  ]);
});

test("a record that matched on a candidate leaves candidacy for the later key", async () => {
  const [initiator] = await runBothParties(
    cascadeTerms(SPLIT_ON_KEYS),
    splitOnInitiatorRows,
    splitOnResponderRows,
  );

  // Initiator row 0 and responder row 1 share a first name, which is the second
  // key's whole content, so the only thing keeping them apart is the removal
  // rule: row 0 appeared in the first round's candidate pairs and left candidacy
  // for every round after it.
  const table = initiator.associationTable;
  expect(table).toBeDefined();
  const [localRows, partnerRows] = table!;
  expect(partnerRows[localRows.indexOf(0)]).toBe(0);
  expect(partnerRows).not.toContain(1);
  // The removed record's first-name value really is the one the other party
  // holds, so this is the rule biting rather than a fixture that never met.
  expect(splitOnInitiatorRows[0].first_name).toBe(
    splitOnResponderRows[1].first_name,
  );
  // And the later round did run: row 2 is matched there, on first name alone.
  expect(localRows).toContain(2);
});

test("the cascade yields the table single-pass computes on the same terms and rows", async () => {
  const [cascadeInitiator, cascadeResponder] = await runBothParties(
    cascadeTerms(SPLIT_ON_KEYS),
    splitOnInitiatorRows,
    splitOnResponderRows,
  );
  const [singleInitiator, singleResponder] = await runBothParties(
    { ...cascadeTerms(SPLIT_ON_KEYS), linkageStrategy: "single-pass" },
    splitOnInitiatorRows,
    splitOnResponderRows,
  );

  expect(cascadeInitiator.associationTable).toEqual(
    singleInitiator.associationTable,
  );
  expect(cascadeResponder.associationTable).toEqual(
    singleResponder.associationTable,
  );
});

// --- each fuzzy comparison kind, end to end ----------------------------------
// Every kind relates one pair the exact values would not, so a table holding
// that pair is the expansion running through the cascade rather than an exact
// match the fixture happened to contain.

interface FuzzyCase {
  readonly kind: GenerateFuzzyComparisons;
  readonly initiator: string;
  readonly responder: string;
}

const FUZZY_CASES: ReadonlyArray<FuzzyCase> = [
  // One transposition of two positions apart.
  { kind: "transpositions", initiator: "SMITH", responder: "SMTIH" },
  // One deletion each side meets in the middle: SMITH and SMYTH both delete to
  // SMTH.
  { kind: "edit_distances", initiator: "SMITH", responder: "SMYTH" },
  // The year either side, on the canonical date layout.
  { kind: "adjacent_years", initiator: "19900115", responder: "19910115" },
  // The one date the day and month exchange to.
  { kind: "day_month_swaps", initiator: "19900112", responder: "19901201" },
];

function fuzzyTerms(kind: GenerateFuzzyComparisons): LinkageTerms {
  const dateKind = kind === "adjacent_years" || kind === "day_month_swaps";
  return cascadeTerms(
    [
      {
        name: "fuzzy",
        elements: [
          {
            field: dateKind ? "date_of_birth" : "last_name",
            // `transpositions` declares one candidate per PAIR of its value's
            // positions, so its element bounds the value the way the reference
            // tells an author to; without a bound the key's declared width
            // crosses the per-key ceiling and the terms are refused.
            ...(kind === "transpositions"
              ? {
                  transform: [
                    { function: "substring", params: { start: 1, length: 5 } },
                  ],
                }
              : {}),
            generateFuzzyComparisons: kind,
          },
        ],
      },
    ],
    dateKind
      ? [{ name: "date_of_birth", type: "date_of_birth" }]
      : [{ name: "last_name", type: "last_name" }],
  );
}

describe("each fuzzy comparison kind matches under the cascade", () => {
  test.each(FUZZY_CASES)(
    "$kind relates the pair its expansion reaches",
    async ({ kind, initiator, responder }) => {
      const dateKind = kind === "adjacent_years" || kind === "day_month_swaps";
      const column = dateKind ? "date_of_birth" : "last_name";
      const [initiatorResult, responderResult] = await runBothParties(
        fuzzyTerms(kind),
        [{ [column]: initiator }],
        [{ [column]: responder }],
        [column],
      );
      expect(initiatorResult.associationTable).toEqual([[0], [0]]);
      expect(responderResult.associationTable).toEqual([[0], [0]]);
      // The two values are not equal, so nothing but the expansion pairs them.
      expect(initiator).not.toBe(responder);
    },
  );

  test("an unrelated pair the expansion does not reach stays unmatched", async () => {
    // The negative half: without it a fixture that matched for any other reason
    // would pass every case above.
    const [initiatorResult] = await runBothParties(
      fuzzyTerms("adjacent_years"),
      [{ date_of_birth: "19900115" }],
      [{ date_of_birth: "19950115" }],
      ["date_of_birth"],
    );
    expect(initiatorResult.associationTable).toEqual([[], []]);
  });
});

// --- a swap key declaring both orders, end to end ----------------------------

const SWAP_TERMS = cascadeTerms([
  {
    name: "FN+LN",
    elements: [{ field: "first_name" }, { field: "last_name" }],
    swap: ["first_name", "last_name"],
  },
]);

test("a swap key matches a partner whose two fields are reversed", async () => {
  // The receiver assembles the key in the authored order as well as the swapped
  // one, so the pair meets whichever party role resolution hands the receiver
  // role to.
  const [initiator, responder] = await runBothParties(
    SWAP_TERMS,
    [{ first_name: "John", last_name: "Smith" }],
    [{ first_name: "Smith", last_name: "John" }],
  );
  expect(initiator.associationTable).toEqual([[0], [0]]);
  expect(responder.associationTable).toEqual([[0], [0]]);
});

test("a swap key still matches a partner whose fields agree", async () => {
  // Building the exchanged order alone would match the reversed partner and
  // lose the one that agrees, so both are driven.
  const [initiator] = await runBothParties(
    SWAP_TERMS,
    [{ first_name: "John", last_name: "Smith" }],
    [{ first_name: "John", last_name: "Smith" }],
  );
  expect(initiator.associationTable).toEqual([[0], [0]]);
});

// --- the per-(record, key) cap and the accumulation charge --------------------
// Both bounds are the key builder's, so what this section adds is that they hold
// for a CASCADE candidate set: a record past either one contributes nothing to
// that key's round and stays eligible for the next, where a record at the cap
// contributes every candidate it declares (docs/spec/PROTOCOL.md, The width
// bound). The round's own per-record ceiling on a partner's grouping is pinned
// in partnerIndexValidation.ts.

// One key whose single element splits on a space, so the width the agreed terms
// declare for it is the fan-out factor exactly and a cell of that many parts is
// the worst case a round of it can carry. The fan-out rides the ELEMENT rather
// than the field pipeline, so this party's own standardization declares none and
// its per-(record, key) bound is that width alone.
const CAP_KEYS: LinkageTerms["linkageKeys"] = [
  {
    name: "parts",
    elements: [
      {
        field: "last_name",
        transform: [{ function: "split_on", params: { delimiter: " " } }],
      },
    ],
  },
  { name: "fallback", elements: [{ field: "first_name" }] },
];
const CAP_TERMS = cascadeTerms(CAP_KEYS);
const CAP_KEY_WIDTH = declaredKeyWidth(CAP_KEYS[0]);

// The cells below carry the delimiter through to the element transform, so the
// default name pipeline's separator rewriting is replaced by a pass-through.
const PASS_THROUGH: Standardization = [
  { output: "last_name", input: "last_name", steps: [] },
  { output: "first_name", input: "first_name", steps: [] },
];

function spaced(count: number, tag: string): string {
  return Array.from({ length: count }, (_unused, i) => `${tag}${i}`).join(" ");
}

// The candidates the round's own key read realizes for a row, which is what the
// cascade contributes to that round's PSI set.
function roundCandidates(
  keys: LinkageTerms["linkageKeys"],
  fields: Record<string, { steps: Array<{ function: string }>; value: string }>,
  keyIndex: number,
  isReceiver = false,
): ReadonlySet<string> | undefined {
  const dataset = new StandardizedDataset(
    Object.entries(fields).map(
      ([name, { steps, value }]) =>
        new StandardizedField(name, name, steps, [{ [name]: value }]),
    ),
    keys,
  );
  const value = new StandardizedKeyIterable(
    keys[keyIndex],
    dataset,
    1,
    isReceiver,
    keyIndex,
  )[0];
  return typeof value === "string" ? new Set([value]) : value;
}

test("a record at the width its key declares carries every candidate into the round", () => {
  // The worst case measured rather than assumed: the widest cell the terms
  // admit realizes exactly the declared width, and one part more realizes
  // nothing at all.
  const at = roundCandidates(
    CAP_KEYS,
    { last_name: { steps: [], value: spaced(CAP_KEY_WIDTH, "P") } },
    0,
  );
  expect(CAP_KEY_WIDTH).toBe(FAN_OUT_CANDIDATES_PER_ELEMENT);
  expect(at?.size).toBe(CAP_KEY_WIDTH);
  expect(
    roundCandidates(
      CAP_KEYS,
      { last_name: { steps: [], value: spaced(CAP_KEY_WIDTH + 1, "P") } },
      0,
    ),
  ).toBeUndefined();
});

test("a record over the declared width sits the cascade round out and matches on a later key", async () => {
  // Row 0 splits into one part more than the key admits, so it contributes
  // nothing to that round even though the partner holds one of its parts; the
  // fallback key is where it matches instead. Row 1 is the same shape one part
  // narrower and matches on the first key, so the bound is what separates them.
  const [initiator] = await runBothParties(
    CAP_TERMS,
    [
      { last_name: spaced(CAP_KEY_WIDTH + 1, "P"), first_name: "SHARED" },
      { last_name: spaced(CAP_KEY_WIDTH, "Q"), first_name: "MINE" },
    ],
    [
      { last_name: "P0", first_name: "THEIRS" },
      { last_name: "Q0", first_name: "OTHER" },
      { last_name: "NONE", first_name: "SHARED" },
    ],
    NAME_COLUMNS,
    PASS_THROUGH,
  );
  expect(initiator.associationTable).toEqual([
    [0, 1],
    [2, 1],
  ]);
});

// The byte limb beside the count limb. A `transpositions` element declares one
// candidate per pair of its value's positions, so 45 characters is the widest
// value whose ceiling stays inside the per-key width ceiling; a cell of 100 such
// tokens crosses the per-row accumulation charge partway through, which is what
// the round has to take as a drop rather than a refusal. One token is inside
// every bound, so the two differ in the charge alone.
const TOKEN_WIDTH = 45;
const CROSSING_TOKENS = 100;
const INSIDE_TOKENS = 1;

const token = (i: number): string =>
  String(i).padStart(2, "0") +
  Array.from({ length: TOKEN_WIDTH - 2 }, (_unused, j) =>
    String.fromCharCode(0x41 + j),
  ).join("");

const CHARGE_KEY: LinkageKey = {
  name: "tokens",
  elements: [
    {
      field: "last_name",
      transform: [
        { function: "substring", params: { start: 1, length: TOKEN_WIDTH } },
      ],
      generateFuzzyComparisons: "transpositions",
    },
  ],
};

test("a record whose candidates cross the accumulation charge contributes nothing to the round", () => {
  const warn = vi
    .spyOn(getLogger("cleaning"), "warn")
    .mockImplementation(() => {});
  try {
    const splitting = [{ function: "split_on", params: { delimiter: "\\|" } }];
    const cell = (count: number) =>
      Array.from({ length: count }, (_unused, i) => token(i)).join("|");
    // The same shape inside the charge is realized in full, so what separates
    // the two is the charge rather than the fixture.
    const inside = roundCandidates(
      [CHARGE_KEY],
      { last_name: { steps: splitting, value: cell(INSIDE_TOKENS) } },
      0,
      true,
    );
    // One token realizes its whole transposition set, a candidate short of the
    // ceiling because two of its characters are equal. The line it raises is
    // the wide-expansion advisory, which leaves every candidate in the round.
    expect(inside?.size).toBe(declaredKeyWidth(CHARGE_KEY) - 1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/may degrade privacy guarantees/);
    warn.mockClear();
    expect(
      roundCandidates(
        [CHARGE_KEY],
        { last_name: { steps: splitting, value: cell(CROSSING_TOKENS) } },
        0,
        true,
      ),
    ).toBeUndefined();
    // The charge's own line, not the count limb's: what dropped the row is the
    // characters its candidates accumulate rather than how many of them there
    // are.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(
      /accumulates \d+ characters of candidate values once this key's fuzzy comparisons expand them/,
    );
  } finally {
    warn.mockRestore();
  }
});
