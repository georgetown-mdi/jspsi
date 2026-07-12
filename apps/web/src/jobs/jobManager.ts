import path from "node:path";

import {
  JOB_FILE_NAMES,
  composeConfigDocument,
  composeKeyFileDocument,
  composeSftpConfigDocument,
} from "./intent";
import { classifyRestoredJob, listRestorableJobIds } from "./jobArtifacts";
import {
  createWorkdir,
  generateJobId,
  jobFileExists,
  readRecordCreatedAt,
  removeWorkdir,
  resolveWorkdir,
  writeJobFile,
} from "./workdir";
import { resolveCliBinaryPath, spawnExchangeJob } from "./cliDriver";

import type {
  CliDriverHandle,
  JobTerminalState,
  RelayEvent,
} from "./cliDriver";
import type { JobSftpRemoteEntry, JobSftpRemotesTable } from "./sftpRemotes";
import type { JobExchangeIntent } from "./intent";

/**
 * Thrown by {@link JobManager.createJob} when an sftp intent names a remote
 * that is not in the operator-provisioned table (or no table is configured).
 * The message never carries the requested name: the route maps this to an
 * empty-bodied 400, and nothing client-chosen should ride an error object
 * toward a log or response either.
 */
export class UnknownSftpRemoteError extends Error {
  constructor() {
    super("the intent names an sftp remote that is not provisioned");
    this.name = "UnknownSftpRemoteError";
  }
}

/**
 * Thrown by {@link JobManager.createJob} when the named remote is already held
 * by a running job. One running exchange per remote: two CLI children polling
 * the same remote directory would corrupt each other's rendezvous. The latch
 * releases when the holding job reaches a terminal state (child exit, event
 * overflow, or delete).
 */
export class SftpRemoteBusyError extends Error {
  constructor() {
    super("the named sftp remote is held by a running job");
    this.name = "SftpRemoteBusyError";
  }
}

/**
 * A single buffered event with its monotonic id. The full event list is retained
 * for the job's lifetime so every SSE connect can replay from the start (or from
 * a Last-Event-ID offset), per the full-history-replay design.
 */
export interface BufferedEvent {
  id: number;
  event: RelayEvent;
}

/** The lifecycle status of a job. */
export type JobStatus = "running" | "succeeded" | "failed" | "cancelled";

/**
 * The uniform view the status and download routes consume, built either from a
 * live in-memory {@link JobRecord} or -- after a restart, when only the workdir
 * survives -- reconstructed from disk artifacts. A live view mirrors what the
 * routes report today; a restored view carries no event history (the events were
 * in memory and are gone) and is always terminal.
 */
export interface JobView {
  id: string;
  status: JobStatus;
  /** True when this view was reconstructed from disk with no in-memory record. */
  restored: boolean;
  /** The reconciled terminal state; always null for a restored job. */
  terminal: JobTerminalState | null;
  terminalEmitted: boolean;
  eventCount: number;
  resultAvailable: boolean;
  recordAvailable: boolean;
  recordCreatedAt?: string;
  /** The three servable file paths (result, record, keys) inside the workdir. */
  outputPath: string;
  recordPath: string;
  keysPath: string;
}

/**
 * The listing subset of a {@link JobView} returned by {@link JobManager.listJobs}:
 * the fields a job list surfaces without the servable paths or event bookkeeping.
 */
export interface JobSummary {
  id: string;
  status: JobStatus;
  restored: boolean;
  resultAvailable: boolean;
  recordAvailable: boolean;
  recordCreatedAt?: string;
}

/** A job record. Lives in server memory only; never persisted. */
export interface JobRecord {
  id: string;
  workdir: string;
  outputPath: string;
  /** The self-attested exchange record's path (the CLI's `--record-file`
   * target). Present whether or not the file was actually written -- the record
   * write is non-fatal, so availability is checked at serve time, not assumed. */
  recordPath: string;
  /** The private verification-keys path paired with {@link recordPath}. */
  keysPath: string;
  /** The remote name an sftp job holds (for the per-remote busy latch); null
   * for filedrop. Only the holder recorded in the manager's latch map releases
   * it, so a stale record cannot free a successor's hold. */
  sftpRemote: string | null;
  status: JobStatus;
  events: Array<BufferedEvent>;
  /** True once a terminal event has been buffered; the SSE stream closes after it. */
  terminalEmitted: boolean;
  /** The reconciled terminal state, once the child has exited. */
  terminal: JobTerminalState | null;
  /** When the terminal event was emitted, for TTL eviction. */
  terminalAt: number | null;
  handle: CliDriverHandle | null;
  /** Registered SSE listeners, notified as events are appended. */
  listeners: Set<(entry: BufferedEvent) => void>;
  /** A cancellation escalation timer chain, cleared on exit. */
  cancelTimers: Array<NodeJS.Timeout>;
}

/**
 * The hard cap on buffered events. The CLI stream is dozens of lines by design;
 * this is a runaway backstop. On overflow the job is failed rather than dropping
 * events silently, so a supervisor never observes a truncated history.
 */
export const EVENT_BUFFER_CAP = 10000;

/** The grace before SIGINT escalates to SIGTERM during cancellation. */
export const CANCEL_SIGTERM_GRACE_MS = 5000;
/** The grace before SIGTERM escalates to SIGKILL during cancellation. */
export const CANCEL_SIGKILL_GRACE_MS = 5000;

/**
 * The TTL after a job reaches a terminal state, after which the in-memory record
 * is evicted as a memory backstop. Eviction removes only the in-memory record;
 * it leaves the workdir on disk (only an explicit DELETE removes the disk).
 */
export const JOB_TERMINAL_TTL_MS = 60 * 60 * 1000;

/**
 * Options for {@link JobManager}, so tests can inject a stub binary path and
 * shortened timers without touching the environment.
 */
export interface JobManagerOptions {
  dataRoot: string;
  binaryPath?: string;
  eventBufferCap?: number;
  cancelSigtermGraceMs?: number;
  cancelSigkillGraceMs?: number;
  terminalTtlMs?: number;
  /**
   * The operator-provisioned SFTP remotes table (loaded fail-closed at server
   * startup; tests inject one directly). Absent when no remotes are
   * configured, in which case every sftp intent fails with
   * {@link UnknownSftpRemoteError}. Never derived from a request.
   */
  sftpRemotes?: JobSftpRemotesTable;
  /**
   * Extra environment variables merged into every spawned child. Empty in
   * production; the manager tests use it to configure the stub CLI. Set only by
   * the server-side constructor, never derived from a request.
   */
  childEnv?: NodeJS.ProcessEnv;
}

/**
 * The public, credential-free projection of one provisioned remote served by
 * `GET /api/jobs/remotes`: the name a client may select plus the locator
 * fields an operator needs to recognize it. Constructed field-by-field from
 * the table entry -- never by spreading it -- so no credential reference,
 * fingerprint, or future field can ride along.
 */
export interface SftpRemoteProjection {
  name: string;
  host: string;
  port?: number;
  path?: string;
}

/**
 * The in-memory job table and lifecycle. Owns the CLI driver, the per-job event
 * buffer, cancellation escalation, TTL eviction, and the shutdown hook that
 * SIGTERMs every running child so no orphaned CLI survives the server.
 */
export class JobManager {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly dataRoot: string;
  private readonly binaryPath: string;
  private readonly eventBufferCap: number;
  private readonly cancelSigtermGraceMs: number;
  private readonly cancelSigkillGraceMs: number;
  private readonly terminalTtlMs: number;
  private readonly childEnv: NodeJS.ProcessEnv | undefined;
  private readonly sftpRemotes: JobSftpRemotesTable | undefined;
  /** The per-remote busy latch: remote name -> holding job id. */
  private readonly sftpRemoteHolders = new Map<string, string>();

  constructor(options: JobManagerOptions) {
    this.dataRoot = options.dataRoot;
    this.binaryPath = options.binaryPath ?? resolveCliBinaryPath();
    this.eventBufferCap = options.eventBufferCap ?? EVENT_BUFFER_CAP;
    this.cancelSigtermGraceMs =
      options.cancelSigtermGraceMs ?? CANCEL_SIGTERM_GRACE_MS;
    this.cancelSigkillGraceMs =
      options.cancelSigkillGraceMs ?? CANCEL_SIGKILL_GRACE_MS;
    this.terminalTtlMs = options.terminalTtlMs ?? JOB_TERMINAL_TTL_MS;
    this.sftpRemotes = options.sftpRemotes;
    this.childEnv = options.childEnv;
  }

  /**
   * Create and start a job from a validated intent. The server generates the id,
   * builds the workdir, writes the composed config, key, and input CSV under
   * fixed names, and spawns the CLI. Returns the new job's id.
   *
   * An sftp intent resolves (and latches) its remote BEFORE any filesystem
   * work, so an unknown or busy remote is rejected with nothing on disk.
   */
  async createJob(intent: JobExchangeIntent): Promise<string> {
    const id = generateJobId();
    const remoteEntry =
      intent.channel === "sftp"
        ? this.acquireSftpRemote(intent.remote, id)
        : undefined;

    let workdir: string | null = null;
    try {
      const created = await createWorkdir(
        this.dataRoot,
        id,
        JOB_FILE_NAMES.exchangeDirectory,
      );
      workdir = created.workdir;
      return await this.startJobInWorkdir(
        intent,
        id,
        created.workdir,
        created.exchangeDirectory,
        remoteEntry,
      );
    } catch (error) {
      // A failure after the workdir exists must not strand it: the record may
      // not be in the table yet, so no DELETE or eviction could ever reach the
      // directory (which may already hold the written key file). The remote
      // latch is released the same way -- no terminal path could ever run.
      this.jobs.delete(id);
      if (intent.channel === "sftp") this.releaseSftpRemote(intent.remote, id);
      if (workdir !== null) await removeWorkdir(workdir);
      throw error;
    }
  }

  /**
   * Resolve an sftp intent's remote name against the table by exact `Map.get`
   * equality and latch it to the new job. Unknown names (including "any name"
   * when no table is configured) and names held by a running job are typed
   * rejections the routes map to status codes without echoing the name.
   */
  private acquireSftpRemote(remote: string, jobId: string): JobSftpRemoteEntry {
    const entry = this.sftpRemotes?.get(remote);
    if (entry === undefined) throw new UnknownSftpRemoteError();
    if (this.sftpRemoteHolders.has(remote)) throw new SftpRemoteBusyError();
    this.sftpRemoteHolders.set(remote, jobId);
    return entry;
  }

  /** Release a remote latch, but only if this job is still its holder. */
  private releaseSftpRemote(remote: string, jobId: string): void {
    if (this.sftpRemoteHolders.get(remote) === jobId)
      this.sftpRemoteHolders.delete(remote);
  }

  /**
   * Release the remote latch a job holds. Called only from
   * {@link reconcileTerminal}, which fires on the child's `close` -- a child
   * confirmed dead can no longer poll the remote, so a successor may safely take
   * it. The forced-kill paths (overflow, delete) must NOT release here: their
   * SIGKILL is asynchronous and the child can still be running.
   */
  private releaseSftpRemoteForRecord(record: JobRecord): void {
    if (record.sftpRemote === null) return;
    this.releaseSftpRemote(record.sftpRemote, record.id);
  }

  /**
   * The credential-free projection of the provisioned remotes for
   * `GET /api/jobs/remotes`. Explicitly mapped field-by-field (never a spread)
   * so only {name, host, port, path} can ever cross the response boundary.
   */
  listSftpRemotes(): Array<SftpRemoteProjection> {
    const projection: Array<SftpRemoteProjection> = [];
    if (this.sftpRemotes === undefined) return projection;
    for (const [name, entry] of this.sftpRemotes) {
      const item: SftpRemoteProjection = { name, host: entry.host };
      if (entry.port !== undefined) item.port = entry.port;
      if (entry.path !== undefined) item.path = entry.path;
      projection.push(item);
    }
    return projection;
  }

  private async startJobInWorkdir(
    intent: JobExchangeIntent,
    id: string,
    workdir: string,
    exchangeDirectory: string,
    remoteEntry: JobSftpRemoteEntry | undefined,
  ): Promise<string> {
    const configDocument = composeDocumentByChannel(
      intent,
      exchangeDirectory,
      remoteEntry,
    );
    const keyDocument = composeKeyFileDocument(intent);

    const configPath = await writeJobFile(
      workdir,
      JOB_FILE_NAMES.config,
      configDocument,
    );
    const keyPath = await writeJobFile(
      workdir,
      JOB_FILE_NAMES.key,
      keyDocument,
    );
    const inputPath = await writeJobFile(
      workdir,
      JOB_FILE_NAMES.input,
      intent.inputCsv,
    );
    const outputPath = path.join(workdir, JOB_FILE_NAMES.output);
    const recordPath = path.join(workdir, JOB_FILE_NAMES.record);
    const keysPath = path.join(workdir, JOB_FILE_NAMES.recordKeys);

    const record: JobRecord = {
      id,
      workdir,
      outputPath,
      recordPath,
      keysPath,
      sftpRemote: intent.channel === "sftp" ? intent.remote : null,
      status: "running",
      events: [],
      terminalEmitted: false,
      terminal: null,
      terminalAt: null,
      handle: null,
      listeners: new Set(),
      cancelTimers: [],
    };
    this.jobs.set(id, record);

    const eventStream = intent.eventStream ?? true;
    record.handle = spawnExchangeJob({
      binaryPath: this.binaryPath,
      configPath,
      keyPath,
      inputPath,
      outputPath,
      recordPath,
      workdir,
      eventStream,
      ...(this.childEnv !== undefined ? { extraEnv: this.childEnv } : {}),
      handlers: {
        onEvent: (event) => this.appendEvent(record, event),
        onDegraded: (message) =>
          this.appendEvent(record, {
            v: 1,
            type: "warning",
            message,
            degraded: true,
          }),
        onTerminal: (state) => this.reconcileTerminal(record, state),
      },
    });

    return id;
  }

  /** Look up a job by id, or undefined if unknown/evicted. */
  getJob(id: string): JobRecord | undefined {
    return this.jobs.get(id);
  }

  /**
   * The uniform view for a job: the live in-memory record when one exists, else a
   * restored view reconstructed from disk artifacts, else null (no record and no
   * workdir). Routes resolve through this so a restart-restored job serves
   * identically to a live one.
   */
  async getJobView(id: string): Promise<JobView | null> {
    const record = this.jobs.get(id);
    if (record !== undefined) return liveJobView(record);
    const artifacts = await classifyRestoredJob(this.dataRoot, id);
    if (artifacts === null) return null;
    return {
      id,
      status: artifacts.status,
      restored: true,
      terminal: null,
      terminalEmitted: true,
      eventCount: 0,
      resultAvailable: artifacts.resultAvailable,
      recordAvailable: artifacts.recordAvailable,
      ...(artifacts.recordCreatedAt !== undefined
        ? { recordCreatedAt: artifacts.recordCreatedAt }
        : {}),
      outputPath: artifacts.outputPath,
      recordPath: artifacts.recordPath,
      keysPath: artifacts.keysPath,
    };
  }

  /**
   * The merged listing of every in-memory record and every restorable disk id not
   * already in memory, deduped by id with the in-memory record winning. A live
   * record is summarized exactly as its status route reports; a disk-only id is
   * classified from its artifacts.
   */
  async listJobs(): Promise<Array<JobSummary>> {
    const summaries = new Map<string, JobSummary>();
    for (const record of this.jobs.values())
      summaries.set(record.id, liveJobSummary(record));
    const diskIds = await listRestorableJobIds(this.dataRoot);
    for (const id of diskIds) {
      if (summaries.has(id)) continue;
      const artifacts = await classifyRestoredJob(this.dataRoot, id);
      if (artifacts === null) continue;
      summaries.set(id, {
        id,
        status: artifacts.status,
        restored: true,
        resultAvailable: artifacts.resultAvailable,
        recordAvailable: artifacts.recordAvailable,
        ...(artifacts.recordCreatedAt !== undefined
          ? { recordCreatedAt: artifacts.recordCreatedAt }
          : {}),
      });
    }
    return [...summaries.values()];
  }

  /**
   * Append an event to a job's buffer with the next monotonic id, notify SSE
   * listeners, and enforce the cap. On overflow the job is failed with a
   * synthesized error terminal so a supervisor always sees a terminal event.
   */
  private appendEvent(record: JobRecord, event: RelayEvent): void {
    if (record.terminalEmitted) return;
    if (record.events.length >= this.eventBufferCap) {
      this.failOnOverflow(record);
      return;
    }
    const entry: BufferedEvent = { id: record.events.length + 1, event };
    record.events.push(entry);
    for (const listener of record.listeners) listener(entry);
    if (event.type === "result" || event.type === "error")
      this.markTerminalEmitted(record, event.type);
  }

  /** Fail a job whose event buffer overflowed, appending a synthesized error. */
  private failOnOverflow(record: JobRecord): void {
    const entry: BufferedEvent = {
      id: record.events.length + 1,
      event: {
        v: 1,
        type: "error",
        category: "exchange",
        message:
          "event stream exceeded the buffer cap; failing the job to avoid " +
          "dropping events",
      },
    };
    record.events.push(entry);
    for (const listener of record.listeners) listener(entry);
    this.markTerminalEmitted(record, "error");
    record.status = "failed";
    record.handle?.signal("SIGKILL");
  }

  /** Record that a terminal event has been buffered and close SSE streams. */
  private markTerminalEmitted(
    record: JobRecord,
    terminalType: "result" | "error",
  ): void {
    record.terminalEmitted = true;
    record.terminalAt = Date.now();
    if (record.status === "running")
      record.status = terminalType === "result" ? "succeeded" : "failed";
    this.scheduleEviction(record);
  }

  /**
   * Reconcile the child's exit into the job's terminal state. If the CLI already
   * emitted its own terminal fd-3 event, that stands; otherwise the client is
   * still guaranteed a terminal event by synthesizing one that matches the exit:
   * - a cancelled outcome (interrupt) legitimately carries no terminal event, so
   *   synthesize a `cancelled`-flavored error terminal;
   * - a succeeded exit with no terminal event (the CLI normally emits a `result`;
   *   this covers a supervisor that missed it) synthesizes a `result`;
   * - any other exit without a terminal event means the stream broke, so
   *   synthesize a failure terminal.
   */
  private reconcileTerminal(record: JobRecord, state: JobTerminalState): void {
    record.terminal = state;
    this.clearCancelTimers(record);
    this.releaseSftpRemoteForRecord(record);

    if (state.outcome === "succeeded") record.status = "succeeded";
    else if (state.outcome === "cancelled") record.status = "cancelled";
    else record.status = "failed";

    if (record.terminalEmitted) {
      record.terminalAt = record.terminalAt ?? Date.now();
      this.scheduleEviction(record);
      return;
    }

    if (state.outcome === "cancelled") {
      this.synthesizeTerminal(record, {
        v: 1,
        type: "error",
        category: "exchange",
        message:
          state.exitCode === 130 || state.signal === "SIGINT"
            ? "run cancelled (SIGINT)"
            : "run cancelled (SIGTERM)",
        cancelled: true,
      });
      return;
    }

    if (state.outcome === "succeeded") {
      this.synthesizeTerminal(record, {
        v: 1,
        type: "result",
        resultWritten: true,
      });
      return;
    }

    this.synthesizeTerminal(record, {
      v: 1,
      type: "error",
      category: "exchange",
      message:
        "CLI exited without a terminal event; the event stream broke" +
        (state.exitCode !== null ? ` (exit ${state.exitCode})` : ""),
    });
  }

  /** Append a synthesized terminal event and close the streams. */
  private synthesizeTerminal(record: JobRecord, event: RelayEvent): void {
    const entry: BufferedEvent = {
      id: record.events.length + 1,
      event,
    };
    record.events.push(entry);
    for (const listener of record.listeners) listener(entry);
    this.markTerminalEmitted(
      record,
      event.type === "result" ? "result" : "error",
    );
  }

  /**
   * Register an SSE listener that receives every event with an id strictly
   * greater than `afterId` (the Last-Event-ID offset; 0 replays from the start).
   * Returns the buffered replay and an unsubscribe. When the job has already
   * emitted its terminal event, no live listener is registered -- the replay is
   * the complete history.
   */
  subscribe(
    record: JobRecord,
    afterId: number,
    onEntry: (entry: BufferedEvent) => void,
  ): { replay: Array<BufferedEvent>; unsubscribe: () => void } {
    const replay = record.events.filter((entry) => entry.id > afterId);
    if (record.terminalEmitted) return { replay, unsubscribe: () => undefined };
    record.listeners.add(onEntry);
    return {
      replay,
      unsubscribe: () => {
        record.listeners.delete(onEntry);
      },
    };
  }

  /**
   * Cancel a running job: SIGINT first, escalate to SIGTERM after a grace, then
   * SIGKILL as a last resort. The escalation timers are cleared when the child
   * exits, so a child that stops on SIGINT is never over-signaled. A job already
   * terminal is a no-op.
   */
  cancelJob(record: JobRecord): void {
    if (record.terminal !== null || record.handle === null) return;
    if (!record.handle.isRunning()) return;
    record.handle.signal("SIGINT");
    const toSigterm = setTimeout(() => {
      if (record.handle?.isRunning()) record.handle.signal("SIGTERM");
      const toSigkill = setTimeout(() => {
        if (record.handle?.isRunning()) record.handle.signal("SIGKILL");
      }, this.cancelSigkillGraceMs);
      record.cancelTimers.push(toSigkill);
      toSigkill.unref();
    }, this.cancelSigtermGraceMs);
    record.cancelTimers.push(toSigterm);
    toSigterm.unref();
  }

  private clearCancelTimers(record: JobRecord): void {
    for (const timer of record.cancelTimers) clearTimeout(timer);
    record.cancelTimers = [];
  }

  /**
   * Delete a job: remove the in-memory record and the workdir on disk. Signals a
   * still-running child SIGKILL first so the delete does not leave an orphan.
   * The remote latch is not released here: a SIGKILL is asynchronous, so the
   * child may still be polling the remote's directory after this returns:
   * {@link reconcileTerminal} releases the latch on the child's `close`, which
   * keeps a successor job from rendezvousing with the dying child.
   */
  async deleteJob(id: string): Promise<boolean> {
    const record = this.jobs.get(id);
    if (record === undefined) return this.deleteRestoredJob(id);
    this.clearCancelTimers(record);
    if (record.handle?.isRunning()) record.handle.signal("SIGKILL");
    this.jobs.delete(id);
    const workdir = resolveWorkdir(this.dataRoot, id);
    if (workdir !== null) await removeWorkdir(workdir);
    return true;
  }

  /**
   * Delete a restart-restored job that has no in-memory record: a disk-only
   * removal of the workdir. Such a job holds no child and no remote latch, so
   * there is nothing to signal or release. Returns false when no workdir exists.
   */
  private async deleteRestoredJob(id: string): Promise<boolean> {
    const artifacts = await classifyRestoredJob(this.dataRoot, id);
    if (artifacts === null) return false;
    const workdir = resolveWorkdir(this.dataRoot, id);
    if (workdir === null) return false;
    await removeWorkdir(workdir);
    return true;
  }

  /**
   * Schedule TTL eviction of the in-memory record. Eviction removes only the
   * record, never the disk (only an explicit DELETE removes the workdir).
   */
  private scheduleEviction(record: JobRecord): void {
    const timer = setTimeout(() => {
      // Evict only if still terminal and untouched: a DELETE may have already
      // removed it, and a record is never resurrected once terminal.
      if (this.jobs.get(record.id) === record) this.jobs.delete(record.id);
    }, this.terminalTtlMs);
    timer.unref();
  }

  /**
   * Shutdown hook: SIGTERM every running child so no orphaned CLI outlives the
   * server. Called from the server lifecycle on shutdown.
   */
  shutdown(): void {
    for (const record of this.jobs.values()) {
      this.clearCancelTimers(record);
      if (record.handle?.isRunning()) record.handle.signal("SIGTERM");
    }
  }
}

/**
 * The record pair's availability for a live record, offered all-or-nothing: the
 * job succeeded, both the record and keys files exist, and the record's
 * `createdAt` parses. This is the same rule the status route applied when it read
 * the in-memory record directly, lifted here so live and restored views share it.
 */
function liveRecordAvailability(
  record: JobRecord,
):
  | { recordAvailable: false }
  | { recordAvailable: true; recordCreatedAt: string } {
  if (record.status !== "succeeded") return { recordAvailable: false };
  if (!jobFileExists(record.recordPath) || !jobFileExists(record.keysPath))
    return { recordAvailable: false };
  const recordCreatedAt = readRecordCreatedAt(record.recordPath);
  if (recordCreatedAt === null) return { recordAvailable: false };
  return { recordAvailable: true, recordCreatedAt };
}

/** The live view of an in-memory record, mirroring what the routes report. */
function liveJobView(record: JobRecord): JobView {
  return {
    id: record.id,
    status: record.status,
    restored: false,
    terminal: record.terminal,
    terminalEmitted: record.terminalEmitted,
    eventCount: record.events.length,
    resultAvailable: record.status === "succeeded",
    ...liveRecordAvailability(record),
    outputPath: record.outputPath,
    recordPath: record.recordPath,
    keysPath: record.keysPath,
  };
}

/** The listing summary of a live in-memory record. */
function liveJobSummary(record: JobRecord): JobSummary {
  return {
    id: record.id,
    status: record.status,
    restored: false,
    resultAvailable: record.status === "succeeded",
    ...liveRecordAvailability(record),
  };
}

/**
 * Compose the CLI config document for the intent's channel: filedrop rendezvous
 * in the server-chosen exchange directory inside the workdir; sftp rendezvous
 * at the operator-provisioned remote (the per-job exchange directory is simply
 * unused). The sftp arm requires the entry `acquireSftpRemote` resolved; a
 * missing one here is a caller bug surfaced as a hard error, not a silent
 * fallback.
 */
function composeDocumentByChannel(
  intent: JobExchangeIntent,
  exchangeDirectory: string,
  remoteEntry: JobSftpRemoteEntry | undefined,
): string {
  if (intent.channel === "sftp") {
    if (remoteEntry === undefined)
      throw new Error("sftp job reached compose without a resolved remote");
    return composeSftpConfigDocument(intent, remoteEntry);
  }
  return composeConfigDocument(intent, exchangeDirectory);
}
