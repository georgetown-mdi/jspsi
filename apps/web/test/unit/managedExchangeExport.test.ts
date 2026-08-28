import {
  assembleExchangeSpec,
  connectionFromLocator,
  generateSharedSecret,
  getDefaultLinkageTerms,
} from "@psilink/core";
import { describe, expect, test, vi } from "vitest";

import {
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
} from "@psi/managedExchangeRecord";
import {
  dispatchManagedCronExport,
  dispatchManagedMigration,
  exportManagedBackup,
  managedBackupFileName,
} from "@psi/managedExchangeExport";
import {
  importManagedExchangeArtifact,
  parseManagedExchangeArtifact,
} from "@psi/managedExchangeArtifact";

import type {
  ManagedCronExportDeps,
  ManagedExportDeps,
  ManagedMigrationDeps,
} from "@psi/managedExchangeExport";
import type { ManagedExchangeRecord } from "@psi/managedExchangeRecord";

// The three export intents, tested in Node with injected seams. Every export reads
// the record fresh, composes what it will download, and marks it in one atomic step
// (readAndMark), so what it serializes is what the marker attests and a composition
// that refuses the record leaves no marker behind; a backup leaves the source live;
// a migration and a command-line export download and return a confirm handle,
// spending the source only when the operator attests the files are saved (a
// dismissed save leaves it live).

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
    // The atomic read-compose-and-mark: hands the fresh record to the export's own
    // composition, then marks, as the store's step does.
    readAndMark: vi.fn(
      (
        _id: string,
        _backedUpAt: string,
        composeExport: (read: ManagedExchangeRecord) => void,
      ) => {
        composeExport(rec);
        return Promise.resolve(rec);
      },
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
      expect.any(Function),
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
      readAndMark: vi.fn(
        (
          _id: string,
          _backedUpAt: string,
          composeExport: (read: ManagedExchangeRecord) => void,
        ) => {
          order.push("readAndMark");
          composeExport(rec);
          return Promise.resolve(rec);
        },
      ),
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
      expect.any(Function),
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

describe("dispatchManagedCronExport", () => {
  /** A record the command-line composition refuses: a connection on a channel this
   * app does not compose, reachable only by importing a hand-crafted artifact. */
  function refusedRecord(): ManagedExchangeRecord {
    return buildManagedExchangeRecord({
      label: "Riverbend quarterly",
      exchangeFile: assembleExchangeSpec({
        connection: connectionFromLocator({
          channel: "filedrop",
          path: "/srv/exchange",
        }),
        linkageTerms,
      }),
      side: "inviter",
      sharedSecret: generateSharedSecret(),
    });
  }

  function cronDeps(rec: ManagedExchangeRecord): ManagedCronExportDeps & {
    downloaded: Array<{ fileName: string; content: string; mimeType: string }>;
    marked: Array<string>;
    order: Array<string>;
    markSpent: ReturnType<typeof vi.fn>;
  } {
    const order: Array<string> = [];
    const marked: Array<string> = [];
    const downloaded: Array<{
      fileName: string;
      content: string;
      mimeType: string;
    }> = [];
    return {
      downloaded,
      marked,
      order,
      // The store's atomic step, modelled: the composition runs on the record read
      // and the marker is written only once it returns, so a refusal thrown out of
      // it leaves nothing marked -- the transaction the real store aborts.
      readAndMark: (
        _id: string,
        backedUpAt: string,
        composeExport: (read: ManagedExchangeRecord) => void,
      ) => {
        order.push("compose");
        composeExport(rec);
        order.push("mark");
        marked.push(backedUpAt);
        return Promise.resolve(rec);
      },
      download: (fileName, content, mimeType) => {
        order.push("download");
        downloaded.push({ fileName, content, mimeType });
      },
      markSpent: vi.fn((_id: string, _spentAt: string) => Promise.resolve()),
      now: () => new Date("2026-07-14T12:00:00.000Z"),
    };
  }

  test("downloads both CLI files and marks backed-up, without spending", async () => {
    const rec = record();
    const deps = cronDeps(rec);
    const dispatch = await dispatchManagedCronExport(rec.id, deps);

    expect(deps.downloaded.map((file) => file.fileName)).toEqual([
      "psilink.yaml",
      ".psilink.key",
    ]);
    expect(deps.marked).toEqual(["2026-07-14T12:00:00.000Z"]);
    // The spend is operator-attested: not written until confirm() is called.
    expect(deps.markSpent).not.toHaveBeenCalled();
    expect(dispatch.record).toBe(rec);
    expect(dispatch.composed.command).toBe(
      "psilink exchange input.csv results.csv",
    );
  });

  test("composes before any durable write, then downloads", async () => {
    const rec = record();
    const deps = cronDeps(rec);
    await dispatchManagedCronExport(rec.id, deps);
    expect(deps.order).toEqual(["compose", "mark", "download", "download"]);
  });

  test("confirm spends the source as of the confirmation instant", async () => {
    const rec = record();
    const deps = cronDeps(rec);
    const dispatch = await dispatchManagedCronExport(rec.id, deps);
    await dispatch.confirm(new Date("2026-07-14T13:30:00.000Z"));
    expect(deps.markSpent).toHaveBeenCalledWith(
      rec.id,
      "2026-07-14T13:30:00.000Z",
    );
  });

  test("a refused record marks nothing and leaves the record untouched", async () => {
    const rec = refusedRecord();
    const before = JSON.stringify(rec);
    const deps = cronDeps(rec);

    await expect(dispatchManagedCronExport(rec.id, deps)).rejects.toThrow(
      /stored connection channel is filedrop/,
    );
    // The refusal aborts the step it was composed inside: no marker, no bytes, no
    // spend -- the panel's "nothing changed here" is literal.
    expect(deps.marked).toEqual([]);
    expect(deps.downloaded).toEqual([]);
    expect(deps.markSpent).not.toHaveBeenCalled();
    expect(JSON.stringify(rec)).toBe(before);
  });

  test("a step that marks without composing is refused, not downloaded", async () => {
    // The binding is only as good as the step honoring it, so a seam that resolves
    // having skipped the composition fails the export rather than downloading bytes
    // no marker attests.
    const rec = record();
    const deps = {
      ...cronDeps(rec),
      readAndMark: () => Promise.resolve(rec),
    };

    await expect(dispatchManagedCronExport(rec.id, deps)).rejects.toThrow(
      /without composing the export/,
    );
    expect(deps.downloaded).toEqual([]);
    expect(deps.markSpent).not.toHaveBeenCalled();
  });
});
