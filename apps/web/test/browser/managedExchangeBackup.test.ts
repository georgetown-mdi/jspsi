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
  markManagedExchangeSpent,
} from "@psi/managedLocalState";
import { composeManagedExchangeFile } from "@psi/managedExchangeRecord";
import { deriveManagedFailureTier } from "@psi/managedFailureTiers";
import { failedRun } from "@psi/managedRunRotate";
import { importManagedExchange } from "@psi/managedExchangeImport";
import { managedRunFailureFromRecord } from "@bench/managedRunLaunchModel";
import { savedExchangeRows } from "@bench/savedExchangesModel";

import type { NewManagedExchange } from "@psi/managedExchangeRecord";
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
    // The import marks it backed-up, so it reads green immediately.
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
    // The artifact carries no import marker (a sibling, never in the export).
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

describe("an unattended run's failure surfaces through the same tiers at the next visit", () => {
  test("a stored auth failure with no benign evidence reads as the unexplained tier", async () => {
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

  test("a stored storage failure reads as the benign storage tier at the next visit", async () => {
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
  test("marking spent surfaces a spent row (no run) and revives by import", async () => {
    const source = await createManagedExchange(newExchange());
    const bytes = serializeManagedExchangeArtifact(
      encodeManagedExchangeArtifact(source),
    );

    await markManagedExchangeSpent(source.id, new Date().toISOString());
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

describe("the export binds the marker to the bytes it serialized", () => {
  // The seams a real export drives against the live store: read-and-mark atomically,
  // then download the bytes read. The download is captured so the test can inspect
  // the exact bytes the marker attests.
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

  test("the post-run completion export carries the ROTATED secret, not the mount-time one", async () => {
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

    // And the exchange reads green against the rotated store.
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
      markSpent: markManagedExchangeSpent,
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
  test("a re-import onto the spending device revives the husk, not a duplicate", async () => {
    const source = await createManagedExchange(newExchange());
    const bytes = serializeManagedExchangeArtifact(
      encodeManagedExchangeArtifact(source),
    );
    // Spend the source (a migration handed it off from this device).
    await markManagedExchangeSpent(source.id, new Date().toISOString());

    // Importing the artifact back revives the SAME record (same id), clears spent,
    // and marks it backed-up -- no duplicate row.
    const revived = await importManagedExchange(bytes);
    expect(revived.id).toBe(source.id);
    expect(revived.sharedSecret).toBe(source.sharedSecret);
    const all = await listManagedExchanges();
    expect(all.map((r) => r.id)).toEqual([source.id]);
    const local = await getManagedLocalState(source.id);
    expect(local?.spent).toBeUndefined();
    expect(local?.backup).toBeDefined();
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
    await markManagedExchangeSpent(record.id, new Date().toISOString());
    expect(await getManagedLocalState(record.id)).toBeDefined();

    await deleteManagedExchange(record.id);

    expect(await getManagedExchange(record.id)).toBeUndefined();
    expect(await getManagedLocalState(record.id)).toBeUndefined();
    expect((await listManagedLocalState()).size).toBe(0);
  });
});
