import { describe, expect, test } from "vitest";
import { getDefaultLinkageTerms, inferMetadata } from "@psilink/core";

import { composeManagedExchangeFile } from "@psi/managedExchangeRecord";
import { prepareManagedRerunExchange } from "@psi/managedPreparedExchange";

import type { CSVRow } from "@psilink/core";

// The re-run's prepared-exchange assembly, tested in Node: the persisted document's
// own-perspective terms bind to this run's rows, and the received-payload commitment
// is threaded from the record's persisted `expectedPayloadColumns` exactly as the
// accept path threads it from the invitation's disclosed set.

const columns = ["first_name", "last_name", "date_of_birth"];
const rows: Array<CSVRow> = [
  { first_name: "Ada", last_name: "Lovelace", date_of_birth: "12/10/1815" },
];

// The terms a deposit composed from this party's own file: the built-in rule set
// narrowed to the keys these columns support, which is what a re-run's own
// columns then have to satisfy in full.
const standingTerms = (identity: string) =>
  getDefaultLinkageTerms(identity, inferMetadata(columns));

function exchangeFile(expectedPayloadColumns?: Array<string>) {
  return composeManagedExchangeFile({
    connection: { channel: "webrtc", host: "signaling.example.org" },
    linkageTerms: standingTerms("County Health Dept"),
    ...(expectedPayloadColumns !== undefined ? { expectedPayloadColumns } : {}),
  });
}

describe("prepareManagedRerunExchange", () => {
  test("binds the persisted terms to this run's rows and identity", () => {
    const prepared = prepareManagedRerunExchange(exchangeFile(), rows, columns);
    expect(prepared.linkageTerms.identity).toBe("County Health Dept");
    expect(prepared.rowCount).toBe(1);
  });

  test("threads the persisted expected-payload commitment onto the prepared exchange", () => {
    const prepared = prepareManagedRerunExchange(
      exchangeFile(["shared_id"]),
      rows,
      columns,
    );
    // The received-payload commitment is the record's persisted set, passed as-is (the
    // same explicit commitment the accept path applies from the disclosed set).
    expect(prepared.expectedPayloadColumns).toEqual(["shared_id"]);
  });

  test("a record with no commitment leaves it undefined (lazy reconciliation)", () => {
    const prepared = prepareManagedRerunExchange(exchangeFile(), rows, columns);
    expect(prepared.expectedPayloadColumns).toBeUndefined();
  });

  test("threads the persisted terms-side commitment onto the prepared exchange", () => {
    // A managed re-run holds no invitation token, so the declaration it binds the
    // inviter to comes from the record's own document. Both booleans: `false` is a
    // real declaration, and the one an inviter would widen away from by presenting
    // `true` at a later re-run's terms exchange.
    for (const declared of [false, true]) {
      const document = composeManagedExchangeFile({
        connection: { channel: "webrtc", host: "signaling.example.org" },
        linkageTerms: standingTerms("County Health Dept"),
        expectedPartnerDeduplicate: declared,
      });
      const prepared = prepareManagedRerunExchange(document, rows, columns);
      expect(prepared.expectedPartnerDeduplicate).toBe(declared);
    }
  });

  test("a record with no declaration binds nothing", () => {
    // An inviter's record, or one composed from no acceptance: nothing was
    // declared to this party, so the partner's presented value is unconstrained.
    const prepared = prepareManagedRerunExchange(exchangeFile(), rows, columns);
    expect(prepared.expectedPartnerDeduplicate).toBeUndefined();
  });

  test("refuses before connecting when the run's set is not the one consented to", () => {
    // A stored acceptor document whose consent names a set this run's columns no
    // longer resolve: the re-run must refuse rather than transmit it. The document
    // has no metadata, so the set resolves from THIS run's header.
    const stale = composeManagedExchangeFile({
      connection: { channel: "webrtc", host: "signaling.example.org" },
      linkageTerms: standingTerms("Clinic A"),
      outboundPayloadConsent: {
        status: "confirmed",
        columns: ["consented_column"],
      },
    });
    expect(() => prepareManagedRerunExchange(stale, rows, columns)).toThrow(
      /not the ones you confirmed/,
    );
  });

  test("a consent record covering the run's set prepares normally", () => {
    const covered = composeManagedExchangeFile({
      connection: { channel: "webrtc", host: "signaling.example.org" },
      linkageTerms: standingTerms("Clinic A"),
      outboundPayloadConsent: { status: "confirmed", columns: [] },
    });
    expect(() =>
      prepareManagedRerunExchange(covered, rows, columns),
    ).not.toThrow();
  });
});
