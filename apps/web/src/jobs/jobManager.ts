import path from "node:path";

import {
  JOB_FILE_NAMES,
  composeConfigDocument,
  composeKeyFileDocument,
  composeSftpConfigDocument,
} from "./intent";
import { JobInputNotFoundError, jobInputFilePath } from "./workInputs";
import {
  createWorkdir,
  generateJobId,
  jobFileExists,
  readRecordCreatedAt,
  removeWorkdir,
  resolveWorkdir,
  workdirDirectoryExists,
  writeJobFile,
} from "./workdir";
import { resolveCliBinaryPath, spawnExchangeJob } from "./cliDriver";
import { rendezvousStartupWarnings } from "./jobRendezvous";

import type {
  CliDriverHandle,
  JobTerminalState,
  RelayEvent,
} from "./cliDriver";
import type { JobExchangeIntent, JobInputFileReference } from "./intent";
import type { JobSftpServerEntry } from "./sftpServer";

/**
 * Thrown by {@link JobManager.createJob} when an sftp intent arrives but no
 * SFTP server is provisioned (`JOB_SFTP_SERVER` unset). The console UI falls
 * back to the save-a-file surface in that state, so this is the server-side
 * backstop for an intent that reached the API anyway; the route maps it to a
 * 400, mirroring {@link JobRendezvousUnavailableError}.
 */
export class SftpUnavailableError extends Error {
  constructor() {
    super("an sftp intent arrived but no server is provisioned");
    this.name = "SftpUnavailableError";
  }
}

/**
 * Thrown by {@link JobManager.createJob} when an exchange is already occupying
 * the single slot. The console facilitates one exchange at a time, so a second
 * create -- of either channel -- is refused with an empty-bodied 409 until the
 * running exchange is deleted. Channel is irrelevant: a running filedrop job
 * blocks an sftp create and vice versa. The slot frees only when the exchange
 * was deleted AND its child's exit was observed (or no child was ever spawned),
 * so a successor can never rendezvous with a still-dying child.
 */
export class ExchangeBusyError extends Error {
  constructor() {
    super("an exchange is already active");
    this.name = "ExchangeBusyError";
  }
}

/**
 * Thrown by {@link JobManager.createJob} when a filedrop intent arrives but no
 * rendezvous directory is configured (`JOB_RENDEZVOUS_DIR` unset). The console UI
 * disables the filedrop transport in that state, so this is the server-side backstop
 * for an intent that reached the API anyway; the route maps it to a 400.
 */
export class JobRendezvousUnavailableError extends Error {
  constructor() {
    super("no rendezvous directory is configured for a filedrop exchange");
    this.name = "JobRendezvousUnavailableError";
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
 * The uniform view the status and download routes consume, built from the live
 * in-memory {@link JobRecord}. There is at most one exchange, held in memory only;
 * a restart forgets it, so there is no restored view.
 */
export interface JobView {
  id: string;
  status: JobStatus;
  /** The reconciled terminal state, once the child has exited. */
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
  handle: CliDriverHandle | null;
  /** Registered SSE listeners, notified as events are appended. */
  listeners: Set<(entry: BufferedEvent) => void>;
  /** A cancellation escalation timer chain, cleared on exit. */
  cancelTimers: Array<NodeJS.Timeout>;
}

/**
 * The single-exchange slot. `starting` is claimed synchronously at the top of
 * {@link JobManager.createJob} (before any await) so two concurrent POSTs cannot
 * both pass the null check; it becomes `active` once the record exists. The
 * `deleted` flag makes the surface 404 immediately on DELETE while the slot stays
 * occupied until the child's exit is observed (see {@link JobManager.maybeFreeSlot}).
 */
type ExchangeSlot =
  | { phase: "starting"; id: string }
  | { phase: "active"; record: JobRecord; deleted: boolean };

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
 * Options for {@link JobManager}, so tests can inject a stub binary path and
 * shortened timers without touching the environment.
 */
export interface JobManagerOptions {
  dataRoot: string;
  binaryPath?: string;
  eventBufferCap?: number;
  cancelSigtermGraceMs?: number;
  cancelSigkillGraceMs?: number;
  /**
   * The operator-provisioned SFTP server (loaded fail-closed at server startup;
   * tests inject one directly). Absent when no server is configured, in which
   * case every sftp intent fails with {@link SftpUnavailableError}. Never
   * derived from a request.
   */
  sftpServer?: JobSftpServerEntry;
  /**
   * The resolved work-input directory (from {@link useJobInputDir}). Absent when
   * `JOB_INPUT_DIR` is unset, in which case an intent naming an `inputFile` fails
   * with {@link JobInputNotFoundError}. Never derived from a request.
   */
  jobInputDir?: string;
  /**
   * The resolved rendezvous directory (from {@link useJobRendezvousDir}) a filedrop
   * exchange reads and writes. Absent when `JOB_RENDEZVOUS_DIR` is unset, in which
   * case a filedrop intent fails with {@link JobRendezvousUnavailableError}. Never
   * derived from a request.
   */
  jobRendezvousDir?: string;
  /**
   * Extra environment variables merged into every spawned child. Empty in
   * production; the manager tests use it to configure the stub CLI. Set only by
   * the server-side constructor, never derived from a request.
   */
  childEnv?: NodeJS.ProcessEnv;
}

/**
 * The public, credential-free projection of the provisioned SFTP server served
 * by `GET /api/jobs/sftp`: the locator fields an operator needs to recognize it
 * and the client needs to author an invitation endpoint from. Constructed
 * field-by-field from the entry -- never by spreading it -- so no credential
 * reference, fingerprint, or future field can ride along.
 */
export interface SftpConnectionProjection {
  host: string;
  port?: number;
  path?: string;
}

/**
 * The single-exchange job manager and lifecycle. Owns the CLI driver, the event
 * buffer, cancellation escalation, and the shutdown hook that SIGTERMs the running
 * child so no orphaned CLI survives the server. At most one exchange occupies the
 * slot at a time; a second create is rejected until the current one is deleted.
 */
export class JobManager {
  private slot: ExchangeSlot | null = null;
  private readonly dataRoot: string;
  private readonly binaryPath: string;
  private readonly eventBufferCap: number;
  private readonly cancelSigtermGraceMs: number;
  private readonly cancelSigkillGraceMs: number;
  private readonly childEnv: NodeJS.ProcessEnv | undefined;
  private readonly sftpServer: JobSftpServerEntry | undefined;
  private readonly jobInputDir: string | undefined;
  private readonly jobRendezvousDir: string | undefined;

  constructor(options: JobManagerOptions) {
    this.dataRoot = options.dataRoot;
    this.binaryPath = options.binaryPath ?? resolveCliBinaryPath();
    this.eventBufferCap = options.eventBufferCap ?? EVENT_BUFFER_CAP;
    this.cancelSigtermGraceMs =
      options.cancelSigtermGraceMs ?? CANCEL_SIGTERM_GRACE_MS;
    this.cancelSigkillGraceMs =
      options.cancelSigkillGraceMs ?? CANCEL_SIGKILL_GRACE_MS;
    this.sftpServer = options.sftpServer;
    this.jobInputDir = options.jobInputDir;
    this.jobRendezvousDir = options.jobRendezvousDir;
    this.childEnv = options.childEnv;
  }

  /**
   * Create and start a job from a validated intent. The server generates the id,
   * builds the workdir, writes the composed config, key, and input CSV under
   * fixed names, and spawns the CLI. Returns the new job's id.
   *
   * The channel's provisioned resource is resolved synchronously first -- an sftp
   * intent the single provisioned server, a filedrop intent a configured
   * rendezvous directory -- so an unconfigured target is rejected before
   * the slot is claimed and with nothing on disk. The single slot is then claimed
   * with no await between the null check and the assignment, so two concurrent
   * POSTs cannot both pass: a second create while an exchange occupies the slot is
   * {@link ExchangeBusyError}. An `inputFile` intent resolves its mounted path
   * inside the try (mirroring the unknown-remote flow): a name that resolves to no
   * regular file is rejected and the slot freed with nothing on disk. The CLI reads
   * the mounted file in place, so nothing is copied into the workdir.
   */
  async createJob(intent: JobExchangeIntent): Promise<string> {
    const id = generateJobId();

    let serverEntry: JobSftpServerEntry | undefined;
    if (intent.channel === "sftp") {
      if (this.sftpServer === undefined) throw new SftpUnavailableError();
      serverEntry = this.sftpServer;
    }
    if (intent.channel === "filedrop" && this.jobRendezvousDir === undefined)
      throw new JobRendezvousUnavailableError();

    // Claim the slot with no await between the null check and the assignment, so
    // two concurrent POSTs cannot both observe a free slot.
    if (this.slot !== null) throw new ExchangeBusyError();
    this.slot = { phase: "starting", id };

    let workdir: string | null = null;
    try {
      // Resolve the mounted input before creating the workdir, inside the try so a
      // rejection frees the slot and leaves nothing on disk.
      const mountedInputPath =
        intent.inputFile !== undefined
          ? this.resolveWorkInputPath(intent.inputFile)
          : undefined;
      const created = await createWorkdir(this.dataRoot, id);
      workdir = created.workdir;
      return await this.startJobInWorkdir(
        intent,
        id,
        created.workdir,
        serverEntry,
        mountedInputPath,
      );
    } catch (error) {
      // spawnExchangeJob is the final fallible step of startJobInWorkdir, so this
      // catch is reachable only before any child was spawned. A slot record whose
      // handle is already set would mean a live child, and freeing the slot here
      // would strand it -- assert that never happens rather than trust the
      // ordering.
      const active = this.activeSlotRecord();
      if (active !== null && active.handle !== null)
        throw new Error(
          "createJob cleanup reached with a spawned child; refusing to free the slot",
        );
      this.slot = null;
      if (workdir !== null) await removeWorkdir(workdir);
      throw error;
    }
  }

  /**
   * The active record the slot holds (in either deleted state), else null. Read
   * through a method so the create-failure catch sees the record even where
   * control-flow narrowing would otherwise hide the slot's `active` phase.
   */
  private activeSlotRecord(): JobRecord | null {
    return this.slot !== null && this.slot.phase === "active"
      ? this.slot.record
      : null;
  }

  /**
   * Resolve an `inputFile` reference to the mounted path the CLI reads in place,
   * before any filesystem work: an unset directory, or a name that resolves to no
   * regular file, is {@link JobInputNotFoundError} -- mapped by the route to a 400.
   * The mounted directory is the operator's own read-only data.
   */
  private resolveWorkInputPath(inputFile: JobInputFileReference): string {
    if (this.jobInputDir === undefined) throw new JobInputNotFoundError();
    return jobInputFilePath(this.jobInputDir, inputFile.name);
  }

  /**
   * The credential-free projection of the provisioned SFTP server for
   * `GET /api/jobs/sftp`, or null when none is provisioned. Explicitly mapped
   * field-by-field (never a spread) so only {host, port, path} can ever cross
   * the response boundary.
   */
  sftpProjection(): SftpConnectionProjection | null {
    const entry = this.sftpServer;
    if (entry === undefined) return null;
    const projection: SftpConnectionProjection = { host: entry.host };
    if (entry.port !== undefined) projection.port = entry.port;
    if (entry.path !== undefined) projection.path = entry.path;
    return projection;
  }

  private async startJobInWorkdir(
    intent: JobExchangeIntent,
    id: string,
    workdir: string,
    serverEntry: JobSftpServerEntry | undefined,
    mountedInputPath: string | undefined,
  ): Promise<string> {
    const configDocument = composeDocumentByChannel(
      intent,
      this.jobRendezvousDir,
      serverEntry,
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
    const inputPath = await this.writeJobInput(
      intent,
      workdir,
      mountedInputPath,
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
      handle: null,
      listeners: new Set(),
      cancelTimers: [],
    };
    this.slot = { phase: "active", record, deleted: false };

    if (intent.channel === "filedrop" && this.jobRendezvousDir !== undefined)
      for (const message of rendezvousStartupWarnings(
        this.jobRendezvousDir,
        this.jobInputDir,
        this.dataRoot,
      ))
        this.appendEvent(record, { v: 1, type: "warning", message });

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

  /**
   * Resolve the path the CLI reads its input from. A `mountedInputPath` points the
   * CLI at the operator-mounted file in place (nothing is copied into the workdir);
   * otherwise the inline `inputCsv` content is written to the fixed workdir name.
   */
  private async writeJobInput(
    intent: JobExchangeIntent,
    workdir: string,
    mountedInputPath: string | undefined,
  ): Promise<string> {
    if (mountedInputPath !== undefined) return mountedInputPath;
    if (intent.inputCsv !== undefined)
      return writeJobFile(workdir, JOB_FILE_NAMES.input, intent.inputCsv);
    // The exactly-one-of intent schema guarantees one input source; refuse a
    // caller that bypassed it rather than spawning the CLI on an empty input.
    throw new Error("job intent carries neither inputCsv nor inputFile");
  }

  /**
   * The active record when the slot holds one matching this id and it has not been
   * deleted, else undefined. A deleted (but not-yet-freed) slot surfaces 404 here,
   * as today's eager delete did.
   */
  getJob(id: string): JobRecord | undefined {
    const slot = this.slot;
    if (
      slot !== null &&
      slot.phase === "active" &&
      slot.record.id === id &&
      !slot.deleted
    )
      return slot.record;
    return undefined;
  }

  /** The uniform view for a job, or null when no live record matches the id. */
  getJobView(id: string): JobView | null {
    const record = this.getJob(id);
    return record !== undefined ? liveJobView(record) : null;
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
    this.notifyListeners(record, entry);
    if (event.type === "result" || event.type === "error")
      this.markTerminalEmitted(record, event.type);
  }

  /**
   * Notify every SSE listener of one buffered entry, isolating each: a listener
   * whose enqueue throws (a controller in an unexpected state) is dropped rather
   * than allowed to propagate out of the fd-3 relay and break every other
   * subscriber's stream.
   */
  private notifyListeners(record: JobRecord, entry: BufferedEvent): void {
    for (const listener of record.listeners) {
      try {
        listener(entry);
      } catch {
        record.listeners.delete(listener);
      }
    }
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
    this.notifyListeners(record, entry);
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
    if (record.status === "running")
      record.status = terminalType === "result" ? "succeeded" : "failed";
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
   *
   * This is the only slot-release point besides the pre-spawn create failure: it
   * fires on the child's `close` (or a spawn `error`), so a killed child is
   * confirmed dead before {@link maybeFreeSlot} can free the slot for a successor.
   */
  private reconcileTerminal(record: JobRecord, state: JobTerminalState): void {
    record.terminal = state;
    this.clearCancelTimers(record);

    // An already-emitted terminal is authoritative: a job failed on buffer
    // overflow signals SIGKILL, and if the child's own clean exit is observed
    // before that kill lands, this exit outcome must not overwrite the failed
    // status the overflow already committed.
    if (!record.terminalEmitted) {
      if (state.outcome === "succeeded") record.status = "succeeded";
      else if (state.outcome === "cancelled") record.status = "cancelled";
      else record.status = "failed";

      if (state.outcome === "cancelled")
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
      else if (state.outcome === "succeeded")
        this.synthesizeTerminal(record, {
          v: 1,
          type: "result",
          resultWritten: true,
        });
      else
        this.synthesizeTerminal(record, {
          v: 1,
          type: "error",
          category: "exchange",
          message:
            "CLI exited without a terminal event; the event stream broke" +
            (state.exitCode !== null ? ` (exit ${state.exitCode})` : ""),
        });
    }

    this.maybeFreeSlot(record);
  }

  /**
   * Free the slot exactly when it is active for this record, the exchange was
   * deleted, and the child's exit has been observed (`record.terminal !== null`,
   * set only here in {@link reconcileTerminal}). Keying on `terminal` -- not
   * `terminalEmitted`, which the overflow path sets while a SIGKILLed child may
   * still be running -- is the encoded rendezvous-safety invariant: no path frees
   * the slot while a killed child might still touch the shared rendezvous or remote
   * directory.
   */
  private maybeFreeSlot(record: JobRecord): void {
    const slot = this.slot;
    if (
      slot !== null &&
      slot.phase === "active" &&
      slot.record === record &&
      slot.deleted &&
      record.terminal !== null
    )
      this.slot = null;
  }

  /** Append a synthesized terminal event and close the streams. */
  private synthesizeTerminal(record: JobRecord, event: RelayEvent): void {
    const entry: BufferedEvent = {
      id: record.events.length + 1,
      event,
    };
    record.events.push(entry);
    this.notifyListeners(record, entry);
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
   * Delete a job: mark the slot deleted and remove the workdir on disk. Signals a
   * still-running child SIGKILL first so the delete does not leave an orphan. The
   * slot is not freed here when the child was still running: a SIGKILL is
   * asynchronous, so the child may still be touching the rendezvous after this
   * returns; {@link reconcileTerminal} frees the slot on the child's `close`, which
   * keeps a successor job from rendezvousing with the dying child.
   *
   * When no live record matches the id, the disk-only arm removes a
   * restart-orphaned workdir named by a valid id -- reading no artifacts and
   * serving nothing, so an explicit DELETE can still bound the at-rest exposure of
   * a workdir the server forgot on restart. It refuses the slot's own id (a
   * starting or already-deleted id whose directory a live or dying child owns).
   */
  async deleteJob(id: string): Promise<boolean> {
    const slot = this.slot;
    if (
      slot !== null &&
      slot.phase === "active" &&
      slot.record.id === id &&
      !slot.deleted
    ) {
      const record = slot.record;
      this.clearCancelTimers(record);
      if (record.handle?.isRunning()) record.handle.signal("SIGKILL");
      slot.deleted = true;
      const workdir = resolveWorkdir(this.dataRoot, id);
      if (workdir !== null) await removeWorkdir(workdir);
      this.maybeFreeSlot(record);
      return true;
    }
    return this.deleteOrphanWorkdir(id);
  }

  /**
   * Remove a restart-orphaned workdir named by a valid id: a disk-only removal
   * that touches no in-memory state and serves nothing. Refuses the slot's own id
   * (its directory is owned by a live or still-dying child), then applies the
   * containment check ({@link resolveWorkdir}) and the real-directory guard
   * ({@link workdirDirectoryExists}, which lstats so a symlinked leaf is refused
   * rather than followed). Returns false when nothing resolves.
   */
  private async deleteOrphanWorkdir(id: string): Promise<boolean> {
    if (this.slotId() === id) return false;
    const workdir = resolveWorkdir(this.dataRoot, id);
    if (workdir === null) return false;
    if (!(await workdirDirectoryExists(workdir))) return false;
    await removeWorkdir(workdir);
    return true;
  }

  /** The id the slot currently holds, in either phase, or null when free. */
  private slotId(): string | null {
    if (this.slot === null) return null;
    return this.slot.phase === "starting" ? this.slot.id : this.slot.record.id;
  }

  /**
   * Shutdown hook: SIGTERM the single active record's running child so no orphaned
   * CLI outlives the server. Called from the server lifecycle on shutdown.
   */
  shutdown(): void {
    const slot = this.slot;
    if (slot === null || slot.phase !== "active") return;
    const record = slot.record;
    this.clearCancelTimers(record);
    if (record.handle?.isRunning()) record.handle.signal("SIGTERM");
  }
}

/**
 * The record pair's availability for a live record, offered all-or-nothing: the
 * job succeeded, both the record and keys files exist, and the record's
 * `createdAt` parses. This is the same rule the status route applied when it read
 * the in-memory record directly, lifted here so the view shares it.
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

/**
 * Compose the CLI config document for the intent's channel: filedrop rendezvous in
 * the operator-configured rendezvous mount; sftp rendezvous at the
 * operator-provisioned server. Each arm requires the resource `createJob` already
 * resolved -- the sftp server entry, the filedrop rendezvous directory -- so a
 * missing one here is a caller bug surfaced as a hard error, not a silent fallback.
 */
function composeDocumentByChannel(
  intent: JobExchangeIntent,
  rendezvousDir: string | undefined,
  serverEntry: JobSftpServerEntry | undefined,
): string {
  if (intent.channel === "sftp") {
    if (serverEntry === undefined)
      throw new Error("sftp job reached compose without a resolved server");
    return composeSftpConfigDocument(intent, serverEntry);
  }
  if (rendezvousDir === undefined)
    throw new Error(
      "filedrop job reached compose without a rendezvous directory",
    );
  return composeConfigDocument(intent, rendezvousDir);
}
