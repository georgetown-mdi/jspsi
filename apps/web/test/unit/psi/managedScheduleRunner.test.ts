import {
  ConnectionError,
  generateSharedSecret,
  getDefaultLinkageTerms,
} from "@psilink/core";
import { beforeEach, describe, expect, test } from "vitest";

import {
  ATTEMPT_PEER_WAIT_MS,
  ATTEMPT_RATE_GAP_MS,
  MAX_WINDOW_ATTEMPTS,
  tickManagedSchedules,
} from "@psi/managed/managedScheduleRunner";
import {
  ManagedExchangeCustodyUnreadableError,
  ManagedExchangeSpentError,
} from "@psi/managed/managedExchangeRun";
import {
  applyManagedExchangeLastRun,
  applyManagedExchangeLocalEdits,
  applyManagedExchangeScheduleAdvance,
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
  parseManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";
import {
  encodeManagedExchangeArtifact,
  reconstructRecordFromArtifact,
} from "@psi/managed/managedExchangeArtifact";
import { ManagedExchangeExpiredError } from "@psi/managed/managedExpiry";
import { ManagedExchangeLockUnavailableError } from "@psi/managed/managedExchangeLock";
import { ManagedInputError } from "@psi/managed/managedInputGuard";
import { PartnerNoShowError } from "@psi/transport/waitForConnection";
import { RotationPersistError } from "@psi/managed/managedRunRotate";
import { managedScheduleWindow } from "@psi/managed/managedSchedule";

import type {
  ManagedExchangeRecord,
  ManagedExchangeSchedule,
  ManagedExchangeScheduleAdvance,
} from "@psi/managed/managedExchangeRecord";
import type {
  ManagedScheduleAttempt,
  ManagedScheduleTickSeams,
} from "@psi/managed/managedScheduleRunner";
import type { ManagedLocalState } from "@psi/managed/managedLocalStateShape";

// The unattended runner's tick in Node, with the clock, the store, the delay
// and the run all injected. The fake clock advances only where real time would
// -- inside an attempt's peer wait and inside the pacing delay -- so a
// window's occupancy is exact and the assertions can name the instant the
// last attempt ended. The store fake applies the REAL conditioned write
// (`applyManagedExchangeScheduleAdvance`), so a test is held to the store's own cadence-and-plan match.

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
  /** Stored keys the per-entry read could not parse, as the store reports them
   * beside the records it could. */
  unreadableIds?: Array<string>;
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
    listRecords: () =>
      Promise.resolve({
        records: [...stored.values()],
        unreadableIds: options.unreadableIds ?? [],
      }),
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
    // The run recorded its own `lastRun`; the advance holds none, so a window
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
      new ManagedExchangeSpentError("record-under-test"),
      // The custody reading that failed: a local storage problem the next attempt
      // meets unchanged, so the window ends here rather than spending its whole
      // attempt budget on it the way a transport fault would.
      new ManagedExchangeCustodyUnreadableError(
        "record-under-test",
        new Error("the sibling entry did not validate"),
      ),
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

  test("a hand-off confirmed mid-window ends the window where it lands", async () => {
    // The tick read the sibling state before the window opened, so the hand-off
    // reaches this occupancy as the run path's own refusal on the second attempt.
    // A retryable failure would otherwise have spun this window to the attempt
    // cap; the refusal is what stops it there.
    const runner = harness({
      records: [recordWith()],
      startAt: "2026-01-06T14:00:00.000Z",
      script: [
        { kind: "fail", error: new Error("the broker refused") },
        { kind: "fail", error: new ManagedExchangeSpentError("spent-record") },
      ],
    });

    const [entry] = await tickManagedSchedules(runner.seams);

    expect(entry.attempts).toBe(2);
    expect(entry.disposition).toBe("failed");
    // The window says nothing about the partner: no miss counted, and the run
    // that refused recorded its own `handed-off` bookkeeping, so the advance
    // holds none.
    expect(runner.advances[0].advance.schedule.consecutiveMisses).toBe(0);
    expect(runner.advances[0].advance.lastRun).toBeUndefined();
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

describe("a window whose attempts do not agree", () => {
  /** A transient failure that runs the rest of the window out, so the occupancy
   * ends on THIS attempt and the window's disposition is decided with it as the
   * last verdict. */
  function transientThroughTheClose(afterMs: number): AttemptScript[number] {
    return {
      kind: "fail",
      error: new Error("the channel dropped"),
      spendsMs: 3 * 60 * 60 * 1000 - afterMs,
    };
  }

  test("counts the miss when a transient failure trails the no-show waits", async () => {
    // The defect this pins: taking the LAST attempt's verdict alone let one
    // dropped channel at the end of a window of no-show waits record "failed",
    // which leaves consecutiveMisses untouched -- so the window nobody arrived
    // in was never counted as a miss at all. Zero pacing after an attempt that
    // spent its whole peer wait is what makes that trailing attempt cheap to
    // reach.
    const runner = harness({
      records: [recordWith()],
      startAt: "2026-01-06T14:00:00.000Z",
      script: [
        ...noShowScript(),
        ...noShowScript(),
        transientThroughTheClose(2 * ATTEMPT_PEER_WAIT_MS),
      ],
    });

    const [entry] = await tickManagedSchedules(runner.seams);

    expect(entry.attempts).toBe(3);
    expect(entry.disposition).toBe("missed");
    expect(runner.advances[0].advance.schedule.consecutiveMisses).toBe(1);
  });

  test("leaves a window whose failures are all local uncounted", async () => {
    // The same window minus the no-show waits, which is what keeps the fold
    // from becoming a blanket "any failure is a miss": nothing here waited on
    // an absent partner, so the window says nothing about whether the two
    // runners are still meeting.
    const runner = harness({
      records: [recordWith()],
      startAt: "2026-01-06T14:00:00.000Z",
      script: [transientThroughTheClose(0)],
    });

    const [entry] = await tickManagedSchedules(runner.seams);

    expect(entry.attempts).toBe(1);
    expect(entry.disposition).toBe("failed");
    expect(runner.advances[0].advance.schedule.consecutiveMisses).toBe(0);
  });

  test("leaves the window failed when a handshake that failed closed trails the no-show waits", async () => {
    // The partnership MET here: the authenticated key exchange runs only over a
    // channel already open to the partner, so promoting this window to "missed"
    // on the earlier waits would count a coordination miss against a window that
    // raises a desync question instead (docs/spec/MANAGED_EXCHANGE_RECORD.md,
    // the `consecutiveMisses` row).
    const runner = harness({
      records: [recordWith()],
      startAt: "2026-01-06T14:00:00.000Z",
      script: [
        ...noShowScript(),
        {
          kind: "fail",
          error: new ConnectionError("key exchange failed", "security"),
        },
      ],
    });

    const [entry] = await tickManagedSchedules(runner.seams);

    expect(entry.attempts).toBe(2);
    expect(entry.disposition).toBe("failed");
    expect(runner.advances[0].advance.schedule.consecutiveMisses).toBe(0);
  });

  test("leaves the window failed when a rotation persist failure trails the no-show waits", async () => {
    // The partner arrived late in the window and the handshake completed -- the
    // persist failure is raised only after it yielded the rotated secret -- so
    // this window is the benign storage tier's, not the miss count's.
    const runner = harness({
      records: [recordWith()],
      startAt: "2026-01-06T14:00:00.000Z",
      script: [
        ...noShowScript(),
        {
          kind: "fail",
          error: new RotationPersistError(
            at("2026-01-06T14:20:00.000Z"),
            new Error("the store refused the write"),
          ),
        },
      ],
    });

    const [entry] = await tickManagedSchedules(runner.seams);

    expect(entry.attempts).toBe(2);
    expect(entry.disposition).toBe("failed");
    expect(runner.advances[0].advance.schedule.consecutiveMisses).toBe(0);
  });

  test("leaves the window failed when a drop past the data exchange trails the no-show waits", async () => {
    // Past that phase boundary the run had a partner to send payload to, which
    // decides the question the miss count asks whatever the earlier waits found.
    const runner = harness({
      records: [recordWith()],
      startAt: "2026-01-06T14:00:00.000Z",
      script: [
        ...noShowScript(),
        {
          kind: "fail",
          error: new Error("the channel dropped mid-exchange"),
          startsDataExchange: true,
        },
      ],
    });

    const [entry] = await tickManagedSchedules(runner.seams);

    expect(entry.attempts).toBe(2);
    expect(entry.disposition).toBe("failed");
    expect(runner.advances[0].advance.schedule.consecutiveMisses).toBe(0);
  });

  test("takes the success when any attempt completed the exchange", async () => {
    const runner = harness({
      records: [recordWith()],
      startAt: "2026-01-06T14:00:00.000Z",
      script: [...noShowScript(), { kind: "succeed" }],
    });

    const [entry] = await tickManagedSchedules(runner.seams);

    expect(entry.attempts).toBe(2);
    expect(entry.disposition).toBe("succeeded");
    expect(runner.advances[0].advance.schedule.consecutiveMisses).toBe(0);
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

  test("dominates the no-show waits the same window already took", async () => {
    // The two findings a window can hold at once: attempts that waited out an
    // absent partner, then a refusal that says another context is running this
    // very record. The refusal wins -- the window is that context's to account
    // for -- so nothing here is counted as a miss.
    const record = recordWith();
    const runner = harness({
      records: [record],
      startAt: "2026-01-06T14:00:00.000Z",
      script: [
        ...noShowScript(),
        ...noShowScript(),
        {
          kind: "fail",
          error: new ManagedExchangeLockUnavailableError(record.id),
        },
      ],
    });

    const [entry] = await tickManagedSchedules(runner.seams);

    expect(entry.attempts).toBe(3);
    expect(entry.disposition).toBe("unattempted");
    expect(runner.advances[0].advance.schedule).toMatchObject({
      nextWindow: "2026-01-13T14:00:00.000Z",
      consecutiveMisses: 0,
    });
    expect(runner.advances[0].advance.lastRun).toBeUndefined();
  });

  /** A record already one miss into the count, refused the lock at its window,
   * driven to the wake after the refusal advanced past that window. */
  async function refusedThenWokenAgain(): Promise<{
    record: ManagedExchangeRecord;
    runner: Harness;
    wake: (concurrent?: ManagedExchangeRecord["lastRun"]) => Promise<void>;
  }> {
    const record = recordWith({
      schedule: { ...weekly, consecutiveMisses: 1 },
    });
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
    await tickManagedSchedules(runner.seams);
    return {
      record,
      runner,
      wake: async (concurrent) => {
        const held = runner.stored.get(record.id);
        if (held === undefined) throw new Error("the record went missing");
        // The other context's run settles inside the window, AFTER the refusal
        // advanced past it -- the ordering the defect lives in.
        if (concurrent !== undefined)
          runner.stored.set(
            record.id,
            applyManagedExchangeLastRun(held, concurrent),
          );
        runner.advanceClock(60 * 60 * 1000);
        await tickManagedSchedules(runner.seams);
      },
    };
  }

  test("credits the concurrent run that succeeded inside it", async () => {
    // The refusal advances the plan past a window whose run is still in flight,
    // so that run's bookkeeping lands in a window the walk no longer visits.
    // Uncredited, a success could not reset the count, and the two-miss
    // escalation would fire a window early.
    const { record, runner, wake } = await refusedThenWokenAgain();

    await wake({ at: "2026-01-06T14:40:00.000Z", outcome: "succeeded" });

    expect(runner.advances[1].advance).toMatchObject({
      fromNextWindow: "2026-01-13T14:00:00.000Z",
      fromConsecutiveMisses: 1,
      schedule: {
        nextWindow: "2026-01-13T14:00:00.000Z",
        consecutiveMisses: 0,
      },
    });
    expect(runner.stored.get(record.id)?.schedule?.consecutiveMisses).toBe(0);
  });

  test("stays exactly unattempted when no concurrent run recorded anything", async () => {
    const { record, runner, wake } = await refusedThenWokenAgain();

    await wake();

    // Neither an attempt nor a miss: the window is the other context's to
    // account for, and it accounted for nothing.
    expect(runner.advances).toHaveLength(1);
    expect(runner.stored.get(record.id)?.schedule).toMatchObject({
      nextWindow: "2026-01-13T14:00:00.000Z",
      consecutiveMisses: 1,
    });
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
    // The registry the runtime passes across its wakes; the guard is what it
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
    // An artifact holds no input handle (it is a device-local platform
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

describe("a stored entry the read could not parse", () => {
  test("is skipped and named, while every other due record still runs", async () => {
    const healthy = recordWith();
    const runner = harness({
      records: [healthy],
      startAt: "2026-01-06T14:30:00.000Z",
      script: [{ kind: "succeed" }],
      // An out-of-bounds or app-upgrade-invalidated entry: unparseable until an
      // operator discards it, so failing the wake on it would stop every
      // scheduled exchange in the store, standing, at every wake.
      unreadableIds: ["legacy-out-of-bounds"],
    });

    const entries = await tickManagedSchedules(runner.seams);

    expect(entries).toContainEqual({
      id: "legacy-out-of-bounds",
      caughtUpMisses: 0,
      attempts: 0,
      skipped: "unreadable",
    });
    const ran = entries.find((entry) => entry.id === healthy.id);
    expect(ran?.disposition).toBe("succeeded");
    expect(runner.attempts.map((attempt) => attempt.id)).toEqual([healthy.id]);
  });

  test("has nothing attempted or written for it", async () => {
    const runner = harness({
      records: [],
      startAt: "2026-01-06T14:30:00.000Z",
      unreadableIds: ["first-bad", "second-bad"],
    });

    const entries = await tickManagedSchedules(runner.seams);

    expect(entries.map((entry) => entry.skipped)).toEqual([
      "unreadable",
      "unreadable",
    ]);
    expect(runner.attempts).toHaveLength(0);
    expect(runner.advances).toHaveLength(0);
  });

  test("does not enter the in-flight registry it would never leave", async () => {
    const runner = harness({
      records: [],
      startAt: "2026-01-06T14:30:00.000Z",
      unreadableIds: ["legacy-out-of-bounds"],
    });
    const inFlight = new Set<string>();

    await tickManagedSchedules(runner.seams, inFlight);

    // Nothing runs for it, so nothing settles to clear it: an entry left in the
    // registry would report as `"in-flight"` at every later wake instead of as
    // the unreadable entry it is.
    expect([...inFlight]).toEqual([]);
    const second = await tickManagedSchedules(runner.seams, inFlight);
    expect(second[0].skipped).toBe("unreadable");
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
