import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  generateSharedSecret,
  getDefaultLinkageTerms,
  getLogger,
} from "@alcove/core";

import {
  MANAGED_EXCHANGE_SCHEMA_VERSION,
  NO_STANDING_CONDITION,
  composeManagedExchangeFile,
} from "../../../src/psi/managed/managedExchangeRecord.js";
import { raiseBetweenVisitNotices } from "../../../src/psi/managed/managedScheduleRuntime.js";

import type {
  ManagedExchangeRecord,
  ManagedExchangeSchedule,
} from "../../../src/psi/managed/managedExchangeRecord.js";
import type { BetweenVisitNotice } from "../../../src/psi/managed/betweenVisitNotice.js";
import type { BetweenVisitNoticeSeams } from "../../../src/psi/managed/managedScheduleRuntime.js";
import type { ManagedLocalState } from "../../../src/psi/managed/managedLocalStateShape.js";
import type { ManagedScheduleTickEntry } from "../../../src/psi/managed/managedScheduleRunner.js";

/**
 * What the runtime raises across its wakes: one notification per occurrence, one
 * for a wake that finds several windows elapsed, and nothing more while a state
 * the operator has already been told about stands.
 *
 * The run driver is mocked for its import alone -- nothing here runs an exchange
 * -- and the notice copy itself is betweenVisitNotice.test.ts's.
 */

vi.mock(
  "../../../src/psi/managed/managedRunDriver.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    runManagedExchangeInBrowser: vi.fn(),
  }),
);
vi.mock("@openmined/psi.js/psi_wasm_web", () => ({
  default: () => Promise.resolve({}),
}));
vi.mock("../../../src/psi/parkedResultsStore.js", () => ({
  parkRunResults: vi.fn(),
  recordParkedResultsRefusal: vi.fn(),
  recordResultsTooLarge: vi.fn(),
  recordResultsWrittenToFolder: vi.fn(),
}));

const NOW = Date.parse("2026-07-14T12:00:00.000Z");
const RUN_AT = "2026-07-14T09:00:00.000Z";
const ID = "riverbend";

function schedule(consecutiveMisses = 0): ManagedExchangeSchedule {
  return {
    anchor: "2026-07-01T09:00:00.000Z",
    intervalDays: 1,
    windowSeconds: 3600,
    nextWindow: "2026-07-15T09:00:00.000Z",
    consecutiveMisses,
  };
}

function record(
  overrides: Partial<ManagedExchangeRecord> = {},
): ManagedExchangeRecord {
  return {
    schemaVersion: MANAGED_EXCHANGE_SCHEMA_VERSION,
    id: ID,
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: { channel: "webrtc", host: "signaling.example.org" },
      linkageTerms: getDefaultLinkageTerms("County Health Dept"),
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
    standingCondition: NO_STANDING_CONDITION,
    schedule: schedule(),
    ...overrides,
  };
}

function entry(
  overrides: Partial<ManagedScheduleTickEntry> = {},
): ManagedScheduleTickEntry {
  return {
    id: ID,
    caughtUpMisses: 0,
    caughtUpSkips: 0,
    attempts: 1,
    ...overrides,
  };
}

/** The notification boundary, holding what each wake was handed. */
function notifier({
  armed = true,
  local,
}: { armed?: boolean; local?: ManagedLocalState } = {}) {
  const shown: Array<BetweenVisitNotice> = [];
  const reads = { records: 0 };
  let stored = record();
  const seams: BetweenVisitNoticeSeams = {
    now: () => NOW,
    listRecords: () => {
      reads.records += 1;
      return Promise.resolve({ records: [stored], unreadableIds: [] });
    },
    listLocalState: () =>
      Promise.resolve(
        new Map(local === undefined ? [] : [[ID, local] as const]),
      ),
    armed: () => armed,
    show: (notice) => {
      shown.push(notice);
      return Promise.resolve();
    },
  };
  return {
    shown,
    reads,
    seams,
    /** Stand the store on a new record, as a window's bookkeeping write does. */
    store: (next: ManagedExchangeRecord) => {
      stored = next;
    },
  };
}

const announced = new Map<string, string>();

beforeEach(() => {
  announced.clear();
});

describe("raiseBetweenVisitNotices: one notification per occurrence", () => {
  test("a completed run is announced once, however many wakes follow", async () => {
    const boundary = notifier();
    boundary.store(record({ lastRun: { at: RUN_AT, outcome: "succeeded" } }));
    const entries = [entry({ disposition: "succeeded" })];

    await raiseBetweenVisitNotices(entries, announced, boundary.seams);
    await raiseBetweenVisitNotices(entries, announced, boundary.seams);

    expect(boundary.shown).toHaveLength(1);
    expect(boundary.shown[0].kind).toBe("backup");
  });

  test("a wake that finds several windows elapsed announces them once", async () => {
    const boundary = notifier();
    boundary.store(record({ schedule: schedule(3) }));

    await raiseBetweenVisitNotices(
      [entry({ caughtUpMisses: 3, attempts: 0, skipped: "not-due" })],
      announced,
      boundary.seams,
    );

    expect(boundary.shown).toHaveLength(1);
    expect(boundary.shown[0].kind).toBe("repeated-misses");
  });

  test("the escalation ends the per-miss notices while it stands", async () => {
    const boundary = notifier();
    const missed = [entry({ disposition: "missed" })];

    boundary.store(record({ schedule: schedule(1) }));
    await raiseBetweenVisitNotices(missed, announced, boundary.seams);
    boundary.store(record({ schedule: schedule(2) }));
    await raiseBetweenVisitNotices(missed, announced, boundary.seams);
    boundary.store(record({ schedule: schedule(3) }));
    await raiseBetweenVisitNotices(missed, announced, boundary.seams);

    expect(boundary.shown.map((notice) => notice.kind)).toEqual([
      "missed",
      "repeated-misses",
    ]);
  });

  test("a state that returns after a quiet window is announced again", async () => {
    const boundary = notifier({ local: { backup: { backedUpAt: RUN_AT } } });
    const failed = {
      at: RUN_AT,
      outcome: "failed" as const,
      failureKind: "input" as const,
    };

    boundary.store(record({ lastRun: failed }));
    await raiseBetweenVisitNotices(
      [entry({ disposition: "failed" })],
      announced,
      boundary.seams,
    );
    boundary.store(record({ lastRun: { at: RUN_AT, outcome: "succeeded" } }));
    await raiseBetweenVisitNotices(
      [entry({ disposition: "succeeded" })],
      announced,
      boundary.seams,
    );
    boundary.store(record({ lastRun: failed }));
    await raiseBetweenVisitNotices(
      [entry({ disposition: "failed" })],
      announced,
      boundary.seams,
    );

    expect(boundary.shown.map((notice) => notice.kind)).toEqual([
      "input",
      "input",
    ]);
  });
});

describe("raiseBetweenVisitNotices: what it does not report", () => {
  test("a refused permission raises nothing and reads no record", async () => {
    const boundary = notifier({ armed: false });
    boundary.store(record({ lastRun: { at: RUN_AT, outcome: "succeeded" } }));

    await raiseBetweenVisitNotices(
      [entry({ disposition: "succeeded" })],
      announced,
      boundary.seams,
    );

    expect(boundary.shown).toEqual([]);
    expect(boundary.reads.records).toBe(0);
  });

  test("a window whose bookkeeping did not land is not reported", async () => {
    const boundary = notifier();
    boundary.store(record({ lastRun: { at: RUN_AT, outcome: "succeeded" } }));

    await raiseBetweenVisitNotices(
      [entry({ disposition: "succeeded", skipped: "bookkeeping-failed" })],
      announced,
      boundary.seams,
    );

    expect(boundary.shown).toEqual([]);
  });

  test("a wake that occupied no window reads nothing at all", async () => {
    const boundary = notifier();

    await raiseBetweenVisitNotices(
      [entry({ attempts: 0, skipped: "not-due" })],
      announced,
      boundary.seams,
    );

    expect(boundary.reads.records).toBe(0);
    expect(boundary.shown).toEqual([]);
  });

  test("a store read that fails costs the notice and nothing else", async () => {
    // The loss reports itself to the diagnostic log, which is where an operator
    // looks for it; kept out of the suite's output.
    vi.spyOn(getLogger("managedScheduleRuntime"), "warn").mockImplementation(
      () => {},
    );
    const boundary = notifier();
    const seams: BetweenVisitNoticeSeams = {
      ...boundary.seams,
      listRecords: () =>
        Promise.reject(new Error("the database would not open")),
    };

    await expect(
      raiseBetweenVisitNotices(
        [entry({ disposition: "succeeded" })],
        announced,
        seams,
      ),
    ).resolves.toBeUndefined();
    expect(boundary.shown).toEqual([]);
  });

  test("a seam that throws checking armed costs the notice and nothing else", async () => {
    vi.spyOn(getLogger("managedScheduleRuntime"), "warn").mockImplementation(
      () => {},
    );
    const boundary = notifier();
    boundary.store(record({ lastRun: { at: RUN_AT, outcome: "succeeded" } }));
    const seams: BetweenVisitNoticeSeams = {
      ...boundary.seams,
      armed: () => {
        throw new Error("the permission check failed");
      },
    };

    await expect(
      raiseBetweenVisitNotices(
        [entry({ disposition: "succeeded" })],
        announced,
        seams,
      ),
    ).resolves.toBeUndefined();
    expect(boundary.shown).toEqual([]);
  });
});
