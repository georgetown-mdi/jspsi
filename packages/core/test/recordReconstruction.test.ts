import { describe, expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import { buildExchangeRecord } from "../src/exchangeRecord";
import { prepareForExchange, runExchange } from "../src/exchange";
import {
  buildOutputTable,
  preparePayload,
  toCommittedPayload,
} from "../src/payloadExchange";
import {
  reconstructCommittedData,
  verifyExchangeRecord,
} from "../src/recordVerification";
import { createMessagePipe } from "../src/connection/messageConnection";

import type { LinkageTerms, Output } from "../src/config/linkageTerms";
import type { Metadata } from "../src/config/metadata";
import type { PartnerPayload } from "../src/payloadExchange";
import type { AssociationTable } from "../src/types";
import type { CSVRow } from "../src/file";

const psiLibrary = await PSI();

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

// Reconstruct the committed data from the record + retained input + result the
// real build path produces, then verify. A "verified" outcome means the
// reconstruction reproduced the exact committed bytes end to end.
async function roundTrip(opts: {
  rawRows: CSVRow[];
  metadata: Metadata;
  associationTable: AssociationTable;
  partnerPayload: PartnerPayload;
  ourIdColumn?: string;
}) {
  const localPayloadSent = toCommittedPayload(
    preparePayload(opts.rawRows, opts.metadata, opts.associationTable),
  );
  const partnerPayloadReceived = toCommittedPayload(opts.partnerPayload);
  const { record, keys } = await buildExchangeRecord({
    localTerms: termsA,
    partnerTerms: termsB,
    recordsExposed: opts.rawRows.length,
    resultSize: opts.associationTable[0].length,
    associationTable: opts.associationTable,
    localPayloadSent,
    partnerPayloadReceived,
    createdAt: "2026-01-02T03:04:05.000Z",
  });
  const result = buildOutputTable(
    opts.associationTable,
    opts.rawRows,
    opts.metadata,
    opts.partnerPayload,
  );
  const { data, warnings } = reconstructCommittedData({
    record,
    inputRows: opts.rawRows,
    result,
    ourIdColumn: opts.ourIdColumn,
  });
  const report = await verifyExchangeRecord(record, keys, {
    data,
    localTerms: termsA,
    partnerTerms: termsB,
  });
  return { report, warnings };
}

const idMeta: Metadata = [
  { name: "pid", type: "ssn", role: "identifier", isPayload: false },
  { name: "dose", type: "first_name", role: "payload", isPayload: true },
];
const rowIndexMeta: Metadata = [
  { name: "dose", type: "first_name", role: "payload", isPayload: true },
];
const idRows: CSVRow[] = [
  { pid: "P0", dose: "10mg" },
  { pid: "P1", dose: "20mg" },
  { pid: "P2", dose: "30mg" },
];

describe("reconstructCommittedData round-trips through the real build path", () => {
  test("identifier column, both payloads, misaligned partner send order", async () => {
    // The crucial case: our matched rows are [0, 2]; the partner's matched rows
    // are [2, 0] in OUR order, but the partner SENT its payload in ascending order
    // ([0, 2]). buildOutputTable reorders to our order; reconstruction must sort
    // the result back into the partner's send order to reproduce the commitment.
    const partnerPayload: PartnerPayload = {
      columns: ["note"],
      rowIndices: [0, 2],
      rows: [["s-e"], ["s-c"]],
    };
    const { report } = await roundTrip({
      rawRows: idRows,
      metadata: idMeta,
      associationTable: [
        [0, 2],
        [2, 0],
      ],
      partnerPayload,
      ourIdColumn: "pid",
    });
    expect(report.outcome).toBe("verified");
    expect(report.commitments).toEqual({
      localPayloadSent: "verified",
      partnerPayloadReceived: "verified",
      associationTable: "verified",
    });
  });

  test("no identifier column: the result's first column is the row index", async () => {
    // Partner send order is ascending (rowIndices [0, 1], the linkage invariant),
    // but our order pairs them as [1, 0] -- so the result reorders and
    // reconstruction still has to sort by the partner index.
    const partnerPayload: PartnerPayload = {
      columns: ["note"],
      rowIndices: [0, 1],
      rows: [["q-0"], ["q-1"]],
    };
    const { report } = await roundTrip({
      rawRows: idRows,
      metadata: rowIndexMeta,
      associationTable: [
        [0, 2],
        [1, 0],
      ],
      partnerPayload,
      // no ourIdColumn
    });
    expect(report.outcome).toBe("verified");
  });

  test("no partner payload: partnerPayloadReceived is the empty committed value", async () => {
    const partnerPayload: PartnerPayload = {
      columns: [],
      rowIndices: [],
      rows: [],
    };
    const { report } = await roundTrip({
      rawRows: idRows,
      metadata: idMeta,
      associationTable: [
        [0, 2],
        [3, 1],
      ],
      partnerPayload,
      ourIdColumn: "pid",
    });
    expect(report.outcome).toBe("verified");
    expect(report.commitments.partnerPayloadReceived).toBe("verified");
  });

  test("no disclosed columns: localPayloadSent is the empty committed value", async () => {
    // No payload columns disclosed, but the partner sent one.
    const noSendMeta: Metadata = [
      { name: "pid", type: "ssn", role: "identifier", isPayload: false },
    ];
    const partnerPayload: PartnerPayload = {
      columns: ["note"],
      rowIndices: [0],
      rows: [["p-0"]],
    };
    const { report } = await roundTrip({
      rawRows: idRows,
      metadata: noSendMeta,
      associationTable: [[1], [0]],
      partnerPayload,
      ourIdColumn: "pid",
    });
    expect(report.outcome).toBe("verified");
    expect(report.commitments.localPayloadSent).toBe("verified");
  });

  test("warns, and fails to open, when a re-supplied input misses an identifier", async () => {
    // Reconstruct against an input whose identifier values do not cover the
    // result: the reconstruction warns and the affected commitments do not open.
    const localPayloadSent = toCommittedPayload(
      preparePayload(idRows, idMeta, [
        [0, 2],
        [2, 0],
      ]),
    );
    const partnerPayload: PartnerPayload = {
      columns: ["note"],
      rowIndices: [0, 2],
      rows: [["s-e"], ["s-c"]],
    };
    const { record, keys } = await buildExchangeRecord({
      localTerms: termsA,
      partnerTerms: termsB,
      recordsExposed: idRows.length,
      resultSize: 2,
      associationTable: [
        [0, 2],
        [2, 0],
      ],
      localPayloadSent,
      partnerPayloadReceived: toCommittedPayload(partnerPayload),
      createdAt: "2026-01-02T03:04:05.000Z",
    });
    const result = buildOutputTable(
      [
        [0, 2],
        [2, 0],
      ],
      idRows,
      idMeta,
      partnerPayload,
    );
    // A different input file: the identifiers do not match the result's.
    const wrongInput: CSVRow[] = [
      { pid: "X0", dose: "10mg" },
      { pid: "X1", dose: "20mg" },
    ];
    const { data, warnings } = reconstructCommittedData({
      record,
      inputRows: wrongInput,
      result,
      ourIdColumn: "pid",
    });
    expect(
      warnings.some((w) => w.includes("not present in the supplied input")),
    ).toBe(true);
    const report = await verifyExchangeRecord(record, keys, { data });
    expect(report.outcome).toBe("failed");
    expect(report.commitments.localPayloadSent).toBe("mismatch");
  });
});

// The reconstruction rests on a linkage invariant (both parties' association
// tables are sorted ascending by their own row index, so the partner send order
// is recoverable by sorting the result on the partner-index column). Pin it
// against the REAL linkage: run a live PSI exchange, then reconstruct each party's
// committed data from the result the real build path produces and verify it. If a
// future linkage change broke the ascending ordering, this fails rather than the
// reconstruction silently mis-reproducing partnerPayloadReceived.
describe("reconstructCommittedData round-trips a live PSI exchange", () => {
  const liveTerms = {
    version: "1.0.0",
    date: "2026-01-01",
    algorithm: "psi" as const,
    linkageStrategy: "cascade" as const,
    deduplicate: false,
    linkageFields: [{ name: "firstName", type: "first_name" as const }],
    linkageKeys: [{ name: "firstName", elements: [{ field: "firstName" }] }],
  };
  // Deliberately different row orders on the two sides, so the partner send order
  // and our association order genuinely diverge (exercising the sort).
  const serverRows: CSVRow[] = [
    { first_name: "Elizabeth", note: "s-e" },
    { first_name: "Alice", note: "s-a" },
    { first_name: "Carol", note: "s-c" },
    { first_name: "Bob", note: "s-b" },
  ];
  const clientRows: CSVRow[] = [
    { first_name: "Carol", note: "c-c" },
    { first_name: "Henry", note: "c-h" },
    { first_name: "Elizabeth", note: "c-e" },
  ];
  const prep = (identity: string, rows: CSVRow[]) =>
    prepareForExchange(
      {
        linkageTerms: {
          ...liveTerms,
          identity,
          output: { expectsOutput: true, shareWithPartner: true } as Output,
        },
      },
      identity,
      rows,
      ["first_name", "note"],
    );

  test("both parties reconstruct and verify their own record from their result", async () => {
    const [conn0, conn1] = createMessagePipe();
    const initPrep = prep("Init", clientRows);
    const respPrep = prep("Resp", serverRows);
    const [initiator, responder] = await Promise.all([
      runExchange(conn0, "initiator", initPrep, { psiLibrary }),
      runExchange(conn1, "responder", respPrep, { psiLibrary }),
    ]);

    for (const [dataPrep, result] of [
      [initPrep, initiator],
      [respPrep, responder],
    ] as const) {
      const audit = result.audit!;
      const table = result.associationTable!;
      const output = buildOutputTable(
        table,
        dataPrep.rawRows,
        dataPrep.metadata,
        result.partnerPayload,
      );
      const ourIdColumn = dataPrep.metadata.find(
        (c) => c.role === "identifier",
      )?.name;
      const { data } = reconstructCommittedData({
        record: audit.record,
        inputRows: dataPrep.rawRows,
        result: output,
        ourIdColumn,
      });
      const report = await verifyExchangeRecord(audit.record, audit.keys, {
        data,
      });
      // Every commitment opens; the terms hash is not-checked (no partner terms
      // supplied), so the overall outcome is incomplete, never failed.
      expect(
        Object.values(report.commitments).every((s) => s === "verified"),
      ).toBe(true);
      expect(report.commitments.associationTable).toBe("verified");
      expect(report.outcome).toBe("incomplete");
    }
  });
});
