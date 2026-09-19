import fs from "node:fs";

import { afterEach, expect, test } from "vitest";

import { WARNING_MESSAGE_MAX_DISPLAY_LENGTH } from "@psilink/core";

import { JobManager } from "@jobs/jobManager";
import { SWEEP_CONTROL_LABEL } from "@psi/runDiagnosticsModel";

import {
  STUB_CLI_PATH,
  tempDataRoot,
  validIntent,
} from "../../utils/jobFixtures";

import type { JobRecord } from "@jobs/jobManager";
import type { RelayEvent } from "@jobs/cliDriver";

// A transport close that overran its ceiling leaves this party's protocol files
// in the shared exchange directory, and the CLI reports that on its operator log
// alone: the report comes after the run's terminal event, and nothing goes on fd
// 3 past that (docs/spec/CLI_EVENTS.md). A run that emitted its own terminal
// event is synthesized nothing, so the retained stderr tail it leaves is read by
// nothing else -- these hold that the console raises the report as a warning of
// its own there, raises none where the run reported no leftover files, and does
// not repeat it where the terminal was synthesized and the tail already rides
// its cause link.

const roots: Array<string> = [];
const managers: Array<JobManager> = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.shutdown();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
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

/** Run one job to its reconciled exit and return the record. */
async function runJob(manager: JobManager): Promise<JobRecord> {
  const record = manager.getJob(await manager.createJob(validIntent()))!;
  const deadline = Date.now() + 5000;
  while (record.terminal === null) {
    if (Date.now() > deadline)
      throw new Error("timed out waiting for the exit");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return record;
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
 * notice holds it exactly when the abandoned close may have left this party's
 * protocol files behind.
 */
const TEARDOWN_NOTICE_WITH_LEFTOVERS =
  "[2026-09-18T00:00:00.000Z] [ERROR] [protocol] the transport did not " +
  "finish closing within 90s, so this run stopped waiting on it; still held " +
  "by: socket. The exchange's own outcome and exit status are unchanged, and " +
  "everything it writes is already on disk. Check the exchange directory and " +
  "remove any protocol files this run left there; deleting them is the part " +
  "of the close that did not finish, and passing --sweep-exchange-files to " +
  "the next run removes them before it meets the partner.\n";

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

test("a run that terminated itself and left protocol files is told so", async () => {
  const record = await runJob(
    makeManager({
      events: [RESULT_EVENT],
      stderr: TEARDOWN_NOTICE_WITH_LEFTOVERS,
    }),
  );
  const warnings = warningsOf(record);
  expect(warnings).toHaveLength(1);
  expect(warnings[0].source).toBe("relayTransportTeardownOverrun");
  const message = String(warnings[0].message);
  expect(message).toContain("protocol files");
  expect(message).toContain(`"${SWEEP_CONTROL_LABEL}"`);
  // The notice is the console's own copy, not a relay of the CLI's: the flag
  // behind the control and the CLI's own sentences stay out of it.
  expect(message).not.toContain("--sweep-exchange-files");
  expect(message.length).toBeLessThanOrEqual(
    WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
  );
  // The run's own outcome stands: the notice is housekeeping the operator acts
  // on, and a completed run that reported failed would send them to re-run an
  // exchange that already disclosed.
  expect(record.status).toBe("succeeded");
  expect(record.terminal?.outcome).toBe("succeeded");
  expect(record.events[record.events.length - 2].event.type).toBe("result");
});

test("a run that terminated itself and overran nothing is told nothing", async () => {
  const record = await runJob(
    makeManager({
      events: [RESULT_EVENT],
      stderr:
        "[2026-09-18T00:00:00.000Z] [INFO] [protocol] exchange complete\n",
    }),
  );
  expect(warningsOf(record)).toEqual([]);
  expect(record.status).toBe("succeeded");
});

test("a run whose close left nothing to clear is told nothing", async () => {
  // The overrun alone is not the operator's problem: the CLI holds the
  // protocol-file grammar and states the leftovers clause only for a run whose
  // close is what deletes those files.
  const record = await runJob(
    makeManager({
      events: [RESULT_EVENT],
      stderr: TEARDOWN_NOTICE_WITHOUT_LEFTOVERS,
    }),
  );
  expect(warningsOf(record)).toEqual([]);
  expect(record.status).toBe("succeeded");
});

test("a synthesized terminal keeps the tail on its cause link alone", async () => {
  // No terminal event of its own, so the console synthesizes one whose cause
  // link holds the end of the tail -- the teardown notice among it. A warning
  // here would put the same report in front of the operator twice.
  const record = await runJob(
    makeManager({
      events: [],
      exitCode: 69,
      stderr: TEARDOWN_NOTICE_WITH_LEFTOVERS,
    }),
  );
  expect(warningsOf(record)).toEqual([]);
  expect(record.status).toBe("failed");
  const terminal = record.events[record.events.length - 1].event;
  expect(terminal.type).toBe("error");
  expect(JSON.stringify(terminal)).toContain(
    "remove any protocol files this run left there",
  );
});
