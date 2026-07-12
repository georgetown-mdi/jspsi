import path from "node:path";

import {
  JOB_FILE_NAMES,
  composeConfigDocument,
  composeKeyFileDocument,
} from "./intent";
import {
  createWorkdir,
  generateJobId,
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
import type { JobExchangeIntent } from "./intent";

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
   * Extra environment variables merged into every spawned child. Empty in
   * production; the manager tests use it to configure the stub CLI. Set only by
   * the server-side constructor, never derived from a request.
   */
  childEnv?: NodeJS.ProcessEnv;
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

  constructor(options: JobManagerOptions) {
    this.dataRoot = options.dataRoot;
    this.binaryPath = options.binaryPath ?? resolveCliBinaryPath();
    this.eventBufferCap = options.eventBufferCap ?? EVENT_BUFFER_CAP;
    this.cancelSigtermGraceMs =
      options.cancelSigtermGraceMs ?? CANCEL_SIGTERM_GRACE_MS;
    this.cancelSigkillGraceMs =
      options.cancelSigkillGraceMs ?? CANCEL_SIGKILL_GRACE_MS;
    this.terminalTtlMs = options.terminalTtlMs ?? JOB_TERMINAL_TTL_MS;
    this.childEnv = options.childEnv;
  }

  /**
   * Create and start a job from a validated intent. The server generates the id,
   * builds the workdir, writes the composed config, key, and input CSV under
   * fixed names, and spawns the CLI. Returns the new job's id.
   */
  async createJob(intent: JobExchangeIntent): Promise<string> {
    const id = generateJobId();
    const { workdir, exchangeDirectory } = await createWorkdir(
      this.dataRoot,
      id,
      JOB_FILE_NAMES.exchangeDirectory,
    );

    try {
      return await this.startJobInWorkdir(
        intent,
        id,
        workdir,
        exchangeDirectory,
      );
    } catch (error) {
      // A failure after the workdir exists must not strand it: the record may
      // not be in the table yet, so no DELETE or eviction could ever reach the
      // directory (which may already hold the written key file).
      this.jobs.delete(id);
      await removeWorkdir(workdir);
      throw error;
    }
  }

  private async startJobInWorkdir(
    intent: JobExchangeIntent,
    id: string,
    workdir: string,
    exchangeDirectory: string,
  ): Promise<string> {
    const configDocument = composeConfigDocument(intent, exchangeDirectory);
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
   */
  async deleteJob(id: string): Promise<boolean> {
    const record = this.jobs.get(id);
    if (record === undefined) return false;
    this.clearCancelTimers(record);
    if (record.handle?.isRunning()) record.handle.signal("SIGKILL");
    this.jobs.delete(id);
    const workdir = resolveWorkdir(this.dataRoot, id);
    if (workdir !== null) await removeWorkdir(workdir);
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
