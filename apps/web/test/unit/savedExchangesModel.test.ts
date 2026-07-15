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
import type { ManagedLocalState } from "@psi/managedLocalState";

// The saved-exchanges run list's display derivation, tested in Node: the side
// label, the one-line status from `lastRun` and `expires`, the derived backup
// state, and the spent (handed-off) state. The status is a plain last-run summary --
// the tiered desync/attack copy is a later item, so a failed run reads neutrally
// here.

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
    const row = savedExchangeRow(record({ side: "inviter" }), undefined, NOW);
    expect(row.sideLabel).toBe("You invite");
    expect(row.status).toBe("Not run yet");
    expect(row.expired).toBe(false);
  });

  test("the acceptor side is named for the operator", () => {
    expect(
      savedExchangeRow(record({ side: "acceptor" }), undefined, NOW).sideLabel,
    ).toBe("You accept");
  });

  test("a succeeded run names its date", () => {
    const row = savedExchangeRow(
      record({
        lastRun: { at: "2026-07-10T09:00:00.000Z", outcome: "succeeded" },
      }),
      undefined,
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
      undefined,
      NOW,
    );
    expect(row.status).toMatch(/did not complete/);
    expect(row.status).not.toMatch(/attack|tamper|desync/i);
  });

  test("a lapsed secret is flagged and named in the status", () => {
    const row = savedExchangeRow(
      record({ expires: "2026-07-01T00:00:00.000Z" }),
      undefined,
      NOW,
    );
    expect(row.expired).toBe(true);
    expect(row.status).toMatch(/lapsed/);
    expect(row.status).toMatch(/re-invite/);
  });
});

describe("savedExchangeRow backup state", () => {
  test("no marker at all is backup-needed", () => {
    expect(savedExchangeRow(record(), undefined, NOW).backup).toEqual({
      kind: "backup-needed",
    });
  });

  test("a marker with no successful run reads backed-up", () => {
    const local: ManagedLocalState = {
      backup: { backedUpAt: "2026-07-10T09:00:00.000Z" },
    };
    const row = savedExchangeRow(record(), local, NOW);
    expect(row.backup.kind).toBe("backed-up");
  });

  test("a marker older than the last successful run reads backup-needed", () => {
    const local: ManagedLocalState = {
      backup: { backedUpAt: "2026-07-09T09:00:00.000Z" },
    };
    const row = savedExchangeRow(
      record({
        lastRun: { at: "2026-07-10T09:00:00.000Z", outcome: "succeeded" },
      }),
      local,
      NOW,
    );
    expect(row.backup).toEqual({ kind: "backup-needed" });
  });

  test("a marker at or after the last successful run reads backed-up", () => {
    const local: ManagedLocalState = {
      backup: { backedUpAt: "2026-07-11T09:00:00.000Z" },
    };
    const row = savedExchangeRow(
      record({
        lastRun: { at: "2026-07-10T09:00:00.000Z", outcome: "succeeded" },
      }),
      local,
      NOW,
    );
    expect(row.backup.kind).toBe("backed-up");
  });
});

describe("savedExchangeRow spent state", () => {
  test("a spent record names its handoff date", () => {
    const local: ManagedLocalState = {
      spent: { spentAt: "2026-07-12T09:00:00.000Z" },
    };
    const row = savedExchangeRow(record(), local, NOW);
    expect(row.spentAsOf).toBeDefined();
  });

  test("a live record carries no spent date", () => {
    expect(
      savedExchangeRow(record(), undefined, NOW).spentAsOf,
    ).toBeUndefined();
  });
});

describe("savedExchangeRows", () => {
  test("derives a row per record in store order, joined to local state", () => {
    const local = new Map<string, ManagedLocalState>([
      ["two", { spent: { spentAt: "2026-07-12T09:00:00.000Z" } }],
    ]);
    const rows = savedExchangeRows(
      [record({ id: "one" }), record({ id: "two" })],
      local,
      NOW,
    );
    expect(rows.map((row) => row.id)).toEqual(["one", "two"]);
    expect(rows[0].spentAsOf).toBeUndefined();
    expect(rows[1].spentAsOf).toBeDefined();
  });
});
