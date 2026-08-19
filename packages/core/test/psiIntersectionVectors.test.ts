import { readFileSync } from "node:fs";

import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import { PSIParticipant } from "../src/participant";
import { linkViaPSI } from "../src/link";
import { createMessagePipe } from "../src/connection/messageConnection";
import type { AssociationTable } from "../src/types";
import { sortAssociationTable } from "../src/testing";
import { UNBOUNDED_PSI_ELEMENTS } from "./utils/psiElementBounds";

// Resolved intersection-and-association known-answer anchor for the vendored
// @openmined/psi.js engine. psi-intersection-vectors.json holds every scenario
// the matching cascade has to get right -- the empty-round and empty-key cases,
// which live here alone, alongside the projections psiParticipant.test.ts,
// psiLink.test.ts, and psiLinkForLinkageKeys.test.ts exercise from the API side
// -- in one portable fork-bump gate: this test replays each scenario against the
// vendored engine and pins both the intersection membership and the
// association/permutation mapping back to original input rows, so a fork re-roll
// or an accidental engine swap that silently permutes or corrupts the mapping
// fails here deterministically. This is the CORRECTNESS anchor; the byte-for-byte
// anchor lives in psiEngineWireVectors.test.ts. Regenerate the fixture with
// generate-psi-intersection-vectors.mjs in the vectors directory.
//
// This gate runs against the default WASM engine only; a native-backend replay
// is intentionally omitted because the projection is data-defined -- any correct
// engine build reproduces it -- and the native addon is already anchored
// byte-for-byte in psiEngineWireVectorsNative.test.ts and behaviorally (the
// identify-intersection scenario, cross-backend) in psiParticipantNativeParity.test.ts.
//
// Scope caveat for a re-roller: a green run means the engine still computes
// linkage CORRECTLY, not that a re-rolled or swapped engine is SECURE. It does
// not verify no-leakage-beyond-the-intersection, malicious-security, or byte
// interop, and does not replace the @openmined/psi.js security review
// CONTRIBUTING.md's Cryptographic-dependencies rule requires.

type Table = [number[], number[]];
type Cardinality =
  "one-to-one" | "one-to-many" | "many-to-one" | "many-to-many";

interface IdentifyVector {
  name: string;
  description: string;
  method: "identifyIntersection";
  starterInputs: string[];
  joinerInputs: string[];
  starter: Table;
  joiner: Table;
}

interface LinkVector {
  name: string;
  description: string;
  method: "linkViaPSI";
  cardinality: Cardinality;
  // undefined inputs (the no-key sentinel) serialize as JSON null.
  starterKeys: Array<Array<string | null>>;
  joinerKeys: Array<Array<string | null>>;
  starter: Table;
  joiner: Table;
}

type Vector = IdentifyVector | LinkVector;

interface IntersectionVectors {
  vectors: Vector[];
}

const { vectors }: IntersectionVectors = JSON.parse(
  readFileSync(
    new URL("./vectors/psi-intersection-vectors.json", import.meta.url),
    "utf-8",
  ),
);

const psiLibrary = await PSI();

function makeParticipant(role: "starter" | "joiner"): PSIParticipant {
  return new PSIParticipant(
    role,
    psiLibrary,
    { role, verbose: -1 },
    UNBOUNDED_PSI_ELEMENTS,
  );
}

// Both parties run concurrently over one in-memory pipe, then each side's raw
// table is normalized the same way the source inline tests do: the starter sorted
// ascending by its local index, the joiner sorted ascending by its partner index,
// so the two align index-for-index.
async function runIdentify(
  v: IdentifyVector,
): Promise<[AssociationTable, AssociationTable]> {
  const [starterConn, joinerConn] = createMessagePipe();
  const [starterResult, joinerResult] = await Promise.all([
    makeParticipant("starter").identifyIntersection(
      starterConn,
      v.starterInputs,
    ),
    makeParticipant("joiner").identifyIntersection(joinerConn, v.joinerInputs),
  ]);
  return [
    sortAssociationTable(starterResult),
    sortAssociationTable(joinerResult, true),
  ];
}

const withUndefined = (
  rounds: Array<Array<string | null>>,
): Array<Array<string | undefined>> =>
  rounds.map((round) => round.map((value) => value ?? undefined));

async function runLink(
  v: LinkVector,
): Promise<[AssociationTable, AssociationTable]> {
  const [starterConn, joinerConn] = createMessagePipe();
  const [starterResult, joinerResult] = await Promise.all([
    linkViaPSI(
      { cardinality: v.cardinality },
      makeParticipant("starter"),
      starterConn,
      withUndefined(v.starterKeys),
      v.joinerKeys[0].length,
      -1,
    ),
    linkViaPSI(
      { cardinality: v.cardinality },
      makeParticipant("joiner"),
      joinerConn,
      withUndefined(v.joinerKeys),
      v.starterKeys[0].length,
      -1,
    ),
  ]);
  return [
    sortAssociationTable(starterResult),
    sortAssociationTable(joinerResult, true),
  ];
}

test("the fixture covers every scenario", () => {
  // A guard against a silently truncated regeneration: every scenario is
  // represented, so dropping one from the generator fails here rather than
  // quietly narrowing the anchor.
  expect(vectors.map((v) => v.name)).toStrictEqual([
    "identify-intersection-names",
    "cascade-two-key-value-contention",
    "cascade-survivor-relative-uniqueness",
    "cascade-multi-key-standardized",
    "empty-round-joiner-fully-matched",
    "empty-round-starter-fully-matched",
    "empty-round-both-fully-matched",
    "empty-key-singleton-empty-string-matches",
    "empty-key-duplicated-empty-string-dropped",
    "empty-key-all-empty-column-no-match",
    "empty-key-carried-forward-later-round",
    "empty-key-duplicate-dropped-unique-still-matches",
    "many-to-one-duplicate-entity-cascade",
  ]);
});

for (const vector of vectors) {
  test(`vendored engine reproduces the pinned projection: ${vector.name}`, async () => {
    const [starter, joiner] =
      vector.method === "identifyIntersection"
        ? await runIdentify(vector)
        : await runLink(vector);

    // The live engine reproduces both the intersection membership and the
    // association mapping committed to the fixture.
    expect(starter).toStrictEqual(vector.starter);
    expect(joiner).toStrictEqual(vector.joiner);

    // The live starter and joiner agree: the starter's local indices are the
    // joiner's partner indices and vice versa -- the "server and client yield
    // identical results" invariant, asserted on the live tables rather than the
    // committed fixture, so a broken engine that desyncs the two sides fails here.
    expect(starter[0]).toStrictEqual(joiner[1]);
    expect(starter[1]).toStrictEqual(joiner[0]);
  });
}
