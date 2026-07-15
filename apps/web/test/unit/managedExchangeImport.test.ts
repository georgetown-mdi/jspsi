import { describe, expect, test, vi } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@psilink/core";

import {
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
} from "@psi/managedExchangeRecord";
import {
  encodeManagedExchangeArtifact,
  serializeManagedExchangeArtifact,
} from "@psi/managedExchangeArtifact";
import { importManagedExchange } from "@psi/managedExchangeImport";

import type { ManagedExchangeRecord } from "@psi/managedExchangeRecord";
import type { ManagedImportDeps } from "@psi/managedExchangeImport";

// The import take-over, tested in Node with injected seams: a valid artifact installs
// one owner and marks it imported-and-backed-up; a malformed or tampered file is
// rejected before any install, so the store is left untouched. The store-backed
// install (real IndexedDB) is the browser suite's.

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

function recordingDeps(revive?: ManagedExchangeRecord): ManagedImportDeps & {
  installed: Array<ManagedExchangeRecord>;
  reviveSpent: ReturnType<typeof vi.fn>;
  markImported: ReturnType<typeof vi.fn>;
} {
  const installed: Array<ManagedExchangeRecord> = [];
  return {
    installed,
    reviveSpent: vi.fn(() => Promise.resolve(revive)),
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

  test("revives a spent secret-match in place instead of installing a duplicate", async () => {
    const existing = buildManagedExchangeRecord({
      label: "Riverbend quarterly",
      exchangeFile: composeManagedExchangeFile({
        connection: { channel: "webrtc", host: "signaling.example.org" },
        linkageTerms,
      }),
      side: "inviter",
      sharedSecret: generateSharedSecret(),
    });
    const deps = recordingDeps(existing);
    const result = await importManagedExchange(goodBytes(), deps);
    // The revived record is returned; nothing fresh is installed and no separate
    // marker write runs (the revive stamped it in its own transaction).
    expect(result).toBe(existing);
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

  test("the installed record carries no input-file handle", async () => {
    const deps = recordingDeps();
    const installed = await importManagedExchange(goodBytes(), deps);
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
