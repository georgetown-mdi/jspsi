import { describe, expect, test, vi } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@psilink/core";

import {
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
} from "@psi/managedExchangeRecord";
import {
  dispatchManagedMigration,
  exportManagedBackup,
  managedBackupFileName,
} from "@psi/managedExchangeExport";
import {
  importManagedExchangeArtifact,
  parseManagedExchangeArtifact,
} from "@psi/managedExchangeArtifact";

import type {
  ManagedExportDeps,
  ManagedMigrationDeps,
} from "@psi/managedExchangeExport";
import type { ManagedExchangeRecord } from "@psi/managedExchangeRecord";

// The two export intents, tested in Node with injected seams. Every export reads the
// record fresh and marks it in one atomic step (readAndMark), so what it serializes
// is what the marker attests; a backup leaves the source live; a migration downloads
// and returns a confirm handle, spending the source only when the operator attests
// the file is saved (a dismissed save leaves it live).

const linkageTerms = getDefaultLinkageTerms("County Health Dept");

function record(): ManagedExchangeRecord {
  return buildManagedExchangeRecord({
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: { channel: "webrtc", host: "signaling.example.org" },
      linkageTerms,
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
  });
}

function backupDeps(rec: ManagedExchangeRecord): ManagedExportDeps & {
  downloaded: Array<{ fileName: string; content: string }>;
  readAndMark: ReturnType<typeof vi.fn>;
} {
  const downloaded: Array<{ fileName: string; content: string }> = [];
  return {
    downloaded,
    // The atomic read-and-mark: returns the fresh record the export serializes.
    readAndMark: vi.fn((_id: string, _backedUpAt: string) =>
      Promise.resolve(rec),
    ),
    download: (fileName, content) => downloaded.push({ fileName, content }),
    now: () => new Date("2026-07-14T12:00:00.000Z"),
  };
}

describe("managedBackupFileName", () => {
  test("names the file by the export's calendar day", () => {
    expect(managedBackupFileName(new Date("2026-07-14T12:00:00.000Z"))).toBe(
      "psilink-managed-backup-2026-07-14.json",
    );
  });
});

describe("exportManagedBackup", () => {
  test("reads-and-marks the record and downloads exactly those bytes", async () => {
    const rec = record();
    const deps = backupDeps(rec);
    const result = await exportManagedBackup(rec.id, deps);

    expect(deps.downloaded).toHaveLength(1);
    expect(deps.readAndMark).toHaveBeenCalledWith(
      rec.id,
      "2026-07-14T12:00:00.000Z",
    );
    // The result threads the one clock read and the record exported.
    expect(result.backedUpAt.toISOString()).toBe("2026-07-14T12:00:00.000Z");
    expect(result.record).toBe(rec);
  });

  test("the marker attests the secret the downloaded file carries", async () => {
    const rec = record();
    const deps = backupDeps(rec);
    await exportManagedBackup(rec.id, deps);
    // The bytes downloaded re-import to the secret readAndMark returned -- the same
    // secret the marker was stamped against, not a stale React snapshot.
    const restored = importManagedExchangeArtifact(deps.downloaded[0].content);
    expect(restored.sharedSecret).toBe(rec.sharedSecret);
  });
});

describe("dispatchManagedMigration", () => {
  function migrationDeps(rec: ManagedExchangeRecord): ManagedMigrationDeps & {
    downloaded: Array<{ fileName: string; content: string }>;
    order: Array<string>;
    markSpent: ReturnType<typeof vi.fn>;
  } {
    const order: Array<string> = [];
    const downloaded: Array<{ fileName: string; content: string }> = [];
    return {
      downloaded,
      order,
      readAndMark: vi.fn((_id: string, _backedUpAt: string) => {
        order.push("readAndMark");
        return Promise.resolve(rec);
      }),
      download: (fileName, content) => {
        order.push("download");
        downloaded.push({ fileName, content });
      },
      markSpent: vi.fn((_id: string, _spentAt: string) => {
        order.push("markSpent");
        return Promise.resolve();
      }),
      now: () => new Date("2026-07-14T12:00:00.000Z"),
    };
  }

  test("downloads and marks backed-up, but does not spend on dispatch", async () => {
    const rec = record();
    const deps = migrationDeps(rec);
    const dispatch = await dispatchManagedMigration(rec.id, deps);

    expect(deps.downloaded).toHaveLength(1);
    expect(deps.readAndMark).toHaveBeenCalledWith(
      rec.id,
      "2026-07-14T12:00:00.000Z",
    );
    // The spend is operator-attested: not written until confirm() is called.
    expect(deps.markSpent).not.toHaveBeenCalled();
    expect(dispatch.record).toBe(rec);
  });

  test("confirm spends the source as of the confirmation instant", async () => {
    const rec = record();
    const deps = migrationDeps(rec);
    const dispatch = await dispatchManagedMigration(rec.id, deps);
    await dispatch.confirm(new Date("2026-07-14T13:30:00.000Z"));
    expect(deps.markSpent).toHaveBeenCalledWith(
      rec.id,
      "2026-07-14T13:30:00.000Z",
    );
  });

  test("a never-confirmed dispatch never spends (a dismissed save leaves it live)", async () => {
    const rec = record();
    const deps = migrationDeps(rec);
    await dispatchManagedMigration(rec.id, deps);
    // The caller drops the dispatch without calling confirm.
    expect(deps.markSpent).not.toHaveBeenCalled();
  });

  test("marks backed-up before it could ever spend", async () => {
    const rec = record();
    const deps = migrationDeps(rec);
    await dispatchManagedMigration(rec.id, deps);
    expect(deps.order).toEqual(["readAndMark", "download"]);
  });

  test("the migration artifact parses as a valid artifact", async () => {
    const rec = record();
    const deps = migrationDeps(rec);
    await dispatchManagedMigration(rec.id, deps);
    expect(() =>
      parseManagedExchangeArtifact(deps.downloaded[0].content),
    ).not.toThrow();
  });
});
