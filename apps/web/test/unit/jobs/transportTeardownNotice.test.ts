import fs from "node:fs";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  TEARDOWN_LEFTOVER_FILES_CLAUSE,
  WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
} from "@alcove/core";

import {
  createServerJobExchangeDriver,
  raiseTeardownLeftoverFilesNotice,
} from "@psi/jobClient/serverJobExchangeDriver";
import { JobManager } from "@jobs/jobManager";
import { SWEEP_CONTROL_LABEL } from "@psi/runDiagnosticsModel";
import { appendSanitizedRunWarning } from "@psi/runWarnings";

import {
  STUB_CLI_PATH,
  VALID_SHARED_SECRET,
  tempDataRoot,
  validIntent,
  validLinkageTerms,
} from "../../utils/jobFixtures";

import type {
  FinalRunStatus,
  JobApiClient,
  ServerJobExchangeDriverConfig,
} from "@psi/jobClient/serverJobExchangeDriver";
import type { JobRecord } from "@jobs/jobManager";
import type { RelayEvent } from "@jobs/cliDriver";

// A transport close that overran its ceiling leaves this party's protocol files
// in the shared exchange directory, and the CLI reports that on its operator log
// alone: the report comes after the run's terminal event, and nothing goes on fd
// 3 past that (docs/spec/CLI_EVENTS.md). The run's own terminal has closed the
// event stream by then, so the console states the report on the job's status and
// the browser reads it there -- these hold both halves: which run the status
// states it for, and that the read puts the console's own copy in front of the
// operator.

const roots: Array<string> = [];
const managers: Array<JobManager> = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.shutdown();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});

/** A created scratch directory, removed after the test. */
function scratchDir(label: string): string {
  const dir = tempDataRoot(label);
  fs.mkdirSync(dir, { recursive: true });
  roots.push(dir);
  return dir;
}

/**
 * A manager on the stub CLI whose child writes `stderr`, emits `events` on fd 3,
 * and exits with `exitCode`. The stub writes fd 3 before stderr, which is the
 * order the real CLI reports in: its terminal event, then whatever its teardown
 * puts on the log.
 */
function makeManager(options: {
  events: Array<unknown>;
  stderr?: string;
  exitCode?: number;
}): JobManager {
  const manager = new JobManager({
    dataRoot: scratchDir("teardown-root"),
    binaryPath: STUB_CLI_PATH,
    jobRendezvousDir: scratchDir("teardown-rvz"),
    childEnv: {
      STUB_EXIT_CODE: String(options.exitCode ?? 0),
      STUB_FD3_EVENTS: JSON.stringify(options.events),
      ...(options.stderr === undefined ? {} : { STUB_STDERR: options.stderr }),
    },
  });
  managers.push(manager);
  return manager;
}

/** Run one job to its reconciled exit and return the manager and the record. */
async function runJob(
  manager: JobManager,
): Promise<{ manager: JobManager; record: JobRecord }> {
  const record = manager.getJob(await manager.createJob(validIntent()))!;
  const deadline = Date.now() + 5000;
  while (record.terminal === null) {
    if (Date.now() > deadline)
      throw new Error("timed out waiting for the exit");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return { manager, record };
}

/** What the status body states about the run's transport close. */
function teardownReportedBy(manager: JobManager, record: JobRecord): boolean {
  return manager.getJobView(record.id)!.transportTeardownOverran;
}

/** The warning events a finished job buffered, in order. */
function warningsOf(record: JobRecord): Array<RelayEvent> {
  return record.events
    .map((entry) => entry.event)
    .filter((event) => event.type === "warning");
}

const RESULT_EVENT = { v: 1, type: "result", resultWritten: true };

/**
 * The CLI's teardown notice as it writes it on a file-channel run that deleted
 * nothing (`teardownCeilingNotice`, apps/cli/src/transportTeardown.ts), behind
 * the log line's own prefix. Its last sentence is the one the console reads: the
 * notice holds {@link TEARDOWN_LEFTOVER_FILES_CLAUSE} exactly when the abandoned
 * close may have left this party's protocol files behind.
 */
const TEARDOWN_NOTICE_WITH_LEFTOVERS =
  "[2026-09-18T00:00:00.000Z] [ERROR] [protocol] the transport did not " +
  "finish closing within 90s, so this run stopped waiting on it; still held " +
  "by: socket. The exchange's own outcome and exit status are unchanged, and " +
  "everything it writes is already on disk. Check the exchange directory and " +
  `${TEARDOWN_LEFTOVER_FILES_CLAUSE}; deleting them is the part of the close ` +
  "that did not finish, and passing --sweep-exchange-files to the next run " +
  "removes them before it meets the partner.\n";

/**
 * The same notice as a run with no protocol files to leave writes it -- a WebRTC
 * run, or one retaining its files as a transcript. The close overran, and the
 * operator has nothing to clear.
 */
const TEARDOWN_NOTICE_WITHOUT_LEFTOVERS =
  "[2026-09-18T00:00:00.000Z] [ERROR] [protocol] the transport did not " +
  "finish closing within 360s, so this run stopped waiting on it; still held " +
  "by: socket. The exchange's own outcome and exit status are unchanged, and " +
  "everything it writes is already on disk.\n";

describe("the job's status states what the run reported about its close", () => {
  test("a run that terminated itself and left protocol files says so", async () => {
    const { manager, record } = await runJob(
      makeManager({
        events: [RESULT_EVENT],
        stderr: TEARDOWN_NOTICE_WITH_LEFTOVERS,
      }),
    );
    expect(teardownReportedBy(manager, record)).toBe(true);
    // The run's own outcome stands: the report is housekeeping the operator acts
    // on, and a completed run that reported failed would send them to re-run an
    // exchange that already disclosed. Nothing is appended past the terminal
    // either -- the report is on the status, not on the closed stream.
    expect(record.status).toBe("succeeded");
    expect(record.terminal?.outcome).toBe("succeeded");
    expect(warningsOf(record)).toEqual([]);
    expect(record.events[record.events.length - 1].event.type).toBe("result");
  });

  test("a run that terminated itself and overran nothing says nothing", async () => {
    const { manager, record } = await runJob(
      makeManager({
        events: [RESULT_EVENT],
        stderr:
          "[2026-09-18T00:00:00.000Z] [INFO] [protocol] exchange complete\n",
      }),
    );
    expect(teardownReportedBy(manager, record)).toBe(false);
    expect(record.status).toBe("succeeded");
  });

  test("a run whose close left nothing to clear says nothing", async () => {
    // The overrun alone is not the operator's problem: the CLI holds the
    // protocol-file grammar and states the leftovers clause only for a run whose
    // close is what deletes those files.
    const { manager, record } = await runJob(
      makeManager({
        events: [RESULT_EVENT],
        stderr: TEARDOWN_NOTICE_WITHOUT_LEFTOVERS,
      }),
    );
    expect(teardownReportedBy(manager, record)).toBe(false);
    expect(record.status).toBe("succeeded");
  });

  test("a synthesized terminal keeps the tail on its cause link alone", async () => {
    // No terminal event of its own, so the console synthesizes one whose cause
    // link holds the end of the tail -- the teardown report among it. Stating it
    // on the status as well would put the same report in front of the operator
    // twice.
    const { manager, record } = await runJob(
      makeManager({
        events: [],
        exitCode: 69,
        stderr: TEARDOWN_NOTICE_WITH_LEFTOVERS,
      }),
    );
    expect(teardownReportedBy(manager, record)).toBe(false);
    expect(record.status).toBe("failed");
    const terminal = record.events[record.events.length - 1].event;
    expect(terminal.type).toBe("error");
    expect(JSON.stringify(terminal)).toContain(TEARDOWN_LEFTOVER_FILES_CLAUSE);
  });
});

/** The filedrop-transport config these folds run over; the driver only passes it
 * into the intent it posts, so its values are never validated here. */
function driverConfig(): ServerJobExchangeDriverConfig {
  return {
    transport: { channel: "filedrop" },
    side: "inviter",
    linkageTerms: validLinkageTerms(),
    sharedSecret: VALID_SHARED_SECRET,
    inputSource: { kind: "inline", csv: "ssn\n111223333\n" },
  };
}

/** The run's own terminal event when it failed rather than delivered. */
const ERROR_EVENT = {
  v: 1,
  type: "error",
  category: "exchange",
  message: "the partner never arrived",
};

/** A client whose stream is one terminal frame -- `terminal`, a result by
 * default -- and whose post-terminal read answers `final`, recording how many
 * times it was asked. */
function terminalThenStatus(
  final: FinalRunStatus | Array<FinalRunStatus>,
  terminal: unknown = RESULT_EVENT,
) {
  const answers = Array.isArray(final) ? [...final] : [final];
  const asks: Array<string> = [];
  const client: JobApiClient = {
    createJob: () => Promise.resolve("job-1"),
    openEventStream: async function* () {
      await Promise.resolve();
      yield terminal as RelayEvent;
    },
    cancelJob: () => Promise.resolve(),
    deleteJob: () => Promise.resolve(),
    fetchJobStatus: () => Promise.resolve({ kind: "live", status: "running" }),
    fetchFinalRunStatus: (jobId) => {
      asks.push(jobId);
      return Promise.resolve(
        answers.length > 1 ? answers.shift()! : answers[0],
      );
    },
  };
  return { client, asks };
}

/** A post-terminal read with nothing to offer, `overrides` applied. */
function finalStatus(overrides: Partial<FinalRunStatus> = {}): FinalRunStatus {
  return {
    record: { available: false },
    transportTeardownOverran: false,
    exitReconciled: true,
    ...overrides,
  };
}

describe("the console reads that report off the job's status", () => {
  test("a final status holding the report puts the notice in run state", async () => {
    const { client } = terminalThenStatus(
      finalStatus({ transportTeardownOverran: true }),
    );
    const warnings: Array<string> = [];
    const results: Array<unknown> = [];

    await createServerJobExchangeDriver(driverConfig(), client).run({
      signal: new AbortController().signal,
      onStages: () => undefined,
      onStage: () => undefined,
      onResult: (outputs) => results.push(outputs),
      onError: () => undefined,
      onWarning: (message) => {
        warnings.push(...appendSanitizedRunWarning([], message));
      },
    });

    // The run still reports its result, and the notice arrives beside it as the
    // seat would render it.
    expect(results).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("protocol files");
    expect(warnings[0]).toContain(`"${SWEEP_CONTROL_LABEL}"`);
    // The console's own copy, not a relay of the CLI's: the flag behind the
    // control and the CLI's own sentences stay out of it.
    expect(warnings[0]).not.toContain("--sweep-exchange-files");
    expect(warnings[0].length).toBeLessThanOrEqual(
      WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
    );
  });

  test("a final status without the report raises no notice", async () => {
    const { client, asks } = terminalThenStatus(finalStatus());
    const warnings: Array<string> = [];

    await createServerJobExchangeDriver(driverConfig(), client).run({
      signal: new AbortController().signal,
      onStages: () => undefined,
      onStage: () => undefined,
      onResult: () => undefined,
      onError: () => undefined,
      onWarning: (message) => warnings.push(message),
    });

    expect(warnings).toEqual([]);
    // A reconciled exit is the whole answer, so the run asks once.
    expect(asks).toEqual(["job-1"]);
  });

  test("a run that failed is told about the files its close left too", async () => {
    // The close is abandoned whichever way the run ended, and the files it
    // would have removed outlive the failure, so the notice follows the failure
    // alert rather than being held back by it.
    const { client } = terminalThenStatus(
      finalStatus({ transportTeardownOverran: true }),
      ERROR_EVENT,
    );
    const sequence: Array<string> = [];
    const warnings: Array<string> = [];

    await createServerJobExchangeDriver(driverConfig(), client).run({
      signal: new AbortController().signal,
      onStages: () => undefined,
      onStage: () => undefined,
      onResult: () => undefined,
      onError: () => sequence.push("error"),
      onWarning: (message) => {
        sequence.push("warning");
        warnings.push(message);
      },
    });

    expect(sequence).toEqual(["error", "warning"]);
    expect(warnings[0]).toContain("protocol files");
  });

  test("a run that failed and reported no overrun is told nothing extra", async () => {
    const { client, asks } = terminalThenStatus(finalStatus(), ERROR_EVENT);
    const warnings: Array<string> = [];
    const errors: Array<unknown> = [];

    await createServerJobExchangeDriver(driverConfig(), client).run({
      signal: new AbortController().signal,
      onStages: () => undefined,
      onStage: () => undefined,
      onResult: () => undefined,
      onError: (failure) => errors.push(failure),
      onWarning: (message) => warnings.push(message),
    });

    expect(errors).toHaveLength(1);
    expect(warnings).toEqual([]);
    expect(asks).toEqual(["job-1"]);
  });

  test("a read that arrived before the exit is asked again", async () => {
    // The CLI reports its outcome before it closes the transport, so the read
    // that follows the result frame usually finds the child still closing: the
    // report exists only once the console has reconciled its exit.
    const { client, asks } = terminalThenStatus([
      finalStatus({ exitReconciled: false }),
      finalStatus({ exitReconciled: false }),
      finalStatus({ transportTeardownOverran: true }),
    ]);
    const warnings: Array<string> = [];

    await raiseTeardownLeftoverFilesNotice(
      client,
      "job-1",
      finalStatus({ exitReconciled: false }),
      new AbortController().signal,
      (message) => warnings.push(message),
      () => Promise.resolve(),
    );

    expect(asks).toHaveLength(3);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("protocol files");
  });

  test("an abort while waiting stops the asks and says nothing", async () => {
    const controller = new AbortController();
    const { client, asks } = terminalThenStatus(
      finalStatus({ exitReconciled: false }),
    );
    const warnings: Array<string> = [];

    await raiseTeardownLeftoverFilesNotice(
      client,
      "job-1",
      finalStatus({ exitReconciled: false }),
      controller.signal,
      (message) => warnings.push(message),
      () => {
        controller.abort();
        return Promise.resolve();
      },
    );

    expect(asks).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("a child that never settles is given up on, not asked forever", async () => {
    vi.useFakeTimers();
    const { client, asks } = terminalThenStatus(
      finalStatus({ exitReconciled: false }),
    );
    const warnings: Array<string> = [];

    await raiseTeardownLeftoverFilesNotice(
      client,
      "job-1",
      finalStatus({ exitReconciled: false }),
      new AbortController().signal,
      (message) => warnings.push(message),
      (ms) => {
        vi.advanceTimersByTime(ms);
        return Promise.resolve();
      },
    );

    // Bounded by the budget the wait holds rather than by the child, and silent:
    // nothing was ever reported about the close.
    expect(asks.length).toBeGreaterThan(1);
    expect(asks.length).toBeLessThan(200);
    expect(warnings).toEqual([]);
  });

  test("a run with no warning sink asks nothing at all", async () => {
    const { client, asks } = terminalThenStatus(
      finalStatus({ transportTeardownOverran: true, exitReconciled: false }),
    );

    await raiseTeardownLeftoverFilesNotice(
      client,
      "job-1",
      finalStatus({ exitReconciled: false }),
      new AbortController().signal,
      undefined,
      () => Promise.resolve(),
    );

    expect(asks).toEqual([]);
  });
});
