import {
  assembleExchangeSpec,
  connectionFromLocator,
  generateSharedSecret,
  getDefaultLinkageTerms,
} from "@psilink/core";
import { describe, expect, test, vi } from "vitest";

import {
  ManagedHandoffRefusedError,
  dispatchManagedCronExport,
  dispatchManagedMigration,
  exportManagedBackup,
  managedBackupFileName,
} from "@psi/managed/managedExchangeExport";
import {
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
} from "@psi/managed/managedExchangeRecord";
import {
  importManagedExchangeArtifact,
  parseManagedExchangeArtifact,
} from "@psi/managed/managedExchangeArtifact";

import type {
  ManagedCronExportDeps,
  ManagedExportDeps,
  ManagedMigrationDeps,
} from "@psi/managed/managedExchangeExport";
import type {
  ManagedSpendOutcome,
  ManagedSpentHandoff,
} from "@psi/managed/managedLocalState";
import type { ManagedExchangeRecord } from "@psi/managed/managedExchangeRecord";

// The three export intents, tested in Node with injected dependencies. Every
// export reads the record fresh rather than trusting a caller's copy. The
// backup and migration exports serialize and mark atomically (readAndMark), so
// what they serialize is what the marker attests; the command-line export
// takes a plain read with no marking call site, since its two files are not a
// backup this app restores from.

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

  test("the marker attests the secret the downloaded file has", async () => {
    const rec = record();
    const deps = backupDeps(rec);
    await exportManagedBackup(rec.id, deps);
    // The bytes downloaded re-import to the secret readAndMark returned -- the same
    // secret the marker was stamped against, not a stale React snapshot.
    const restored = importManagedExchangeArtifact(deps.downloaded[0].content);
    expect(restored.sharedSecret).toBe(rec.sharedSecret);
  });

  test("a step that marks without serializing is refused, not downloaded", async () => {
    // The binding is only as good as the step honoring it, so a dependency that
    // resolves having skipped the serialization fails the export rather than
    // downloading bytes no marker attests.
    const rec = record();
    const deps = {
      ...backupDeps(rec),
      readAndMark: () => Promise.resolve(rec),
    };

    await expect(exportManagedBackup(rec.id, deps)).rejects.toThrow(
      /without serializing the export/,
    );
    expect(deps.downloaded).toEqual([]);
  });
});

describe("dispatchManagedMigration", () => {
  function migrationDeps(rec: ManagedExchangeRecord): ManagedMigrationDeps & {
    downloaded: Array<{ fileName: string; content: string }>;
    order: Array<string>;
    spendIfCurrent: ReturnType<typeof vi.fn>;
    /** The spends the atomic step actually wrote; a refused one writes nothing. */
    spent: Array<string>;
    /** What the confirm-time step finds in the store: the record itself until a test
     * moves it, as a rotation or a delete in another context would, and whether a
     * run holds the run+rotate lock the step takes before it reads anything. */
    stored: { record: ManagedExchangeRecord | undefined; runInFlight: boolean };
  } {
    const order: Array<string> = [];
    const spent: Array<string> = [];
    const downloaded: Array<{ fileName: string; content: string }> = [];
    const stored: {
      record: ManagedExchangeRecord | undefined;
      runInFlight: boolean;
    } = { record: rec, runInFlight: false };
    return {
      downloaded,
      order,
      spent,
      stored,
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
      // The store's spend, modelled: one step excludes a run in flight, compares the
      // stored secret, and writes the spent state, so a refusal is what leaves
      // nothing written. The run exclusion comes first because the real one does --
      // it is the lock the step takes before it opens its transaction.
      spendIfCurrent: vi.fn(
        (_id: string, expectedSharedSecret: string, spentAt: string) => {
          order.push("spendIfCurrent");
          if (stored.runInFlight)
            return Promise.resolve<ManagedSpendOutcome>("run-in-flight");
          const current = stored.record;
          if (current === undefined)
            return Promise.resolve<ManagedSpendOutcome>("gone");
          if (current.sharedSecret !== expectedSharedSecret)
            return Promise.resolve<ManagedSpendOutcome>("superseded");
          spent.push(spentAt);
          return Promise.resolve<ManagedSpendOutcome>("spent");
        },
      ),
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
    expect(deps.spendIfCurrent).not.toHaveBeenCalled();
    expect(dispatch.record).toBe(rec);
  });

  test("confirm spends the source as of the confirmation instant", async () => {
    const rec = record();
    const deps = migrationDeps(rec);
    const dispatch = await dispatchManagedMigration(rec.id, deps);
    await dispatch.confirm(new Date("2026-07-14T13:30:00.000Z"));
    // The secret the dispatch serialized is what the step checks against, so the
    // spend is decided by the artifact in the operator's hands.
    expect(deps.spendIfCurrent).toHaveBeenCalledWith(
      rec.id,
      rec.sharedSecret,
      "2026-07-14T13:30:00.000Z",
    );
    expect(deps.spent).toEqual(["2026-07-14T13:30:00.000Z"]);
  });

  test("a never-confirmed dispatch never spends (a dismissed save leaves it live)", async () => {
    const rec = record();
    const deps = migrationDeps(rec);
    await dispatchManagedMigration(rec.id, deps);
    // The caller drops the dispatch without calling confirm.
    expect(deps.spendIfCurrent).not.toHaveBeenCalled();
    expect(deps.spent).toEqual([]);
  });

  test("confirm refuses an artifact a rotation has superseded", async () => {
    // The ordering the gate on the surface cannot cover: a run in any context
    // rotates between the download and the operator's attestation, so what they are
    // attesting to is no longer the exchange's secret.
    const rec = record();
    const deps = migrationDeps(rec);
    const dispatch = await dispatchManagedMigration(rec.id, deps);
    deps.stored.record = { ...rec, sharedSecret: generateSharedSecret() };

    const refusal = await dispatch.confirm(new Date()).then(
      () => {
        throw new Error("the confirmation should have been refused");
      },
      (reason: unknown) => reason,
    );
    expect(refusal).toBeInstanceOf(ManagedHandoffRefusedError);
    expect((refusal as ManagedHandoffRefusedError).refusal).toBe("superseded");
    expect(deps.spent).toEqual([]);
  });

  test("confirm refuses a run in flight as its own refusal", async () => {
    // The refusal the currency check cannot make: the run holding the lock has
    // rotated nothing yet, so the stored secret still matches the artifact -- and
    // a spend taken there would be superseded by that run's own persist. Held
    // apart from the superseded refusal because it ends when the run does.
    const rec = record();
    const deps = migrationDeps(rec);
    const dispatch = await dispatchManagedMigration(rec.id, deps);
    deps.stored.runInFlight = true;

    const refusal = await dispatch.confirm(new Date()).then(
      () => {
        throw new Error("the confirmation should have been refused");
      },
      (reason: unknown) => reason,
    );
    expect(refusal).toBeInstanceOf(ManagedHandoffRefusedError);
    expect((refusal as ManagedHandoffRefusedError).refusal).toBe(
      "run-in-flight",
    );
    expect(deps.spent).toEqual([]);
  });

  test("confirm refuses a record that is gone as its own refusal", async () => {
    // Held apart from the superseded refusal because the surfaces answer them
    // differently: this record cannot be downloaded again, so the copy that names
    // a fresh download would send the operator after one nothing can produce.
    const rec = record();
    const deps = migrationDeps(rec);
    const dispatch = await dispatchManagedMigration(rec.id, deps);
    deps.stored.record = undefined;

    const refusal = await dispatch.confirm(new Date()).then(
      () => {
        throw new Error("the confirmation should have been refused");
      },
      (reason: unknown) => reason,
    );
    expect(refusal).toBeInstanceOf(ManagedHandoffRefusedError);
    expect((refusal as ManagedHandoffRefusedError).refusal).toBe("record-gone");
    expect(deps.spent).toEqual([]);
  });

  test("confirm spends only through the checked step, and only after the download", async () => {
    // The check and the write are one step, so there is no second write to order
    // against: an intent that reached a bare spend would show it here.
    const rec = record();
    const deps = migrationDeps(rec);
    const dispatch = await dispatchManagedMigration(rec.id, deps);
    await dispatch.confirm(new Date("2026-07-14T13:30:00.000Z"));
    expect(deps.order).toEqual(["readAndMark", "download", "spendIfCurrent"]);
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
  /** The record shapes the command-line composition refuses, each with the part of
   * its refusal this dispatch must propagate. None is composable through the app --
   * they reach a record by importing a hand-crafted artifact, which the composer's
   * own suite pins -- so what is measured here is the dispatch's effect on the
   * store when the composition throws inside its read-and-mark step. */
  const refusedRecords: Array<[string, () => ManagedExchangeRecord, RegExp]> = [
    [
      "a connection on another channel",
      () =>
        buildManagedExchangeRecord({
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
        }),
      /stored connection channel is filedrop/,
    ],
    [
      "an authentication block on the stored document",
      () => {
        const rec = record();
        return {
          ...rec,
          exchangeFile: {
            ...rec.exchangeFile,
            authentication: {
              sharedSecret: generateSharedSecret(),
              expires: "2026-04-06T14:00:00.000Z",
            },
          },
        };
      },
      /authentication block/,
    ],
    [
      "a top-level field outside the composition",
      () =>
        buildManagedExchangeRecord({
          label: "Riverbend quarterly",
          exchangeFile: assembleExchangeSpec({
            connection: connectionFromLocator({
              channel: "webrtc",
              host: "signaling.example.org",
            }),
            linkageTerms,
            signing: {
              mode: "certificate",
              identityFile: "@/home/other/psilink-signing.identity",
              partnerFingerprint: "0123456789012345678901234567890123456789abA",
              receiptOutput: "/home/other/receipts/planted-receipt.json",
            },
          }),
          side: "inviter",
          sharedSecret: generateSharedSecret(),
        }),
      /Remove: signing/,
    ],
  ];

  function cronDeps(rec: ManagedExchangeRecord): ManagedCronExportDeps & {
    downloaded: Array<{ fileName: string; content: string; mimeType: string }>;
    order: Array<string>;
    readRecord: ReturnType<typeof vi.fn>;
    spendIfCurrent: ReturnType<typeof vi.fn>;
    /** The spends the atomic step actually wrote; a refused one writes nothing. */
    spent: Array<{ spentAt: string; handoff: ManagedSpentHandoff }>;
    /** What the confirm-time step finds in the store: the record itself until a test
     * moves it, as a rotation or a delete in another context would, and whether a
     * run holds the run+rotate lock the step takes before it reads anything. */
    stored: { record: ManagedExchangeRecord | undefined; runInFlight: boolean };
  } {
    const order: Array<string> = [];
    const spent: Array<{ spentAt: string; handoff: ManagedSpentHandoff }> = [];
    const downloaded: Array<{
      fileName: string;
      content: string;
      mimeType: string;
    }> = [];
    const stored: {
      record: ManagedExchangeRecord | undefined;
      runInFlight: boolean;
    } = { record: rec, runInFlight: false };
    return {
      downloaded,
      order,
      spent,
      stored,
      // The plain read this export takes: no marker is written here or anywhere else
      // in it, so the deps have no marking call site to write one through.
      readRecord: vi.fn((_id: string) => {
        order.push("read");
        return Promise.resolve<ManagedExchangeRecord | undefined>(rec);
      }),
      download: (fileName, content, mimeType) => {
        order.push("download");
        downloaded.push({ fileName, content, mimeType });
      },
      // The store's spend, modelled as the migration's is: one step excludes a run
      // in flight, compares the stored secret, and writes the spent state under its
      // hand-off.
      spendIfCurrent: vi.fn(
        (
          _id: string,
          expectedSharedSecret: string,
          spentAt: string,
          handoff: ManagedSpentHandoff,
        ) => {
          if (stored.runInFlight)
            return Promise.resolve<ManagedSpendOutcome>("run-in-flight");
          const current = stored.record;
          if (current === undefined)
            return Promise.resolve<ManagedSpendOutcome>("gone");
          if (current.sharedSecret !== expectedSharedSecret)
            return Promise.resolve<ManagedSpendOutcome>("superseded");
          spent.push({ spentAt, handoff });
          return Promise.resolve<ManagedSpendOutcome>("spent");
        },
      ),
    };
  }

  test("downloads both CLI files from a fresh read, without spending", async () => {
    const rec = record();
    const deps = cronDeps(rec);
    const dispatch = await dispatchManagedCronExport(rec.id, deps);

    expect(deps.downloaded.map((file) => file.fileName)).toEqual([
      "psilink.yaml",
      ".psilink.key",
    ]);
    expect(deps.readRecord).toHaveBeenCalledWith(rec.id);
    // The spend is operator-attested: not written until confirm() is called.
    expect(deps.spendIfCurrent).not.toHaveBeenCalled();
    expect(dispatch.record).toBe(rec);
    expect(dispatch.composed.command).toBe(
      "psilink exchange input.csv results.csv",
    );
  });

  test("reads first, then downloads", async () => {
    const rec = record();
    const deps = cronDeps(rec);
    await dispatchManagedCronExport(rec.id, deps);
    expect(deps.order).toEqual(["read", "download", "download"]);
  });

  test("a record gone from the store downloads nothing", async () => {
    const rec = record();
    const deps = {
      ...cronDeps(rec),
      readRecord: () =>
        Promise.resolve<ManagedExchangeRecord | undefined>(undefined),
    };

    await expect(dispatchManagedCronExport(rec.id, deps)).rejects.toThrow(
      /no managed exchange with id/,
    );
    expect(deps.downloaded).toEqual([]);
    expect(deps.spendIfCurrent).not.toHaveBeenCalled();
  });

  test("confirm spends the source as a command-line hand-off", async () => {
    // The instant is the operator's confirmation, and the hand-off is recorded
    // beside it: a migration's spent state is revived by importing the artifact
    // back, and this one has no artifact to import, so the durable spent surfaces
    // must be able to tell the two apart.
    const rec = record();
    const deps = cronDeps(rec);
    const dispatch = await dispatchManagedCronExport(rec.id, deps);
    await dispatch.confirm(new Date("2026-07-14T13:30:00.000Z"));
    expect(deps.spendIfCurrent).toHaveBeenCalledWith(
      rec.id,
      rec.sharedSecret,
      "2026-07-14T13:30:00.000Z",
      "command-line",
    );
    expect(deps.spent).toEqual([
      { spentAt: "2026-07-14T13:30:00.000Z", handoff: "command-line" },
    ]);
  });

  test("confirm refuses files a rotation has superseded", async () => {
    // The same ordering the migration's confirm refuses: a run rotated between the
    // two downloads and the operator's attestation, so the key file on their disk
    // is no longer this exchange's.
    const rec = record();
    const deps = cronDeps(rec);
    const dispatch = await dispatchManagedCronExport(rec.id, deps);
    deps.stored.record = { ...rec, sharedSecret: generateSharedSecret() };

    await expect(dispatch.confirm(new Date())).rejects.toBeInstanceOf(
      ManagedHandoffRefusedError,
    );
    expect(deps.spent).toEqual([]);
  });

  test("confirm refuses a run in flight as its own refusal", async () => {
    // The same exclusion the migration's confirm meets: a run of this record holds
    // the run+rotate lock, so the two files on the operator's disk are handed over
    // only once it is over.
    const rec = record();
    const deps = cronDeps(rec);
    const dispatch = await dispatchManagedCronExport(rec.id, deps);
    deps.stored.runInFlight = true;

    const inFlight = await dispatch.confirm(new Date()).then(
      () => {
        throw new Error("the confirmation should have been refused");
      },
      (reason: unknown) => reason,
    );
    expect((inFlight as ManagedHandoffRefusedError).refusal).toBe(
      "run-in-flight",
    );
    expect(deps.spent).toEqual([]);
  });

  test("confirm refuses a record that is gone as its own refusal", async () => {
    const rec = record();
    const deps = cronDeps(rec);
    const dispatch = await dispatchManagedCronExport(rec.id, deps);
    deps.stored.record = undefined;

    const refusal = await dispatch.confirm(new Date()).then(
      () => {
        throw new Error("the confirmation should have been refused");
      },
      (reason: unknown) => reason,
    );
    expect((refusal as ManagedHandoffRefusedError).refusal).toBe("record-gone");
    expect(deps.spent).toEqual([]);
  });

  test.each(refusedRecords)(
    "a refused record downloads nothing and leaves the record untouched (%s)",
    async (_shape, build, refusal) => {
      const rec = build();
      const before = structuredClone(rec);
      const deps = cronDeps(rec);

      await expect(dispatchManagedCronExport(rec.id, deps)).rejects.toThrow(
        refusal,
      );
      // The composition refuses before anything leaves the app: no bytes, no spend,
      // and the record the read returned still equals its snapshot.
      expect(deps.downloaded).toEqual([]);
      expect(deps.spendIfCurrent).not.toHaveBeenCalled();
      expect(rec).toEqual(before);
    },
  );
});
