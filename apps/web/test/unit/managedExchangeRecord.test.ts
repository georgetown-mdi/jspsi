import {
  connectionFromLocator,
  generateSharedSecret,
  getDefaultLinkageTerms,
} from "@psilink/core";
import { describe, expect, test } from "vitest";

import {
  MANAGED_EXCHANGE_SCHEMA_VERSION,
  MAX_LABEL_LENGTH,
  applyManagedExchangeLocalEdits,
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
  parseManagedExchangeRecord,
  safeParseManagedExchangeRecord,
} from "@psi/managedExchangeRecord";

import type {
  ManagedExchangeSchedule,
  NewManagedExchange,
} from "@psi/managedExchangeRecord";
import type { WebRTCExchangeLocator } from "@psilink/core";

const linkageTerms = getDefaultLinkageTerms("County Health Dept");

const webrtcLocator: WebRTCExchangeLocator = {
  channel: "webrtc",
  host: "signaling.example.org",
  port: 3000,
  path: "/api/",
};

function exchangeFile() {
  return composeManagedExchangeFile({
    connection: webrtcLocator,
    linkageTerms,
  });
}

function newExchange(
  overrides: Partial<NewManagedExchange> = {},
): NewManagedExchange {
  return {
    label: "Riverbend quarterly",
    exchangeFile: exchangeFile(),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
    ...overrides,
  };
}

const schedule: ManagedExchangeSchedule = {
  anchor: "2026-01-06T14:00:00.000Z",
  intervalDays: 7,
  windowSeconds: 10_800,
  nextWindow: "2026-01-13T14:00:00.000Z",
  consecutiveMisses: 0,
};

describe("composeManagedExchangeFile", () => {
  test("composes a credential-free webrtc connection block", () => {
    const file = exchangeFile();
    expect(file.connection).toEqual(connectionFromLocator(webrtcLocator));
    expect(file.connection.channel).toBe("webrtc");
    // No authentication block: the secret lives in sharedSecret, never the
    // document.
    expect(file.authentication).toBeUndefined();
  });

  test("no credential is representable in the persisted document", () => {
    const file = exchangeFile();
    const server = (file.connection as { server?: Record<string, unknown> })
      .server;
    expect(server).toBeDefined();
    // The webrtc server locator carries only host/port/path -- no PeerJS key, no
    // username, no relay credential.
    expect(Object.keys(server ?? {}).sort()).toEqual(["host", "path", "port"]);
    expect(JSON.stringify(file)).not.toContain("username");
    expect(JSON.stringify(file)).not.toContain("key");
  });

  test("rejects a locator smuggling a credential-bearing field", () => {
    const smuggled = {
      ...webrtcLocator,
      // A PeerJS API key is not on the credential-free locator allowlist; the
      // strict endpoint schema rejects it rather than stripping it.
      key: "peerjs-secret",
    } as unknown as WebRTCExchangeLocator;
    expect(() =>
      composeManagedExchangeFile({ connection: smuggled, linkageTerms }),
    ).toThrow();
  });

  test("rejects an out-of-range port", () => {
    const badPort = { ...webrtcLocator, port: 70_000 };
    expect(() =>
      composeManagedExchangeFile({ connection: badPort, linkageTerms }),
    ).toThrow();
  });
});

describe("buildManagedExchangeRecord", () => {
  test("assigns a fresh id and the v1 schemaVersion", () => {
    const record = buildManagedExchangeRecord(newExchange());
    expect(record.schemaVersion).toBe(MANAGED_EXCHANGE_SCHEMA_VERSION);
    expect(record.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    const other = buildManagedExchangeRecord(newExchange());
    expect(other.id).not.toBe(record.id);
  });

  test("round-trips through parse unchanged", () => {
    const record = buildManagedExchangeRecord(
      newExchange({
        inputFileHandle: { name: "records.csv" } as FileSystemFileHandle,
        tokenMaxAgeDays: 90,
        expires: "2026-04-06T14:00:00.000Z",
        schedule,
      }),
    );
    expect(parseManagedExchangeRecord(record)).toEqual(record);
  });

  test("the opt-in policy fields default to absent", () => {
    const record = buildManagedExchangeRecord(newExchange());
    expect(record).not.toHaveProperty("tokenMaxAgeDays");
    expect(record).not.toHaveProperty("expires");
    expect(record).not.toHaveProperty("schedule");
    expect(record).not.toHaveProperty("inputFileHandle");
    expect(record).not.toHaveProperty("lastRun");
  });

  test("enforces the label length cap at write", () => {
    const atCap = "x".repeat(MAX_LABEL_LENGTH);
    expect(() =>
      buildManagedExchangeRecord(newExchange({ label: atCap })),
    ).not.toThrow();
    const overCap = "x".repeat(MAX_LABEL_LENGTH + 1);
    expect(() =>
      buildManagedExchangeRecord(newExchange({ label: overCap })),
    ).toThrow();
  });

  test("rejects a malformed shared secret", () => {
    expect(() =>
      buildManagedExchangeRecord(newExchange({ sharedSecret: "not-a-secret" })),
    ).toThrow();
  });

  test("rejects an exchangeFile carrying an authentication block", () => {
    const withAuth = {
      ...exchangeFile(),
      authentication: { sharedSecret: generateSharedSecret() },
    };
    expect(() =>
      buildManagedExchangeRecord(newExchange({ exchangeFile: withAuth })),
    ).toThrow();
  });
});

describe("no-input-content invariant", () => {
  test("the record holds only a handle pointer, never file contents", () => {
    const handle = { name: "records.csv" } as FileSystemFileHandle;
    const record = buildManagedExchangeRecord(
      newExchange({ inputFileHandle: handle }),
    );
    expect(record.inputFileHandle).toBe(handle);
    // The record's own fields carry no row value or file content: only the
    // pointer, the terms' column shape, the connection, and the secret.
    expect(Object.keys(record).sort()).toEqual([
      "exchangeFile",
      "id",
      "inputFileHandle",
      "label",
      "schemaVersion",
      "sharedSecret",
      "side",
    ]);
  });
});

describe("parseManagedExchangeRecord reader-rejects-unknown", () => {
  test("rejects an unrecognized schemaVersion rather than migrating", () => {
    const record = buildManagedExchangeRecord(newExchange());
    const future = { ...record, schemaVersion: "psilink-managed-exchange/v2" };
    const result = safeParseManagedExchangeRecord(future);
    expect(result.success).toBe(false);
    expect(() => parseManagedExchangeRecord(future)).toThrow();
  });

  test("accepts the recognized v1 schemaVersion", () => {
    const record = buildManagedExchangeRecord(newExchange());
    expect(safeParseManagedExchangeRecord(record).success).toBe(true);
  });
});

describe("applyManagedExchangeLocalEdits", () => {
  test("edits the label in place without touching the document or secret", () => {
    const record = buildManagedExchangeRecord(newExchange());
    const edited = applyManagedExchangeLocalEdits(record, {
      label: "Riverbend monthly",
    });
    expect(edited.label).toBe("Riverbend monthly");
    expect(edited.exchangeFile).toEqual(record.exchangeFile);
    expect(edited.sharedSecret).toBe(record.sharedSecret);
    expect(edited.id).toBe(record.id);
    // The input record is not mutated.
    expect(record.label).toBe("Riverbend quarterly");
  });

  test("sets and drops the schedule and the max-age policy", () => {
    const record = buildManagedExchangeRecord(newExchange());
    const withSchedule = applyManagedExchangeLocalEdits(record, {
      schedule,
      tokenMaxAgeDays: 30,
    });
    expect(withSchedule.schedule).toEqual(schedule);
    expect(withSchedule.tokenMaxAgeDays).toBe(30);

    const dropped = applyManagedExchangeLocalEdits(withSchedule, {
      schedule: null,
      tokenMaxAgeDays: null,
    });
    expect(dropped).not.toHaveProperty("schedule");
    expect(dropped).not.toHaveProperty("tokenMaxAgeDays");
  });

  test("re-validates the label cap on edit", () => {
    const record = buildManagedExchangeRecord(newExchange());
    expect(() =>
      applyManagedExchangeLocalEdits(record, {
        label: "x".repeat(MAX_LABEL_LENGTH + 1),
      }),
    ).toThrow();
  });
});
