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
