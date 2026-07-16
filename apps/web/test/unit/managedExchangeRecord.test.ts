import {
  connectionFromLocator,
  generateSharedSecret,
  getDefaultLinkageTerms,
} from "@psilink/core";
import { describe, expect, test } from "vitest";

import {
  MANAGED_EXCHANGE_SCHEMA_VERSION,
  MAX_LABEL_LENGTH,
  applyManagedExchangeInputHandle,
  applyManagedExchangeLastRun,
  applyManagedExchangeLocalEdits,
  applyManagedExchangeReinviteRotation,
  applyManagedExchangeRotation,
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
  diagnoseManagedExchangeRecord,
  parseManagedExchangeRecord,
  safeParseManagedExchangeRecord,
} from "@psi/managedExchangeRecord";

import type {
  ManagedExchangeLastRun,
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

  test("an edit that does not touch the policy leaves expires untouched", () => {
    const record = buildManagedExchangeRecord(
      newExchange({ tokenMaxAgeDays: 90, expires: "2026-04-06T14:00:00.000Z" }),
    );
    const edited = applyManagedExchangeLocalEdits(record, {
      label: "Riverbend monthly",
    });
    expect(edited.expires).toBe("2026-04-06T14:00:00.000Z");
    expect(edited.tokenMaxAgeDays).toBe(90);
  });

  // The security corner: editing the max-token-age policy re-derives `expires`
  // conservatively -- an edit never pushes the bound later than the anchor
  // derivation (docs/spec/MANAGED_EXCHANGE_RECORD.md, the `expires` row). The four
  // cases are pinned here at the edit boundary; the pure derivation is unit-tested
  // in managedTokenAgeEdit.test.ts.
  const MS_PER_DAY = 86_400_000;
  const anchor = Date.parse("2026-01-01T00:00:00.000Z");
  const expires90 = new Date(anchor + 90 * MS_PER_DAY).toISOString();
  const editNow = anchor + 200 * MS_PER_DAY;

  test("shortening the policy recomputes expires earlier from the anchor", () => {
    const record = buildManagedExchangeRecord(
      newExchange({ tokenMaxAgeDays: 90, expires: expires90 }),
    );
    const edited = applyManagedExchangeLocalEdits(
      record,
      { tokenMaxAgeDays: 30 },
      editNow,
    );
    expect(edited.tokenMaxAgeDays).toBe(30);
    expect(edited.expires).toBe(
      new Date(anchor + 30 * MS_PER_DAY).toISOString(),
    );
    expect(Date.parse(edited.expires as string)).toBeLessThan(
      Date.parse(expires90),
    );
  });

  test("lengthening the policy keeps the current bound (no extension without a rotation)", () => {
    const record = buildManagedExchangeRecord(
      newExchange({ tokenMaxAgeDays: 90, expires: expires90 }),
    );
    const edited = applyManagedExchangeLocalEdits(
      record,
      { tokenMaxAgeDays: 365 },
      editNow,
    );
    expect(edited.tokenMaxAgeDays).toBe(365);
    expect(edited.expires).toBe(expires90);
  });

  test("adding a policy where none existed stamps now + days", () => {
    const record = buildManagedExchangeRecord(newExchange());
    expect(record).not.toHaveProperty("expires");
    const edited = applyManagedExchangeLocalEdits(
      record,
      { tokenMaxAgeDays: 30 },
      editNow,
    );
    expect(edited.tokenMaxAgeDays).toBe(30);
    expect(edited.expires).toBe(
      new Date(editNow + 30 * MS_PER_DAY).toISOString(),
    );
  });

  test("clearing the policy drops both the policy and the bound", () => {
    const record = buildManagedExchangeRecord(
      newExchange({ tokenMaxAgeDays: 90, expires: expires90 }),
    );
    const edited = applyManagedExchangeLocalEdits(
      record,
      { tokenMaxAgeDays: null },
      editNow,
    );
    expect(edited).not.toHaveProperty("tokenMaxAgeDays");
    expect(edited).not.toHaveProperty("expires");
  });
});

describe("applyManagedExchangeRotation", () => {
  test("a string expires sets the bound; the secret advances", () => {
    const record = buildManagedExchangeRecord(newExchange());
    const rotatedSecret = generateSharedSecret();
    const rotated = applyManagedExchangeRotation(record, {
      sharedSecret: rotatedSecret,
      expires: "2026-10-06T14:00:00.000Z",
    });
    expect(rotated.sharedSecret).toBe(rotatedSecret);
    expect(rotated.expires).toBe("2026-10-06T14:00:00.000Z");
  });

  test("a null expires deletes the key, not merely sets it undefined", () => {
    const record = buildManagedExchangeRecord(
      newExchange({ expires: "2026-04-06T14:00:00.000Z" }),
    );
    const rotated = applyManagedExchangeRotation(record, {
      sharedSecret: generateSharedSecret(),
      expires: null,
    });
    expect(rotated).not.toHaveProperty("expires");
  });

  test("touches only the rotation fields; everything else survives", () => {
    const record = buildManagedExchangeRecord(
      newExchange({ tokenMaxAgeDays: 90, schedule }),
    );
    const rotated = applyManagedExchangeRotation(record, {
      sharedSecret: generateSharedSecret(),
      expires: null,
    });
    expect(rotated.id).toBe(record.id);
    expect(rotated.label).toBe(record.label);
    expect(rotated.exchangeFile).toEqual(record.exchangeFile);
    expect(rotated.side).toBe(record.side);
    expect(rotated.tokenMaxAgeDays).toBe(90);
    expect(rotated.schedule).toEqual(schedule);
  });

  test("rejects a malformed rotated secret at this pure layer", () => {
    const record = buildManagedExchangeRecord(newExchange());
    expect(() =>
      applyManagedExchangeRotation(record, {
        sharedSecret: "not-a-secret",
        expires: null,
      }),
    ).toThrow();
  });

  test("does not mutate the input record", () => {
    const record = buildManagedExchangeRecord(
      newExchange({ expires: "2026-04-06T14:00:00.000Z" }),
    );
    const originalSecret = record.sharedSecret;
    applyManagedExchangeRotation(record, {
      sharedSecret: generateSharedSecret(),
      expires: null,
    });
    expect(record.sharedSecret).toBe(originalSecret);
    expect(record.expires).toBe("2026-04-06T14:00:00.000Z");
  });
});

describe("applyManagedExchangeReinviteRotation", () => {
  const authFailure: ManagedExchangeLastRun = {
    at: "2026-07-14T09:00:00.000Z",
    outcome: "failed",
    failureKind: "auth",
  };

  test("rotates the secret AND drops the consumed lastRun", () => {
    const record = buildManagedExchangeRecord(
      newExchange({ lastRun: authFailure }),
    );
    const rotatedSecret = generateSharedSecret();
    const rotated = applyManagedExchangeReinviteRotation(record, {
      sharedSecret: rotatedSecret,
      expires: null,
    });
    expect(rotated.sharedSecret).toBe(rotatedSecret);
    // The failure the re-invite recovers from must not re-derive at the next visit.
    expect(rotated).not.toHaveProperty("lastRun");
  });

  test("clears lastRun even when there was none (a no-op drop)", () => {
    const record = buildManagedExchangeRecord(newExchange());
    const rotated = applyManagedExchangeReinviteRotation(record, {
      sharedSecret: generateSharedSecret(),
      expires: null,
    });
    expect(rotated).not.toHaveProperty("lastRun");
  });

  test("restamps expires from the rotation and touches nothing else", () => {
    const record = buildManagedExchangeRecord(
      newExchange({ tokenMaxAgeDays: 90, schedule, lastRun: authFailure }),
    );
    const rotated = applyManagedExchangeReinviteRotation(record, {
      sharedSecret: generateSharedSecret(),
      expires: "2026-10-06T14:00:00.000Z",
    });
    expect(rotated.expires).toBe("2026-10-06T14:00:00.000Z");
    expect(rotated.exchangeFile).toEqual(record.exchangeFile);
    expect(rotated.tokenMaxAgeDays).toBe(90);
    expect(rotated.schedule).toEqual(schedule);
  });

  test("does not mutate the input record", () => {
    const record = buildManagedExchangeRecord(
      newExchange({ lastRun: authFailure }),
    );
    applyManagedExchangeReinviteRotation(record, {
      sharedSecret: generateSharedSecret(),
      expires: null,
    });
    expect(record.lastRun).toEqual(authFailure);
  });
});

describe("applyManagedExchangeInputHandle", () => {
  // A FileSystemFileHandle is an opaque platform object the schema carries through
  // as an optional unknown (no runtime shape assertion; see the schema note), so a
  // stand-in object exercises the set path in Node -- the real handle's structured-
  // clone round-trip is the browser suite's.
  const fakeHandle = { kind: "file", name: "input.csv" } as unknown as never;

  test("sets the handle, touching nothing else", () => {
    const record = buildManagedExchangeRecord(
      newExchange({ tokenMaxAgeDays: 90, schedule }),
    );
    const pointed = applyManagedExchangeInputHandle(record, fakeHandle);
    expect(pointed.inputFileHandle).toBe(fakeHandle);
    expect(pointed.sharedSecret).toBe(record.sharedSecret);
    expect(pointed.exchangeFile).toEqual(record.exchangeFile);
    expect(pointed.label).toBe(record.label);
    expect(pointed.schedule).toEqual(schedule);
  });

  test("re-points to a replacement handle", () => {
    const record = applyManagedExchangeInputHandle(
      buildManagedExchangeRecord(newExchange()),
      fakeHandle,
    );
    const other = { kind: "file", name: "other.csv" } as unknown as never;
    expect(applyManagedExchangeInputHandle(record, other).inputFileHandle).toBe(
      other,
    );
  });

  test("a null drops the handle, deleting the key", () => {
    const record = applyManagedExchangeInputHandle(
      buildManagedExchangeRecord(newExchange()),
      fakeHandle,
    );
    const dropped = applyManagedExchangeInputHandle(record, null);
    expect(dropped).not.toHaveProperty("inputFileHandle");
  });

  test("does not mutate the input record", () => {
    const record = buildManagedExchangeRecord(newExchange());
    applyManagedExchangeInputHandle(record, fakeHandle);
    expect(record.inputFileHandle).toBeUndefined();
  });
});

describe("applyManagedExchangeLastRun", () => {
  const olderRun: ManagedExchangeLastRun = {
    at: "2026-07-14T12:00:00.000Z",
    outcome: "succeeded",
  };
  const newerRun: ManagedExchangeLastRun = {
    at: "2026-07-14T13:00:00.000Z",
    outcome: "failed",
    failureKind: "storage",
  };

  test("records an outcome, leaving the secret and document untouched", () => {
    const record = buildManagedExchangeRecord(newExchange());
    const updated = applyManagedExchangeLastRun(record, olderRun);
    expect(updated.lastRun).toEqual(olderRun);
    expect(updated.sharedSecret).toBe(record.sharedSecret);
    expect(updated.exchangeFile).toEqual(record.exchangeFile);
    // The input record is not mutated.
    expect(record).not.toHaveProperty("lastRun");
  });

  test("a newer entry overwrites an older stored one", () => {
    const record = applyManagedExchangeLastRun(
      buildManagedExchangeRecord(newExchange()),
      olderRun,
    );
    expect(applyManagedExchangeLastRun(record, newerRun).lastRun).toEqual(
      newerRun,
    );
  });

  test("an entry staler than the stored one is a no-op", () => {
    const record = applyManagedExchangeLastRun(
      buildManagedExchangeRecord(newExchange()),
      newerRun,
    );
    const applied = applyManagedExchangeLastRun(record, olderRun);
    expect(applied.lastRun).toEqual(newerRun);
  });

  test("an entry with the same instant overwrites (only strictly-staler no-ops)", () => {
    const record = applyManagedExchangeLastRun(
      buildManagedExchangeRecord(newExchange()),
      olderRun,
    );
    const sameInstant: ManagedExchangeLastRun = {
      at: olderRun.at,
      outcome: "missed",
    };
    expect(applyManagedExchangeLastRun(record, sameInstant).lastRun).toEqual(
      sameInstant,
    );
  });

  test("staleness compares instants, not strings, across ISO precisions", () => {
    // A whole-second ISO stamp sorts lexicographically AFTER a fractional stamp
    // of a later instant ("...00Z" > "...00.500Z" as strings); the guard must
    // still treat it as the older instant and keep the newer entry.
    const fractionalNewer: ManagedExchangeLastRun = {
      at: "2026-07-14T12:00:00.500Z",
      outcome: "failed",
      failureKind: "storage",
    };
    const wholeSecondOlder: ManagedExchangeLastRun = {
      at: "2026-07-14T12:00:00Z",
      outcome: "succeeded",
    };
    const record = applyManagedExchangeLastRun(
      buildManagedExchangeRecord(newExchange()),
      fractionalNewer,
    );
    expect(
      applyManagedExchangeLastRun(record, wholeSecondOlder).lastRun,
    ).toEqual(fractionalNewer);
  });
});

describe("diagnoseManagedExchangeRecord", () => {
  test("returns only the display essentials -- id, label, side, and last-run date", () => {
    const record = buildManagedExchangeRecord(
      newExchange({ label: "Riverbend quarterly", side: "acceptor" }),
    );
    const withRun = applyManagedExchangeLastRun(record, {
      at: "2026-07-10T09:00:00.000Z",
      outcome: "succeeded",
    });
    expect(diagnoseManagedExchangeRecord(withRun)).toEqual({
      id: withRun.id,
      label: "Riverbend quarterly",
      side: "acceptor",
      lastRunAt: "2026-07-10T09:00:00.000Z",
    });
  });

  test("omits the last-run date for a never-run record", () => {
    const record = buildManagedExchangeRecord(newExchange());
    expect(diagnoseManagedExchangeRecord(record).lastRunAt).toBeUndefined();
  });

  test("never surfaces the secret or the document", () => {
    const record = buildManagedExchangeRecord(newExchange());
    const essentials = diagnoseManagedExchangeRecord(record);
    // The essentials object is display-only: the secret, the document, and the
    // handle must not be reachable through it.
    expect(Object.keys(essentials).sort()).toEqual(["id", "label", "side"]);
    expect(JSON.stringify(essentials)).not.toContain(record.sharedSecret);
  });

  test("throws on a value the strict read would reject", () => {
    const record = buildManagedExchangeRecord(newExchange());
    expect(() =>
      diagnoseManagedExchangeRecord({
        ...record,
        schemaVersion: "psilink-managed-exchange/v2",
      }),
    ).toThrow();
  });
});
