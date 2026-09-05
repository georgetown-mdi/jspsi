import { Readable } from "node:stream";

import { describe, expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import {
  buildExchangeRecord,
  parseExchangeRecord,
  serializeExchangeRecord,
} from "../src/exchangeRecord";
import {
  matchedPairCount,
  prepareForExchange,
  runExchange,
} from "../src/exchange";
import { loadCSVFile } from "../src/file";
import {
  buildOutputTable,
  preparePayload,
  toCommittedPayload,
} from "../src/payloadExchange";
import {
  reconstructCommittedData,
  toRetainedResult,
  verifyExchangeRecord,
} from "../src/recordVerification";
import { createMessagePipe } from "../src/connection/messageConnection";

import type { LinkageTerms, Output } from "../src/config/linkageTerms";
import type { Metadata } from "../src/config/metadata";
import type { PartnerPayload } from "../src/payloadExchange";
import type { RetainedResult } from "../src/recordVerification";
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

// What a party retains is a result FILE, so the round trip below runs through
// one: buildOutputTable emits RFC 4180 escaped cells, and every writer joins
// them with commas and newlines alone (the CLI's writeOutput, the web console's
// download). Serializing and re-reading here keeps the escaper and parser both
// inside the claim, rather than testing reconstruction against raw escaped
// cells.
async function writeAndReadBack(table: {
  headers: string[];
  rows: Array<Array<string>>;
}): Promise<RetainedResult> {
  const csv = [table.headers, ...table.rows]
    .map((cells) => cells.join(",") + "\n")
    .join("");
  const stream = new Readable({ read() {} });
  stream.push(Buffer.from(csv, "utf8"));
  stream.push(null);
  return toRetainedResult(await loadCSVFile(stream));
}

// Reconstruct the committed data from the record + retained input + result the
// real build/write/parse path produces, then verify. A "verified" outcome means
// the reconstruction reproduced the exact committed bytes end to end.
async function roundTrip(opts: {
  rawRows: CSVRow[];
  metadata: Metadata;
  associationTable: AssociationTable;
  partnerPayload: PartnerPayload;
  ourIdColumn?: string;
  // Applied to the parsed result rows between the write and the reconstruction:
  // a retained result file edited after the exchange wrote it, reaching the
  // re-supply path exactly as an unedited one does.
  editRetainedResult?: (rows: string[][]) => void;
}) {
  const localPayloadSent = toCommittedPayload(
    preparePayload(opts.rawRows, opts.metadata, opts.associationTable),
  );
  const partnerPayloadReceived = toCommittedPayload(opts.partnerPayload);
  const { record, keys } = await buildExchangeRecord({
    localTerms: termsA,
    partnerTerms: termsB,
    outcome: "completed",
    recordsExposed: opts.rawRows.length,
    // matchedPairCount's own definition of the attested figure, read here
    // rather than restated, so a change to what a record attests is a failure
    // in these round trips too.
    resultSize: matchedPairCount(opts.associationTable),
    associationTable: opts.associationTable,
    localPayloadSent,
    partnerPayloadReceived,
    createdAt: "2026-01-02T03:04:05.000Z",
  });
  const result = await writeAndReadBack(
    buildOutputTable(
      opts.associationTable,
      opts.rawRows,
      opts.metadata,
      opts.partnerPayload,
    ),
  );
  opts.editRetainedResult?.(result.rows);
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
  return { report, warnings, result, record, keys, data };
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

// The characters that make the result file's escaping critical, plus the
// empty cell. Named so each is visible in a failure's diff.
const COMMA_VALUE = "Doe, Jane";
const QUOTE_VALUE = 'she said "hi"';
const NEWLINE_VALUE = "line one\nline two";

describe("reconstructCommittedData round-trips through the real build path", () => {
  test("a comma, a double quote, a newline, and an empty cell survive the file", async () => {
    // The commitments bind the canonical encoding of the LOGICAL values, so a
    // dropped quote (splitting a field) or a doubled one (leaving quotes in the
    // value) reproduces different bytes and reports a mismatch here. Core's own
    // consumers -- anything holding a result file that is not the CLI -- rest on
    // this, so it is pinned here rather than only in the CLI's writer suite.
    const specialRows: CSVRow[] = [
      { pid: COMMA_VALUE, dose: NEWLINE_VALUE },
      { pid: "P1", dose: "20mg" },
      { pid: QUOTE_VALUE, dose: "" },
    ];
    // `blank` is a declared partner column whose cell is empty: it must read back
    // as an empty value rather than as a dropped column.
    const partnerPayload: PartnerPayload = {
      columns: ["note", "blank"],
      rowIndices: [0, 1],
      rows: [
        [COMMA_VALUE, ""],
        [`${QUOTE_VALUE} / ${NEWLINE_VALUE}`, ""],
      ],
    };
    const { report, warnings, result } = await roundTrip({
      rawRows: specialRows,
      metadata: idMeta,
      associationTable: [
        [0, 2],
        [1, 0],
      ],
      partnerPayload,
      ourIdColumn: "pid",
    });
    // The reader's own verdict first, so an escaping fault localizes to the hop
    // rather than surfacing only as an opaque commitment mismatch.
    expect(result.headers).toEqual(["pid", "row_id", "note", "blank"]);
    expect(result.rows).toEqual([
      [COMMA_VALUE, "1", `${QUOTE_VALUE} / ${NEWLINE_VALUE}`, ""],
      [QUOTE_VALUE, "0", COMMA_VALUE, ""],
    ]);
    expect(warnings).toEqual([]);
    expect(report.outcome).toBe("verified");
    expect(report.commitments).toEqual({
      localPayloadSent: "verified",
      partnerPayloadReceived: "verified",
      associationTable: "verified",
    });
  });

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

  test("a short row omitting a prototype-member payload column reconstructs null, not the inherited function", async () => {
    // A payload column named exactly an Object.prototype member ('toString'),
    // omitted by a short input row: the send side (preparePayload) commits null,
    // so reconstruction must read the same absent value. A bare inputRows[i]?.[col]
    // would read the INHERITED function off the prototype chain, reconstructing a
    // different byte than was committed -- a spurious localPayloadSent mismatch on a
    // legitimate exchange. The own-property read reproduces the committed null.
    const protoMeta: Metadata = [
      { name: "pid", type: "ssn", role: "identifier", isPayload: false },
      { name: "toString", type: "other", role: "payload", isPayload: true },
    ];
    const sparseRows: CSVRow[] = [{ pid: "P0" }, { pid: "P1" }]; // omit 'toString'
    const partnerPayload: PartnerPayload = {
      columns: ["note"],
      rowIndices: [0],
      rows: [["s-0"]],
    };
    const { report } = await roundTrip({
      rawRows: sparseRows,
      metadata: protoMeta,
      associationTable: [[0], [0]],
      partnerPayload,
      ourIdColumn: "pid",
    });
    expect(report.outcome).toBe("verified");
    expect(report.commitments.localPayloadSent).toBe("verified");
  });

  test("short rows omitting a prototype-member identifier column raise no spurious duplicate warning", async () => {
    // Two input rows omit the 'toString' identifier column. A bare row[ourIdColumn]
    // reads the SAME inherited prototype function for each, so the id-to-row map
    // sees a repeated "value" and warns of a duplicate identifier that does not
    // exist. The own-property read treats each omitting row as having no identifier
    // (undefined), so no spurious duplicate warning is raised.
    const protoIdMeta: Metadata = [
      { name: "toString", type: "ssn", role: "identifier", isPayload: false },
      { name: "dose", type: "first_name", role: "payload", isPayload: true },
    ];
    const rows: CSVRow[] = [
      { toString: "P0", dose: "10mg" },
      { dose: "20mg" }, // omits the 'toString' identifier column
      { dose: "30mg" }, // also omits it -- same inherited value under a bare read
    ];
    const partnerPayload: PartnerPayload = {
      columns: ["note"],
      rowIndices: [0],
      rows: [["s-0"]],
    };
    const { report, warnings } = await roundTrip({
      rawRows: rows,
      metadata: protoIdMeta,
      associationTable: [[0], [0]],
      partnerPayload,
      ourIdColumn: "toString",
    });
    expect(warnings.some((w) => w.includes("duplicate"))).toBe(false);
    expect(report.outcome).toBe("verified");
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
      outcome: "completed",
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

// A deduplicating cardinality repeats a row index on one side of the association
// table, so the result file holds several rows against one record. The record's
// commitments still bind one payload row per matched RECORD on each side, and the
// re-supply path has to collapse the repeated result rows back to it -- on the
// local side for the sent payload, on the partner side for the received one. Both
// fan directions are driven here, each against the payload frame the mirrored
// party would actually have sent.
describe("reconstructCommittedData round-trips a deduplicating cardinality", () => {
  test("the 'one' side: several partner records against one of ours", async () => {
    // The partner's rows 1 and 0 both link to our row 0, and its row 3 to our
    // row 2. Its payload holds one row per record IT matched, ascending.
    const partnerPayload: PartnerPayload = {
      columns: ["note"],
      rowIndices: [0, 1, 3],
      rows: [["q-0"], ["q-1"], ["q-3"]],
    };
    const { report, record, data, result } = await roundTrip({
      rawRows: idRows,
      metadata: idMeta,
      associationTable: [
        [0, 0, 2],
        [1, 0, 3],
      ],
      partnerPayload,
      ourIdColumn: "pid",
    });
    // One result row per PAIR, our identifier repeating down the column.
    expect(result.rows).toEqual([
      ["P0", "1", "q-1"],
      ["P0", "0", "q-0"],
      ["P2", "3", "q-3"],
    ]);
    // The sent payload is one row per distinct matched record of ours -- two,
    // against three pairs -- and the re-supply reproduces exactly that.
    expect(data.localPayloadSent).toEqual({
      columns: ["dose"],
      rows: [["10mg"], ["30mg"]],
    });
    expect(report.outcome).toBe("verified");
    expect(report.commitments).toEqual({
      localPayloadSent: "verified",
      partnerPayloadReceived: "verified",
      associationTable: "verified",
    });
    // The attested figure is the pair count, which the distinct matched-record
    // count on this side does not equal.
    expect(record.resultSize).toBe(3);
  });

  test("the 'many' side: several of our records against one partner record", async () => {
    // Our rows 0 and 1 both link to the partner's row 1, and our row 2 to its
    // row 3. The partner is the "one" side here, so its payload holds one row
    // per record it matched -- two rows against our three pairs.
    const partnerPayload: PartnerPayload = {
      columns: ["note"],
      rowIndices: [1, 3],
      rows: [["q-1"], ["q-3"]],
    };
    const { report, record, data, result } = await roundTrip({
      rawRows: idRows,
      metadata: idMeta,
      associationTable: [
        [0, 1, 2],
        [1, 1, 3],
      ],
      partnerPayload,
      ourIdColumn: "pid",
    });
    // The one partner payload row is written against each of our grouped records.
    expect(result.rows).toEqual([
      ["P0", "1", "q-1"],
      ["P1", "1", "q-1"],
      ["P2", "3", "q-3"],
    ]);
    // Collapsing the repeated result rows back to the two rows the partner sent
    // is what reopens the received-payload commitment: one row per pair would
    // reproduce three and mismatch.
    expect(data.partnerPayloadReceived).toEqual({
      columns: ["note"],
      rows: [["q-1"], ["q-3"]],
    });
    expect(report.outcome).toBe("verified");
    expect(report.commitments).toEqual({
      localPayloadSent: "verified",
      partnerPayloadReceived: "verified",
      associationTable: "verified",
    });
    expect(record.resultSize).toBe(3);
  });

  test("a fan on each side at once reopens every commitment", async () => {
    // The both-sided shape, which the cascade produces for an agreed
    // many-to-many pair: the local half repeats AND the partner half repeats, and
    // neither collapse may disturb the other. The re-supply path is shape-driven,
    // so it is driven here on the shape rather than through a run.
    const partnerPayload: PartnerPayload = {
      columns: ["note"],
      rowIndices: [0, 2],
      rows: [["q-0"], ["q-2"]],
    };
    const { report, record } = await roundTrip({
      rawRows: idRows,
      metadata: idMeta,
      associationTable: [
        [0, 0, 1, 1],
        [0, 2, 0, 2],
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
    expect(record.resultSize).toBe(4);
  });
});

// Under a deduplicating cardinality the result writes one row per PAIR while the
// received-payload commitment binds one row per partner RECORD, so the re-supply
// collapses the repeated rows back to the one row the sender committed. A collapse
// that kept the FIRST copy unconditionally would put every later copy's value
// cells outside every commitment in the record: nothing would reproduce them, so
// nothing would contradict an edit to them. Each case below edits one value cell
// of an otherwise honest artifact set, through the same build/write/parse path
// the honest round trips take, and requires the verdict to move off "verified".
describe("an edited copy of a repeated result row fails its commitment", () => {
  // The result's value columns start after our record id and the partner row
  // index, so with one disclosed partner column the received value is cell 2.
  const PARTNER_INDEX_CELL = 1;
  const RECEIVED_CELL = 2;

  // Our rows 0 and 1 both link to the partner's row 1, so the partner's single
  // sent row for that record is written twice.
  const manySideFan = {
    rawRows: idRows,
    metadata: idMeta,
    associationTable: [
      [0, 1, 2],
      [1, 1, 3],
    ] as AssociationTable,
    partnerPayload: {
      columns: ["note"],
      rowIndices: [1, 3],
      rows: [["q-1"], ["q-3"]],
    } as PartnerPayload,
    ourIdColumn: "pid",
  };

  // Both halves repeat: our rows 0 and 1 each link to the partner's rows 0 and 2,
  // so each of the two sent rows is written twice and the two collapses interleave.
  const bothSidesFan = {
    rawRows: idRows,
    metadata: idMeta,
    associationTable: [
      [0, 0, 1, 1],
      [0, 2, 0, 2],
    ] as AssociationTable,
    partnerPayload: {
      columns: ["note"],
      rowIndices: [0, 2],
      rows: [["q-0"], ["q-2"]],
    } as PartnerPayload,
    ourIdColumn: "pid",
  };

  test("copies carrying the same values still collapse to the one committed row", async () => {
    // The control for the cases below: agreeing copies are the honest shape, so
    // they collapse silently and every commitment opens.
    const { report, warnings, data } = await roundTrip(manySideFan);
    expect(warnings).toEqual([]);
    expect(data.partnerPayloadReceived).toEqual({
      columns: ["note"],
      rows: [["q-1"], ["q-3"]],
    });
    expect(report.outcome).toBe("verified");
  });

  test("the second copy's received cell is covered on the many-side fan", async () => {
    const { report, warnings } = await roundTrip({
      ...manySideFan,
      editRetainedResult: (rows) => {
        expect(rows[1]).toEqual(["P1", "1", "q-1"]);
        rows[1][RECEIVED_CELL] = "TAMPERED";
      },
    });
    expect(report.outcome).toBe("failed");
    expect(report.commitments.partnerPayloadReceived).toBe("mismatch");
    // The edit is confined to a received value, so the pairing and our own sent
    // values still reproduce -- the received-payload commitment is what has to
    // catch it.
    expect(report.commitments.associationTable).toBe("verified");
    expect(report.commitments.localPayloadSent).toBe("verified");
    expect(warnings.some((w) => w.includes("received values differ"))).toBe(
      true,
    );
  });

  test("the second copy's received cell is covered on the both-sides fan", async () => {
    const { report, warnings } = await roundTrip({
      ...bothSidesFan,
      editRetainedResult: (rows) => {
        expect(rows[2]).toEqual(["P1", "0", "q-0"]);
        rows[2][RECEIVED_CELL] = "TAMPERED";
      },
    });
    expect(report.outcome).toBe("failed");
    expect(report.commitments.partnerPayloadReceived).toBe("mismatch");
    expect(report.commitments.associationTable).toBe("verified");
    expect(warnings.some((w) => w.includes("received values differ"))).toBe(
      true,
    );
  });

  test("the first copy's received cell stays covered", async () => {
    const { report } = await roundTrip({
      ...manySideFan,
      editRetainedResult: (rows) => {
        expect(rows[0]).toEqual(["P0", "1", "q-1"]);
        rows[0][RECEIVED_CELL] = "TAMPERED";
      },
    });
    expect(report.outcome).toBe("failed");
    expect(report.commitments.partnerPayloadReceived).toBe("mismatch");
  });

  test("a moved pairing column surfaces the divergence on the table instead", async () => {
    // The case the warning's attribution has to stay conditional for. Pointing
    // the third result row at the partner row the first two already hold makes
    // its value cell a disagreeing copy -- but the collapse then reproduces the
    // two rows the partner sent EXACTLY, so the received-payload commitment
    // opens and the association table is the one that mismatches. A warning
    // naming only the received payload would send the reader to the one line of
    // the verdict that passed.
    const { report, warnings } = await roundTrip({
      ...manySideFan,
      editRetainedResult: (rows) => {
        expect(rows[2]).toEqual(["P2", "3", "q-3"]);
        rows[2][PARTNER_INDEX_CELL] = "1";
      },
    });
    const divergence = warnings.find((w) =>
      w.includes("received values differ"),
    );
    expect(divergence).toBeDefined();
    expect(divergence).toContain("the received payload's where a value cell");
    expect(divergence).toContain(
      "the association table's where a partner row index moved",
    );
    expect(report.commitments.partnerPayloadReceived).toBe("verified");
    expect(report.commitments.associationTable).toBe("mismatch");
    expect(report.outcome).toBe("failed");
  });
});

// No commitment covers the recorded result size, so verification recounts it
// from the pairing the record does commit to. Each case below alters that one
// cleartext field of an otherwise honest artifact set -- the commitments stay
// untouched, so a "verified" verdict would mean the pair count is whatever the
// holder typed.
describe("a tampered result size fails against the re-supplied pairing", () => {
  // What an auditor verifies is a record FILE, so `viaRecordFile` writes the
  // altered record through the record's own serializer and reads it back through
  // its parser before verification. An in-memory edit alone would leave the
  // recount claim resting on an object that never crossed either.
  async function withRecordedSize(
    opts: Parameters<typeof roundTrip>[0],
    resultSize: number,
    viaRecordFile = false,
  ) {
    const { record, keys, data } = await roundTrip(opts);
    const tampered = { ...record, resultSize };
    return verifyExchangeRecord(
      viaRecordFile
        ? parseExchangeRecord(JSON.parse(serializeExchangeRecord(tampered)))
        : tampered,
      keys,
      { data, localTerms: termsA, partnerTerms: termsB },
    );
  }

  const oneToOne = {
    rawRows: idRows,
    metadata: idMeta,
    associationTable: [
      [0, 2],
      [1, 0],
    ] as AssociationTable,
    partnerPayload: {
      columns: ["note"],
      rowIndices: [0, 1],
      rows: [["q-0"], ["q-1"]],
    } as PartnerPayload,
    ourIdColumn: "pid",
  };

  // Our rows 0 and 1 both link to the partner's row 1: three pairs, three
  // matched records of ours, two of the partner's.
  const manySideFan = {
    rawRows: idRows,
    metadata: idMeta,
    associationTable: [
      [0, 1, 2],
      [1, 1, 3],
    ] as AssociationTable,
    partnerPayload: {
      columns: ["note"],
      rowIndices: [1, 3],
      rows: [["q-1"], ["q-3"]],
    } as PartnerPayload,
    ourIdColumn: "pid",
  };

  test("one-to-one: an inflated figure fails across the record file, and the honest one verifies", async () => {
    const honest = await withRecordedSize(oneToOne, 2, true);
    expect(honest.resultSize).toBe("verified");
    expect(honest.outcome).toBe("verified");

    const tampered = await withRecordedSize(oneToOne, 3, true);
    expect(tampered.resultSize).toBe("mismatch");
    expect(tampered.outcome).toBe("failed");
    // The pairing itself reproduced, so the record's own figure is what the
    // verdict indicts -- not the files the holder re-supplied.
    expect(tampered.commitments).toEqual({
      localPayloadSent: "verified",
      partnerPayloadReceived: "verified",
      associationTable: "verified",
    });
  });

  test("many-to-one: the partner's matched-record count is not the pair count", async () => {
    const honest = await withRecordedSize(manySideFan, 3);
    expect(honest.resultSize).toBe("verified");
    expect(honest.outcome).toBe("verified");

    // Two is the number of the PARTNER's records that matched -- the figure a
    // per-party reading would record, and the one a deduplicating exchange makes
    // it possible to state instead of the pair count.
    const tampered = await withRecordedSize(manySideFan, 2);
    expect(tampered.resultSize).toBe("mismatch");
    expect(tampered.outcome).toBe("failed");
    expect(tampered.commitments.associationTable).toBe("verified");
  });

  test("one-to-many: our own matched-record count is not the pair count either", async () => {
    // The mirrored fan: the partner's rows 1 and 0 both link to our row 0, so
    // three pairs stand over two matched records of ours.
    const oneSideFan = {
      rawRows: idRows,
      metadata: idMeta,
      associationTable: [
        [0, 0, 2],
        [1, 0, 3],
      ] as AssociationTable,
      partnerPayload: {
        columns: ["note"],
        rowIndices: [0, 1, 3],
        rows: [["q-0"], ["q-1"], ["q-3"]],
      } as PartnerPayload,
      ourIdColumn: "pid",
    };
    const honest = await withRecordedSize(oneSideFan, 3);
    expect(honest.resultSize).toBe("verified");
    expect(honest.outcome).toBe("verified");

    const tampered = await withRecordedSize(oneSideFan, 2);
    expect(tampered.resultSize).toBe("mismatch");
    expect(tampered.outcome).toBe("failed");
    expect(tampered.commitments.associationTable).toBe("verified");
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
  // Different row orders on the two sides, by design, so the partner send order
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
      const output = await writeAndReadBack(
        buildOutputTable(
          table,
          dataPrep.rawRows,
          dataPrep.metadata,
          result.partnerPayload,
        ),
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
