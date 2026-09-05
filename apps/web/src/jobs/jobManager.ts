import path from "node:path";

import {
  zeroSetupFiledropArgv,
  zeroSetupOptionsArgv,
  zeroSetupSftpArgv,
} from "./intentArgv";

import {
  composeConfigDocument,
  composeKeyFileDocument,
  composeSftpConfigDocument,
} from "./intentConfig";
import { JOB_FILE_NAMES } from "./intentSchemas";

import { JobInputNotFoundError, jobInputFilePath } from "./workInputs";
import {
  createWorkdir,
  generateJobId,
  jobFileExists,
  readRecordSummary,
  removeWorkdir,
  resolveWorkdir,
  resolveWorkdirFile,
  workdirDirectoryExists,
  writeJobFile,
} from "./workdir";
import { jobRendezvousLegs, rendezvousStartupWarnings } from "./jobRendezvous";
import {
  resolveCliBinaryPath,
  spawnExchangeJob,
  spawnZeroSetupJob,
} from "./cliDriver";
import {
  runSigningFingerprint,
  signingCertificatePath,
  signingIdentityPath,
} from "./signingIdentity";
import { buildJobHandoff } from "./handoff";
import { probeSftpHostKey } from "./sftpProbe";
import { removeSftpCredentialFile } from "./sftpScratch";
import { validateAuthoredSftpServer } from "./sftpServer";

import type {
  CliDriverHandle,
  CliDriverHandlers,
  CliRunControls,
  JobTerminalState,
  RelayEvent,
} from "./cliDriver";
import type {
  JobCreateIntent,
  JobExchangeIntent,
  JobInputFileReference,
  JobSigningPaths,
} from "./intentSchemas";
import type { ExchangeRecordOutcome } from "@psilink/core";
import type { JobHandoff } from "./handoff";
import type { JobSftpServerEntry } from "./sftpServer";
import type { RendezvousLeg } from "./jobRendezvous";
import type { SftpProbeResult } from "./sftpProbe";
import type { SigningFingerprintResult } from "./signingIdentity";

/**
 * Thrown by {@link JobManager.createJob} when an sftp intent arrives but no
 * SFTP connection is authored. The route maps it to a 400, mirroring
 * {@link JobRendezvousUnavailableError}.
 */
export class SftpUnavailableError extends Error {
  constructor() {
    super("an sftp intent arrived but no connection is authored");
    this.name = "SftpUnavailableError";
  }
}

/**
 * Thrown by {@link JobManager.createJob} when an exchange already occupies
 * the single slot: a second create of either channel is refused with a 409
 * until the running exchange is deleted and its child's exit is observed.
 *
 * Holds {@link activeJobId}, the occupying exchange's id (not a secret; access
 * rides the loopback-only origin), so the route can emit it in the 409 body
 * and the browser can re-attach to the running exchange.
 */
export class ExchangeBusyError extends Error {
  constructor(readonly activeJobId: string) {
    super("an exchange is already active");
    this.name = "ExchangeBusyError";
  }
}

/**
 * Thrown by {@link JobManager.probeSftpHostKey} when a probe child is already
 * running: the probe is single-flight, so a concurrent request is refused
 * with a 409. Independent of the exchange slot -- a probe authors nothing.
 */
export class SftpProbeBusyError extends Error {
  constructor() {
    super("a host-key probe is already running");
    this.name = "SftpProbeBusyError";
  }
}

/**
 * Thrown by {@link JobManager.resolveSigningFingerprint} when a fingerprint
 * child is already running. Single-flight because two concurrent runs would
 * both create-or-load the same identity file, and the CLI's first-time create
 * is exclusive. Independent of the exchange slot: this authors an identity,
 * not a run.
 */
export class SigningFingerprintBusyError extends Error {
  constructor() {
    super("a signing fingerprint request is already running");
    this.name = "SigningFingerprintBusyError";
  }
}

/**
 * Thrown by {@link JobManager.createJob} when a filedrop intent arrives but
 * this console cannot rendezvous one: no rendezvous directory is resolved
 * (neither `JOB_RENDEZVOUS_DIR` nor its `JOB_DATA_ROOT` fallback is set), or
 * the split pair a second mount provisions is incoherent (see
 * `rendezvousSplitFaults`). The route maps it to a 400.
 */
export class JobRendezvousUnavailableError extends Error {
  constructor() {
    super("no rendezvous directory is configured for a filedrop exchange");
    this.name = "JobRendezvousUnavailableError";
  }
}

/**
 * Thrown by {@link JobManager.createJob} when a filedrop intent reaches a
 * split-provisioned console without retain mode. A separate outbound
 * directory requires `retain_files` -- core's connection schema and the CLI
 * both refuse the pair without it, and on a split console every filedrop
 * exchange has the pair. Mapped by the route to a 400 rather than reaching
 * core's compose as a 500.
 */
export class JobRendezvousRetainRequiredError extends Error {
  constructor() {
    super(
      "a split rendezvous (inbound and outbound directories) requires retain mode",
    );
    this.name = "JobRendezvousRetainRequiredError";
  }
}

/**
 * A single buffered event with its monotonic id. The full event list is
 * retained for the job's lifetime so every SSE connect can replay from the
 * start (or from a Last-Event-ID offset).
 */
export interface BufferedEvent {
  id: number;
  event: RelayEvent;
}

/** The lifecycle status of a job. */
type JobStatus = "running" | "succeeded" | "failed" | "cancelled";

/**
 * Why the exchange-record pair is withheld for a job, distinguished because a
 * client may act on each differently: `no-record` is the console's definitive
 * denial (nothing at the record path), the only one that licenses destroying
 * the workdir without asking; `undescribable-record` is a record file present
 * but not one this bundle can parse (unknown `outcome`, malformed, or missing
 * its keys half); `not-settled` is a run still going, whose pair the CLI
 * writes near the end.
 */
export type RecordUnavailableReason =
  "not-settled" | "no-record" | "undescribable-record";

/**
 * The uniform view the status and download routes consume, built from the live
 * in-memory {@link JobRecord}. There is at most one exchange, held in memory only;
 * a restart forgets it, so there is no restored view.
 */
interface JobView {
  id: string;
  status: JobStatus;
  /** The reconciled terminal state, once the child has exited. */
  terminal: JobTerminalState | null;
  terminalEmitted: boolean;
  eventCount: number;
  resultAvailable: boolean;
  recordAvailable: boolean;
  recordCreatedAt?: string;
  /** What the available record says became of the run that wrote it, present
   * exactly when {@link recordAvailable} is true. A terminated run's record
   * attests the same disclosure a completed run's does but has no result file
   * behind its commitments. */
  recordOutcome?: ExchangeRecordOutcome;
  /** Why the pair is withheld, present exactly when {@link recordAvailable} is
   * false: distinguishes the console's definitive denial from a record on disk
   * this bundle cannot describe -- the same negative to a reader of the boolean
   * alone. */
  recordUnavailableReason?: RecordUnavailableReason;
  /** Whether this run's intent asked for a diagnostic log, whether or not the
   * CLI has opened the file yet. It is what separates a run that will never have
   * a log from one whose log has not appeared, so a client watching for the file
   * knows when to stop. */
  logRequested: boolean;
  /** Whether this run captured a diagnostic log and the file is on disk. */
  logAvailable: boolean;
  /** Whether this run's intent asked for a signed receipt (`certificate` mode),
   * whether or not the CLI wrote one. It separates a run that will never have a
   * receipt from one whose receipt has not appeared, exactly as
   * {@link logRequested} does for the log. */
  receiptRequested: boolean;
  /** Whether this run wrote a dual-signed receipt and the file is on disk. */
  receiptAvailable: boolean;
  /** The five servable file paths (result, record, keys, log, receipt) inside the
   * workdir. `logPath` is null for a run that captured no log, `receiptPath` for
   * one that signed nothing. */
  outputPath: string;
  recordPath: string;
  keysPath: string;
  logPath: string | null;
  receiptPath: string | null;
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
  /**
   * The diagnostic log the CLI was pointed at with `--log-file`, or null when
   * this run was not a diagnostic one. Set at creation from the intent's
   * `diagnosticRun`, so a run that did not ask for a log has no log path to
   * serve at all rather than a path that happens to name no file.
   */
  logPath: string | null;
  /**
   * The dual-signed receipt the CLI was pointed at with `signing.receipt_output`,
   * or null when this run signed nothing. Set at creation from the intent's
   * signing mode, so a run that asked for no receipt has no receipt path to serve
   * at all rather than a path that happens to name no file.
   */
  receiptPath: string | null;
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
  /** The recurring-run hand-off (the portable, secret-free template plus its
   * metadata), composed at creation from this run's intent and resources. Served
   * verbatim by `GET /api/jobs/:jobId/handoff`. */
  handoff: JobHandoff;
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
 * The hard cap on buffered events: a safety check well above the CLI stream's
 * normal dozens-of-lines volume. On overflow the job is failed rather than
 * dropping events silently, so a supervisor never observes a truncated
 * history.
 */
const EVENT_BUFFER_CAP = 10000;

/** The grace before SIGINT escalates to SIGTERM during cancellation. */
const CANCEL_SIGTERM_GRACE_MS = 5000;
/** The grace before SIGTERM escalates to SIGKILL during cancellation. */
const CANCEL_SIGKILL_GRACE_MS = 5000;

/**
 * Options for {@link JobManager}, so tests can inject a stub binary path and
 * shortened timers without touching the environment.
 */
interface JobManagerOptions {
  dataRoot: string;
  binaryPath?: string;
  eventBufferCap?: number;
  cancelSigtermGraceMs?: number;
  cancelSigkillGraceMs?: number;
  /**
   * The resolved work-input directory (from {@link useJobInputDir}), which falls back
   * to the data root when `JOB_INPUT_DIR` is unset. Absent only when neither resolves;
   * an intent naming an `inputFile` then fails with {@link JobInputNotFoundError}.
   * Never derived from a request.
   */
  jobInputDir?: string;
  /**
   * The resolved rendezvous directory (from {@link JobRendezvousProvisioning.dir})
   * a filedrop exchange reads and writes, which falls back to the data root when
   * `JOB_RENDEZVOUS_DIR` is unset. Absent only when neither resolves; a filedrop intent
   * then fails with {@link JobRendezvousUnavailableError}. On a split-provisioned
   * console it is the INBOUND (peer-written) leg. Never derived from a request.
   */
  jobRendezvousDir?: string;
  /**
   * The resolved outbound (self-written) rendezvous leg (from
   * {@link JobRendezvousProvisioning.outboundDir}), present only when
   * `JOB_RENDEZVOUS_OUTBOUND_DIR` names one. Its presence makes every filedrop
   * exchange this console runs a split one: the composed config has
   * `inbound_path`/`outbound_path` instead of a single `path`, and the
   * zero-setup argv gains `--outbound-path`. Never derived from a request.
   */
  jobRendezvousOutboundDir?: string;
  /**
   * Why a filedrop exchange cannot run as this console is provisioned (from
   * {@link JobRendezvousProvisioning.problem}) -- an incoherent split pair.
   * Present only in that state; a filedrop intent then fails with
   * {@link JobRendezvousUnavailableError}.
   */
  jobRendezvousProblem?: string;
  /**
   * The resolved secrets mount (from {@link useJobSecretsDir}) the operator
   * browses for an authored connection's file-reference credential -- no
   * data-root fallback, so absent when `JOB_SECRETS_DIR` is unset. Used only
   * to resolve a `mountRef` credential locator to its `@path` during
   * {@link authorSftpServer}; an unset mount refuses that authoring.
   */
  jobSecretsDir?: string;
  /**
   * The container-internal scratch directory a PASTED credential is materialized
   * to (from {@link setupSftpCredentialScratchDir} at boot). Absent when the boot
   * setup did not run (a disabled API, or a test that authors only file-reference
   * credentials); a raw-paste authoring then fails rather than composing an
   * inline value. Never a request value or the data root.
   */
  credentialScratchDir?: string;
  /**
   * Extra environment variables merged into every spawned child. Empty in
   * production; the manager tests use it to configure the stub CLI. Set only by
   * the server-side constructor, never derived from a request.
   */
  childEnv?: NodeJS.ProcessEnv;
}

/**
 * The public, credential-free projection of the authored SFTP connection
 * served by `GET /api/jobs/sftp`: the locator fields plus any non-blocking
 * credential warnings (each naming a field and a directory only, never a
 * secret). Constructed field-by-field from the entry -- never by spreading it
 * -- so no credential reference, fingerprint, or future field can ride along.
 */
export interface SftpConnectionProjection {
  host: string;
  port?: number;
  path?: string;
  /** The inbound (peer-written) remote directory of a split-directory
   * connection; present only as a pair with {@link outboundPath}, and never
   * alongside {@link path}. */
  inboundPath?: string;
  /** The outbound (self-written) remote directory of a split-directory
   * connection. */
  outboundPath?: string;
  credentialWarnings?: Array<string>;
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
  private readonly jobInputDir: string | undefined;
  private readonly jobRendezvousDir: string | undefined;
  private readonly jobRendezvousOutboundDir: string | undefined;
  private readonly jobRendezvousProblem: string | undefined;
  private readonly jobSecretsDir: string | undefined;
  private readonly credentialScratchDir: string | undefined;
  /**
   * The in-app authored SFTP connection, held in memory for the single exchange
   * only (never persisted; a restart forgets it). Set by {@link authorSftpServer},
   * cleared by {@link clearAuthoredSftpServer} and when the active exchange is
   * deleted.
   */
  private authoredSftpServer: JobSftpServerEntry | undefined;
  /**
   * The non-blocking credential warnings for the authored connection (each
   * naming a field and a directory only), held alongside it and exposed in
   * the projection so both the PUT response and a later GET (console reload)
   * include them. Empty when no connection is authored or every credential
   * resolves safely.
   */
  private authoredCredentialWarnings: Array<string> = [];
  /**
   * The server-owned scratch file the authored connection's PASTED credential was
   * materialized to, when it arrived that way. Tracked so it is deleted with the
   * connection (clear, exchange delete, or a re-author that replaces it); absent
   * when the authored credential is a file reference the operator owns. A pasted
   * secret must not outlive the connection it belongs to.
   */
  private authoredMaterializedCredentialPath: string | undefined;
  /**
   * Whether a host-key probe child is running. The probe is single-flight, so a
   * concurrent {@link probeSftpHostKey} is refused with {@link SftpProbeBusyError}.
   * Set synchronously at entry (before any await) so two concurrent calls cannot
   * both pass; cleared when the child settles. Independent of the exchange slot.
   */
  private probeInFlight = false;
  /**
   * Whether a signing-fingerprint child is running. Claimed and cleared exactly as
   * {@link probeInFlight} is, and for the reason
   * {@link SigningFingerprintBusyError} states.
   */
  private fingerprintInFlight = false;

  constructor(options: JobManagerOptions) {
    this.dataRoot = options.dataRoot;
    this.binaryPath = options.binaryPath ?? resolveCliBinaryPath();
    this.eventBufferCap = options.eventBufferCap ?? EVENT_BUFFER_CAP;
    this.cancelSigtermGraceMs =
      options.cancelSigtermGraceMs ?? CANCEL_SIGTERM_GRACE_MS;
    this.cancelSigkillGraceMs =
      options.cancelSigkillGraceMs ?? CANCEL_SIGKILL_GRACE_MS;
    this.jobInputDir = options.jobInputDir;
    this.jobRendezvousDir = options.jobRendezvousDir;
    this.jobRendezvousOutboundDir = options.jobRendezvousOutboundDir;
    this.jobRendezvousProblem = options.jobRendezvousProblem;
    this.jobSecretsDir = options.jobSecretsDir;
    this.credentialScratchDir = options.credentialScratchDir;
    this.childEnv = options.childEnv;
  }

  /**
   * Create and start a job from a validated intent: generates the id, builds
   * the workdir, writes the composed config, key, and input CSV, and spawns
   * the CLI. The connection resource is resolved before the slot is claimed
   * (so an unconfigured target is rejected with nothing on disk), and the
   * slot itself is claimed with no await between the null check and the
   * assignment, so two concurrent POSTs cannot both pass. An `inputFile`
   * intent resolves its mounted path inside the try; the CLI reads it in
   * place, so nothing is copied into the workdir.
   */
  async createJob(intent: JobCreateIntent): Promise<string> {
    const id = generateJobId();

    let serverEntry: JobSftpServerEntry | undefined;
    if (intent.channel === "sftp") {
      if (this.authoredSftpServer === undefined)
        throw new SftpUnavailableError();
      serverEntry = this.authoredSftpServer;
    }
    if (intent.channel === "filedrop") {
      if (
        this.jobRendezvousDir === undefined ||
        this.jobRendezvousProblem !== undefined
      )
        throw new JobRendezvousUnavailableError();
      // Every filedrop exchange on a split-provisioned console has the
      // inbound/outbound pair, which core refuses without retain mode. Refused
      // here, before the slot is claimed, so the operator meets a 400 the console
      // can explain rather than a compose failure after a workdir exists.
      if (
        this.jobRendezvousOutboundDir !== undefined &&
        intent.options?.retainFiles !== true
      )
        throw new JobRendezvousRetainRequiredError();
    }

    // Claim the slot with no await between the null check and the assignment, so
    // two concurrent POSTs cannot both observe a free slot. The busy rejection
    // holds the occupying exchange's id so the caller can re-attach to it.
    if (this.slot !== null) throw new ExchangeBusyError(this.slotId()!);
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
      // spawnExchangeJob is the final fallible step of startJobInWorkdir, so
      // this catch is reachable only before any child was spawned. A slot
      // record whose handle is already set would mean a live child; freeing
      // the slot here would strand it, so that state is asserted unreachable.
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
   * The rendezvous mounts a filedrop job preflights and a credential `@path`
   * is excluded from, each paired with the leg it is. Routed through the
   * shared enumeration so the manager and the boot-time containment surfaces
   * cannot state different rules about which mounts this console has.
   */
  private rendezvousLegs(): Array<[string, RendezvousLeg]> {
    return jobRendezvousLegs(
      this.jobRendezvousDir,
      this.jobRendezvousOutboundDir,
    );
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
   * Validate and hold an in-app authored SFTP connection for the single
   * exchange, via {@link validateAuthoredSftpServer}. A validation failure
   * throws before the slot is touched, so a rejected body never replaces a
   * previously authored connection. A `mountRef` credential locator is
   * resolved against the secrets mount here, and a `raw` (pasted) credential
   * is materialized to the server-owned scratch file. Returns the
   * credential-free projection of the now-effective connection.
   */
  authorSftpServer(rawBody: unknown): SftpConnectionProjection {
    const result = validateAuthoredSftpServer(
      rawBody,
      this.dataRoot,
      this.rendezvousLegs().map(([dir]) => dir),
      this.jobSecretsDir,
      this.credentialScratchDir,
    );
    // Adopt only after validation succeeds: drop the prior connection's
    // materialized secret (if any) so a re-author never orphans a scratch file.
    this.discardMaterializedCredential();
    this.authoredSftpServer = result.entry;
    this.authoredCredentialWarnings = result.credentialWarnings;
    this.authoredMaterializedCredentialPath = result.materializedCredentialPath;
    return this.sftpProjection()!;
  }

  /** Forget the in-app authored SFTP connection and its warnings, deleting any
   * materialized pasted credential. Idempotent. */
  clearAuthoredSftpServer(): void {
    this.discardMaterializedCredential();
    this.authoredSftpServer = undefined;
    this.authoredCredentialWarnings = [];
  }

  /** Delete the authored connection's materialized pasted credential, if it holds
   * one. A no-op for a file-reference credential (the operator's own file is never
   * touched). */
  private discardMaterializedCredential(): void {
    if (this.authoredMaterializedCredentialPath !== undefined) {
      removeSftpCredentialFile(this.authoredMaterializedCredentialPath);
      this.authoredMaterializedCredentialPath = undefined;
    }
  }

  /**
   * The credential-free projection of the authored SFTP connection for
   * `GET /api/jobs/sftp`, or null when none is authored. Explicitly mapped
   * field-by-field (never a spread) so only the locator fields {host, port, and
   * whichever remote-directory form the entry holds} can ever cross the
   * response boundary.
   */
  sftpProjection(): SftpConnectionProjection | null {
    const entry = this.authoredSftpServer;
    if (entry === undefined) return null;
    const projection: SftpConnectionProjection = { host: entry.host };
    if (entry.port !== undefined) projection.port = entry.port;
    if (entry.path !== undefined) projection.path = entry.path;
    if (entry.inboundPath !== undefined)
      projection.inboundPath = entry.inboundPath;
    if (entry.outboundPath !== undefined)
      projection.outboundPath = entry.outboundPath;
    projection.credentialWarnings = this.authoredCredentialWarnings;
    return projection;
  }

  /**
   * Read the host-key fingerprint an SFTP server at `host[:port]` presents,
   * by spawning the CLI's `probe-host-key` subcommand. Stateless: touches no
   * authored connection and records nothing -- the console offers the
   * observation beside the paste field for comparison, never trusting it.
   * Single-flight: the flag is claimed synchronously (no await before the
   * assignment), so a concurrent probe is {@link SftpProbeBusyError} (a 409).
   */
  async probeSftpHostKey(args: {
    host: string;
    port?: number;
  }): Promise<SftpProbeResult> {
    if (this.probeInFlight) throw new SftpProbeBusyError();
    this.probeInFlight = true;
    try {
      return await probeSftpHostKey({
        host: args.host,
        ...(args.port !== undefined ? { port: args.port } : {}),
        binaryPath: this.binaryPath,
        ...(this.childEnv !== undefined ? { childEnv: this.childEnv } : {}),
      });
    } finally {
      this.probeInFlight = false;
    }
  }

  /**
   * The absolute paths a `certificate`-mode job's composed `signing` block
   * names: the long-lived identity in the console's mounted data root
   * (durable across jobs; see {@link signingIdentityPath}), and the receipt
   * pinned to a fixed name in this job's workdir. Each is composed through
   * its directory's own containment check rather than joined, so a constant
   * that stopped resolving inside that directory is refused rather than
   * naming a file served from outside the workdir.
   */
  private signingPathsFor(
    workdir: string,
  ): JobSigningPaths & { receiptOutput: string } {
    return {
      identityFile: signingIdentityPath(this.dataRoot),
      receiptOutput: workdirArtifactPath(workdir, JOB_FILE_NAMES.receipt),
    };
  }

  /**
   * Create-or-reuse this party's signing identity and return its
   * fingerprint, by spawning the CLI's `fingerprint` subcommand against the
   * mounted identity file.
   *
   * `identityLabel` is the operator's `linkage_terms.identity`, bound into a
   * new identity and ignored (with the CLI's own warning) when one already
   * exists; `exportCertificate` additionally writes the public certificate to
   * a second fixed name in the same mount. The manager owns both paths, so no
   * request value is ever a path.
   *
   * Single-flight: the flag is claimed synchronously, so a concurrent
   * request is {@link SigningFingerprintBusyError} (a 409) rather than a
   * second child racing the same file.
   */
  async resolveSigningFingerprint(args: {
    identityLabel: string;
    exportCertificate: boolean;
  }): Promise<SigningFingerprintResult> {
    if (this.fingerprintInFlight) throw new SigningFingerprintBusyError();
    this.fingerprintInFlight = true;
    try {
      return await runSigningFingerprint({
        binaryPath: this.binaryPath,
        identityPath: signingIdentityPath(this.dataRoot),
        identityLabel: args.identityLabel,
        ...(args.exportCertificate
          ? { exportPath: signingCertificatePath(this.dataRoot) }
          : {}),
        ...(this.childEnv !== undefined ? { childEnv: this.childEnv } : {}),
      });
    } finally {
      this.fingerprintInFlight = false;
    }
  }

  private async startJobInWorkdir(
    intent: JobCreateIntent,
    id: string,
    workdir: string,
    serverEntry: JobSftpServerEntry | undefined,
    mountedInputPath: string | undefined,
  ): Promise<string> {
    // Exchange composes a config document and a key file into the workdir;
    // zero-setup writes NEITHER -- its connection rides argv and it has no
    // shared secret, so the workdir holds only input (when inline), output, and
    // the record pair.
    const exchangeDocuments =
      intent.mode === "zeroSetup"
        ? undefined
        : await this.writeExchangeDocuments(intent, workdir, serverEntry);

    const inputPath = await this.writeJobInput(
      intent,
      workdir,
      mountedInputPath,
    );
    const outputPath = path.join(workdir, JOB_FILE_NAMES.output);
    const recordPath = path.join(workdir, JOB_FILE_NAMES.record);
    const keysPath = path.join(workdir, JOB_FILE_NAMES.recordKeys);
    const logPath =
      intent.diagnosticRun === true
        ? workdirArtifactPath(workdir, JOB_FILE_NAMES.log)
        : null;
    // Only a certificate-mode exchange writes one. A zero-setup run composes no
    // config at all, so it has no signing block and never signs.
    const receiptPath =
      intent.mode !== "zeroSetup" && intent.signing?.mode === "certificate"
        ? this.signingPathsFor(workdir).receiptOutput
        : null;

    const handoff = buildJobHandoff(intent, serverEntry, {
      credentialPasted: this.authoredMaterializedCredentialPath !== undefined,
      filedropSplit: this.jobRendezvousOutboundDir !== undefined,
    });

    const record: JobRecord = {
      id,
      workdir,
      outputPath,
      recordPath,
      keysPath,
      logPath,
      receiptPath,
      status: "running",
      events: [],
      terminalEmitted: false,
      terminal: null,
      handle: null,
      listeners: new Set(),
      cancelTimers: [],
      handoff,
    };
    this.slot = { phase: "active", record, deleted: false };

    // One value for the preflight's recovery copy and for what the child is told
    // to do, so the notice cannot send the operator to a control this very launch
    // already has.
    const sweepExchangeFiles = intent.sweepExchangeFiles === true;

    // Each leg preflights independently and names itself, so a split console's
    // two mounts raise their own notices rather than one set the operator cannot
    // attribute to a folder.
    if (intent.channel === "filedrop" && this.jobRendezvousDir !== undefined)
      for (const [dir, leg] of this.rendezvousLegs())
        for (const message of rendezvousStartupWarnings(
          dir,
          leg,
          this.jobInputDir,
          this.dataRoot,
          workdir,
          sweepExchangeFiles,
        ))
          this.appendEvent(record, { v: 1, type: "warning", message });

    const handlers: CliDriverHandlers = {
      onEvent: (event) => this.appendEvent(record, event),
      onDegraded: (message) =>
        this.appendEvent(record, {
          v: 1,
          type: "warning",
          message,
          degraded: true,
        }),
      onTerminal: (state) => this.reconcileTerminal(record, state),
    };

    record.handle = this.spawnForMode(intent, {
      exchangeDocuments,
      serverEntry,
      inputPath,
      outputPath,
      recordPath,
      workdir,
      eventStream: intent.eventStream ?? true,
      runControls: {
        sweepExchangeFiles,
        logFilePath: logPath ?? undefined,
      },
      handlers,
    });

    return id;
  }

  /**
   * Compose and write the exchange mode's config and key files into the workdir,
   * returning their paths. The connection block is drawn only from the server-side
   * resources ({@link composeDocumentByChannel}); the key file holds the shared
   * secret. Not reached on the zero-setup path, which writes neither.
   */
  private async writeExchangeDocuments(
    intent: JobExchangeIntent,
    workdir: string,
    serverEntry: JobSftpServerEntry | undefined,
  ): Promise<{ configPath: string; keyPath: string }> {
    const configDocument = composeDocumentByChannel(
      intent,
      this.jobRendezvousDir,
      this.jobRendezvousOutboundDir,
      serverEntry,
      this.signingPathsFor(workdir),
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
    return { configPath, keyPath };
  }

  /**
   * Spawn the CLI for the intent's mode: an exchange run driven by the
   * composed config and key files, or a zero-setup run driven by the literal
   * positional `$0` form (URL plus, for sftp, `--server-*` flags), with no
   * `--config-file`, no `--key-file`, and never `--save`. The zero-setup
   * connection argv is built here from the same server-side resources the
   * exchange config draws on, so a missing one is a caller bug reported as a
   * hard error, not a silent fallback.
   */
  private spawnForMode(
    intent: JobCreateIntent,
    args: {
      exchangeDocuments: { configPath: string; keyPath: string } | undefined;
      serverEntry: JobSftpServerEntry | undefined;
      inputPath: string;
      outputPath: string;
      recordPath: string;
      workdir: string;
      eventStream: boolean;
      runControls: CliRunControls;
      handlers: CliDriverHandlers;
    },
  ): CliDriverHandle {
    const extraEnv = this.childEnv;
    if (intent.mode === "zeroSetup")
      return spawnZeroSetupJob({
        binaryPath: this.binaryPath,
        connectionArgs: this.zeroSetupConnectionArgs(intent, args.serverEntry),
        optionArgs: zeroSetupOptionsArgv(intent.options),
        inputPath: args.inputPath,
        outputPath: args.outputPath,
        recordPath: args.recordPath,
        workdir: args.workdir,
        eventStream: args.eventStream,
        runControls: args.runControls,
        ...(intent.identity !== undefined ? { identity: intent.identity } : {}),
        ...(intent.linkageStrategy !== undefined
          ? { linkageStrategy: intent.linkageStrategy }
          : {}),
        ...(extraEnv !== undefined ? { extraEnv } : {}),
        handlers: args.handlers,
      });

    if (args.exchangeDocuments === undefined)
      throw new Error("exchange job reached spawn with no composed documents");
    return spawnExchangeJob({
      binaryPath: this.binaryPath,
      configPath: args.exchangeDocuments.configPath,
      keyPath: args.exchangeDocuments.keyPath,
      inputPath: args.inputPath,
      outputPath: args.outputPath,
      recordPath: args.recordPath,
      workdir: args.workdir,
      eventStream: args.eventStream,
      runControls: args.runControls,
      ...(extraEnv !== undefined ? { extraEnv } : {}),
      handlers: args.handlers,
    });
  }

  /**
   * The connection portion of a zero-setup CLI argv for the intent's channel: the
   * `sftp://` URL and `--server-*` flags from the authored connection, or the
   * `file://` rendezvous locator. Each arm requires the resource `createJob`
   * already resolved, so a missing one is a caller bug reported as a hard error.
   */
  private zeroSetupConnectionArgs(
    intent: JobCreateIntent,
    serverEntry: JobSftpServerEntry | undefined,
  ): Array<string> {
    if (intent.channel === "sftp") {
      if (serverEntry === undefined)
        throw new Error("sftp zero-setup job reached spawn without a server");
      return zeroSetupSftpArgv(serverEntry);
    }
    if (this.jobRendezvousDir === undefined)
      throw new Error(
        "filedrop zero-setup job reached spawn without a rendezvous directory",
      );
    return zeroSetupFiledropArgv(
      this.jobRendezvousDir,
      this.jobRendezvousOutboundDir,
    );
  }

  /**
   * Resolve the path the CLI reads its input from. A `mountedInputPath` points the
   * CLI at the operator-mounted file in place (nothing is copied into the workdir);
   * otherwise the inline `inputCsv` content is written to the fixed workdir name.
   */
  private async writeJobInput(
    intent: JobCreateIntent,
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
   * The active record when the slot holds one matching this id and it has not
   * been deleted, else undefined. A deleted (but not-yet-freed) slot shows
   * 404 here.
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
   * The id of the exchange occupying the single slot, or null when free.
   * Occupied is exactly the states {@link ExchangeBusyError} refuses on -- a
   * starting or active exchange, including one deleted whose child is still
   * dying -- so `GET /api/jobs/slot` and the busy create disclose the same
   * occupant. Delegates to {@link slotId}, the same value `createJob` puts in
   * the busy error.
   */
  occupiedSlotId(): string | null {
    return this.slotId();
  }

  /**
   * The recurring-run hand-off for a job, or null when no live record matches the
   * id (an unknown, deleted, or restart-forgotten job). Held on the record from
   * creation, so it is available across the run's whole lifetime -- the panel reads
   * it at completion, but the endpoint's 404 discipline keys on job existence, not
   * status.
   */
  getJobHandoff(id: string): JobHandoff | null {
    const record = this.getJob(id);
    return record !== undefined ? record.handoff : null;
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
   * Reconcile the child's exit into the job's terminal state. An
   * already-emitted CLI terminal event stands; otherwise one is synthesized
   * to match the exit: cancelled -> a `cancelled`-flavored error, succeeded
   * -> a `result`, persistence loss -> a non-retryable `output`-category
   * error, anything else -> a stream-broke `exchange`-category error.
   *
   * The exit decides the outcome; the terminal event's type decides the
   * status the result route gates on. A persistence loss with the CLI's own
   * `result` terminal is therefore `succeeded` and serves its result, with
   * the loss named on `terminal.outcome`; with no terminal event at all the
   * status is `failed` and nothing is offered.
   *
   * The only slot-release point besides the pre-spawn create failure: fires
   * on the child's `close` (or a spawn `error`), so a killed child is
   * confirmed dead before {@link maybeFreeSlot} frees the slot for a
   * successor.
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
      else if (state.outcome === "completedWithPersistenceLoss")
        this.synthesizeTerminal(record, {
          v: 1,
          type: "error",
          category: "output",
          message:
            "the run reported a lost local write and its event stream broke " +
            "before naming which one, so this console cannot confirm which " +
            "files reached disk; look in the folder it writes its exchange " +
            "files to",
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
   * Free the slot exactly when it is active for this record, the exchange
   * was deleted, and the child's exit has been observed
   * (`record.terminal !== null`, set only in {@link reconcileTerminal}).
   * Keyed on `terminal` rather than `terminalEmitted` (which the overflow
   * path sets while a SIGKILLed child may still be running): no path frees
   * the slot while a killed child might still touch the shared rendezvous or
   * remote directory.
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
   * Delete a job: mark the slot deleted and remove the workdir on disk,
   * signaling a still-running child SIGKILL first. The slot is not freed
   * here when the child was still running -- a SIGKILL is asynchronous, so
   * the child may still be touching the rendezvous after this returns;
   * {@link reconcileTerminal} frees the slot on the child's `close`.
   *
   * When no live record matches the id, the disk-only arm removes a
   * restart-orphaned workdir named by a valid id, refusing the slot's own id
   * (a starting or already-deleted id whose directory a live or dying child
   * owns).
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
      // The authored connection is scoped to this single exchange; deleting the
      // exchange forgets it and its warnings (and deletes any materialized pasted
      // credential), so the next exchange starts from a clean slate.
      this.discardMaterializedCredential();
      this.authoredSftpServer = undefined;
      this.authoredCredentialWarnings = [];
      const workdir = resolveWorkdir(this.dataRoot, id);
      if (workdir !== null) await removeWorkdir(workdir);
      this.maybeFreeSlot(record);
      return true;
    }
    return this.deleteOrphanWorkdir(id);
  }

  /**
   * Remove a restart-orphaned workdir named by a valid id: a disk-only
   * removal touching no in-memory state. Refuses the slot's own id (owned by
   * a live or still-dying child), then applies the containment check
   * ({@link resolveWorkdir}) and the real-directory guard
   * ({@link workdirDirectoryExists}, which lstats so a symlinked leaf is
   * refused rather than followed).
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
 * The record pair's availability for a live record, offered all-or-nothing:
 * the run has settled, both the record and keys files exist, and the record
 * parses into a `createdAt` and an `outcome`.
 *
 * Gated on the record's own existence rather than the run having succeeded:
 * a record is owed from the moment the payload exchange returns
 * (docs/spec/EXCHANGE_RECORD.md, When a record is owed), so a run that
 * disclosed and then terminated writes one too. Settling is read separately
 * because the CLI writes the pair near the end of a run, so a mid-run ask
 * could read a half-written state.
 *
 * `recordOutcome` travels with the availability so a client can tell a
 * terminated record (no result file behind it) from a completed one.
 * `RecordUnavailableReason` separates the console's definitive denial from a
 * record on disk this bundle cannot describe.
 */
function liveRecordAvailability(record: JobRecord):
  | { recordAvailable: false; recordUnavailableReason: RecordUnavailableReason }
  | {
      recordAvailable: true;
      recordCreatedAt: string;
      recordOutcome: ExchangeRecordOutcome;
    } {
  const withheld = (recordUnavailableReason: RecordUnavailableReason) => ({
    recordAvailable: false as const,
    recordUnavailableReason,
  });
  if (record.status === "running") return withheld("not-settled");
  if (!jobFileExists(record.recordPath)) return withheld("no-record");
  const summary = readRecordSummary(record.recordPath);
  if (summary === null || !jobFileExists(record.keysPath))
    return withheld("undescribable-record");
  return {
    recordAvailable: true,
    recordCreatedAt: summary.createdAt,
    recordOutcome: summary.outcome,
  };
}

/**
 * A fixed-name artifact's path inside a job workdir, resolved through the
 * containment check {@link resolveWorkdirFile} rather than joined directly.
 * Every name is a server constant, so a null resolution is a caller bug --
 * reported as a hard error rather than a path outside the workdir the
 * artifact's endpoint would then serve.
 */
function workdirArtifactPath(workdir: string, name: string): string {
  const artifactPath = resolveWorkdirFile(workdir, name);
  if (artifactPath === null)
    throw new Error(`the job ${name} did not resolve inside the workdir`);
  return artifactPath;
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
    // Both answer from the log path set at creation from the intent, so what a
    // client is told about this run's log comes from what the console
    // launched rather than from anything the reading request holds.
    logRequested: record.logPath !== null,
    // Not gated on the run having finished: a diagnostic log's whole point is a
    // run that misbehaved, including one still stalled, so it is offered as soon
    // as the CLI has opened the file.
    logAvailable: record.logPath !== null && jobFileExists(record.logPath),
    // Answered from the receipt path set at creation from the intent, exactly as
    // the log pair above is: what a client is told about this run's receipt comes
    // from what the console launched.
    receiptRequested: record.receiptPath !== null,
    receiptAvailable:
      record.receiptPath !== null && jobFileExists(record.receiptPath),
    outputPath: record.outputPath,
    recordPath: record.recordPath,
    keysPath: record.keysPath,
    logPath: record.logPath,
    receiptPath: record.receiptPath,
  };
}

/**
 * Compose the CLI config document for the intent's channel: filedrop
 * rendezvous in the operator-configured rendezvous mount; sftp rendezvous at
 * the operator-authored connection. Each arm requires the resource `createJob`
 * already resolved, so a missing one here is a caller bug reported as a hard
 * error, not a silent fallback.
 */
function composeDocumentByChannel(
  intent: JobExchangeIntent,
  rendezvousDir: string | undefined,
  outboundRendezvousDir: string | undefined,
  serverEntry: JobSftpServerEntry | undefined,
  signingPaths: JobSigningPaths,
): string {
  if (intent.channel === "sftp") {
    if (serverEntry === undefined)
      throw new Error("sftp job reached compose without a resolved server");
    return composeSftpConfigDocument(intent, serverEntry, signingPaths);
  }
  if (rendezvousDir === undefined)
    throw new Error(
      "filedrop job reached compose without a rendezvous directory",
    );
  return composeConfigDocument(
    intent,
    rendezvousDir,
    outboundRendezvousDir,
    signingPaths,
  );
}
