// Regenerates psi-intersection-vectors.json: the resolved intersection-and-
// association known-answer vectors for the vendored @openmined/psi.js engine as
// psilink drives it (item 207302520). Run from the repo root:
//
//   npm run build -w packages/core   # the generator imports the built dist below
//   node packages/core/test/vectors/generate-psi-intersection-vectors.mjs
//   npm run format                   # apply the repo's JSON layout
//
// Purpose: consolidate into one explicit, portable fixture the intersection
// membership and the association/permutation mapping back to original input rows
// that are otherwise pinned inline as toStrictEqual assertions scattered across
// psiParticipant.test.ts, psiLink.test.ts, psiLinkForLinkageKeys.test.ts,
// psiLinkEmptyRound.test.ts, and psiLinkEmptyKey.test.ts. A fork re-roll or an
// accidental engine swap that silently permutes or corrupts the association
// mapping flips these projections and fails psiIntersectionVectors.test.ts
// deterministically in CI (no network, no nightly-only run).
//
// This is a CORRECTNESS anchor, distinct from the BYTE-stability anchor in
// psi-engine-wire-vectors.json. The resolved projection is defined by the DATA
// (which local row matches which partner row), not by the engine's random per-
// exchange key, so a correct engine always reproduces it. The raw association
// table row ORDER is engine-permutation-dependent, so every projection is
// normalized by sorting on the local-index array before it is pinned -- exactly
// what the inline tests do via sortAssociationTable: the starter (PSI sender) is
// sorted ascending by its own local index, the joiner (receiver) is sorted
// ascending by its partner index (the starter's local index), so the two align
// and starter[0] === joiner[1], starter[1] === joiner[0].

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import PSI from "@openmined/psi.js";

import {
  PSIParticipant,
  linkViaPSI,
  createMessagePipe,
  buildStandardizedDataset,
  StandardizedKeyIterable,
} from "../../dist/core.esm.js";

// PSI element-count bounds that never reject; mirrors
// test/utils/psiElementBounds.ts. These tests exercise PSI correctness, not the
// decode-seam amplification guard, so an inert bound keeps them focused.
const UNBOUNDED_PSI_ELEMENTS = {
  setup: Number.POSITIVE_INFINITY,
  request: Number.POSITIVE_INFINITY,
  response: Number.POSITIVE_INFINITY,
};

// Mirrors test/utils/associationTable.ts. Normal sort orders the pairs by the
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
      -1,
    ),
    linkViaPSI(
      { cardinality },
      makeParticipant("joiner"),
      joinerConn,
      joinerKeys,
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
// Each scenario names its source inline test so the two stay discoverably in
// step. `inputs` are the exact engine inputs; `expect` (starter, joiner) is
// filled in by running the scenario below.
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
      "matching loop must still run key 1 for both parties. Source: " +
      "psiLinkEmptyRound.test.ts (joiner fully matched early).",
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
      "still has an unmatched record. Source: psiLinkEmptyRound.test.ts " +
      "(starter fully matched early).",
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
      "no-op on both sides. Source: psiLinkEmptyRound.test.ts (both-empty round).",
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
      "its dataset and matches; undefined and non-matching named rows do not. " +
      "Source: psiLinkEmptyKey.test.ts (singleton '' matches).",
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
      "singleton '' therefore matches nothing. Source: psiLinkEmptyKey.test.ts " +
      "('' duplicated within a dataset is dropped).",
    method: "linkViaPSI",
    cardinality: "one-to-one",
    starterKeys: [["", "", "Alice"]],
    joinerKeys: [["", "Bob"]],
  },
  {
    name: "empty-key-all-empty-column-no-match",
    description:
      "linkViaPSI one-to-one: every '' on both sides is a within-dataset " +
      "duplicate, so the round drops them all and produces no match. Source: " +
      "psiLinkEmptyKey.test.ts (all-'' column matches nothing).",
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
      "value is '' -- so the carried-forward '' matches like any other value. " +
      "Source: psiLinkEmptyKey.test.ts ('' matches in a later round).",
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
      "within-dataset duplicates while its unique 'Alice' still matches -- " +
      "dropping the duplicated '' does not poison the rest of the round. Source: " +
      "psiLinkEmptyKey.test.ts (duplicated '' dropped, unique value still " +
      "matches).",
    method: "linkViaPSI",
    cardinality: "one-to-one",
    starterKeys: [["", "", "Alice"]],
    joinerKeys: [["", "Alice"]],
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
    "sorting on the local index. These consolidate the toStrictEqual KATs " +
    "otherwise inline in psiParticipant.test.ts, psiLink.test.ts, " +
    "psiLinkForLinkageKeys.test.ts, psiLinkEmptyRound.test.ts, and " +
    "psiLinkEmptyKey.test.ts into one portable fork-bump acceptance gate: a fork " +
    "re-roll or an accidental engine swap that permutes or corrupts the " +
    "association mapping fails psiIntersectionVectors.test.ts deterministically. " +
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
