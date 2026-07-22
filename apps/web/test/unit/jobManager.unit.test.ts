import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import * as cliDriver from "@jobs/cliDriver";
import {
  ExchangeBusyError,
  JobManager,
  JobRendezvousUnavailableError,
  SftpUnavailableError,
} from "@jobs/jobManager";
import { generateJobId, writeJobFile } from "@jobs/workdir";
import { JobInputNotFoundError } from "@jobs/workInputs";

import {
  STUB_CLI_PATH,
  TEST_HOST_KEY_FINGERPRINT,
  tempDataRoot,
  validInputFileIntent,
  validIntent,
  validSftpIntent,
  validZeroSetupIntent,
  validZeroSetupSftpIntent,
} from "../utils/jobFixtures";

import type { BufferedEvent, JobRecord } from "@jobs/jobManager";
import type { CliDriverHandlers } from "@jobs/cliDriver";
import type { JobInputFileReference } from "@jobs/intent";

vi.mock("@jobs/workdir", { spy: true });

const roots: Array<string> = [];
const managers: Array<JobManager> = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.shutdown();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  // Clear the spy call history and any per-test `*Once` overrides so a test can
  // never observe a prior test's calls (a cumulative `toHaveBeenCalled` is a
  // false-signal trap for the concurrency tests below).
  vi.restoreAllMocks();
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
  jobInputDir?: string;
  jobRendezvousDir?: string;
  jobSecretsDir?: string;
  credentialScratchDir?: string;
  recordJson?: string;
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
  if (options.recordJson !== undefined)
    childEnv.STUB_RECORD_JSON = options.recordJson;
  if (options.delayMs !== undefined)
    childEnv.STUB_DELAY_MS = String(options.delayMs);
  if (options.ignoreSigint) childEnv.STUB_IGNORE_SIGINT = "1";
  if (options.ignoreSigterm) childEnv.STUB_IGNORE_SIGTERM = "1";

  // A filedrop job requires a configured rendezvous directory; default one so the
  // filedrop tests run, unless the case under test overrides it. Created before the
  // data root so the data root stays the last-pushed cleanup entry.
  let rendezvousDir = options.jobRendezvousDir;
  if (rendezvousDir === undefined) {
    rendezvousDir = tempDataRoot("rvz");
    roots.push(rendezvousDir);
    fs.mkdirSync(rendezvousDir, { recursive: true });
  }
  const root = tempDataRoot("mgr");
  roots.push(root);
  const manager = new JobManager({
    dataRoot: root,
    binaryPath: STUB_CLI_PATH,
    cancelSigtermGraceMs: 40,
    cancelSigkillGraceMs: 40,
    eventBufferCap: options.eventBufferCap,
    jobInputDir: options.jobInputDir,
    jobRendezvousDir: rendezvousDir,
    jobSecretsDir: options.jobSecretsDir,
    credentialScratchDir: options.credentialScratchDir,
    childEnv,
  });
  managers.push(manager);
  return manager;
}

/** A created, writable rendezvous directory a filedrop job needs, registered for
 * cleanup and disjoint from the data root so it raises no preflight warning. */
function rendezvousRoot(): string {
  const dir = tempDataRoot("rvz");
  roots.push(dir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Author a real file-reference SFTP connection on the manager so an sftp job can
 * run, returning the credential's `@path`. The secret lives outside the data and
 * rendezvous roots, so it composes cleanly. */
function armSftpConnection(
  manager: JobManager,
  host = "sftp.example.org",
): { credentialRef: string } {
  const dir = tempDataRoot("armed-secret");
  roots.push(dir);
  fs.mkdirSync(dir, { recursive: true });
  const secretPath = path.join(dir, "password");
  fs.writeFileSync(secretPath, "s3cret\n");
  manager.authorSftpServer({
    host,
    port: 2222,
    username: "linkage",
    path: "/exchange",
    hostKeyFingerprint: TEST_HOST_KEY_FINGERPRINT,
    credential: { kind: "ref", ref: `@${secretPath}`, credType: "password" },
  });
  return { credentialRef: `@${secretPath}` };
}

/**
 * A manager whose spawn is stubbed to a child that reports "still running", so a
 * test can drive the terminal edge by hand -- the deterministic way to observe the
 * slot's release timing without racing a real child. The captured handlers are
 * exposed through the returned ref.
 */
function makeStubSpawnManager(): {
  manager: JobManager;
  handlersRef: { current: CliDriverHandlers | null };
} {
  const handlersRef: { current: CliDriverHandlers | null } = { current: null };
  vi.spyOn(cliDriver, "spawnExchangeJob").mockImplementation((args) => {
    handlersRef.current = args.handlers;
    return { signal: () => true, isRunning: () => true };
  });
  const root = tempDataRoot("slot-stub");
  roots.push(root);
  const manager = new JobManager({
    dataRoot: root,
    binaryPath: STUB_CLI_PATH,
    jobRendezvousDir: rendezvousRoot(),
  });
  managers.push(manager);
  return { manager, handlersRef };
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

  test("a throwing listener is dropped and never breaks the relay", async () => {
    // Drive the append path directly so a listener whose enqueue throws (a
    // controller in an unexpected state) is isolated: it is unsubscribed, the
    // append does not throw, and every other subscriber still receives events.
    let handlers!: CliDriverHandlers;
    const spy = vi
      .spyOn(cliDriver, "spawnExchangeJob")
      .mockImplementation((args) => {
        handlers = args.handlers;
        return { signal: () => true, isRunning: () => true };
      });

    const root = tempDataRoot("throwing-listener");
    roots.push(root);
    const manager = new JobManager({
      dataRoot: root,
      binaryPath: STUB_CLI_PATH,
      jobRendezvousDir: rendezvousRoot(),
    });
    managers.push(manager);

    const id = await manager.createJob(validIntent());
    const record = manager.getJob(id)!;
    const healthy: Array<BufferedEvent> = [];
    manager.subscribe(record, 0, () => {
      throw new Error("enqueue on a closed controller");
    });
    manager.subscribe(record, 0, (entry) => healthy.push(entry));

    expect(() =>
      handlers.onEvent({ v: 1, type: "stage", id: "s1", label: "one" }),
    ).not.toThrow();
    expect(record.listeners.size).toBe(1);
    handlers.onEvent({ v: 1, type: "stage", id: "s2", label: "two" });
    expect(healthy.map((entry) => entry.id)).toEqual([1, 2]);

    spy.mockRestore();
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

  test("a clean child exit after overflow does not revert the failed status", async () => {
    // The overflow fails the job and signals SIGKILL, but the exit reconciliation
    // races that kill: if the child's own exit-0 close is observed first, the
    // succeeded outcome must not overwrite the failed status the overflow set. The
    // spawn is stubbed so both edges fire in the losing order with no timing luck.
    let handlers!: CliDriverHandlers;
    const spy = vi
      .spyOn(cliDriver, "spawnExchangeJob")
      .mockImplementation((args) => {
        handlers = args.handlers;
        return { signal: () => true, isRunning: () => true };
      });

    const root = tempDataRoot("overflow-exit-race");
    roots.push(root);
    const manager = new JobManager({
      dataRoot: root,
      binaryPath: STUB_CLI_PATH,
      eventBufferCap: 3,
      jobRendezvousDir: rendezvousRoot(),
    });
    managers.push(manager);

    const id = await manager.createJob(validIntent());
    const record = manager.getJob(id)!;
    for (let i = 0; i < 5; i++)
      handlers.onEvent({
        v: 1,
        type: "stage",
        id: `s${i}`,
        label: `stage ${i}`,
      });
    expect(record.status).toBe("failed");

    handlers.onTerminal({ outcome: "succeeded", exitCode: 0, signal: null });
    expect(record.status).toBe("failed");
    const terminal = record.events[record.events.length - 1].event;
    expect(terminal.type).toBe("error");
    expect(String(terminal.message)).toContain("buffer cap");

    spy.mockRestore();
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
  test("a failed workdir write removes the directory, rethrows, and frees the slot", async () => {
    const manager = makeManager({ events: [RESULT_EVENT], exitCode: 0 });
    const root = roots[roots.length - 1];
    vi.mocked(writeJobFile).mockRejectedValueOnce(new Error("disk full"));
    await expect(manager.createJob(validIntent())).rejects.toThrow("disk full");
    expect(fs.readdirSync(root)).toEqual([]);
    // The slot did not leak: a fresh job is immediately acceptable and runs.
    const id = await manager.createJob(validIntent());
    const record = manager.getJob(id)!;
    await waitForTerminal(record);
    expect(record.status).toBe("succeeded");
  });

  test("a failed sftp job write frees the slot with the workdir", async () => {
    const manager = makeManager({
      events: [RESULT_EVENT],
      exitCode: 0,
    });
    const root = roots[roots.length - 1];
    armSftpConnection(manager);
    vi.mocked(writeJobFile).mockRejectedValueOnce(new Error("disk full"));
    await expect(manager.createJob(validSftpIntent())).rejects.toThrow(
      "disk full",
    );
    expect(fs.readdirSync(root)).toEqual([]);
    // The slot did not leak: a subsequent job is accepted and runs.
    const id = await manager.createJob(validSftpIntent());
    const record = manager.getJob(id)!;
    await waitForTerminal(record);
    expect(record.status).toBe("succeeded");
  });
});

/** Write a fresh work-input directory holding one CSV and return the directory plus
 * the reference a client would submit -- its opaque name. The CLI reads the mounted
 * file in place, so no size/mtime snapshot travels. */
function writeInputDir(
  label: string,
  content = "ssn,last_name,date_of_birth\n111223333,smith,1990-01-01\n",
  name = "input.csv",
): { dir: string; ref: JobInputFileReference } {
  const dir = tempDataRoot(label);
  roots.push(dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
  return { dir, ref: { name } };
}

describe("mounted work input read in place at create", () => {
  test("points the CLI at the mounted file and writes no input.csv into the workdir", async () => {
    const content = "ssn,last_name,date_of_birth\n555667777,jones,1975-06-02\n";
    const { dir, ref } = writeInputDir("inplace", content, "clients.csv");
    const captured: Array<{ inputPath: string; workdir: string }> = [];
    const spy = vi
      .spyOn(cliDriver, "spawnExchangeJob")
      .mockImplementation((args) => {
        captured.push({ inputPath: args.inputPath, workdir: args.workdir });
        return { signal: () => true, isRunning: () => true };
      });

    const inlineId = await manager0(dir).createJob(validIntent());
    const managerB = manager0(dir);
    const fileId = await managerB.createJob(validInputFileIntent(ref));

    const inline = captured.find((c) => c.workdir.endsWith(inlineId))!;
    const mounted = captured.find((c) => c.workdir.endsWith(fileId))!;
    // An inline job writes and reads input.csv in its own workdir; a mounted job
    // reads the operator's file in place, so the CLI's input path IS the mounted
    // file and nothing is copied into the job workdir.
    expect(inline.inputPath).toBe(path.join(inline.workdir, "input.csv"));
    expect(mounted.inputPath).toBe(path.join(dir, "clients.csv"));
    expect(fs.existsSync(path.join(mounted.workdir, "input.csv"))).toBe(false);

    spy.mockRestore();
  });

  function manager0(dir: string): JobManager {
    return makeManager({ jobInputDir: dir });
  }

  test("a valid mounted inputFile runs to a succeeded terminal", async () => {
    const { dir, ref } = writeInputDir("run");
    const manager = makeManager({
      events: [RESULT_EVENT],
      exitCode: 0,
      jobInputDir: dir,
    });
    const id = await manager.createJob(validInputFileIntent(ref));
    const record = manager.getJob(id)!;
    await waitForTerminal(record);
    expect(record.status).toBe("succeeded");
  });

  test("an unknown/vanished name is JobInputNotFoundError and leaves no workdir", async () => {
    const { dir } = writeInputDir("vanished");
    const manager = makeManager({ jobInputDir: dir });
    const root = roots[roots.length - 1]; // makeManager pushes the data root last
    await expect(
      manager.createJob(validInputFileIntent({ name: "absent.csv" })),
    ).rejects.toBeInstanceOf(JobInputNotFoundError);
    expect(fs.existsSync(root)).toBe(false);
  });

  test("an inputFile intent with no directory configured is JobInputNotFoundError", async () => {
    const rvz = tempDataRoot("rvz-only");
    roots.push(rvz);
    fs.mkdirSync(rvz, { recursive: true });
    const manager = makeManager({ jobRendezvousDir: rvz });
    await expect(
      manager.createJob(validInputFileIntent()),
    ).rejects.toBeInstanceOf(JobInputNotFoundError);
  });
});

describe("sftp server resolution", () => {
  test("an absent server rejects every sftp intent and creates NO workdir", async () => {
    const manager = makeManager({});
    const root = roots[roots.length - 1];
    await expect(manager.createJob(validSftpIntent())).rejects.toThrow(
      SftpUnavailableError,
    );
    // The server resolves BEFORE the slot is claimed and BEFORE createWorkdir:
    // nothing touched the disk, not even the data root.
    expect(fs.existsSync(root)).toBe(false);
  });

  test("an sftp job completes end-to-end and writes an sftp config", async () => {
    const manager = makeManager({
      events: [RESULT_EVENT],
      exitCode: 0,
    });
    const { credentialRef } = armSftpConnection(manager);
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
    // The authored connection's @path credential reference lands verbatim; no
    // secret byte reaches the composed config.
    expect(configYaml).toContain(credentialRef);
    expect(configYaml).not.toContain("s3cret");
  });

  test("filedrop jobs are unaffected by an absent sftp server", async () => {
    const manager = makeManager({ events: [RESULT_EVENT], exitCode: 0 });
    const id = await manager.createJob(validIntent());
    const record = manager.getJob(id)!;
    await waitForTerminal(record);
    expect(record.status).toBe("succeeded");
  });
});

describe("the in-app authored sftp connection", () => {
  /** A secret file outside any data/rendezvous root, plus an authoring body that
   * references it. */
  function authoredBody(host = "authored.partner.example") {
    const dir = tempDataRoot("secrets");
    roots.push(dir);
    fs.mkdirSync(dir, { recursive: true });
    const secretPath = path.join(dir, "password");
    fs.writeFileSync(secretPath, "s3cret\n");
    return {
      host,
      port: 2022,
      path: "/drop",
      hostKeyFingerprint: TEST_HOST_KEY_FINGERPRINT,
      credential: { kind: "ref", ref: `@${secretPath}`, credType: "password" },
    };
  }

  test("authoring holds the connection and projects it credential-free", () => {
    const manager = makeManager({});
    expect(manager.sftpProjection()).toBeNull();
    const projection = manager.authorSftpServer(authoredBody());
    expect(projection).toEqual({
      host: "authored.partner.example",
      port: 2022,
      path: "/drop",
      // The authored secret lives outside the data root, so no warning.
      credentialWarnings: [],
    });
    expect(manager.sftpProjection()).toEqual(projection);
  });

  test("a credential inside the data root surfaces a non-blocking warning", () => {
    const manager = makeManager({});
    const dataRoot = roots[roots.length - 1];
    fs.mkdirSync(dataRoot, { recursive: true });
    const secretPath = path.join(dataRoot, "password");
    fs.writeFileSync(secretPath, "s3cret\n");
    const projection = manager.authorSftpServer({
      host: "authored.partner.example",
      hostKeyFingerprint: TEST_HOST_KEY_FINGERPRINT,
      credential: { kind: "ref", ref: `@${secretPath}`, credType: "password" },
    });
    // Authored (not rejected), carrying a warning that persists to a later
    // projection (a console reload) and clears with the connection.
    expect(projection.credentialWarnings).toHaveLength(1);
    expect(projection.credentialWarnings?.[0]).toContain("data root");
    expect(manager.sftpProjection()?.credentialWarnings).toHaveLength(1);
    manager.clearAuthoredSftpServer();
    expect(manager.sftpProjection()).toBeNull();
  });

  test("an sftp job composes the authored connection into its config", async () => {
    const manager = makeManager({ events: [RESULT_EVENT], exitCode: 0 });
    const dir = tempDataRoot("secrets-compose");
    roots.push(dir);
    fs.mkdirSync(dir, { recursive: true });
    const secretPath = path.join(dir, "password");
    fs.writeFileSync(secretPath, "s3cret\n");
    manager.authorSftpServer({
      host: "authored.partner.example",
      hostKeyFingerprint: TEST_HOST_KEY_FINGERPRINT,
      credential: { kind: "ref", ref: `@${secretPath}`, credType: "password" },
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
    expect(configYaml).toContain("host: authored.partner.example");
    // The @path reference lands verbatim; the secret bytes never reach the config.
    expect(configYaml).toContain(`@${secretPath}`);
    expect(configYaml).not.toContain("s3cret");
  });

  test("authoring resolves a mountRef against the manager's secrets mount", () => {
    const secretsDir = tempDataRoot("author-secrets");
    roots.push(secretsDir);
    fs.mkdirSync(secretsDir, { recursive: true });
    fs.writeFileSync(path.join(secretsDir, "partner-password"), "s3cret\n");
    const manager = makeManager({ jobSecretsDir: secretsDir });
    const projection = manager.authorSftpServer({
      host: "authored.partner.example",
      hostKeyFingerprint: TEST_HOST_KEY_FINGERPRINT,
      credential: {
        kind: "mountRef",
        mount: "secrets",
        subPath: ["partner-password"],
        credType: "password",
      },
    });
    expect(projection).toEqual({
      host: "authored.partner.example",
      credentialWarnings: [],
    });
    expect(manager.sftpProjection()).toEqual(projection);
  });

  test("a mountRef with no secrets mount configured is refused", () => {
    const manager = makeManager({});
    expect(() =>
      manager.authorSftpServer({
        host: "authored.partner.example",
        hostKeyFingerprint: TEST_HOST_KEY_FINGERPRINT,
        credential: {
          kind: "mountRef",
          mount: "secrets",
          subPath: ["partner-password"],
          credType: "password",
        },
      }),
    ).toThrow();
    expect(manager.sftpProjection()).toBeNull();
  });

  test("clearing forgets the authored connection", () => {
    const manager = makeManager({});
    manager.authorSftpServer(authoredBody());
    expect(manager.sftpProjection()).not.toBeNull();
    manager.clearAuthoredSftpServer();
    expect(manager.sftpProjection()).toBeNull();
  });

  test("deleting the exchange forgets the authored connection", async () => {
    const manager = makeManager({ events: [RESULT_EVENT], exitCode: 0 });
    manager.authorSftpServer(authoredBody());
    const id = await manager.createJob(validSftpIntent());
    const record = manager.getJob(id)!;
    await waitForTerminal(record);
    await vi.waitFor(() => expect(record.terminal).not.toBeNull());
    expect(await manager.deleteJob(id)).toBe(true);
    // Scoped to the single exchange: deleting it clears the authored connection.
    expect(manager.sftpProjection()).toBeNull();
  });

  test("a rejected authoring body never replaces a held connection", () => {
    const manager = makeManager({});
    manager.authorSftpServer(authoredBody("first.example"));
    // An invalid body (inline credential) is refused; the prior connection stands.
    expect(() =>
      manager.authorSftpServer({
        host: "second.example",
        hostKeyFingerprint: TEST_HOST_KEY_FINGERPRINT,
        credential: {
          kind: "ref",
          ref: "inline-not-a-path",
          credType: "password",
        },
      }),
    ).toThrow();
    expect(manager.sftpProjection()?.host).toBe("first.example");
  });

  /** A created scratch directory the manager materializes pasted credentials to. */
  function scratchDir(): string {
    const dir = tempDataRoot("cred-scratch");
    roots.push(dir);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** A raw-paste authoring body carrying a pasted credential value. */
  function rawBody(value = "s3cret-password") {
    return {
      host: "authored.partner.example",
      hostKeyFingerprint: TEST_HOST_KEY_FINGERPRINT,
      credential: { kind: "raw", value, credType: "password" as const },
    };
  }

  test("a pasted credential materializes to the scratch dir, projected credential-free", () => {
    const scratch = scratchDir();
    const manager = makeManager({ credentialScratchDir: scratch });
    const projection = manager.authorSftpServer(rawBody());
    // The projection carries only the locator -- never the value.
    expect(projection).toEqual({
      host: "authored.partner.example",
      credentialWarnings: [],
    });
    // Exactly one materialized secret, owner-only, holding the pasted value.
    const files = fs.readdirSync(scratch);
    expect(files).toHaveLength(1);
    const materialized = path.join(scratch, files[0]);
    expect(fs.statSync(materialized).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(materialized, "utf8")).toBe("s3cret-password");
  });

  test("clearing deletes the materialized pasted credential", () => {
    const scratch = scratchDir();
    const manager = makeManager({ credentialScratchDir: scratch });
    manager.authorSftpServer(rawBody());
    expect(fs.readdirSync(scratch)).toHaveLength(1);
    manager.clearAuthoredSftpServer();
    expect(fs.readdirSync(scratch)).toEqual([]);
    expect(manager.sftpProjection()).toBeNull();
  });

  test("re-authoring deletes the prior pasted credential", () => {
    const scratch = scratchDir();
    const manager = makeManager({ credentialScratchDir: scratch });
    manager.authorSftpServer(rawBody("first-secret"));
    manager.authorSftpServer(rawBody("second-secret"));
    // The prior scratch file is gone; only the new one remains.
    const files = fs.readdirSync(scratch);
    expect(files).toHaveLength(1);
    expect(fs.readFileSync(path.join(scratch, files[0]), "utf8")).toBe(
      "second-secret",
    );
  });

  test("re-authoring with a file reference drops the prior pasted credential", () => {
    const scratch = scratchDir();
    const manager = makeManager({ credentialScratchDir: scratch });
    manager.authorSftpServer(rawBody());
    expect(fs.readdirSync(scratch)).toHaveLength(1);
    // A file-reference re-author has no materialized secret; the prior one is swept.
    manager.authorSftpServer(authoredBody("file.example"));
    expect(fs.readdirSync(scratch)).toEqual([]);
    expect(manager.sftpProjection()?.host).toBe("file.example");
  });

  test("deleting the exchange deletes the materialized pasted credential", async () => {
    const scratch = scratchDir();
    const manager = makeManager({
      events: [RESULT_EVENT],
      exitCode: 0,
      credentialScratchDir: scratch,
    });
    manager.authorSftpServer(rawBody());
    expect(fs.readdirSync(scratch)).toHaveLength(1);
    const id = await manager.createJob(validSftpIntent());
    const record = manager.getJob(id)!;
    await waitForTerminal(record);
    await vi.waitFor(() => expect(record.terminal).not.toBeNull());
    expect(await manager.deleteJob(id)).toBe(true);
    expect(fs.readdirSync(scratch)).toEqual([]);
    expect(manager.sftpProjection()).toBeNull();
  });

  test("a pasted credential composes into the sftp config as an @path, not a value", async () => {
    const scratch = scratchDir();
    const manager = makeManager({
      events: [RESULT_EVENT],
      exitCode: 0,
      credentialScratchDir: scratch,
    });
    manager.authorSftpServer(rawBody("s3cret-in-config"));
    const id = await manager.createJob(validSftpIntent());
    const record = manager.getJob(id)!;
    await waitForTerminal(record);
    expect(record.status).toBe("succeeded");
    const configYaml = fs.readFileSync(
      `${record.workdir}/psilink.yaml`,
      "utf8",
    );
    // The composed config carries the @path reference, never the pasted value.
    expect(configYaml).toContain("channel: sftp");
    expect(configYaml).toContain(scratch);
    expect(configYaml).not.toContain("s3cret-in-config");
  });

  test("a raw paste with no scratch dir configured is refused", () => {
    const manager = makeManager({});
    expect(() => manager.authorSftpServer(rawBody())).toThrow();
    expect(manager.sftpProjection()).toBeNull();
  });
});

describe("sftp job driven by a mounted work input", () => {
  test("an inputFile naming no file fails and leaves the slot free", async () => {
    const { dir } = writeInputDir("sftp-input-missing");
    const manager = makeManager({
      events: [RESULT_EVENT],
      exitCode: 0,
      jobInputDir: dir,
    });
    const root = roots[roots.length - 1];
    armSftpConnection(manager);
    await expect(
      manager.createJob(
        validSftpIntent({
          inputCsv: undefined,
          inputFile: { name: "absent.csv" },
        }),
      ),
    ).rejects.toBeInstanceOf(JobInputNotFoundError);
    // The input resolves inside the try, before createWorkdir: nothing on disk,
    // not even the data root, and the slot is freed by the catch.
    expect(fs.existsSync(root)).toBe(false);
    // The slot did not leak: a subsequent valid job is accepted and runs.
    const id = await manager.createJob(validSftpIntent());
    const record = manager.getJob(id)!;
    await waitForTerminal(record);
    expect(record.status).toBe("succeeded");
  });

  test("a valid inputFile reads the mount in place and composes the sftp config", async () => {
    const { dir, ref } = writeInputDir("sftp-input-valid");
    const manager = makeManager({
      events: [RESULT_EVENT],
      exitCode: 0,
      jobInputDir: dir,
    });
    armSftpConnection(manager);
    const id = await manager.createJob(
      validSftpIntent({ inputCsv: undefined, inputFile: ref }),
    );
    const record = manager.getJob(id)!;
    // Read in place: nothing is copied into the workdir.
    expect(fs.existsSync(path.join(record.workdir, "input.csv"))).toBe(false);
    await waitForTerminal(record);
    expect(record.status).toBe("succeeded");
    const configYaml = fs.readFileSync(
      `${record.workdir}/psilink.yaml`,
      "utf8",
    );
    expect(configYaml).toContain("channel: sftp");
  });
});

describe("filedrop rendezvous facilitation", () => {
  test("composes the configured rendezvous mount as the filedrop connection path", async () => {
    const rvz = tempDataRoot("rvz-path");
    roots.push(rvz);
    fs.mkdirSync(rvz, { recursive: true });
    const manager = makeManager({ jobRendezvousDir: rvz });
    const id = await manager.createJob(validIntent());
    const record = manager.getJob(id)!;
    const configYaml = fs.readFileSync(
      `${record.workdir}/psilink.yaml`,
      "utf8",
    );
    expect(configYaml).toContain("channel: filedrop");
    expect(configYaml).toContain(`path: ${rvz}`);
  });

  test("a filedrop intent with no rendezvous configured is rejected, no workdir", async () => {
    const root = tempDataRoot("no-rvz");
    roots.push(root);
    const manager = new JobManager({
      dataRoot: root,
      binaryPath: STUB_CLI_PATH,
      childEnv: { STUB_FD3_EVENTS: "[]" },
    });
    managers.push(manager);
    await expect(manager.createJob(validIntent())).rejects.toBeInstanceOf(
      JobRendezvousUnavailableError,
    );
    expect(fs.existsSync(root)).toBe(false);
  });

  test("warns through the job stream when the rendezvous mount is missing", async () => {
    const rvz = path.join(tempDataRoot("rvz-missing"), "not-created");
    const manager = makeManager({
      events: [RESULT_EVENT],
      exitCode: 0,
      jobRendezvousDir: rvz,
    });
    const id = await manager.createJob(validIntent());
    const record = manager.getJob(id)!;
    const warnings = record.events.filter(
      (entry) => entry.event.type === "warning",
    );
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe("zero-setup mode end-to-end via the stub CLI", () => {
  test("a filedrop zero-setup job runs and writes NO config or key file", async () => {
    const manager = makeManager({ events: [RESULT_EVENT], exitCode: 0 });
    const id = await manager.createJob(validZeroSetupIntent());
    const record = manager.getJob(id)!;
    await waitForTerminal(record);
    expect(record.status).toBe("succeeded");
    // The zero-setup workdir holds only input (inline), output, and the record
    // pair -- never a composed config document or a key file.
    expect(fs.existsSync(path.join(record.workdir, "psilink.yaml"))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(record.workdir, ".psilink.key"))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(record.workdir, "input.csv"))).toBe(true);
  });

  test("an sftp zero-setup job runs and writes NO config or key file", async () => {
    const manager = makeManager({
      events: [RESULT_EVENT],
      exitCode: 0,
    });
    armSftpConnection(manager);
    const id = await manager.createJob(validZeroSetupSftpIntent());
    const record = manager.getJob(id)!;
    await waitForTerminal(record);
    expect(record.status).toBe("succeeded");
    expect(fs.existsSync(path.join(record.workdir, "psilink.yaml"))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(record.workdir, ".psilink.key"))).toBe(
      false,
    );
  });

  test("routes to spawnZeroSetupJob with the connection argv and selectors", async () => {
    const captured: Array<Parameters<typeof cliDriver.spawnZeroSetupJob>[0]> =
      [];
    const zsSpy = vi
      .spyOn(cliDriver, "spawnZeroSetupJob")
      .mockImplementation((args) => {
        captured.push(args);
        return { signal: () => true, isRunning: () => true };
      });
    const exSpy = vi.spyOn(cliDriver, "spawnExchangeJob");

    const manager = makeManager({});
    const { credentialRef } = armSftpConnection(manager);
    await manager.createJob(
      validZeroSetupSftpIntent({
        identity: "county-health",
        linkageStrategy: "single-pass",
      }),
    );

    expect(exSpy).not.toHaveBeenCalled();
    expect(captured).toHaveLength(1);
    const args = captured[0];
    // The connection argv is the authored connection's URL plus its @path
    // credential and the mandatory pinned fingerprint -- no client contribution.
    expect(args.connectionArgs[0]).toBe(
      "sftp://sftp.example.org:2222/exchange",
    );
    // Value-bearing connection flags ride single `--flag=value` tokens.
    expect(
      args.connectionArgs.some((token) =>
        token.startsWith("--server-host-key-fingerprint="),
      ),
    ).toBe(true);
    expect(args.connectionArgs).toContain(`--server-password=${credentialRef}`);
    expect(args.identity).toBe("county-health");
    expect(args.linkageStrategy).toBe("single-pass");

    zsSpy.mockRestore();
    exSpy.mockRestore();
  });

  test("a terms mismatch surfaces as a failed job with the CLI error", async () => {
    // Zero-setup infers terms from each party's file; a mismatch aborts the
    // exchange. The stub emits the CLI's terminal error event and exits non-zero,
    // which the manager must surface as a failed job carrying that error.
    const manager = makeManager({
      events: [
        {
          v: 1,
          type: "error",
          category: "config",
          message: "linkage terms do not match the partner's inferred terms",
        },
      ],
      exitCode: 69,
    });
    const id = await manager.createJob(validZeroSetupIntent());
    const record = manager.getJob(id)!;
    await waitForTerminal(record);
    expect(record.status).toBe("failed");
    const terminal = record.events[record.events.length - 1].event;
    expect(terminal.type).toBe("error");
    expect(String(terminal.message)).toContain("do not match");
  });

  test("an sftp zero-setup intent with no server is SftpUnavailableError, no workdir", async () => {
    const manager = makeManager({});
    const root = roots[roots.length - 1];
    await expect(manager.createJob(validZeroSetupSftpIntent())).rejects.toThrow(
      SftpUnavailableError,
    );
    expect(fs.existsSync(root)).toBe(false);
  });

  test("a running zero-setup blocks an exchange create and vice versa", async () => {
    const manager = makeManager({
      delayMs: 5000,
    });
    armSftpConnection(manager);
    const firstId = await manager.createJob(validZeroSetupIntent());
    const first = manager.getJob(firstId)!;
    await expect(manager.createJob(validIntent())).rejects.toThrow(
      ExchangeBusyError,
    );
    await expect(manager.createJob(validZeroSetupSftpIntent())).rejects.toThrow(
      ExchangeBusyError,
    );
    manager.cancelJob(first);
    await waitForTerminal(first);
  });
});

describe("the single exchange slot", () => {
  test("a running filedrop job rejects a second create of either channel", async () => {
    const manager = makeManager({
      delayMs: 5000,
    });
    armSftpConnection(manager);
    const firstId = await manager.createJob(validIntent());
    const first = manager.getJob(firstId)!;

    await expect(manager.createJob(validIntent())).rejects.toThrow(
      ExchangeBusyError,
    );
    await expect(manager.createJob(validSftpIntent())).rejects.toThrow(
      ExchangeBusyError,
    );

    manager.cancelJob(first);
    await waitForTerminal(first);
  });

  test("a running sftp job rejects a second create of either channel", async () => {
    const manager = makeManager({
      delayMs: 5000,
    });
    armSftpConnection(manager);
    const firstId = await manager.createJob(validSftpIntent());
    const first = manager.getJob(firstId)!;

    await expect(manager.createJob(validSftpIntent())).rejects.toThrow(
      ExchangeBusyError,
    );
    await expect(manager.createJob(validIntent())).rejects.toThrow(
      ExchangeBusyError,
    );

    manager.cancelJob(first);
    await waitForTerminal(first);
  });

  test("overflow-SIGKILL keeps the slot occupied until the exchange is deleted", async () => {
    const manager = makeManager({ delayMs: 5000 });
    const firstId = await manager.createJob(validIntent());
    const first = manager.getJob(firstId)!;

    // The overflow path SIGKILLs and fails the job, but the exchange was never
    // deleted, so the slot stays occupied: a create is still rejected.
    (
      manager as unknown as { failOnOverflow: (record: JobRecord) => void }
    ).failOnOverflow(first);
    expect(first.status).toBe("failed");
    await expect(manager.createJob(validIntent())).rejects.toThrow(
      ExchangeBusyError,
    );

    // Even after the killed child's close is observed, the slot is held: only a
    // DELETE frees a terminal exchange.
    await waitForTerminal(first);
    await vi.waitFor(() => expect(first.terminal).not.toBeNull());
    await expect(manager.createJob(validIntent())).rejects.toThrow(
      ExchangeBusyError,
    );
  });

  test("DELETE of a running job holds the slot until the child's exit", async () => {
    const { manager, handlersRef } = makeStubSpawnManager();
    const firstId = await manager.createJob(validIntent());

    expect(await manager.deleteJob(firstId)).toBe(true);
    // Deleted, but the SIGKILLed child has not closed: the slot is still occupied,
    // so a successor cannot rendezvous with the dying child.
    await expect(manager.createJob(validIntent())).rejects.toThrow(
      ExchangeBusyError,
    );

    // The child's close frees the slot; a successor create then succeeds.
    handlersRef.current!.onTerminal({
      outcome: "failed",
      exitCode: null,
      signal: "SIGKILL",
    });
    const secondId = await manager.createJob(validIntent());
    expect(secondId).not.toBe(firstId);
  });

  test("a terminal but undeleted exchange rejects a create; DELETE frees the slot", async () => {
    const manager = makeManager({ events: [RESULT_EVENT], exitCode: 0 });
    const firstId = await manager.createJob(validIntent());
    const first = manager.getJob(firstId)!;
    await waitForTerminal(first);
    await vi.waitFor(() => expect(first.terminal).not.toBeNull());

    // Reject-until-DELETE: the settled exchange keeps the slot until it is deleted.
    await expect(manager.createJob(validIntent())).rejects.toThrow(
      ExchangeBusyError,
    );

    expect(await manager.deleteJob(firstId)).toBe(true);
    expect(manager.getJob(firstId)).toBeUndefined();
    const secondId = await manager.createJob(validIntent());
    expect(secondId).not.toBe(firstId);
  });

  test("DELETE of a running job 404s the surface immediately", async () => {
    const { manager } = makeStubSpawnManager();
    const id = await manager.createJob(validIntent());
    expect(manager.getJob(id)).toBeDefined();
    expect(await manager.deleteJob(id)).toBe(true);
    // The slot is still occupied (child not yet closed), but the surface is gone.
    expect(manager.getJob(id)).toBeUndefined();
    expect(manager.getJobView(id)).toBeNull();
  });
});

describe("the disk-only DELETE arm", () => {
  /** A bare manager over an existing data root, wired to the stub but never
   * spawning: it exercises only the disk-only DELETE arm. */
  function bareManager(root: string): JobManager {
    const manager = new JobManager({
      dataRoot: root,
      binaryPath: STUB_CLI_PATH,
      childEnv: { STUB_FD3_EVENTS: JSON.stringify([]) },
    });
    managers.push(manager);
    return manager;
  }

  test("removes a restart-orphaned workdir named by a valid id", async () => {
    const root = tempDataRoot("orphan");
    roots.push(root);
    const id = generateJobId();
    const workdir = path.join(root, id);
    fs.mkdirSync(workdir, { recursive: true });
    fs.writeFileSync(path.join(workdir, "output.csv"), "id\n1\n");

    const manager = bareManager(root);
    expect(await manager.deleteJob(id)).toBe(true);
    expect(fs.existsSync(workdir)).toBe(false);
    // A second delete finds nothing.
    expect(await manager.deleteJob(id)).toBe(false);
  });

  test("rejects a symlinked leaf rather than following it", async () => {
    const root = tempDataRoot("orphan-symlink");
    roots.push(root);
    fs.mkdirSync(root, { recursive: true });
    const outside = tempDataRoot("orphan-outside");
    roots.push(outside);
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "output.csv"), "id\n1\n");
    const linkId = generateJobId();
    fs.symlinkSync(outside, path.join(root, linkId), "dir");

    const manager = bareManager(root);
    // lstat sees a symlink, not a directory, so the leaf is refused and its
    // outside target is never removed.
    expect(await manager.deleteJob(linkId)).toBe(false);
    expect(fs.existsSync(path.join(outside, "output.csv"))).toBe(true);
  });

  test("a malformed id resolves nothing and is false", async () => {
    const root = tempDataRoot("orphan-malformed");
    roots.push(root);
    fs.mkdirSync(root, { recursive: true });
    const manager = bareManager(root);
    expect(await manager.deleteJob("../../etc/passwd")).toBe(false);
  });

  test("refuses the slot's own id", async () => {
    // The active-matching arm owns the running exchange's id; a re-delete must not
    // fall through to the disk arm and touch a workdir a live or dying child owns.
    const { manager } = makeStubSpawnManager();
    const id = await manager.createJob(validIntent());
    expect(await manager.deleteJob(id)).toBe(true);
    // The child is still "running", so the slot is held under this id; the disk
    // arm refuses it.
    expect(await manager.deleteJob(id)).toBe(false);
  });
});
