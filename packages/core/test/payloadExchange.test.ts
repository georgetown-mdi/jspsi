import { expect, test } from "vitest";

import {
  preparePayload,
  exchangePayloads,
  buildOutputTable,
  assertPayloadSendDisclosed,
} from "../src/payloadExchange";
import { prepareForExchange } from "../src/exchange";
import { deriveAcceptedLinkageTerms } from "../src/config/linkageTerms";
import { UsageError } from "../src/errors";

import type { Metadata } from "../src/config/metadata";
import type { LinkageTerms, Payload } from "../src/config/linkageTerms";
import { MAX_NAME_LENGTH } from "../src/config/linkageTerms";
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

// --- assertPayloadSendDisclosed ----------------------------------------------

// The payload.send data dictionary (exchanged, consented to, and written into
// the exchange record) must not over-declare relative to what metadata actually
// transmits (isDisclosedToPartner = isPayload && role !== "ignored"). Forward
// direction only; an over-declaration is rejected (UsageError -> CLI exit 64).

test("assertPayloadSendDisclosed: a send column with isPayload:false is rejected", () => {
  const meta: Metadata = [
    { name: "ssn", type: "ssn", role: "linkage", isPayload: false },
    { name: "diagnosis", type: "other", role: "payload", isPayload: false },
  ];
  const payload: Payload = { send: [{ name: "diagnosis" }] };
  expect(() => assertPayloadSendDisclosed(payload, meta)).toThrow(UsageError);
  // The offending column is named so the operator can reconcile it.
  expect(() => assertPayloadSendDisclosed(payload, meta)).toThrow(/diagnosis/);
});

test("assertPayloadSendDisclosed: a send column with role:ignored is rejected", () => {
  const meta: Metadata = [
    { name: "ssn", type: "ssn", role: "linkage", isPayload: false },
    { name: "county", type: "other", role: "ignored", isPayload: true },
  ];
  const payload: Payload = { send: [{ name: "county" }] };
  expect(() => assertPayloadSendDisclosed(payload, meta)).toThrow(UsageError);
  expect(() => assertPayloadSendDisclosed(payload, meta)).toThrow(/county/);
});

test("assertPayloadSendDisclosed: a send column absent from metadata is rejected", () => {
  const meta: Metadata = [
    { name: "ssn", type: "ssn", role: "linkage", isPayload: false },
  ];
  const payload: Payload = { send: [{ name: "ghost" }] };
  expect(() => assertPayloadSendDisclosed(payload, meta)).toThrow(UsageError);
});

test("assertPayloadSendDisclosed: a fully disclosed send dictionary is accepted", () => {
  const meta: Metadata = [
    { name: "ssn", type: "ssn", role: "linkage", isPayload: false },
    { name: "diagnosis", type: "other", role: "payload", isPayload: true },
    { name: "enrollment", type: "other", role: "payload", isPayload: true },
  ];
  const payload: Payload = {
    send: [{ name: "diagnosis" }, { name: "enrollment" }],
  };
  expect(() => assertPayloadSendDisclosed(payload, meta)).not.toThrow();
});

test("assertPayloadSendDisclosed: an identifier column left isPayload:true is disclosed and accepted", () => {
  // isDisclosedToPartner is isPayload && role !== "ignored", so a role:identifier
  // column left isPayload:true IS transmitted -- the subtle case the predicate's
  // doc warns about. A payload.send naming it must be accepted, not flagged.
  const meta: Metadata = [
    { name: "ssn", type: "ssn", role: "linkage", isPayload: false },
    {
      name: "patient_id",
      type: "identifier",
      role: "identifier",
      isPayload: true,
    },
  ];
  const payload: Payload = { send: [{ name: "patient_id" }] };
  expect(() => assertPayloadSendDisclosed(payload, meta)).not.toThrow();
});

test("assertPayloadSendDisclosed: an absent or empty payload is a no-op", () => {
  const meta: Metadata = [
    { name: "diagnosis", type: "other", role: "payload", isPayload: true },
  ];
  expect(() => assertPayloadSendDisclosed(undefined, meta)).not.toThrow();
  expect(() => assertPayloadSendDisclosed({ send: [] }, meta)).not.toThrow();
});

test("assertPayloadSendDisclosed: every over-declared column is named, disclosed ones are not", () => {
  const meta: Metadata = [
    { name: "kept", type: "other", role: "payload", isPayload: true },
    { name: "off", type: "other", role: "payload", isPayload: false },
    { name: "skip", type: "other", role: "ignored", isPayload: true },
  ];
  const payload: Payload = {
    send: [{ name: "kept" }, { name: "off" }, { name: "skip" }],
  };
  let message = "";
  try {
    assertPayloadSendDisclosed(payload, meta);
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  // Both gated-off columns are listed, in send order; the disclosed one is not.
  expect(message).toContain("[off, skip]");
  expect(message).not.toContain("kept");
});

test("prepareForExchange: rejects a config whose payload.send over-declares", () => {
  const metadata: Metadata = [
    {
      name: "first_name",
      type: "first_name",
      role: "linkage",
      isPayload: false,
    },
    { name: "secret", type: "other", role: "ignored", isPayload: true },
  ];
  const linkageTerms = {
    version: "1.0.0",
    identity: "Tester",
    date: "2026-01-01",
    algorithm: "psi" as const,
    output: { expectsOutput: true, shareWithPartner: true },
    deduplicate: false,
    linkageFields: [{ name: "first_name", type: "first_name" as const }],
    linkageKeys: [{ name: "FN", elements: [{ field: "first_name" }] }],
    payload: { send: [{ name: "secret" }] },
  };
  // The check fires during preparation, before any connection or dataset build.
  expect(() =>
    prepareForExchange(
      { linkageTerms, metadata },
      "Tester",
      [{ first_name: "Alice", secret: "x" }],
      ["first_name", "secret"],
    ),
  ).toThrow(UsageError);
});

// --- assertPayloadSendDisclosed on the ACCEPTOR path -------------------------

// assertPayloadSendDisclosed runs in prepareForExchange for EVERY party,
// including the acceptor, whose payload is the MIRROR of the inviter's
// (deriveAcceptedLinkageTerms): the acceptor's `send` is the inviter's `receive`
// -- the PARTNER's columns the inviter requested, which are in the ACCEPTOR's own
// column namespace. Validating that mirrored send against the acceptor's own
// metadata is therefore the correct, same-namespace comparison. (The earlier
// verbatim adoption put the inviter's send -- in the INVITER's namespace -- onto
// the acceptor, so checking it against the acceptor's metadata cross-referenced
// the wrong namespace; the mirror removes that. Item 203461508.)

const inviterBaseTerms: LinkageTerms = {
  version: "1.0.0",
  identity: "Inviter",
  date: "2026-01-01",
  algorithm: "psi",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [{ name: "first_name", type: "first_name" }],
  linkageKeys: [{ name: "FN", elements: [{ field: "first_name" }] }],
};

test("assertPayloadSendDisclosed (acceptor path): a mirrored send the acceptor discloses is accepted", () => {
  // The inviter REQUESTS case_id from the partner (payload.receive); the mirror
  // makes it the acceptor's payload.send, in the acceptor's own namespace.
  const inviter: LinkageTerms = {
    ...inviterBaseTerms,
    payload: { receive: [{ name: "case_id" }] },
  };
  const acceptor = deriveAcceptedLinkageTerms(inviter, "Acceptor");
  expect(acceptor.payload).toStrictEqual({ send: [{ name: "case_id" }] });
  // The acceptor discloses case_id in its OWN metadata, so the same-namespace
  // check accepts the mirrored send.
  const acceptorMeta: Metadata = [
    {
      name: "first_name",
      type: "first_name",
      role: "linkage",
      isPayload: false,
    },
    { name: "case_id", type: "other", role: "payload", isPayload: true },
  ];
  expect(() =>
    assertPayloadSendDisclosed(acceptor.payload, acceptorMeta),
  ).not.toThrow();
});

test("assertPayloadSendDisclosed (acceptor path): a mirrored send the acceptor does NOT disclose is rejected", () => {
  // Same inviter request, but the acceptor never marked case_id as sent (role
  // ignored wins over isPayload). The mirrored send over-declares against the
  // acceptor's OWN metadata -- a genuine acceptor over-declaration, correctly
  // rejected, preserving the forward-only subset guarantee on the acceptor too.
  const inviter: LinkageTerms = {
    ...inviterBaseTerms,
    payload: { receive: [{ name: "case_id" }] },
  };
  const acceptor = deriveAcceptedLinkageTerms(inviter, "Acceptor");
  const acceptorMeta: Metadata = [
    {
      name: "first_name",
      type: "first_name",
      role: "linkage",
      isPayload: false,
    },
    { name: "case_id", type: "other", role: "ignored", isPayload: true },
  ];
  expect(() =>
    assertPayloadSendDisclosed(acceptor.payload, acceptorMeta),
  ).toThrow(UsageError);
  expect(() =>
    assertPayloadSendDisclosed(acceptor.payload, acceptorMeta),
  ).toThrow(/case_id/);
});

test("assertPayloadSendDisclosed (acceptor path): the common inviter-send shape leaves the acceptor send empty (dormant early-return)", () => {
  // The common shape: the inviter authors a send and NO receive. The mirror puts
  // the inviter's send into the acceptor's RECEIVE, leaving the acceptor's send
  // absent -- so the check early-returns regardless of the acceptor's metadata,
  // and a legitimate inviter-authored send (in the inviter's namespace) is never
  // falsely rejected on the acceptor.
  const inviter: LinkageTerms = {
    ...inviterBaseTerms,
    payload: { send: [{ name: "enrollment_date" }] },
  };
  const acceptor = deriveAcceptedLinkageTerms(inviter, "Acceptor");
  expect(acceptor.payload).toStrictEqual({
    receive: [{ name: "enrollment_date" }],
  });
  expect(acceptor.payload?.send).toBeUndefined();
  // enrollment_date is the INVITER's column; the acceptor need not have it, and
  // the check does not consult it because the acceptor's send is empty.
  const acceptorMeta: Metadata = [
    {
      name: "first_name",
      type: "first_name",
      role: "linkage",
      isPayload: false,
    },
  ];
  expect(() =>
    assertPayloadSendDisclosed(acceptor.payload, acceptorMeta),
  ).not.toThrow();
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

test("exchangePayloads: an empty partner column name is rejected as a protocol error", async () => {
  // The wire `columns` predicate floors each name at .min(1): a partner that
  // hand-crafts a `""` column -- to drive this party's record build into the
  // non-fatal guard that drops the audit record while the exchange still completes
  // -- is rejected as a clean ConnectionError("protocol"). Honest senders never
  // emit an empty name (inferMetadata rejects it at intake), so this floor cannot
  // regress them.
  const [connA, connB] = createMessagePipe();
  const initiatorPromise = exchangePayloads(connA, "initiator", {
    hasData: false,
  });
  await connB.receive();
  await connB.send({
    hasData: true,
    columns: [""],
    rowIndices: [0],
    rows: [["v"]],
  });
  const err = await initiatorPromise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("protocol");
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

test("exchangePayloads: an over-long partner column name is rejected at the wire", async () => {
  // A received column name flows verbatim into this party's local exchange-record
  // file, so the wire predicate bounds each name's LENGTH to MAX_NAME_LENGTH. A
  // name one character over the bound is rejected as a clean protocol error
  // before any column name reaches the record.
  const [connA, connB] = createMessagePipe();
  const initiatorPromise = exchangePayloads(connA, "initiator", {
    hasData: false,
  });
  await connB.receive();
  await connB.send({
    hasData: true,
    columns: ["a".repeat(MAX_NAME_LENGTH + 1)],
    rowIndices: [0],
    rows: [["v"]],
  });
  const err = await initiatorPromise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("protocol");
});

test("exchangePayloads: a partner column name at the length bound is accepted", async () => {
  // The boundary case: a name of exactly MAX_NAME_LENGTH is legitimate and must
  // pass unchanged, so the bound rejects only what exceeds it.
  const name = "a".repeat(MAX_NAME_LENGTH);
  const [connA, connB] = createMessagePipe();
  const initiatorPromise = exchangePayloads(connA, "initiator", {
    hasData: false,
  });
  await connB.receive();
  await connB.send({
    hasData: true,
    columns: [name],
    rowIndices: [0],
    rows: [["v"]],
  });
  const received = await initiatorPromise;
  expect(received.columns).toEqual([name]);
});

test("exchangePayloads: the column-name length bound counts UTF-16 code units", async () => {
  // The bound is value.length (UTF-16 code units), matching every other
  // MAX_NAME_LENGTH use in the codebase, and the wire and record bounds use the
  // identical unit so they cannot disagree. Pin the unit so a future switch to
  // code points or graphemes fails here: an astral (surrogate-pair) character
  // counts as its two code units, not one visible character.
  const astral = "\u{1D54F}"; // U+1D54F, one visible char, two UTF-16 code units
  const atBound = astral.repeat(MAX_NAME_LENGTH / 2); // exactly MAX_NAME_LENGTH units
  expect(atBound.length).toBe(MAX_NAME_LENGTH);

  // At the bound: accepted and round-tripped unchanged.
  const [acceptA, acceptB] = createMessagePipe();
  const acceptP = exchangePayloads(acceptA, "initiator", { hasData: false });
  await acceptB.receive();
  await acceptB.send({
    hasData: true,
    columns: [atBound],
    rowIndices: [0],
    rows: [["v"]],
  });
  expect((await acceptP).columns).toEqual([atBound]);

  // One code unit over: rejected as a clean protocol error.
  const [rejectA, rejectB] = createMessagePipe();
  const rejectP = exchangePayloads(rejectA, "initiator", { hasData: false });
  await rejectB.receive();
  await rejectB.send({
    hasData: true,
    columns: [atBound + "a"],
    rowIndices: [0],
    rows: [["v"]],
  });
  const err = await rejectP.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("protocol");
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
