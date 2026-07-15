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
} from "@psi/managedExchangeStore";
import {
  encodeManagedExchangeArtifact,
  serializeManagedExchangeArtifact,
} from "@psi/managedExchangeArtifact";
import {
  getManagedLocalState,
  listManagedLocalState,
  markManagedExchangeBackedUp,
  markManagedExchangeSpent,
} from "@psi/managedLocalState";
import { composeManagedExchangeFile } from "@psi/managedExchangeRecord";
import { importManagedExchange } from "@psi/managedExchangeImport";
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

    // The spent record revives only by importing the artifact back (a fresh owner).
    const revived = await importManagedExchange(bytes);
    expect(revived.sharedSecret).toBe(source.sharedSecret);
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
