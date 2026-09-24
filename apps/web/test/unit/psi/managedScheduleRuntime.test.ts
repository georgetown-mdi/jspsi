import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { describeResolvedRunShape, getLogger } from "@alcove/core";

import {
  DISCLOSURE_NOT_FILED_WARNING,
  runManagedExchangeInBrowser,
} from "../../../src/psi/managed/managedRunDriver.js";
import {
  browserScheduleTickSeams,
  droppableUnattendedNotice,
  startManagedScheduleRuntime,
} from "../../../src/psi/managed/managedScheduleRuntime.js";
import { CLOSE_OUTCOME_WARNINGS } from "../../../src/psi/exchangeLifecycle.js";
import { listReadableManagedExchanges } from "../../../src/psi/managed/managedExchangeStore.js";

import {
  parkRunResults,
  recordParkedResultsRefusal,
  recordResultsTooLarge,
  recordResultsWrittenToFolder,
} from "../../../src/psi/parkedResultsStore.js";
import { MAX_PARKED_RESULT_BYTES } from "../../../src/psi/resultSizeProjection.js";

import type { ManagedExchangeRunResult } from "../../../src/psi/managed/managedExchangeRun.js";
import type { ManagedRunDriverConfig } from "../../../src/psi/managed/managedRunDriver.js";
import type { ManagedScheduleTickSeams } from "../../../src/psi/managed/managedScheduleRunner.js";
import type { RunOutputs } from "../../../src/psi/runOutputs.js";
import type { RunnableManagedExchangeRecord } from "../../../src/psi/managed/managedExchangeRecord.js";

const log = getLogger("managedScheduleRuntime");

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
  "../../../src/psi/managed/managedRunDriver.js",
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
// The parking store is IndexedDB, which this project has none of: its own suite
// is test/browser/managedExchangeStore.test.ts, and what is asserted here is
// which of its two writes a run reaches and with what.
vi.mock("../../../src/psi/parkedResultsStore.js", () => ({
  parkRunResults: vi.fn(),
  recordParkedResultsRefusal: vi.fn(),
  recordResultsTooLarge: vi.fn(),
  recordResultsWrittenToFolder: vi.fn(),
}));

const mockedRun = vi.mocked(runManagedExchangeInBrowser);
const mockedPark = vi.mocked(parkRunResults);
const mockedRefusal = vi.mocked(recordParkedResultsRefusal);
const mockedWrittenNote = vi.mocked(recordResultsWrittenToFolder);
const mockedTooLarge = vi.mocked(recordResultsTooLarge);

const RECORD = {
  id: "record-under-test",
  label: "Riverbend quarterly",
} as RunnableManagedExchangeRecord;

/** The granted output folder, as the run reaches it: a permission state it
 * reports without prompting, and a write that either takes the bytes or throws.
 * A real directory handle needs a picker grant no unit project can summon, so
 * the handle is built to the two platform calls the delivery makes. */
function grantedFolder({
  permission = "granted",
  write,
}: {
  permission?: "granted" | "denied" | "prompt";
  write?: () => Promise<never>;
} = {}) {
  const written: Array<{ fileName: string; text: string }> = [];
  const handle = {
    name: "Riverbend results",
    queryPermission: () => Promise.resolve(permission),
    getFileHandle: (fileName: string) =>
      Promise.resolve({
        createWritable: () =>
          Promise.resolve({
            write: async (blob: Blob) => {
              if (write !== undefined) await write();
              written.push({ fileName, text: await blob.text() });
            },
            close: () => Promise.resolve(),
            abort: () => Promise.resolve(),
          }),
      }),
  };
  return {
    written,
    record: {
      id: RECORD.id,
      label: RECORD.label,
      outputDirectoryHandle: handle as unknown as FileSystemDirectoryHandle,
    } as RunnableManagedExchangeRecord,
  };
}

/** An attempt against `record` rather than the folderless one above. */
function attemptFor(record: RunnableManagedExchangeRecord) {
  return { ...attempt(), record };
}

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

/** The instant the runs below stamp, which is also the instant their parked
 * results are held to their retention from. */
const RUN_AT = "2026-03-01T09:00:00.000Z";

/** A completed run as the driver reports one: the outputs it built and the
 * `succeeded` stamp it wrote. Defaults to a run whose agreed terms gave this
 * party no result table, which has nothing to park. */
function completedRun(
  outputs: RunOutputs = { kind: "withheld" },
): ManagedExchangeRunResult<RunOutputs> {
  return { exchange: outputs, lastRun: { at: RUN_AT, outcome: "succeeded" } };
}

/** A run that produced a result table, built through the runtime's own URL
 * boundary exactly as the outputs builder does. */
function matchedRun(config: ManagedRunDriverConfig, csv = "id,value\n1,a\n") {
  return completedRun({
    kind: "matched",
    resultsUrl: config.urls.create(new Blob([csv], { type: "text/csv" })),
    matchedRecordCount: 1,
  });
}

/** A run whose result file is `sizeBytes` long. The size is stated rather than
 * allocated: the delivery weighs `Blob.size` and hands the same object on, and a
 * real allocation past the bound would cost this suite a hundred megabytes to
 * assert an integer comparison. */
function sizedRun(config: ManagedRunDriverConfig, sizeBytes: number) {
  const blob = {
    size: sizeBytes,
    type: "text/csv",
    text: () => Promise.resolve("id,value\n1,a\n"),
  } as unknown as Blob;
  return completedRun({
    kind: "matched",
    resultsUrl: config.urls.create(blob),
    matchedRecordCount: 4_000_000,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("window", {
    URL: {
      createObjectURL: vi.fn((blob: Blob) => `blob:${String(blob.size)}`),
      revokeObjectURL: vi.fn(),
    },
  });
  // The feature detection the delivery gates the stored grant on; Node has no
  // File System Access API of its own.
  vi.stubGlobal("FileSystemDirectoryHandle", class {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("what a scheduled attempt hands the run driver", () => {
  test("is the same entry, lock discipline, and unattended handle read an attended run takes", async () => {
    mockedRun.mockResolvedValue(completedRun());
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
      return Promise.resolve(completedRun());
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

describe("what a completed unattended run leaves for the next visit", () => {
  test("parks the results file, under the run's own instant", async () => {
    mockedRun.mockImplementation((config) =>
      Promise.resolve(matchedRun(config)),
    );

    await browserScheduleTickSeams(new AbortController().signal).runAttempt(
      attempt(),
    );

    expect(mockedPark).toHaveBeenCalledTimes(1);
    const [id, parked] = mockedPark.mock.calls[0];
    expect(id).toBe(RECORD.id);
    expect(parked.kind).toBe("results");
    expect(parked.runAt).toBe(RUN_AT);
    expect(parked.matchedRecordCount).toBe(1);
    expect(parked.fileName).toContain("2026-03-01");
    // The bytes are the ones the run built, not a re-read of a revoked URL.
    expect(await parked.csv.text()).toBe("id,value\n1,a\n");
    expect(mockedRefusal).not.toHaveBeenCalled();
    // And the URL is still revoked: nobody is present to download one, and the
    // parked copy is what the next visit reads.
    expect(window.URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  test("parks nothing for a run that produced no result table", async () => {
    // A count-only run, or one whose agreed terms give this party no output: the
    // run's own bookkeeping already states what it did, and there is no file.
    mockedRun.mockResolvedValue(completedRun());
    await browserScheduleTickSeams(new AbortController().signal).runAttempt(
      attempt(),
    );
    expect(mockedPark).not.toHaveBeenCalled();
    expect(mockedRefusal).not.toHaveBeenCalled();
  });

  test("records the refused state when this browser will not store the results", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    mockedRun.mockImplementation((config) =>
      Promise.resolve(matchedRun(config)),
    );
    mockedPark.mockRejectedValue(new Error("the quota refused it"));

    await browserScheduleTickSeams(new AbortController().signal).runAttempt(
      attempt(),
    );

    // A named state under the same run instant, so the operator meets it at the
    // next visit rather than finding nothing where results should be.
    expect(mockedRefusal).toHaveBeenCalledWith(RECORD.id, RUN_AT);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test("never turns a completed run into a failed attempt, however the parking goes", async () => {
    // The run rotated its secret and filed its disclosure before this point, so
    // nothing the parking does may restate the attempt's outcome.
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    mockedRun.mockImplementation((config) =>
      Promise.resolve(matchedRun(config)),
    );
    mockedPark.mockRejectedValue(new Error("the quota refused it"));
    mockedRefusal.mockRejectedValue(new Error("the store is gone"));

    await expect(
      browserScheduleTickSeams(new AbortController().signal).runAttempt(
        attempt(),
      ),
    ).resolves.toBeUndefined();

    expect(error).toHaveBeenCalled();
    error.mockRestore();
    warn.mockRestore();
  });

  test("parks nothing for a run that failed", async () => {
    mockedRun.mockRejectedValue(new Error("the channel dropped"));
    await expect(
      browserScheduleTickSeams(new AbortController().signal).runAttempt(
        attempt(),
      ),
    ).rejects.toThrow("the channel dropped");
    expect(mockedPark).not.toHaveBeenCalled();
    expect(mockedRefusal).not.toHaveBeenCalled();
  });
});

describe("where a completed unattended run's results go", () => {
  // Each case states its own store outcome rather than inheriting the failure a
  // preceding case installed.
  beforeEach(() => {
    mockedPark.mockResolvedValue(undefined);
    mockedRefusal.mockResolvedValue(undefined);
    mockedWrittenNote.mockResolvedValue(undefined);
    mockedTooLarge.mockResolvedValue(undefined);
  });

  test("into the folder the operator granted, with nothing kept in this browser", async () => {
    const folder = grantedFolder();
    mockedRun.mockImplementation((config) =>
      Promise.resolve(matchedRun(config)),
    );

    await browserScheduleTickSeams(new AbortController().signal).runAttempt(
      attemptFor(folder.record),
    );

    // The results are in the folder, under the run's own instant so a later run
    // does not overwrite them.
    expect(folder.written).toHaveLength(1);
    expect(folder.written[0].fileName).toContain("2026-03-01");
    expect(folder.written[0].text).toBe("id,value\n1,a\n");
    // And the next visit is told where they went, without a second copy of the
    // rows at rest here.
    expect(mockedPark).not.toHaveBeenCalled();
    expect(mockedRefusal).not.toHaveBeenCalled();
    expect(mockedWrittenNote).toHaveBeenCalledTimes(1);
    const [id, note] = mockedWrittenNote.mock.calls[0];
    expect(id).toBe(RECORD.id);
    expect(note).toMatchObject({
      kind: "written",
      runAt: RUN_AT,
      directoryName: "Riverbend results",
      matchedRecordCount: 1,
    });
  });

  test("into this browser when the grant is not one a run with nobody present may use", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    // A grant the platform will not honour unattended, or one the operator
    // revoked: the run may query but never prompt, so the results are kept here.
    const folder = grantedFolder({ permission: "prompt" });
    mockedRun.mockImplementation((config) =>
      Promise.resolve(matchedRun(config)),
    );

    await browserScheduleTickSeams(new AbortController().signal).runAttempt(
      attemptFor(folder.record),
    );

    expect(folder.written).toHaveLength(0);
    expect(mockedWrittenNote).not.toHaveBeenCalled();
    expect(mockedPark).toHaveBeenCalledTimes(1);
    const [, parked] = mockedPark.mock.calls[0];
    // Named rather than reported as a plain success: the operator is owed which
    // of the two happened.
    expect(parked.fallback).toBe("ungranted");
    expect(await parked.csv.text()).toBe("id,value\n1,a\n");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test("into this browser when the write to the granted folder throws", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const folder = grantedFolder({
      write: () => Promise.reject(new Error("the disk is full")),
    });
    mockedRun.mockImplementation((config) =>
      Promise.resolve(matchedRun(config)),
    );

    await browserScheduleTickSeams(new AbortController().signal).runAttempt(
      attemptFor(folder.record),
    );

    expect(folder.written).toHaveLength(0);
    expect(mockedWrittenNote).not.toHaveBeenCalled();
    expect(mockedPark).toHaveBeenCalledTimes(1);
    expect(mockedPark.mock.calls[0][1].fallback).toBe("write-failed");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test("into this browser with no reason stated where no folder was granted", async () => {
    // The plain parking case: nothing failed, so the row says nothing about a
    // folder.
    mockedRun.mockImplementation((config) =>
      Promise.resolve(matchedRun(config)),
    );

    await browserScheduleTickSeams(new AbortController().signal).runAttempt(
      attempt(),
    );

    expect(mockedWrittenNote).not.toHaveBeenCalled();
    expect(mockedPark.mock.calls[0][1].fallback).toBeUndefined();
  });

  test("never turns a completed run into a failed attempt when the written note is refused", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const folder = grantedFolder();
    mockedRun.mockImplementation((config) =>
      Promise.resolve(matchedRun(config)),
    );
    mockedWrittenNote.mockRejectedValue(new Error("the store is gone"));

    await expect(
      browserScheduleTickSeams(new AbortController().signal).runAttempt(
        attemptFor(folder.record),
      ),
    ).resolves.toBeUndefined();

    // The results are in the folder, so the lost note parks no second copy.
    expect(folder.written).toHaveLength(1);
    expect(mockedPark).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("a result larger than this browser keeps", () => {
  beforeEach(() => {
    mockedPark.mockResolvedValue(undefined);
    mockedRefusal.mockResolvedValue(undefined);
    mockedWrittenNote.mockResolvedValue(undefined);
    mockedTooLarge.mockResolvedValue(undefined);
  });

  test("parks nothing, cuts nothing down, and records the state in their place", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    mockedRun.mockImplementation((config) =>
      Promise.resolve(sizedRun(config, MAX_PARKED_RESULT_BYTES + 1)),
    );

    await browserScheduleTickSeams(new AbortController().signal).runAttempt(
      attempt(),
    );

    expect(mockedPark).not.toHaveBeenCalled();
    expect(mockedRefusal).not.toHaveBeenCalled();
    expect(mockedTooLarge).toHaveBeenCalledTimes(1);
    const [id, tooLarge] = mockedTooLarge.mock.calls[0];
    expect(id).toBe(RECORD.id);
    expect(tooLarge).toMatchObject({
      kind: "too-large",
      runAt: RUN_AT,
      resultBytes: MAX_PARKED_RESULT_BYTES + 1,
      matchedRecordCount: 4_000_000,
    });
    expect(tooLarge.fallback).toBeUndefined();
    expect(warn.mock.calls.at(-1)?.[0]).toContain(
      "granting an output folder is what takes a result this size",
    );
    warn.mockRestore();
  });

  test("names the grant it could not use with nobody present, on the state and in the log", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const folder = grantedFolder({ permission: "prompt" });
    mockedRun.mockImplementation((config) =>
      Promise.resolve(sizedRun(config, MAX_PARKED_RESULT_BYTES + 1)),
    );

    await browserScheduleTickSeams(new AbortController().signal).runAttempt(
      attemptFor(folder.record),
    );

    expect(mockedTooLarge.mock.calls[0][1].fallback).toBe("ungranted");
    expect(warn.mock.calls.at(-1)?.[0]).toContain("granting it again");
    warn.mockRestore();
  });

  test("names the write that failed, on the state and in the log", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const folder = grantedFolder({
      write: () => Promise.reject(new Error("the disk is full")),
    });
    mockedRun.mockImplementation((config) =>
      Promise.resolve(sizedRun(config, MAX_PARKED_RESULT_BYTES + 1)),
    );

    await browserScheduleTickSeams(new AbortController().signal).runAttempt(
      attemptFor(folder.record),
    );

    expect(mockedTooLarge.mock.calls[0][1].fallback).toBe("write-failed");
    expect(warn.mock.calls.at(-1)?.[0]).toContain("still exists and has room");
    warn.mockRestore();
  });

  test("still parks a result at the bound itself", async () => {
    mockedRun.mockImplementation((config) =>
      Promise.resolve(sizedRun(config, MAX_PARKED_RESULT_BYTES)),
    );

    await browserScheduleTickSeams(new AbortController().signal).runAttempt(
      attempt(),
    );

    expect(mockedPark).toHaveBeenCalledTimes(1);
    expect(mockedTooLarge).not.toHaveBeenCalled();
  });

  test("goes to the granted folder, which the bound does not apply to", async () => {
    const folder = grantedFolder();
    mockedRun.mockImplementation((config) =>
      Promise.resolve(sizedRun(config, MAX_PARKED_RESULT_BYTES + 1)),
    );

    await browserScheduleTickSeams(new AbortController().signal).runAttempt(
      attemptFor(folder.record),
    );

    expect(folder.written).toHaveLength(1);
    expect(mockedTooLarge).not.toHaveBeenCalled();
    expect(mockedPark).not.toHaveBeenCalled();
  });

  test("never turns a completed run into a failed attempt when the state cannot be recorded", async () => {
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    mockedRun.mockImplementation((config) =>
      Promise.resolve(sizedRun(config, MAX_PARKED_RESULT_BYTES + 1)),
    );
    mockedTooLarge.mockRejectedValue(new Error("the store is gone"));

    await expect(
      browserScheduleTickSeams(new AbortController().signal).runAttempt(
        attempt(),
      ),
    ).resolves.toBeUndefined();

    expect(error).toHaveBeenCalled();
    error.mockRestore();
    warn.mockRestore();
  });
});

describe("the counts a run declared", () => {
  beforeEach(() => {
    mockedPark.mockResolvedValue(undefined);
    mockedWrittenNote.mockResolvedValue(undefined);
    mockedTooLarge.mockResolvedValue(undefined);
  });

  test("are kept beside what the run left, so the next visit can project the next result", async () => {
    mockedRun.mockImplementation((config) => {
      config.onPairTableFactors?.({ local: 12_000, partner: 9_000 });
      return Promise.resolve(matchedRun(config));
    });

    await browserScheduleTickSeams(new AbortController().signal).runAttempt(
      attempt(),
    );

    expect(mockedPark.mock.calls[0][1].pairTableFactors).toEqual({
      local: 12_000,
      partner: 9_000,
    });
  });

  test("reach the note of a folder write and the too-large state alike", async () => {
    const folder = grantedFolder();
    mockedRun.mockImplementation((config) => {
      config.onPairTableFactors?.({ local: 12_000, partner: 9_000 });
      return Promise.resolve(matchedRun(config));
    });
    await browserScheduleTickSeams(new AbortController().signal).runAttempt(
      attemptFor(folder.record),
    );
    expect(mockedWrittenNote.mock.calls[0][1].pairTableFactors).toEqual({
      local: 12_000,
      partner: 9_000,
    });

    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    mockedRun.mockImplementation((config) => {
      config.onPairTableFactors?.({ local: 12_000, partner: 9_000 });
      return Promise.resolve(sizedRun(config, MAX_PARKED_RESULT_BYTES + 1));
    });
    await browserScheduleTickSeams(new AbortController().signal).runAttempt(
      attempt(),
    );
    expect(mockedTooLarge.mock.calls[0][1].pairTableFactors).toEqual({
      local: 12_000,
      partner: 9_000,
    });
    warn.mockRestore();
  });

  test("are absent from an entry for a run that declared none", async () => {
    // Under every cardinality but many-to-many a single record count bounds the
    // pair table, there is no product to project, and the driver reports nothing.
    mockedRun.mockImplementation((config) =>
      Promise.resolve(matchedRun(config)),
    );
    await browserScheduleTickSeams(new AbortController().signal).runAttempt(
      attempt(),
    );
    expect(mockedPark.mock.calls[0][1].pairTableFactors).toBeUndefined();
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
      return Promise.resolve(completedRun());
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
      localDeduplicate: true,
      partnerDeduplicate: true,
      localRecordCount: 3163,
      localDeclaredRecordCount: 3163,
      partnerRecordCount: 3164,
      localExpectsOutput: true,
      partnerAssociationTableWithheld: false,
    });
    mockedRun.mockImplementation((config) => {
      config.onWarning?.(cardinalityNotice!);
      config.onWarning?.(pairTableAdvisory!);
      return Promise.resolve(completedRun());
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
   * test/unit/psi/managedScheduleRunner.test.ts. */
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
          caughtUpSkips: 0,
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
