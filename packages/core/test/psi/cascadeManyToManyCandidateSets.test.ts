import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import { PSIParticipant } from "../../src/psi/participant";
import { linkViaPSI } from "../../src/psi/link";
import { entityClusters } from "../../src/psi/entityClosure";
import { createMessagePipe } from "../../src/connection/messageConnection";
import type { AssociationTable } from "../../src/types";
import { UNBOUNDED_PSI_ELEMENTS } from "../utils/psiElementBounds";
import {
  candidateSetBounds,
  declaredKeyWidths,
  type Column,
} from "../utils/candidateSetBounds";

// A candidate set under `many-to-many`, held against a reference built from the
// two parties' incidences rather than against a second strategy: single-pass
// pairs no both-sided cardinality, so the equivalence MUST that binds every
// other shape has no referent here and none is manufactured
// (docs/spec/PROTOCOL.md, What this resolution owes). What stands in its
// place is the specification oracle below, and both parties are driven over
// every fixture in both role assignments.

const psiLibrary = await PSI();

function makeParticipant(role: "starter" | "joiner"): PSIParticipant {
  return new PSIParticipant(
    role === "starter" ? "server" : "client",
    psiLibrary,
    { role, verbose: -1 },
    UNBOUNDED_PSI_ELEMENTS,
  );
}

// --- the specification oracle -------------------------------------------------

type Pair = [number, number];

// The values a column's rows realize, as a set per row, with the rows that have
// left candidacy dropped.
function incidence(
  column: Column,
  outOfCandidacy: ReadonlySet<number>,
): Map<string, Array<number>> {
  const byValue = new Map<string, Array<number>>();
  column.forEach((cell, row) => {
    if (cell === undefined || outOfCandidacy.has(row)) return;
    for (const value of typeof cell === "string" ? [cell] : cell) {
      const rows = byValue.get(value);
      if (rows === undefined) byValue.set(value, [row]);
      else if (rows[rows.length - 1] !== row) rows.push(row);
    }
  });
  return byValue;
}

/**
 * The pair set `many-to-many` specifies for a cascade, built straight from the
 * two parties' incidences: for each round, the union over its matched values of
 * the product of the records contributing that value on each side,
 * deduplicated, after which every record the round touched leaves candidacy
 * (docs/spec/PROTOCOL.md, What this resolution owes).
 *
 * Correct by construction because acceptance is total: no order, no tiebreak
 * and no within-round removal enters it, so the reference needs none of the
 * machinery the resolution it checks is made of.
 */
function oraclePairs(
  starterKeys: ReadonlyArray<Column>,
  joinerKeys: ReadonlyArray<Column>,
): Array<Pair> {
  const pairs: Array<Pair> = [];
  const starterMatched = new Set<number>();
  const joinerMatched = new Set<number>();
  for (let key = 0; key < starterKeys.length; ++key) {
    const starterBy = incidence(starterKeys[key], starterMatched);
    const joinerBy = incidence(joinerKeys[key], joinerMatched);
    const round = new Set<string>();
    for (const [value, starterRows] of starterBy) {
      const joinerRows = joinerBy.get(value);
      if (joinerRows === undefined) continue;
      for (const starterRow of starterRows)
        for (const joinerRow of joinerRows)
          round.add(`${starterRow} ${joinerRow}`);
    }
    for (const pair of round) {
      const [starterRow, joinerRow] = pair.split(" ").map(Number);
      pairs.push([starterRow, joinerRow]);
    }
    for (const pair of round) {
      const [starterRow, joinerRow] = pair.split(" ").map(Number);
      starterMatched.add(starterRow);
      joinerMatched.add(joinerRow);
    }
  }
  return sortPairs(pairs);
}

function sortPairs(pairs: ReadonlyArray<Pair>): Array<Pair> {
  return [...pairs].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

// A party's own table read as (starter row, joiner row) pairs, so the two
// parties' halves are comparable as one set.
function pairsOf(table: AssociationTable, swap: boolean): Array<Pair> {
  return sortPairs(
    table[0].map((local, i): Pair =>
      swap ? [table[1][i], local] : [local, table[1][i]],
    ),
  );
}

// The connected components of a pair set, computed here rather than read from
// the closure under test, so the clusters each party derives are held against a
// reference of their own.
function oracleClusters(
  pairs: ReadonlyArray<Pair>,
): Array<{ localRows: Array<number>; partnerRows: Array<number> }> {
  const of = new Map<string, string>();
  const find = (node: string): string => {
    let root = node;
    while ((of.get(root) ?? root) !== root) root = of.get(root)!;
    return root;
  };
  for (const [starterRow, joinerRow] of pairs) {
    const a = find(`s${starterRow}`);
    const b = find(`j${joinerRow}`);
    if (a !== b) of.set(a, b);
  }
  const members = new Map<
    string,
    { localRows: Set<number>; partnerRows: Set<number> }
  >();
  for (const [starterRow, joinerRow] of pairs) {
    const root = find(`s${starterRow}`);
    let cluster = members.get(root);
    if (cluster === undefined) {
      cluster = { localRows: new Set(), partnerRows: new Set() };
      members.set(root, cluster);
    }
    cluster.localRows.add(starterRow);
    cluster.partnerRows.add(joinerRow);
  }
  const ascending = (a: number, b: number): number => a - b;
  return [...members.values()]
    .map((cluster) => ({
      localRows: [...cluster.localRows].sort(ascending),
      partnerRows: [...cluster.partnerRows].sort(ascending),
    }))
    .sort((a, b) => a.localRows[0] - b.localRows[0]);
}

// --- the fixtures -------------------------------------------------------------

interface Fixture {
  readonly what: string;
  readonly starterKeys: Array<Column>;
  readonly joinerKeys: Array<Column>;
}

const FIXTURES: ReadonlyArray<Fixture> = [
  {
    // The multiplicity running both ways at once, which is what the both-sided
    // cardinality adds and the differential vectors owe: the starter's row 0
    // reaches two of the joiner's records through its two candidates, and the
    // joiner's row 0 reaches two of the starter's through its own.
    what: "candidates crossing in both directions",
    starterKeys: [[new Set(["ab", "cd"]), "cd", "ef"]],
    joinerKeys: [[new Set(["ab", "ef"]), "ab", "cd"]],
  },
  {
    // The smallest chained cluster the spec fixes (The smallest chained
    // cluster): three pairs where the 2 x 2 product would hold four, and the
    // starter's row 1 and the joiner's row 0 stand in one cluster sharing no
    // value.
    what: "the smallest chained cluster",
    starterKeys: [[new Set(["ab", "cd"]), "cd"]],
    joinerKeys: [["ab", "cd"]],
  },
  {
    // Duplicates on both sides of one candidate set: a value two of each
    // party's records hold, reached by a third record through its second
    // candidate.
    what: "a duplicated value a candidate set reaches",
    starterKeys: [["ab", "ab", new Set(["ab", "cd"])]],
    joinerKeys: [["ab", "ab", "cd"]],
  },
  {
    // Two rounds: the second key's blocks form only among the records the first
    // left in candidacy, so no cluster reaches across the two.
    what: "two rounds, with removal between them",
    starterKeys: [
      [new Set(["ab", "cd"]), undefined, "ef"],
      ["gh", "gh", "gh"],
    ],
    joinerKeys: [
      ["ab", "ef", undefined],
      ["gh", "gh", "gh"],
    ],
  },
  {
    // A candidate set on one party only, with the other holding duplicates: the
    // widening on each axis at once, where neither alone produces a chain.
    what: "one party's candidate set against the other's duplicates",
    starterKeys: [[new Set(["ab", "cd"]), "ef"]],
    joinerKeys: [["ab", "cd", "cd"]],
  },
];

async function runCascade(
  starterKeys: Array<Column>,
  joinerKeys: Array<Column>,
): Promise<[AssociationTable, AssociationTable]> {
  const [starterConn, joinerConn] = createMessagePipe();
  const keyWidths = declaredKeyWidths(starterKeys, joinerKeys);
  const tables = await Promise.all([
    linkViaPSI(
      { cardinality: "many-to-many" },
      makeParticipant("starter"),
      starterConn,
      starterKeys,
      candidateSetBounds(joinerKeys[0].length, keyWidths),
      -1,
    ),
    linkViaPSI(
      { cardinality: "many-to-many" },
      makeParticipant("joiner"),
      joinerConn,
      joinerKeys,
      candidateSetBounds(starterKeys[0].length, keyWidths),
      -1,
    ),
  ]);
  await starterConn.close();
  return tables;
}

for (const fixture of FIXTURES) {
  test(`both parties resolve ${fixture.what} to the specified pair set`, async () => {
    const expected = oraclePairs(fixture.starterKeys, fixture.joinerKeys);
    // Non-vacuity: a fixture whose oracle is empty would pass every assertion
    // below without the resolution pairing anything.
    expect(expected.length).toBeGreaterThan(0);

    const [starter, joiner] = await runCascade(
      fixture.starterKeys,
      fixture.joinerKeys,
    );
    // The two parties resolving one fixture differently is a verification
    // failure rather than a degraded match, so both halves are asserted against
    // the oracle rather than against each other alone.
    expect(pairsOf(starter, false)).toEqual(expected);
    expect(pairsOf(joiner, true)).toEqual(expected);

    // The same inputs with the PSI roles exchanged: which party opens the
    // exchange decides whose set is permuted and whose positions are read, and
    // the two assignments owe the one table.
    const [mirroredStarter, mirroredJoiner] = await runCascade(
      fixture.joinerKeys,
      fixture.starterKeys,
    );
    expect(pairsOf(mirroredStarter, true)).toEqual(expected);
    expect(pairsOf(mirroredJoiner, false)).toEqual(expected);

    // The clusters each party derives, against components computed from the
    // oracle's pairs: a cluster set disagreeing with the table it came from is
    // what this catches.
    const clusters = oracleClusters(expected);
    expect(entityClusters(starter)).toEqual(clusters);
    expect(entityClusters(joiner)).toEqual(
      oracleClusters(expected.map(([s, j]): Pair => [j, s])),
    );
  });
}

test("the chained cluster holds three pairs over four records", async () => {
  // The spec's own smallest case, read as the closure rather than as a pair
  // set: one cluster of two records a side, holding three pairs where the
  // product would hold four, and joining a record of each party that shares no
  // value (docs/spec/PROTOCOL.md, The smallest chained cluster).
  const [starter, joiner] = await runCascade(
    [[new Set(["ab", "cd"]), "cd"]],
    [["ab", "cd"]],
  );

  expect(pairsOf(starter, false)).toEqual([
    [0, 0],
    [0, 1],
    [1, 1],
  ]);
  expect(entityClusters(starter)).toEqual([
    { localRows: [0, 1], partnerRows: [0, 1] },
  ]);
  expect(entityClusters(joiner)).toEqual([
    { localRows: [0, 1], partnerRows: [0, 1] },
  ]);
});
