import { expect, test, vi } from "vitest";

import PSI from "@openmined/psi.js";

// This corpus runs at the link boundary, below every terms-level refusal, with
// the strategy allowlist held open so a fixture reads the resolution rather
// than an entry (CANDIDATE_SET_IMPLEMENTED_BY_STRATEGY, linkageTermsPolicy.ts).
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
import { UNBOUNDED_PSI_ELEMENTS } from "../utils/psiElementBounds";
import { recordingConnection } from "../utils/recordingConnection";
import {
  candidateSetBounds,
  declaredKeyWidths,
  mirrorCardinality,
  type Column,
} from "../utils/candidateSetBounds";

// The conformance corpus over ragged and fanned-out inputs together that
// docs/spec/PROTOCOL.md requires (What the cascade realization owes), asserting
// for every fixture the one verdict the specification admits: both parties
// resolving, each party's table equal to the one single-pass computes on the
// same inputs. No shape the sweep resolves is refused, so a refusal anywhere in
// the corpus is a failure.
//
// Every fixture also runs with the two parties' roles exchanged, since which
// party opens the PSI exchange decides which one permutes its own set and
// which reads the other's positions. The two assignments owe the same table,
// read from the other side.

const psiLibrary = await PSI();

// Enough fixtures to reach the ragged and fanned-out shapes together many times
// over at the row counts and alphabet below, and to keep reaching them as the
// generator is widened.
const CORPUS_SIZE = 700;

function makeParticipant(role: "starter" | "joiner"): PSIParticipant {
  return new PSIParticipant(
    role === "starter" ? "server" : "client",
    psiLibrary,
    { role, verbose: -1 },
    UNBOUNDED_PSI_ELEMENTS,
  );
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Fixture {
  readonly cardinality: LinkageCardinality;
  readonly starterKeys: Array<Column>;
  readonly joinerKeys: Array<Column>;
}

// `many-to-many` is left out: it takes obligations of its own rather than this
// corpus's, the round-diagonal closure check over the table each strategy
// resolves and differential vectors of its own (docs/spec/PROTOCOL.md, What the
// cascade realization owes), which strategyDifferentialVectors.test.ts drives.
const CARDINALITIES: ReadonlyArray<LinkageCardinality> = [
  "one-to-one",
  "many-to-one",
  "one-to-many",
];

// A small value alphabet against a widish row count, so a value recurs within
// one party by construction rather than by luck: that is what puts several
// records behind one position on a deduplicating party, which is the ragged
// half of the shape. The fan-out half is the candidate SET a row may hold.
function randomColumn(
  rand: () => number,
  rows: number,
  alphabet: number,
): Column {
  const column: Column = [];
  for (let row = 0; row < rows; ++row) {
    const width = Math.floor(rand() * 4);
    if (width === 0) {
      column.push(undefined);
      continue;
    }
    const chosen = new Set<string>();
    for (let k = 0; k < width; ++k)
      chosen.add(`V${Math.floor(rand() * alphabet)}`);
    column.push(chosen.size === 1 ? [...chosen][0] : chosen);
  }
  return column;
}

function randomCorpus(count: number): Array<Fixture> {
  const rand = mulberry32(0x0ca5cade);
  const corpus: Array<Fixture> = [];
  for (let f = 0; f < count; ++f) {
    const keys = 1 + Math.floor(rand() * 2);
    const alphabet = 2 + Math.floor(rand() * 3);
    const starterRows = 1 + Math.floor(rand() * 4);
    const joinerRows = 1 + Math.floor(rand() * 4);
    const cardinality =
      CARDINALITIES[Math.floor(rand() * CARDINALITIES.length)];
    const starterKeys: Array<Column> = [];
    const joinerKeys: Array<Column> = [];
    for (let key = 0; key < keys; ++key) {
      starterKeys.push(randomColumn(rand, starterRows, alphabet));
      joinerKeys.push(randomColumn(rand, joinerRows, alphabet));
    }
    corpus.push({ cardinality, starterKeys, joinerKeys });
  }
  return corpus;
}

// The same input with the PSI roles exchanged: the party that opens the
// exchange takes the joiner's columns, and each party's cardinality follows
// its columns.
function mirroredAssignment(fixture: Fixture): Fixture {
  return {
    cardinality: mirrorCardinality(fixture.cardinality),
    starterKeys: fixture.joinerKeys,
    joinerKeys: fixture.starterKeys,
  };
}

function describeFixture(fixture: Fixture): string {
  const cell = (value: string | Set<string> | undefined): string =>
    value === undefined
      ? "_"
      : typeof value === "string"
        ? value
        : `{${[...value].join(",")}}`;
  const side = (keys: Array<Column>): string =>
    keys.map((column) => column.map(cell).join(" ")).join(" | ");
  return (
    `${fixture.cardinality} [${side(fixture.starterKeys)}] vs ` +
    `[${side(fixture.joinerKeys)}]`
  );
}

// The pair order the PSI library returns an intersection in varies run to run,
// so two tables are compared as the SET of pairs they hold rather than as the
// order either run happened to produce.
function canonicalPairs(table: AssociationTable): string {
  return JSON.stringify(
    table[0]
      .map((local, i): [number, number] => [local, table[1][i]])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]),
  );
}

// The same pairs read from the other side, which is the form the party holding
// these rows under the mirrored assignment states them in.
function flippedPairs(table: AssociationTable): string {
  return canonicalPairs([table[1], table[0]]);
}

// A frame of the mapped-element exchange: the entries a party states for its
// own matched records. Nothing else a linkage round sends is an array of
// objects.
function holdsMappedElements(frame: unknown): boolean {
  return (
    Array.isArray(frame) &&
    frame.length > 0 &&
    frame.every(
      (entry) =>
        typeof entry === "object" && entry !== null && "theirIndex" in entry,
    )
  );
}

// A party that neither resolves nor refuses is the failure this corpus exists
// to catch, so each one is bounded rather than left to stall the whole run.
const PARTY_SETTLE_MS = 20_000;

function settled<T>(run: Promise<T>, label: string): Promise<T | unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<unknown>((resolve) => {
    timer = setTimeout(
      () => resolve(new Error(`${label} never settled`)),
      PARTY_SETTLE_MS,
    );
  });
  return Promise.race([
    run.then(
      (value) => value,
      (err: unknown) => err,
    ),
    stalled,
  ]).finally(() => clearTimeout(timer));
}

interface CascadeOutcome {
  readonly starter: unknown;
  readonly joiner: unknown;
  readonly starterSent: Array<unknown>;
  readonly joinerSent: Array<unknown>;
}

async function runCascade(fixture: Fixture): Promise<CascadeOutcome> {
  const [starterConn, joinerConn] = createMessagePipe();
  const starterRecorder = recordingConnection(starterConn);
  const joinerRecorder = recordingConnection(joinerConn);
  const keyWidths = declaredKeyWidths(fixture.starterKeys, fixture.joinerKeys);
  const [starter, joiner] = await Promise.all([
    settled(
      linkViaPSI(
        { cardinality: fixture.cardinality },
        makeParticipant("starter"),
        starterRecorder.conn,
        fixture.starterKeys,
        candidateSetBounds(fixture.joinerKeys[0].length, keyWidths),
        -1,
      ),
      "the cascade starter",
    ),
    settled(
      linkViaPSI(
        { cardinality: mirrorCardinality(fixture.cardinality) },
        makeParticipant("joiner"),
        joinerRecorder.conn,
        fixture.joinerKeys,
        candidateSetBounds(fixture.starterKeys[0].length, keyWidths),
        -1,
      ),
      "the cascade joiner",
    ),
  ]);
  await starterConn.close();
  return {
    starter,
    joiner,
    starterSent: starterRecorder.sent,
    joinerSent: joinerRecorder.sent,
  };
}

async function runSinglePass(
  fixture: Fixture,
): Promise<{ starter: unknown; joiner: unknown }> {
  const [starterConn, joinerConn] = createMessagePipe();
  const keyWidths = declaredKeyWidths(fixture.starterKeys, fixture.joinerKeys);
  const [starter, joiner] = await Promise.all([
    settled(
      linkViaSinglePassPSI(
        { cardinality: fixture.cardinality },
        makeParticipant("starter"),
        starterConn,
        fixture.starterKeys,
        {
          ...candidateSetBounds(fixture.joinerKeys[0].length, keyWidths),
          localFanOutFactor: 1,
        },
        false,
        -1,
      ),
      "the single-pass starter",
    ),
    settled(
      linkViaSinglePassPSI(
        { cardinality: mirrorCardinality(fixture.cardinality) },
        makeParticipant("joiner"),
        joinerConn,
        fixture.joinerKeys,
        {
          ...candidateSetBounds(fixture.starterKeys[0].length, keyWidths),
          localFanOutFactor: 1,
        },
        false,
        -1,
      ),
      "the single-pass joiner",
    ),
  ]);
  await starterConn.close();
  return { starter, joiner };
}

function reportOf(outcome: unknown): string {
  return outcome instanceof Error
    ? `${outcome.constructor.name}: ${outcome.message}`
    : JSON.stringify(outcome);
}

test(
  "every ragged fan-out fixture resolves to the table single-pass computes",
  { timeout: 600_000 },
  async () => {
    const problems: Array<string> = [];
    let resolvedFixtures = 0;
    let fixturesStatingMappedElements = 0;

    for (const fixture of randomCorpus(CORPUS_SIZE)) {
      const where = describeFixture(fixture);
      const cascade = await runCascade(fixture);
      const mirrored = await runCascade(mirroredAssignment(fixture));
      if (cascade.starter instanceof Error || cascade.joiner instanceof Error) {
        problems.push(
          `${where}: starter ${reportOf(cascade.starter)}, joiner ` +
            reportOf(cascade.joiner),
        );
        continue;
      }
      if (
        mirrored.starter instanceof Error ||
        mirrored.joiner instanceof Error
      ) {
        problems.push(
          `${where}: with the roles exchanged, starter ` +
            `${reportOf(mirrored.starter)}, joiner ${reportOf(mirrored.joiner)}`,
        );
        continue;
      }
      ++resolvedFixtures;
      if (
        cascade.starterSent.some(holdsMappedElements) &&
        cascade.joinerSent.some(holdsMappedElements)
      )
        ++fixturesStatingMappedElements;

      const single = await runSinglePass(fixture);
      if (single.starter instanceof Error || single.joiner instanceof Error) {
        problems.push(`${where}: single-pass ${reportOf(single.starter)}`);
        continue;
      }
      const cascadeTables = [
        canonicalPairs(cascade.starter as AssociationTable),
        canonicalPairs(cascade.joiner as AssociationTable),
      ];
      const singleTables = [
        canonicalPairs(single.starter as AssociationTable),
        canonicalPairs(single.joiner as AssociationTable),
      ];
      if (cascadeTables[0] !== singleTables[0])
        problems.push(
          `${where}: starter cascade ${cascadeTables[0]} vs single-pass ` +
            singleTables[0],
        );
      if (cascadeTables[1] !== singleTables[1])
        problems.push(
          `${where}: joiner cascade ${cascadeTables[1]} vs single-pass ` +
            singleTables[1],
        );

      const mirroredTables = [
        canonicalPairs(mirrored.starter as AssociationTable),
        canonicalPairs(mirrored.joiner as AssociationTable),
      ];
      if (
        mirroredTables[0] !== flippedPairs(cascade.starter as AssociationTable)
      )
        problems.push(
          `${where}: with the roles exchanged, starter ${mirroredTables[0]} ` +
            `vs ${flippedPairs(cascade.starter as AssociationTable)}`,
        );
      if (
        mirroredTables[1] !== flippedPairs(cascade.joiner as AssociationTable)
      )
        problems.push(
          `${where}: with the roles exchanged, joiner ${mirroredTables[1]} ` +
            `vs ${flippedPairs(cascade.joiner as AssociationTable)}`,
        );
    }

    expect(problems).toStrictEqual([]);
    // Every fixture resolves: no shape the sweep reaches is refused, and the
    // count is the corpus size rather than a floor, so a fixture that stopped
    // resolving would fail here even if it also stopped being compared.
    expect(resolvedFixtures).toBe(CORPUS_SIZE);
    // Non-vacuity on the mapped-element frames, which a fixture matching
    // nothing puts on neither wire.
    expect(fixturesStatingMappedElements).toBeGreaterThan(0);
  },
);
