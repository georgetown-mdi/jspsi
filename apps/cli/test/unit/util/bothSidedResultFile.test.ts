import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test, vi } from "vitest";

// The record writer reports its two writes through core's logger; capture it so
// those lines stay out of the suite output. Nothing else in core is replaced --
// the result table and the record this test reads are built by the real ones.
const logCapture = vi.hoisted(() => ({ infos: [] as string[] }));

vi.mock("@psilink/core", async (importActual) => {
  const actual = await importActual<typeof import("@psilink/core")>();
  return {
    ...actual,
    getLogger: () => ({
      info: (msg: string) => {
        logCapture.infos.push(msg);
      },
      warn: () => {},
      error: () => {},
      debug: () => {},
      trace: () => {},
    }),
  };
});

import {
  buildExchangeRecord,
  buildOutputTable,
  loadCSVFile,
  matchedPairCount,
  parseExchangeRecord,
  preparePayload,
  toCommittedPayload,
  toRetainedResult,
} from "@psilink/core";
import type {
  AssociationTable,
  CSVRow,
  LinkageTerms,
  Metadata,
  PartnerPayload,
} from "@psilink/core";

import { writeExchangeRecord } from "../../../src/recordFile";
import { writeOutput } from "../../../src/util/dataIo";

// The CLI's own artifacts for the both-sided deduplicating cardinality: the
// result file it writes and the exchange record it persists beside it. Checked
// here: the CLI's two writers hold the shape those rounds produce -- one result
// row per PAIR, so a cluster of m of this party's records and n of the partner's
// occupies m * n rows with no column naming the cluster, and one attested size,
// that pair count rather than either party's matched-record count.

// This party's rows. "Carol" is held twice on each side, so the pair it
// contributes is the two groups' product; "Henry" matches once, and "Alice"
// matches nothing.
const inputRows: CSVRow[] = [
  { pid: "A0", first_name: "Alice" },
  { pid: "A1", first_name: "Carol" },
  { pid: "A2", first_name: "Carol" },
  { pid: "A3", first_name: "Henry" },
];

const metadata: Metadata = [
  { name: "pid", type: "identifier", role: "identifier", isPayload: false },
  { name: "first_name", type: "first_name", role: "linkage", isPayload: false },
];

// The table an agreed (true, true) pair produces for these two files under the
// cascade, this party's side first: rows 1 and 2 against the partner's rows 0 and
// 1 (the 2 x 2 block), and row 3 against the partner's row 2 beside it. Both
// halves repeat, which is what makes it the both-sided shape.
const associationTable: AssociationTable = [
  [1, 1, 2, 2, 3],
  [0, 1, 0, 1, 2],
];

const partnerPayload: PartnerPayload = {
  columns: ["clinic"],
  rowIndices: [0, 1, 2],
  rows: [["north"], ["south"], ["east"]],
};

// The whole product of the block, in this party's row order, then the single pair
// beside it. A row per pair and nothing else: no cluster id, no group size.
const EXPECTED_HEADERS = ["pid", "row_id", "clinic"];
const EXPECTED_ROWS = [
  ["A1", "0", "north"],
  ["A1", "1", "south"],
  ["A2", "0", "north"],
  ["A2", "1", "south"],
  ["A3", "2", "east"],
];

const terms: LinkageTerms = {
  version: "1.0.0",
  identity: "Party A",
  date: "2026-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: true,
  linkageFields: [{ name: "first_name", type: "first_name" }],
  linkageKeys: [{ name: "firstName", elements: [{ field: "first_name" }] }],
};
// Both parties declare it, which is the pair that resolves many-to-many.
const partnerTerms: LinkageTerms = { ...terms, identity: "Party B" };

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-both-sided-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  logCapture.infos.length = 0;
  while (tempDirs.length > 0)
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

test("a both-sided result writes a cluster's whole product and attests the pair count", async () => {
  const dir = tempDir();
  const resultPath = path.join(dir, "results.csv");
  const recordPath = path.join(dir, "record.json");

  const { headers, rows } = buildOutputTable(
    associationTable,
    inputRows,
    metadata,
    partnerPayload,
  );
  await writeOutput(resultPath, headers, rows, { error: () => {} });

  const written = toRetainedResult(
    await loadCSVFile(fs.createReadStream(resultPath)),
  );
  expect(written.headers).toEqual(EXPECTED_HEADERS);
  expect(written.rows).toEqual(EXPECTED_ROWS);
  // The block's own rows are the product rather than a pairing of one of ours to
  // one of theirs: each of our two clustered records holds both partner rows.
  expect(
    written.rows.filter((row) => row[0] === "A1").map((row) => row[1]),
  ).toEqual(["0", "1"]);
  expect(
    written.rows.filter((row) => row[0] === "A2").map((row) => row[1]),
  ).toEqual(["0", "1"]);

  const { record, keys } = await buildExchangeRecord({
    localTerms: terms,
    partnerTerms,
    outcome: "completed",
    recordsExposed: inputRows.length,
    resultSize: matchedPairCount(associationTable),
    associationTable,
    localPayloadSent: toCommittedPayload(
      preparePayload(inputRows, metadata, associationTable),
    ),
    partnerPayloadReceived: toCommittedPayload(partnerPayload),
    createdAt: "2026-01-02T03:04:05.000Z",
  });
  expect(
    writeExchangeRecord({ recordFile: recordPath }, record, keys, "test"),
  ).toBeUndefined();

  // The figure on disk is the pair count: neither this party's matched-record
  // count (3), nor the clusters (2), nor the rows either party exposed.
  const onDisk = parseExchangeRecord(
    JSON.parse(fs.readFileSync(recordPath, "utf8")),
  );
  expect(onDisk.resultSize).toBe(5);
  expect(onDisk.resultSize).toBe(written.rows.length);
  expect(new Set(associationTable[0]).size).toBe(3);
});
