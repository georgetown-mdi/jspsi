import { describe, expect, test } from "vitest";

import { deriveManagedBackupState } from "@psi/managedBackupState";

import type { ManagedBackupMarker } from "@psi/managedBackupState";
import type { ManagedExchangeLastRun } from "@psi/managedExchangeRecord";

// The one derived backup state, tested in Node across rotate/export sequences. A
// backup is current when it was taken at or after the last successful run (the last
// rotation); no marker is always backup-needed. No secret material and no
// navigator.storage.persisted() is ever an input -- the derivation reads only the
// run bookkeeping and the marker.

const succeeded = (at: string): ManagedExchangeLastRun => ({
  at,
  outcome: "succeeded",
});

function marker(backedUpAt: string): ManagedBackupMarker {
  return { backedUpAt };
}

describe("deriveManagedBackupState", () => {
  test("no marker at all is backup-needed", () => {
    expect(deriveManagedBackupState({}, undefined)).toEqual({
      kind: "backup-needed",
    });
  });

  test("a marker on a never-run record is backed-up (no rotation yet)", () => {
    expect(
      deriveManagedBackupState({}, marker("2026-07-10T09:00:00.000Z")),
    ).toEqual({ kind: "backed-up", backedUpAt: "2026-07-10T09:00:00.000Z" });
  });

  test("a marker taken after the last successful run is backed-up", () => {
    const state = deriveManagedBackupState(
      { lastRun: succeeded("2026-07-10T09:00:00.000Z") },
      marker("2026-07-10T10:00:00.000Z"),
    );
    expect(state.kind).toBe("backed-up");
  });

  test("a marker taken at the exact rotation instant is backed-up", () => {
    const state = deriveManagedBackupState(
      { lastRun: succeeded("2026-07-10T09:00:00.000Z") },
      marker("2026-07-10T09:00:00.000Z"),
    );
    expect(state.kind).toBe("backed-up");
  });

  test("a marker taken before the last successful run is backup-needed", () => {
    const state = deriveManagedBackupState(
      { lastRun: succeeded("2026-07-10T09:00:00.000Z") },
      marker("2026-07-09T09:00:00.000Z"),
    );
    expect(state).toEqual({ kind: "backup-needed" });
  });

  test("only a successful run counts as a rotation; a miss does not stale a backup", () => {
    // A missed window did not rotate the secret, so a backup taken before it stays
    // current.
    const state = deriveManagedBackupState(
      { lastRun: { at: "2026-07-10T09:00:00.000Z", outcome: "missed" } },
      marker("2026-07-05T09:00:00.000Z"),
    );
    expect(state.kind).toBe("backed-up");
  });

  test("a failed run does not stale a backup either", () => {
    const state = deriveManagedBackupState(
      {
        lastRun: {
          at: "2026-07-10T09:00:00.000Z",
          outcome: "failed",
          failureKind: "auth",
        },
      },
      marker("2026-07-05T09:00:00.000Z"),
    );
    expect(state.kind).toBe("backed-up");
  });

  test("a rotate-then-export sequence: rotation stales, re-export restores", () => {
    // Backed up, then a successful run rotates (marker now older than the run):
    // backup-needed. Re-exporting after the run restores backed-up.
    const afterExport = marker("2026-07-01T09:00:00.000Z");
    const afterRun = { lastRun: succeeded("2026-07-08T09:00:00.000Z") };
    expect(deriveManagedBackupState(afterRun, afterExport)).toEqual({
      kind: "backup-needed",
    });
    const afterReexport = marker("2026-07-08T09:00:00.000Z");
    expect(deriveManagedBackupState(afterRun, afterReexport).kind).toBe(
      "backed-up",
    );
  });

  test("currency compares instants, not strings, across ISO precisions", () => {
    // A whole-second marker sorts lexicographically after a fractional run stamp of
    // a later instant, but is the earlier instant: it must read backup-needed.
    const state = deriveManagedBackupState(
      { lastRun: succeeded("2026-07-10T09:00:00.500Z") },
      marker("2026-07-10T09:00:00Z"),
    );
    expect(state).toEqual({ kind: "backup-needed" });
  });
});
