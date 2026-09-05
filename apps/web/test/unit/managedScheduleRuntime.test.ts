import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import log from "loglevel";

import { describeResolvedRunShape } from "@psilink/core";

import {
  DISCLOSURE_NOT_FILED_WARNING,
  runManagedExchangeInBrowser,
} from "../../src/psi/managed/managedRunDriver.js";
import {
  browserScheduleTickSeams,
  droppableUnattendedNotice,
  startManagedScheduleRuntime,
} from "../../src/psi/managed/managedScheduleRuntime.js";
import { CLOSE_OUTCOME_WARNINGS } from "../../src/psi/exchangeLifecycle.js";
import { listReadableManagedExchanges } from "../../src/psi/managed/managedExchangeStore.js";

import type { ManagedExchangeRecord } from "../../src/psi/managed/managedExchangeRecord.js";
import type { ManagedRunDriverConfig } from "../../src/psi/managed/managedRunDriver.js";
import type { ManagedScheduleTickSeams } from "../../src/psi/managed/managedScheduleRunner.js";

/**
 * The browser half of the unattended runner: what it hands the run driver, what
 * it does with notices the driver raises, and the host loop that wakes the tick.
 * The driver itself is mocked (its own suite is managedRunDriver's), so this
 * asserts only the wiring choices that make a scheduled run the SAME run an
 * attended one is: the same entry point, the same fail-fast single-writer lock,
 * and the unattended read of the persisted handle.
 */

// The real module is kept for its notice constant (the sink's whole decision is
// which notice it was handed, so asserting against a copy of the text would
// assert nothing), with only the run replaced.
vi.mock(
  "../../src/psi/managed/managedRunDriver.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    runManagedExchangeInBrowser: vi.fn(),
  }),
);
// The WASM engine the real driver module pulls in; never loaded for a run that
// is mocked.
vi.mock("@openmined/psi.js/psi_wasm_web", () => ({
  default: () => Promise.resolve({}),
}));

const mockedRun = vi.mocked(runManagedExchangeInBrowser);

const RECORD = { id: "record-under-test" } as ManagedExchangeRecord;

const SOURCE = {
  kind: "handle" as const,
  handle: {} as FileSystemFileHandle,
  attendance: "unattended" as const,
};

function attempt(onDataExchangeStart = () => undefined) {
  return {
    record: RECORD,
    source: SOURCE,
    peerWaitTimeoutMs: 42_000,
    onDataExchangeStart,
  };
}

/** The config the mocked driver was called with. */
function driverConfig(): ManagedRunDriverConfig {
  return mockedRun.mock.calls[0][0];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("window", {
    URL: {
      createObjectURL: vi.fn((blob: Blob) => `blob:${String(blob.size)}`),
      revokeObjectURL: vi.fn(),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("what a scheduled attempt hands the run driver", () => {
  test("is the same entry, lock discipline, and unattended handle read an attended run takes", async () => {
    mockedRun.mockResolvedValue(
      undefined as unknown as Awaited<
        ReturnType<typeof runManagedExchangeInBrowser>
      >,
    );
    const controller = new AbortController();
    const onDataExchangeStart = vi.fn();

    await browserScheduleTickSeams(controller.signal).runAttempt(
      attempt(onDataExchangeStart),
    );

    expect(mockedRun).toHaveBeenCalledTimes(1);
    const config = driverConfig();
    expect(config.record).toBe(RECORD);
    expect(config.source).toBe(SOURCE);
    expect(config.signal).toBe(controller.signal);
    expect(config.peerWaitTimeoutMs).toBe(42_000);
    // Fail-fast, exactly as the attended surface: a run already in progress in
    // another tab is a window this runner defers to rather than queues behind.
    expect(config.options?.lock).toEqual({ ifAvailable: true });
    config.options?.onDataExchangeStart?.();
    expect(onDataExchangeStart).toHaveBeenCalledTimes(1);
  });

  test("revokes the object URLs the run's outputs were built into, however it settles", async () => {
    const controller = new AbortController();
    const seams = browserScheduleTickSeams(controller.signal);
    const built = (config: ManagedRunDriverConfig) => {
      config.urls.create(new Blob(["results"]));
      config.urls.create(new Blob(["record"]));
    };

    mockedRun.mockImplementation((config) => {
      built(config);
      return Promise.resolve(
        undefined as unknown as Awaited<
          ReturnType<typeof runManagedExchangeInBrowser>
        >,
      );
    });
    await seams.runAttempt(attempt());
    expect(window.URL.revokeObjectURL).toHaveBeenCalledTimes(2);

    mockedRun.mockImplementation((config) => {
      built(config);
      return Promise.reject(new Error("the channel dropped"));
    });
    await expect(seams.runAttempt(attempt())).rejects.toThrow(
      "the channel dropped",
    );
    expect(window.URL.revokeObjectURL).toHaveBeenCalledTimes(4);
  });
});

describe("the notices an unattended run can raise", () => {
  test("are not one thing: the close outcome is droppable, the unfiled disclosure is not", () => {
    const closeOutcomes = Object.values(CLOSE_OUTCOME_WARNINGS).filter(
      (warning): warning is string => warning !== undefined,
    );
    expect(closeOutcomes.length).toBeGreaterThan(0);
    for (const warning of closeOutcomes)
      expect(droppableUnattendedNotice(warning)).toBe(true);
    expect(droppableUnattendedNotice(DISCLOSURE_NOT_FILED_WARNING)).toBe(false);
    // Dropping is a positive match, so a notice this policy has never seen
    // reaches the log rather than being swallowed.
    expect(droppableUnattendedNotice("a notice added later")).toBe(false);
  });

  test("reach the diagnostic log only for the one that is not droppable", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const closeOutcome = Object.values(CLOSE_OUTCOME_WARNINGS).find(
      (warning): warning is string => warning !== undefined,
    );
    mockedRun.mockImplementation((config) => {
      config.onWarning?.(closeOutcome as string);
      config.onWarning?.(DISCLOSURE_NOT_FILED_WARNING);
      return Promise.resolve(
        undefined as unknown as Awaited<
          ReturnType<typeof runManagedExchangeInBrowser>
        >,
      );
    });

    await browserScheduleTickSeams(new AbortController().signal).runAttempt(
      attempt(),
    );

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][1])).toContain(
      "could not be saved to this exchange's accounting",
    );
    warn.mockRestore();
  });

  test("both notices holding the run's resolved shape reach the diagnostic log", async () => {
    // The unattended seat is the one where a widening of the match goes
    // unnoticed: nobody is watching, and the terms it resolves from are a
    // standing record, not something authored this morning. The pre-round
    // notices must leave a line behind rather than being swallowed by the drop
    // policy above, which does not name them. Asserted with the strings core
    // actually composes, since the sink's whole decision is which notice it was handed.
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const { cardinalityNotice, pairTableAdvisory } = describeResolvedRunShape({
      cardinality: "many-to-many",
      localRecordCount: 3163,
      localDeclaredRecordCount: 3163,
      partnerRecordCount: 3164,
      localExpectsOutput: true,
      partnerAssociationTableWithheld: false,
    });
    mockedRun.mockImplementation((config) => {
      config.onWarning?.(cardinalityNotice!);
      config.onWarning?.(pairTableAdvisory!);
      return Promise.resolve(
        undefined as unknown as Awaited<
          ReturnType<typeof runManagedExchangeInBrowser>
        >,
      );
    });

    await browserScheduleTickSeams(new AbortController().signal).runAttempt(
      attempt(),
    );

    // Verbatim: the display boundary the sink folds them through escapes what
    // needs it, and first-party ASCII prose needs none.
    expect(warn.mock.calls.map((call) => String(call[1]))).toEqual([
      cardinalityNotice,
      pairTableAdvisory,
    ]);
    warn.mockRestore();
  });
});

describe("the store read a wake takes", () => {
  test("is the per-entry one, never the strict list a single bad record fails", () => {
    // The strict read rejects the whole list on one unparseable entry. Nobody is
    // present at a wake to meet the read-failed recovery surface that rejection
    // routes to, so taking it here would stop every scheduled exchange in the
    // store for as long as that entry sat in it.
    expect(
      browserScheduleTickSeams(new AbortController().signal).listRecords,
    ).toBe(listReadableManagedExchanges);
  });
});

describe("the host that wakes the tick", () => {
  /** The record the paused tick below is occupying a window for. */
  const OCCUPIED = "record-occupying-its-window";

  /** A tick that resolves when the test releases it, so a second wake can be
   * driven while the first is still running. It keeps the real tick's side of
   * the contract -- the record it is running is entered in the registry the host
   * hands it, and removed when it settles -- so what this suite drives is the
   * host's half. The registry's own per-record guard is the real tick's, in
   * test/unit/managedScheduleRunner.test.ts. */
  function pausedTick() {
    const registries: Array<Set<string>> = [];
    const calls: Array<() => void> = [];
    const tick = vi.fn(
      (_seams: ManagedScheduleTickSeams, inFlight: Set<string>) => {
        registries.push(inFlight);
        inFlight.add(OCCUPIED);
        return new Promise<[]>((resolve) => {
          calls.push(() => {
            inFlight.delete(OCCUPIED);
            resolve([]);
          });
        });
      },
    );
    return {
      tick,
      registries,
      release: () => calls.forEach((done) => done()),
    };
  }

  const seams = {} as ManagedScheduleTickSeams;

  test("wakes once immediately, then on the interval", async () => {
    vi.useFakeTimers();
    const tick = vi.fn(() => Promise.resolve([]));

    startManagedScheduleRuntime({
      signal: new AbortController().signal,
      intervalMs: 1000,
      tick,
      seams,
    });

    // The first wake is immediate: a launch owes the catch-up rule to every
    // record whose windows elapsed while this runtime was not running.
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(tick).toHaveBeenCalledTimes(3);
  });

  test("keeps waking while a window is occupied, on one registry the guard spans", async () => {
    vi.useFakeTimers();
    const { tick, registries, release } = pausedTick();

    startManagedScheduleRuntime({
      signal: new AbortController().signal,
      intervalMs: 1000,
      tick,
      seams,
    });

    await vi.advanceTimersByTimeAsync(5000);

    // Occupying a window can take the width of that window. What is held back
    // is the occupied RECORD, not the wake, so an exchange whose window opens
    // meanwhile is picked up at the next wake rather than after the occupancy
    // ends.
    expect(tick).toHaveBeenCalledTimes(6);
    // One registry, handed to every wake: that identity is what holds the
    // per-record guard across them.
    expect(new Set(registries).size).toBe(1);
    expect([...registries[registries.length - 1]]).toEqual([OCCUPIED]);

    release();
    await vi.advanceTimersByTimeAsync(0);
    // And it empties as the occupancy settles, so the record is available to
    // the wake after that -- which still comes on the interval.
    expect([...registries[0]]).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(tick).toHaveBeenCalledTimes(7);
  });

  test("stops waking once the runtime is torn down", async () => {
    vi.useFakeTimers();
    const tick = vi.fn(() => Promise.resolve([]));
    const controller = new AbortController();

    startManagedScheduleRuntime({
      signal: controller.signal,
      intervalMs: 1000,
      tick,
      seams,
    });
    await vi.advanceTimersByTimeAsync(1000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(tick).toHaveBeenCalledTimes(2);
  });

  test("starts nothing at all on a signal that has already aborted", async () => {
    vi.useFakeTimers();
    const tick = vi.fn(() => Promise.resolve([]));
    const controller = new AbortController();
    controller.abort();

    startManagedScheduleRuntime({
      signal: controller.signal,
      intervalMs: 1000,
      tick,
      seams,
    });

    // An abort listener attached to an already-aborted signal never fires, so
    // an interval created ahead of it would survive with nothing left to clear
    // it -- for the life of the page, in a runtime that was told to stop.
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tick).not.toHaveBeenCalled();
  });

  test("warns about a stored entry the read could not parse, naming its recovery", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const tick = vi.fn(() =>
      Promise.resolve([
        {
          id: "legacy-out-of-bounds",
          caughtUpMisses: 0,
          attempts: 0,
          skipped: "unreadable" as const,
        },
      ]),
    );

    startManagedScheduleRuntime({
      signal: new AbortController().signal,
      intervalMs: 1000,
      tick,
      seams,
    });
    await vi.advanceTimersByTimeAsync(0);

    // A skip that stands until an operator acts, so it is a warning rather than
    // the triage-level debug line the transient skips take.
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain("legacy-out-of-bounds");
    expect(line).toContain("saved exchanges list");
    warn.mockRestore();
  });

  test("reports a tick that threw rather than leaving it unhandled", async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const tick = vi.fn(() => Promise.reject(new Error("the store is gone")));

    startManagedScheduleRuntime({
      signal: new AbortController().signal,
      intervalMs: 1000,
      tick,
      seams,
    });
    await vi.advanceTimersByTimeAsync(1000);

    expect(error).toHaveBeenCalled();
    // A failed tick does not wedge the host: the next interval wakes it again.
    expect(tick).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });
});
