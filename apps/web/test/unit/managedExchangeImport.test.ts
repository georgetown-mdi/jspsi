import { describe, expect, test, vi } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@psilink/core";

import {
  ManagedImportHandedOffError,
  importManagedExchange,
} from "@psi/managed/managedExchangeImport";
import {
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
} from "@psi/managed/managedExchangeRecord";
import {
  encodeManagedExchangeArtifact,
  serializeManagedExchangeArtifact,
} from "@psi/managed/managedExchangeArtifact";

import type { ManagedExchangeRecord } from "@psi/managed/managedExchangeRecord";
import type { ManagedImportDeps } from "@psi/managed/managedExchangeImport";
import type { ManagedReviveOutcome } from "@psi/managed/managedExchangeStore";

// The import take-over, tested in Node with injected dependencies: a valid
// artifact installs one owner and marks it imported-and-backed-up; a
// migration-spent secret-match is revived in place; a match handed off by a
// route of its own refuses the import outright; a malformed or tampered file
// is rejected before any install, so the store is left untouched. The
// store-backed install (real IndexedDB) is the browser suite's.

const linkageTerms = getDefaultLinkageTerms("County Health Dept");

function goodBytes(): string {
  const record = buildManagedExchangeRecord({
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: { channel: "webrtc", host: "signaling.example.org" },
      linkageTerms,
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
  });
  return serializeManagedExchangeArtifact(
    encodeManagedExchangeArtifact(record),
  );
}

/** A backup of a record that WAS scheduled and did hold an input pointer: the
 * artifact holds the schedule, and the handle is a device-local platform
 * object no artifact can hold. */
function scheduledBytes(): string {
  const record = buildManagedExchangeRecord({
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: { channel: "webrtc", host: "signaling.example.org" },
      linkageTerms,
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
    inputFileHandle: {} as FileSystemFileHandle,
    schedule: {
      anchor: "2026-01-06T14:00:00.000Z",
      intervalDays: 7,
      windowSeconds: 10_800,
      nextWindow: "2026-01-06T14:00:00.000Z",
      consecutiveMisses: 0,
    },
  });
  return serializeManagedExchangeArtifact(
    encodeManagedExchangeArtifact(record),
  );
}

function recordingDeps(
  reconciled: ManagedReviveOutcome = { kind: "no-match" },
): ManagedImportDeps & {
  installed: Array<ManagedExchangeRecord>;
  reviveSpent: ReturnType<typeof vi.fn>;
  markImported: ReturnType<typeof vi.fn>;
} {
  const installed: Array<ManagedExchangeRecord> = [];
  return {
    installed,
    reviveSpent: vi.fn(() => Promise.resolve(reconciled)),
    install: (record) => {
      installed.push(record);
      return Promise.resolve(record);
    },
    markImported: vi.fn(() => Promise.resolve()),
    now: () => new Date("2026-07-14T12:00:00.000Z"),
  };
}

describe("importManagedExchange", () => {
  test("installs the reconstructed record and marks it imported and backed-up", async () => {
    const deps = recordingDeps();
    const installed = await importManagedExchange(goodBytes(), deps);
    expect(deps.reviveSpent).toHaveBeenCalledOnce();
    expect(deps.installed).toHaveLength(1);
    expect(deps.markImported).toHaveBeenCalledWith(
      installed.id,
      "2026-07-14T12:00:00.000Z",
    );
  });

  test("revives a migration-spent secret-match in place instead of installing a duplicate", async () => {
    const existing = buildManagedExchangeRecord({
      label: "Riverbend quarterly",
      exchangeFile: composeManagedExchangeFile({
        connection: { channel: "webrtc", host: "signaling.example.org" },
        linkageTerms,
      }),
      side: "inviter",
      sharedSecret: generateSharedSecret(),
    });
    const deps = recordingDeps({ kind: "revived", record: existing });
    const result = await importManagedExchange(goodBytes(), deps);
    // The revived record is returned; nothing fresh is installed and no separate
    // marker write runs (the revive stamped it in its own transaction).
    expect(result).toBe(existing);
    expect(deps.installed).toHaveLength(0);
    expect(deps.markImported).not.toHaveBeenCalled();
  });

  test("a match handed off by another route refuses, installing nothing", async () => {
    // The husk the artifact would fork: the exchange runs from what the hand-off
    // saved, so neither reviving it here nor installing a second live copy beside it
    // is an import -- the refusal holds the stored record's label so the surface
    // can name the exchange the operator still has.
    const deps = recordingDeps({
      kind: "handed-off",
      handoff: "command-line",
      label: "Riverbend quarterly",
    });
    await expect(importManagedExchange(goodBytes(), deps)).rejects.toThrow(
      ManagedImportHandedOffError,
    );
    await expect(
      importManagedExchange(goodBytes(), deps),
    ).rejects.toMatchObject({
      handoff: "command-line",
      label: "Riverbend quarterly",
    });
    expect(deps.installed).toHaveLength(0);
    expect(deps.markImported).not.toHaveBeenCalled();
  });

  test("a marker-write failure after a fresh install still reports success", async () => {
    const deps = recordingDeps();
    deps.markImported.mockRejectedValueOnce(new Error("marker write failed"));
    const installed = await importManagedExchange(goodBytes(), deps);
    // The record is durable; a best-effort marker failure must not fail the import
    // (a retry would duplicate it).
    expect(deps.installed).toHaveLength(1);
    expect(installed).toBe(deps.installed[0]);
  });

  test("the installed record has no input-file handle", async () => {
    const deps = recordingDeps();
    const installed = await importManagedExchange(goodBytes(), deps);
    expect(installed).not.toHaveProperty("inputFileHandle");
  });

  test("has a backed-up schedule but still no handle, so no import can run unattended", async () => {
    // The converse of the deposit path (test/unit/manageOfferModel.test.ts,
    // which writes a handle and no schedule): an import can have a schedule and
    // reconstructs no handle, so neither path on its own assembles the pair the
    // unattended runner fires on. The source record here HELD a handle, so what
    // is asserted is that the round trip drops it rather than that there was
    // nothing to drop.
    const deps = recordingDeps();
    const installed = await importManagedExchange(scheduledBytes(), deps);
    expect(installed.schedule).toMatchObject({
      nextWindow: "2026-01-06T14:00:00.000Z",
      intervalDays: 7,
    });
    expect(installed).not.toHaveProperty("inputFileHandle");
  });

  test("a malformed file installs nothing (store left untouched)", async () => {
    const deps = recordingDeps();
    await expect(importManagedExchange("not json {{{", deps)).rejects.toThrow();
    expect(deps.installed).toHaveLength(0);
    expect(deps.markImported).not.toHaveBeenCalled();
  });

  test("a tampered secret installs nothing", async () => {
    const deps = recordingDeps();
    const artifact = JSON.parse(goodBytes());
    artifact.key.sharedSecret = "not-a-secret";
    await expect(
      importManagedExchange(JSON.stringify(artifact), deps),
    ).rejects.toThrow();
    expect(deps.installed).toHaveLength(0);
  });
});
