import { beforeEach, describe, expect, test } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@psilink/core";

import {
  ATTEMPT_PEER_WAIT_MS,
  ATTEMPT_RATE_GAP_MS,
  MAX_WINDOW_ATTEMPTS,
  tickManagedSchedules,
} from "@psi/managedScheduleRunner";
import {
  applyManagedExchangeLocalEdits,
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
  id: string;
  source: ManagedScheduleAttempt["source"];
  peerWaitTimeoutMs: number;
  startedAtMs: number;
}

/** How one attempt behaves, in order; the last entry repeats for every further
 * attempt. A `"hang"` never settles until the harness releases it, which is how
 * a test holds one record inside its window while it drives another wake. */
type AttemptScript = Array<
  | { kind: "succeed"; spendsMs?: number }
  | { kind: "hang" }
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
  /** Resolves once the first attempt has begun, so a second wake can be driven
   * at a moment the first is provably inside a window. */
  firstAttempt: Promise<void>;
  /** Settles every hanging attempt as a completed exchange. */
  releaseHangingAttempts: () => void;
  /** Moves the fake clock on between two wakes, as real time does while a
   * window is being occupied. */
  advanceClock: (ms: number) => void;
}

function harness(options: {
  records: Array<ManagedExchangeRecord>;
  startAt: string;
  script?: AttemptScript;
  localState?: Map<string, ManagedLocalState>;
  stopAfterAttempts?: number;
  failAdvanceFor?: string;
  /** A write applied to the stored record immediately before the conditioned
   * advance lands, standing in for another tab's edit between this tick's
   * snapshot and its write. */
  concurrentEdit?: (record: ManagedExchangeRecord) => ManagedExchangeRecord;
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
  const hangReleases: Array<() => void> = [];
  let clockMs = at(options.startAt);
  let noteFirstAttempt = (): void => undefined;
  const firstAttempt = new Promise<void>((resolve) => {
    noteFirstAttempt = () => {
      resolve();
    };
  });

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
      const current = options.concurrentEdit?.(existing) ?? existing;
      const next = applyManagedExchangeScheduleAdvance(current, advance);
      stored.set(id, next);
      return Promise.resolve(next);
    },
    runAttempt: (attempt) => {
      order.push("attempt");
      attempts.push({
        id: attempt.record.id,
        source: attempt.source,
        peerWaitTimeoutMs: attempt.peerWaitTimeoutMs,
        startedAtMs: clockMs,
      });
      noteFirstAttempt();
      // The last scripted step repeats; a tick that attempts anything with no
      // script at all is a test that meant to supply one.
      const step = script.at(Math.min(attempts.length - 1, script.length - 1));
      if (step === undefined)
        return Promise.reject(new Error("no attempt scripted"));
      if (step.kind === "hang")
        return new Promise<undefined>((resolve) => {
          hangReleases.push(() => {
            resolve(undefined);
          });
        });
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
  return {
    seams,
    attempts,
    advances,
    order,
    stored,
    nowMs: () => clockMs,
    firstAttempt,
    releaseHangingAttempts: () => {
      for (const release of hangReleases) release();
    },
    advanceClock: (ms) => {
      clockMs += ms;
    },
  };
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

  test("paces no further than the window's close, which ends the occupancy anyway", async () => {
    const runner = harness({
      records: [recordWith()],
      // Half a rate gap before the close, so the full pacing delay would run
      // past it.
      startAt: "2026-01-06T16:59:30.000Z",
      script: [{ kind: "fail", error: new Error("the broker refused") }],
    });

    const [entry] = await tickManagedSchedules(runner.seams);

    expect(entry.attempts).toBe(1);
    expect(entry.disposition).toBe("failed");
    // The occupancy ends AT the close rather than waiting out a gap the window
    // has no room for, so the record is free again the moment its window is.
    expect(runner.nowMs()).toBe(at("2026-01-06T17:00:00.000Z"));
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

describe("a wake while an earlier one is still occupying a window", () => {
  /** A second exchange whose window opens two hours after the first one's, so
   * one wake finds it not due and a later wake finds it open. */
  const laterWindow: ManagedExchangeSchedule = {
    anchor: "2026-01-06T16:00:00.000Z",
    intervalDays: 7,
    windowSeconds: 10_800,
    nextWindow: "2026-01-06T16:00:00.000Z",
    consecutiveMisses: 0,
  };

  test("runs the exchange whose window just opened, and does not re-enter the occupied one", async () => {
    const occupying = recordWith();
    const opening = recordWith({ schedule: laterWindow });
    const runner = harness({
      records: [occupying, opening],
      startAt: "2026-01-06T14:30:00.000Z",
      script: [{ kind: "hang" }, { kind: "succeed" }],
    });
    // The registry the runtime carries across its wakes; the guard is what it
    // holds, not the wake.
    const inFlight = new Set<string>();

    const firstWake = tickManagedSchedules(runner.seams, inFlight);
    await runner.firstAttempt;
    runner.advanceClock(100 * 60 * 1000);
    const secondWake = await tickManagedSchedules(runner.seams, inFlight);

    const stillOccupying = secondWake.find(
      (entry) => entry.id === occupying.id,
    );
    const justOpened = secondWake.find((entry) => entry.id === opening.id);
    expect(stillOccupying).toMatchObject({ attempts: 0, skipped: "in-flight" });
    // The whole point: the second exchange's window is not lost to the first
    // one's occupancy, which can legitimately last the width of a window.
    expect(justOpened).toMatchObject({ attempts: 1, disposition: "succeeded" });
    expect(
      runner.attempts.filter((attempt) => attempt.id === occupying.id),
    ).toHaveLength(1);

    runner.releaseHangingAttempts();
    const firstEntries = await firstWake;
    expect(firstEntries[0]).toMatchObject({
      id: occupying.id,
      attempts: 1,
      disposition: "succeeded",
    });
    // The record leaves the registry when its tick settles, so the next wake
    // finds it available again.
    expect([...inFlight]).toEqual([]);
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

  test("reports the attempts and disposition the failed write was for, not zeroes", async () => {
    const record = recordWith();
    const runner = harness({
      records: [record],
      startAt: "2026-01-06T14:30:00.000Z",
      script: [
        {
          kind: "fail",
          error: new ManagedInputError({
            reason: "acquire",
            cause: new Error("gone"),
          }),
        },
      ],
      failAdvanceFor: record.id,
    });

    const [entry] = await tickManagedSchedules(runner.seams);

    // The window WAS occupied and did settle; what failed is the write that
    // would have recorded it, and the diagnostic entry says so rather than
    // reporting an untouched window.
    expect(entry).toMatchObject({
      attempts: 1,
      disposition: "failed",
      skipped: "bookkeeping-failed",
    });
    expect(runner.attempts).toHaveLength(1);
  });
});

describe("a schedule an edit in another tab dropped mid-tick", () => {
  test("is left alone rather than run against the plan the store no longer holds", async () => {
    const record = recordWith();
    const runner = harness({
      records: [record],
      // Three windows elapsed, so the catch-up walk writes before any attempt --
      // and that write is where the concurrent edit is seen.
      startAt: "2026-01-27T14:30:00.000Z",
      script: [{ kind: "succeed" }],
      concurrentEdit: (stored) =>
        applyManagedExchangeLocalEdits(stored, { schedule: null }),
    });

    const [entry] = await tickManagedSchedules(runner.seams);

    expect(entry.skipped).toBe("plan-moved");
    expect(runner.attempts).toHaveLength(0);
    expect(runner.stored.get(record.id)?.schedule).toBeUndefined();
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
