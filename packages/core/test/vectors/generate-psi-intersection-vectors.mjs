// Regenerates psi-intersection-vectors.json: the resolved intersection-and-
// association known-answer vectors for the vendored @openmined/psi.js engine as
// psilink drives it. Run from the repo root:
//
//   npm run build -w packages/core   # the generator imports the built dist below
//   node packages/core/test/vectors/generate-psi-intersection-vectors.mjs
//   npm run format                   # apply the repo's JSON layout
//
// Purpose: hold in one explicit, portable fixture the intersection membership and
// the association/permutation mapping back to original input rows for every
// scenario psilink's matching cascade has to get right -- the empty-round and
// empty-key scenarios pinned nowhere else, plus the projections
// psiParticipant.test.ts, psiLink.test.ts, and psiLinkForLinkageKeys.test.ts
// exercise from the API side. A fork re-roll or an accidental engine swap that
// silently permutes or corrupts the association mapping flips these projections
// and fails psiIntersectionVectors.test.ts deterministically in CI (no network,
// no nightly-only run).
//
// This is a CORRECTNESS anchor, distinct from the BYTE-stability anchor in
// psi-engine-wire-vectors.json. The resolved projection is defined by the DATA
// (which local row matches which partner row), not by the engine's random per-
// exchange key, so a correct engine always reproduces it. The raw association
// table row ORDER is engine-permutation-dependent, so every projection is
// normalized by sorting on the local-index array before it is pinned -- the
// sortAssociationTable normalization: the starter (PSI sender) is sorted
// ascending by its own local index, the joiner (receiver) is sorted ascending by
// its partner index (the starter's local index), so the two align and
// starter[0] === joiner[1], starter[1] === joiner[0].

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import PSI from "@openmined/psi.js";

import {
  PSIParticipant,
  createMessagePipe,
  buildStandardizedDataset,
} from "../../dist/core.esm.js";
import { StandardizedKeyIterable, linkViaPSI } from "../../dist/testing.esm.js";

// PSI element-count bounds that never reject; mirrors
// test/utils/psiElementBounds.ts. These tests exercise PSI correctness, not the
// decode-seam amplification guard, so an inert bound keeps them focused.
const UNBOUNDED_PSI_ELEMENTS = {
  setup: Number.POSITIVE_INFINITY,
  request: Number.POSITIVE_INFINITY,
  response: Number.POSITIVE_INFINITY,
};

// Mirrors sortAssociationTable in src/testing.ts. Normal sort orders the pairs by the
// local index (value[0]); reverse sort orders them by the partner index
// (value[1]) and keeps the local index alongside, so a joiner sorted in reverse
// lines up index-for-index with a starter sorted normally.
function sortAssociationTable(value, reverse) {
  return reverse
    ? value[1]
        .map((x, i) => ({ x, y: value[0][i] }))
        .sort((a, b) => a.x - b.x)
        .reduce(
          (acc, v) => {
            acc[1].push(v.x);
            acc[0].push(v.y);
            return acc;
          },
          [[], []],
        )
    : value[0]
        .map((x, i) => ({ x, y: value[1][i] }))
        .sort((a, b) => a.x - b.x)
        .reduce(
          (acc, v) => {
            acc[0].push(v.x);
            acc[1].push(v.y);
            return acc;
          },
          [[], []],
        );
}

const psi = await PSI();

function makeParticipant(role) {
  return new PSIParticipant(
    role,
    psi,
    { role, verbose: -1 },
    UNBOUNDED_PSI_ELEMENTS,
  );
}

// identifyIntersection driver: a single key round of plain strings, the
// primitive psiParticipant.test.ts exercises directly.
async function runIdentify(starterInputs, joinerInputs) {
  const [starterConn, joinerConn] = createMessagePipe();
  const [starterResult, joinerResult] = await Promise.all([
    makeParticipant("starter").identifyIntersection(starterConn, starterInputs),
    makeParticipant("joiner").identifyIntersection(joinerConn, joinerInputs),
  ]);
  return [
    sortAssociationTable(starterResult),
    sortAssociationTable(joinerResult, true),
  ];
}

// The partner's view of the same exchange. A cardinality label is read from the
// party that resolves it, so the two parties of one exchange hold mirror labels
// and a scenario pins the STARTER's; mirrors test/psiIntersectionVectors.ts.
function mirrorCardinality(cardinality) {
  return cardinality === "many-to-one"
    ? "one-to-many"
    : cardinality === "one-to-many"
      ? "many-to-one"
      : cardinality;
}

// linkViaPSI driver: a cascade of key rounds (each round an array of per-row
// string | undefined). Accepts either plain arrays or StandardizedKeyIterables,
// both of which satisfy the IndexableIterable interface linkViaPSI reads.
async function runLink(cardinality, starterKeys, joinerKeys) {
  const [starterConn, joinerConn] = createMessagePipe();
  const [starterResult, joinerResult] = await Promise.all([
    linkViaPSI(
      { cardinality },
      makeParticipant("starter"),
      starterConn,
      starterKeys,
      joinerKeys[0].length,
      -1,
    ),
    linkViaPSI(
      { cardinality: mirrorCardinality(cardinality) },
      makeParticipant("joiner"),
      joinerConn,
      joinerKeys,
      starterKeys[0].length,
      -1,
    ),
  ]);
  return [
    sortAssociationTable(starterResult),
    sortAssociationTable(joinerResult, true),
  ];
}

// -- Multi-key standardized scenario (psiLinkForLinkageKeys.test.ts) ------------
// The engine sees per-round KEY STRINGS, not raw rows; the raw-row ->
// key-string mapping is the standardization layer's concern, covered by its own
// tests. So the generator runs the standardization pipeline once to derive the
// per-round key strings, then bakes those strings into the fixture as the
// portable engine inputs. The consuming test replays them through linkViaPSI
// with no standardization dependency. Baking is proven faithful below: running
// linkViaPSI over the StandardizedKeyIterables and over the baked plain-array
// strings must yield the identical projection.

const metadata = [
  { name: "id", type: "identifier", role: "identifier", isPayload: false },
  { name: "first_name", type: "first_name", role: "linkage", isPayload: false },
  { name: "last_name", type: "last_name", role: "linkage", isPayload: false },
  { name: "ssn", type: "ssn", role: "linkage", isPayload: false },
  {
    name: "date_of_birth",
    type: "date_of_birth",
    role: "linkage",
    isPayload: false,
  },
];

const terms = {
  version: "1.0.0",
  identity: "test",
  date: "2026-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [
    { name: "ssn", type: "ssn" },
    { name: "lastName", type: "last_name" },
    { name: "firstName", type: "first_name" },
    { name: "dateOfBirth", type: "date_of_birth" },
  ],
  linkageKeys: [
    {
      name: "SSN + LN + DOB",
      elements: [
        { field: "ssn" },
        { field: "lastName" },
        { field: "dateOfBirth" },
      ],
    },
    {
      name: "SSN + LN1 + FN1",
      elements: [
        { field: "ssn" },
        {
          field: "lastName",
          transform: [
            { function: "substring", params: { start: 1, length: 1 } },
          ],
        },
        {
          field: "firstName",
          transform: [
            { function: "substring", params: { start: 1, length: 1 } },
          ],
        },
      ],
    },
  ],
};

function makeIterables(rawRows) {
  const dataset = buildStandardizedDataset(undefined, rawRows, metadata, terms);
  return terms.linkageKeys.map(
    (key) => new StandardizedKeyIterable(key, dataset, rawRows.length, false),
  );
}

const multiKeyServerRows = [
  {
    id: "159859483",
    first_name: "James",
    last_name: "HEARD",
    ssn: "559811301",
    date_of_birth: "19750716",
  },
  {
    id: "165562801",
    first_name: "Albert",
    last_name: "IORIO",
    ssn: "322842281",
    date_of_birth: "19750817",
  },
];

const multiKeyClientRows = [
  {
    id: "159859483",
    first_name: "Jim",
    last_name: "HEARD",
    ssn: "559811301",
    date_of_birth: "19750717",
  },
  {
    id: "159859483",
    first_name: "Jim",
    last_name: "HEARD",
    ssn: "559811301",
    date_of_birth: "19750716",
  },
  {
    id: "165562801",
    first_name: "Albert",
    last_name: "IORIO",
    ssn: "322842281",
    date_of_birth: "19750818",
  },
];

const multiKeyStarterKeys = makeIterables(multiKeyServerRows).map((it) => [
  ...it,
]);
const multiKeyJoinerKeys = makeIterables(multiKeyClientRows).map((it) => [
  ...it,
]);

// -- Scenario table ------------------------------------------------------------
// A scenario an API-side test also exercises names that test, so the two stay
// discoverably in step; the rest are pinned here alone. `inputs` are the exact
// engine inputs; `expect` (starter, joiner) is filled in by running the scenario
// below.
const scenarios = [
  {
    name: "identify-intersection-names",
    description:
      "PSIParticipant.identifyIntersection over a single key round of distinct " +
      "names. Source: psiParticipant.test.ts ('psi yields correct results').",
    method: "identifyIntersection",
    starterInputs: [
      "Alice",
      "Bob",
      "Carol",
      "David",
      "Elizabeth",
      "Frank",
      "Greta",
    ],
    joinerInputs: ["Carol", "Elizabeth", "Henry"],
  },
  {
    name: "cascade-two-key-value-contention",
    description:
      "linkViaPSI one-to-one, two key rounds: a name round then a value round " +
      "where within-round uniqueness among the survivors drives the second " +
      "match. Source: psiLink.test.ts ('results are correct').",
    method: "linkViaPSI",
    cardinality: "one-to-one",
    starterKeys: [
      ["Alice", "Bob", "Carol", "David", "Elizabeth", "Frank", "Greta"],
      ["1", "2", "1", "1", "1", "1", "1"],
    ],
    joinerKeys: [
      ["Carol", "Elizabeth", "Henry"],
      ["3", "3", "2"],
    ],
  },
  {
    name: "cascade-survivor-relative-uniqueness",
    description:
      "linkViaPSI one-to-one where a value duplicated across the whole dataset " +
      "('Z','Z') becomes matchable once an earlier key claims its twin -- " +
      "uniqueness is evaluated over the round's survivors, not the full dataset. " +
      "Source: psiLink.test.ts ('single-pass reproduces the cascade's " +
      "survivor-relative uniqueness'), whose cascade branch pins this projection.",
    method: "linkViaPSI",
    cardinality: "one-to-one",
    starterKeys: [
      ["A", "B"],
      ["Z", "Z"],
    ],
    joinerKeys: [
      ["A", undefined],
      [undefined, "Z"],
    ],
  },
  {
    name: "cascade-multi-key-standardized",
    description:
      "linkViaPSI one-to-one over two standardized linkage keys (SSN+LN+DOB, " +
      "then the looser SSN+LN1+FN1): row 1 matches exactly on key 1, rows 0 and " +
      "2 carry forward and match on key 2, and key 1 having consumed a shared-SSN " +
      "record forces row 2's match into key 2. The engine inputs are the per-row " +
      "key strings the standardization pipeline derives from the source rows " +
      "(baked here for portability). Source: psiLinkForLinkageKeys.test.ts.",
    method: "linkViaPSI",
    cardinality: "one-to-one",
    starterKeys: multiKeyStarterKeys,
    joinerKeys: multiKeyJoinerKeys,
  },
  {
    name: "empty-round-joiner-fully-matched",
    description:
      "linkViaPSI one-to-one: the joiner is fully matched on key 0 (its key-1 " +
      "set is empty) while the starter still holds an unmatched record. The " +
      "matching loop must still run key 1 for both parties -- skipping a " +
      "locally-empty round drops a send/receive the partner still performs and " +
      "deadlocks the lockstep exchange, so a regression hangs this vector.",
    method: "linkViaPSI",
    cardinality: "one-to-one",
    starterKeys: [
      ["Carol", "David", "Frank"],
      ["a", "b", "c"],
    ],
    joinerKeys: [
      ["Carol", "David"],
      ["x", "y"],
    ],
  },
  {
    name: "empty-round-starter-fully-matched",
    description:
      "Mirror of the above: the starter's key-1 set is empty while the joiner " +
      "still has an unmatched record, exercising the same desync in the " +
      "opposite role direction.",
    method: "linkViaPSI",
    cardinality: "one-to-one",
    starterKeys: [
      ["Carol", "David"],
      ["a", "b"],
    ],
    joinerKeys: [
      ["Carol", "David", "Henry"],
      ["x", "y", "z"],
    ],
  },
  {
    name: "empty-round-both-fully-matched",
    description:
      "linkViaPSI one-to-one: both parties fully match on key 0, so key 1 is a " +
      "no-op on both sides and must still be run by both.",
    method: "linkViaPSI",
    cardinality: "one-to-one",
    starterKeys: [
      ["Carol", "David"],
      ["a", "b"],
    ],
    joinerKeys: [
      ["Carol", "David"],
      ["x", "y"],
    ],
  },
  {
    name: "empty-key-singleton-empty-string-matches",
    description:
      "linkViaPSI one-to-one: '' is a present, matchable key distinct from " +
      "undefined (the no-key sentinel). The lone '' on each side is unique within " +
      "its dataset and matches; undefined and non-matching named rows do not.",
    method: "linkViaPSI",
    cardinality: "one-to-one",
    starterKeys: [[undefined, "", "Alice"]],
    joinerKeys: [["Bob", undefined, ""]],
  },
  {
    name: "empty-key-duplicated-empty-string-dropped",
    description:
      "linkViaPSI one-to-one: the starter has two '' values, so every '' is a " +
      "within-dataset duplicate and is dropped from the round; the joiner's " +
      "singleton '' therefore matches nothing, even though a singleton-vs-" +
      "singleton '' would match.",
    method: "linkViaPSI",
    cardinality: "one-to-one",
    starterKeys: [["", "", "Alice"]],
    joinerKeys: [["", "Bob"]],
  },
  {
    name: "empty-key-all-empty-column-no-match",
    description:
      "linkViaPSI one-to-one: every '' on both sides is a within-dataset " +
      "duplicate, so the round drops them all and produces no match.",
    method: "linkViaPSI",
    cardinality: "one-to-one",
    starterKeys: [["", ""]],
    joinerKeys: [["", "", ""]],
  },
  {
    name: "empty-key-carried-forward-later-round",
    description:
      "linkViaPSI one-to-one: row 0 matches on key 0 ('A') and is removed; row 1 " +
      "does not match on key 0 and carries forward to key 1, where both sides' " +
      "value is '' -- so the carried-forward '' matches like any other value, " +
      "rather than being treated as already matched or dropped.",
    method: "linkViaPSI",
    cardinality: "one-to-one",
    starterKeys: [
      ["A", "B"],
      ["x", ""],
    ],
    joinerKeys: [
      ["A", "Z"],
      ["y", ""],
    ],
  },
  {
    name: "empty-key-duplicate-dropped-unique-still-matches",
    description:
      "linkViaPSI one-to-one: the starter's two '' rows are dropped as " +
      "within-dataset duplicates while its unique 'Alice' still matches -- the " +
      "uniqueness rule treats '' exactly like any other value, and dropping it " +
      "does not poison the rest of the round.",
    method: "linkViaPSI",
    cardinality: "one-to-one",
    starterKeys: [["", "", "Alice"]],
    joinerKeys: [["", "Alice"]],
  },
  {
    name: "many-to-one-duplicate-entity-cascade",
    description:
      "linkViaPSI with the joiner deduplicating: it holds two intake rows for " +
      "the same entity 'E1' (a re-registered record) alongside two singleton " +
      "entities 'E2' and 'E3', against the starter's one row per entity. The " +
      "joiner is the 'many' side, so it contributes 'E1' once and round 0 " +
      "attributes the match to BOTH of its rows, where one-to-one would have " +
      "dropped the value as a within-round duplicate and left round 1's " +
      "secondary key to resolve at most one of them. The group's rows and the " +
      "starter row they link to all leave candidacy together, so round 1's " +
      "secondary key adds nothing. The starter, being the 'one' side, holds the " +
      "mirror label and its half of the table repeats row 0 against the two " +
      "joiner rows; the projections are the two views of one pairing.",
    method: "linkViaPSI",
    cardinality: "one-to-many",
    starterKeys: [
      ["E1", "E2", "E3"],
      ["C2", "x", "y"],
    ],
    joinerKeys: [
      ["E1", "E1", "E2", "E3"],
      ["C1", "C2", "x", "y"],
    ],
  },
  {
    name: "many-to-one-group-expansion-ordering",
    description:
      "linkViaPSI with the joiner deduplicating, over a dataset whose ORDER " +
      "decides the reconstructed table: the joiner's two groups interleave " +
      "across its rows ('Y' at rows 0, 2, 4 and 'X' at rows 1, 3), and its " +
      "first-occurrence set order ('Y' then 'X') is the reverse of the " +
      "starter's ('X' at row 0, 'Y' at row 1). Translating an entry whose " +
      "position stands for a group expands it into one entry per record in " +
      "ascending record order, with the groups left in the order of the list " +
      "being translated, so the starter's returned list arrives grouped by its " +
      "OWN matched records rather than by joiner row order. An implementation " +
      "that expanded in any other order reconstructs a different pairing here " +
      "and fails this vector.",
    method: "linkViaPSI",
    cardinality: "one-to-many",
    starterKeys: [["X", "Y"]],
    joinerKeys: [["Y", "X", "Y", "X", "Y"]],
  },
];

async function project(scenario) {
  return scenario.method === "identifyIntersection"
    ? runIdentify(scenario.starterInputs, scenario.joinerInputs)
    : runLink(scenario.cardinality, scenario.starterKeys, scenario.joinerKeys);
}

// Baking self-check: the standardized multi-key scenario must yield the same
// projection whether linkViaPSI is fed the live StandardizedKeyIterables or the
// baked plain-string arrays committed to the fixture.
const bakedProjection = await runLink(
  "one-to-one",
  multiKeyStarterKeys,
  multiKeyJoinerKeys,
);
const liveProjection = await runLink(
  "one-to-one",
  makeIterables(multiKeyServerRows),
  makeIterables(multiKeyClientRows),
);
if (JSON.stringify(bakedProjection) !== JSON.stringify(liveProjection)) {
  throw new Error(
    "baked multi-key key strings diverge from the live StandardizedKeyIterable " +
      "projection; the fixture would not faithfully reproduce " +
      "psiLinkForLinkageKeys.test.ts.",
  );
}

const vectors = [];
for (const scenario of scenarios) {
  const first = await project(scenario);
  // Re-run and assert the sorted projection is stable across the engine's random
  // per-exchange key, so a fixture the consumer can never reproduce cannot be
  // committed.
  const second = await project(scenario);
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    throw new Error(
      `scenario ${scenario.name}: resolved projection is not deterministic ` +
        `across runs; the sorted intersection/association KAT is not valid.`,
    );
  }
  const [starter, joiner] = first;
  vectors.push({ ...scenario, starter, joiner });
}

const doc = {
  description:
    "Resolved intersection-and-association known-answer vectors for the vendored " +
    "@openmined/psi.js engine as psilink drives it. Each scenario fixes the " +
    "engine inputs and pins both the intersection membership and the " +
    "association/permutation mapping back to original input rows, normalized by " +
    "sorting on the local index. They hold every scenario psilink's matching " +
    "cascade has to get right -- the empty-round and empty-key scenarios pinned " +
    "nowhere else, plus the projections psiParticipant.test.ts, psiLink.test.ts, " +
    "and psiLinkForLinkageKeys.test.ts exercise from the API side -- in one " +
    "portable fork-bump acceptance gate: a fork re-roll or an accidental engine " +
    "swap that permutes or corrupts the association mapping fails " +
    "psiIntersectionVectors.test.ts deterministically. " +
    "This is a CORRECTNESS anchor (the projection is data-defined, so a correct " +
    "engine always reproduces it), distinct from the BYTE-stability anchor in " +
    "psi-engine-wire-vectors.json. A green run confirms only that the engine still " +
    "computes linkage correctly; it does NOT verify the properties that make PSI " +
    "safe -- that nothing beyond the intersection is revealed, malicious-counterparty " +
    "resistance, or curve/key handling -- nor byte-level interop, and it does NOT " +
    "substitute for the explicit security review CONTRIBUTING.md's " +
    "Cryptographic-dependencies rule requires for any @openmined/psi.js re-roll or " +
    "replacement. Regenerate with generate-psi-intersection-vectors.mjs in this " +
    "directory.",
  curve: "NIST P-256",
  revealIntersection: true,
  associationTableLayout:
    "[localRowIndices, partnerRowIndices]; the two arrays are equal length and " +
    "pair index-for-index. The starter is sorted ascending by its local index " +
    "(starter[0]); the joiner is sorted ascending by its partner index " +
    "(joiner[1]), so across the pair starter[0] === joiner[1] and " +
    "starter[1] === joiner[0]. undefined inputs (the no-key sentinel) serialize " +
    "as JSON null.",
  vectors,
};

const outPath = fileURLToPath(
  new URL("./psi-intersection-vectors.json", import.meta.url),
);
writeFileSync(outPath, JSON.stringify(doc, null, 2) + "\n");
console.log(`wrote ${doc.vectors.length} vectors to ${outPath}`);
