import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import log from "loglevel";

import {
  DISCLOSURE_NOT_FILED_WARNING,
  runManagedExchangeInBrowser,
} from "../../src/psi/managedRunDriver.js";
import {
  browserScheduleTickSeams,
  droppableUnattendedNotice,
  startManagedScheduleRuntime,
} from "../../src/psi/managedScheduleRuntime.js";
import { CLOSE_OUTCOME_WARNINGS } from "../../src/psi/exchangeLifecycle.js";

import type { ManagedExchangeRecord } from "../../src/psi/managedExchangeRecord.js";
import type { ManagedRunDriverConfig } from "../../src/psi/managedRunDriver.js";
import type { ManagedScheduleTickSeams } from "../../src/psi/managedScheduleRunner.js";

/**
 * The browser half of the unattended runner: what it hands the run driver, what
 * it does with the two notices the driver raises, and the host loop that wakes
 * the tick. The driver itself is mocked -- the run it performs is
 * managedRunDriver's own suite -- so what is asserted here is the wiring's
 * choices, which are the ones that make a scheduled run the SAME run an attended
 * one is: the same entry point, the same fail-fast single-writer lock, and the
 * unattended read of the persisted handle.
 */

// The real module is kept for its notice constant (the sink's whole decision is
// which notice it was handed, so asserting against a copy of the text would
// assert nothing), with only the run replaced.
vi.mock("../../src/psi/managedRunDriver.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runManagedExchangeInBrowser: vi.fn(),
}));
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

describe("the two notices an unattended run can raise", () => {
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
});

describe("the host that wakes the tick", () => {
  /** A tick that resolves when the test releases it, so a second wake can be
   * driven while the first is still running. */
  function pausedTick() {
    const calls: Array<() => void> = [];
    const tick = vi.fn(
      () =>
        new Promise<[]>((resolve) => {
          calls.push(() => resolve([]));
        }),
    );
    return { tick, release: () => calls.forEach((done) => done()) };
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

  test("does not re-enter a tick that is still occupying a window", async () => {
    vi.useFakeTimers();
    const { tick, release } = pausedTick();

    startManagedScheduleRuntime({
      signal: new AbortController().signal,
      intervalMs: 1000,
      tick,
      seams,
    });

    await vi.advanceTimersByTimeAsync(5000);
    expect(tick).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(tick).toHaveBeenCalledTimes(2);
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
