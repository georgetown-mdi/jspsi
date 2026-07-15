import { describe, expect, test } from "vitest";

import { deriveManagedBackupState } from "@psi/managedBackupState";

import type { ManagedBackupMarker } from "@psi/managedBackupState";

// The one derived backup state, now marker-present/absent: a present marker is
// backed-up, no marker is backup-needed. Currency is carried structurally by how the
// marker is written and cleared (an export binds the serialized bytes to the marker;
// a rotation clears it atomically -- see managedExchangeStore), not re-derived here.
// No secret material and no navigator.storage.persisted() is ever an input.

function marker(backedUpAt: string): ManagedBackupMarker {
  return { backedUpAt };
}

describe("deriveManagedBackupState", () => {
  test("no marker is backup-needed", () => {
    expect(deriveManagedBackupState(undefined)).toEqual({
      kind: "backup-needed",
    });
  });

  test("a present marker is backed-up, carrying its instant", () => {
    expect(
      deriveManagedBackupState(marker("2026-07-10T09:00:00.000Z")),
    ).toEqual({ kind: "backed-up", backedUpAt: "2026-07-10T09:00:00.000Z" });
  });
});
