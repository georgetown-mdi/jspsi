import { describe, expect, test } from "vitest";

import { buildExchangeRecord } from "../src/exchangeRecord";
import { verifyExchangeRecord } from "../src/recordVerification";

import type {
  CommittedPayload,
  ExchangeRecordInputs,
} from "../src/exchangeRecord";
import type { LinkageTerms } from "../src/config/linkageTerms";
import type { CanonicalValue } from "../src/utils/canonical";
import type { AssociationTable } from "../src/types";

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
