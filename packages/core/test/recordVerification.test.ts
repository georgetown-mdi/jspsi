import { Readable } from "node:stream";

import { describe, expect, test } from "vitest";

import { buildExchangeRecord } from "../src/exchangeRecord";
import { buildOutputTable } from "../src/payloadExchange";
import { loadCSVFile } from "../src/file";
import {
  reconstructCommittedData,
  reproductionMismatchCauses,
  toRetainedResult,
  verifyExchangeRecord,
} from "../src/recordVerification";

import type {
  CommittedPayload,
  ExchangeRecordInputs,
} from "../src/exchangeRecord";
import type { LinkageTerms } from "../src/config/linkageTerms";
import type { Metadata } from "../src/config/metadata";
import type { PartnerPayload } from "../src/payloadExchange";
import type { RetainedResult } from "../src/recordVerification";
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

// The received payload carries a genuine null cell, so the null-vs-empty
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
    // A party that received no output holds no association table, so neither the
    // record nor the keys carries it -- a legitimate absence, not reported.
    const { associationTable: _omit, ...withoutTable } = baseInputs;
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

// buildOutputTable emits already-escaped cells and every writer only joins them,
// so serializing that way and reading the bytes back through the shared reader is
// the round trip a holder's retained result makes.
async function retainedResultFor(
  partnerPayload: PartnerPayload,
): Promise<RetainedResult> {
  const table = buildOutputTable(
    associationTable,
    retainedInputRows,
    retainedMetadata,
    partnerPayload,
  );
  const csv = [table.headers, ...table.rows]
    .map((cells) => cells.join(",") + "\n")
    .join("");
  const stream = new Readable({ read() {} });
  stream.push(Buffer.from(csv, "utf8"));
  stream.push(null);
  return toRetainedResult(await loadCSVFile(stream));
}

function reconstructFrom(
  record: Parameters<typeof reconstructCommittedData>[0]["record"],
  result: RetainedResult,
) {
  return reconstructCommittedData({
    record,
    inputRows: retainedInputRows,
    result,
    ourIdColumn: "pid",
  });
}

describe("reproductionMismatchCauses", () => {
  test("the result writes a committed null as an empty cell", async () => {
    // The premise the whole caveat rests on: our matched rows [0, 2] pair with
    // partner rows [1, 0], so the first result row carries the partner's null and
    // the second its "active" -- and the null arrives as an empty string.
    const result = await retainedResultFor(partnerPayloadAsSent);
    expect(result.rows.map((row) => row[2])).toEqual(["", "active"]);
  });

  test("a quoted empty string and an empty cell read back identically", async () => {
    // Quoting the result's fields does not resolve the edge: both spellings of an
    // empty cell come back from the shared reader as the same empty string, so no
    // reader-side distinction is available to reconstruct a null from.
    const csv = 'pid,row_id,status\nP0,1,""\nP2,0,\n';
    const stream = new Readable({ read() {} });
    stream.push(Buffer.from(csv, "utf8"));
    stream.push(null);
    const result = toRetainedResult(await loadCSVFile(stream));
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
    // Nothing was modified, and everything reproducible reproduced: the received
    // payload alone mismatches, on the one cell the result could not carry.
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

  test("an empty string in that cell opens the commitment and earns no note", async () => {
    // The same exchange with an empty string where the null was: the result cell
    // is identical, but this time it reproduces what was committed. An empty cell
    // on its own must not raise the note, or every verified result carrying one
    // would come with a caveat about a mismatch that did not happen.
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
