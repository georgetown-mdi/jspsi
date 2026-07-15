import { describe, expect, test, vi } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@psilink/core";

import {
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
} from "@psi/managedExchangeRecord";
import {
  exportManagedBackup,
  exportManagedMigration,
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

// The two export intents, tested in Node with injected seams: a backup leaves the
// source live (only the download and the backup marker fire); a migration downloads
// the same artifact and additionally spends the source. The spend follows the
// download so a failed download does not spend.

const linkageTerms = getDefaultLinkageTerms("County Health Dept");

function record() {
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

function backupDeps(): ManagedExportDeps & {
  downloaded: Array<{ fileName: string; content: string }>;
} {
  const downloaded: Array<{ fileName: string; content: string }> = [];
  return {
    downloaded,
    download: (fileName, content) => downloaded.push({ fileName, content }),
    markBackedUp: vi.fn(() => Promise.resolve()),
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
  test("downloads the artifact and records the backup marker, leaving the source live", async () => {
    const deps = backupDeps();
    const rec = record();
    await exportManagedBackup(rec, deps);

    expect(deps.downloaded).toHaveLength(1);
    expect(deps.markBackedUp).toHaveBeenCalledWith(
      rec.id,
      "2026-07-14T12:00:00.000Z",
    );
  });

  test("the downloaded artifact re-imports to the same secret", async () => {
    const deps = backupDeps();
    const rec = record();
    await exportManagedBackup(rec, deps);
    const restored = importManagedExchangeArtifact(deps.downloaded[0].content);
    expect(restored.sharedSecret).toBe(rec.sharedSecret);
  });
});

describe("exportManagedMigration", () => {
  function migrationDeps(): ManagedMigrationDeps & {
    downloaded: Array<{ fileName: string; content: string }>;
    order: Array<string>;
  } {
    const order: Array<string> = [];
    const downloaded: Array<{ fileName: string; content: string }> = [];
    return {
      downloaded,
      order,
      download: (fileName, content) => {
        order.push("download");
        downloaded.push({ fileName, content });
      },
      markBackedUp: vi.fn(() => {
        order.push("markBackedUp");
        return Promise.resolve();
      }),
      markSpent: vi.fn(() => {
        order.push("markSpent");
        return Promise.resolve();
      }),
      now: () => new Date("2026-07-14T12:00:00.000Z"),
    };
  }

  test("downloads, spends the source, and records the backup marker", async () => {
    const deps = migrationDeps();
    const rec = record();
    await exportManagedMigration(rec, deps);

    expect(deps.downloaded).toHaveLength(1);
    expect(deps.markSpent).toHaveBeenCalledWith(
      rec.id,
      "2026-07-14T12:00:00.000Z",
    );
    expect(deps.markBackedUp).toHaveBeenCalledWith(
      rec.id,
      "2026-07-14T12:00:00.000Z",
    );
  });

  test("spends only after the download (a failed download does not spend)", async () => {
    const deps = migrationDeps();
    deps.download = () => {
      throw new Error("download failed");
    };
    await expect(exportManagedMigration(record(), deps)).rejects.toThrow();
    expect(deps.markSpent).not.toHaveBeenCalled();
  });

  test("the spend follows the download in order", async () => {
    const deps = migrationDeps();
    await exportManagedMigration(record(), deps);
    expect(deps.order[0]).toBe("download");
    expect(deps.order).toContain("markSpent");
  });

  test("the migration artifact parses as a valid artifact", async () => {
    const deps = migrationDeps();
    await exportManagedMigration(record(), deps);
    expect(() =>
      parseManagedExchangeArtifact(deps.downloaded[0].content),
    ).not.toThrow();
  });
});
