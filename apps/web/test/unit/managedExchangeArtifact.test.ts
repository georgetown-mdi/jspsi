import { describe, expect, test } from "vitest";
import {
  generateSharedSecret,
  getDefaultLinkageTerms,
  parseExchangeSpec,
  parseSensitiveYaml,
} from "@psilink/core";

import {
  MANAGED_EXCHANGE_ARTIFACT_VERSION,
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
  keyFileFieldsSchema,
} from "@psi/managedExchangeRecord";
import {
  encodeManagedExchangeArtifact,
  importManagedExchangeArtifact,
  parseManagedExchangeArtifact,
  reconstructRecordFromArtifact,
  serializeManagedExchangeArtifact,
} from "@psi/managedExchangeArtifact";

import type {
  ManagedExchangeSchedule,
  NewManagedExchange,
} from "@psi/managedExchangeRecord";
import type { WebRTCExchangeLocator } from "@psilink/core";

// The export/import artifact, tested in Node without a store: the round-trip
// restores a runnable record minus the handle, the artifact's two halves satisfy
// the CLI's exchange-file and key-file shapes, and a malformed or tampered file is
// rejected without a record ever being reconstructed.

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
  consecutiveMisses: 0,
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

describe("export/import round-trip", () => {
  test("restores a runnable record (fresh id, no handle, fields preserved)", () => {
    const record = buildManagedExchangeRecord(
      newExchange({
        inputFileHandle: { name: "records.csv" } as FileSystemFileHandle,
        tokenMaxAgeDays: 90,
        expires: "2026-04-06T14:00:00.000Z",
        schedule,
      }),
    );
    const restored = reconstructRecordFromArtifact(
      encodeManagedExchangeArtifact(record),
    );

    // A take-over mints a fresh id, never a copy of the source's.
    expect(restored.id).not.toBe(record.id);
    // The handle does not serialize: an imported record re-acquires one by
    // selection.
    expect(restored).not.toHaveProperty("inputFileHandle");
    // Everything else round-trips.
    expect(restored.label).toBe(record.label);
    expect(restored.side).toBe(record.side);
    expect(restored.sharedSecret).toBe(record.sharedSecret);
    expect(restored.expires).toBe(record.expires);
    expect(restored.tokenMaxAgeDays).toBe(90);
    expect(restored.schedule).toEqual(schedule);
    expect(restored.exchangeFile).toEqual(record.exchangeFile);
  });

  test("carries the run bookkeeping forward", () => {
    const record = buildManagedExchangeRecord(newExchange());
    const withRun = {
      ...record,
      lastRun: {
        at: "2026-07-10T09:00:00.000Z",
        outcome: "succeeded" as const,
      },
    };
    const restored = reconstructRecordFromArtifact(
      encodeManagedExchangeArtifact(withRun),
    );
    expect(restored.lastRun).toEqual(withRun.lastRun);
  });

  test("serialize then importManagedExchangeArtifact round-trips from bytes", () => {
    const record = buildManagedExchangeRecord(newExchange());
    const bytes = serializeManagedExchangeArtifact(
      encodeManagedExchangeArtifact(record),
    );
    const restored = importManagedExchangeArtifact(bytes);
    expect(restored.sharedSecret).toBe(record.sharedSecret);
    expect(restored.exchangeFile).toEqual(record.exchangeFile);
  });

  test("a secret-only export (no expires) round-trips", () => {
    const record = buildManagedExchangeRecord(newExchange());
    const artifact = encodeManagedExchangeArtifact(record);
    expect(artifact.key).not.toHaveProperty("expires");
    const restored = reconstructRecordFromArtifact(artifact);
    expect(restored).not.toHaveProperty("expires");
  });
});

describe("CLI separability", () => {
  test("the embedded document parses as an exchange file", () => {
    const record = buildManagedExchangeRecord(
      newExchange({ expires: "2026-04-06T14:00:00.000Z" }),
    );
    const artifact = encodeManagedExchangeArtifact(record);
    // The embedded half is valid psilink.yaml text: parse it through the CLI's own
    // exchange-file parse path.
    const parsed = parseExchangeSpec(
      parseSensitiveYaml(artifact.exchangeDocument, "test"),
    );
    expect(parsed).toEqual(record.exchangeFile);
    // The document is credential-free and carries no secret half.
    expect(parsed.authentication).toBeUndefined();
    expect(artifact.exchangeDocument).not.toContain(record.sharedSecret);
  });

  test("the key block is a lift-out .psilink.key: exact CLI field names, camelCase", () => {
    const record = buildManagedExchangeRecord(
      newExchange({ expires: "2026-04-06T14:00:00.000Z" }),
    );
    const artifact = encodeManagedExchangeArtifact(record);
    // The .psilink.key file the CLI reads is camelCase JSON (sharedSecret, expires),
    // parsed without a snake_case conversion, so the key block's JSON keys must be
    // exactly those names -- the block lifts out verbatim into a valid key file with
    // no renaming. Pin the literal key names, not just the values.
    expect(Object.keys(artifact.key).sort()).toEqual([
      "expires",
      "sharedSecret",
    ]);
    expect(artifact.key).not.toHaveProperty("shared_secret");
    // And it validates against the shared key-file shape (keyFileFieldsSchema is the
    // one the CLI's key file and this artifact both use).
    const key = keyFileFieldsSchema.parse(artifact.key);
    expect(key.sharedSecret).toBe(record.sharedSecret);
    expect(key.expires).toBe(record.expires);
  });

  test("a tampered schedule with intervalDays: 0 is rejected (artifact no laxer than record)", () => {
    const record = buildManagedExchangeRecord(newExchange({ schedule }));
    const bytes = serializeManagedExchangeArtifact(
      encodeManagedExchangeArtifact(record),
    );
    const artifact = JSON.parse(bytes);
    artifact.local.schedule.intervalDays = 0;
    // The artifact schema reuses the canonical schedule schema (min bounds), so a
    // zero interval is rejected at the artifact parse, not merely at reconstruction.
    expect(() =>
      parseManagedExchangeArtifact(JSON.stringify(artifact)),
    ).toThrow();
  });

  test("the local fields are cleanly separated into their own block", () => {
    const record = buildManagedExchangeRecord(
      newExchange({ tokenMaxAgeDays: 90, schedule }),
    );
    const artifact = encodeManagedExchangeArtifact(record);
    // The local fields the CLI ignores live in one block, apart from the two CLI
    // halves.
    expect(Object.keys(artifact.local).sort()).toEqual([
      "label",
      "schedule",
      "side",
      "tokenMaxAgeDays",
    ]);
    expect(artifact.artifactVersion).toBe(MANAGED_EXCHANGE_ARTIFACT_VERSION);
  });
});

describe("rejection of malformed or tampered imports", () => {
  function goodBytes(): string {
    return serializeManagedExchangeArtifact(
      encodeManagedExchangeArtifact(buildManagedExchangeRecord(newExchange())),
    );
  }

  test("non-JSON bytes are rejected", () => {
    expect(() => importManagedExchangeArtifact("not json {{{")).toThrow();
  });

  test("an unrecognized artifactVersion is rejected", () => {
    const artifact = JSON.parse(goodBytes());
    artifact.artifactVersion = "psilink-managed-exchange-backup/v2";
    expect(() =>
      parseManagedExchangeArtifact(JSON.stringify(artifact)),
    ).toThrow();
  });

  test("an unknown top-level key is rejected (reader-rejects-unknown)", () => {
    const artifact = JSON.parse(goodBytes());
    artifact.smuggled = "extra";
    expect(() =>
      parseManagedExchangeArtifact(JSON.stringify(artifact)),
    ).toThrow();
  });

  test("a tampered (malformed) shared secret is rejected", () => {
    const artifact = JSON.parse(goodBytes());
    artifact.key.sharedSecret = "not-a-secret";
    expect(() =>
      parseManagedExchangeArtifact(JSON.stringify(artifact)),
    ).toThrow();
  });

  test("a document tampered to carry an authentication block is rejected", () => {
    const artifact = JSON.parse(goodBytes());
    // Smuggle a secret into the embedded document: the reconstructed record must
    // reject it (the document carries no authentication block).
    artifact.exchangeDocument = `${artifact.exchangeDocument}\nauthentication:\n  shared_secret: ${generateSharedSecret()}\n`;
    expect(() =>
      reconstructRecordFromArtifact(
        parseManagedExchangeArtifact(JSON.stringify(artifact)),
      ),
    ).toThrow();
  });

  test("a non-parseable embedded document is rejected", () => {
    const artifact = JSON.parse(goodBytes());
    artifact.exchangeDocument = "key: : : not yaml";
    const parsed = parseManagedExchangeArtifact(JSON.stringify(artifact));
    expect(() => reconstructRecordFromArtifact(parsed)).toThrow();
  });

  test("a missing key block is rejected", () => {
    const artifact = JSON.parse(goodBytes());
    delete artifact.key;
    expect(() =>
      parseManagedExchangeArtifact(JSON.stringify(artifact)),
    ).toThrow();
  });
});
