import { describe, expect, test } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@psilink/core";

import {
  MANAGED_EXCHANGE_SCHEMA_VERSION,
  composeManagedExchangeFile,
} from "@psi/managed/managedExchangeRecord";
import {
  savedExchangeRow,
  savedExchangeRows,
} from "@recurring/savedExchangesModel";

import type {
  ManagedExchangeRecord,
  ManagedExchangeSchedule,
} from "@psi/managed/managedExchangeRecord";
import type { ManagedLocalState } from "@psi/managed/managedLocalState";

// The saved-exchanges run list's display derivation, tested in Node: the side
// label, the one-line status from `lastRun` and `expires`, the derived backup
// state, and the spent (handed-off) state. The status is a plain last-run summary --
// the tiered desync/attack copy is a later item, so a failed run displays
// neutrally here.

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

  test("an unexplained auth failure displays as a check-with-partner line, never attack framing", () => {
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
    // The list's quiet form of the unexplained tier: the accurate lead, not
    // the attack checklist (that lives on the exchange's own surface).
    expect(row.status).toMatch(/check with your partner/i);
    expect(row.status).not.toMatch(/attack|tamper|desync|impersonat/i);
  });

  test("a recorded storage failure displays as its specific benign line", () => {
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

  test("a consent refusal displays as its own quiet line, not a connection problem", () => {
    const row = savedExchangeRow(
      record({
        lastRun: {
          at: "2026-07-10T09:00:00.000Z",
          outcome: "failed",
          failureKind: "consent",
        },
      }),
      undefined,
      NOW,
    );
    expect(row.status).toMatch(/stopped before sending/i);
    expect(row.status).toMatch(/what it sends/i);
    expect(row.status).not.toMatch(/attack|tamper|desync|connection/i);
  });

  test("a linkage shortfall displays as its own quiet line, not the input file's", () => {
    const row = savedExchangeRow(
      record({
        lastRun: {
          at: "2026-07-10T09:00:00.000Z",
          outcome: "failed",
          failureKind: "terms-shortfall",
        },
      }),
      undefined,
      NOW,
    );
    expect(row.status).toMatch(/settle the terms/i);
    // Not the input tier's line: putting the file back is not this state's remedy.
    expect(row.status).not.toMatch(/could not use your input file/i);
    expect(row.status).not.toMatch(/attack|tamper|desync/i);
  });

  test("a partner no-show displays as the arrival line, never a window or a connection problem", () => {
    const row = savedExchangeRow(
      record({
        lastRun: { at: "2026-07-10T09:00:00.000Z", outcome: "missed" },
      }),
      undefined,
      NOW,
    );
    expect(row.status).toMatch(/partner did not arrive/i);
    // The same line stands for an attended run whose wait expired, so it names no
    // window and no connection fault on this device.
    expect(row.status).not.toMatch(/window|connection/i);
    expect(row.status).not.toMatch(/attack|tamper|desync/i);
  });

  test("an auth failure on a restored record displays as the benign restore line", () => {
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
  // Currency is structural: a rotation clears the marker atomically and an export
  // binds its bytes to the marker, so the row derives state from marker presence
  // alone, independent of the record's lastRun.
  test("no marker at all is backup-needed", () => {
    expect(savedExchangeRow(record(), undefined, NOW).backup).toEqual({
      kind: "backup-needed",
    });
  });

  test("a present marker displays as backed-up, including its date", () => {
    const local: ManagedLocalState = {
      backup: { backedUpAt: "2026-07-10T09:00:00.000Z" },
    };
    const row = savedExchangeRow(record(), local, NOW);
    expect(row.backup.kind).toBe("backed-up");
  });

  test("a present marker displays as backed-up regardless of the last run's instant", () => {
    // A marker chronologically before the last successful run still displays
    // as backed-up: the rotation would have cleared a stale marker, so a
    // marker present at all is by construction current.
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
    // A migration spend has no hand-off: it is the one an import revives, and
    // the row's recovery line says so.
    expect(row.spentHandoff).toBeUndefined();
  });

  test("a command-line hand-off is named as one", () => {
    // The two spends have different recoveries, so the row holds which one it
    // was rather than one "handed off" line for both.
    const local: ManagedLocalState = {
      spent: { spentAt: "2026-07-12T09:00:00.000Z", handoff: "command-line" },
    };
    const row = savedExchangeRow(record(), local, NOW);
    expect(row.spentAsOf).toBeDefined();
    expect(row.spentHandoff).toBe("command-line");
  });

  test("a live record has no spent date", () => {
    expect(
      savedExchangeRow(record(), undefined, NOW).spentAsOf,
    ).toBeUndefined();
  });
});

describe("savedExchangeRow schedule lines", () => {
  // NOW is 2026-07-14T12:00Z: window 0 of this daily cadence opened an hour before
  // it and closes two hours after, so NOW sits inside a window.
  const daily: ManagedExchangeSchedule = {
    anchor: "2026-07-14T11:00:00.000Z",
    intervalDays: 1,
    windowSeconds: 10_800,
    nextWindow: "2026-07-14T11:00:00.000Z",
    consecutiveMisses: 0,
  };

  test("a record with no schedule has no schedule lines at all", () => {
    // Nothing about scheduling exists for an exchange nobody scheduled, so the row
    // is exactly what it was before schedules were shown.
    expect(savedExchangeRow(record(), undefined, NOW).schedule).toBeUndefined();
  });

  test("an open window is named as open, with when it closes", () => {
    const row = savedExchangeRow(record({ schedule: daily }), undefined, NOW);
    expect(row.schedule?.dueLine).toMatch(/^Run window open now, until /);
    expect(row.schedule?.missLine).toBeUndefined();
  });

  test("between windows the next one is named, not the one that passed", () => {
    // This cadence's window opened at 06:00 and closed at 09:00, three hours
    // before NOW: the row names tomorrow's window rather than today's.
    const row = savedExchangeRow(
      record({
        schedule: {
          ...daily,
          anchor: "2026-07-13T06:00:00.000Z",
          nextWindow: "2026-07-13T06:00:00.000Z",
        },
      }),
      undefined,
      NOW,
    );
    expect(row.schedule?.dueLine).toMatch(/^Next run window: /);
  });

  test("one miss stays quiet; the second puts the coordination line on the row", () => {
    const once = savedExchangeRow(
      record({ schedule: { ...daily, consecutiveMisses: 1 } }),
      undefined,
      NOW,
    );
    expect(once.schedule?.missLine).toBeUndefined();

    const twice = savedExchangeRow(
      record({ schedule: { ...daily, consecutiveMisses: 2 } }),
      undefined,
      NOW,
    );
    // The list's quiet form of the coordination state: both checks named, the
    // full prompt left to the exchange's own surface.
    expect(twice.schedule?.missLine).toMatch(/partner/i);
    expect(twice.schedule?.missLine).toMatch(/clock/i);
    expect(twice.schedule?.missLine).not.toMatch(/attack|tamper|desync/i);
  });

  test("a lapsed secret keeps its window line beside the lapse", () => {
    // The two states compose rather than one suppressing the other: a lapse is
    // recovered by a re-invite, which keeps the cadence the partnership agreed, so
    // the row names the lapse AND where the recurrence stands. Contrast the spent
    // row below, whose copy this browser no longer runs at all.
    const row = savedExchangeRow(
      record({ expires: "2026-07-01T00:00:00.000Z", schedule: daily }),
      undefined,
      NOW,
    );
    expect(row.expired).toBe(true);
    expect(row.status).toMatch(/lapsed/);
    expect(row.schedule?.dueLine).toMatch(/^Run window open now, until /);
  });

  test("a spent row names no window: this browser's copy no longer runs", () => {
    const local: ManagedLocalState = {
      spent: { spentAt: "2026-07-12T09:00:00.000Z", handoff: "command-line" },
    };
    const row = savedExchangeRow(
      record({ schedule: { ...daily, consecutiveMisses: 3 } }),
      local,
      NOW,
    );
    expect(row.spentAsOf).toBeDefined();
    expect(row.schedule).toBeUndefined();
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
