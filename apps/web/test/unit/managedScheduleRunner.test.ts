import { beforeEach, describe, expect, test } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@psilink/core";

import {
  ATTEMPT_PEER_WAIT_MS,
  ATTEMPT_RATE_GAP_MS,
  MAX_WINDOW_ATTEMPTS,
  tickManagedSchedules,
} from "@psi/managedScheduleRunner";
import {
  applyManagedExchangeScheduleAdvance,
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
  parseManagedExchangeRecord,
} from "@psi/managedExchangeRecord";
import {
  encodeManagedExchangeArtifact,
  reconstructRecordFromArtifact,
} from "@psi/managedExchangeArtifact";
import { ManagedExchangeExpiredError } from "@psi/managedExpiry";
import { ManagedExchangeLockUnavailableError } from "@psi/managedExchangeRun";
import { ManagedInputError } from "@psi/managedInputGuard";
import { PartnerNoShowError } from "@psi/waitForConnection";
import { managedScheduleWindow } from "@psi/managedSchedule";

import type {
  ManagedExchangeRecord,
  ManagedExchangeSchedule,
  ManagedExchangeScheduleAdvance,
} from "@psi/managedExchangeRecord";
import type {
  ManagedScheduleAttempt,
  ManagedScheduleTickSeams,
} from "@psi/managedScheduleRunner";
import type { ManagedLocalState } from "@psi/managedLocalStateShape";

// The unattended runner's tick in Node, with the clock, the store, the delay and
// the run all injected. Every instant here is pinned: the fake clock advances
// only where real time would -- inside an attempt that spends its peer wait, and
// inside the pacing delay -- so a window's occupancy is exact rather than
// approximate, and the assertions can name the instant the last attempt ended.
//
// The store fake applies the REAL conditioned write
// (`applyManagedExchangeScheduleAdvance`), so a test that advances the plan is
// held to the same cadence-and-plan match the store enforces rather than to a
// permissive stand-in.

/** Anchor 2026-01-06T14:00Z, weekly, a three-hour window: window n opens
 * `2026-01-06 + 7n` at 14:00Z and closes at 17:00Z. */
const weekly: ManagedExchangeSchedule = {
  anchor: "2026-01-06T14:00:00.000Z",
  intervalDays: 7,
  windowSeconds: 10_800,
  nextWindow: "2026-01-06T14:00:00.000Z",
  consecutiveMisses: 0,
};

function at(instant: string): number {
  return Date.parse(instant);
}

/** A handle stands in for the persisted `FileSystemFileHandle`: the record's
 * schema validates its presence, not its structure, and nothing under test reads
 * through it. */
const inputFileHandle = {} as FileSystemFileHandle;

function recordWith(
  fields: Partial<ManagedExchangeRecord> & {
    schedule?: ManagedExchangeSchedule;
  } = {},
): ManagedExchangeRecord {
  const base = buildManagedExchangeRecord({
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: { channel: "webrtc", host: "signaling.example.org" },
      linkageTerms: getDefaultLinkageTerms("County Health Dept"),
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
    inputFileHandle,
    schedule: weekly,
  });
  return parseManagedExchangeRecord({ ...base, ...fields });
}

/** One recorded attempt: what the tick handed the run seam. */
interface RecordedAttempt {
  source: ManagedScheduleAttempt["source"];
  peerWaitTimeoutMs: number;
  startedAtMs: number;
}

/** How one attempt behaves, in order; the last entry repeats for every further
 * attempt. */
type AttemptScript = Array<
  | { kind: "succeed"; spendsMs?: number }
  | {
      kind: "fail";
      error: unknown;
      spendsMs?: number;
      startsDataExchange?: true;
    }
>;

interface Harness {
  seams: ManagedScheduleTickSeams;
  attempts: Array<RecordedAttempt>;
  advances: Array<{ id: string; advance: ManagedExchangeScheduleAdvance }>;
  /** Every store write and run in the order they happened, so a test can pin
   * that the catch-up write preceded the first attempt. */
  order: Array<"advance" | "attempt">;
  stored: Map<string, ManagedExchangeRecord>;
  nowMs: () => number;
}

function harness(options: {
  records: Array<ManagedExchangeRecord>;
  startAt: string;
  script?: AttemptScript;
  localState?: Map<string, ManagedLocalState>;
  stopAfterAttempts?: number;
  failAdvanceFor?: string;
}): Harness {
  const script = options.script ?? [];
  const stored = new Map(
    options.records.map((record) => [record.id, record] as const),
  );
  const attempts: Array<RecordedAttempt> = [];
  const advances: Array<{
    id: string;
    advance: ManagedExchangeScheduleAdvance;
  }> = [];
  const order: Array<"advance" | "attempt"> = [];
  let clockMs = at(options.startAt);

  const seams: ManagedScheduleTickSeams = {
    now: () => clockMs,
    listRecords: () => Promise.resolve([...stored.values()]),
    listLocalState: () =>
      Promise.resolve(
        options.localState ?? new Map<string, ManagedLocalState>(),
      ),
    persistAdvance: (id, advance) => {
      order.push("advance");
      advances.push({ id, advance });
      if (id === options.failAdvanceFor)
        return Promise.reject(new Error("the store refused the write"));
      const existing = stored.get(id);
      if (existing === undefined)
        return Promise.reject(new Error(`no record ${id}`));
      const next = applyManagedExchangeScheduleAdvance(existing, advance);
      stored.set(id, next);
      return Promise.resolve(next);
    },
    runAttempt: (attempt) => {
      order.push("attempt");
      attempts.push({
        source: attempt.source,
        peerWaitTimeoutMs: attempt.peerWaitTimeoutMs,
        startedAtMs: clockMs,
      });
      // The last scripted step repeats; a tick that attempts anything with no
      // script at all is a test that meant to supply one.
      const step = script.at(Math.min(attempts.length - 1, script.length - 1));
      if (step === undefined)
        return Promise.reject(new Error("no attempt scripted"));
      clockMs += step.spendsMs ?? 0;
      if (step.kind === "succeed") return Promise.resolve(undefined);
      if (step.startsDataExchange === true) attempt.onDataExchangeStart();
      return Promise.reject(step.error);
    },
    delay: (ms) => {
      clockMs += ms;
      return Promise.resolve();
    },
    stopped: () =>
      options.stopAfterAttempts !== undefined &&
      attempts.length >= options.stopAfterAttempts,
  };
  return { seams, attempts, advances, order, stored, nowMs: () => clockMs };
}

/** A no-show attempt spends its whole peer wait, exactly as the rendezvous
 * budget does before it raises. */
function noShowScript(): AttemptScript {
  return [
    {
      kind: "fail",
      error: new PartnerNoShowError("timed out waiting for the other party"),
      spendsMs: ATTEMPT_PEER_WAIT_MS,
    },
  ];
}

describe("a due window in the open runtime", () => {
  test("fires one unattended attempt through the persisted handle and advances the plan", async () => {
    const record = recordWith();
    const runner = harness({
      records: [record],
      startAt: "2026-01-06T14:30:00.000Z",
      script: [{ kind: "succeed" }],
    });

    const [entry] = await tickManagedSchedules(runner.seams);

    expect(entry).toMatchObject({
      id: record.id,
      caughtUpMisses: 0,
      attempts: 1,
      disposition: "succeeded",
    });
    expect(runner.attempts[0].source).toEqual({
      kind: "handle",
      handle: inputFileHandle,
      attendance: "unattended",
    });
    // Nothing elapsed, so the only write is the window's own disposition.
    expect(runner.advances).toHaveLength(1);
    expect(runner.advances[0].advance.schedule).toMatchObject({
      nextWindow: "2026-01-13T14:00:00.000Z",
      consecutiveMisses: 0,
    });
    // The run recorded its own `lastRun`; the advance carries none, so a window
    // produces one bookkeeping entry rather than two writers of it.
    expect(runner.advances[0].advance.lastRun).toBeUndefined();
  });

  test("bounds one attempt's wait by the peer budget, then by what is left of the window", async () => {
    const runner = harness({
      records: [recordWith()],
      startAt: "2026-01-06T14:00:00.000Z",
      script: noShowScript(),
    });

    await tickManagedSchedules(runner.seams);

    const waits = runner.attempts.map((attempt) => attempt.peerWaitTimeoutMs);
    expect(Math.max(...waits)).toBe(ATTEMPT_PEER_WAIT_MS);
    for (const attempt of runner.attempts)
      expect(
        attempt.startedAtMs + attempt.peerWaitTimeoutMs,
      ).toBeLessThanOrEqual(at("2026-01-06T17:00:00.000Z"));
    // Occupancy runs the window out and stops exactly at its close: no attempt
    // starts after it, and the last one's wait ends on it rather than past it.
    expect(runner.nowMs()).toBe(at("2026-01-06T17:00:00.000Z"));
    expect(runner.attempts).toHaveLength(
      (3 * 60 * 60 * 1000) / ATTEMPT_PEER_WAIT_MS,
    );
  });

  test("re-attempts a transient failure inside the window rather than forfeiting it", async () => {
    const runner = harness({
      records: [recordWith()],
      startAt: "2026-01-06T14:00:00.000Z",
      script: [
        { kind: "fail", error: new Error("the channel dropped") },
        { kind: "succeed" },
      ],
    });

    const [entry] = await tickManagedSchedules(runner.seams);

    expect(entry.attempts).toBe(2);
    expect(entry.disposition).toBe("succeeded");
    // The retry is paced from the failed attempt's start, so a failure that
    // reproduces instantly cannot spin the window away.
    expect(
      runner.attempts[1].startedAtMs - runner.attempts[0].startedAtMs,
    ).toBe(ATTEMPT_RATE_GAP_MS);
  });

  test("never re-attempts once the data exchange began", async () => {
    const runner = harness({
      records: [recordWith()],
      startAt: "2026-01-06T14:00:00.000Z",
      script: [
        {
          kind: "fail",
          error: new Error("the channel dropped mid-exchange"),
          startsDataExchange: true,
        },
      ],
    });

    const [entry] = await tickManagedSchedules(runner.seams);

    expect(entry.attempts).toBe(1);
    expect(entry.disposition).toBe("failed");
  });

  test("does not re-attempt a failure whose local cause the next attempt reproduces", async () => {
    for (const error of [
      new ManagedInputError({ reason: "acquire", cause: new Error("gone") }),
      new ManagedExchangeExpiredError("2026-01-05T00:00:00.000Z"),
    ]) {
      const runner = harness({
        records: [recordWith()],
        startAt: "2026-01-06T14:00:00.000Z",
        script: [{ kind: "fail", error }],
      });

      const [entry] = await tickManagedSchedules(runner.seams);

      expect(entry.attempts).toBe(1);
      expect(entry.disposition).toBe("failed");
      // "failed" leaves the miss count alone: a local failure says nothing about
      // whether the two runners are still meeting.
      expect(runner.advances[0].advance.schedule.consecutiveMisses).toBe(0);
    }
  });

  test("bounds a window whose attempts fail immediately", async () => {
    const runner = harness({
      records: [recordWith()],
      startAt: "2026-01-06T14:00:00.000Z",
      script: [{ kind: "fail", error: new Error("the broker refused") }],
    });

    const [entry] = await tickManagedSchedules(runner.seams);

    expect(entry.attempts).toBe(MAX_WINDOW_ATTEMPTS);
    expect(entry.disposition).toBe("failed");
  });
});

describe("a window nobody arrived in", () => {
  test("records one miss for the window and plans the next one, nothing sooner", async () => {
    const record = recordWith();
    const runner = harness({
      records: [record],
      startAt: "2026-01-06T14:00:00.000Z",
      script: noShowScript(),
    });

    const [entry] = await tickManagedSchedules(runner.seams);

    expect(entry.disposition).toBe("missed");
    // One bookkeeping entry for the window, not one per attempt.
    expect(runner.advances).toHaveLength(1);
    expect(runner.advances[0].advance.schedule).toMatchObject({
      nextWindow: "2026-01-13T14:00:00.000Z",
      consecutiveMisses: 1,
    });
    expect(runner.stored.get(record.id)?.schedule).toMatchObject({
      nextWindow: "2026-01-13T14:00:00.000Z",
      consecutiveMisses: 1,
    });
  });

  test("leaves the run's own no-show bookkeeping to the run", async () => {
    const runner = harness({
      records: [recordWith()],
      startAt: "2026-01-06T14:00:00.000Z",
      script: noShowScript(),
    });

    await tickManagedSchedules(runner.seams);

    expect(runner.advances[0].advance.lastRun).toBeUndefined();
  });
});

describe("a window the single-writer lock was held through", () => {
  test("records neither an attempt nor a miss, and advances past it", async () => {
    const record = recordWith();
    const runner = harness({
      records: [record],
      startAt: "2026-01-06T14:00:00.000Z",
      script: [
        {
          kind: "fail",
          error: new ManagedExchangeLockUnavailableError(record.id),
        },
      ],
    });

    const [entry] = await tickManagedSchedules(runner.seams);

    expect(entry.disposition).toBe("unattempted");
    // One attempt was made and refused the lock; the runner defers rather than
    // contending for it again.
    expect(entry.attempts).toBe(1);
    expect(runner.advances[0].advance).toMatchObject({
      fromConsecutiveMisses: 0,
      schedule: {
        nextWindow: "2026-01-13T14:00:00.000Z",
        consecutiveMisses: 0,
      },
    });
    expect(runner.advances[0].advance.lastRun).toBeUndefined();
  });
});

describe("catch-up on wake", () => {
  test("counts every elapsed window and persists that before any attempt", async () => {
    const record = recordWith();
    const runner = harness({
      records: [record],
      startAt: "2026-01-27T14:30:00.000Z",
      script: [{ kind: "succeed" }],
    });

    const [entry] = await tickManagedSchedules(runner.seams);

    // Windows 0, 1 and 2 elapsed unattempted; window 3 (27 January) is open.
    expect(entry.caughtUpMisses).toBe(3);
    expect(runner.order).toEqual(["advance", "attempt", "advance"]);
    expect(runner.advances[0].advance).toMatchObject({
      fromNextWindow: "2026-01-06T14:00:00.000Z",
      fromConsecutiveMisses: 0,
      schedule: {
        nextWindow: "2026-01-27T14:00:00.000Z",
        consecutiveMisses: 3,
      },
      lastRun: { at: "2026-01-20T17:00:00.000Z", outcome: "missed" },
    });
    // The run then resets the count the elapsed windows built.
    expect(runner.advances[1].advance.schedule).toMatchObject({
      nextWindow: "2026-02-03T14:00:00.000Z",
      consecutiveMisses: 0,
    });
  });

  test("applies to a restored backup's stale plan on its first wake", async () => {
    const source = recordWith({
      schedule: {
        ...weekly,
        nextWindow: "2026-01-06T14:00:00.000Z",
        consecutiveMisses: 1,
      },
    });
    // An artifact carries no input handle (it is a device-local platform
    // object), so the restored record is given one: what is under test is that
    // the stale plan catches up before the attempt, not the re-selection path.
    const restored = parseManagedExchangeRecord({
      ...reconstructRecordFromArtifact(encodeManagedExchangeArtifact(source)),
      inputFileHandle,
    });
    const runner = harness({
      records: [restored],
      startAt: "2026-01-20T14:30:00.000Z",
      script: [{ kind: "succeed" }],
    });

    const [entry] = await tickManagedSchedules(runner.seams);

    expect(entry.caughtUpMisses).toBe(2);
    expect(runner.order).toEqual(["advance", "attempt", "advance"]);
    expect(runner.advances[0].advance.schedule).toMatchObject({
      nextWindow: "2026-01-20T14:00:00.000Z",
      consecutiveMisses: 3,
    });
  });

  test("treats a run that completed inside the open window as satisfying it", async () => {
    const record = recordWith({
      lastRun: { at: "2026-01-06T14:10:00.000Z", outcome: "succeeded" },
    });
    const runner = harness({
      records: [record],
      startAt: "2026-01-06T14:30:00.000Z",
    });

    const [entry] = await tickManagedSchedules(runner.seams);

    expect(entry.attempts).toBe(0);
    expect(entry.skipped).toBe("not-due");
    expect(runner.advances[0].advance.schedule).toMatchObject({
      nextWindow: "2026-01-13T14:00:00.000Z",
      consecutiveMisses: 0,
    });
  });

  test("writes nothing when the stored plan is already the open window", async () => {
    const runner = harness({
      records: [recordWith()],
      startAt: "2026-01-06T14:30:00.000Z",
      script: [{ kind: "succeed" }],
    });

    await tickManagedSchedules(runner.seams);

    expect(runner.order).toEqual(["attempt", "advance"]);
  });
});

describe("records the tick leaves alone", () => {
  let attempted: number;

  beforeEach(() => {
    attempted = 0;
  });

  async function tickOne(
    record: ManagedExchangeRecord,
    localState?: Map<string, ManagedLocalState>,
  ) {
    const runner = harness({
      records: [record],
      startAt: "2026-01-06T14:30:00.000Z",
      script: [{ kind: "succeed" }],
      ...(localState !== undefined ? { localState } : {}),
    });
    const [entry] = await tickManagedSchedules(runner.seams);
    attempted = runner.attempts.length;
    return { entry, runner };
  }

  test("an exchange with no schedule", async () => {
    const { entry } = await tickOne(recordWith({ schedule: undefined }));
    expect(entry.skipped).toBe("no-schedule");
    expect(attempted).toBe(0);
  });

  test("a copy this device handed off", async () => {
    const record = recordWith();
    const { entry, runner } = await tickOne(
      record,
      new Map([
        [record.id, { spent: { spentAt: "2026-01-05T00:00:00.000Z" } }],
      ]),
    );
    expect(entry.skipped).toBe("spent");
    expect(attempted).toBe(0);
    expect(runner.advances).toHaveLength(0);
  });

  test("a record with no persisted input handle", async () => {
    const { entry, runner } = await tickOne(
      parseManagedExchangeRecord({
        ...recordWith(),
        inputFileHandle: undefined,
      }),
    );
    expect(entry.skipped).toBe("no-input-handle");
    expect(attempted).toBe(0);
    // The window is left unaccounted, so the wake that finds it elapsed counts
    // it exactly as a window this runtime slept through.
    expect(runner.advances).toHaveLength(0);
  });
});

describe("the runtime going away mid-window", () => {
  test("leaves the window unresolved rather than recording a disposition", async () => {
    const record = recordWith();
    const runner = harness({
      records: [record],
      startAt: "2026-01-06T14:00:00.000Z",
      script: noShowScript(),
      stopAfterAttempts: 2,
    });

    const [entry] = await tickManagedSchedules(runner.seams);

    expect(entry.attempts).toBe(2);
    expect(entry.disposition).toBeUndefined();
    expect(entry.skipped).toBe("stopped");
    expect(runner.advances).toHaveLength(0);
    expect(runner.stored.get(record.id)?.schedule).toEqual(weekly);
  });
});

describe("one record's trouble", () => {
  test("is reported rather than thrown, and does not stop the record beside it", async () => {
    const refusing = recordWith();
    const healthy = recordWith();
    const runner = harness({
      records: [refusing, healthy],
      startAt: "2026-01-06T14:30:00.000Z",
      script: [{ kind: "succeed" }],
      failAdvanceFor: refusing.id,
    });

    const entries = await tickManagedSchedules(runner.seams);

    expect(entries[0]).toMatchObject({
      id: refusing.id,
      skipped: "bookkeeping-failed",
    });
    expect(entries[1].disposition).toBe("succeeded");
  });
});

describe("the window's own geometry", () => {
  test("is the schedule's, read from the record rather than measured off a clock", () => {
    expect(managedScheduleWindow(weekly, 0)).toEqual({
      index: 0,
      opensAtMs: at("2026-01-06T14:00:00.000Z"),
      closesAtMs: at("2026-01-06T17:00:00.000Z"),
    });
  });
});
