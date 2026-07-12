import fs from "node:fs";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  JobManager,
  SftpRemoteBusyError,
  UnknownSftpRemoteError,
} from "@jobs/jobManager";
import { writeJobFile } from "@jobs/workdir";

import {
  STUB_CLI_PATH,
  tempDataRoot,
  testSftpRemotesTable,
  validIntent,
  validSftpIntent,
} from "../utils/jobFixtures";

import type { BufferedEvent, JobRecord } from "@jobs/jobManager";
import type { JobSftpRemotesTable } from "@jobs/sftpRemotes";

vi.mock("@jobs/workdir", { spy: true });

const roots: Array<string> = [];
const managers: Array<JobManager> = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.shutdown();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

/** A manager pointed at the stub CLI with shortened cancellation graces. */
function makeManager(options: {
  events?: Array<unknown>;
  raw?: string;
  exitCode?: number;
  outputFile?: string;
  delayMs?: number;
  ignoreSigint?: boolean;
  ignoreSigterm?: boolean;
  eventBufferCap?: number;
  sftpRemotes?: JobSftpRemotesTable;
}): JobManager {
  // The stub reads its scenario from the child environment; the driver's
  // sanitized child env drops ambient vars, so pass the config through childEnv.
  const childEnv: NodeJS.ProcessEnv = {
    STUB_FD3_EVENTS: JSON.stringify(options.events ?? []),
  };
  if (options.raw !== undefined) childEnv.STUB_FD3_RAW = options.raw;
  if (options.exitCode !== undefined)
    childEnv.STUB_EXIT_CODE = String(options.exitCode);
  if (options.outputFile !== undefined)
    childEnv.STUB_OUTPUT_FILE = options.outputFile;
  if (options.delayMs !== undefined)
    childEnv.STUB_DELAY_MS = String(options.delayMs);
  if (options.ignoreSigint) childEnv.STUB_IGNORE_SIGINT = "1";
  if (options.ignoreSigterm) childEnv.STUB_IGNORE_SIGTERM = "1";

  const root = tempDataRoot("mgr");
  roots.push(root);
  const manager = new JobManager({
    dataRoot: root,
    binaryPath: STUB_CLI_PATH,
    cancelSigtermGraceMs: 40,
    cancelSigkillGraceMs: 40,
    eventBufferCap: options.eventBufferCap,
    sftpRemotes: options.sftpRemotes,
    childEnv,
  });
  managers.push(manager);
  return manager;
}

/** Resolve once the job has emitted its terminal event or the timeout elapses. */
async function waitForTerminal(
  record: JobRecord,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!record.terminalEmitted) {
    if (Date.now() > deadline)
      throw new Error("timed out waiting for terminal");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const RESULT_EVENT = { v: 1, type: "result", resultWritten: true };
const ERROR_EVENT = {
  v: 1,
  type: "error",
  category: "security",
  message: "key exchange authentication failed",
};

describe("JobManager end-to-end via the stub CLI", () => {
  test("a successful run buffers the terminal result and marks succeeded", async () => {
    const manager = makeManager({ events: [RESULT_EVENT], exitCode: 0 });
    const id = await manager.createJob(validIntent());
    const record = manager.getJob(id)!;
    await waitForTerminal(record);
    await vi.waitFor(() => expect(record.terminal).not.toBeNull());
    expect(record.status).toBe("succeeded");
    const terminal = record.events[record.events.length - 1].event;
    expect(terminal.type).toBe("result");
  });

  test("an interrupt (exit 130) maps to cancelled distinctly", async () => {
    const manager = makeManager({ exitCode: 130 });
    const id = await manager.createJob(validIntent());
    const record = manager.getJob(id)!;
    await waitForTerminal(record);
    expect(record.status).toBe("cancelled");
    expect(record.terminal?.outcome).toBe("cancelled");
    expect(record.terminal?.exitCode).toBe(130);
  });

  test("exit 143 maps to cancelled distinctly", async () => {
    const manager = makeManager({ exitCode: 143 });
    const id = await manager.createJob(validIntent());
    const record = manager.getJob(id)!;
    await waitForTerminal(record);
    expect(record.terminal?.exitCode).toBe(143);
    expect(record.status).toBe("cancelled");
  });

  test("another exit without a terminal event synthesizes a failure", async () => {
    // Exit 69 (transport failure) with NO fd-3 terminal event: the stream broke,
    // so the manager must synthesize a failure terminal.
    const manager = makeManager({ exitCode: 69 });
    const id = await manager.createJob(validIntent());
    const record = manager.getJob(id)!;
    await waitForTerminal(record);
    expect(record.status).toBe("failed");
    const terminal = record.events[record.events.length - 1].event;
    expect(terminal.type).toBe("error");
    expect(String(terminal.message)).toContain("stream broke");
  });

  test("an interrupt without a terminal event synthesizes a cancelled error", async () => {
    const manager = makeManager({ exitCode: 130 });
    const id = await manager.createJob(validIntent());
    const record = manager.getJob(id)!;
    await waitForTerminal(record);
    const terminal = record.events[record.events.length - 1].event;
    expect(terminal.type).toBe("error");
    expect(terminal.cancelled).toBe(true);
  });

  test("a malformed fd-3 line degrades rather than crashing the relay", async () => {
    const manager = makeManager({
      events: [RESULT_EVENT],
      raw: "this is not json\n",
      exitCode: 0,
    });
    const id = await manager.createJob(validIntent());
    const record = manager.getJob(id)!;
    await waitForTerminal(record);
    const degraded = record.events.some(
      (entry) => entry.event.degraded === true,
    );
    expect(degraded).toBe(true);
    expect(record.status).toBe("succeeded");
  });
});

describe("SSE replay", () => {
  test("replays the full history from zero with monotonic ids", async () => {
    const manager = makeManager({
      events: [{ v: 1, type: "stage", id: "s1", label: "one" }, RESULT_EVENT],
      exitCode: 0,
    });
    const id = await manager.createJob(validIntent());
    const record = manager.getJob(id)!;
    await waitForTerminal(record);
    const { replay } = manager.subscribe(record, 0, () => undefined);
    expect(replay.map((entry) => entry.id)).toEqual([1, 2]);
    expect(replay[replay.length - 1].event.type).toBe("result");
  });

  test("resumes from a Last-Event-ID offset", async () => {
    const manager = makeManager({
      events: [
        { v: 1, type: "stage", id: "s1", label: "one" },
        { v: 1, type: "stage", id: "s2", label: "two" },
        RESULT_EVENT,
      ],
      exitCode: 0,
    });
    const id = await manager.createJob(validIntent());
    const record = manager.getJob(id)!;
    await waitForTerminal(record);
    const { replay } = manager.subscribe(record, 1, () => undefined);
    expect(replay.map((entry) => entry.id)).toEqual([2, 3]);
  });

  test("a live subscriber receives events appended after subscribe", async () => {
    const manager = makeManager({ events: [RESULT_EVENT], delayMs: 60 });
    const id = await manager.createJob(validIntent());
    const record = manager.getJob(id)!;
    const seen: Array<BufferedEvent> = [];
    manager.subscribe(record, 0, (entry) => seen.push(entry));
    await waitForTerminal(record);
    expect(seen.some((entry) => entry.event.type === "result")).toBe(true);
  });
});

describe("event cap fails the job", () => {
  test("overflow synthesizes a failure terminal rather than dropping events", async () => {
    const events = Array.from({ length: 5 }, (_, i) => ({
      v: 1,
      type: "stage",
      id: `s${i}`,
      label: `stage ${i}`,
    }));
    // Cap below the emitted count so the buffer overflows before the terminal.
    const manager = makeManager({ events, exitCode: 0, eventBufferCap: 3 });
    const id = await manager.createJob(validIntent());
    const record = manager.getJob(id)!;
    await waitForTerminal(record);
    expect(record.status).toBe("failed");
    const terminal = record.events[record.events.length - 1].event;
    expect(terminal.type).toBe("error");
    expect(String(terminal.message)).toContain("buffer cap");
  });
});

describe("cancellation and deletion", () => {
  test("cancelling a running job drives it to a cancelled terminal", async () => {
    const manager = makeManager({ delayMs: 5000 });
    const id = await manager.createJob(validIntent());
    const record = manager.getJob(id)!;
    // Let the child come up, then cancel.
    await new Promise((resolve) => setTimeout(resolve, 50));
    manager.cancelJob(record);
    await waitForTerminal(record);
    expect(record.status).toBe("cancelled");
  });

  test("SIGINT-ignoring child escalates to SIGTERM", async () => {
    const manager = makeManager({ delayMs: 5000, ignoreSigint: true });
    const id = await manager.createJob(validIntent());
    const record = manager.getJob(id)!;
    await new Promise((resolve) => setTimeout(resolve, 50));
    manager.cancelJob(record);
    await waitForTerminal(record);
    expect(record.status).toBe("cancelled");
    expect(record.terminal?.exitCode).toBe(143);
  });

  test("delete removes the record and the workdir", async () => {
    const manager = makeManager({ events: [RESULT_EVENT], exitCode: 0 });
    const id = await manager.createJob(validIntent());
    const record = manager.getJob(id)!;
    await waitForTerminal(record);
    const workdir = record.workdir;
    expect(fs.existsSync(workdir)).toBe(true);
    expect(await manager.deleteJob(id)).toBe(true);
    expect(manager.getJob(id)).toBeUndefined();
    expect(fs.existsSync(workdir)).toBe(false);
  });

  test("a result file is written into the workdir and status is succeeded", async () => {
    const manager = makeManager({
      events: [RESULT_EVENT],
      exitCode: 0,
      outputFile: "id1,id2\n1,2\n",
    });
    const id = await manager.createJob(validIntent());
    const record = manager.getJob(id)!;
    await waitForTerminal(record);
    expect(record.status).toBe("succeeded");
    expect(fs.existsSync(record.outputPath)).toBe(true);
    expect(fs.readFileSync(record.outputPath, "utf8")).toContain("id1,id2");
  });
});

test("the security error terminal is classified and closes the stream", async () => {
  const manager = makeManager({ events: [ERROR_EVENT], exitCode: 69 });
  const id = await manager.createJob(validIntent());
  const record = manager.getJob(id)!;
  await waitForTerminal(record);
  const terminal = record.events[record.events.length - 1].event;
  expect(terminal.type).toBe("error");
  expect(terminal.category).toBe("security");
  expect(record.status).toBe("failed");
});

describe("createJob failure cleanup", () => {
  test("a failed workdir write removes the directory and rethrows", async () => {
    const manager = makeManager({});
    const root = roots[roots.length - 1];
    vi.mocked(writeJobFile).mockRejectedValueOnce(new Error("disk full"));
    await expect(manager.createJob(validIntent())).rejects.toThrow("disk full");
    expect(fs.readdirSync(root)).toEqual([]);
  });

  test("a failed sftp job write releases the remote latch with the workdir", async () => {
    const manager = makeManager({
      events: [RESULT_EVENT],
      exitCode: 0,
      sftpRemotes: testSftpRemotesTable(),
    });
    const root = roots[roots.length - 1];
    vi.mocked(writeJobFile).mockRejectedValueOnce(new Error("disk full"));
    await expect(manager.createJob(validSftpIntent())).rejects.toThrow(
      "disk full",
    );
    expect(fs.readdirSync(root)).toEqual([]);
    // The latch did not leak: the same remote is immediately acquirable.
    const id = await manager.createJob(validSftpIntent());
    const record = manager.getJob(id)!;
    await waitForTerminal(record);
    expect(record.status).toBe("succeeded");
  });
});

describe("sftp remote resolution and the per-remote busy latch", () => {
  test("an unknown remote is a typed error and creates NO workdir", async () => {
    const manager = makeManager({ sftpRemotes: testSftpRemotesTable() });
    const root = roots[roots.length - 1];
    await expect(
      manager.createJob(validSftpIntent({ remote: "not_provisioned" })),
    ).rejects.toThrow(UnknownSftpRemoteError);
    // The remote resolves BEFORE createWorkdir: nothing touched the disk, not
    // even the data root.
    expect(fs.existsSync(root)).toBe(false);
  });

  test("an absent table rejects every sftp intent the same way", async () => {
    const manager = makeManager({});
    const root = roots[roots.length - 1];
    await expect(manager.createJob(validSftpIntent())).rejects.toThrow(
      UnknownSftpRemoteError,
    );
    expect(fs.existsSync(root)).toBe(false);
  });

  test("a running job's remote is busy; terminal state releases it", async () => {
    const manager = makeManager({
      delayMs: 5000,
      sftpRemotes: testSftpRemotesTable(),
    });
    const firstId = await manager.createJob(validSftpIntent());
    const first = manager.getJob(firstId)!;

    await expect(manager.createJob(validSftpIntent())).rejects.toThrow(
      SftpRemoteBusyError,
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    manager.cancelJob(first);
    await waitForTerminal(first);
    await vi.waitFor(() => expect(first.terminal).not.toBeNull());

    const secondId = await manager.createJob(validSftpIntent());
    expect(secondId).not.toBe(firstId);
  });

  test("deleting the holding job releases the latch", async () => {
    const manager = makeManager({
      delayMs: 5000,
      sftpRemotes: testSftpRemotesTable(),
    });
    const firstId = await manager.createJob(validSftpIntent());
    await expect(manager.createJob(validSftpIntent())).rejects.toThrow(
      SftpRemoteBusyError,
    );
    expect(await manager.deleteJob(firstId)).toBe(true);
    const secondId = await manager.createJob(validSftpIntent());
    expect(manager.getJob(secondId)).toBeDefined();
  });

  test("an sftp job completes end-to-end and writes an sftp config", async () => {
    const manager = makeManager({
      events: [RESULT_EVENT],
      exitCode: 0,
      sftpRemotes: testSftpRemotesTable(),
    });
    const id = await manager.createJob(validSftpIntent());
    const record = manager.getJob(id)!;
    await waitForTerminal(record);
    expect(record.status).toBe("succeeded");
    const configYaml = fs.readFileSync(
      `${record.workdir}/psilink.yaml`,
      "utf8",
    );
    expect(configYaml).toContain("channel: sftp");
    expect(configYaml).toContain("host: sftp.example.org");
    expect(configYaml).not.toContain("prod_east");
  });

  test("filedrop jobs are unaffected by an absent remotes table", async () => {
    const manager = makeManager({ events: [RESULT_EVENT], exitCode: 0 });
    const id = await manager.createJob(validIntent());
    const record = manager.getJob(id)!;
    await waitForTerminal(record);
    expect(record.status).toBe("succeeded");
  });
});
