/// <reference types="@vitest/browser-playwright/context" />
/// <reference types="vite/client" />

import { afterEach, describe, expect, test } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@psilink/core";

import {
  ManagedExchangeLockUnavailableError,
  withManagedExchangeLock,
} from "@psi/managed/managedExchangeLock";
import {
  clearManagedExchanges,
  createManagedExchange,
  getManagedExchange,
  listReadableManagedExchanges,
  persistManagedExchangeScheduleAdvance,
  recordManagedExchangeLastRun,
} from "@psi/managed/managedExchangeStore";
import { PartnerNoShowError } from "@psi/transport/waitForConnection";
import { composeManagedExchangeFile } from "@psi/managed/managedExchangeRecord";
import { listManagedLocalState } from "@psi/managed/managedLocalState";
import { runManagedRerun } from "@psi/managed/managedRun";
import { succeededRun } from "@psi/managed/managedRunRotate";
import { tickManagedSchedules } from "@psi/managed/managedScheduleRunner";

import type {
  ManagedExchangeRecord,
  ManagedExchangeSchedule,
} from "@psi/managed/managedExchangeRecord";
import type { ManagedScheduleTickSeams } from "@psi/managed/managedScheduleRunner";
import type { WebRTCExchangeLocator } from "@psilink/core";

// The inter-attempt lock yield, against real Chromium Web Locks and real
// IndexedDB: that the run+rotate lock is genuinely free across a stand-down and
// held across an attempt, and that the orderings an operator's own Run can now
// create inside an occupied window leave that run's success standing and its
// window counted as met.
//
// Time is SCALED: the clock the runner reads advances SCALE times faster than
// real time, and every duration it asks to wait is divided by SCALE before the
// wait actually happens. So a ten-minute peer wait costs 600 ms here and a
// five-minute stand-down costs 300 ms, with the ordering between them intact.

const SCALE = 1000;
const WINDOW_SECONDS = 60 * 60;

const linkageTerms = getDefaultLinkageTerms("County Health Dept");
const webrtcLocator: WebRTCExchangeLocator = {
  channel: "webrtc",
  host: "signaling.example.org",
  port: 3000,
  path: "/api/",
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A deferred promise, so a test can hold an attended run's data exchange open
 * across the moment the next scheduled attempt begins. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = () => {
      r();
    };
  });
  return { promise, resolve };
}

/** A handle the runner accepts as the record's input pointer. Nothing under
 * test reads through it: the run's phases are supplied by this file. */
async function inputHandle(): Promise<FileSystemFileHandle> {
  const root = await navigator.storage.getDirectory();
  return await root.getFileHandle("scheduled-input.csv", { create: true });
}

/** Whether an operator's own Run could take the record's lock at this instant,
 * on the attended surface's own fail-fast discipline. */
async function attendedRunCouldStart(id: string): Promise<boolean> {
  try {
    await withManagedExchangeLock(id, () => Promise.resolve(), {
      ifAvailable: true,
    });
    return true;
  } catch (error) {
    if (error instanceof ManagedExchangeLockUnavailableError) return false;
    throw error;
  }
}

interface ScheduledWindow {
  record: ManagedExchangeRecord;
  openedAtMs: number;
  seams: ManagedScheduleTickSeams;
  /** How many attempts the occupancy made. */
  attempts: () => number;
}

/**
 * Stand up a record whose window is open now and the seams to occupy it: the
 * real store on every side, a scaled clock, and attempts that go through the
 * real attended run path (so the real lock, the real spent check, and the real
 * bookkeeping writes) with a partner who never arrives.
 */
async function scheduledWindow(hooks: {
  /** Runs inside an attempt, while the lock is held. `record` is the one that
   * attempt carries, which after the first is what the loop head re-read. */
  duringAttempt?: (context: {
    id: string;
    attempt: number;
    now: () => number;
    record: ManagedExchangeRecord;
  }) => Promise<void>;
  /** Runs during a stand-down, while no lock is held. */
  duringStandDown?: (context: {
    id: string;
    now: () => number;
  }) => Promise<void>;
}): Promise<ScheduledWindow> {
  const openedAtMs = Date.now();
  const schedule: ManagedExchangeSchedule = {
    anchor: new Date(openedAtMs).toISOString(),
    intervalDays: 7,
    windowSeconds: WINDOW_SECONDS,
    nextWindow: new Date(openedAtMs).toISOString(),
    consecutiveMisses: 0,
  };
  const record = await createManagedExchange({
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: webrtcLocator,
      linkageTerms,
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
    inputFileHandle: await inputHandle(),
    schedule,
  });

  const realStart = performance.now();
  const now = (): number =>
    openedAtMs + Math.round((performance.now() - realStart) * SCALE);
  let attempts = 0;

  const seams: ManagedScheduleTickSeams = {
    now,
    listRecords: listReadableManagedExchanges,
    listLocalState: listManagedLocalState,
    persistAdvance: persistManagedExchangeScheduleAdvance,
    readRecord: getManagedExchange,
    delay: async (ms) => {
      await hooks.duringStandDown?.({ id: record.id, now });
      await sleep(ms / SCALE);
    },
    stopped: () => false,
    runAttempt: (attempt) =>
      runManagedRerun(
        attempt.record,
        {
          acquireInput: () => Promise.resolve(undefined),
          handshake: async () => {
            attempts += 1;
            await hooks.duringAttempt?.({
              id: record.id,
              attempt: attempts,
              now,
              record: attempt.record,
            });
            await sleep(attempt.peerWaitTimeoutMs / SCALE);
            throw new PartnerNoShowError(
              "timed out waiting for the other party",
            );
          },
          dataExchange: () =>
            Promise.reject(new Error("no data exchange in a no-show")),
        },
        {
          now,
          lock: { ifAvailable: true },
          onDataExchangeStart: attempt.onDataExchangeStart,
        },
      ),
  };

  return { record, openedAtMs, seams, attempts: () => attempts };
}

afterEach(async () => {
  await clearManagedExchanges();
});

describe("the run+rotate lock across a scheduled window's stand-down", () => {
  test("is held through an attempt and free across the stand-down", async () => {
    let heldDuringAttempt: boolean | undefined;
    let freeDuringStandDown: boolean | undefined;
    const window = await scheduledWindow({
      duringAttempt: async ({ id, attempt }) => {
        if (attempt === 1)
          heldDuringAttempt = !(await attendedRunCouldStart(id));
      },
      duringStandDown: async ({ id }) => {
        freeDuringStandDown ??= await attendedRunCouldStart(id);
      },
    });

    await tickManagedSchedules(window.seams);

    // The occupancy's whole point, and the whole of what the yield changes: an
    // attempt is exclusive, and the interval between two attempts is not.
    expect(heldDuringAttempt).toBe(true);
    expect(freeDuringStandDown).toBe(true);
    expect(window.attempts()).toBeGreaterThan(1);
  }, 120_000);

  test("an operator's run inside a stand-down takes the window, counting no miss", async () => {
    // An attended Run completes in the gap between two attempts. The next
    // attempt must not run the window a second time, and the window it met
    // must not fold to a miss.
    const window = await scheduledWindow({
      duringStandDown: async ({ id, now }) => {
        const stored = await getManagedExchange(id);
        if (stored?.lastRun?.outcome === "succeeded") return;
        // The attended run began inside this same gap and completed in it.
        const completedAtMs = now();
        await recordManagedExchangeLastRun(
          id,
          succeededRun(completedAtMs),
          completedAtMs - 10_000,
        );
      },
    });

    const [entry] = await tickManagedSchedules(window.seams);

    expect(entry.disposition).toBe("succeeded");
    expect(entry.attempts).toBe(1);
    const stored = await getManagedExchange(window.record.id);
    expect(stored?.lastRun?.outcome).toBe("succeeded");
    expect(stored?.schedule?.consecutiveMisses).toBe(0);
  }, 120_000);

  test("an operator's run that lands mid-attempt is not erased by the no-show", async () => {
    // The attended success is stamped while a scheduled attempt is already
    // waiting, so the attempt's own `missed` entry is the NEWER stamp. Left to
    // land it would erase the success permanently and count the met window as
    // a miss.
    const window = await scheduledWindow({
      duringAttempt: async ({ id, attempt, now }) => {
        if (attempt !== 1) return;
        const completedAtMs = now();
        await recordManagedExchangeLastRun(
          id,
          succeededRun(completedAtMs),
          completedAtMs,
        );
      },
    });

    const [entry] = await tickManagedSchedules(window.seams);

    const stored = await getManagedExchange(window.record.id);
    expect(stored?.lastRun?.outcome).toBe("succeeded");
    expect(entry.disposition).toBe("succeeded");
    expect(stored?.schedule?.consecutiveMisses).toBe(0);
  }, 120_000);

  test("an attended run still exchanging at the next loop head does not stop that attempt", async () => {
    // The ordering the stand-down makes reachable and neither guard covers: the
    // run lock releases at the rotation persist, so an attended run taken in a
    // stand-down can still be exchanging payload when the next attempt's re-read
    // runs. No success is stamped until that exchange ends, so the re-read finds
    // the window unmet and the attempt runs -- against the record the attended
    // run just rotated. This pins that ordering and what it does not cost: the
    // attended success is still the stored outcome and the window still counts
    // as met (see docs/spec/MANAGED_EXCHANGE_RECORD.md, "What the next attempt
    // re-reads", which states the limit).
    const rotatedSecret = generateSharedSecret();
    const exchanging = deferred();
    const releaseExchange = deferred();
    const secretsAttempted: Array<string> = [];
    let attended: Promise<unknown> | undefined;
    let storedWhileExchanging: ManagedExchangeRecord | undefined;

    const window = await scheduledWindow({
      duringStandDown: async ({ id, now }) => {
        if (attended !== undefined) return;
        const claimed = await getManagedExchange(id);
        if (claimed === undefined) throw new Error("the record went");
        attended = runManagedRerun(
          claimed,
          {
            acquireInput: () => Promise.resolve(undefined),
            handshake: () =>
              Promise.resolve({ rotatedSecret, handshake: "carried" }),
            dataExchange: async () => {
              await releaseExchange.promise;
              return "exchanged";
            },
          },
          {
            now,
            lock: { ifAvailable: true },
            onDataExchangeStart: exchanging.resolve,
          },
        );
        // Held here until the attended run is past its persist and its lock
        // release, so the stand-down ends with its data exchange in flight.
        await exchanging.promise;
        storedWhileExchanging = await getManagedExchange(id);
      },
      duringAttempt: ({ attempt, record }) => {
        secretsAttempted.push(record.sharedSecret);
        // The attended exchange completes while this attempt waits on its own
        // partner, so its success is stamped after the attempt began.
        if (attempt === 2) releaseExchange.resolve();
        return Promise.resolve();
      },
    });

    const [entry] = await tickManagedSchedules(window.seams);
    await attended;

    // What the loop head read: the rotation landed, and the only outcome
    // stored is the first attempt's own no-show -- the attended run stamps its
    // success only once the data exchange it is still running ends.
    expect(storedWhileExchanging?.sharedSecret).toBe(rotatedSecret);
    expect(storedWhileExchanging?.lastRun?.outcome).toBe("missed");
    // So a second attempt ran, carrying the record the attended run rotated.
    expect(secretsAttempted[0]).toBe(window.record.sharedSecret);
    expect(secretsAttempted[1]).toBe(rotatedSecret);
    // What the branch's guards still hold: the attended success is the stored
    // outcome, the window is met, and the attempt that ran alongside it -- a
    // no-show -- rotated nothing of its own.
    const stored = await getManagedExchange(window.record.id);
    expect(stored?.lastRun?.outcome).toBe("succeeded");
    expect(stored?.sharedSecret).toBe(rotatedSecret);
    expect(entry.disposition).toBe("succeeded");
    expect(stored?.schedule?.consecutiveMisses).toBe(0);
  }, 120_000);
});
