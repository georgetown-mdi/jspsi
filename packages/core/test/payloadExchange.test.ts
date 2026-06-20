import { expect, test } from "vitest";

import {
  preparePayload,
  exchangePayloads,
  buildOutputTable,
} from "../src/payloadExchange";

import type { Metadata } from "../src/config/metadata";
import type { PartnerPayload } from "../src/payloadExchange";

import {
  createMessagePipe,
  ConnectionError,
} from "../src/connection/messageConnection";
import type { MessageConnection } from "../src/connection/messageConnection";

// --- Fixtures ----------------------------------------------------------------

const metaWithId: Metadata = [
  { name: "ssn", type: "ssn", role: "linkage", isPayload: false },
  {
    name: "patient_id",
    type: "identifier",
    role: "identifier",
    isPayload: true,
  },
  { name: "diagnosis", type: "other", role: "payload", isPayload: true },
];

const metaNoId: Metadata = [
  { name: "ssn", type: "ssn", role: "linkage", isPayload: false },
  { name: "diagnosis", type: "other", role: "payload", isPayload: true },
];

const metaLinkageOnly: Metadata = [
  { name: "ssn", type: "ssn", role: "linkage", isPayload: false },
];

const rawRows = [
  { ssn: "001", patient_id: "P0", diagnosis: "A" },
  { ssn: "002", patient_id: "P1", diagnosis: "B" },
  { ssn: "003", patient_id: "P2", diagnosis: "C" },
  { ssn: "004", patient_id: "P3", diagnosis: "D" },
  { ssn: "005", patient_id: "P4", diagnosis: "E" },
];

// --- preparePayload ----------------------------------------------------------

test("preparePayload: no payload columns returns hasData:false", () => {
  const result = preparePayload(rawRows, metaLinkageOnly, [
    [0, 1],
    [2, 3],
  ]);
  expect(result).toEqual({ hasData: false });
});

test("preparePayload: no matched rows returns hasData:false", () => {
  const result = preparePayload(rawRows, metaWithId, [[], []]);
  expect(result).toEqual({ hasData: false });
});

test("preparePayload: rows are indexed by associationTable[0]", () => {
  const result = preparePayload(rawRows, metaWithId, [
    [1, 3],
    [0, 2],
  ]);
  if (!result.hasData) throw new Error("expected hasData:true");
  expect(result.columns).toEqual(["patient_id", "diagnosis"]);
  expect(result.rowIndices).toEqual([1, 3]);
  expect(result.rows).toEqual([
    ["P1", "B"],
    ["P3", "D"],
  ]);
});

test("preparePayload: identifier column is sent as a plain payload column", () => {
  const result = preparePayload(rawRows, metaWithId, [[0], [0]]);
  if (!result.hasData) throw new Error("expected hasData:true");
  // patient_id has isPayload:true — it is transmitted, but not specially labeled
  expect(result.columns).toContain("patient_id");
  expect(result.rowIndices).toEqual([0]);
  expect(result).not.toHaveProperty("identifierColumn");
});

test("preparePayload: missing column value becomes null", () => {
  const sparse = [{ ssn: "001", patient_id: "P0" }]; // no 'diagnosis'
  const result = preparePayload(sparse, metaWithId, [[0], [0]]);
  if (!result.hasData) throw new Error("expected hasData:true");
  expect(result.rowIndices).toEqual([0]);
  expect(result.rows[0]).toEqual(["P0", null]);
});

test("preparePayload: ignored column is never transmitted, even with isPayload:true", () => {
  // The role: ignored opt-out wins over isPayload (accept-but-ignore resolution
  // of the is_payload + ignored open question). diagnosis is a normal payload
  // column; county is ignored despite isPayload:true and must not be sent.
  const metaWithIgnored: Metadata = [
    { name: "ssn", type: "ssn", role: "linkage", isPayload: false },
    { name: "diagnosis", type: "other", role: "payload", isPayload: true },
    { name: "county", type: "other", role: "ignored", isPayload: true },
  ];
  const withCounty = rawRows.map((r) => ({ ...r, county: "DC" }));
  const result = preparePayload(withCounty, metaWithIgnored, [[0], [0]]);
  if (!result.hasData) throw new Error("expected hasData:true");
  expect(result.columns).toEqual(["diagnosis"]);
  expect(result.columns).not.toContain("county");
});

test("preparePayload: a dataset whose only isPayload column is ignored has no data", () => {
  const metaOnlyIgnored: Metadata = [
    { name: "ssn", type: "ssn", role: "linkage", isPayload: false },
    { name: "county", type: "other", role: "ignored", isPayload: true },
  ];
  const result = preparePayload(rawRows, metaOnlyIgnored, [[0], [0]]);
  expect(result).toEqual({ hasData: false });
});

test("buildOutputTable: an ignored column is not treated as the identifier", () => {
  // patient_id is present but marked ignored, so it is not the output identifier;
  // the header falls back to row_id just as it does with no identifier column.
  const metaIgnoredId: Metadata = [
    { name: "ssn", type: "ssn", role: "linkage", isPayload: false },
    {
      name: "patient_id",
      type: "identifier",
      role: "ignored",
      isPayload: false,
    },
  ];
  const partnerPayload: PartnerPayload = {
    columns: ["partner_id"],
    rowIndices: [0],
    rows: [["Q0"]],
  };
  const { headers } = buildOutputTable(
    [[0], [0]],
    rawRows,
    metaIgnoredId,
    partnerPayload,
  );
  expect(headers[0]).toBe("row_id");
});

// --- exchangePayloads --------------------------------------------------------

async function runExchangePayloads(
  payloadA: ReturnType<typeof preparePayload>,
  payloadB: ReturnType<typeof preparePayload>,
) {
  const [connA, connB] = createMessagePipe();
  return Promise.all([
    exchangePayloads(connA, "initiator", payloadA),
    exchangePayloads(connB, "responder", payloadB),
  ]);
}

test("exchangePayloads: each party receives the other's payload", async () => {
  const payloadA = preparePayload(rawRows, metaWithId, [
    [0, 2],
    [1, 3],
  ]);
  const payloadB = preparePayload(rawRows, metaNoId, [
    [1, 3],
    [0, 2],
  ]);

  const [receivedByA, receivedByB] = await runExchangePayloads(
    payloadA,
    payloadB,
  );

  // A sent payloadA (patient_id + diagnosis for rows 0 and 2); B receives it
  expect(receivedByB.columns).toEqual(["patient_id", "diagnosis"]);
  expect(receivedByB.rowIndices).toEqual([0, 2]);
  expect(receivedByB.rows).toEqual([
    ["P0", "A"],
    ["P2", "C"],
  ]);

  // B sent payloadB (diagnosis only for rows 1 and 3); A receives it
  expect(receivedByA.columns).toEqual(["diagnosis"]);
  expect(receivedByA.rowIndices).toEqual([1, 3]);
  expect(receivedByA.rows).toEqual([["B"], ["D"]]);
});

test("exchangePayloads: hasData:false from both parties yields empty PartnerPayload on both sides", async () => {
  const empty = preparePayload(rawRows, metaLinkageOnly, [[0], [1]]);

  const [receivedByInitiator, receivedByResponder] = await runExchangePayloads(
    empty,
    empty,
  );

  expect(receivedByInitiator).toEqual({
    columns: [],
    rowIndices: [],
    rows: [],
  });
  expect(receivedByResponder).toEqual({
    columns: [],
    rowIndices: [],
    rows: [],
  });
});

test("exchangePayloads: hasData:false from initiator yields empty PartnerPayload on responder side", async () => {
  const empty = preparePayload(rawRows, metaLinkageOnly, [[0], [1]]);
  const data = preparePayload(rawRows, metaWithId, [[1], [0]]);

  const [, receivedByResponder] = await runExchangePayloads(empty, data);

  expect(receivedByResponder).toEqual({
    columns: [],
    rowIndices: [],
    rows: [],
  });
});

test("exchangePayloads: hasData:false from responder yields empty PartnerPayload on initiator side", async () => {
  const data = preparePayload(rawRows, metaWithId, [[0], [1]]);
  const empty = preparePayload(rawRows, metaLinkageOnly, [[1], [0]]);

  const [receivedByInitiator] = await runExchangePayloads(data, empty);

  expect(receivedByInitiator).toEqual({
    columns: [],
    rowIndices: [],
    rows: [],
  });
});

test("exchangePayloads: malformed data from partner rejects the initiator", async () => {
  const [connA, connB] = createMessagePipe();
  const initiatorPromise = exchangePayloads(connA, "initiator", {
    hasData: false,
  });
  // Responder sends garbage instead of a valid payload message.
  await connB.receive();
  await connB.send({ unexpected: true });
  await expect(initiatorPromise).rejects.toThrow();
});

test("exchangePayloads: malformed data from partner rejects the responder", async () => {
  const [connA, connB] = createMessagePipe();
  const responderPromise = exchangePayloads(connB, "responder", {
    hasData: false,
  });
  // Initiator sends garbage instead of a valid payload message.
  await connA.send({ unexpected: true });
  await expect(responderPromise).rejects.toThrow();
});

test("exchangePayloads: rowIndices/rows length mismatch rejects the receiver", async () => {
  const [connA, connB] = createMessagePipe();
  const initiatorPromise = exchangePayloads(connA, "initiator", {
    hasData: false,
  });
  // Responder sends a structurally valid message but with mismatched lengths.
  await connB.receive();
  await connB.send({
    hasData: true,
    columns: ["patient_id"],
    rowIndices: [0, 1],
    rows: [["P0"]], // only one row for two indices
  });
  await expect(initiatorPromise).rejects.toThrow();
});

test("exchangePayloads: send rejection rejects the initiator", async () => {
  const sendError = new Error("send failed");
  const conn: MessageConnection = {
    send: () => Promise.reject(sendError),
    receive: () => new Promise<unknown>(() => {}),
    close: () => Promise.resolve(),
  };
  await expect(
    exchangePayloads(conn, "initiator", { hasData: false }),
  ).rejects.toThrow("send failed");
});

test("exchangePayloads: send rejection rejects the responder", async () => {
  const sendError = new Error("send failed");
  const conn: MessageConnection = {
    send: () => Promise.reject(sendError),
    receive: () => Promise.resolve({ hasData: false }),
    close: () => Promise.resolve(),
  };
  // Responder receives first then sends; the send rejection surfaces.
  await expect(
    exchangePayloads(conn, "responder", { hasData: false }),
  ).rejects.toThrow("send failed");
});

test("exchangePayloads: a pathological-count partner row fails cleanly, not with a RangeError", async () => {
  // A single row of ~300k invalid inner cells: the count that overflowed Zod's
  // call stack on the unbounded `z.array(z.array(z.string().nullable()))` schema
  // (RangeError). The single-issue row validator must turn it into a clean
  // protocol rejection. receiveParsed wraps either outcome as a
  // ConnectionError("protocol"); the improvement under test is that the cause is a
  // bounded validation error, not the RangeError.
  const [connA, connB] = createMessagePipe();
  const initiatorPromise = exchangePayloads(connA, "initiator", {
    hasData: false,
  });
  await connB.receive(); // consume the initiator's hasData:false frame
  await connB.send({
    hasData: true,
    columns: ["c"],
    rowIndices: [0],
    rows: [Array.from({ length: 300_000 }, () => 1)],
  });
  const err = await initiatorPromise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("protocol");
  expect((err as ConnectionError).cause).not.toBeInstanceOf(RangeError);
});

test("exchangePayloads: a pathological-count columns array fails cleanly, not with a RangeError", async () => {
  // ~4M invalid (non-string) column names, past the ~3.5M `Invalid string
  // length` threshold the unbounded `z.array(z.string())` schema hit (a ~4.5s
  // CPU burn then a RangeError). The single-issue validator caps that at one
  // clean issue; receiveParsed wraps it as ConnectionError("protocol").
  const [connA, connB] = createMessagePipe();
  const initiatorPromise = exchangePayloads(connA, "initiator", {
    hasData: false,
  });
  await connB.receive();
  await connB.send({
    hasData: true,
    columns: Array.from({ length: 4_000_000 }, () => 1),
    rowIndices: [0],
    rows: [["v"]],
  });
  const err = await initiatorPromise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("protocol");
  expect((err as ConnectionError).cause).not.toBeInstanceOf(RangeError);
});

test("exchangePayloads: a pathological-count rowIndices array fails cleanly, not with a RangeError", async () => {
  // ~4M invalid (negative) row indices, past the same threshold. rowIndices is
  // one per matched record, legitimately in the millions, so a count `.max()` is
  // unusable; the single-issue validator caps accumulation regardless of the
  // length mismatch with `rows`.
  const [connA, connB] = createMessagePipe();
  const initiatorPromise = exchangePayloads(connA, "initiator", {
    hasData: false,
  });
  await connB.receive();
  await connB.send({
    hasData: true,
    columns: ["c"],
    rowIndices: Array.from({ length: 4_000_000 }, () => -1),
    rows: [["v"]],
  });
  const err = await initiatorPromise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("protocol");
  expect((err as ConnectionError).cause).not.toBeInstanceOf(RangeError);
});

test("exchangePayloads: a pathological-count rows array fails cleanly, not with a RangeError", async () => {
  // ~4M invalid (non-array) ROWS. #220 made each ROW single-issue (capping a row
  // of millions of invalid cells), but left the outer row COUNT unbounded -- so
  // millions of invalid rows still accumulate one issue per row and burn the
  // event loop (`Invalid string length` at the top). The outer `rows` is now a
  // single-issue validator too, so the whole 2-D structure yields one issue.
  const [connA, connB] = createMessagePipe();
  const initiatorPromise = exchangePayloads(connA, "initiator", {
    hasData: false,
  });
  await connB.receive();
  await connB.send({
    hasData: true,
    columns: ["c"],
    rowIndices: [0],
    rows: Array.from({ length: 4_000_000 }, () => 0),
  });
  const err = await initiatorPromise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("protocol");
  expect((err as ConnectionError).cause).not.toBeInstanceOf(RangeError);
});

test("exchangePayloads: a legitimately large partner payload parses", async () => {
  // rows and rowIndices are one entry per matched record, legitimately in the
  // millions; a count `.max()` low enough to forestall the overflow would reject
  // this, the single-issue validators do not. 200k clears the ~130k overflow
  // threshold, so this also proves a VALID large message never trips the bound.
  const n = 200_000;
  const [connA, connB] = createMessagePipe();
  const initiatorPromise = exchangePayloads(connA, "initiator", {
    hasData: false,
  });
  await connB.receive();
  await connB.send({
    hasData: true,
    columns: ["c"],
    rowIndices: Array.from({ length: n }, (_, i) => i),
    rows: Array.from({ length: n }, () => ["v"]),
  });
  const received = await initiatorPromise;
  expect(received.rows).toHaveLength(n);
});

// --- buildOutputTable --------------------------------------------------------

test("buildOutputTable: our header uses identifier column name", () => {
  const partnerPayload: PartnerPayload = {
    columns: ["partner_id"],
    rowIndices: [0],
    rows: [["Q0"]],
  };
  const { headers } = buildOutputTable(
    [[0], [0]],
    rawRows,
    metaWithId,
    partnerPayload,
  );
  expect(headers[0]).toBe("patient_id");
});

test("buildOutputTable: our header falls back to row_id when no identifier", () => {
  const partnerPayload: PartnerPayload = {
    columns: ["diagnosis"],
    rowIndices: [0],
    rows: [["X"]],
  };
  const { headers } = buildOutputTable(
    [[0], [0]],
    rawRows,
    metaNoId,
    partnerPayload,
  );
  expect(headers[0]).toBe("row_id");
});

test("buildOutputTable: our row_id value is the 0-based row index", () => {
  const partnerPayload: PartnerPayload = {
    columns: [],
    rowIndices: [],
    rows: [],
  };
  const { rows } = buildOutputTable(
    [
      [2, 4],
      [0, 1],
    ],
    rawRows,
    metaNoId,
    partnerPayload,
  );
  expect(rows[0][0]).toBe("2");
  expect(rows[1][0]).toBe("4");
});

test("buildOutputTable: partner columns use plain names when no collision", () => {
  const partnerPayload: PartnerPayload = {
    columns: ["partner_id", "notes"],
    rowIndices: [0, 1],
    rows: [
      ["Q0", "note0"],
      ["Q1", "note1"],
    ],
  };
  const { headers } = buildOutputTable(
    [
      [0, 1],
      [0, 1],
    ],
    rawRows,
    metaWithId,
    partnerPayload,
  );
  expect(headers).toEqual(["patient_id", "partner_id", "notes"]);
});

test("buildOutputTable: their_ prefix disambiguates same-named columns", () => {
  // Both datasets have a column named "patient_id"; the their_ prefix on the
  // partner column keeps them distinct.
  const partnerPayload: PartnerPayload = {
    columns: ["patient_id"],
    rowIndices: [0],
    rows: [["Q0"]],
  };
  const { headers } = buildOutputTable(
    [[0], [0]],
    rawRows,
    metaWithId,
    partnerPayload,
  );
  expect(headers).toEqual(["patient_id", "their_patient_id"]);
});

test("buildOutputTable: maps partner rows correctly when their indices are not in pairing order", () => {
  // Our rows 0, 2, 4 matched with their rows 3, 1, 2 respectively.
  // Partner's payload includes rowIndices so the join does not depend on
  // ordering.
  const partnerPayload: PartnerPayload = {
    columns: ["partner_id"],
    rowIndices: [1, 2, 3],
    rows: [["Q1"], ["Q2"], ["Q3"]],
  };
  const { rows } = buildOutputTable(
    [
      [0, 2, 4],
      [3, 1, 2],
    ],
    rawRows,
    metaWithId,
    partnerPayload,
  );
  expect(rows).toEqual([
    ["P0", "Q3"], // our row 0 → their row 3 → payload index 2
    ["P2", "Q1"], // our row 2 → their row 1 → payload index 0
    ["P4", "Q2"], // our row 4 → their row 2 → payload index 1
  ]);
});

test("buildOutputTable: empty association table yields no rows", () => {
  const partnerPayload: PartnerPayload = {
    columns: ["partner_id"],
    rowIndices: [],
    rows: [],
  };
  const { rows } = buildOutputTable(
    [[], []],
    rawRows,
    metaWithId,
    partnerPayload,
  );
  expect(rows).toHaveLength(0);
});

test("buildOutputTable: no partner payload appends row_id with partner index", () => {
  const partnerPayload: PartnerPayload = {
    columns: [],
    rowIndices: [],
    rows: [],
  };
  const { headers, rows } = buildOutputTable(
    [
      [0, 1],
      [0, 1],
    ],
    rawRows,
    metaWithId,
    partnerPayload,
  );
  expect(headers).toEqual(["patient_id", "row_id"]);
  expect(rows[0]).toEqual(["P0", "0"]);
  expect(rows[1]).toEqual(["P1", "1"]);
});

test("buildOutputTable: CSV-escapes values containing commas", () => {
  const specialRows = [{ ssn: "001", patient_id: "A,B", diagnosis: "C" }];
  const partnerPayload: PartnerPayload = {
    columns: [],
    rowIndices: [],
    rows: [],
  };
  const { rows } = buildOutputTable(
    [[0], [0]],
    specialRows,
    metaWithId,
    partnerPayload,
  );
  expect(rows[0][0]).toBe('"A,B"');
});

test("buildOutputTable: throws when partner payload is missing an association table index", () => {
  const partnerPayload: PartnerPayload = {
    columns: ["partner_id"],
    rowIndices: [0], // missing index 1
    rows: [["Q0"]],
  };
  expect(() =>
    buildOutputTable(
      [
        [0, 1],
        [0, 1], // their index 1 has no corresponding payload row
      ],
      rawRows,
      metaWithId,
      partnerPayload,
    ),
  ).toThrow("1");
});

test("buildOutputTable: CSV-escapes values containing double-quotes", () => {
  const specialRows = [{ ssn: "001", patient_id: 'say "hi"', diagnosis: "C" }];
  const partnerPayload: PartnerPayload = {
    columns: [],
    rowIndices: [],
    rows: [],
  };
  const { rows } = buildOutputTable(
    [[0], [0]],
    specialRows,
    metaWithId,
    partnerPayload,
  );
  expect(rows[0][0]).toBe('"say ""hi"""');
});

test("buildOutputTable: CSV-escapes values containing carriage returns", () => {
  const specialRows = [{ ssn: "001", patient_id: "a\rb", diagnosis: "C" }];
  const partnerPayload: PartnerPayload = {
    columns: [],
    rowIndices: [],
    rows: [],
  };
  const { rows } = buildOutputTable(
    [[0], [0]],
    specialRows,
    metaWithId,
    partnerPayload,
  );
  expect(rows[0][0]).toBe('"a\rb"');
});

test("buildOutputTable: falls back to row index when rawRows entry is missing", () => {
  // associationTable[0] references index 5, which is out of range for rawRows
  const partnerPayload: PartnerPayload = {
    columns: [],
    rowIndices: [],
    rows: [],
  };
  const { rows } = buildOutputTable(
    [[5], [0]],
    rawRows, // only has indices 0-4
    metaWithId,
    partnerPayload,
  );
  expect(rows[0][0]).toBe("5");
});

test("buildOutputTable: throws when association table arrays have different lengths", () => {
  const partnerPayload: PartnerPayload = {
    columns: [],
    rowIndices: [],
    rows: [],
  };
  expect(() =>
    buildOutputTable(
      [[0, 1], [0]], // length 2 vs length 1
      rawRows,
      metaWithId,
      partnerPayload,
    ),
  ).toThrow("2");
});

test("buildOutputTable: null partner payload cells are emitted as empty strings", () => {
  const partnerPayload: PartnerPayload = {
    columns: ["partner_id", "notes"],
    rowIndices: [0],
    rows: [[null, "note0"]], // partner_id is null for this row
  };
  const { rows } = buildOutputTable(
    [[0], [0]],
    rawRows,
    metaWithId,
    partnerPayload,
  );
  expect(rows[0][1]).toBe(""); // null -> ""
  expect(rows[0][2]).toBe("note0");
});

test("buildOutputTable: throws when partner payload rowIndices and rows have different lengths", () => {
  const partnerPayload: PartnerPayload = {
    columns: ["partner_id"],
    rowIndices: [0, 1],
    rows: [["Q0"]], // length 1 vs rowIndices length 2
  };
  expect(() =>
    buildOutputTable([[0], [0]], rawRows, metaWithId, partnerPayload),
  ).toThrow("2");
});

test("buildOutputTable: throws when partner payload rowIndices contains duplicates", () => {
  const partnerPayload: PartnerPayload = {
    columns: ["partner_id"],
    rowIndices: [0, 0], // duplicate
    rows: [["Q0"], ["Q0"]],
  };
  expect(() =>
    buildOutputTable(
      [
        [0, 1],
        [0, 0],
      ],
      rawRows,
      metaWithId,
      partnerPayload,
    ),
  ).toThrow("duplicate");
});
