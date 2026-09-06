import { expect, test, vi } from "vitest";

// The whole point of this file is what the shipped build does not do: the swap
// variant and the fuzzy expansion are gated on APPLIED_SETTINGS.fuzzyComparisons,
// so a driven exchange over a swapped key is the only place the width both
// parties declare for such a key and the candidates one of them assembles are
// composed rather than checked apart.
vi.mock("../src/consent/appliedSettings", () => ({
  APPLIED_SETTINGS: { deduplicate: true, fuzzyComparisons: true },
}));

import PSI from "@openmined/psi.js";

import { prepareForExchange, runExchange } from "../src/exchange";
import { createMessagePipe } from "../src/connection/messageConnection";

import type { ExchangeResult } from "../src/exchange";
import type {
  LinkageKey,
  Output,
  TransformStep,
} from "../src/config/linkageTermsSchema";

const psiLibrary = await PSI();

const both: Output = { expectsOutput: true, shareWithPartner: true };

type NameRow = { first_name: string; last_name: string };

const baseTerms = {
  version: "1.0.0",
  date: "2026-01-01",
  algorithm: "psi" as const,
  linkageStrategy: "single-pass" as const,
  deduplicate: false,
  linkageFields: [
    { name: "firstName", type: "first_name" as const },
    { name: "lastName", type: "last_name" as const },
  ],
};

// The pair a swap is authored for: one element reads the first name and the
// other the last, and the receiver assembles both arrangements.
const swappedKey: LinkageKey = {
  name: "FN + LN",
  elements: [{ field: "firstName" }, { field: "lastName" }],
  swap: ["firstName", "lastName"],
};

// Every candidate of an all-pairs transposition is quadratic in the value's
// width, so a transposed element bounds its value with a transform; two
// characters is the narrowest bound that transposes to anything at all.
const BOUND_TO_TWO_CHARACTERS: TransformStep[] = [
  { function: "substring", params: { start: 1, length: 2 } },
];

// The same pair, with the transposition expansion on both of its positions --
// the arrangement the terms schema requires of a swap pair. The receiver
// assembles the two arrangements of the two transpositions of each element,
// which is the swap factor and the fuzzy factors of the width composing.
const transposedSwappedKey: LinkageKey = {
  name: "FN2 + LN2",
  elements: [
    {
      field: "firstName",
      transform: BOUND_TO_TWO_CHARACTERS,
      generateFuzzyComparisons: "transpositions",
    },
    {
      field: "lastName",
      transform: BOUND_TO_TWO_CHARACTERS,
      generateFuzzyComparisons: "transpositions",
    },
  ],
  swap: ["firstName", "lastName"],
};

// Rows no arrangement of either party's key can meet, padding one party's count
// so role resolution designates the other the receiver. Alphabetic throughout:
// the default name cleaning keeps letters and drops the rest.
const filler = (party: string, count: number): NameRow[] =>
  Array.from({ length: count }, (_unused, i) => ({
    first_name: `${party}FILLERFIRST${"ABCDEFGHIJ"[i % 10]}`,
    last_name: `${party}FILLERLAST${"ABCDEFGHIJ"[i % 10]}`,
  }));

function prepared(key: LinkageKey, identity: string, rows: NameRow[]) {
  return prepareForExchange(
    {
      linkageTerms: {
        ...baseTerms,
        linkageKeys: [key],
        identity,
        output: both,
      },
    },
    identity,
    rows,
    ["first_name", "last_name"],
  );
}

/**
 * Drive one exchange between the party holding the records as authored and the
 * party holding some of them the other way round, with `receiver` naming which
 * of the two role resolution is to designate.
 *
 * Both parties expect output, so the role follows the declared record counts
 * (`resolveRole`): the party to be the receiver is left at its own row count and
 * the other is padded with rows nothing matches, which moves the role without
 * moving the intersection.
 */
async function runSwapExchange(
  key: LinkageKey,
  authoredRows: NameRow[],
  reversedRows: NameRow[],
  receiver: "authored" | "reversed",
): Promise<{ authored: ExchangeResult; reversed: ExchangeResult }> {
  const padding = 3;
  const [connAuthored, connReversed] = createMessagePipe();
  const [authored, reversed] = await Promise.all([
    runExchange(
      connAuthored,
      "initiator",
      prepared(key, "Authored Co", [
        ...authoredRows,
        ...(receiver === "authored" ? [] : filler("AUTH", padding)),
      ]),
      { psiLibrary },
    ),
    runExchange(
      connReversed,
      "responder",
      prepared(key, "Reversed Co", [
        ...reversedRows,
        ...(receiver === "reversed" ? [] : filler("REV", padding)),
      ]),
      { psiLibrary },
    ),
  ]);
  return { authored, reversed };
}

// The matched (local row, partner row) pairs in ascending local order, which is
// the shape both parties' tables are already built in.
function matchedPairs(result: ExchangeResult): Array<[number, number]> {
  const table = result.associationTable;
  expect(table).toBeDefined();
  return table![0].map((local, i) => [local, table![1][i]]);
}

// One pair whose two records agree on the arrangement, and one whose records are
// reversed against each other. The agreeing pair meets only through the order the
// terms author, and the reversed pair only through the exchanged one, so a run
// matching both is a run in which the receiver assembled the key twice.
const AGREEING_AND_REVERSED: {
  authored: NameRow[];
  reversed: NameRow[];
} = {
  authored: [
    { first_name: "CAROL", last_name: "SMITH" },
    { first_name: "ALICE", last_name: "JONES" },
  ],
  reversed: [
    { first_name: "CAROL", last_name: "SMITH" },
    { first_name: "JONES", last_name: "ALICE" },
  ],
};

for (const receiver of ["authored", "reversed"] as const) {
  test(`a swapped key matches both arrangements with the ${receiver} party as receiver`, async () => {
    const { authored, reversed } = await runSwapExchange(
      swappedKey,
      AGREEING_AND_REVERSED.authored,
      AGREEING_AND_REVERSED.reversed,
      receiver,
    );

    expect(authored.resolvedRole).toBe(
      receiver === "authored" ? "receiver" : "sender",
    );
    expect(reversed.resolvedRole).toBe(
      receiver === "reversed" ? "receiver" : "sender",
    );

    // Both records meet: row 0 through the authored arrangement, row 1 through
    // the exchanged one. Each party names the same two pairs from its own side,
    // which is the intersection both resolved.
    expect(matchedPairs(authored)).toEqual([
      [0, 0],
      [1, 1],
    ]);
    expect(matchedPairs(reversed)).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });
}

// One record entered the other way round AND with the two leading characters of
// one of its values transposed, so meeting it needs the swap's second
// arrangement and the transposition expansion at once.
const REVERSED_AND_TRANSPOSED: {
  authored: NameRow[];
  reversed: NameRow[];
} = {
  authored: [{ first_name: "ABEL", last_name: "CDIXON" }],
  reversed: [{ first_name: "DCIXON", last_name: "ABEL" }],
};

for (const receiver of ["authored", "reversed"] as const) {
  test(`a swapped key with a transposed pair matches with the ${receiver} party as receiver`, async () => {
    const { authored, reversed } = await runSwapExchange(
      transposedSwappedKey,
      REVERSED_AND_TRANSPOSED.authored,
      REVERSED_AND_TRANSPOSED.reversed,
      receiver,
    );

    // Whichever party expands reaches the other's single exact value, so the
    // pair meets under either role resolution -- the involution the one-sided
    // model rests on, driven rather than argued.
    expect(matchedPairs(authored)).toEqual([[0, 0]]);
    expect(matchedPairs(reversed)).toEqual([[0, 0]]);
  });
}

test("a swapped key still matches nothing the arrangements do not reach", async () => {
  // The width a swapped key declares buys two arrangements of each record, not a
  // match between records that share neither. Without this the tests above would
  // pass on a key that matched everything.
  const { authored, reversed } = await runSwapExchange(
    swappedKey,
    [{ first_name: "CAROL", last_name: "SMITH" }],
    [{ first_name: "HENRY", last_name: "BROWN" }],
    "reversed",
  );
  expect(matchedPairs(authored)).toEqual([]);
  expect(matchedPairs(reversed)).toEqual([]);
});
