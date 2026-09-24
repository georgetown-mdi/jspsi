import { describe, expect, test } from "vitest";
import {
  generateSharedSecret,
  getDefaultLinkageTerms,
  parseExchangeSpec,
  parseSensitiveYaml,
} from "@alcove/core";

import {
  MANAGED_EXCHANGE_ARTIFACT_VERSION,
  NO_STANDING_CONDITION,
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
  keyFileFieldsSchema,
  runnableManagedExchangeOrRefuse,
} from "@psi/managed/managedExchangeRecord";
import {
  encodeManagedExchangeArtifact,
  importManagedExchangeArtifact,
  parseManagedExchangeArtifact,
  reconstructRecordFromArtifact,
  serializeManagedExchangeArtifact,
} from "@psi/managed/managedExchangeArtifact";

import type {
  ManagedExchangeSchedule,
  NewManagedExchange,
  RunnableManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";
import type { WebRTCExchangeLocator } from "@alcove/core";

/** A record built from `fields` and narrowed to the runnable shape: every fixture
 * here is built with a shared secret, and the export paths take the record type
 * that holds one. */
function runnableRecord(
  fields: NewManagedExchange,
): RunnableManagedExchangeRecord {
  return runnableManagedExchangeOrRefuse(buildManagedExchangeRecord(fields));
}

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
    const record = runnableRecord(
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

  test("keeps the run bookkeeping across the round trip", () => {
    const record = runnableRecord(newExchange());
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

  test("keeps a standing condition across the round trip", () => {
    // An export that dropped it would be a fourth way to clear one, and only the
    // operator's acknowledgement, a re-invite, and a delete may.
    const withCondition = {
      ...runnableRecord(newExchange()),
      standingCondition: {
        since: "2026-07-10T09:00:00.000Z",
        kind: "auth" as const,
      },
    };
    const restored = reconstructRecordFromArtifact(
      encodeManagedExchangeArtifact(withCondition),
    );
    expect(restored.standingCondition).toEqual(withCondition.standingCondition);
  });

  test("keeps the operator's answer to a condition across the round trip", () => {
    // The answer rides on the condition it answers, so an export that dropped it
    // would clear it -- and an import would then offer the fresh invitation the
    // operator withheld.
    const answered = {
      ...runnableRecord(newExchange()),
      standingCondition: {
        since: "2026-07-10T09:00:00.000Z",
        kind: "auth" as const,
        response: {
          kind: "compromise" as const,
          at: "2026-07-10T11:00:00.000Z",
        },
      },
    };
    const restored = reconstructRecordFromArtifact(
      encodeManagedExchangeArtifact(answered),
    );
    expect(restored.standingCondition).toEqual(answered.standingCondition);
  });

  test("an unknown member nested in the condition is refused, not dropped", () => {
    // This build's strict schema reaches inside the condition as well as around
    // it: an unknown member refuses the whole artifact rather than reconstructing
    // a record with the member gone.
    const artifact = JSON.parse(
      serializeManagedExchangeArtifact(
        encodeManagedExchangeArtifact(runnableRecord(newExchange())),
      ),
    ) as { local: Record<string, unknown> };
    artifact.local.standingCondition = {
      since: "2026-07-10T09:00:00.000Z",
      kind: "auth",
      settledAt: "2026-07-10T11:00:00.000Z",
    };
    expect(() =>
      importManagedExchangeArtifact(JSON.stringify(artifact)),
    ).toThrow();
  });

  test("a record with none standing round-trips to the none form", () => {
    const record = runnableRecord(newExchange());
    const artifact = encodeManagedExchangeArtifact(record);
    expect(artifact.local).not.toHaveProperty("standingCondition");
    expect(reconstructRecordFromArtifact(artifact).standingCondition).toEqual(
      NO_STANDING_CONDITION,
    );
  });

  test("serialize then importManagedExchangeArtifact round-trips from bytes", () => {
    const record = runnableRecord(newExchange());
    const bytes = serializeManagedExchangeArtifact(
      encodeManagedExchangeArtifact(record),
    );
    const { record: restored } = importManagedExchangeArtifact(bytes);
    expect(restored.sharedSecret).toBe(record.sharedSecret);
    expect(restored.exchangeFile).toEqual(record.exchangeFile);
  });

  test("a secret-only export (no expires) round-trips", () => {
    const record = runnableRecord(newExchange());
    const artifact = encodeManagedExchangeArtifact(record);
    expect(artifact.key).not.toHaveProperty("expires");
    const restored = reconstructRecordFromArtifact(artifact);
    expect(restored).not.toHaveProperty("expires");
  });
});

describe("CLI separability", () => {
  test("the embedded document parses as an exchange file", () => {
    const record = runnableRecord(
      newExchange({ expires: "2026-04-06T14:00:00.000Z" }),
    );
    const artifact = encodeManagedExchangeArtifact(record);
    // The embedded half is valid alcove.yaml text: parse it through the CLI's own
    // exchange-file parse path.
    const parsed = parseExchangeSpec(
      parseSensitiveYaml(artifact.exchangeDocument, "test"),
    );
    expect(parsed).toEqual(record.exchangeFile);
    // The document is credential-free and has no secret half.
    expect(parsed.authentication).toBeUndefined();
    expect(artifact.exchangeDocument).not.toContain(record.sharedSecret);
  });

  test("the key block is a lift-out .alcove.key: exact CLI field names, camelCase", () => {
    const record = runnableRecord(
      newExchange({ expires: "2026-04-06T14:00:00.000Z" }),
    );
    const artifact = encodeManagedExchangeArtifact(record);
    // The .alcove.key file the CLI reads is camelCase JSON (sharedSecret, expires),
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
    const record = runnableRecord(newExchange({ schedule }));
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
    const record = runnableRecord(
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

describe("the grants the source held", () => {
  test("a source holding both handles marks both, and an import reports both", () => {
    const record = runnableRecord(
      newExchange({
        inputFileHandle: { name: "records.csv" } as FileSystemFileHandle,
        outputDirectoryHandle: { name: "results" } as FileSystemDirectoryHandle,
      }),
    );
    const artifact = encodeManagedExchangeArtifact(record);
    expect(artifact.local.heldInputFile).toBe(true);
    expect(artifact.local.heldOutputFolder).toBe(true);
    // The handles themselves do not cross the bytes, so the markers are all an
    // import has to go on.
    const imported = importManagedExchangeArtifact(
      serializeManagedExchangeArtifact(artifact),
    );
    expect(imported.heldGrants).toEqual(["input-file", "output-folder"]);
    expect(imported.record).not.toHaveProperty("inputFileHandle");
    expect(imported.record).not.toHaveProperty("outputDirectoryHandle");
  });

  test("a source holding one handle marks only that one", () => {
    const record = runnableRecord(
      newExchange({
        outputDirectoryHandle: { name: "results" } as FileSystemDirectoryHandle,
      }),
    );
    const artifact = encodeManagedExchangeArtifact(record);
    expect(artifact.local).not.toHaveProperty("heldInputFile");
    expect(
      importManagedExchangeArtifact(serializeManagedExchangeArtifact(artifact))
        .heldGrants,
    ).toEqual(["output-folder"]);
  });

  test("a source holding neither writes no marker and reports none", () => {
    const artifact = encodeManagedExchangeArtifact(
      runnableRecord(newExchange()),
    );
    expect(artifact.local).not.toHaveProperty("heldInputFile");
    expect(artifact.local).not.toHaveProperty("heldOutputFolder");
    expect(
      importManagedExchangeArtifact(serializeManagedExchangeArtifact(artifact))
        .heldGrants,
    ).toEqual([]);
  });

  test("an artifact written before the markers existed reports none", () => {
    // An older backup file the operator still holds: no marker is not a claim the
    // source had nothing, so the import says nothing rather than guessing.
    const artifact = JSON.parse(
      serializeManagedExchangeArtifact(
        encodeManagedExchangeArtifact(
          runnableRecord(
            newExchange({
              inputFileHandle: { name: "records.csv" } as FileSystemFileHandle,
            }),
          ),
        ),
      ),
    );
    delete artifact.local.heldInputFile;
    expect(
      importManagedExchangeArtifact(JSON.stringify(artifact)).heldGrants,
    ).toEqual([]);
  });
});

describe("rejection of malformed or tampered imports", () => {
  function goodBytes(): string {
    return serializeManagedExchangeArtifact(
      encodeManagedExchangeArtifact(runnableRecord(newExchange())),
    );
  }

  test("non-JSON bytes are rejected", () => {
    expect(() => importManagedExchangeArtifact("not json {{{")).toThrow();
  });

  test("an unrecognized artifactVersion is rejected", () => {
    const artifact = JSON.parse(goodBytes());
    artifact.artifactVersion = "alcove-managed-exchange-backup/v4";
    expect(() =>
      parseManagedExchangeArtifact(JSON.stringify(artifact)),
    ).toThrow();
  });

  test("an artifact written under the previous version is refused whole", () => {
    // A v2 file predates the operator's answer to a standing condition. The
    // version is what this build reads it on, so an older file is refused entire
    // rather than imported as a record, exactly as an older stored record is.
    const artifact = JSON.parse(goodBytes());
    artifact.artifactVersion = "alcove-managed-exchange-backup/v2";
    expect(() =>
      importManagedExchangeArtifact(JSON.stringify(artifact)),
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

  test("a document tampered to hold an authentication block is rejected", () => {
    const artifact = JSON.parse(goodBytes());
    // Smuggle a secret into the embedded document: the reconstructed record must
    // reject it (the document has no authentication block).
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
