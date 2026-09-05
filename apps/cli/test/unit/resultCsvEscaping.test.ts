import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test, vi } from "vitest";
import {
  buildExchangeRecord,
  buildOutputTable,
  deriveOurIdColumn,
  loadCSVFile,
  preparePayload,
  reconstructCommittedData,
  toCommittedPayload,
  toRetainedResult,
  verifyExchangeRecord,
} from "@psilink/core";
import type {
  AssociationTable,
  CSVRow,
  LinkageTerms,
  Metadata,
  PartnerPayload,
} from "@psilink/core";

import { writeOutput } from "../../src/util/dataIo";

// The result CSV's RFC 4180 round trip. Partner payloads and identifier columns
// carry ordinary real-world values, so a comma, a double quote, and a newline all
// reach the result; each must survive both of writeOutput's branches and come
// back unchanged from loadCSVFile, the reader `verify-receipt` re-supplies a
// retained result through.
//
// Escaping happens exactly once, in core's buildOutputTable, which hands
// writeOutput fields that are already quoted; the writer concatenates them. These
// tests are the executable form of that division: a second escaping pass added to
// either branch, or a dropped one upstream, fails here rather than in an
// operator's verify run.

// The three characters this round trip is named for; a bare CR is quoted the same
// way. Named separately so each is visible in the fixtures below and in a
// failure's diff.
const COMMA_VALUE = "Doe, Jane";
const QUOTE_VALUE = 'she said "hi"';
const NEWLINE_VALUE = "line one\nline two";

const metadata: Metadata = [
  { name: "pid", type: "ssn", role: "identifier", isPayload: false },
  { name: "dose", type: "first_name", role: "payload", isPayload: true },
];

// Our identifier values carry the comma and the quote, so the escaping is
// exercised on the result's first column and not only on partner values.
const inputRows: CSVRow[] = [
  { pid: COMMA_VALUE, dose: "10mg" },
  { pid: "P1", dose: "20mg" },
  { pid: QUOTE_VALUE, dose: NEWLINE_VALUE },
];

// Our matched rows are 0 and 2; the partner's are 1 and 0 in our order, so the
// result also reorders the partner's ascending send order -- the shape the
// re-supply below has to undo.
const associationTable: AssociationTable = [
  [0, 2],
  [1, 0],
];

// `blank` is the empty-value case: a partner column present in the schema whose
// cell is empty, which must read back as "" rather than as a dropped column.
const partnerPayload: PartnerPayload = {
  columns: ["note", "blank"],
  rowIndices: [0, 1],
  rows: [
    [COMMA_VALUE, ""],
    [`${QUOTE_VALUE} and ${NEWLINE_VALUE}`, ""],
  ],
};

// The values the reader must yield, row for row: result rows are in our matched
// order ([0, 2]), so the first carries the partner's row 1 and the second the
// partner's row 0.
const EXPECTED_HEADERS = ["pid", "row_id", "note", "blank"];
const EXPECTED_ROWS = [
  [COMMA_VALUE, "1", `${QUOTE_VALUE} and ${NEWLINE_VALUE}`, ""],
  [QUOTE_VALUE, "0", COMMA_VALUE, ""],
];

const terms: LinkageTerms = {
  version: "1.0.0",
  identity: "Party A",
  date: "2025-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [{ name: "ssn", type: "ssn" }],
  linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
};
const partnerTerms: LinkageTerms = { ...terms, identity: "Party B" };

function resultTable(): { headers: string[]; rows: Array<Array<string>> } {
  return buildOutputTable(
    associationTable,
    inputRows,
    metadata,
    partnerPayload,
  );
}

const tempDirs: string[] = [];

function tempResultPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-result-csv-"));
  tempDirs.push(dir);
  return path.join(dir, "results.csv");
}

// writeOutput's redirect notice fires on the stdout branch when fd 1 is a regular
// file, which it is under a redirected test run; swallow it, since these tests
// assert bytes rather than the notice (cli.test.ts owns that).
function silentLog(): { error: (message: string) => void } {
  return { error: () => {} };
}

// Capture the stdout branch's bytes without letting a result CSV reach the real
// stdout the test runner reports on.
async function stdoutBranchBytes(
  headers: string[],
  rows: Array<Array<string>>,
): Promise<string> {
  const chunks: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
    chunk: string | Uint8Array,
  ): boolean => {
    chunks.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
    );
    return true;
  }) as typeof process.stdout.write);
  try {
    await writeOutput(undefined, headers, rows, silentLog());
  } finally {
    stdoutSpy.mockRestore();
  }
  return chunks.join("");
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0)
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

test("writeOutput: a comma, a double quote, a newline, and an empty value read back unchanged", async () => {
  // The round trip the verify path depends on: written by the CLI, re-read by
  // loadCSVFile, every value is the value written -- the comma and newline did
  // not split a row or a field, and the doubled quotes collapsed back to one.
  const { headers, rows } = resultTable();
  const file = tempResultPath();
  await writeOutput(file, headers, rows, silentLog());

  const readBack = toRetainedResult(
    await loadCSVFile(fs.createReadStream(file)),
  );
  expect(readBack.headers).toEqual(EXPECTED_HEADERS);
  expect(readBack.rows).toEqual(EXPECTED_ROWS);
});

test("writeOutput: each field is quoted once, not escaped a second time", async () => {
  // The bytes on disk, not just the reader's verdict: escaping is core's, and the
  // writer only joins. A second pass in either branch would write `"""Doe, Jane"""`
  // -- which still parses, yielding a value with its quotes intact, so the reader
  // assertion above cannot see it on its own.
  const { headers, rows } = resultTable();
  const file = tempResultPath();
  await writeOutput(file, headers, rows, silentLog());

  const text = fs.readFileSync(file, "utf8");
  expect(text).toContain(`"${COMMA_VALUE}"`);
  expect(text).toContain('"she said ""hi"""');
  expect(text).not.toContain(`"""${COMMA_VALUE}"""`);
  // The header row carries no special characters, so it is written bare.
  expect(text.startsWith(`${EXPECTED_HEADERS.join(",")}\n`)).toBe(true);
});

test("writeOutput: the stdout branch and the OUTPUT_FILE branch write identical bytes", async () => {
  // A quoted field cannot be produced on one branch and not the other: both take
  // the same already-escaped fields and join them the same way, so `psilink
  // exchange input.csv > results.csv` and `psilink exchange input.csv results.csv`
  // differ only in the file's permissions.
  const { headers, rows } = resultTable();
  const file = tempResultPath();
  await writeOutput(file, headers, rows, silentLog());

  expect(await stdoutBranchBytes(headers, rows)).toBe(
    fs.readFileSync(file, "utf8"),
  );
});

test("writeOutput: a written result re-supplies its record's commitments", async () => {
  // The end-to-end consequence of the round trip: a result carrying all three
  // characters, read back and reshaped the way `verify-receipt` reshapes it, opens
  // every commitment. The commitments bind the canonical encoding of the LOGICAL
  // values, so an escaping fault on either side -- a dropped quote splitting a
  // field, or a doubled one leaving quotes in the value -- reports a mismatch here.
  const { record, keys } = await buildExchangeRecord({
    localTerms: terms,
    partnerTerms,
    outcome: "completed",
    recordsExposed: inputRows.length,
    resultSize: associationTable[0].length,
    associationTable,
    localPayloadSent: toCommittedPayload(
      preparePayload(inputRows, metadata, associationTable),
    ),
    partnerPayloadReceived: toCommittedPayload(partnerPayload),
    createdAt: "2026-01-02T03:04:05.000Z",
  });

  const { headers, rows } = resultTable();
  const file = tempResultPath();
  await writeOutput(file, headers, rows, silentLog());
  const result = toRetainedResult(await loadCSVFile(fs.createReadStream(file)));

  const { data, warnings } = reconstructCommittedData({
    record,
    inputRows,
    result,
    ourIdColumn: deriveOurIdColumn(
      result.headers,
      new Set(metadata.map((column) => column.name)),
    ),
  });
  const report = await verifyExchangeRecord(record, keys, {
    data,
    localTerms: terms,
    partnerTerms,
  });

  expect(warnings).toEqual([]);
  expect(report.commitments).toEqual({
    associationTable: "verified",
    localPayloadSent: "verified",
    partnerPayloadReceived: "verified",
  });
  expect(report.outcome).toBe("verified");
});
