import { Readable } from "node:stream";

import { describe, expect, test } from "vitest";

import { buildExchangeRecord } from "../src/records/exchangeRecord";
import { buildOutputTable, preparePayload } from "../src/payloadExchange";
import { loadCSVFile } from "../src/file";
import {
  reconstructCommittedData,
  recordAlterationIsTheOnlyExplanation,
  reproductionMismatchCauses,
  toRetainedResult,
  verifyExchangeRecord,
} from "../src/records/recordVerification";

import type {
  CommitmentName,
  CommittedPayload,
  ExchangeRecordInputs,
} from "../src/records/exchangeRecord";
import type { LinkageTerms } from "../src/config/linkageTermsSchema";
import type { Metadata } from "../src/config/metadata";
import type { PartnerPayload } from "../src/payloadExchange";
import type {
  CommitmentStatus,
  RecordVerificationReport,
  RetainedResult,
} from "../src/records/recordVerification";
import type { CanonicalValue } from "../src/utils/canonical";
import type { AssociationTable } from "../src/types";
import type { CSVRow } from "../src/file";

// --- Fixtures ----------------------------------------------------------------

const termsA: LinkageTerms = {
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
const termsB: LinkageTerms = { ...termsA, identity: "Party B" };

// The received payload holds a genuine null cell, so the null-vs-empty
// re-supply guard below has something to distinguish.
const localPayloadSent: CommittedPayload = {
  columns: ["dose"],
  rows: [["10mg"], ["20mg"]],
};
const partnerPayloadReceived: CommittedPayload = {
  columns: ["status"],
  rows: [["active"], [null]],
};
const associationTable: AssociationTable = [
  [0, 2],
  [1, 0],
];

const baseInputs: ExchangeRecordInputs = {
  localTerms: termsA,
  partnerTerms: termsB,
  outcome: "completed",
  recordsExposed: 5,
  resultSize: 2,
  associationTable,
  localPayloadSent,
  partnerPayloadReceived,
  createdAt: "2026-01-02T03:04:05.000Z",
};

// The exact data sets to re-supply, keyed by commitment name.
const fullData: Record<string, CanonicalValue> = {
  localPayloadSent,
  partnerPayloadReceived,
  associationTable: associationTable as unknown as CanonicalValue,
};

// --- Tests -------------------------------------------------------------------

describe("verifyExchangeRecord", () => {
  test("verifies when the exact data and both parties' terms are re-supplied", async () => {
    const { record, keys } = await buildExchangeRecord(baseInputs);
    const report = await verifyExchangeRecord(record, keys, {
      data: fullData,
      localTerms: termsA,
      partnerTerms: termsB,
    });
    expect(report.outcome).toBe("verified");
    expect(report.termsHash).toBe("verified");
    expect(report.commitments).toEqual({
      localPayloadSent: "verified",
      partnerPayloadReceived: "verified",
      associationTable: "verified",
    });
  });

  test("auditor mode (no data, no terms) is incomplete, never failed", async () => {
    const { record, keys } = await buildExchangeRecord(baseInputs);
    const report = await verifyExchangeRecord(record, keys);
    expect(report.outcome).toBe("incomplete");
    expect(report.termsHash).toBe("not-checked");
    expect(report.commitments).toEqual({
      localPayloadSent: "not-supplied",
      partnerPayloadReceived: "not-supplied",
      associationTable: "not-supplied",
    });
  });

  test("a wrong commitment opening fails distinctly and localizes the failure", async () => {
    const { record, keys } = await buildExchangeRecord(baseInputs);
    const report = await verifyExchangeRecord(record, keys, {
      data: {
        ...fullData,
        // Same columns, different value in the second row.
        partnerPayloadReceived: {
          columns: ["status"],
          rows: [["active"], ["inactive"]],
        },
      },
      localTerms: termsA,
      partnerTerms: termsB,
    });
    expect(report.outcome).toBe("failed");
    expect(report.commitments.partnerPayloadReceived).toBe("mismatch");
    // Only the tampered set fails; the others still verify.
    expect(report.commitments.localPayloadSent).toBe("verified");
    expect(report.commitments.associationTable).toBe("verified");
  });

  test("re-supplied data in a different row order does not open (byte-identical guard)", async () => {
    const { record, keys } = await buildExchangeRecord(baseInputs);
    const report = await verifyExchangeRecord(record, keys, {
      data: {
        ...fullData,
        // The same pairs, reordered: RFC 8785 array order is significant, so the
        // canonical bytes -- and the commitment -- differ.
        associationTable: [
          [2, 0],
          [0, 1],
        ] as unknown as CanonicalValue,
      },
    });
    expect(report.commitments.associationTable).toBe("mismatch");
    expect(report.outcome).toBe("failed");
  });

  test("re-supplied data that maps a null cell to an empty string does not open", async () => {
    const { record, keys } = await buildExchangeRecord(baseInputs);
    const report = await verifyExchangeRecord(record, keys, {
      data: {
        ...fullData,
        // The committed row is [null]; re-supplying "" instead is a different
        // canonical encoding, so it must not open.
        partnerPayloadReceived: {
          columns: ["status"],
          rows: [["active"], [""]],
        },
      },
    });
    expect(report.commitments.partnerPayloadReceived).toBe("mismatch");
    expect(report.outcome).toBe("failed");
  });

  test("a mismatched terms hash fails distinctly", async () => {
    const { record, keys } = await buildExchangeRecord(baseInputs);
    const report = await verifyExchangeRecord(record, keys, {
      data: fullData,
      localTerms: termsA,
      partnerTerms: { ...termsB, identity: "Someone Else" },
    });
    expect(report.termsHash).toBe("mismatch");
    expect(report.outcome).toBe("failed");
  });

  test("terms not re-supplied leaves the terms hash unchecked (incomplete)", async () => {
    const { record, keys } = await buildExchangeRecord(baseInputs);
    const report = await verifyExchangeRecord(record, keys, { data: fullData });
    expect(report.termsHash).toBe("not-checked");
    // Every commitment opened, but the terms hash was not checked.
    expect(report.commitments).toEqual({
      localPayloadSent: "verified",
      partnerPayloadReceived: "verified",
      associationTable: "verified",
    });
    expect(report.outcome).toBe("incomplete");
  });

  test("a commitment whose salt is missing is unopenable, not failed", async () => {
    const { record, keys } = await buildExchangeRecord(baseInputs);
    // Drop the (optional) association-table salt: the commitment is still in the
    // record, so it is unopenable rather than absent.
    const { associationTable: _omit, ...saltsWithoutTable } = keys.salts;
    const report = await verifyExchangeRecord(
      record,
      { ...keys, salts: saltsWithoutTable },
      { data: fullData, localTerms: termsA, partnerTerms: termsB },
    );
    expect(report.commitments.associationTable).toBe("unopenable");
    expect(report.outcome).toBe("incomplete");
  });

  test("a held-no-table record does not report the absent association table", async () => {
    // A party that received no output holds no association table, so neither
    // the record nor the keys contains it -- a legitimate absence, not
    // reported. The same party is not entitled to the result size either
    // (the gate is both parties receiving output), so the record states none.
    const {
      associationTable: _omitTable,
      resultSize: _omitSize,
      ...withoutTable
    } = baseInputs;
    const { record, keys } = await buildExchangeRecord(withoutTable);
    const report = await verifyExchangeRecord(record, keys, {
      data: { localPayloadSent, partnerPayloadReceived },
      localTerms: termsA,
      partnerTerms: termsB,
    });
    expect("associationTable" in report.commitments).toBe(false);
    expect(report.commitments.localPayloadSent).toBe("verified");
    expect(report.outcome).toBe("verified");
  });

  test("a mandatory commitment absent from the record is a failure, not incomplete", async () => {
    const { record, keys } = await buildExchangeRecord(baseInputs);
    // Strip a mandatory commitment from the record but leave its (now orphaned)
    // salt in the keys. A parsed record can never reach this -- the schema
    // requires the mandatory pair -- but a hand-built one could; the verifier
    // must treat it as a definite failure, matching verifyRecordCommitments,
    // rather than downgrading it to incomplete because a salt happens to remain.
    const commitments = { ...record.commitments };
    delete (commitments as { localPayloadSent?: string }).localPayloadSent;
    const report = await verifyExchangeRecord(
      { ...record, commitments },
      keys,
      { data: fullData, localTerms: termsA, partnerTerms: termsB },
    );
    expect(report.commitments.localPayloadSent).toBe("unopenable");
    expect(report.outcome).toBe("failed");
  });

  test("a malformed commitment value yields a verdict, not a crash (fail-safe)", async () => {
    const { record, keys } = await buildExchangeRecord(baseInputs);
    // A base64url-invalid commitment cannot be decoded; verification must report a
    // mismatch rather than throw.
    const tampered = {
      ...record,
      commitments: {
        ...record.commitments,
        localPayloadSent: "not-valid-base64!!",
      },
    };
    const report = await verifyExchangeRecord(tampered, keys, {
      data: fullData,
    });
    expect(report.commitments.localPayloadSent).toBe("mismatch");
    expect(report.outcome).toBe("failed");
  });
});

// --- The recorded result size ------------------------------------------------

// No commitment covers the result size, so verification recounts it from the
// association table the record does commit to. `baseInputs` records 2 against a
// two-pair table, so a tampered figure is the same record with a different
// integer in that one cleartext field -- the alteration an auditor holding the
// record and the holder's files could not otherwise see.
describe("verifyExchangeRecord checks the recorded result size", () => {
  test("the untampered figure verifies against the re-supplied pairing", async () => {
    const { record, keys } = await buildExchangeRecord(baseInputs);
    const report = await verifyExchangeRecord(record, keys, {
      data: fullData,
      localTerms: termsA,
      partnerTerms: termsB,
    });
    expect(report.resultSize).toBe("verified");
    expect(report.outcome).toBe("verified");
  });

  test("a tampered figure fails and is named apart from the commitments", async () => {
    const { record, keys } = await buildExchangeRecord(baseInputs);
    const report = await verifyExchangeRecord(
      { ...record, resultSize: 7 },
      keys,
      { data: fullData, localTerms: termsA, partnerTerms: termsB },
    );
    expect(report.resultSize).toBe("mismatch");
    expect(report.outcome).toBe("failed");
    // The field at fault is the result size alone: every commitment opened and
    // the terms hash re-derived, so nothing else in the report is implicated.
    expect(report.commitments).toEqual({
      localPayloadSent: "verified",
      partnerPayloadReceived: "verified",
      associationTable: "verified",
    });
    expect(report.termsHash).toBe("verified");
  });

  test("a figure one off the pair count still fails", async () => {
    // The plausible tamper is a small edit, not a wild one: the check is an
    // equality against the count, not a range or a plausibility test.
    const { record, keys } = await buildExchangeRecord(baseInputs);
    const report = await verifyExchangeRecord(
      { ...record, resultSize: 1 },
      keys,
      { data: fullData },
    );
    expect(report.resultSize).toBe("mismatch");
    expect(report.outcome).toBe("failed");
  });

  test("a record stating no result size reports none, and that is not a fault", async () => {
    const { resultSize: _omit, ...withoutSize } = baseInputs;
    const { record, keys } = await buildExchangeRecord(withoutSize);
    const report = await verifyExchangeRecord(record, keys, {
      data: fullData,
      localTerms: termsA,
      partnerTerms: termsB,
    });
    expect("resultSize" in report).toBe(false);
    expect(report.outcome).toBe("verified");
  });

  test("a result that was not re-supplied leaves the figure unchecked", async () => {
    // The auditor case for this field: no pairing was re-supplied, so nothing
    // was recounted -- reported as unchecked, never as verified.
    const { record, keys } = await buildExchangeRecord(baseInputs);
    const report = await verifyExchangeRecord(record, keys, {
      data: { localPayloadSent, partnerPayloadReceived },
      localTerms: termsA,
      partnerTerms: termsB,
    });
    expect(report.resultSize).toBe("not-supplied");
    expect(report.outcome).toBe("incomplete");
  });

  test("a tampered figure with no result re-supplied is unchecked, not verified", async () => {
    // The fail-safe half of the contract stated against a record that IS
    // altered: with nothing to recount from, the verdict withholds rather than
    // passing the altered figure.
    const { record, keys } = await buildExchangeRecord(baseInputs);
    const report = await verifyExchangeRecord(
      { ...record, resultSize: 7 },
      keys,
      { data: { localPayloadSent, partnerPayloadReceived } },
    );
    expect(report.resultSize).toBe("not-supplied");
    expect(report.outcome).toBe("incomplete");
  });

  test("a keys file with no association-table salt leaves the figure unchecked", async () => {
    const { record, keys } = await buildExchangeRecord(baseInputs);
    const { associationTable: _omit, ...saltsWithoutTable } = keys.salts;
    const report = await verifyExchangeRecord(
      record,
      { ...keys, salts: saltsWithoutTable },
      { data: fullData, localTerms: termsA, partnerTerms: termsB },
    );
    expect(report.commitments.associationTable).toBe("unopenable");
    expect(report.resultSize).toBe("unopenable");
    expect(report.outcome).toBe("incomplete");
  });

  test("a pairing that did not open leaves the figure unchecked, never at fault", async () => {
    // A re-supplied table that does not reproduce its commitment says nothing
    // about the recorded figure: the fault is reported on the commitment, and
    // the result size withholds rather than joining the accusation.
    const { record, keys } = await buildExchangeRecord(baseInputs);
    const report = await verifyExchangeRecord(record, keys, {
      data: {
        ...fullData,
        associationTable: [
          [0, 1, 2],
          [2, 0, 1],
        ] as unknown as CanonicalValue,
      },
    });
    expect(report.commitments.associationTable).toBe("mismatch");
    expect(report.resultSize).toBe("unopenable");
    expect(report.outcome).toBe("failed");
  });

  test("a record with a size but no pairing at all leaves it unchecked", async () => {
    // The count-only shape: the run produced no pairing, so the record commits
    // to none while still recording the count. Nothing reproduces the figure,
    // so it reports unchecked -- the verdict cannot reach "verified".
    const { associationTable: _omit, ...withoutTable } = baseInputs;
    const { record, keys } = await buildExchangeRecord(withoutTable);
    const report = await verifyExchangeRecord(
      { ...record, resultSize: 2 },
      keys,
      {
        data: { localPayloadSent, partnerPayloadReceived },
        localTerms: termsA,
        partnerTerms: termsB,
      },
    );
    expect("associationTable" in report.commitments).toBe(false);
    expect(report.resultSize).toBe("unopenable");
    expect(report.outcome).toBe("incomplete");
  });

  test("a re-supplied pairing with no readable pair count is unchecked", async () => {
    // Halves of different lengths hold no pair count -- each entry is one
    // pair read across both -- so the figure is withheld rather than
    // compared against a guessed one. The record commits to the shape, so
    // reaching this needs a hand-built pair; the fail-safe contract still
    // owes a verdict, not a throw.
    const lopsided = [[0, 1], [0]] as unknown as CanonicalValue;
    const { record, keys } = await buildExchangeRecord({
      ...baseInputs,
      associationTable: lopsided as unknown as AssociationTable,
    });
    const report = await verifyExchangeRecord(record, keys, {
      data: { ...fullData, associationTable: lopsided },
    });
    expect(report.commitments.associationTable).toBe("verified");
    expect(report.resultSize).toBe("unopenable");
    expect(report.outcome).toBe("incomplete");
  });

  // A pair count is read only off a value shaped as the pairing the record
  // commits to. Each shape below is committed AND re-supplied, so its commitment
  // opens and the recount is the only thing left to withhold the figure: a
  // counted figure here would put "verified" on a record whose committed value
  // is not a pairing at all. Reaching any of them takes a hand-built record --
  // the exchange commits an AssociationTable -- and the fail-safe contract still
  // owes a verdict rather than a throw.
  const unreadableShapes: Array<{ label: string; table: CanonicalValue }> = [
    { label: "not an array at all", table: "two pairs" },
    {
      label: "an object rather than two halves",
      table: { our: [0, 1], partner: [1, 0] },
    },
    {
      label: "three halves",
      table: [
        [0, 1],
        [1, 0],
        [9, 9],
      ],
    },
    { label: "a single half", table: [[0, 1]] },
    {
      label: "two halves of objects",
      table: [
        [{ row: 0 }, { row: 1 }],
        [{ row: 1 }, { row: 0 }],
      ],
    },
    {
      label: "two halves of nested arrays",
      table: [
        [[0], [1]],
        [[1], [0]],
      ],
    },
    {
      label: "two halves of strings",
      table: [
        ["0", "1"],
        ["1", "0"],
      ],
    },
    {
      label: "carrying a negative row index",
      table: [
        [0, -1],
        [1, 0],
      ],
    },
    {
      label: "carrying a fractional row index",
      table: [
        [0, 1.5],
        [1, 0],
      ],
    },
  ];

  test.each(unreadableShapes)(
    "a committed value $label is not recounted, and never verifies",
    async ({ table }) => {
      const { record, keys } = await buildExchangeRecord({
        ...baseInputs,
        associationTable: table as unknown as AssociationTable,
      });
      const report = await verifyExchangeRecord(record, keys, {
        data: { ...fullData, associationTable: table },
      });
      expect(report.commitments.associationTable).toBe("verified");
      expect(report.resultSize).toBe("unopenable");
      expect(report.outcome).toBe("incomplete");
    },
  );
});

// --- The record-alteration verdict guard -------------------------------------

// The guard both verification consumers ask before dropping the
// altered-or-wrong-file hedge and stating flatly that the record was
// altered. The shapes below are hand-built rather than verified out of a
// record, since the guard is exported and takes a plain report: an empty
// commitment map, a map with no association table, a figure at fault under
// a verdict that did not fail are all shapes no core-built report reaches,
// and an accusation may not rest on a sweep that passes because there was
// nothing to sweep.
describe("recordAlterationIsTheOnlyExplanation", () => {
  const onlyTheFigureAtFault: RecordVerificationReport = {
    outcome: "failed",
    termsHash: "verified",
    commitments: {
      localPayloadSent: "verified",
      partnerPayloadReceived: "verified",
      associationTable: "verified",
    },
    resultSize: "mismatch",
  };

  function withCommitment(
    name: CommitmentName,
    status: CommitmentStatus,
  ): RecordVerificationReport {
    const commitments: Partial<Record<CommitmentName, CommitmentStatus>> = {
      ...onlyTheFigureAtFault.commitments,
    };
    commitments[name] = status;
    return { ...onlyTheFigureAtFault, commitments };
  }

  test("the recorded figure alone at fault is the record's own alteration", () => {
    expect(recordAlterationIsTheOnlyExplanation(onlyTheFigureAtFault)).toBe(
      true,
    );
  });

  test("the report a real tampered figure produces reaches the guard", async () => {
    // The hand-built shape above, held against the verdict verification
    // actually emits: the matrix cannot drift onto a report core never writes.
    const { record, keys } = await buildExchangeRecord(baseInputs);
    const report = await verifyExchangeRecord(
      { ...record, resultSize: 7 },
      keys,
      { data: fullData, localTerms: termsA, partnerTerms: termsB },
    );
    expect(recordAlterationIsTheOnlyExplanation(report)).toBe(true);
  });

  const unverifiedElement: Array<{
    label: string;
    report: RecordVerificationReport;
  }> = [
    {
      label: "a figure at fault under a verdict that verified",
      report: { ...onlyTheFigureAtFault, outcome: "verified" },
    },
    {
      label: "a figure at fault under a verdict that is merely incomplete",
      report: { ...onlyTheFigureAtFault, outcome: "incomplete" },
    },
    {
      label: "a result size that recounted",
      report: {
        ...onlyTheFigureAtFault,
        outcome: "verified",
        resultSize: "verified",
      },
    },
    {
      label: "a result size with no re-supplied pairing to recount",
      report: {
        ...onlyTheFigureAtFault,
        outcome: "incomplete",
        resultSize: "not-supplied",
      },
    },
    {
      label: "a result size with no opened pairing behind it",
      report: {
        ...onlyTheFigureAtFault,
        outcome: "incomplete",
        resultSize: "unopenable",
      },
    },
    {
      label: "a record stating no result size at all",
      report: {
        outcome: "verified",
        termsHash: "verified",
        commitments: onlyTheFigureAtFault.commitments,
      },
    },
    {
      label: "an unchecked agreed-terms hash",
      report: { ...onlyTheFigureAtFault, termsHash: "not-checked" },
    },
    {
      label: "an agreed-terms hash that did not re-derive",
      report: { ...onlyTheFigureAtFault, termsHash: "mismatch" },
    },
    ...(
      [
        "localPayloadSent",
        "partnerPayloadReceived",
        "associationTable",
      ] as const
    ).flatMap((name) =>
      (["mismatch", "not-supplied", "unopenable"] as const).map((status) => ({
        label: `commitment ${name} reported ${status}`,
        report: withCommitment(name, status),
      })),
    ),
    {
      label: "an empty commitment map",
      report: { ...onlyTheFigureAtFault, commitments: {} },
    },
    {
      label: "a commitment map carrying no association table",
      report: {
        ...onlyTheFigureAtFault,
        commitments: {
          localPayloadSent: "verified",
          partnerPayloadReceived: "verified",
        },
      },
    },
  ];

  test.each(unverifiedElement)(
    "$label leaves the alteration unclaimed",
    ({ report }) => {
      expect(recordAlterationIsTheOnlyExplanation(report)).toBe(false);
    },
  );
});

// --- The null-versus-empty reproduction edge ---------------------------------

// The retained artifacts behind the record `baseInputs` describes: three input
// rows whose matched pair is [0, 2], and the partner's payload in its own send
// order (ascending row index), whose second cell is the genuine null. Verifying
// from these is the operator's actual path -- write a result, keep the input, come
// back later -- so the edge is driven through the real writer and reader rather
// than asserted from a hand-built data set.
const retainedInputRows: CSVRow[] = [
  { pid: "P0", dose: "10mg" },
  { pid: "P1", dose: "15mg" },
  { pid: "P2", dose: "20mg" },
];
const retainedMetadata: Metadata = [
  { name: "pid", type: "ssn", role: "identifier", isPayload: false },
  { name: "dose", type: "first_name", role: "payload", isPayload: true },
];
const partnerPayloadAsSent: PartnerPayload = {
  columns: ["status"],
  rowIndices: [0, 1],
  rows: [["active"], [null]],
};

function csvStream(text: string): Readable {
  const stream = new Readable({ read() {} });
  stream.push(Buffer.from(text, "utf8"));
  stream.push(null);
  return stream;
}

// buildOutputTable emits already-escaped cells and every writer only joins them,
// so serializing that way and reading the bytes back through the shared reader is
// the round trip a holder's retained result makes.
async function retainedResultFor(
  partnerPayload: PartnerPayload,
  inputRows: CSVRow[] = retainedInputRows,
): Promise<RetainedResult> {
  const table = buildOutputTable(
    associationTable,
    inputRows,
    retainedMetadata,
    partnerPayload,
  );
  const csv = [table.headers, ...table.rows]
    .map((cells) => cells.join(",") + "\n")
    .join("");
  return toRetainedResult(await loadCSVFile(csvStream(csv)));
}

function reconstructFrom(
  record: Parameters<typeof reconstructCommittedData>[0]["record"],
  result: RetainedResult,
  inputRows: CSVRow[] = retainedInputRows,
) {
  return reconstructCommittedData({
    record,
    inputRows,
    result,
    ourIdColumn: "pid",
  });
}

describe("reproductionMismatchCauses", () => {
  test("the result writes a committed null as an empty cell", async () => {
    // The assumption the whole caveat rests on: our matched rows [0, 2] pair
    // with partner rows [1, 0], so the first result row holds the partner's
    // null and the second its "active" -- and the null arrives as an empty
    // string.
    const result = await retainedResultFor(partnerPayloadAsSent);
    expect(result.rows.map((row) => row[2])).toEqual(["", "active"]);
  });

  test("a quoted empty string and an empty cell read back identically", async () => {
    // Quoting the result's fields does not resolve the edge: both spellings of an
    // empty cell come back from the shared reader as the same empty string, so no
    // reader-side distinction is available to reconstruct a null from.
    const csv = 'pid,row_id,status\nP0,1,""\nP2,0,\n';
    const result = toRetainedResult(await loadCSVFile(csvStream(csv)));
    expect(result.rows.map((row) => row[2])).toEqual(["", ""]);
  });

  test("a committed null reproduces as an empty string, and the note names it", async () => {
    const { record, keys } = await buildExchangeRecord(baseInputs);
    const result = await retainedResultFor(partnerPayloadAsSent);
    const { data, warnings } = reconstructFrom(record, result);
    const report = await verifyExchangeRecord(record, keys, {
      data,
      localTerms: termsA,
      partnerTerms: termsB,
    });
    // Nothing was modified, and everything reproducible reproduced: the
    // received payload alone mismatches, on the one cell the result could
    // not hold.
    expect(warnings).toEqual([]);
    expect(report.commitments.partnerPayloadReceived).toBe("mismatch");
    expect(report.commitments.localPayloadSent).toBe("verified");
    expect(report.commitments.associationTable).toBe("verified");
    const causes = reproductionMismatchCauses(report, data);
    expect(causes).toHaveLength(1);
    expect(causes[0]).toContain(
      "cannot distinguish a committed empty string from a committed null",
    );
    // The cause is named, not accepted: the verdict is still a failure.
    expect(report.outcome).toBe("failed");
  });

  test("an empty cell the sent payload committed reproduces from the input", async () => {
    // The exclusion that bounds the caveat to the received payload, driven on the
    // run that raises it: the retained input holds an empty payload cell at a
    // matched row, and the partner's second value was null. Both reach the
    // re-supply as an empty string, but the sent side reads its cell back from
    // the input the send side read it from, through the same reader, so
    // localPayloadSent opens and the note stands against the received payload
    // alone.
    const inputRows = (
      await loadCSVFile(csvStream("pid,dose\nP0,\nP1,15mg\nP2,20mg\n"))
    ).data;
    const sent = preparePayload(inputRows, retainedMetadata, associationTable);
    if (!sent.hasData) throw new Error("expected hasData:true");
    expect(sent.rows).toEqual([[""], ["20mg"]]);

    const { record, keys } = await buildExchangeRecord({
      ...baseInputs,
      localPayloadSent: { columns: sent.columns, rows: sent.rows },
    });
    const result = await retainedResultFor(partnerPayloadAsSent, inputRows);
    const { data, warnings } = reconstructFrom(record, result, inputRows);
    const report = await verifyExchangeRecord(record, keys, { data });
    expect(warnings).toEqual([]);
    expect(report.commitments.localPayloadSent).toBe("verified");
    expect(report.commitments.partnerPayloadReceived).toBe("mismatch");
    const causes = reproductionMismatchCauses(report, data);
    expect(causes).toHaveLength(1);
    expect(causes[0]).toContain("the re-supplied received payload has");
  });

  test("an empty string in that cell opens the commitment and earns no note", async () => {
    // The same exchange with an empty string where the null was: the result
    // cell is identical, but this time it reproduces what was committed. An
    // empty cell on its own must not raise the note, or every verified
    // result holding one would come with a caveat about a mismatch that did
    // not happen.
    const emptyRatherThanNull: PartnerPayload = {
      ...partnerPayloadAsSent,
      rows: [["active"], [""]],
    };
    const { record, keys } = await buildExchangeRecord({
      ...baseInputs,
      partnerPayloadReceived: {
        columns: ["status"],
        rows: [["active"], [""]],
      },
    });
    const result = await retainedResultFor(emptyRatherThanNull);
    const { data } = reconstructFrom(record, result);
    const report = await verifyExchangeRecord(record, keys, { data });
    expect(report.commitments.partnerPayloadReceived).toBe("verified");
    expect(reproductionMismatchCauses(report, data)).toEqual([]);
  });

  test("a mismatch with no empty cell earns no note", async () => {
    // A received payload that mismatches on a non-empty value: the null
    // explanation is impossible there, so naming it would point the operator away
    // from a real discrepancy.
    const { record, keys } = await buildExchangeRecord(baseInputs);
    const data = {
      ...fullData,
      partnerPayloadReceived: {
        columns: ["status"],
        rows: [["active"], ["inactive"]],
      },
    };
    const report = await verifyExchangeRecord(record, keys, { data });
    expect(report.commitments.partnerPayloadReceived).toBe("mismatch");
    expect(reproductionMismatchCauses(report, data)).toEqual([]);
  });

  test("a report opened against nothing earns no note", async () => {
    // The auditor case: no data was re-supplied, so no commitment mismatched and
    // there is nothing to explain.
    const { record, keys } = await buildExchangeRecord(baseInputs);
    const report = await verifyExchangeRecord(record, keys);
    expect(reproductionMismatchCauses(report)).toEqual([]);
  });
});
