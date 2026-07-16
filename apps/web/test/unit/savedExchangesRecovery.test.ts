import { describe, expect, test } from "vitest";

import {
  UNREADABLE_RECORD_LABEL,
  recoveryRow,
  recoveryRows,
} from "@bench/savedExchangesRecovery";

import type { ManagedExchangeDiagnosticEntry } from "@psi/managedExchangeStore";

// The read-failed recovery listing's display derivation, tested in Node: a readable
// entry surfaces its label, side, and last-run date; an unreadable entry surfaces a
// fixed label and its stored key, and nothing more. Every row carries the key the
// one-step delete-by-key acts on.

function readable(
  overrides: Partial<{
    id: string;
    label: string;
    side: "inviter" | "acceptor";
    lastRunAt: string;
  }> = {},
): ManagedExchangeDiagnosticEntry {
  return {
    kind: "readable",
    essentials: {
      id: overrides.id ?? "abc",
      label: overrides.label ?? "Riverbend quarterly",
      side: overrides.side ?? "inviter",
      ...(overrides.lastRunAt !== undefined
        ? { lastRunAt: overrides.lastRunAt }
        : {}),
    },
  };
}

describe("recoveryRow", () => {
  test("a readable entry surfaces its label, side, and last-run date", () => {
    const row = recoveryRow(
      readable({
        id: "one",
        label: "Riverbend quarterly",
        side: "acceptor",
        lastRunAt: "2026-07-10T09:00:00.000Z",
      }),
    );
    expect(row.id).toBe("one");
    expect(row.label).toBe("Riverbend quarterly");
    expect(row.sideLabel).toBe("You accept");
    expect(row.lastRunAt).toBeDefined();
    expect(row.unreadable).toBe(false);
  });

  test("an empty label reads as (unnamed exchange), matching the run list", () => {
    expect(recoveryRow(readable({ label: "" })).label).toBe(
      "(unnamed exchange)",
    );
  });

  test("a readable entry with no run carries no last-run date", () => {
    expect(recoveryRow(readable()).lastRunAt).toBeUndefined();
  });

  test("an unreadable entry surfaces the fixed label, its key, and nothing else", () => {
    const row = recoveryRow({ kind: "unreadable", id: "bad-key" });
    expect(row.id).toBe("bad-key");
    expect(row.label).toBe(UNREADABLE_RECORD_LABEL);
    expect(row.sideLabel).toBeUndefined();
    expect(row.lastRunAt).toBeUndefined();
    expect(row.unreadable).toBe(true);
  });
});

describe("recoveryRows", () => {
  test("derives a row per entry in order, mixing readable and unreadable", () => {
    const rows = recoveryRows([
      readable({ id: "one" }),
      { kind: "unreadable", id: "two" },
    ]);
    expect(rows.map((row) => row.id)).toEqual(["one", "two"]);
    expect(rows[0].unreadable).toBe(false);
    expect(rows[1].unreadable).toBe(true);
  });
});
