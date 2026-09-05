import {
  DEFAULT_LINKAGE_KEY_SET_NAME,
  connectionFromLocator,
  generateSharedSecret,
  getDefaultLinkageTerms,
} from "@psilink/core";
import { describe, expect, test } from "vitest";

import {
  MANAGED_EXCHANGE_SCHEMA_VERSION,
  MAX_LABEL_LENGTH,
  MAX_SCHEDULE_INTERVAL_DAYS,
  applyManagedExchangeInputHandle,
  applyManagedExchangeLastRun,
  applyManagedExchangeLocalEdits,
  applyManagedExchangeReinviteRotation,
  applyManagedExchangeRotation,
  applyManagedExchangeScheduleAdvance,
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
  diagnoseManagedExchangeRecord,
  parseManagedExchangeRecord,
  partitionReadableManagedExchanges,
  safeParseManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";
import { withTimeZone } from "../utils/hostTimeZone";

import type {
  ManagedExchangeLastRun,
  ManagedExchangeRecord,
  ManagedExchangeSchedule,
  NewManagedExchange,
} from "@psi/managed/managedExchangeRecord";
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
    // The webrtc server locator has only host/port/path -- no PeerJS key, no
    // username, no relay credential.
    expect(Object.keys(server ?? {}).sort()).toEqual(["host", "path", "port"]);
    // Scanned as bare substrings, so a credential held as a VALUE (a PeerJS API
    // key, an SSH username) is caught wherever in the document it sits, not just a
    // property named for one. The two strings the linkage terms' rule-set citation
    // legitimately spells "key" in -- the `keySet` property and the key set's own
    // name -- are excised by their exact text first, so the scan keeps its reach
    // without treating the citation as a credential.
    const serialized = JSON.stringify(file);
    expect(serialized).toContain('"keySet"');
    expect(serialized).toContain(DEFAULT_LINKAGE_KEY_SET_NAME);
    const withoutCitation = serialized
      .replaceAll('"keySet"', "")
      .replaceAll(DEFAULT_LINKAGE_KEY_SET_NAME, "");
    expect(withoutCitation).not.toContain("username");
    expect(withoutCitation).not.toContain("key");
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

  test("rejects an exchangeFile holding an authentication block", () => {
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
    // The record's own fields hold no row value or file content: only the
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

  test("reads back every recorded failure kind, the terms shortfall included", () => {
    const kinds: Array<ManagedExchangeLastRun["failureKind"]> = [
      "auth",
      "transport",
      "storage",
      "custody-unreadable",
      "input",
      "terms-shortfall",
      "consent",
      "handed-off",
      "cancelled",
    ];
    for (const failureKind of kinds) {
      const record = buildManagedExchangeRecord(
        newExchange({
          lastRun: {
            at: "2026-07-14T09:00:00.000Z",
            outcome: "failed",
            failureKind,
          },
        }),
      );
      expect(parseManagedExchangeRecord(record).lastRun?.failureKind).toBe(
        failureKind,
      );
    }
  });

  test("a record written before a kind existed still reads unchanged", () => {
    // Widening the enum only adds members, so a stored entry an earlier build
    // wrote -- a linkage shortfall recorded as "input" -- loads and reads as it did.
    const legacy = {
      ...buildManagedExchangeRecord(newExchange()),
      lastRun: {
        at: "2026-07-14T09:00:00.000Z",
        outcome: "failed",
        failureKind: "input",
      },
    };
    expect(parseManagedExchangeRecord(legacy).lastRun).toEqual(legacy.lastRun);
  });

  test("rejects a failure kind it does not recognize rather than dropping it", () => {
    // The reader-rejects-unknown rule's converse: a kind a later build added is
    // refused whole and loudly, never read with the kind silently absent.
    const future = {
      ...buildManagedExchangeRecord(newExchange()),
      lastRun: {
        at: "2026-07-14T09:00:00.000Z",
        outcome: "failed",
        failureKind: "kind-from-a-later-build",
      },
    };
    expect(safeParseManagedExchangeRecord(future).success).toBe(false);
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
  // A FileSystemFileHandle is an opaque platform object the schema holds as an
  // optional unknown (no runtime shape assertion; see the schema note), so a
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

describe("applyManagedExchangeScheduleAdvance", () => {
  const advancedSchedule: ManagedExchangeSchedule = {
    ...schedule,
    nextWindow: "2026-01-20T14:00:00.000Z",
    consecutiveMisses: 1,
  };
  const missedRun: ManagedExchangeLastRun = {
    at: "2026-01-13T17:00:00.000Z",
    outcome: "missed",
  };

  function scheduled(): ManagedExchangeRecord {
    return buildManagedExchangeRecord(newExchange({ schedule }));
  }

  test("moves the planned window, the count, and the outcome together", () => {
    const record = scheduled();
    const advanced = applyManagedExchangeScheduleAdvance(record, {
      schedule: advancedSchedule,
      fromNextWindow: schedule.nextWindow,
      fromConsecutiveMisses: schedule.consecutiveMisses,
      lastRun: missedRun,
    });
    expect(advanced.schedule).toEqual(advancedSchedule);
    expect(advanced.lastRun).toEqual(missedRun);
    expect(advanced.sharedSecret).toBe(record.sharedSecret);
    expect(advanced.exchangeFile).toEqual(record.exchangeFile);
    // The input record is not mutated.
    expect(record.schedule).toEqual(schedule);
  });

  test("advances the schedule alone when the window produced no bookkeeping", () => {
    const advanced = applyManagedExchangeScheduleAdvance(scheduled(), {
      schedule: advancedSchedule,
      fromNextWindow: schedule.nextWindow,
      fromConsecutiveMisses: schedule.consecutiveMisses,
    });
    expect(advanced.schedule).toEqual(advancedSchedule);
    expect(advanced).not.toHaveProperty("lastRun");
  });

  test("a record whose schedule was dropped is left entirely unchanged", () => {
    // The operator reverted the exchange to attended-only from another tab while
    // the window ran; the advance must not resurrect the schedule.
    const record = buildManagedExchangeRecord(newExchange());
    const advanced = applyManagedExchangeScheduleAdvance(record, {
      schedule: advancedSchedule,
      fromNextWindow: schedule.nextWindow,
      fromConsecutiveMisses: schedule.consecutiveMisses,
      lastRun: missedRun,
    });
    expect(advanced).not.toHaveProperty("schedule");
    expect(advanced).not.toHaveProperty("lastRun");
  });

  test("a cadence the operator re-entered is not overwritten", () => {
    const record = buildManagedExchangeRecord(
      newExchange({ schedule: { ...schedule, intervalDays: 14 } }),
    );
    const advanced = applyManagedExchangeScheduleAdvance(record, {
      schedule: advancedSchedule,
      fromNextWindow: schedule.nextWindow,
      fromConsecutiveMisses: schedule.consecutiveMisses,
      lastRun: missedRun,
    });
    // The planned window the advance holds was derived from the replaced
    // cadence, so neither half of it lands.
    expect(advanced.schedule).toEqual({ ...schedule, intervalDays: 14 });
    expect(advanced).not.toHaveProperty("lastRun");
  });

  test("an anchor or width change also holds the advance off", () => {
    for (const stored of [
      { ...schedule, anchor: "2026-01-07T14:00:00.000Z" },
      { ...schedule, windowSeconds: 7200 },
    ]) {
      const advanced = applyManagedExchangeScheduleAdvance(
        buildManagedExchangeRecord(newExchange({ schedule: stored })),
        {
          schedule: advancedSchedule,
          fromNextWindow: schedule.nextWindow,
          fromConsecutiveMisses: schedule.consecutiveMisses,
          lastRun: missedRun,
        },
      );
      expect(advanced.schedule).toEqual(stored);
      expect(advanced).not.toHaveProperty("lastRun");
    }
  });

  test("an advance behind a newer one cannot rewind the plan or the count", () => {
    // Two wakes' bookkeeping tails are no more serialized than two runs': the
    // earlier wake's write can land after the newer one's, where an
    // unconditioned write would rewind the plan and drop the count back to the
    // one miss the newer advance had already moved past.
    const newer = applyManagedExchangeScheduleAdvance(scheduled(), {
      schedule: {
        ...schedule,
        nextWindow: "2026-01-27T14:00:00.000Z",
        consecutiveMisses: 2,
      },
      fromNextWindow: schedule.nextWindow,
      fromConsecutiveMisses: schedule.consecutiveMisses,
    });
    const applied = applyManagedExchangeScheduleAdvance(newer, {
      schedule: advancedSchedule,
      fromNextWindow: schedule.nextWindow,
      fromConsecutiveMisses: schedule.consecutiveMisses,
      lastRun: missedRun,
    });
    expect(applied.schedule).toEqual({
      ...schedule,
      nextWindow: "2026-01-27T14:00:00.000Z",
      consecutiveMisses: 2,
    });
    expect(applied).not.toHaveProperty("lastRun");
  });

  test("a re-plan on the same cadence is not clobbered by a running window", () => {
    // The operator re-planned the next attempt (and cleared the count) from
    // another tab while the window ran. The cadence still matches, so only the
    // planned window the advance was computed from tells the two apart.
    const replanned = {
      ...schedule,
      nextWindow: "2026-02-03T14:00:00.000Z",
      consecutiveMisses: 0,
    };
    const record = applyManagedExchangeLocalEdits(scheduled(), {
      schedule: replanned,
    });
    const advanced = applyManagedExchangeScheduleAdvance(record, {
      schedule: advancedSchedule,
      fromNextWindow: schedule.nextWindow,
      fromConsecutiveMisses: schedule.consecutiveMisses,
      lastRun: missedRun,
    });
    expect(advanced.schedule).toEqual(replanned);
    expect(advanced).not.toHaveProperty("lastRun");
  });

  test("a count the operator cleared is not restored by a wake that read it", () => {
    // The wake read a count of 3 and computed a fourth miss; the operator
    // cleared the count from another tab while the window ran, leaving the plan
    // itself untouched, so the count alone tells the stale advance from a live
    // one -- and the count is what the two-miss escalation reads.
    const counted = { ...schedule, consecutiveMisses: 3 };
    const cleared = { ...schedule, consecutiveMisses: 0 };
    const record = applyManagedExchangeLocalEdits(
      buildManagedExchangeRecord(newExchange({ schedule: counted })),
      { schedule: cleared },
    );
    const advanced = applyManagedExchangeScheduleAdvance(record, {
      schedule: { ...advancedSchedule, consecutiveMisses: 4 },
      fromNextWindow: schedule.nextWindow,
      fromConsecutiveMisses: counted.consecutiveMisses,
      lastRun: missedRun,
    });
    expect(advanced.schedule).toEqual(cleared);
    expect(advanced).not.toHaveProperty("lastRun");
  });

  test("the plan is matched as an instant, not a string, across ISO precisions", () => {
    // The same moments, stored whole-second and held fractional: a string
    // comparison would treat them as a different cadence and a different plan.
    const record = buildManagedExchangeRecord(
      newExchange({
        schedule: {
          ...schedule,
          anchor: "2026-01-06T14:00:00Z",
          nextWindow: "2026-01-13T14:00:00Z",
        },
      }),
    );
    const advanced = applyManagedExchangeScheduleAdvance(record, {
      schedule: advancedSchedule,
      fromNextWindow: schedule.nextWindow,
      fromConsecutiveMisses: schedule.consecutiveMisses,
      lastRun: missedRun,
    });
    expect(advanced.schedule).toEqual(advancedSchedule);
    expect(advanced.lastRun).toEqual(missedRun);
  });

  test("a plan the guard cannot read matches nothing and writes nothing", () => {
    // Unreadable either way: no instant at all, and one whose wall clock has no
    // designator to read it against (which would otherwise match or not by the
    // host's zone).
    for (const fromNextWindow of ["soon", "2026-01-13T14:00:00"]) {
      const advanced = applyManagedExchangeScheduleAdvance(scheduled(), {
        schedule: advancedSchedule,
        fromNextWindow,
        fromConsecutiveMisses: schedule.consecutiveMisses,
        lastRun: missedRun,
      });
      expect(advanced.schedule).toEqual(schedule);
      expect(advanced).not.toHaveProperty("lastRun");
    }
  });

  test("a stale outcome is dropped while the schedule still advances", () => {
    // A run that landed after the window closed already recorded the newer
    // outcome; the window's own miss must not mask it, but the window did close.
    const record = applyManagedExchangeLastRun(scheduled(), {
      at: "2026-01-13T18:00:00.000Z",
      outcome: "succeeded",
    });
    const advanced = applyManagedExchangeScheduleAdvance(record, {
      schedule: advancedSchedule,
      fromNextWindow: schedule.nextWindow,
      fromConsecutiveMisses: schedule.consecutiveMisses,
      lastRun: missedRun,
    });
    expect(advanced.schedule).toEqual(advancedSchedule);
    expect(advanced.lastRun).toEqual({
      at: "2026-01-13T18:00:00.000Z",
      outcome: "succeeded",
    });
  });

  test("a stored stamp with no UTC designator compares as no run, not host-local", () => {
    const offsetless = "2026-01-13T18:00:00";
    const moments = ["UTC", "America/New_York"].map((zone) =>
      withTimeZone(zone, () => Date.parse(offsetless)),
    );
    // The stamp really is host-sensitive, so nothing below passes vacuously:
    // read against the host zone it names a different moment per machine, and
    // either reading would rank it newer than the window's own entry and
    // suppress it.
    expect(moments[0]).not.toBe(moments[1]);
    expect(moments[0]).toBeGreaterThan(Date.parse(missedRun.at));
    expect(moments[1]).toBeGreaterThan(Date.parse(missedRun.at));

    // A record only a hand edit or a tampered artifact produces: the schema
    // admits no such stamp, and the monotonicity guard must not be the one place
    // that reads it against whatever zone the browser runs in.
    const record: ManagedExchangeRecord = {
      ...scheduled(),
      lastRun: { at: offsetless, outcome: "succeeded" },
    };
    for (const zone of ["UTC", "America/New_York"]) {
      const advanced = withTimeZone(zone, () =>
        applyManagedExchangeScheduleAdvance(record, {
          schedule: advancedSchedule,
          fromNextWindow: schedule.nextWindow,
          fromConsecutiveMisses: schedule.consecutiveMisses,
          lastRun: missedRun,
        }),
      );
      expect(advanced.schedule).toEqual(advancedSchedule);
      expect(advanced.lastRun).toEqual(missedRun);
    }
  });

  test("an advance the schema would reject writes nothing", () => {
    expect(() =>
      applyManagedExchangeScheduleAdvance(scheduled(), {
        schedule: { ...advancedSchedule, consecutiveMisses: -1 },
        fromNextWindow: schedule.nextWindow,
        fromConsecutiveMisses: schedule.consecutiveMisses,
      }),
    ).toThrow();
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

  test("never exposes the secret or the document", () => {
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

describe("partitionReadableManagedExchanges", () => {
  /** A record holding a period past the schema's ceiling -- the shape a
   * pre-ceiling import or a hand-edit leaves behind, which the strict read
   * rejects. Assembled past the schema on purpose: the builder would refuse it. */
  function outOfBoundsRecord(): unknown {
    const record = buildManagedExchangeRecord(
      newExchange({ label: "Out of bounds", schedule }),
    );
    return {
      ...record,
      schedule: { ...schedule, intervalDays: MAX_SCHEDULE_INTERVAL_DAYS + 1 },
    };
  }

  test("skips an out-of-bounds record and keeps every readable one", () => {
    const first = buildManagedExchangeRecord(newExchange({ label: "First" }));
    const second = buildManagedExchangeRecord(newExchange({ label: "Second" }));
    const bad = outOfBoundsRecord();
    // What the strict read does with the same value, for contrast: the whole
    // list fails, which is the wholesale rejection the tolerant read exists to
    // avoid at an unattended wake.
    expect(() => parseManagedExchangeRecord(bad)).toThrow();

    const read = partitionReadableManagedExchanges(
      [first.id, "legacy-key", second.id],
      [first, bad, second],
    );

    expect(read.records.map((record) => record.label)).toEqual([
      "First",
      "Second",
    ]);
    expect(read.unreadableIds).toEqual(["legacy-key"]);
  });

  test("reports the stored key, not the unreadable entry's own id", () => {
    const record = buildManagedExchangeRecord(newExchange());
    // A failed parse leaves the entry's own `id` untrusted, so the key the store
    // holds it under is what a report names and a delete acts on.
    const read = partitionReadableManagedExchanges(
      ["the-store-key"],
      [{ ...record, id: "the-embedded-id", schedule: { nonsense: true } }],
    );

    expect(read.records).toEqual([]);
    expect(read.unreadableIds).toEqual(["the-store-key"]);
  });

  test("skips an entry an app upgrade invalidated, on the same reading", () => {
    const good = buildManagedExchangeRecord(newExchange({ label: "Good" }));
    const read = partitionReadableManagedExchanges(
      ["future", good.id],
      [{ ...good, schemaVersion: "psilink-managed-exchange/v2" }, good],
    );

    expect(read.records.map((record) => record.id)).toEqual([good.id]);
    expect(read.unreadableIds).toEqual(["future"]);
  });

  test("never throws, even when no entry parses at all", () => {
    const read = partitionReadableManagedExchanges(
      ["a", "b"],
      [undefined, "not a record"],
    );

    expect(read.records).toEqual([]);
    expect(read.unreadableIds).toEqual(["a", "b"]);
  });

  test("reports nothing unreadable for a store of valid records", () => {
    const record = buildManagedExchangeRecord(newExchange());
    const read = partitionReadableManagedExchanges([record.id], [record]);

    expect(read.records).toEqual([record]);
    expect(read.unreadableIds).toEqual([]);
  });
});
