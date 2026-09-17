/// <reference types="@vitest/browser-playwright/context" />
/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@psilink/core";

import {
  MANAGED_EXCHANGE_LOCAL_STORE_NAME,
  MANAGED_EXCHANGE_STORE_NAME,
  clearManagedExchanges,
  createManagedExchange,
  deleteManagedExchange,
  getManagedExchange,
  listManagedExchanges,
  listManagedExchangesDiagnostic,
  openManagedExchangeDatabase,
  persistManagedExchangeRotation,
  readRecordAndMarkBackedUp,
  recordManagedExchangeLastRun,
  retakeHandedOffManagedExchange,
  spendManagedExchangeIfCurrent,
} from "@psi/managed/managedExchangeStore";
import {
  dispatchManagedMigration,
  exportManagedBackup,
} from "@psi/managed/managedExchangeExport";
import {
  encodeManagedExchangeArtifact,
  importManagedExchangeArtifact,
  serializeManagedExchangeArtifact,
} from "@psi/managed/managedExchangeArtifact";
import {
  getManagedLocalState,
  listManagedLocalState,
  markManagedExchangeBackedUp,
  markManagedExchangeImported,
} from "@psi/managed/managedLocalState";
import { composeManagedExchangeFile } from "@psi/managed/managedExchangeRecord";
import { deriveManagedFailureTier } from "@psi/managed/managedFailureTiers";
import { failedRun } from "@psi/managed/managedRunRotate";
import { importManagedExchange } from "@psi/managed/managedExchangeImport";
import { managedRunFailureFromRecord } from "@recurring/managedRunLaunchModel";
import { savedExchangeRows } from "@recurring/savedExchangesModel";
import { withManagedExchangeLock } from "@psi/managed/managedExchangeLock";

import type {
  ManagedExchangeSchedule,
  NewManagedExchange,
} from "@psi/managed/managedExchangeRecord";
import type { WebRTCExchangeLocator } from "@psilink/core";

// The store-backed export/import and local sibling state, exercised against real
// Chromium (real IndexedDB and the sibling object store). The pure encode/parse and
// derivation are unit-tested without a database; this suite proves an export/import
// round-trip installs one owner against the real store, a migration spends the
// source, the backup marker and spent state persist beside the record, a record
// this build cannot parse is skipped rather than failing an import (as is a
// sibling entry it cannot parse, which refuses conservatively where it holds the
// artifact's secret), and a delete leaves no sibling entry behind.

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

    const { record: installed } = await importManagedExchange(bytes);
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
    const { record: installed } = await importManagedExchange(bytes);
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
    const { record: installed } = await importManagedExchange(bytes);

    // The first run after the import fails closed. Its bookkeeping lands as auth.
    await recordManagedExchangeLastRun(
      installed.id,
      failedRun(Date.now(), "failed", "auth"),
      Date.now(),
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
      Date.now(),
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
      Date.now(),
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
    const { record: revived } = await importManagedExchange(bytes);
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
    const { record: restored } = importManagedExchangeArtifact(
      deps.downloaded[0],
    );
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
    await recordManagedExchangeLastRun(
      record.id,
      {
        at: new Date().toISOString(),
        outcome: "failed",
        failureKind: "transport",
      },
      Date.now(),
    );

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
    const { record: restored } = importManagedExchangeArtifact(
      deps.downloaded[0],
    );
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
    const { record: restored } = await importManagedExchange(
      deps.downloaded[0],
    );
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
    const { record: revived } = await importManagedExchange(bytes);
    expect(revived.id).toBe(source.id);
    expect(revived.sharedSecret).toBe(source.sharedSecret);
    // The revive restores the whole artifact, not just the secret: the unattended
    // path picks the recurrence back up at the window and miss count the artifact
    // holds, rather than reviving an attended-only husk.
    expect(revived.schedule).toEqual(
      importManagedExchangeArtifact(bytes).record.schedule,
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
    const { record: installed } = await importManagedExchange(bytes);
    expect(installed.id).not.toBe(source.id);
    const all = await listManagedExchanges();
    expect(all).toHaveLength(2);
  });
});

/** Plant an invalid record under `id`, keeping every other field of `fields`, so a
 * test stages the record an app upgrade left unreadable. Bypasses the validating
 * write, as no supported path stores one. */
async function plantUnreadable(id: string, fields: object): Promise<void> {
  const db = await openManagedExchangeDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(
        MANAGED_EXCHANGE_STORE_NAME,
        "readwrite",
      );
      transaction
        .objectStore(MANAGED_EXCHANGE_STORE_NAME)
        .put({ ...fields, id, schemaVersion: "psilink-managed-exchange/v3" });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

/** Plant a sibling entry this build's schema refuses under `id`: a hand-off route a
 * newer build recorded is the shape an app upgrade leaves behind. Bypasses the
 * validating write, as no supported path stores one. */
async function plantUnreadableSibling(id: string): Promise<void> {
  const db = await openManagedExchangeDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(
        MANAGED_EXCHANGE_LOCAL_STORE_NAME,
        "readwrite",
      );
      transaction.objectStore(MANAGED_EXCHANGE_LOCAL_STORE_NAME).put(
        {
          spent: {
            spentAt: "2026-07-14T13:00:00.000Z",
            handoff: "a-route-this-build-does-not-know",
          },
        },
        id,
      );
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

describe("a record this build cannot parse is skipped, not fatal to the import", () => {
  /** The stored keys the diagnostic read reports as unreadable -- what an operator
   * still has to discard after an import from the read-failed state. */
  async function unreadableIds(): Promise<Array<string>> {
    const entries = await listManagedExchangesDiagnostic();
    return entries.flatMap((entry) =>
      entry.kind === "unreadable" ? [entry.id] : [],
    );
  }

  test("an unrelated import lands beside an invalid record and a handed-off one", async () => {
    // The read-failed state an operator meets: one record this build cannot parse,
    // beside a valid record handed off to the command line. The artifact is a third
    // exchange's, so the import has nothing to reconcile -- and the invalid record
    // must not refuse it, which is the way forward the surface offers.
    const other = await createManagedExchange(
      newExchange({ label: "Other partnership" }),
    );
    const bytes = serializeManagedExchangeArtifact(
      encodeManagedExchangeArtifact(other),
    );
    await deleteManagedExchange(other.id);
    const handedOff = await createManagedExchange(
      newExchange({ label: "Handed to the command line" }),
    );
    expect(
      await spendManagedExchangeIfCurrent(
        handedOff.id,
        handedOff.sharedSecret,
        "2026-07-14T13:00:00.000Z",
        "command-line",
      ),
    ).toBe("spent");
    await plantUnreadable("zzz-bad-record", {
      ...handedOff,
      sharedSecret: generateSharedSecret(),
    });
    // Precondition: the attended list read rejects wholesale, so this is the state
    // the read-failed recovery surface renders from.
    await expect(listManagedExchanges()).rejects.toThrow();

    const { record: installed } = await importManagedExchange(bytes);

    expect(installed.sharedSecret).toBe(other.sharedSecret);
    expect(installed.label).toBe("Other partnership");
    // The invalid record is left in place and still reported, for the operator to
    // discard from the recovery listing.
    expect(await unreadableIds()).toEqual(["zzz-bad-record"]);
    // The handed-off record is untouched: no revive, and its spent state stands.
    expect(await getManagedExchange(handedOff.id)).toEqual(handedOff);
    expect(await getManagedLocalState(handedOff.id)).toEqual({
      spent: { spentAt: "2026-07-14T13:00:00.000Z", handoff: "command-line" },
    });
  });

  test("a skipped record's own hand-off still refuses the import", async () => {
    // The record became unreadable after the hand-off spent it, so its secret field
    // still reads: the refusal fires on it rather than installing a second live copy
    // beside the machine the hand-off runs on. It names no label, the failed parse
    // leaving the record's own fields untrusted.
    const handedOff = await createManagedExchange(newExchange());
    const bytes = serializeManagedExchangeArtifact(
      encodeManagedExchangeArtifact(handedOff),
    );
    expect(
      await spendManagedExchangeIfCurrent(
        handedOff.id,
        handedOff.sharedSecret,
        "2026-07-14T13:00:00.000Z",
        "command-line",
      ),
    ).toBe("spent");
    await plantUnreadable(handedOff.id, handedOff);

    await expect(importManagedExchange(bytes)).rejects.toMatchObject({
      name: "ManagedImportHandedOffError",
      handoff: "command-line",
      label: "",
    });

    // Nothing was written: the store still holds that one unreadable record.
    expect(await unreadableIds()).toEqual([handedOff.id]);
    expect(await getManagedLocalState(handedOff.id)).toEqual({
      spent: { spentAt: "2026-07-14T13:00:00.000Z", handoff: "command-line" },
    });
  });

  test("a skipped record whose secret field is unreadable too installs fresh", async () => {
    // The stated limit of that refusal: the comparison needs the stored secret, so a
    // record holding none this build can read matches nothing and the import lands.
    const handedOff = await createManagedExchange(newExchange());
    const bytes = serializeManagedExchangeArtifact(
      encodeManagedExchangeArtifact(handedOff),
    );
    expect(
      await spendManagedExchangeIfCurrent(
        handedOff.id,
        handedOff.sharedSecret,
        "2026-07-14T13:00:00.000Z",
        "command-line",
      ),
    ).toBe("spent");
    await plantUnreadable(handedOff.id, { ...handedOff, sharedSecret: 42 });

    const { record: installed } = await importManagedExchange(bytes);

    expect(installed.id).not.toBe(handedOff.id);
    expect(await unreadableIds()).toEqual([handedOff.id]);
  });

  test("a skipped record holding no secret field at all installs fresh", async () => {
    // The same limit reached the other way: an app upgrade can leave a record with
    // no `sharedSecret` field rather than an unreadable one, and an absent field
    // matches no artifact either, so the refusal does not fire.
    const handedOff = await createManagedExchange(newExchange());
    const bytes = serializeManagedExchangeArtifact(
      encodeManagedExchangeArtifact(handedOff),
    );
    expect(
      await spendManagedExchangeIfCurrent(
        handedOff.id,
        handedOff.sharedSecret,
        "2026-07-14T13:00:00.000Z",
        "command-line",
      ),
    ).toBe("spent");
    const withoutSecret: Record<string, unknown> = { ...handedOff };
    delete withoutSecret.sharedSecret;
    expect("sharedSecret" in withoutSecret).toBe(false);
    await plantUnreadable(handedOff.id, withoutSecret);

    const { record: installed } = await importManagedExchange(bytes);

    expect(installed.id).not.toBe(handedOff.id);
    expect(installed.sharedSecret).toBe(handedOff.sharedSecret);
    expect(await unreadableIds()).toEqual([handedOff.id]);
  });

  test("a skipped migration-spent record installs fresh beside the husk", async () => {
    // A revive rewrites the whole record, which needs a record this build can parse,
    // so the migration's artifact installs fresh and the husk stays for the operator
    // to discard.
    const source = await createManagedExchange(newExchange());
    const bytes = serializeManagedExchangeArtifact(
      encodeManagedExchangeArtifact(source),
    );
    expect(
      await spendManagedExchangeIfCurrent(
        source.id,
        source.sharedSecret,
        "2026-07-14T13:00:00.000Z",
      ),
    ).toBe("spent");
    await plantUnreadable(source.id, source);

    const { record: installed } = await importManagedExchange(bytes);

    expect(installed.id).not.toBe(source.id);
    expect(installed.sharedSecret).toBe(source.sharedSecret);
    expect(await unreadableIds()).toEqual([source.id]);
  });

  test("a parseable migration-spent record is revived beside an invalid one", async () => {
    // The recovery the skip is for: the artifact's own migration-spent record parses,
    // so it is revived in place -- same id, and the input handle and output-folder
    // grant it already held -- while the invalid record beside it is skipped and left
    // for the operator to discard.
    const root = await navigator.storage.getDirectory();
    const inputFile = await root.getFileHandle("revived-input.csv", {
      create: true,
    });
    const outputFolder = await root.getDirectoryHandle("revived-results", {
      create: true,
    });
    const source = await createManagedExchange(
      newExchange({
        inputFileHandle: inputFile,
        outputDirectoryHandle: outputFolder,
      }),
    );
    const bytes = serializeManagedExchangeArtifact(
      encodeManagedExchangeArtifact(source),
    );
    expect(
      await spendManagedExchangeIfCurrent(
        source.id,
        source.sharedSecret,
        "2026-07-14T13:00:00.000Z",
      ),
    ).toBe("spent");
    await plantUnreadable("zzz-bad-record", {
      ...source,
      sharedSecret: generateSharedSecret(),
    });
    // Precondition: the attended list read rejects wholesale, so this is the state
    // the read-failed recovery surface renders from.
    await expect(listManagedExchanges()).rejects.toThrow();

    const { record: revived, missingGrants } =
      await importManagedExchange(bytes);

    expect(revived.id).toBe(source.id);
    expect(revived.sharedSecret).toBe(source.sharedSecret);
    expect(await revived.inputFileHandle?.isSameEntry(inputFile)).toBe(true);
    expect(await revived.outputDirectoryHandle?.isSameEntry(outputFolder)).toBe(
      true,
    );
    // The artifact states its source held both grants, so the empty report below is
    // the revive keeping them rather than the markers being absent.
    expect(importManagedExchangeArtifact(bytes).heldGrants).toEqual([
      "input-file",
      "output-folder",
    ]);
    // Both grants are still here, so the import asks for neither of them again.
    expect(missingGrants).toEqual([]);
    // The spend is cleared and the revive stamped its import evidence.
    const local = await getManagedLocalState(source.id);
    expect(local?.spent).toBeUndefined();
    expect(local?.imported?.importedAt).toEqual(expect.any(String));
    // One readable row, the revived one: no duplicate installed beside it.
    const readableIds = (await listManagedExchangesDiagnostic()).flatMap(
      (entry) => (entry.kind === "readable" ? [entry.essentials.id] : []),
    );
    expect(readableIds).toEqual([source.id]);
    // The invalid record is left in place and still reported.
    expect(await unreadableIds()).toEqual(["zzz-bad-record"]);

    await root.removeEntry("revived-input.csv");
    await root.removeEntry("revived-results", { recursive: true });
  });
});

describe("a local-state entry this build cannot parse is skipped too", () => {
  test("an unrelated import lands beside one, and beside a handed-off record", async () => {
    // The second way into the read-failed surface: one sibling entry this build
    // cannot parse, beside a valid record handed off to the command line. The
    // artifact is a third exchange's, so nothing stored holds its secret and the
    // import must land -- which is the way forward that surface offers.
    const other = await createManagedExchange(
      newExchange({ label: "Other partnership" }),
    );
    const bytes = serializeManagedExchangeArtifact(
      encodeManagedExchangeArtifact(other),
    );
    await deleteManagedExchange(other.id);
    const handedOff = await createManagedExchange(
      newExchange({ label: "Handed to the command line" }),
    );
    expect(
      await spendManagedExchangeIfCurrent(
        handedOff.id,
        handedOff.sharedSecret,
        "2026-07-14T13:00:00.000Z",
        "command-line",
      ),
    ).toBe("spent");
    const stranded = await createManagedExchange(
      newExchange({ label: "Saved state unreadable" }),
    );
    await plantUnreadableSibling(stranded.id);
    // Precondition: the attended load joins the sibling state and rejects wholesale
    // on that entry, so this is the state the read-failed surface renders from.
    await expect(listManagedLocalState()).rejects.toThrow();

    const { record: installed } = await importManagedExchange(bytes);

    expect(installed.sharedSecret).toBe(other.sharedSecret);
    expect(installed.label).toBe("Other partnership");
    // Both stored records are untouched, and the unreadable entry is left for the
    // operator to discard.
    expect(await getManagedExchange(stranded.id)).toEqual(stranded);
    expect(await getManagedExchange(handedOff.id)).toEqual(handedOff);
    await expect(listManagedLocalState()).rejects.toThrow();
  });

  test("a record whose saved state cannot be read refuses the import", async () => {
    // The conservative refusal: the sibling entry is where a hand-off is recorded,
    // so an unreadable one leaves no way to tell a handed-off record from a
    // migration-spent or a live one. It names the exchange and no hand-off route.
    const stored = await createManagedExchange(newExchange());
    const bytes = serializeManagedExchangeArtifact(
      encodeManagedExchangeArtifact(stored),
    );
    await plantUnreadableSibling(stored.id);

    await expect(importManagedExchange(bytes)).rejects.toMatchObject({
      name: "ManagedImportCustodyUnreadableError",
      label: "Riverbend quarterly",
    });
    await expect(importManagedExchange(bytes)).rejects.not.toHaveProperty(
      "handoff",
    );

    // Nothing was written: the stored record stands alone, with no second copy.
    expect((await listManagedExchanges()).map((record) => record.id)).toEqual([
      stored.id,
    ]);
  });

  test("an unreadable entry beside an unreadable record refuses with no label", async () => {
    // Both halves unreadable: the secret still reads off the raw record, so the
    // refusal fires, and it names no label, the failed parse leaving the record's
    // own fields untrusted.
    const stored = await createManagedExchange(newExchange());
    const bytes = serializeManagedExchangeArtifact(
      encodeManagedExchangeArtifact(stored),
    );
    await plantUnreadable(stored.id, stored);
    await plantUnreadableSibling(stored.id);

    await expect(importManagedExchange(bytes)).rejects.toMatchObject({
      name: "ManagedImportCustodyUnreadableError",
      label: "",
    });
  });

  test("an entry holding another exchange's secret leaves the import alone", async () => {
    // The unreadable entry belongs to an exchange the artifact is not: it takes no
    // part in the reconciliation, so a migration-spent record is revived in place
    // beside it rather than the import refusing or installing a duplicate.
    const source = await createManagedExchange(newExchange());
    const bytes = serializeManagedExchangeArtifact(
      encodeManagedExchangeArtifact(source),
    );
    expect(
      await spendManagedExchangeIfCurrent(
        source.id,
        source.sharedSecret,
        "2026-07-14T13:00:00.000Z",
      ),
    ).toBe("spent");
    const stranded = await createManagedExchange(
      newExchange({ label: "Saved state unreadable" }),
    );
    await plantUnreadableSibling(stranded.id);

    const { record: revived } = await importManagedExchange(bytes);

    expect(revived.id).toBe(source.id);
    expect(revived.sharedSecret).toBe(source.sharedSecret);
    const local = await getManagedLocalState(source.id);
    expect(local?.spent).toBeUndefined();
    expect(local?.imported?.importedAt).toEqual(expect.any(String));
    expect(await getManagedExchange(stranded.id)).toEqual(stranded);
  });

  test("a hand-off the store could read decides ahead of one it could not", async () => {
    // Two stored records hold the artifact's secret and only one states what spent
    // it, so the refusal that can name a route is the one the import meets.
    const handedOff = await createManagedExchange(newExchange());
    const bytes = serializeManagedExchangeArtifact(
      encodeManagedExchangeArtifact(handedOff),
    );
    expect(
      await spendManagedExchangeIfCurrent(
        handedOff.id,
        handedOff.sharedSecret,
        "2026-07-14T13:00:00.000Z",
        "command-line",
      ),
    ).toBe("spent");
    const stranded = await createManagedExchange(
      newExchange({
        label: "Saved state unreadable",
        sharedSecret: handedOff.sharedSecret,
      }),
    );
    await plantUnreadableSibling(stranded.id);

    await expect(importManagedExchange(bytes)).rejects.toMatchObject({
      name: "ManagedImportHandedOffError",
      handoff: "command-line",
      label: "Riverbend quarterly",
    });
  });
});

describe("what the handed-off import refusal is scoped to", () => {
  // Both of the refusal's conditions are the operator's to remove, and neither is
  // prevented: it is an operator-cooperation property, not a cryptographic one
  // (docs/spec/MANAGED_EXCHANGE_RECORD.md). These pin what each removal leaves in
  // the store, which is what the re-take's attestation exists to be better than.

  test("an artifact behind the record's rotation matches nothing and installs fresh", async () => {
    const source = await createManagedExchange(newExchange());
    const bytes = serializeManagedExchangeArtifact(
      encodeManagedExchangeArtifact(source),
    );
    // A run rotated the secret before the hand-off, so the artifact holds a secret
    // no stored record has: nothing for the refusal to match on.
    const rotated = await persistManagedExchangeRotation(source.id, {
      sharedSecret: generateSharedSecret(),
      expires: null,
    });
    await spendManagedExchangeIfCurrent(
      source.id,
      rotated.sharedSecret,
      "2026-07-14T13:00:00.000Z",
      "command-line",
    );

    const { record: installed } = await importManagedExchange(bytes);

    // A second live row beside the handed-off husk, holding the older secret.
    expect(installed.id).not.toBe(source.id);
    expect(installed.sharedSecret).toBe(source.sharedSecret);
    expect((await listManagedExchanges()).map((r) => r.id).sort()).toEqual(
      [source.id, installed.id].sort(),
    );
    // The handed-off record is untouched by the import that landed beside it.
    expect(await getManagedExchange(source.id)).toEqual(rotated);
    expect(await getManagedLocalState(source.id)).toEqual({
      spent: { spentAt: "2026-07-14T13:00:00.000Z", handoff: "command-line" },
    });
  });

  test("deleting the handed-off record removes the match, and a later import installs", async () => {
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
    });

    await deleteManagedExchange(source.id);
    const { record: installed } = await importManagedExchange(bytes);

    // The delete took the record the refusal was made against, so the same bytes
    // install a live copy of a secret the command line still holds.
    expect(installed.id).not.toBe(source.id);
    expect(installed.sharedSecret).toBe(source.sharedSecret);
    expect((await listManagedExchanges()).map((r) => r.id)).toEqual([
      installed.id,
    ]);
    const local = await getManagedLocalState(installed.id);
    expect(local?.spent).toBeUndefined();
    expect(local?.imported?.importedAt).toEqual(expect.any(String));
  });
});

describe("taking a command-line hand-off back", () => {
  // The attested route out of the spent state. The store step is what these pin:
  // it clears the spent state, reads the key file's secret in where the scheduled
  // runs have moved past the stored one, and writes nothing at all otherwise.

  async function handedOff() {
    const record = await createManagedExchange(newExchange({ schedule }));
    await markManagedExchangeBackedUp(record.id, "2026-07-14T12:00:00.000Z");
    await spendManagedExchangeIfCurrent(
      record.id,
      record.sharedSecret,
      "2026-07-14T13:00:00.000Z",
      "command-line",
    );
    return record;
  }

  test("a re-take with no key file makes the record live, changing nothing else", async () => {
    // The case the ruling settles with "no cron run happened": the stored secret
    // is still the partnership's, so nothing is read in and the backup taken
    // before the hand-off still holds the current secret.
    const record = await handedOff();

    const outcome = await retakeHandedOffManagedExchange(record.id);

    expect(outcome).toEqual({ kind: "retaken", record });
    expect(await getManagedExchange(record.id)).toEqual(record);
    expect(await getManagedLocalState(record.id)).toEqual({
      backup: { backedUpAt: "2026-07-14T12:00:00.000Z" },
    });
  });

  test("the key file's rotated secret is read in, and stales the backup with it", async () => {
    // The scheduled runs on the other machine rotated the secret and wrote it back
    // to the key file, so the stored one is behind the partnership's.
    const record = await handedOff();
    const key = {
      sharedSecret: generateSharedSecret(),
      expires: "2026-10-01T00:00:00.000Z",
    };

    const outcome = await retakeHandedOffManagedExchange(record.id, key);

    const stored = await getManagedExchange(record.id);
    expect(outcome).toEqual({ kind: "retaken", record: stored });
    expect(stored?.sharedSecret).toBe(key.sharedSecret);
    expect(stored?.expires).toBe(key.expires);
    // Only the secret half moved: the terms, the label and the schedule are the
    // record's own, and no re-invite happened.
    expect(stored?.exchangeFile).toEqual(record.exchangeFile);
    expect(stored?.schedule).toEqual(schedule);
    // The secret advanced, so the backup taken before it attests bytes the
    // partnership has moved past: the marker goes the way every rotation sends it,
    // and the spent state with it.
    expect(await getManagedLocalState(record.id)).toBeUndefined();
  });

  test("a run holding the run+rotate lock refuses the re-take, writing nothing", async () => {
    // The run re-reads the spent state as its first act inside that lock, so a
    // re-take landing beside it would decide against state the run is about to
    // read. Excluded on the lock, exactly as the hand-off spend is.
    const record = await handedOff();
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
      expect(await retakeHandedOffManagedExchange(record.id)).toEqual({
        kind: "run-in-flight",
      });
      expect((await getManagedLocalState(record.id))?.spent).toEqual({
        spentAt: "2026-07-14T13:00:00.000Z",
        handoff: "command-line",
      });
    } finally {
      // Released even if the assertions throw, so a failing test cannot strand the
      // exclusive lock for the rest of the page's life.
      release();
      await run;
    }

    // The refusal consumed nothing: the same copy comes back once the lock is free.
    expect((await retakeHandedOffManagedExchange(record.id)).kind).toBe(
      "retaken",
    );
  });

  test("a migration-spent copy is not this route's to take back", async () => {
    // Its recovery is importing its own artifact back, which revives it in place;
    // clearing its spent state here would leave the device it was migrated to
    // running beside a live copy here.
    const record = await createManagedExchange(newExchange());
    await spendManagedExchangeIfCurrent(
      record.id,
      record.sharedSecret,
      "2026-07-14T13:00:00.000Z",
    );

    expect(await retakeHandedOffManagedExchange(record.id)).toEqual({
      kind: "not-handed-off",
    });
    expect(await getManagedLocalState(record.id)).toEqual({
      spent: { spentAt: "2026-07-14T13:00:00.000Z" },
    });
  });

  test("a live record has nothing to take back, and a deleted one is gone", async () => {
    const live = await createManagedExchange(newExchange());
    expect(await retakeHandedOffManagedExchange(live.id)).toEqual({
      kind: "not-handed-off",
    });
    expect(await getManagedExchange(live.id)).toEqual(live);

    const record = await handedOff();
    await deleteManagedExchange(record.id);
    expect(await retakeHandedOffManagedExchange(record.id)).toEqual({
      kind: "gone",
    });
    expect(await getManagedLocalState(record.id)).toBeUndefined();
  });

  test("a key the record schema rejects leaves the record exactly as it was", async () => {
    // The write is field-scoped and re-validated, so a malformed secret aborts the
    // whole cross-store transaction: the record keeps its own secret and stays
    // spent, rather than half-taken-back.
    const record = await handedOff();

    await expect(
      retakeHandedOffManagedExchange(record.id, {
        sharedSecret: "not-a-shared-secret",
      }),
    ).rejects.toThrow();

    expect(await getManagedExchange(record.id)).toEqual(record);
    expect(await getManagedLocalState(record.id)).toEqual({
      backup: { backedUpAt: "2026-07-14T12:00:00.000Z" },
      spent: { spentAt: "2026-07-14T13:00:00.000Z", handoff: "command-line" },
    });
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
