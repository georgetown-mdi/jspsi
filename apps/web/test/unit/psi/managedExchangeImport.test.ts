import { describe, expect, test, vi } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@psilink/core";

import {
  ManagedImportCustodyUnreadableError,
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
// route of its own refuses the import outright, as does one whose sibling state
// the reconciliation could not read; a malformed or tampered file
// is rejected before any install, so the store is left untouched. Each import
// also reports which of the source's device-local grants the imported record
// does not hold. The store-backed install (real IndexedDB) is the browser suite's.

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

/** A record holding whichever device-local grants the case needs: the input-file
 * pointer, the folder its scheduled runs write results to, or both. */
function recordHolding(grants: {
  inputFile?: boolean;
  outputFolder?: boolean;
}): ManagedExchangeRecord {
  return buildManagedExchangeRecord({
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: { channel: "webrtc", host: "signaling.example.org" },
      linkageTerms,
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
    ...(grants.inputFile === true
      ? { inputFileHandle: { name: "records.csv" } as FileSystemFileHandle }
      : {}),
    ...(grants.outputFolder === true
      ? {
          outputDirectoryHandle: {
            name: "results",
          } as FileSystemDirectoryHandle,
        }
      : {}),
  });
}

/** A backup of a record that held both device-local grants. */
function grantedBytes(): string {
  return serializeManagedExchangeArtifact(
    encodeManagedExchangeArtifact(
      recordHolding({ inputFile: true, outputFolder: true }),
    ),
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
    const { record: installed } = await importManagedExchange(
      goodBytes(),
      deps,
    );
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
    expect(result.record).toBe(existing);
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

  test("a match whose saved state could not be read refuses, installing nothing", async () => {
    // The sibling entry is where a hand-off is recorded, so a reconciliation that
    // could not read it can say neither that the copy is still this browser's nor
    // that it is gone. It refuses rather than reviving a copy a hand-off may hold or
    // installing a second live one, and it names the exchange but no route.
    const deps = recordingDeps({
      kind: "custody-unreadable",
      label: "Riverbend quarterly",
    });
    await expect(importManagedExchange(goodBytes(), deps)).rejects.toThrow(
      ManagedImportCustodyUnreadableError,
    );
    await expect(
      importManagedExchange(goodBytes(), deps),
    ).rejects.toMatchObject({ label: "Riverbend quarterly" });
    await expect(
      importManagedExchange(goodBytes(), deps),
    ).rejects.not.toHaveProperty("handoff");
    expect(deps.installed).toHaveLength(0);
    expect(deps.markImported).not.toHaveBeenCalled();
  });

  test("a marker-write failure after a fresh install still reports success", async () => {
    const deps = recordingDeps();
    deps.markImported.mockRejectedValueOnce(new Error("marker write failed"));
    const { record: installed } = await importManagedExchange(
      goodBytes(),
      deps,
    );
    // The record is durable; a best-effort marker failure must not fail the import
    // (a retry would duplicate it).
    expect(deps.installed).toHaveLength(1);
    expect(installed).toBe(deps.installed[0]);
  });

  test("the installed record has no input-file handle", async () => {
    const deps = recordingDeps();
    const { record: installed } = await importManagedExchange(
      goodBytes(),
      deps,
    );
    expect(installed).not.toHaveProperty("inputFileHandle");
  });

  test("has a backed-up schedule but still no handle, so no import can run unattended", async () => {
    // The converse of the deposit path (test/unit/exchange/manageOfferModel.test.ts,
    // which writes a handle and no schedule): an import can have a schedule and
    // reconstructs no handle, so neither path on its own assembles the pair the
    // unattended runner fires on. The source record here HELD a handle, so what
    // is asserted is that the round trip drops it rather than that there was
    // nothing to drop.
    const deps = recordingDeps();
    const { record: installed } = await importManagedExchange(
      scheduledBytes(),
      deps,
    );
    expect(installed.schedule).toMatchObject({
      nextWindow: "2026-01-06T14:00:00.000Z",
      intervalDays: 7,
    });
    expect(installed).not.toHaveProperty("inputFileHandle");
  });

  test("a fresh install reports the grants the source held and it does not", async () => {
    const deps = recordingDeps();
    const { missingGrants } = await importManagedExchange(grantedBytes(), deps);
    // Neither handle serializes, so a fresh install holds neither: the operator is
    // told at the import rather than by a scheduled run a window later.
    expect(missingGrants).toEqual(["input-file", "output-folder"]);
  });

  test("an import of a source that held neither grant reports none", async () => {
    const deps = recordingDeps();
    const { missingGrants } = await importManagedExchange(goodBytes(), deps);
    expect(missingGrants).toEqual([]);
  });

  test("a revive in place reports nothing missing: it keeps its own grants", async () => {
    // The profile's own spent record still holds the handles it took, so the revive
    // has nothing for the operator to choose again.
    const existing = recordHolding({ inputFile: true, outputFolder: true });
    const deps = recordingDeps({ kind: "revived", record: existing });
    const result = await importManagedExchange(grantedBytes(), deps);
    expect(result.record).toBe(existing);
    expect(result.missingGrants).toEqual([]);
  });

  test("a revive onto a record that lost a grant reports that one", async () => {
    // A revive keeps what the record has, not what the artifact's source had: a
    // folder grant the operator dropped here is still one to choose again.
    const deps = recordingDeps({
      kind: "revived",
      record: recordHolding({ inputFile: true }),
    });
    const result = await importManagedExchange(grantedBytes(), deps);
    expect(result.missingGrants).toEqual(["output-folder"]);
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
