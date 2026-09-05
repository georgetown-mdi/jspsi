/// <reference types="@vitest/browser-playwright/context" />
/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@psilink/core";

import {
  clearManagedExchanges,
  createManagedExchange,
  deleteManagedExchange,
  getManagedExchange,
  listManagedExchanges,
  persistManagedExchangeRotation,
  readRecordAndMarkBackedUp,
  recordManagedExchangeLastRun,
  spendManagedExchangeIfCurrent,
} from "@psi/managedExchangeStore";
import {
  dispatchManagedMigration,
  exportManagedBackup,
} from "@psi/managedExchangeExport";
import {
  encodeManagedExchangeArtifact,
  importManagedExchangeArtifact,
  serializeManagedExchangeArtifact,
} from "@psi/managedExchangeArtifact";
import {
  getManagedLocalState,
  listManagedLocalState,
  markManagedExchangeBackedUp,
  markManagedExchangeImported,
} from "@psi/managedLocalState";
import { composeManagedExchangeFile } from "@psi/managedExchangeRecord";
import { deriveManagedFailureTier } from "@psi/managedFailureTiers";
import { failedRun } from "@psi/managedRunRotate";
import { importManagedExchange } from "@psi/managedExchangeImport";
import { managedRunFailureFromRecord } from "@bench/managedRunLaunchModel";
import { savedExchangeRows } from "@bench/savedExchangesModel";
import { withManagedExchangeLock } from "@psi/managedExchangeLock";

import type {
  ManagedExchangeSchedule,
  NewManagedExchange,
} from "@psi/managedExchangeRecord";
import type { WebRTCExchangeLocator } from "@psilink/core";

// The store-backed export/import and local sibling state, exercised against real
// Chromium (real IndexedDB and the sibling object store). The pure encode/parse and
// derivation are unit-tested without a database; this suite proves an export/import
// round-trip installs one owner against the real store, a migration spends the
// source, the backup marker and spent state persist beside the record, and a delete
// leaves no sibling entry behind.

const linkageTerms = getDefaultLinkageTerms("County Health Dept");

const webrtcLocator: WebRTCExchangeLocator = {
  channel: "webrtc",
  host: "signaling.example.org",
  port: 3000,
  path: "/api/",
};

const schedule: ManagedExchangeSchedule = {
  anchor: "2026-01-06T14:00:00.000Z",
  intervalDays: 7,
  windowSeconds: 10_800,
  nextWindow: "2026-01-13T14:00:00.000Z",
  consecutiveMisses: 2,
};

function newExchange(
  overrides: Partial<NewManagedExchange> = {},
): NewManagedExchange {
  return {
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: webrtcLocator,
      linkageTerms,
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
    ...overrides,
  };
}

beforeEach(async () => {
  await clearManagedExchanges();
});

afterEach(async () => {
  await clearManagedExchanges();
});

describe("export/import round-trip against the real store", () => {
  test("an import installs a new owner minus the handle", async () => {
    const source = await createManagedExchange(
      newExchange({ tokenMaxAgeDays: 90 }),
    );
    const bytes = serializeManagedExchangeArtifact(
      encodeManagedExchangeArtifact(source),
    );

    // Simulate an eviction: the source is gone, and the operator imports.
    await deleteManagedExchange(source.id);
    expect(await listManagedExchanges()).toEqual([]);

    const installed = await importManagedExchange(bytes);
    // A fresh id, the same secret and terms, no handle.
    expect(installed.id).not.toBe(source.id);
    expect(installed.sharedSecret).toBe(source.sharedSecret);
    expect(installed.exchangeFile).toEqual(source.exchangeFile);
    expect(installed).not.toHaveProperty("inputFileHandle");
    // It is the one owner in the store.
    const all = await listManagedExchanges();
    expect(all.map((r) => r.id)).toEqual([installed.id]);
    // The import marks it backed-up, so it shows green immediately.
    const local = await getManagedLocalState(installed.id);
    expect(local?.backup).toBeDefined();
  });

  test("a malformed import leaves the store untouched", async () => {
    const existing = await createManagedExchange(newExchange());
    await expect(importManagedExchange("not json {{{")).rejects.toThrow();
    // The pre-existing record is untouched and no new record landed.
    const all = await listManagedExchanges();
    expect(all.map((r) => r.id)).toEqual([existing.id]);
  });
});

describe("the backup marker persists beside the record", () => {
  test("marking backed-up flips the list's derived backup state to green", async () => {
    const record = await createManagedExchange(newExchange());
    const before = savedExchangeRows(
      [record],
      await listManagedLocalState(),
      Date.now(),
    );
    expect(before[0].backup.kind).toBe("backup-needed");

    await markManagedExchangeBackedUp(record.id, new Date().toISOString());
    const after = savedExchangeRows(
      [record],
      await listManagedLocalState(),
      Date.now(),
    );
    expect(after[0].backup.kind).toBe("backed-up");
  });
});

describe("the import marker is the restore evidence the desync tiering reads", () => {
  test("an import stamps importedAt beside the record, out of the artifact", async () => {
    const source = await createManagedExchange(newExchange());
    const bytes = serializeManagedExchangeArtifact(
      encodeManagedExchangeArtifact(source),
    );
    // The artifact contains no import marker (a sibling, never in the export).
    expect(bytes).not.toMatch(/importedAt/);

    await deleteManagedExchange(source.id);
    const installed = await importManagedExchange(bytes);
    const local = await getManagedLocalState(installed.id);
    // Both markers are stamped: the restore evidence and the current-backup marker.
    expect(local?.imported).toBeDefined();
    expect(local?.backup).toBeDefined();
  });

  test("a rotation consumes the import marker (a completed handshake proves sync)", async () => {
    const record = await createManagedExchange(newExchange());
    await markManagedExchangeImported(record.id, new Date().toISOString());
    expect((await getManagedLocalState(record.id))?.imported).toBeDefined();

    // A successful run rotates the secret, clearing the import (and backup) marker in
    // the same cross-store transaction.
    await persistManagedExchangeRotation(record.id, {
      sharedSecret: generateSharedSecret(),
      expires: null,
    });
    const local = await getManagedLocalState(record.id);
    expect(local?.imported).toBeUndefined();
    expect(local?.backup).toBeUndefined();
  });

  test("an auth failure on a freshly imported record tiers as imported, not unexplained", async () => {
    const source = await createManagedExchange(newExchange());
    const bytes = serializeManagedExchangeArtifact(
      encodeManagedExchangeArtifact(source),
    );
    await deleteManagedExchange(source.id);
    const installed = await importManagedExchange(bytes);

    // The first run after the import fails closed. Its bookkeeping lands as auth.
    await recordManagedExchangeLastRun(
      installed.id,
      failedRun(Date.now(), "failed", "auth"),
    );
    const [record, local] = [
      await getManagedExchange(installed.id),
      await getManagedLocalState(installed.id),
    ];
    // The record's own evidence (an import not yet run-through) explains the failure:
    // the benign imported tier, never the attack path.
    expect(deriveManagedFailureTier(record!, local, Date.now())).toBe(
      "imported",
    );
  });
});

describe("an unattended run's failure shows through the same tiers at the next visit", () => {
  test("a stored auth failure with no benign evidence is treated as the unexplained tier", async () => {
    const record = await createManagedExchange(newExchange());
    // An unattended run failed closed and recorded auth -- nothing else explains it.
    await recordManagedExchangeLastRun(
      record.id,
      failedRun(Date.now(), "failed", "auth"),
    );
    const reloaded = await getManagedExchange(record.id);
    const local = await getManagedLocalState(record.id);
    const failure = managedRunFailureFromRecord(reloaded!, local, Date.now());
    expect(failure?.kind).toBe("unexplained");
    expect(failure?.recovery).toBe("confirm");
  });

  test("a stored storage failure is treated as the benign storage tier at the next visit", async () => {
    const record = await createManagedExchange(newExchange());
    await recordManagedExchangeLastRun(
      record.id,
      failedRun(Date.now(), "failed", "storage"),
    );
    const reloaded = await getManagedExchange(record.id);
    const local = await getManagedLocalState(record.id);
    const failure = managedRunFailureFromRecord(reloaded!, local, Date.now());
    expect(failure?.kind).toBe("storage");
    expect(failure?.recovery).toBe("reinvite");
  });
});

describe("a migration spends the source", () => {
  test("marking spent shows a spent row (no run) and revives by import", async () => {
    const source = await createManagedExchange(newExchange());
    const bytes = serializeManagedExchangeArtifact(
      encodeManagedExchangeArtifact(source),
    );

    await spendManagedExchangeIfCurrent(
      source.id,
      source.sharedSecret,
      new Date().toISOString(),
    );
    const rows = savedExchangeRows(
      [source],
      await listManagedLocalState(),
      Date.now(),
    );
    // The list names the handoff; the surface suppresses the run action for it.
    expect(rows[0].spentAsOf).toBeDefined();

    // The spent record revives by importing the artifact back -- in place (same id),
    // not as a duplicate (see the revive suite below).
    const revived = await importManagedExchange(bytes);
    expect(revived.id).toBe(source.id);
    expect(revived.sharedSecret).toBe(source.sharedSecret);
  });
});

describe("the spend is checked against the stored record in one step", () => {
  // Against the real store: a hand-off is only ever spent while no run of the
  // record is in flight and it still has the secret its files hold. These
  // cases pin both conditions; the transaction interleaving itself is not driven
  // here.

  test("a run holding the run+rotate lock refuses the spend, writing nothing", async () => {
    // The ordering no currency check can decide: the run has not rotated yet, so
    // the stored secret is still the one the operator's files hold -- and would
    // be superseded by that run's own persist the moment it lands. The exclusion
    // is what refuses it, on the very lock the run holds.
    const record = await createManagedExchange(newExchange());
    let granted!: () => void;
    const holding = new Promise<void>((resolve) => {
      granted = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = withManagedExchangeLock(record.id, async () => {
      granted();
      await released;
    });
    await holding;

    try {
      expect(
        await spendManagedExchangeIfCurrent(
          record.id,
          record.sharedSecret,
          "2026-07-14T13:00:00.000Z",
        ),
      ).toBe("run-in-flight");
      // Nothing at all: no spent state, and no sibling entry conjured to hold one.
      expect(await getManagedLocalState(record.id)).toBeUndefined();
    } finally {
      // Released even if the assertions throw, so a failing test cannot strand the
      // exclusive lock for the rest of the page's life.
      release();
      await run;
    }

    // The refusal consumed nothing: this run rotated nothing, so the same copy
    // spends once the lock is free.
    expect(
      await spendManagedExchangeIfCurrent(
        record.id,
        record.sharedSecret,
        "2026-07-14T13:05:00.000Z",
      ),
    ).toBe("spent");
    expect((await getManagedLocalState(record.id))?.spent).toEqual({
      spentAt: "2026-07-14T13:05:00.000Z",
    });
  });

  test("a secret the store has rotated past refuses, writing nothing", async () => {
    const record = await createManagedExchange(newExchange());
    const downloadedSecret = record.sharedSecret;
    await markManagedExchangeBackedUp(record.id, "2026-07-14T12:00:00.000Z");
    await persistManagedExchangeRotation(record.id, {
      sharedSecret: generateSharedSecret(),
      expires: null,
    });
    // The rotation clears the backup marker in its own step; re-stamp it, so a
    // refusal that wrote anything at all to the sibling entry would show.
    await markManagedExchangeBackedUp(record.id, "2026-07-14T12:30:00.000Z");
    const before = await getManagedExchange(record.id);

    expect(
      await spendManagedExchangeIfCurrent(
        record.id,
        downloadedSecret,
        "2026-07-14T13:00:00.000Z",
      ),
    ).toBe("superseded");

    const local = await getManagedLocalState(record.id);
    expect(local?.spent).toBeUndefined();
    expect(local?.backup).toEqual({ backedUpAt: "2026-07-14T12:30:00.000Z" });
    expect(await getManagedExchange(record.id)).toEqual(before);
  });

  test("the current secret spends the copy, keeping its backup marker", async () => {
    const record = await createManagedExchange(newExchange());
    await markManagedExchangeBackedUp(record.id, "2026-07-14T12:00:00.000Z");
    const before = await getManagedExchange(record.id);

    expect(
      await spendManagedExchangeIfCurrent(
        record.id,
        record.sharedSecret,
        "2026-07-14T13:00:00.000Z",
      ),
    ).toBe("spent");

    const local = await getManagedLocalState(record.id);
    // A migration spend records no hand-off: its own artifact revives it.
    expect(local?.spent).toEqual({ spentAt: "2026-07-14T13:00:00.000Z" });
    // A spent source has a current export by construction, so the marker stands;
    // the record itself is the sibling entry's business, not this write's.
    expect(local?.backup).toEqual({ backedUpAt: "2026-07-14T12:00:00.000Z" });
    expect(await getManagedExchange(record.id)).toEqual(before);
  });

  test("a command-line hand-off is recorded beside the instant", async () => {
    const record = await createManagedExchange(newExchange());

    expect(
      await spendManagedExchangeIfCurrent(
        record.id,
        record.sharedSecret,
        "2026-07-14T13:00:00.000Z",
        "command-line",
      ),
    ).toBe("spent");

    expect((await getManagedLocalState(record.id))?.spent).toEqual({
      spentAt: "2026-07-14T13:00:00.000Z",
      handoff: "command-line",
    });
  });

  test("a record already gone refuses as gone, and leaves no sibling entry behind", async () => {
    // Reported as its own refusal rather than folded into the superseded one: the
    // hand-off surfaces answer them differently, since a record that is not here
    // cannot be downloaded again.
    const record = await createManagedExchange(newExchange());
    const downloadedSecret = record.sharedSecret;
    await deleteManagedExchange(record.id);

    expect(
      await spendManagedExchangeIfCurrent(
        record.id,
        downloadedSecret,
        "2026-07-14T13:00:00.000Z",
      ),
    ).toBe("gone");

    // No spent state stranded under an id with no record: there is no live copy
    // left to spend.
    expect(await getManagedLocalState(record.id)).toBeUndefined();
    expect((await listManagedLocalState()).size).toBe(0);
  });
});

describe("the export binds the marker to the bytes it serialized", () => {
  // The call sites a real export drives against the live store: read-and-mark
  // atomically, then download the bytes read. The download is captured so the
  // test can inspect the exact bytes the marker attests.
  function exportDeps(): {
    downloaded: Array<string>;
    readAndMark: typeof readRecordAndMarkBackedUp;
    download: (fileName: string, content: string) => void;
    now: () => Date;
  } {
    const downloaded: Array<string> = [];
    return {
      downloaded,
      readAndMark: readRecordAndMarkBackedUp,
      download: (_fileName, content) => downloaded.push(content),
      now: () => new Date(),
    };
  }

  test("the post-run completion export contains the ROTATED secret, not the mount-time one", async () => {
    const record = await createManagedExchange(newExchange());
    const original = record.sharedSecret;
    // Simulate a run: the rotation persist advances the stored secret (and clears any
    // marker) exactly as runManagedExchange's persist-before-success write does.
    const rotated = generateSharedSecret();
    await persistManagedExchangeRotation(record.id, {
      sharedSecret: rotated,
      expires: null,
    });

    // The completion surface exports by id (never a stale React snapshot of the
    // pre-rotation record), so it serializes the rotated secret the store now holds.
    const deps = exportDeps();
    await exportManagedBackup(record.id, deps);
    const restored = importManagedExchangeArtifact(deps.downloaded[0]);
    expect(restored.sharedSecret).toBe(rotated);
    expect(restored.sharedSecret).not.toBe(original);

    // And the exchange shows green against the rotated store.
    const rows = savedExchangeRows(
      await listManagedExchanges(),
      await listManagedLocalState(),
      Date.now(),
    );
    expect(rows[0].backup.kind).toBe("backed-up");
  });

  test("a rotation stales the marker even when the run then fails in the data exchange", async () => {
    const record = await createManagedExchange(newExchange());
    // Take a backup: green.
    await exportManagedBackup(record.id, exportDeps());
    expect(
      savedExchangeRows(
        await listManagedExchanges(),
        await listManagedLocalState(),
        Date.now(),
      )[0].backup.kind,
    ).toBe("backed-up");

    // A run rotates and persists, THEN the data exchange fails: the rotation cleared
    // the marker in its own transaction, and a failed lastRun does not restore it.
    await persistManagedExchangeRotation(record.id, {
      sharedSecret: generateSharedSecret(),
      expires: null,
    });
    await recordManagedExchangeLastRun(record.id, {
      at: new Date().toISOString(),
      outcome: "failed",
      failureKind: "transport",
    });

    expect(await getManagedLocalState(record.id)).toBeUndefined();
    expect(
      savedExchangeRows(
        await listManagedExchanges(),
        await listManagedLocalState(),
        Date.now(),
      )[0].backup.kind,
    ).toBe("backup-needed");
  });

  test("a stale-tab export cannot mark green over a newer rotation", async () => {
    const record = await createManagedExchange(newExchange());
    // Another context rotates the secret (and clears the marker).
    const rotated = generateSharedSecret();
    await persistManagedExchangeRotation(record.id, {
      sharedSecret: rotated,
      expires: null,
    });

    // A stale tab holding the pre-rotation record exports. Because the export reads
    // and marks atomically by id, it serializes the ROTATED secret and marks that --
    // it structurally cannot stamp a marker over a secret it did not serialize.
    const deps = exportDeps();
    await exportManagedBackup(record.id, deps);
    const restored = importManagedExchangeArtifact(deps.downloaded[0]);
    expect(restored.sharedSecret).toBe(rotated);
    expect(await getManagedExchange(record.id)).toMatchObject({
      sharedSecret: rotated,
    });
  });

  test("a migration dispatch marks green but spends only on confirm", async () => {
    const record = await createManagedExchange(newExchange());
    const downloaded: Array<string> = [];
    const dispatch = await dispatchManagedMigration(record.id, {
      readAndMark: readRecordAndMarkBackedUp,
      download: (_fileName, content) => downloaded.push(content),
      spendIfCurrent: spendManagedExchangeIfCurrent,
      now: () => new Date(),
    });
    // Dispatched: backed up, but the source is still live (no spent state yet).
    expect((await getManagedLocalState(record.id))?.backup).toBeDefined();
    expect((await getManagedLocalState(record.id))?.spent).toBeUndefined();

    await dispatch.confirm(new Date());
    expect((await getManagedLocalState(record.id))?.spent).toBeDefined();
  });
});

describe("importing a spent secret-match revives in place", () => {
  test("a backup export marks the record and its file restores the exchange", async () => {
    // The export the indicator is about, end to end against the real store: it marks
    // the record green, and the bytes it wrote bring the exchange back after the
    // eviction the marker promises they cover.
    const source = await createManagedExchange(newExchange());
    const deps = {
      downloaded: [] as Array<string>,
      readAndMark: readRecordAndMarkBackedUp,
      download: (_fileName: string, content: string) =>
        deps.downloaded.push(content),
      now: () => new Date(),
    };
    await exportManagedBackup(source.id, deps);
    expect((await getManagedLocalState(source.id))?.backup).toBeDefined();

    await deleteManagedExchange(source.id);
    const restored = await importManagedExchange(deps.downloaded[0]);
    expect(restored.sharedSecret).toBe(source.sharedSecret);
    expect(restored.exchangeFile).toEqual(source.exchangeFile);
  });

  test("an artifact predating a command-line hand-off is refused, not revived", async () => {
    // The husk this artifact would fork: the exchange runs from the CLI files the
    // operator saved, so the older browser backup brings nothing back. Reviving would
    // run a copy that was handed away; installing fresh would leave the secret in a
    // live row beside the spent husk. The import refuses instead, naming the record.
    const source = await createManagedExchange(newExchange());
    const bytes = serializeManagedExchangeArtifact(
      encodeManagedExchangeArtifact(source),
    );
    await spendManagedExchangeIfCurrent(
      source.id,
      source.sharedSecret,
      "2026-07-14T13:00:00.000Z",
      "command-line",
    );

    await expect(importManagedExchange(bytes)).rejects.toMatchObject({
      name: "ManagedImportHandedOffError",
      handoff: "command-line",
      label: source.label,
    });

    // Nothing was written by the refusal: one record, still spent under its hand-off,
    // and no import or backup marker stamped over it.
    expect((await listManagedExchanges()).map((r) => r.id)).toEqual([
      source.id,
    ]);
    expect(await getManagedLocalState(source.id)).toEqual({
      spent: { spentAt: "2026-07-14T13:00:00.000Z", handoff: "command-line" },
    });
  });

  test("a hand-off match refuses even beside a migration-spent match", async () => {
    // Both spent shapes hold the artifact's secret at once: the migration copy the
    // artifact would revive, and the copy a command-line hand-off runs from. Reviving
    // the migration husk would put a second live owner beside that hand-off, so the
    // refusal wins and names the handed-off record.
    const migrated = await createManagedExchange(newExchange());
    const bytes = serializeManagedExchangeArtifact(
      encodeManagedExchangeArtifact(migrated),
    );
    const handedOff = await createManagedExchange(
      newExchange({
        label: "Riverbend quarterly (command line)",
        sharedSecret: migrated.sharedSecret,
      }),
    );
    await spendManagedExchangeIfCurrent(
      migrated.id,
      migrated.sharedSecret,
      "2026-07-14T13:00:00.000Z",
    );
    await spendManagedExchangeIfCurrent(
      handedOff.id,
      handedOff.sharedSecret,
      "2026-07-14T14:00:00.000Z",
      "command-line",
    );
    const before = [
      await getManagedExchange(migrated.id),
      await getManagedExchange(handedOff.id),
    ];

    await expect(importManagedExchange(bytes)).rejects.toMatchObject({
      name: "ManagedImportHandedOffError",
      handoff: "command-line",
      label: handedOff.label,
    });

    // Nothing was written: no revive of the migration husk, no fresh install, and both
    // records still have exactly the spent state they were left with.
    const all = await listManagedExchanges();
    expect(all.map((r) => r.id).sort()).toEqual(
      [migrated.id, handedOff.id].sort(),
    );
    expect(await getManagedExchange(migrated.id)).toEqual(before[0]);
    expect(await getManagedExchange(handedOff.id)).toEqual(before[1]);
    expect(await getManagedLocalState(migrated.id)).toEqual({
      spent: { spentAt: "2026-07-14T13:00:00.000Z" },
    });
    expect(await getManagedLocalState(handedOff.id)).toEqual({
      spent: { spentAt: "2026-07-14T14:00:00.000Z", handoff: "command-line" },
    });
  });

  test("a re-import onto the spending device revives the husk, not a duplicate", async () => {
    const source = await createManagedExchange(newExchange({ schedule }));
    const bytes = serializeManagedExchangeArtifact(
      encodeManagedExchangeArtifact(source),
    );
    // Spend the source (a migration handed it off from this device).
    await spendManagedExchangeIfCurrent(
      source.id,
      source.sharedSecret,
      new Date().toISOString(),
    );

    // Importing the artifact back revives the SAME record (same id), clears spent,
    // and marks it backed-up -- no duplicate row.
    const revived = await importManagedExchange(bytes);
    expect(revived.id).toBe(source.id);
    expect(revived.sharedSecret).toBe(source.sharedSecret);
    // The revive restores the whole artifact, not just the secret: the unattended
    // path picks the recurrence back up at the window and miss count the artifact
    // holds, rather than reviving an attended-only husk.
    expect(revived.schedule).toEqual(
      importManagedExchangeArtifact(bytes).schedule,
    );
    expect(revived.schedule).toEqual(schedule);
    const all = await listManagedExchanges();
    expect(all.map((r) => r.id)).toEqual([source.id]);
    const local = await getManagedLocalState(source.id);
    expect(local?.spent).toBeUndefined();
    expect(local?.backup).toBeDefined();
    // A revive is an import event: it stamps the restore evidence the desync
    // tiering reads, at the same instant as the backup marker it writes with it.
    expect(local?.imported?.importedAt).toEqual(expect.any(String));
    expect(local?.imported?.importedAt).toBe(local?.backup?.backedUpAt);
  });

  test("importing over a LIVE secret-match installs fresh (never forks a live owner)", async () => {
    const source = await createManagedExchange(newExchange());
    const bytes = serializeManagedExchangeArtifact(
      encodeManagedExchangeArtifact(source),
    );
    // The source is live (not spent): an import is a second owner, installed fresh.
    const installed = await importManagedExchange(bytes);
    expect(installed.id).not.toBe(source.id);
    const all = await listManagedExchanges();
    expect(all).toHaveLength(2);
  });
});

describe("delete leaves no sibling state behind", () => {
  test("deleting a record removes its backup marker and spent state", async () => {
    const record = await createManagedExchange(newExchange());
    await markManagedExchangeBackedUp(record.id, new Date().toISOString());
    await spendManagedExchangeIfCurrent(
      record.id,
      record.sharedSecret,
      new Date().toISOString(),
    );
    expect(await getManagedLocalState(record.id)).toBeDefined();

    await deleteManagedExchange(record.id);

    expect(await getManagedExchange(record.id)).toBeUndefined();
    expect(await getManagedLocalState(record.id)).toBeUndefined();
    expect((await listManagedLocalState()).size).toBe(0);
  });
});
