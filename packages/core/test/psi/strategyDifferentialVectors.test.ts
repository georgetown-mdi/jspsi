import { expect, test, vi } from "vitest";

import PSI from "@openmined/psi.js";

// The cascade's candidate-set resolution is built behind the strategy
// allowlist (CANDIDATE_SET_IMPLEMENTED_BY_STRATEGY, linkageTermsPolicy.ts).
// These vectors run at the link boundary, below every terms-level refusal.
vi.mock("../../src/linkageTermsPolicy", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../src/linkageTermsPolicy")>();
  return { ...original, candidateSetIsImplementedForStrategy: () => true };
});

import { PSIParticipant } from "../../src/psi/participant";
import {
  linkViaPSI,
  linkViaSinglePassPSI,
  type LinkageCardinality,
} from "../../src/psi/link";
import { createMessagePipe } from "../../src/connection/messageConnection";
import type { AssociationTable } from "../../src/types";
import { sortAssociationTable } from "../../src/testing";
import { UNBOUNDED_PSI_ELEMENTS } from "../utils/psiElementBounds";
import {
  candidateSetBounds,
  declaredKeyWidths,
  mirrorCardinality,
  type Column,
} from "../utils/candidateSetBounds";
import { entityClusters } from "../../src/psi/entityClosure";

// The closure step every reader of a both-sided table runs locally over it, so
// a table asserted equal between the strategies is asserted equal in the
// clusters its readers derive as well.
const clustersOf = (table: AssociationTable) => entityClusters(table);

// The differential conformance vectors docs/spec/PROTOCOL.md requires as a
// MUST (What the cascade realization owes): fixed inputs run through BOTH
// strategies, the two association tables asserted equal. The cascade reaches
// the table by each party resolving its own round from the two groupings the
// round's frames hold, single-pass by its receiver resolving alone, so an
// equality here is the property the shared sweep exists to hold.

const psiLibrary = await PSI();

function makeParticipant(role: "starter" | "joiner"): PSIParticipant {
  return new PSIParticipant(
    role === "starter" ? "server" : "client",
    psiLibrary,
    { role, verbose: -1 },
    UNBOUNDED_PSI_ELEMENTS,
  );
}

type Tables = [AssociationTable, AssociationTable];

async function runCascade(
  cardinality: LinkageCardinality,
  starterKeys: Array<Column>,
  joinerKeys: Array<Column>,
): Promise<Tables> {
  const [starterConn, joinerConn] = createMessagePipe();
  const keyWidths = declaredKeyWidths(starterKeys, joinerKeys);
  const [starter, joiner] = await Promise.all([
    linkViaPSI(
      { cardinality },
      makeParticipant("starter"),
      starterConn,
      starterKeys,
      candidateSetBounds(joinerKeys[0].length, keyWidths),
      -1,
    ),
    linkViaPSI(
      { cardinality: mirrorCardinality(cardinality) },
      makeParticipant("joiner"),
      joinerConn,
      joinerKeys,
      candidateSetBounds(starterKeys[0].length, keyWidths),
      -1,
    ),
  ]);
  return [sortAssociationTable(starter), sortAssociationTable(joiner)];
}

async function runSinglePass(
  cardinality: LinkageCardinality,
  starterKeys: Array<Column>,
  joinerKeys: Array<Column>,
): Promise<Tables> {
  const [starterConn, joinerConn] = createMessagePipe();
  const keyWidths = declaredKeyWidths(starterKeys, joinerKeys);
  const [starter, joiner] = await Promise.all([
    linkViaSinglePassPSI(
      { cardinality },
      makeParticipant("starter"),
      starterConn,
      starterKeys,
      {
        ...candidateSetBounds(joinerKeys[0].length, keyWidths),
        localFanOutFactor: 1,
      },
      false,
      -1,
    ),
    linkViaSinglePassPSI(
      { cardinality: mirrorCardinality(cardinality) },
      makeParticipant("joiner"),
      joinerConn,
      joinerKeys,
      {
        ...candidateSetBounds(starterKeys[0].length, keyWidths),
        localFanOutFactor: 1,
      },
      false,
      -1,
    ),
  ]);
  return [sortAssociationTable(starter), sortAssociationTable(joiner)];
}

// Runs one vector through both strategies in BOTH role assignments, since the
// sweep's order is role-derived and the two must reach the same records either
// way. The mirrored run's tables are the originals with the two halves and the
// two parties exchanged, which is asserted rather than assumed.
async function expectStrategiesAgree(
  cardinality: LinkageCardinality,
  starterKeys: Array<Column>,
  joinerKeys: Array<Column>,
): Promise<Tables> {
  const [cascadeStarter, cascadeJoiner] = await runCascade(
    cardinality,
    starterKeys,
    joinerKeys,
  );
  const [singlePassStarter, singlePassJoiner] = await runSinglePass(
    cardinality,
    starterKeys,
    joinerKeys,
  );
  expect(singlePassStarter).toStrictEqual(cascadeStarter);
  expect(singlePassJoiner).toStrictEqual(cascadeJoiner);

  const mirrored = mirrorCardinality(cardinality);
  const [swappedCascadeStarter, swappedCascadeJoiner] = await runCascade(
    mirrored,
    joinerKeys,
    starterKeys,
  );
  const [swappedSinglePassStarter, swappedSinglePassJoiner] =
    await runSinglePass(mirrored, joinerKeys, starterKeys);
  expect(swappedSinglePassStarter).toStrictEqual(swappedCascadeStarter);
  expect(swappedSinglePassJoiner).toStrictEqual(swappedCascadeJoiner);
  // The same records, whichever party took which role.
  expect(swappedCascadeStarter).toStrictEqual(cascadeJoiner);
  expect(swappedCascadeJoiner).toStrictEqual(cascadeStarter);

  return [cascadeStarter, cascadeJoiner];
}

test("one-to-one, the normative double-match case", async () => {
  const [starter, joiner] = await expectStrategiesAgree(
    "one-to-one",
    [[new Set(["ab", "cd"]), new Set(["ef"])]],
    [["ab", new Set(["cd", "ef"])]],
  );
  expect(starter).toStrictEqual([
    [0, 1],
    [0, 1],
  ]);
  expect(joiner).toStrictEqual([
    [0, 1],
    [0, 1],
  ]);
});

test("one-to-one, a candidate set across two keys with removal in between", async () => {
  // Round 1 leaves a record contradicted rather than matched; round 2 must not
  // pick it up. Both strategies compute the same removal set.
  await expectStrategiesAgree(
    "one-to-one",
    [
      [new Set(["p", "q"]), "z"],
      ["late", "late"],
    ],
    [
      ["p", "q"],
      ["late", "other"],
    ],
  );
});

test("one-to-one, the within-round shared-value drop", async () => {
  await expectStrategiesAgree(
    "one-to-one",
    [[new Set(["shared", "only-mine"]), new Set(["shared", "unmatched"])]],
    [["only-mine", "shared"]],
  );
});

test("many-to-one, a candidate set on the many side", async () => {
  // The starter deduplicates AND fans out, so one of its matched positions is
  // owned by several records while one of its records owns several positions:
  // the ragged owner-list grouping, which run lengths cannot state.
  const [starter, joiner] = await expectStrategiesAgree(
    "many-to-one",
    [[new Set(["E1", "alt"]), "E1", "E2"]],
    [["E1", "E2", "X"]],
  );
  expect(starter).toStrictEqual([
    [0, 1, 2],
    [0, 0, 1],
  ]);
  expect(joiner).toStrictEqual([
    [0, 0, 1],
    [0, 1, 2],
  ]);
});

test("many-to-one, the many side's extra candidate reaching a second partner record", async () => {
  const [starter] = await expectStrategiesAgree(
    "many-to-one",
    [[new Set(["E1", "E2"]), "E1"]],
    [["E1", "E2"]],
  );
  expect(starter).toStrictEqual([
    [0, 1],
    [0, 0],
  ]);
});

test("many-to-one, the one side keeps its own within-round uniqueness rule", async () => {
  await expectStrategiesAgree(
    "many-to-one",
    [[new Set(["U", "V"]), "U"]],
    [["D", "D", "U"]],
  );
});

// The two shapes the widened mapped-element entry exists for, which the spec
// makes normative in both role assignments (docs/spec/PROTOCOL.md, Two cases a
// deduplicating cardinality adds). Each names positions no single canonical one
// could stand in for, so each is where the entry's set form is what keeps the
// two strategies equal.

test("many-to-one, a record accepted against two of the partner's groups", async () => {
  // The "one" side's record matches both of the many side's records, holding
  // different values: the relaxed acceptance clause stops only the many side
  // from repeating, so its entry names both positions and comes back as two
  // rows.
  const [starter, joiner] = await expectStrategiesAgree(
    "many-to-one",
    [["a", "b"]],
    [[new Set(["a", "b"])]],
  );
  expect(starter).toStrictEqual([
    [0, 1],
    [0, 0],
  ]);
  expect(joiner).toStrictEqual([
    [0, 0],
    [0, 1],
  ]);
});

test("many-to-one, a group split across two of the one side's records", async () => {
  // The many side's position for "ab" is owned by both its records; the sweep
  // accepts one of them on a value of its own earlier, so the entry naming that
  // position stands for the record accepted with it alone, not the group.
  const [starter, joiner] = await expectStrategiesAgree(
    "many-to-one",
    [[new Set(["ab", "cd"]), "ab"]],
    [["cd", "ab"]],
  );
  expect(starter).toStrictEqual([
    [0, 1],
    [0, 1],
  ]);
  expect(joiner).toStrictEqual([
    [0, 1],
    [0, 1],
  ]);
});

test("many-to-one, two accepted records of the many side sharing a position", async () => {
  // "V2" is the lowest matched position of both of the many side's records, so
  // one canonical position per accepted record could not tell them apart.
  const [starter, joiner] = await expectStrategiesAgree(
    "many-to-one",
    [[new Set(["V2", "V1"]), new Set(["V0", "V2"])]],
    [["V1", "V0", "V2"]],
  );
  expect(starter).toStrictEqual([
    [0, 1],
    [0, 1],
  ]);
  expect(joiner).toStrictEqual([
    [0, 1],
    [0, 1],
  ]);
});

// The both-sided cardinality, where each party keeps the duplicates of its own
// records and a matched value stands for a group on each side. The pair set is
// the two groups' product, and the entity closure both strategies own is read
// off the one table -- so an equality here is the closure agreeing cluster for
// cluster as well as pair for pair.

test("many-to-many, a value both sides hold twice", async () => {
  const [starter, joiner] = await expectStrategiesAgree(
    "many-to-many",
    [["E1", "E1", "S"]],
    [["E1", "E1", "J"]],
  );
  // Every one of the four pairs between the two groups, and nothing else.
  expect(starter).toStrictEqual([
    [0, 0, 1, 1],
    [0, 1, 0, 1],
  ]);
  expect(joiner).toStrictEqual(starter);
  expect(clustersOf(starter)).toStrictEqual([
    { localRows: [0, 1], partnerRows: [0, 1] },
  ]);
});

test("many-to-many, groups of different sizes contribute their product", async () => {
  const [starter, joiner] = await expectStrategiesAgree(
    "many-to-many",
    [["E1", "E1", "E1"]],
    [["E1", "E1"]],
  );
  expect(starter).toStrictEqual([
    [0, 0, 1, 1, 2, 2],
    [0, 1, 0, 1, 0, 1],
  ]);
  expect(joiner).toStrictEqual([
    [0, 0, 0, 1, 1, 1],
    [0, 1, 2, 0, 1, 2],
  ]);
});

test("many-to-many, a candidate set joining two of a round's blocks", async () => {
  // The shape the block-diagonal derivation does not reach on its own: one
  // record's candidate set stands in two of the round's blocks, so the two
  // blocks are one cluster. Both strategies reach the same cluster, which is
  // what the closure is asserted on rather than the pair count alone.
  const [starter, joiner] = await expectStrategiesAgree(
    "many-to-many",
    [[new Set(["E1", "E2"]), "E2", "S"]],
    [["E1", "E1", "E2"]],
  );
  expect(clustersOf(starter)).toStrictEqual([
    { localRows: [0, 1], partnerRows: [0, 1, 2] },
  ]);
  expect(clustersOf(joiner)).toStrictEqual([
    { localRows: [0, 1, 2], partnerRows: [0, 1] },
  ]);
});

test("many-to-many, a second key forms a block of its own", async () => {
  // Multiplicity is within-round on both strategies: the records the first key
  // paired leave candidacy, so the second key's block holds only what is left
  // and no cluster spans the two rounds.
  const [starter, joiner] = await expectStrategiesAgree(
    "many-to-many",
    [
      ["E1", "E1", "S"],
      ["L", "L", "L"],
    ],
    [
      ["E1", "J", "J2"],
      ["L", "L", "L"],
    ],
  );
  expect(clustersOf(starter)).toStrictEqual([
    { localRows: [0, 1], partnerRows: [0] },
    { localRows: [2], partnerRows: [1, 2] },
  ]);
  expect(clustersOf(joiner)).toStrictEqual([
    { localRows: [0], partnerRows: [0, 1] },
    { localRows: [1, 2], partnerRows: [2] },
  ]);
});
