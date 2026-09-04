import { describe, expect, test } from "vitest";
import * as z from "zod";

import {
  preparePayload,
  exchangePayloads,
  buildOutputTable,
  assertPayloadSendDisclosed,
  assertDisclosureMatchesCommitment,
  reconcileReceivedPayload,
} from "../src/payloadExchange";
import { prepareForExchange } from "../src/exchange";
import {
  deriveAcceptedLinkageTerms,
  MAX_NAME_LENGTH,
} from "../src/config/linkageTerms";
import { disclosedColumnNames } from "../src/config/metadata";
import { OutboundDisclosureRefusalError, UsageError } from "../src/errors";
import { sanitizeErrorForDisplay } from "../src/utils/sanitizeErrorForDisplay";
import { readMessage } from "./utils/compatibilityMessageReader";

import type { Metadata } from "../src/config/metadata";
import type { LinkageTerms, Output, Payload } from "../src/config/linkageTerms";
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
  // patient_id has isPayload:true -- it is transmitted, but not specially labeled
  expect(result.columns).toContain("patient_id");
  expect(result.rowIndices).toEqual([0]);
  expect(result).not.toHaveProperty("identifierColumn");
});

test("preparePayload: missing column value becomes null", () => {
  const sparse = [{ ssn: "001", patient_id: "P0" }];
  const result = preparePayload(sparse, metaWithId, [[0], [0]]);
  if (!result.hasData) throw new Error("expected hasData:true");
  expect(result.rowIndices).toEqual([0]);
  expect(result.rows[0]).toEqual(["P0", null]);
});

test("preparePayload: a short row omitting a prototype-member column sends null, not the inherited function", () => {
  // A payload column named exactly an Object.prototype member, omitted by a short
  // row: a bare row[col] would read the INHERITED function off the prototype chain
  // and transmit it to the partner. The own-property read sends null instead.
  const metaProto: Metadata = [
    { name: "ssn", type: "ssn", role: "linkage", isPayload: false },
    { name: "toString", type: "other", role: "payload", isPayload: true },
    { name: "constructor", type: "other", role: "payload", isPayload: true },
  ];
  const sparse = [{ ssn: "001" }];
  const result = preparePayload(sparse, metaProto, [[0], [0]]);
  if (!result.hasData) throw new Error("expected hasData:true");
  expect(result.columns).toEqual(["toString", "constructor"]);
  expect(result.rows[0]).toEqual([null, null]);
  for (const cell of result.rows[0])
    expect(typeof cell === "string" || cell === null).toBe(true);
});

test("preparePayload: a present prototype-member column sends its real value", () => {
  // The shadowing guard must not swallow a real value: a row that DOES hold a
  // 'toString' column transmits that value verbatim.
  const metaProto: Metadata = [
    { name: "ssn", type: "ssn", role: "linkage", isPayload: false },
    { name: "toString", type: "other", role: "payload", isPayload: true },
  ];
  const rows = [{ ssn: "001", toString: "real-value" }];
  const result = preparePayload(rows, metaProto, [[0], [0]]);
  if (!result.hasData) throw new Error("expected hasData:true");
  expect(result.columns).toEqual(["toString"]);
  expect(result.rows[0]).toEqual(["real-value"]);
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

test("buildOutputTable: a short row omitting a prototype-member identifier column falls back to the row index, not the inherited function", () => {
  // The identifier column is named exactly an Object.prototype member and the
  // matched row omits it: a bare rawRows[ourIdx]?.[ourIdCol.name] would read the
  // INHERITED function and write it into the on-disk identifier cell. The own-
  // property read falls back to String(ourIdx) as it does for any absent column.
  const metaProtoId: Metadata = [
    { name: "ssn", type: "ssn", role: "linkage", isPayload: false },
    {
      name: "toString",
      type: "identifier",
      role: "identifier",
      isPayload: false,
    },
  ];
  const sparse = [{ ssn: "001" }];
  const partnerPayload: PartnerPayload = {
    columns: ["partner_id"],
    rowIndices: [0],
    rows: [["Q0"]],
  };
  const { headers, rows } = buildOutputTable(
    [[0], [0]],
    sparse,
    metaProtoId,
    partnerPayload,
  );
  expect(headers[0]).toBe("toString");
  expect(rows[0][0]).toBe("0");
});

test("buildOutputTable: a present prototype-member identifier column emits its real value", () => {
  const metaProtoId: Metadata = [
    { name: "ssn", type: "ssn", role: "linkage", isPayload: false },
    {
      name: "toString",
      type: "identifier",
      role: "identifier",
      isPayload: false,
    },
  ];
  const rows = [{ ssn: "001", toString: "real-id" }];
  const partnerPayload: PartnerPayload = {
    columns: ["partner_id"],
    rowIndices: [0],
    rows: [["Q0"]],
  };
  const { rows: outRows } = buildOutputTable(
    [[0], [0]],
    rows,
    metaProtoId,
    partnerPayload,
  );
  expect(outRows[0][0]).toBe("real-id");
});

// --- assertPayloadSendDisclosed ----------------------------------------------

// The payload.send data dictionary (exchanged, consented to, written into the
// exchange record, and mirrored into a recurring partner's commitment) must
// name EXACTLY what metadata actually transmits (isDisclosedToPartner =
// isPayload && role !== "ignored") when present: an over-declaration (a name
// not transmitted) or an under-declaration (a transmitted column omitted) is
// rejected (UsageError -> CLI exit 64). Only an ABSENT dictionary is a no-op:
// a present-but-empty one is an explicit "I disclose nothing" and is held to
// it, in the direction where the payload actually crosses.

// The output direction every case below runs in unless it says otherwise: the
// partner is entitled to the result, so this party's disclosed columns leave the
// machine. The direction gate has its own cases further down.
const SHARING_OUTPUT: Output = { expectsOutput: true, shareWithPartner: true };

// The opposite direction: the partner receives no result, so runExchange sends it
// an empty payload message whatever the metadata discloses.
const WITHHOLDING_OUTPUT: Output = {
  expectsOutput: true,
  shareWithPartner: false,
};

test("assertPayloadSendDisclosed: a send column absent from metadata is rejected", () => {
  const meta: Metadata = [
    { name: "ssn", type: "ssn", role: "linkage", isPayload: false },
  ];
  const payload: Payload = { send: [{ name: "ghost" }] };
  expect(() =>
    assertPayloadSendDisclosed(payload, meta, SHARING_OUTPUT),
  ).toThrow(UsageError);
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
  expect(() =>
    assertPayloadSendDisclosed(payload, meta, SHARING_OUTPUT),
  ).not.toThrow();
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
  expect(() =>
    assertPayloadSendDisclosed(payload, meta, SHARING_OUTPUT),
  ).not.toThrow();
});

test("assertPayloadSendDisclosed: a non-empty send omitting a disclosed column is rejected (under-declaration)", () => {
  // A present dictionary must name the FULL disclosed set: metadata discloses
  // {diagnosis, enrollment} but the dictionary lists only diagnosis, so it
  // under-states what is sent -- and a recurring partner that mirrors this send
  // into its receive commitment would commit to too few columns and false-abort
  // the honest exchange when the metadata-governed transmission delivers
  // enrollment.
  const meta: Metadata = [
    { name: "ssn", type: "ssn", role: "linkage", isPayload: false },
    { name: "diagnosis", type: "other", role: "payload", isPayload: true },
    { name: "enrollment", type: "other", role: "payload", isPayload: true },
  ];
  const payload: Payload = { send: [{ name: "diagnosis" }] };
  expect(() =>
    assertPayloadSendDisclosed(payload, meta, SHARING_OUTPUT),
  ).toThrow(UsageError);
  // The omitted disclosed column is named so the operator can reconcile it.
  expect(() =>
    assertPayloadSendDisclosed(payload, meta, SHARING_OUTPUT),
  ).toThrow(/enrollment/);
});

test("assertPayloadSendDisclosed: a send that both over- and under-declares names both directions", () => {
  // metadata discloses {kept}; the dictionary names an undisclosed column (off)
  // and omits the disclosed one (kept), so both directions of the mismatch fire.
  const meta: Metadata = [
    { name: "kept", type: "other", role: "payload", isPayload: true },
    { name: "off", type: "other", role: "ignored", isPayload: true },
  ];
  const payload: Payload = { send: [{ name: "off" }] };
  let message = "";
  try {
    assertPayloadSendDisclosed(payload, meta, SHARING_OUTPUT);
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  expect(message).toContain('["off"]'); // over-declared (named, not transmitted)
  expect(message).toContain('["kept"]'); // under-declared (transmitted, omitted)
});

test("assertPayloadSendDisclosed: an absent payload is a no-op, a present-but-empty send is strict", () => {
  const meta: Metadata = [
    { name: "diagnosis", type: "other", role: "payload", isPayload: true },
  ];
  // Absent stays lazy: the guided and default paths author no dictionary while
  // metadata still transmits.
  expect(() =>
    assertPayloadSendDisclosed(undefined, meta, SHARING_OUTPUT),
  ).not.toThrow();
  expect(() =>
    assertPayloadSendDisclosed({}, meta, SHARING_OUTPUT),
  ).not.toThrow();
  // A present, empty send declares "I disclose nothing", so every disclosed column
  // is an under-declaration. This is the direction deriveAcceptedLinkageTerms
  // keeps strict on the acceptor by design, and holding it here is what keeps
  // those columns off the wire -- a partner can only reject them after they land.
  expect(() =>
    assertPayloadSendDisclosed({ send: [] }, meta, SHARING_OUTPUT),
  ).toThrow(UsageError);
  expect(() =>
    assertPayloadSendDisclosed({ send: [] }, meta, SHARING_OUTPUT),
  ).toThrow(/diagnosis/);
  expect(() =>
    assertPayloadSendDisclosed({ send: [] }, metaLinkageOnly, SHARING_OUTPUT),
  ).not.toThrow();
});

test("assertPayloadSendDisclosed: an empty send is not told to widen itself", () => {
  // The under-declared remedy for a non-empty dictionary ("Add [...] to
  // payload.send") is wrong advice for an empty one: on an accepted invitation the
  // empty send mirrors the inviter's payload.receive, so a local widening declares
  // a disclosure the partner never agreed to and the next acceptance overwrites.
  const meta: Metadata = [
    { name: "diagnosis", type: "other", role: "payload", isPayload: true },
  ];
  let message = "";
  try {
    assertPayloadSendDisclosed({ send: [] }, meta, SHARING_OUTPUT);
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  expect(message).not.toContain('Add ["diagnosis"] to payload.send');
  expect(message).toContain("is_payload: false or role ignored");
  expect(message).toContain("corrected invitation");
});

test("assertPayloadSendDisclosed: an empty send is not held against a partner entitled to no result", () => {
  // runExchange builds this party's payload only when the PARTNER expects output,
  // so with shareWithPartner false the disclosed columns never leave the machine
  // and the empty declaration is already honored. Refusing here would abort an
  // exchange that discloses nothing, and would contradict the acceptor consent
  // screen, which states on this same direction that no payload is sent.
  const meta: Metadata = [
    { name: "diagnosis", type: "other", role: "payload", isPayload: true },
  ];
  expect(() =>
    assertPayloadSendDisclosed({ send: [] }, meta, WITHHOLDING_OUTPUT),
  ).not.toThrow();
});

test("assertPayloadSendDisclosed: a NON-EMPTY send stays checked in both directions", () => {
  // By design, not gated on the direction, unlike the empty case above. A
  // dictionary that names columns is exchanged with the partner, shown for
  // consent, and written into the exchange record whatever the output direction,
  // so it is an accuracy control over those surfaces rather than a disclosure
  // control -- and mis-stating them is wrong even when nothing crosses.
  const meta: Metadata = [
    { name: "diagnosis", type: "other", role: "payload", isPayload: true },
  ];
  const overDeclaring: Payload = {
    send: [{ name: "diagnosis" }, { name: "absent_column" }],
  };
  expect(() =>
    assertPayloadSendDisclosed(overDeclaring, meta, WITHHOLDING_OUTPUT),
  ).toThrow(UsageError);
  expect(() =>
    assertPayloadSendDisclosed(overDeclaring, meta, WITHHOLDING_OUTPUT),
  ).toThrow(/absent_column/);
  // Under-declaration too: the dictionary names a column but omits a transmitted
  // one, and the direction does not excuse it either.
  expect(() =>
    assertPayloadSendDisclosed(
      { send: [{ name: "absent_column" }] },
      meta,
      WITHHOLDING_OUTPUT,
    ),
  ).toThrow(/diagnosis/);
});

test("assertPayloadSendDisclosed: an ABSENT send is lazy in either direction", () => {
  const meta: Metadata = [
    { name: "diagnosis", type: "other", role: "payload", isPayload: true },
  ];
  expect(() =>
    assertPayloadSendDisclosed(undefined, meta, WITHHOLDING_OUTPUT),
  ).not.toThrow();
  expect(() =>
    assertPayloadSendDisclosed({}, meta, WITHHOLDING_OUTPUT),
  ).not.toThrow();
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
    assertPayloadSendDisclosed(payload, meta, SHARING_OUTPUT);
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  // Both gated-off columns are listed, in send order, each in its own delimited
  // run; the disclosed one is not.
  expect(message).toContain('["off","skip"]');
  expect(message).not.toContain("kept");
});

// --- assertPayloadSendDisclosed: the column names an operator is shown ---------

// The offending names are partner-controlled on the accept side, where
// deriveAcceptedLinkageTerms adopts the inviter's payload declaration, so this
// refusal names values a mutually-distrusting party chose inside first-party
// prose an operator reads as psilink's own. The names therefore compose
// through the compatibility-message boundary, each in its own delimited run,
// and what the cases below hold is that boundary's claim at this site: the
// clause structure the operator is shown is the structure this function
// wrote, whatever the name says.

/** The refusal this assertion raises for `payload`/`meta`, as an operator sees it. */
const disclosureRefusal = (payload: Payload, meta: Metadata): string => {
  try {
    assertPayloadSendDisclosed(payload, meta, SHARING_OUTPUT);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("expected assertPayloadSendDisclosed to refuse");
};

const payloadColumn = (name: string) => ({
  name,
  type: "other" as const,
  role: "payload" as const,
  isPayload: true,
});

/**
 * The three clauses this message renders a name list into, each with the name
 * under test in the partner-chosen position and the rest of the case fixed. A
 * benign run and a hostile run of one entry differ in nothing but that name.
 */
const NAMED_LIST_SITES: ReadonlyArray<{
  readonly id: string;
  readonly compose: (name: string) => string;
}> = [
  {
    id: "the over-declared list",
    compose: (name) =>
      disclosureRefusal({ send: [{ name }, { name: "kept" }] }, [
        payloadColumn("kept"),
      ]),
  },
  {
    id: "the under-declared list",
    compose: (name) =>
      disclosureRefusal({ send: [{ name: "kept" }] }, [
        payloadColumn("kept"),
        payloadColumn(name),
      ]),
  },
  {
    id: "the under-declared list under an empty send",
    // The empty send's own remedy, which names the list a second time in prose
    // about a corrected invitation rather than a local edit.
    compose: (name) => disclosureRefusal({ send: [] }, [payloadColumn(name)]),
  },
];

/**
 * The adversarial name shapes, each built around the benign token the clause
 * would hold anyway: a name that closes psilink's own delimited run, one that
 * spells this message's clause separators, and one that forges an extra element
 * into the bracketed list.
 */
const BENIGN_NAME = "diagnosis";

const ADVERSARIAL_NAMES: ReadonlyArray<{
  readonly name: string;
  readonly value: string;
  readonly marker: string;
}> = [
  {
    name: "a delimiter-carrying name",
    value: `${BENIGN_NAME}"]) and omits a column metadata does transmit (["forged`,
    marker: "forged",
  },
  {
    name: "a clause-separator name",
    value: `${BENIGN_NAME}]) and omits a column metadata does transmit ([forged`,
    marker: "forged",
  },
  {
    name: "a list-forging name",
    value: `${BENIGN_NAME}, forged`,
    marker: "forged",
  },
];

/** The value with a control sequence appended, for the display escape to act on. */
const withControlSequence = (value: string): string => `${value}\x1b[31m`;

describe.each(NAMED_LIST_SITES)("$id", ({ compose }) => {
  const displayed = (name: string): string =>
    sanitizeErrorForDisplay(new Error(compose(name)));

  test.each(ADVERSARIAL_NAMES)(
    "is not restructured by $name",
    ({ value, marker }) => {
      const { skeleton, values } = readMessage(compose(value));
      // The whole claim: the operator reading the hostile run is shown exactly
      // the clause structure this function wrote for the benign one, and the
      // name is still held whole inside its run.
      expect(skeleton).toBe(readMessage(compose(BENIGN_NAME)).skeleton);
      expect(values).toContain(value);
      expect(skeleton).not.toContain(marker);
      expect(skeleton).not.toContain("<unterminated>");
    },
  );

  test.each(ADVERSARIAL_NAMES)(
    "survives the error renderer intact under $name",
    ({ value, marker }) => {
      // The delimiting is composed here and the escape runs once at the renderer
      // that shows the UsageError chain, so the structure has to hold on what
      // the operator actually sees -- with a control sequence in the name for
      // the escape to act on.
      const hostile = withControlSequence(value);
      const rendered = displayed(hostile);
      const { skeleton } = readMessage(rendered);
      expect(skeleton).toBe(readMessage(displayed(BENIGN_NAME)).skeleton);
      expect(skeleton).not.toContain(marker);
      expect(skeleton).not.toContain("<unterminated>");
      expect(rendered).not.toContain("\x1b");
    },
  );
});

test("assertPayloadSendDisclosed: a name carrying the list separator is one element", () => {
  // A single column named `a, b` and two named `a` and `b` are different
  // declarations, and the rendering has to show that rather than print the same
  // bracketed list for both -- otherwise a partner-chosen name forges an element
  // count the check never computed.
  const oneComma = disclosureRefusal({ send: [{ name: "a, b" }] }, []);
  const twoNames = disclosureRefusal(
    { send: [{ name: "a" }, { name: "b" }] },
    [],
  );
  expect(oneComma).toContain('(["a, b"])');
  expect(twoNames).toContain('(["a","b"])');
  expect(readMessage(oneComma).values).toContain("a, b");
  expect(readMessage(twoNames).values).toEqual(
    expect.arrayContaining(["a", "b"]),
  );
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
    linkageStrategy: "cascade" as const,
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
// metadata is therefore the correct, same-namespace comparison.

const inviterBaseTerms: LinkageTerms = {
  version: "1.0.0",
  identity: "Inviter",
  date: "2026-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
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
    assertPayloadSendDisclosed(acceptor.payload, acceptorMeta, SHARING_OUTPUT),
  ).not.toThrow();
});

test("assertPayloadSendDisclosed (acceptor path): a mirrored send the acceptor does NOT disclose is rejected", () => {
  // Same inviter request, but the acceptor never marked case_id as sent (role
  // ignored wins over isPayload). The mirrored send over-declares against the
  // acceptor's OWN metadata -- a genuine acceptor over-declaration, correctly
  // rejected, preserving the exact-match disclosure guarantee on the acceptor too
  // (over-declaration is one half of it; under-declaration is the other).
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
    assertPayloadSendDisclosed(acceptor.payload, acceptorMeta, SHARING_OUTPUT),
  ).toThrow(UsageError);
  expect(() =>
    assertPayloadSendDisclosed(acceptor.payload, acceptorMeta, SHARING_OUTPUT),
  ).toThrow(/case_id/);
});

test("assertPayloadSendDisclosed (acceptor path): the common inviter-send shape leaves the acceptor send ABSENT (dormant early-return)", () => {
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
    assertPayloadSendDisclosed(acceptor.payload, acceptorMeta, SHARING_OUTPUT),
  ).not.toThrow();
});

// --- No-drift: the held disclosed subset equals what is transmitted ---------

test("disclosedColumnNames equals preparePayload's transmitted columns over the same metadata", () => {
  // The set held on the invitation (disclosedColumnNames) and the set
  // preparePayload actually transmits are both isDisclosedToPartner over the same
  // metadata, so they cannot diverge -- the no-drift invariant the consent
  // display and enforcement rest on. ssn (role: linkage, isPayload:false) is
  // excluded; patient_id (role: identifier, isPayload:true) and diagnosis are
  // included.
  const carried = disclosedColumnNames(metaWithId);
  expect(carried).toEqual(["patient_id", "diagnosis"]);
  const transmitted = preparePayload(rawRows, metaWithId, [[0], [0]]);
  if (!transmitted.hasData) throw new Error("expected hasData:true");
  expect(transmitted.columns).toEqual(carried);
});

test("disclosedColumnNames excludes a role: ignored column even with isPayload:true", () => {
  const metaWithIgnored: Metadata = [
    { name: "ssn", type: "ssn", role: "linkage", isPayload: false },
    { name: "diagnosis", type: "other", role: "payload", isPayload: true },
    { name: "county", type: "other", role: "ignored", isPayload: true },
  ];
  expect(disclosedColumnNames(metaWithIgnored)).toEqual(["diagnosis"]);
});

// --- assertDisclosureMatchesCommitment (send-side prior-promise check) --------

// The persisted send-side commitment (the config's disclosedPayloadColumns, in
// this party's OWN namespace) is compared against what current metadata discloses
// (disclosedColumnNames). A drift in EITHER direction is rejected (UsageError ->
// CLI exit 64), naming the offending column(s): a promised column no longer
// transmittable (under-delivery), or a newly-transmitted column not promised
// (over-delivery). An absent commitment is a no-op (lazy); an empty commitment is
// strict "disclose nothing". Distinct from assertPayloadSendDisclosed: this
// compares CURRENT metadata against an EARLIER persisted promise, not a present
// payload.send dictionary against current metadata.

// metaWithId discloses [patient_id, diagnosis]. This variant has drifted so
// diagnosis is no longer transmitted (isPayload:false) -- it discloses only
// [patient_id].
const metaDiagDropped: Metadata = [
  { name: "ssn", type: "ssn", role: "linkage", isPayload: false },
  {
    name: "patient_id",
    type: "identifier",
    role: "identifier",
    isPayload: true,
  },
  { name: "diagnosis", type: "other", role: "payload", isPayload: false },
];

test("assertDisclosureMatchesCommitment: an absent commitment is a no-op (lazy)", () => {
  expect(() =>
    assertDisclosureMatchesCommitment(undefined, metaWithId),
  ).not.toThrow();
  expect(() =>
    assertDisclosureMatchesCommitment(undefined, metaLinkageOnly),
  ).not.toThrow();
});

test("assertDisclosureMatchesCommitment: a still-honorable commitment is accepted (any order)", () => {
  expect(() =>
    assertDisclosureMatchesCommitment(["patient_id", "diagnosis"], metaWithId),
  ).not.toThrow();
  expect(() =>
    assertDisclosureMatchesCommitment(["diagnosis", "patient_id"], metaWithId),
  ).not.toThrow();
});

test("assertDisclosureMatchesCommitment: a committed column no longer disclosed is rejected (under-delivery), naming it", () => {
  // Promised diagnosis, but metadata no longer transmits it. This is the drift
  // that would otherwise make the partner abort mid-exchange.
  expect(() =>
    assertDisclosureMatchesCommitment(
      ["patient_id", "diagnosis"],
      metaDiagDropped,
    ),
  ).toThrow(UsageError);
  expect(() =>
    assertDisclosureMatchesCommitment(
      ["patient_id", "diagnosis"],
      metaDiagDropped,
    ),
  ).toThrow(/diagnosis/);
});

test("assertDisclosureMatchesCommitment: a column now disclosed but not committed is rejected (over-delivery), naming it", () => {
  // Committed only patient_id, but metadata now also discloses diagnosis -- the
  // partner locked in {patient_id} and would abort on the extra column.
  expect(() =>
    assertDisclosureMatchesCommitment(["patient_id"], metaWithId),
  ).toThrow(UsageError);
  expect(() =>
    assertDisclosureMatchesCommitment(["patient_id"], metaWithId),
  ).toThrow(/diagnosis/);
});

test("assertDisclosureMatchesCommitment: a drift carries the disclosure-refusal type", () => {
  // The distinct type is what lets a caller keeping per-failure bookkeeping tell a
  // local refusal raised before anything is sent from a transport fault, without
  // giving up the `instanceof UsageError` classification the CLI's exit 64 rests on.
  expect(() =>
    assertDisclosureMatchesCommitment(["patient_id"], metaWithId),
  ).toThrow(OutboundDisclosureRefusalError);
});

test("assertDisclosureMatchesCommitment: an empty commitment is strict 'disclose nothing'", () => {
  expect(() => assertDisclosureMatchesCommitment([], metaWithId)).toThrow(
    UsageError,
  );
  expect(() =>
    assertDisclosureMatchesCommitment([], metaLinkageOnly),
  ).not.toThrow();
});

test("assertDisclosureMatchesCommitment: both drift directions are named at once", () => {
  // Committed [patient_id, note]; metadata discloses [patient_id, diagnosis].
  // note is no longer disclosed (under), diagnosis is newly disclosed (over).
  let message = "";
  try {
    assertDisclosureMatchesCommitment(["patient_id", "note"], metaWithId);
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  expect(message).toMatch(/note/);
  expect(message).toMatch(/diagnosis/);
});

test("assertDisclosureMatchesCommitment: the error offers a dual remedy (restore or re-establish), never only re-widening", () => {
  // The re-widening-safe wording: narrowing is legitimate, so the message must
  // present re-establishing the exchange beside restoring the column.
  let message = "";
  try {
    assertDisclosureMatchesCommitment(
      ["patient_id", "diagnosis"],
      metaDiagDropped,
    );
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  expect(message).toMatch(/re-establish the exchange|re-invite/);
  expect(message).toMatch(/is_payload/);
});

test("assertDisclosureMatchesCommitment: over-delivery's remedy points at narrowing, not the under-delivery wording", () => {
  // The over-delivery direction (a newly disclosed, uncommitted column) must tell
  // the operator to STOP transmitting it (is_payload:false / role ignored), with
  // re-inviting only as the way to widen -- it must NOT reuse the
  // under-delivery remedy ("set the metadata to transmit"), which would pressure
  // the operator toward WIDER disclosure to resolve an over-disclosure.
  let message = "";
  try {
    assertDisclosureMatchesCommitment(["patient_id"], metaWithId);
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  expect(message).toMatch(/not to transmit|is_payload: false or role ignored/);
  expect(message).toMatch(/re-establish the exchange|re-invite/);
});

test("prepareForExchange: rejects a config whose disclosed_payload_columns commitment can no longer be met, before anything is sent", () => {
  // No payload.send here (so assertPayloadSendDisclosed is a no-op) -- the drift is
  // caught solely by the persisted disclosed-columns commitment, the second of the
  // two commitment sources. The check fires during preparation, before any
  // credential, terms, or data are sent, and before the dataset build.
  const metadata: Metadata = [
    {
      name: "first_name",
      type: "first_name",
      role: "linkage",
      isPayload: false,
    },
    // Promised "note" on a prior invitation, but its metadata no longer transmits
    // it (isPayload:false), so the current disclosure discloses nothing.
    { name: "note", type: "other", role: "payload", isPayload: false },
  ];
  const linkageTerms = {
    version: "1.0.0",
    identity: "Tester",
    date: "2026-01-01",
    algorithm: "psi" as const,
    linkageStrategy: "cascade" as const,
    output: { expectsOutput: true, shareWithPartner: true },
    deduplicate: false,
    linkageFields: [{ name: "first_name", type: "first_name" as const }],
    linkageKeys: [{ name: "FN", elements: [{ field: "first_name" }] }],
  };
  expect(() =>
    prepareForExchange(
      { linkageTerms, metadata, disclosedPayloadColumns: ["note"] },
      "Tester",
      [{ first_name: "Alice", note: "x" }],
      ["first_name", "note"],
    ),
  ).toThrow(/note/);
});

test("prepareForExchange: accepts a commitment its current metadata still meets (positive wiring, no false-fire)", () => {
  // The positive counterpart of the rejection above: a present, non-empty
  // commitment that current metadata discloses EXACTLY must pass the prepare-time
  // check and let preparation complete. This pins the wiring against an
  // over-aggressive regression (e.g. comparing the commitment to the wrong
  // metadata) that would false-fire on an honest run.
  const metadata: Metadata = [
    {
      name: "first_name",
      type: "first_name",
      role: "linkage",
      isPayload: false,
    },
    // Still transmits "note" (isPayload:true), so the disclosed set is exactly the
    // committed {note}.
    { name: "note", type: "other", role: "payload", isPayload: true },
  ];
  const linkageTerms = {
    version: "1.0.0",
    identity: "Tester",
    date: "2026-01-01",
    algorithm: "psi" as const,
    linkageStrategy: "cascade" as const,
    output: { expectsOutput: true, shareWithPartner: true },
    deduplicate: false,
    linkageFields: [{ name: "first_name", type: "first_name" as const }],
    linkageKeys: [{ name: "FN", elements: [{ field: "first_name" }] }],
  };
  expect(() =>
    prepareForExchange(
      { linkageTerms, metadata, disclosedPayloadColumns: ["note"] },
      "Tester",
      [{ first_name: "Alice", note: "x" }],
      ["first_name", "note"],
    ),
  ).not.toThrow();
});

// --- reconcileReceivedPayload (runtime enforcement) --------------------------

const received = (columns: string[]): PartnerPayload => ({
  columns,
  rowIndices: columns.length > 0 ? [0] : [],
  rows: columns.length > 0 ? [columns.map(() => "x")] : [],
});

test("reconcileReceivedPayload: lazy (no declared set) accepts any payload", () => {
  expect(() =>
    reconcileReceivedPayload(received(["a", "b"]), undefined),
  ).not.toThrow();
});

test("reconcileReceivedPayload: a present empty declared set is strict (receive nothing)", () => {
  // An empty expected set is NOT lazy -- it means "receive nothing." A party not
  // entitled to output (runExchange passes []) and an inviter that disclosed nothing
  // (the mint holds []) both commit to the empty set, and a non-empty received
  // payload against it aborts. Only an absent (undefined) declared set is lazy.
  expect(() => reconcileReceivedPayload(received(["a", "b"]), [])).toThrow(
    ConnectionError,
  );
  // An empty received set against the empty declared set passes (the no-output
  // party correctly received nothing; also the zero-match case).
  expect(() => reconcileReceivedPayload(received([]), [])).not.toThrow();
});

test("reconcileReceivedPayload: an empty received set is accepted against any declared set", () => {
  // The partner sent no payload (no transmittable columns, or no matched rows),
  // which can never exceed consent -- so it is accepted even when a non-empty set
  // was locked in.
  expect(() =>
    reconcileReceivedPayload(received([]), ["a", "b"]),
  ).not.toThrow();
});

test("reconcileReceivedPayload: an exact match (any order) does not throw", () => {
  expect(() =>
    reconcileReceivedPayload(received(["b", "a"]), ["a", "b"]),
  ).not.toThrow();
});

test("reconcileReceivedPayload: a divergent received set aborts as a protocol error", () => {
  const err = (() => {
    try {
      reconcileReceivedPayload(received(["a", "secret"]), ["a", "b"]);
    } catch (e) {
      return e;
    }
    return undefined;
  })();
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("protocol");
  expect((err as ConnectionError).message).toMatch(
    /payload disclosure mismatch/,
  );
});

test("reconcileReceivedPayload: receiving fewer columns than declared also aborts", () => {
  expect(() => reconcileReceivedPayload(received(["a"]), ["a", "b"])).toThrow(
    ConnectionError,
  );
});

test("reconcileReceivedPayload: receiving more columns than declared aborts (over-delivery)", () => {
  expect(() =>
    reconcileReceivedPayload(received(["a", "b", "c"]), ["a", "b"]),
  ).toThrow(ConnectionError);
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

  expect(receivedByB.columns).toEqual(["patient_id", "diagnosis"]);
  expect(receivedByB.rowIndices).toEqual([0, 2]);
  expect(receivedByB.rows).toEqual([
    ["P0", "A"],
    ["P2", "C"],
  ]);

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
  await connB.receive();
  await connB.send({ unexpected: true });
  await expect(initiatorPromise).rejects.toThrow();
});

test("exchangePayloads: malformed data from partner rejects the responder", async () => {
  const [connA, connB] = createMessagePipe();
  const responderPromise = exchangePayloads(connB, "responder", {
    hasData: false,
  });
  await connA.send({ unexpected: true });
  await expect(responderPromise).rejects.toThrow();
});

test("exchangePayloads: a frame failing length parity is refused on parity alone, not the repeat scan", async () => {
  // Parity is checked before distinctness, so a mismatched frame is refused
  // without walking its indices -- the refusal names only the parity fault.
  const [connA, connB] = createMessagePipe();
  const initiatorPromise = exchangePayloads(connA, "initiator", {
    hasData: false,
  });
  await connB.receive();
  await connB.send({
    hasData: true,
    columns: ["patient_id"],
    rowIndices: [0, 0],
    rows: [["P0"]],
  });
  const err = await initiatorPromise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("protocol");
  expect(String((err as ConnectionError).cause)).toMatch(
    /rowIndices and rows must have the same length/,
  );
  expect(String((err as ConnectionError).cause)).not.toMatch(
    /must not repeat a row index/,
  );
});

test("exchangePayloads: a repeated row index is refused at parse, as a protocol fault", async () => {
  // `rowIndices` pairs one of the sender's rows with the payload row at the same
  // position, so a repeat names two rows for one record. The wire schema refuses
  // it where the message is parsed, with the classification every other malformed
  // partner frame gets, so the receive rejects rather than returning a payload for
  // a later stage to refuse.
  const [connA, connB] = createMessagePipe();
  const initiatorPromise = exchangePayloads(connA, "initiator", {
    hasData: false,
  });
  await connB.receive();
  await connB.send({
    hasData: true,
    columns: ["patient_id"],
    rowIndices: [2, 2],
    rows: [["P2"], ["P2"]],
  });
  const err = await initiatorPromise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("protocol");
  expect(String((err as ConnectionError).cause)).toMatch(
    /rowIndices must not repeat a row index/,
  );
});

test("exchangePayloads: distinct row indices parse whatever order they arrive in", async () => {
  // The other half of the refusal above: only repetition is refused, so an honest
  // message still parses -- including one whose indices do not ascend, which the
  // schema has never required.
  const [connA, connB] = createMessagePipe();
  const initiatorPromise = exchangePayloads(connA, "initiator", {
    hasData: false,
  });
  await connB.receive();
  await connB.send({
    hasData: true,
    columns: ["patient_id"],
    rowIndices: [2, 0],
    rows: [["P2"], ["P0"]],
  });
  await expect(initiatorPromise).resolves.toEqual({
    columns: ["patient_id"],
    rowIndices: [2, 0],
    rows: [["P2"], ["P0"]],
  });
});

test("exchangePayloads: a frame declaring no columns but carrying rows is refused at parse, as a protocol fault", async () => {
  // The starkest width fault: every value in the frame's rows belongs to a column
  // the frame does not name. Accepting it would commit those values to this
  // party's exchange record while the record's readable received-column list --
  // built from the same frame's columns -- said none were received. The wire
  // schema refuses it where the message is parsed, with the classification every
  // other malformed partner frame gets, so the receive rejects before any output
  // or record stage reads the payload.
  const [connA, connB] = createMessagePipe();
  const initiatorPromise = exchangePayloads(connA, "initiator", {
    hasData: false,
  });
  await connB.receive();
  await connB.send({
    hasData: true,
    columns: [],
    rowIndices: [0],
    rows: [["x"]],
  });
  const err = await initiatorPromise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("protocol");
  expect(String((err as ConnectionError).cause)).toMatch(
    /each payload row must have one value per declared column/,
  );
});

test("exchangePayloads: a row carrying more values than the frame names columns is refused", async () => {
  const [connA, connB] = createMessagePipe();
  const initiatorPromise = exchangePayloads(connA, "initiator", {
    hasData: false,
  });
  await connB.receive();
  await connB.send({
    hasData: true,
    columns: ["patient_id"],
    rowIndices: [0],
    rows: [["P0", "undeclared"]],
  });
  const err = await initiatorPromise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("protocol");
  expect(String((err as ConnectionError).cause)).toMatch(
    /each payload row must have one value per declared column/,
  );
});

test("exchangePayloads: a row carrying fewer values than the frame names columns is refused", async () => {
  // The other width direction, refused by the same rule: a named column with no
  // value for the record would otherwise be committed as an absent cell the
  // record's column list still claims was received.
  const [connA, connB] = createMessagePipe();
  const initiatorPromise = exchangePayloads(connA, "initiator", {
    hasData: false,
  });
  await connB.receive();
  await connB.send({
    hasData: true,
    columns: ["patient_id", "diagnosis"],
    rowIndices: [0, 2],
    rows: [["P0", "A"], ["P2"]],
  });
  const err = await initiatorPromise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("protocol");
  expect(String((err as ConnectionError).cause)).toMatch(
    /each payload row must have one value per declared column/,
  );
});

test("exchangePayloads: an ordinary output party's multi-column frame parses", async () => {
  // The accepting half of the rule: rows exactly as wide as the columns the frame
  // names parse, and a null cell counts as the value it is rather than as a
  // missing one.
  const [connA, connB] = createMessagePipe();
  const initiatorPromise = exchangePayloads(connA, "initiator", {
    hasData: false,
  });
  await connB.receive();
  await connB.send({
    hasData: true,
    columns: ["patient_id", "diagnosis"],
    rowIndices: [0, 2],
    rows: [
      ["P0", "A"],
      ["P2", null],
    ],
  });
  await expect(initiatorPromise).resolves.toEqual({
    columns: ["patient_id", "diagnosis"],
    rowIndices: [0, 2],
    rows: [
      ["P0", "A"],
      ["P2", null],
    ],
  });
});

test("exchangePayloads: a zero-match frame naming columns but carrying no rows parses", async () => {
  // No row, so no row to be too wide or too narrow: a sender with transmittable
  // columns and nothing matched is honest, and the rule leaves it alone.
  const [connA, connB] = createMessagePipe();
  const initiatorPromise = exchangePayloads(connA, "initiator", {
    hasData: false,
  });
  await connB.receive();
  await connB.send({
    hasData: true,
    columns: ["patient_id"],
    rowIndices: [],
    rows: [],
  });
  await expect(initiatorPromise).resolves.toEqual({
    columns: ["patient_id"],
    rowIndices: [],
    rows: [],
  });
});

test("exchangePayloads: a columnless frame carrying no rows parses, committing nothing", async () => {
  // The boundary the rule stops at. This party's own preparePayload sends
  // hasData:false rather than this shape, but it holds no value against no
  // column, so its record's committed payload and readable column list agree at
  // empty and there is nothing for the rule to refuse.
  const [connA, connB] = createMessagePipe();
  const initiatorPromise = exchangePayloads(connA, "initiator", {
    hasData: false,
  });
  await connB.receive();
  await connB.send({
    hasData: true,
    columns: [],
    rowIndices: [],
    rows: [],
  });
  await expect(initiatorPromise).resolves.toEqual({
    columns: [],
    rowIndices: [],
    rows: [],
  });
});

// --- the wire schema's element predicates against the schemas they replace ------

// `columns`, `rowIndices` and `rows` are validated by predicates inside a
// single-issue array (utils/singleIssueArray.ts) rather than by element schemas,
// which caps issue accumulation on a hostile frame without changing which frames
// parse. The corpus below is what holds them to that second half: every frame is
// parsed by the real receive path and by a reference schema written the plain
// way, and the two verdicts must agree. A frame reaches the schema as parsed
// JSON, so each is round-tripped through JSON first and only what a JSON body
// can hold is in scope.
const referenceFrameSchema = z.object({
  hasData: z.literal(true),
  columns: z.array(z.string().min(1).max(MAX_NAME_LENGTH)),
  rowIndices: z.array(z.number().int().nonnegative()),
  rows: z.array(z.array(z.string().nullable())),
});

// One column, one matched row, one cell. Every frame below keeps its collections
// in agreement whenever its elements are well shaped, so the schema's parity,
// width and distinctness rules never decide a verdict and the comparison is about
// element shape alone.
const frameWith = (overrides: Record<string, unknown>): unknown => ({
  hasData: true,
  columns: ["diagnosis"],
  rowIndices: [0],
  rows: [["A"]],
  ...overrides,
});

const elementShapeCorpus: Array<{ label: string; frame: unknown }> = [
  { label: "an honest one-column frame", frame: frameWith({}) },
  { label: "a null cell", frame: frameWith({ rows: [[null]] }) },
  {
    label: "a frame carrying nothing",
    frame: frameWith({ columns: [], rowIndices: [], rows: [] }),
  },
  {
    label: "a column name at the length ceiling",
    frame: frameWith({ columns: ["x".repeat(MAX_NAME_LENGTH)] }),
  },
  { label: "an empty column name", frame: frameWith({ columns: [""] }) },
  {
    label: "an overlong column name",
    frame: frameWith({ columns: ["x".repeat(MAX_NAME_LENGTH + 1)] }),
  },
  { label: "a numeric column name", frame: frameWith({ columns: [1] }) },
  { label: "a null column name", frame: frameWith({ columns: [null] }) },
  {
    label: "a columns collection that is not an array",
    frame: frameWith({ columns: "diagnosis" }),
  },
  { label: "a fractional row index", frame: frameWith({ rowIndices: [0.5] }) },
  { label: "a negative row index", frame: frameWith({ rowIndices: [-1] }) },
  {
    label: "a row index past the safe-integer ceiling",
    frame: frameWith({ rowIndices: [2 ** 53] }),
  },
  { label: "a stringified row index", frame: frameWith({ rowIndices: ["0"] }) },
  {
    label: "a rowIndices collection that is not an array",
    frame: frameWith({ rowIndices: 0 }),
  },
  { label: "a numeric cell", frame: frameWith({ rows: [[5]] }) },
  { label: "a boolean cell", frame: frameWith({ rows: [[true]] }) },
  { label: "an object cell", frame: frameWith({ rows: [[{}]] }) },
  { label: "an array cell", frame: frameWith({ rows: [[["A"]]] }) },
  { label: "a string row", frame: frameWith({ rows: ["A"] }) },
  { label: "a numeric row", frame: frameWith({ rows: [0] }) },
  { label: "a null row", frame: frameWith({ rows: [null] }) },
  {
    label: "an array-like object row",
    frame: frameWith({ rows: [{ 0: "A", length: 1 }] }),
  },
  {
    label: "a rows collection that is not an array",
    frame: frameWith({ rows: "A" }),
  },
];

/** Whether the receive path accepts `frame` as the partner's payload message. */
async function parsesOnTheWire(frame: unknown): Promise<boolean> {
  const [connA, connB] = createMessagePipe();
  const initiatorPromise = exchangePayloads(connA, "initiator", {
    hasData: false,
  });
  await connB.receive();
  await connB.send(frame);
  return initiatorPromise.then(
    () => true,
    () => false,
  );
}

test("the wire schema's element predicates accept exactly what the element schemas they replace accept", async () => {
  const accepted: string[] = [];
  const refused: string[] = [];
  for (const { label, frame } of elementShapeCorpus) {
    const asDelivered: unknown = JSON.parse(JSON.stringify(frame));
    const wireVerdict = await parsesOnTheWire(asDelivered);
    const referenceVerdict =
      referenceFrameSchema.safeParse(asDelivered).success;
    // Labelled so a divergence names the frame that diverged rather than
    // reporting a bare boolean mismatch.
    expect(`${label}: ${String(wireVerdict)}`).toBe(
      `${label}: ${String(referenceVerdict)}`,
    );
    (wireVerdict ? accepted : refused).push(label);
  }
  // A corpus that drifted to all-accepting or all-refusing would agree with any
  // predicate at all, so both verdicts have to be represented.
  expect(accepted.length).toBeGreaterThan(0);
  expect(refused.length).toBeGreaterThan(0);
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
  // Responder receives first then sends; the send rejection shows up.
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
  // ~4M invalid (non-array) ROWS. Each ROW is single-issue (capping a row of
  // millions of invalid cells), but an unbounded outer row COUNT would let
  // millions of invalid rows accumulate one issue per row and burn the event
  // loop (`Invalid string length` at the top). The outer `rows` is a
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
  expect(headers).toEqual(["patient_id", "row_id", "partner_id", "notes"]);
});

test("buildOutputTable: their_ prefix disambiguates same-named columns", () => {
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
  expect(headers).toEqual(["patient_id", "row_id", "their_patient_id"]);
});

test("buildOutputTable: partner row-index header falls back past colliding partner columns", () => {
  // Adversarial header collision: the partner sends columns literally named
  // "row_id" and "their_row_id", both of which the partner row-index column would
  // otherwise take. uniqueColumnName walks past them to their_row_id_2, so every
  // header stays distinct rather than silently duplicating.
  const partnerPayload: PartnerPayload = {
    columns: ["row_id", "their_row_id"],
    rowIndices: [3],
    rows: [["A", "B"]],
  };
  const { headers, rows } = buildOutputTable(
    [[0], [3]],
    rawRows,
    metaWithId,
    partnerPayload,
  );
  // ourBaseName is patient_id, so the partner value columns keep their names; the
  // partner-index column becomes their_row_id_2 (row_id and their_row_id taken).
  expect(headers).toEqual([
    "patient_id",
    "their_row_id_2",
    "row_id",
    "their_row_id",
  ]);
  expect(new Set(headers).size).toBe(headers.length);
  expect(rows[0]).toEqual(["P0", "3", "A", "B"]); // partner index in column 2
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
  // Column 2 is the partner row index (their side of the pairing); the payload
  // value follows.
  expect(rows).toEqual([
    ["P0", "3", "Q3"], // our row 0 -> their row 3 -> payload index 2
    ["P2", "1", "Q1"], // our row 2 -> their row 1 -> payload index 0
    ["P4", "2", "Q2"], // our row 4 -> their row 2 -> payload index 1
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
    rowIndices: [0],
    rows: [["Q0"]],
  };
  expect(() =>
    buildOutputTable(
      [
        [0, 1],
        [0, 1],
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
  const partnerPayload: PartnerPayload = {
    columns: [],
    rowIndices: [],
    rows: [],
  };
  const { rows } = buildOutputTable(
    [[5], [0]],
    rawRows,
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
    buildOutputTable([[0, 1], [0]], rawRows, metaWithId, partnerPayload),
  ).toThrow("2");
});

test("buildOutputTable: null partner payload cells are emitted as empty strings", () => {
  const partnerPayload: PartnerPayload = {
    columns: ["partner_id", "notes"],
    rowIndices: [0],
    rows: [[null, "note0"]],
  };
  const { rows } = buildOutputTable(
    [[0], [0]],
    rawRows,
    metaWithId,
    partnerPayload,
  );
  expect(rows[0][1]).toBe("0"); // partner row index column
  expect(rows[0][2]).toBe(""); // null partner_id -> ""
  expect(rows[0][3]).toBe("note0");
});

test("buildOutputTable: throws when partner payload rowIndices and rows have different lengths", () => {
  const partnerPayload: PartnerPayload = {
    columns: ["partner_id"],
    rowIndices: [0, 1],
    rows: [["Q0"]],
  };
  expect(() =>
    buildOutputTable([[0], [0]], rawRows, metaWithId, partnerPayload),
  ).toThrow("2");
});

test("buildOutputTable: throws when partner payload rowIndices contains duplicates", () => {
  const partnerPayload: PartnerPayload = {
    columns: ["partner_id"],
    rowIndices: [0, 0],
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

test("buildOutputTable: throws when a partner payload row is narrower than the declared columns", () => {
  const partnerPayload: PartnerPayload = {
    columns: ["partner_id", "notes"],
    rowIndices: [0],
    rows: [["Q0"]],
  };
  expect(() =>
    buildOutputTable([[0], [0]], rawRows, metaWithId, partnerPayload),
  ).toThrow("one cell per declared column");
});

test("buildOutputTable: throws when a partner payload row is wider than the declared columns", () => {
  const partnerPayload: PartnerPayload = {
    columns: ["partner_id", "notes"],
    rowIndices: [0],
    rows: [["Q0", "note0", "extra"]],
  };
  expect(() =>
    buildOutputTable([[0], [0]], rawRows, metaWithId, partnerPayload),
  ).toThrow("one cell per declared column");
});

test("buildOutputTable: throws when a partner payload row is not a row at all", () => {
  // The exported entry point takes a plain PartnerPayload, so a caller past the
  // type can hand it a string whose LENGTH matches the declared column count.
  // The width comparison alone admits it, and the cells the result would then
  // hold are that string's characters, one per column.
  const partnerPayload: PartnerPayload = {
    columns: ["partner_id", "notes"],
    rowIndices: [0],
    rows: ["Q0" as unknown as Array<string | null>],
  };
  expect(() =>
    buildOutputTable([[0], [0]], rawRows, metaWithId, partnerPayload),
  ).toThrow("not an array of cells");
});

/** The error `run` threw, failing the test when it threw nothing. */
function refusalFrom(run: () => unknown): unknown {
  try {
    run();
  } catch (err: unknown) {
    return err;
  }
  throw new Error("expected a refusal, but the call returned");
}

test("buildOutputTable: an array-valued partner payload cell is refused rather than written unquoted", () => {
  // quoteCsvField asks its value for the characters RFC 4180 escapes with
  // `includes`, which an array answers by element: `["a,b"].includes(",")` is
  // false, so the cell would reach the result unquoted and its own separator
  // would frame two result fields where the payload declared one value.
  const partnerPayload: PartnerPayload = {
    columns: ["notes"],
    rowIndices: [0],
    rows: [[["a,b"] as unknown as string]],
  };
  expect(() =>
    buildOutputTable([[0], [0]], rawRows, metaWithId, partnerPayload),
  ).toThrow("neither a string nor null");
});

test("buildOutputTable: a partner payload cell of any other shape is refused as a shape fault, not a TypeError", () => {
  // The exported entry point takes a plain PartnerPayload, so a caller past the
  // type can hand it a cell of any shape at all. Each is refused with the same
  // class of message the not-a-row and width faults hold.
  for (const cell of [5, true, {}, ["a"], undefined, Symbol("s")]) {
    const partnerPayload: PartnerPayload = {
      columns: ["notes"],
      rowIndices: [0],
      rows: [[cell as unknown as string]],
    };
    const refusal = refusalFrom(() =>
      buildOutputTable([[0], [0]], rawRows, metaWithId, partnerPayload),
    );
    expect(refusal).toBeInstanceOf(Error);
    expect(refusal).not.toBeInstanceOf(TypeError);
    expect((refusal as Error).message).toContain("neither a string nor null");
  }
});

test("buildOutputTable: a hole in a partner payload row is emitted as an empty cell", () => {
  // `Array.prototype.every` skips holes, so a sparse row passes the cell check
  // exactly as it passes the wire schema's row predicate. No JSON body holds a
  // hole, so this shape arrives only from a caller past the type, and what it
  // writes is the empty cell an absent value gets -- neither an unquoted value
  // nor a TypeError.
  const sparseRow = new Array<string | null>(1);
  const partnerPayload: PartnerPayload = {
    columns: ["notes"],
    rowIndices: [0],
    rows: [sparseRow],
  };
  const { rows } = buildOutputTable(
    [[0], [0]],
    rawRows,
    metaWithId,
    partnerPayload,
  );
  expect(rows).toEqual([["P0", "0", ""]]);
});

test("buildOutputTable: a partner payload collection that is not an array is refused as a shape fault, not a TypeError", () => {
  // Each collection has its length read and is walked, so a non-array value would
  // otherwise reach the first array method that misses. The values below all
  // hold a `length` of 1, so nothing downstream catches them either.
  for (const field of ["columns", "rowIndices", "rows"] as const) {
    const partnerPayload = {
      columns: ["notes"],
      rowIndices: [0],
      rows: [["Q0"]],
      [field]: "x",
    } as unknown as PartnerPayload;
    const refusal = refusalFrom(() =>
      buildOutputTable([[0], [0]], rawRows, metaWithId, partnerPayload),
    );
    expect(refusal).toBeInstanceOf(Error);
    expect(refusal).not.toBeInstanceOf(TypeError);
    expect((refusal as Error).message).toContain(
      `partner payload ${field} is not an array`,
    );
  }
});

test("buildOutputTable: a partner payload column name that is not a string is refused as a shape fault, not a TypeError", () => {
  // columns passes the array-of-array-methods guards above with a numeric entry,
  // then quoteCsvField calls `.includes` on it and throws a raw TypeError instead
  // of the controlled shape refusal.
  const partnerPayload = {
    columns: [1],
    rowIndices: [0],
    rows: [["Q0"]],
  } as unknown as PartnerPayload;
  const refusal = refusalFrom(() =>
    buildOutputTable([[0], [0]], rawRows, metaWithId, partnerPayload),
  );
  expect(refusal).toBeInstanceOf(Error);
  expect(refusal).not.toBeInstanceOf(TypeError);
  expect((refusal as Error).message).toMatch(
    /a partner payload column name is not a string/,
  );
});

test("buildOutputTable: the width refusal states the declared count in agreement", () => {
  const oneColumn: PartnerPayload = {
    columns: ["partner_id"],
    rowIndices: [0],
    rows: [["Q0", "extra"]],
  };
  expect(() =>
    buildOutputTable([[0], [0]], rawRows, metaWithId, oneColumn),
  ).toThrow("expected 1 cell per row");

  const twoColumns: PartnerPayload = {
    columns: ["partner_id", "notes"],
    rowIndices: [0],
    rows: [["Q0"]],
  };
  expect(() =>
    buildOutputTable([[0], [0]], rawRows, metaWithId, twoColumns),
  ).toThrow("expected 2 cells per row");
});

// --- match multiplicity: payload rows per record, result rows per pair --------
//
// Under a deduplicating cardinality one side of the association table repeats a
// row index. The payload frame stays one row per matched RECORD -- a repeat there
// is a malformed frame the receiver's parse refuses -- while the result table is
// one row per PAIR. The cases below run a fan in each direction against each
// other: the partner's rows 0 and 1 grouped onto this party's row 1 (so this
// party is the "one" side and its local half repeats), mirrored by the partner
// holding the "many" side's table.

const ONE_SIDE_TABLE: [Array<number>, Array<number>] = [
  [1, 1, 3],
  [0, 1, 2],
];
const MANY_SIDE_TABLE: [Array<number>, Array<number>] = [
  [0, 1, 2],
  [1, 1, 3],
];

test("preparePayload: a repeated local row is transmitted exactly once", () => {
  const result = preparePayload(rawRows, metaWithId, ONE_SIDE_TABLE);
  if (!result.hasData) throw new Error("expected hasData:true");
  expect(result.rowIndices).toEqual([1, 3]);
  expect(result.rows).toEqual([
    ["P1", "B"],
    ["P3", "D"],
  ]);
});

test("exchangePayloads: a deduplicated frame survives the wire schema's distinctness rule", async () => {
  // One payload row per PAIR would repeat row index 1 and the receiver's parse
  // would refuse the whole frame; the round trip is what pins that it does not.
  const [receivedByOneSide, receivedByManySide] = await runExchangePayloads(
    preparePayload(rawRows, metaWithId, ONE_SIDE_TABLE),
    preparePayload(rawRows, metaNoId, MANY_SIDE_TABLE),
  );

  expect(receivedByManySide.rowIndices).toEqual([1, 3]);
  expect(receivedByManySide.rows).toEqual([
    ["P1", "B"],
    ["P3", "D"],
  ]);
  expect(receivedByOneSide.rowIndices).toEqual([0, 1, 2]);
  expect(receivedByOneSide.rows).toEqual([["A"], ["B"], ["C"]]);
});

test("buildOutputTable: the 'one' side writes one row per pair, its identifier repeating", async () => {
  const [receivedByOneSide] = await runExchangePayloads(
    preparePayload(rawRows, metaWithId, ONE_SIDE_TABLE),
    preparePayload(rawRows, metaNoId, MANY_SIDE_TABLE),
  );

  const { headers, rows } = buildOutputTable(
    ONE_SIDE_TABLE,
    rawRows,
    metaWithId,
    receivedByOneSide,
  );

  expect(headers).toEqual(["patient_id", "row_id", "diagnosis"]);
  expect(rows).toEqual([
    ["P1", "0", "A"],
    ["P1", "1", "B"],
    ["P3", "2", "C"],
  ]);
});

test("buildOutputTable: the 'many' side writes the one partner payload row against each grouped record", async () => {
  const [, receivedByManySide] = await runExchangePayloads(
    preparePayload(rawRows, metaWithId, ONE_SIDE_TABLE),
    preparePayload(rawRows, metaNoId, MANY_SIDE_TABLE),
  );

  const { headers, rows } = buildOutputTable(
    MANY_SIDE_TABLE,
    rawRows,
    metaNoId,
    receivedByManySide,
  );

  expect(headers).toEqual([
    "row_id",
    "their_row_id",
    "patient_id",
    "diagnosis",
  ]);
  expect(rows).toEqual([
    ["0", "1", "P1", "B"],
    ["1", "1", "P1", "B"],
    ["2", "3", "P3", "D"],
  ]);
});

test("buildOutputTable: a partner payload missing a row grouped onto several of ours names it once", () => {
  // The malformed-partner diagnostic stays clear under multiplicity: partner
  // row 1 stands against two of this party's records but is one missing row.
  const partnerPayload: PartnerPayload = {
    columns: ["diagnosis"],
    rowIndices: [3],
    rows: [["D"]],
  };
  expect(() =>
    buildOutputTable(MANY_SIDE_TABLE, rawRows, metaNoId, partnerPayload),
  ).toThrow("association table indices: 1");
});
