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

  test("an unexplained auth failure reads as a check-with-partner line, never attack framing", () => {
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
    // The list's quiet form of the unexplained tier: the honest lead, not the
    // attack checklist (that lives on the exchange's own surface).
    expect(row.status).toMatch(/check with your partner/i);
    expect(row.status).not.toMatch(/attack|tamper|desync|impersonat/i);
  });

  test("a recorded storage failure reads as its specific benign line", () => {
    const row = savedExchangeRow(
      record({
        lastRun: {
          at: "2026-07-10T09:00:00.000Z",
          outcome: "failed",
          failureKind: "storage",
        },
      }),
      undefined,
      NOW,
    );
    expect(row.status).toMatch(/could not be saved/i);
    expect(row.status).toMatch(/re-invite/i);
  });

  test("an auth failure on a restored record reads as the benign restore line", () => {
    const local: ManagedLocalState = {
      imported: { importedAt: "2026-07-09T00:00:00.000Z" },
    };
    const row = savedExchangeRow(
      record({
        lastRun: {
          at: "2026-07-10T09:00:00.000Z",
          outcome: "failed",
          failureKind: "auth",
        },
      }),
      local,
      NOW,
    );
    expect(row.status).toMatch(/restored from a backup/i);
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
  // Currency is now structural: a rotation clears the marker atomically and an export
  // binds its bytes to the marker, so the row derives state from marker presence
  // alone, independent of the record's lastRun.
  test("no marker at all is backup-needed", () => {
    expect(savedExchangeRow(record(), undefined, NOW).backup).toEqual({
      kind: "backup-needed",
    });
  });

  test("a present marker reads backed-up, carrying its date", () => {
    const local: ManagedLocalState = {
      backup: { backedUpAt: "2026-07-10T09:00:00.000Z" },
    };
    const row = savedExchangeRow(record(), local, NOW);
    expect(row.backup.kind).toBe("backed-up");
  });

  test("a present marker reads backed-up regardless of the last run's instant", () => {
    // A marker chronologically before the last successful run still reads backed-up:
    // the rotation would have cleared a stale marker, so a marker present at all is
    // by construction current -- the model no longer re-derives staleness here.
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
