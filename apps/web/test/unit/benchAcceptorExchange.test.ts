import { describe, expect, test } from "vitest";

import { acceptorInitialColumnsState } from "@bench/acceptorColumnsModel";
import { prepareAcceptorExchange } from "@bench/acceptorExchange";

import type { CSVRow, LinkageTerms, Metadata } from "@psilink/core";
import type { AcceptorDataEdits } from "@psi/acceptInvitation";

// Two single-element name keys plus a payload the inviter sends, adopted verbatim
// from the invitation. The identity is the INVITER's; the acceptor substitutes its
// own name through acceptorExchangeDataSpec / deriveAcceptedLinkageTerms.
const inviterTerms: LinkageTerms = {
  version: "1.0.0",
  identity: "County Health Department",
  date: "2026-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [
    { name: "firstName", type: "first_name" },
    { name: "lastName", type: "last_name" },
  ],
  linkageKeys: [
    { name: "first", elements: [{ field: "firstName" }] },
    { name: "last", elements: [{ field: "lastName" }] },
  ],
  payload: {
    send: [{ name: "program_code" }],
    receive: [],
  },
};

const columns = ["first_name", "last_name"];
const rawRows: Array<CSVRow> = [
  { first_name: "Alice", last_name: "Smith" },
  { first_name: "Bob", last_name: "Jones" },
];

// The confirm-columns edits the run assembles the spec from: the file-derived
// metadata (normalized for the editor, as acceptorInitialColumnsState seeds it)
// and its recommended cleaning, standing in for the launch payload.
function editsFor(metadata: Metadata): AcceptorDataEdits {
  return { metadata, standardization: [] };
}

// The file-derived seed metadata the columns step starts from.
const seedMetadata = acceptorInitialColumnsState(columns).metadata;

describe("prepareAcceptorExchange", () => {
  const baseEdits = editsFor(seedMetadata);

  test("adopts the invitation's terms under the committed name", () => {
    const prepared = prepareAcceptorExchange({
      linkageTerms: inviterTerms,
      acceptorName: "Sam Alvarez",
      edits: baseEdits,
      rawRows,
      columns,
      disclosedPayloadColumns: ["program_code"],
    });
    // The acceptor's identity replaces the inviter's; the adopted fields and keys
    // are the invitation's exactly.
    expect(prepared.linkageTerms.identity).toBe("Sam Alvarez");
    expect(prepared.linkageTerms.linkageFields).toEqual(
      inviterTerms.linkageFields,
    );
    expect(prepared.linkageTerms.linkageKeys).toEqual(inviterTerms.linkageKeys);
    // The run binds to the acquired CSV with no re-parse.
    expect(prepared.rawRows).toBe(rawRows);
    expect(prepared.rowCount).toBe(2);
  });

  test("locks in the received-payload columns to the disclosed set exactly", () => {
    const prepared = prepareAcceptorExchange({
      linkageTerms: inviterTerms,
      acceptorName: "Sam Alvarez",
      edits: baseEdits,
      rawRows,
      columns,
      disclosedPayloadColumns: ["program_code", "enrollment_date"],
    });
    // The consent-screen disclosed set is the exact lock-in, so an inviter that
    // transmits a different column set aborts (reconcileReceivedPayload).
    expect(prepared.expectedPayloadColumns).toEqual([
      "program_code",
      "enrollment_date",
    ]);
  });

  test("the empty disclosed set locks in 'receive nothing' (not lazy)", () => {
    const prepared = prepareAcceptorExchange({
      linkageTerms: inviterTerms,
      acceptorName: "Sam Alvarez",
      edits: baseEdits,
      rawRows,
      columns,
      disclosedPayloadColumns: [],
    });
    // An empty set is a lock-in, not the lazy case: a later non-empty payload
    // aborts. So the prepared value is the empty array, never undefined.
    expect(prepared.expectedPayloadColumns).toEqual([]);
  });

  test("an omitted disclosed set stays lazy (undefined)", () => {
    const prepared = prepareAcceptorExchange({
      linkageTerms: inviterTerms,
      acceptorName: "Sam Alvarez",
      edits: baseEdits,
      rawRows,
      columns,
      disclosedPayloadColumns: undefined,
    });
    // Only an omitted field is lazy: the acceptor reconciles from the first
    // transmission.
    expect(prepared.expectedPayloadColumns).toBeUndefined();
  });

  test("threads the confirm-columns edits into the prepared metadata", () => {
    // Mark last_name ignored: the edited metadata drives the prepared metadata,
    // proving the confirm-columns edits (not a CSV-inferred default) reach the run.
    const edited = seedMetadata.map((column) =>
      column.name === "last_name"
        ? { ...column, role: "ignored" as const }
        : column,
    );
    const prepared = prepareAcceptorExchange({
      linkageTerms: inviterTerms,
      acceptorName: "Sam Alvarez",
      edits: editsFor(edited),
      rawRows,
      columns,
      disclosedPayloadColumns: ["program_code"],
    });
    expect(
      prepared.metadata.find((column) => column.name === "last_name")?.role,
    ).toBe("ignored");
  });
});
