import { describe, expect, test } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@psilink/core";

import {
  MANAGED_EXCHANGE_SCHEMA_VERSION,
  composeManagedExchangeFile,
} from "@psi/managedExchangeRecord";
import {
  savedExchangeRow,
  savedExchangeRows,
} from "@bench/savedExchangesModel";

import type { ManagedExchangeRecord } from "@psi/managedExchangeRecord";

// The saved-exchanges run list's display derivation, tested in Node: the side
// label, and the one-line status from `lastRun` and `expires`. The status is a
// plain last-run summary -- the tiered desync/attack copy is a later item, so a
// failed run reads neutrally here.

const NOW = Date.parse("2026-07-14T12:00:00.000Z");

function record(
  overrides: Partial<ManagedExchangeRecord> = {},
): ManagedExchangeRecord {
  return {
    schemaVersion: MANAGED_EXCHANGE_SCHEMA_VERSION,
    id: "abc",
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: { channel: "webrtc", host: "signaling.example.org" },
      linkageTerms: getDefaultLinkageTerms("County Health Dept"),
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
    ...overrides,
  };
}

describe("savedExchangeRow", () => {
  test("names the side and a never-run status", () => {
    const row = savedExchangeRow(record({ side: "inviter" }), NOW);
    expect(row.sideLabel).toBe("You invite");
    expect(row.status).toBe("Not run yet");
    expect(row.expired).toBe(false);
  });

  test("the acceptor side is named for the operator", () => {
    expect(savedExchangeRow(record({ side: "acceptor" }), NOW).sideLabel).toBe(
      "You accept",
    );
  });

  test("a succeeded run names its date", () => {
    const row = savedExchangeRow(
      record({
        lastRun: { at: "2026-07-10T09:00:00.000Z", outcome: "succeeded" },
      }),
      NOW,
    );
    expect(row.status).toMatch(/^Last run succeeded /);
  });

  test("a non-succeeded run reads neutrally, never attack framing", () => {
    const row = savedExchangeRow(
      record({
        lastRun: {
          at: "2026-07-10T09:00:00.000Z",
          outcome: "failed",
          failureKind: "auth",
        },
      }),
      NOW,
    );
    expect(row.status).toMatch(/did not complete/);
    expect(row.status).not.toMatch(/attack|tamper|desync/i);
  });

  test("a lapsed secret is flagged and named in the status", () => {
    const row = savedExchangeRow(
      record({ expires: "2026-07-01T00:00:00.000Z" }),
      NOW,
    );
    expect(row.expired).toBe(true);
    expect(row.status).toMatch(/lapsed/);
    expect(row.status).toMatch(/re-invite/);
  });
});

describe("savedExchangeRows", () => {
  test("derives a row per record in store order", () => {
    const rows = savedExchangeRows(
      [record({ id: "one" }), record({ id: "two" })],
      NOW,
    );
    expect(rows.map((row) => row.id)).toEqual(["one", "two"]);
  });
});
