/// <reference types="@vitest/browser-playwright/context" />
/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@psilink/core";

import {
  clearManagedExchanges,
  createManagedExchange,
  getManagedExchange,
  listReadableManagedExchanges,
  persistManagedExchangeScheduleAdvance,
} from "@psi/managed/managedExchangeStore";
import { ManagedExchangeLockUnavailableError } from "@psi/managed/managedExchangeLock";
import { composeManagedExchangeFile } from "@psi/managed/managedExchangeRecord";
import { listManagedLocalState } from "@psi/managed/managedLocalState";
import { runManagedRerun } from "@psi/managed/managedRun";
import { tickManagedSchedules } from "@psi/managed/managedScheduleRunner";

import type { ManagedExchangeRecord } from "@psi/managed/managedExchangeRecord";
import type { ManagedScheduleTickSeams } from "@psi/managed/managedScheduleRunner";
import type { WebRTCExchangeLocator } from "@psilink/core";

// The two run paths against each other, on real Chromium Web Locks and real
// IndexedDB: an attended Run and a scheduled attempt are the two contexts that
// can meet over one record, and the single-writer lock is what keeps at most one
// of them exchanging with the partner. Both directions go through the real run
// path, so the acquisition, the refusal, and the window's own bookkeeping are
// the ones the app runs.

const WINDOW_SECONDS = 60 * 60;

const linkageTerms = getDefaultLinkageTerms("County Health Dept");
const webrtcLocator: WebRTCExchangeLocator = {
  channel: "webrtc",
  host: "signaling.example.org",
  port: 3000,
  path: "/api/",
};

/** A deferred promise, so a test can hold a run's payload exchange open across
 * the moment the other context tries to start one. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = () => {
      settle();
    };
  });
  return { promise, resolve };
}

/** A handle the runner accepts as the record's input pointer. Nothing under test
 * reads through it: every run's phases are supplied by this file. */
async function inputHandle(): Promise<FileSystemFileHandle> {
  const root = await navigator.storage.getDirectory();
  return await root.getFileHandle("exclusion-input.csv", { create: true });
}

/** A record whose schedule window is open now, so one tick occupies it. */
async function recordWithOpenWindow(): Promise<ManagedExchangeRecord> {
  const openedAt = new Date().toISOString();
  return await createManagedExchange({
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: webrtcLocator,
      linkageTerms,
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
    inputFileHandle: await inputHandle(),
    schedule: {
      anchor: openedAt,
      intervalDays: 7,
      windowSeconds: WINDOW_SECONDS,
      nextWindow: openedAt,
      consecutiveMisses: 0,
    },
  });
}

/** The platform boundaries one tick runs on, wired to the real store, with each
 * attempt going through the real attended run path on the scheduled runtime's
 * own fail-fast lock discipline. `attempt` supplies each attempt's phases. */
function scheduleTickSeams(attempt: {
  handshake: () => Promise<{ rotatedSecret: string; handshake: string }>;
  dataExchange: () => Promise<string>;
}): ManagedScheduleTickSeams {
  return {
    now: Date.now,
    listRecords: listReadableManagedExchanges,
    listLocalState: listManagedLocalState,
    persistAdvance: persistManagedExchangeScheduleAdvance,
    delay: () => Promise.resolve(),
    stopped: () => false,
    runAttempt: (scheduled) =>
      runManagedRerun(
        scheduled.record,
        {
          acquireInput: () => Promise.resolve(undefined),
          handshake: attempt.handshake,
          dataExchange: attempt.dataExchange,
        },
        {
          lock: { ifAvailable: true },
          onDataExchangeStart: scheduled.onDataExchangeStart,
        },
      ),
  };
}

beforeEach(async () => {
  await clearManagedExchanges();
});

afterEach(async () => {
  await clearManagedExchanges();
});

describe("an attended Run exchanging when a scheduled attempt is due", () => {
  test("the attempt does not exchange, counts no miss, and leaves the Run's success", async () => {
    const created = await recordWithOpenWindow();
    const rotatedSecret = generateSharedSecret();
    const exchanging = deferred();
    const releaseExchange = deferred();
    let scheduledHandshakes = 0;

    const attended = runManagedRerun(
      created,
      {
        acquireInput: () => Promise.resolve(undefined),
        handshake: () =>
          Promise.resolve({ rotatedSecret, handshake: "attended" }),
        dataExchange: async () => {
          await releaseExchange.promise;
          return "exchanged";
        },
      },
      { lock: { ifAvailable: true }, onDataExchangeStart: exchanging.resolve },
    );
    await exchanging.promise;

    const [entry] = await tickManagedSchedules(
      scheduleTickSeams({
        handshake: () => {
          scheduledHandshakes += 1;
          return Promise.resolve({
            rotatedSecret: generateSharedSecret(),
            handshake: "scheduled",
          });
        },
        dataExchange: () => Promise.resolve("scheduled"),
      }),
    );

    releaseExchange.resolve();
    await attended;

    // No second exchange: the attempt was refused the lock before its handshake.
    expect(scheduledHandshakes).toBe(0);
    // Not a no-show either -- the window records no attempt of its own, so the
    // miss count the retry policy reads stands still.
    expect(entry.disposition).toBe("unattempted");
    const stored = await getManagedExchange(created.id);
    expect(stored?.schedule?.consecutiveMisses).toBe(0);
    // And the attended Run's own outcome is the record's, unwritten over.
    expect(stored?.lastRun?.outcome).toBe("succeeded");
    expect(stored?.sharedSecret).toBe(rotatedSecret);
  });
});

describe("a scheduled attempt exchanging when the operator runs by hand", () => {
  test("the attended Run is refused for the whole exchange", async () => {
    const created = await recordWithOpenWindow();
    const rotatedSecret = generateSharedSecret();
    const exchanging = deferred();
    const releaseExchange = deferred();

    const tick = tickManagedSchedules(
      scheduleTickSeams({
        handshake: () =>
          Promise.resolve({ rotatedSecret, handshake: "scheduled" }),
        dataExchange: async () => {
          exchanging.resolve();
          await releaseExchange.promise;
          return "scheduled";
        },
      }),
    );
    await exchanging.promise;

    try {
      // The operator opens the app mid-exchange and presses Run: refused, and
      // told a run is already in progress, rather than dialing the partner a
      // second time.
      await expect(
        runManagedRerun(
          created,
          {
            acquireInput: () => Promise.resolve(undefined),
            handshake: () => {
              throw new Error("the attended Run must not reach the handshake");
            },
            dataExchange: () => {
              throw new Error("the attended Run must not exchange");
            },
          },
          { lock: { ifAvailable: true } },
        ),
      ).rejects.toBeInstanceOf(ManagedExchangeLockUnavailableError);
    } finally {
      releaseExchange.resolve();
    }

    const [entry] = await tick;
    expect(entry.disposition).toBe("succeeded");
    const stored = await getManagedExchange(created.id);
    expect(stored?.lastRun?.outcome).toBe("succeeded");
    expect(stored?.sharedSecret).toBe(rotatedSecret);
  });
});
