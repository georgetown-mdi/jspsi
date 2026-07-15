import { describe, expect, test } from "vitest";
import { getDefaultLinkageTerms } from "@psilink/core";

import { composeManagedExchangeFile } from "@psi/managedExchangeRecord";
import { prepareManagedRerunExchange } from "@psi/managedPreparedExchange";

import type { CSVRow } from "@psilink/core";

// The re-run's prepared-exchange assembly, tested in Node: the persisted document's
// own-perspective terms bind to this run's rows, and the received-payload lock-in
// is threaded from the record's persisted `expectedPayloadColumns` exactly as the
// accept path threads it from the invitation's disclosed set.

const columns = ["first_name", "last_name", "date_of_birth"];
const rows: Array<CSVRow> = [
  { first_name: "Ada", last_name: "Lovelace", date_of_birth: "12/10/1815" },
];

function exchangeFile(expectedPayloadColumns?: Array<string>) {
  return composeManagedExchangeFile({
    connection: { channel: "webrtc", host: "signaling.example.org" },
    linkageTerms: getDefaultLinkageTerms("County Health Dept"),
    ...(expectedPayloadColumns !== undefined ? { expectedPayloadColumns } : {}),
  });
}

describe("prepareManagedRerunExchange", () => {
  test("binds the persisted terms to this run's rows and identity", () => {
    const prepared = prepareManagedRerunExchange(exchangeFile(), rows, columns);
    expect(prepared.linkageTerms.identity).toBe("County Health Dept");
    expect(prepared.rowCount).toBe(1);
  });

  test("threads the persisted expected-payload lock-in onto the prepared exchange", () => {
    const prepared = prepareManagedRerunExchange(
      exchangeFile(["shared_id"]),
      rows,
      columns,
    );
    // The received-payload lock-in is the record's persisted set, passed as-is (the
    // same explicit lock-in the accept path applies from the disclosed set).
    expect(prepared.expectedPayloadColumns).toEqual(["shared_id"]);
  });

  test("a record with no lock-in leaves it undefined (lazy reconciliation)", () => {
    const prepared = prepareManagedRerunExchange(exchangeFile(), rows, columns);
    expect(prepared.expectedPayloadColumns).toBeUndefined();
  });
});
