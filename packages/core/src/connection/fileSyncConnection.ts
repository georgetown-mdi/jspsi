import * as z from "zod";
import { default as EventEmitter } from "eventemitter3";
import { v4 as uuidv4 } from "uuid";

import { getLoggerForVerbosity } from "../utils/logger";
import type {
  SFTPConnectionConfig,
  FileDropConnectionConfig,
} from "../config/connection";
import type { HandshakeRole } from "../types";
import { UsageError } from "../errors";
import {
  ControlFileEnvelopeSchema,
  serializeEnvelope,
  type ControlFileEnvelope,
} from "./controlEnvelope";

const errMessage = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

// Extracts the declared byte count from a message filename by reading the last
// `-`-delimited segment before `.json`. Parsing is right-anchored so an id
// containing hyphens (a UUID, or a configured peer id) cannot corrupt the
// result regardless of how many segments precede the count. Returns undefined
// when that segment is not a non-negative integer.
const parseMessageByteCount = (name: string): number | undefined => {
  const stem = name.slice(0, -".json".length);
  const lastSegment = stem.slice(stem.lastIndexOf("-") + 1);
  if (!/^\d+$/.test(lastSegment)) return undefined;
  return Number(lastSegment);
};

// Right-anchored parse of the NNN (per-session sequence counter) from a
// timestamped message filename (<id>-<ts>-<NNN>-<byteCount>.json). NNN is
// the segment immediately before the terminal byte-count segment. Returns
// undefined when the segment is not a non-negative integer.
//
// Caller contract: only meaningful for a timestamped filename, i.e. retain
// mode, where timestampInFilename is always true. On a non-timestamped name
// (<id>-<byteCount>.json) the segment before the byte count is part of the id,
// so this returns a WRONG value rather than undefined. There is no runtime
// guard (the sole caller, poll() in retain mode, satisfies the contract); a new
// caller outside retain mode must check timestampInFilename itself.
const parseMessageNNN = (name: string): number | undefined => {
  const stem = name.slice(0, -".json".length);
  const withoutByteCount = stem.slice(0, stem.lastIndexOf("-"));
  const nnnStr = withoutByteCount.slice(withoutByteCount.lastIndexOf("-") + 1);
  if (!/^\d+$/.test(nnnStr)) return undefined;
  return Number(nnnStr);
};

// Right-anchored parse of a receipt filename, extracting both the NNN
// (sequence counter) and the declared byte count. The terminal segment is the
// type word "receipt"; the segment immediately before it is the byte count;
// the segment before that is NNN. Returns undefined when the name does not
// match the receipt pattern or either numeric field is missing.
const parseReceiptSegments = (
  name: string,
): { nnn: number; byteCount: number } | undefined => {
  if (!name.endsWith("-receipt.json")) return undefined;
  const stem = name.slice(0, -".json".length);
  // Remove the "-receipt" type token to expose "<id>-<ts>-<NNN>-<byteCount>".
  const withoutToken = stem.slice(0, -"-receipt".length);
  const bcSep = withoutToken.lastIndexOf("-");
  if (bcSep === -1) return undefined;
  const byteCountStr = withoutToken.slice(bcSep + 1);
  if (!/^\d+$/.test(byteCountStr)) return undefined;
  const withoutByteCount = withoutToken.slice(0, bcSep);
  const nnnSep = withoutByteCount.lastIndexOf("-");
  if (nnnSep === -1) return undefined;
  const nnnStr = withoutByteCount.slice(nnnSep + 1);
  if (!/^\d+$/.test(nnnStr)) return undefined;
  return { nnn: Number(nnnStr), byteCount: Number(byteCountStr) };
};

/**
 * Default peer-inactivity budget (1 hour) used when `peerTimeoutMs` is not
 * supplied in the connection options. Bounds how long this side waits for the
 * peer before treating silence as a transport failure: it is the fallback both
 * for the file-sync rendezvous time-to-live and for the CLI's
 * {@link fromEventConnection} inactivity deadline.
 */
export const DEFAULT_PEER_TIMEOUT_MS = 1000 * 60 * 60;
const DEFAULT_POLLING_FREQUENCY_MS = 100;
const DEFAULT_VERBOSITY = 1;
// Consecutive ENOENT from get() after list() surfaced the file indicates a
// filesystem state that is unlikely to self-resolve: emit an error rather
// than looping silently until the peer timeout fires.
//
// 3 is structural rather than performance-tuning, so it is not exposed as a
// config option: one ENOENT after the file appeared in list() is the expected
// TOCTOU race when the peer's cleanup runs between the listing and the get()
// (a single race per message-consumption cycle); two more in a row indicates
// the directory listing is not converging, which is pathological. A smaller
// threshold (1-2) produces false positives on slow filesystems where one
// peer's cleanup may briefly overlap with our next poll; a larger threshold
// (>5) approaches the peer timeout and gives no practical benefit.
const MAX_CONSECUTIVE_ENOENT = 3;

// Suffix shared by all hello files. Using a named constant avoids repeating
// magic strings and numbers at the multiple slice/endsWith sites below.
const HELLO_SUFFIX = "-hello.json";

// Reads a control file (hello or hello-ack) through the I5 partial-sync gate.
// Retries on any get() failure or JSON parse failure (indicating the sync tool
// has not finished writing the file) until timeToLive expires, then throws a
// transport Error. A fully-synced body that parses but fails the envelope
// schema is a terminal UsageError (protocol mismatch, not a transient sync
// gap). Peer-id recovery is always filename-based; this function validates
// the body only.
async function readControlFileWithGate(
  client: FileTransportClient,
  filePath: string,
  timeToLive: Date,
  pollingFrequency: number,
): Promise<ControlFileEnvelope> {
  const delay = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));
  // do-while guarantees at least one read attempt even when timeToLive has
  // already expired by the time the gate is entered (e.g. a slow polling loop
  // that exhausts the budget before reaching this call). Without this a fully-
  // present file would produce a spurious "timed out" error.
  do {
    let raw: Buffer<ArrayBufferLike>;
    try {
      raw = await client.get(filePath, { encoding: "utf-8" });
    } catch {
      // File may not be readable yet (TOCTOU or partial sync); retry.
      await delay(pollingFrequency);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      // Partial write: body is not valid JSON yet; retry until fully synced.
      await delay(pollingFrequency);
      continue;
    }
    const result = ControlFileEnvelopeSchema.safeParse(parsed);
    if (!result.success) {
      throw new UsageError(
        `control file at ${filePath} has a malformed payload: ` +
          result.error.message,
      );
    }
    return result.data;
  } while (Date.now() <= timeToLive.getTime());
  throw new Error(`timed out waiting for ${filePath} to fully sync`);
}

interface Events {
  data: (data: unknown) => void;
  error: (err: unknown) => void;
}

interface Options {
  // Optional: when not supplied to the constructor, open() sets this from
  // `config.options.peerTimeoutMs` (or DEFAULT_PEER_TIMEOUT_MS) so the budget
  // is not consumed by the time between construction and synchronize().
  timeToLive?: Date;
  pollingFrequency: number;
  verbose: number;
  timestampInFilename: boolean;
  locklessRendezvous: boolean;
  peerId?: string;
  retainFiles: boolean;
}

const Message = z.object({
  ts: z.number().nonnegative(),
  seq: z.number().nonnegative(),
  type: z.literal(["Object", "Uint8Array"]),
  payload: z.json(),
});

const getDefaultOptions = (): Options => {
  return {
    pollingFrequency: DEFAULT_POLLING_FREQUENCY_MS,
    verbose: DEFAULT_VERBOSITY,
    timestampInFilename: false,
    locklessRendezvous: false,
    retainFiles: false,
  };
};

export interface FileInfo {
  name: string;
  // Retained for downstream transport consumers; no longer used by the
  // rendezvous tiebreaker (see waitForPeer), which orders on UUID alone
  // because sync tools stamp transfer time rather than creation time.
  modifyTime: number;
  // On-disk byte count, populated by every FileTransportClient.list(). poll()
  // compares it against the declared count encoded in a message filename so a
  // partially synced file is not read as a complete message.
  size: number;
}

export interface PutOptions {
  mode?: number | string;
  flags?: "w" | "a";
  encoding?: null | string;
}

export interface GetOptions {
  mode?: number | string;
  flags?: "r";
  encoding?: null | string;
  handle?: null | string;
}

/**
 * Abstract file transport used by {@link FileSyncConnection}. Implemented by
 * {@link SSH2SFTPClientAdapter} for real SFTP servers and by `LocalFSClient`
 * for locally-mounted network folders.
 */
export interface FileTransportClient {
  /**
   * Options are defined by transport providers and must match their expected
   * names and types.
   */
  connect: (options: Record<string, unknown>) => Promise<void>;
  end: () => Promise<void>;
  list: (path: string) => Promise<Array<FileInfo>>;
  get: (path: string, options?: GetOptions) => Promise<Buffer<ArrayBufferLike>>;
  put: (
    src: string | Buffer | NodeJS.ReadableStream,
    dest: string,
    options?: PutOptions,
  ) => Promise<unknown>;
  delete: (path: string) => Promise<void>;
  /**
   * Removes `path`, swallowing all errors (file-absent, permission, transport).
   * Implementations must never reject so callers may use this in `catch` blocks
   * to clean up without masking the original error.
   */
  safeDelete: (path: string) => Promise<void>;
  rename: (fromPath: string, toPath: string) => Promise<void>;
  /**
   * Creates an empty file at `path` atomically. Throws with
   * `code === "EEXIST"` (or an equivalent server error) if `path` already
   * exists, giving atomic "only one winner" semantics for the wave-file race.
   */
  createExclusive: (path: string) => Promise<void>;
  exists: (remotePath: string) => Promise<boolean>;
}

/**
 * File-based rendezvous and message-passing connection. Implements the
 * `-hello.json`/`.wave` handshake (or the lockless ack-handshake barrier) and
 * `.json` polling protocol over any {@link FileTransportClient} — an SFTP
 * server via {@link SSH2SFTPClientAdapter} or a locally-mounted folder via
 * `LocalFSClient`.
 */
export class FileSyncConnection extends EventEmitter<Events, never> {
  private client: FileTransportClient;
  id: string;
  role: string;
  options: Options;
  log: ReturnType<typeof getLoggerForVerbosity>;
  seq = 0;
  private recvSeq = 0;
  // Highest message NNN whose receipt has already been written, used to keep the
  // retain-mode receipt write idempotent across a reprocess (see poll()). -1
  // means none yet; the first message is NNN 0.
  private lastReceiptedNNN = -1;
  connected = false;

  path: string | undefined;
  private config: SFTPConnectionConfig | FileDropConnectionConfig | undefined;

  peerId: string | undefined;
  handshakeRole: HandshakeRole | undefined;
  private poller: NodeJS.Timeout | undefined;
  private pollerActive: boolean;
  private responsibleFiles: Set<string>;
  private lastSentFile: string | undefined;
  private consecutiveEnoentCount = 0;
  // An `error` emitted while no listener is registered is held here so the
  // next protocol-layer receive can detect failures that arrived in the gap
  // between listener-registration cycles. Reading clears the value; only the
  // most recent unhandled error is retained, since a subsequent error would
  // supersede the first as the proximate cause.
  private bufferedError: unknown;

  constructor(client: FileTransportClient, options?: Partial<Options>) {
    super();
    this.client = client;
    // No peerId validation here: Options is an internal type, not the public
    // FileSyncOptions. The validation boundary is FileSyncOptionsSchema
    // (enforced by parseFileSyncOptions / applyConnectionOverrides). All
    // production callers go through that path before reaching this constructor.
    this.id = options?.peerId ?? uuidv4();
    this.role = "unknown role";
    this.pollerActive = false;
    this.responsibleFiles = new Set();

    this.options = { ...getDefaultOptions(), ...options } as Options;
    this.log = getLoggerForVerbosity(
      `filesync-${this.id.substring(0, 8)}`,
      this.options.verbose,
    );
  }

  // Override emit so that an error fired with no listener is retained rather
  // than dropped. EventEmitter3 silently discards unhandled errors (unlike
  // Node's EventEmitter, which throws); buffering them lets the next
  // protocol-layer receive observe failures that occurred in the gap between
  // listener-registration cycles. `eventNames()` returns the events that
  // currently have listeners; an error-with-no-listener has the event absent.
  emit<E extends keyof Events>(
    event: E,
    ...args: Parameters<Events[E]>
  ): boolean {
    const hadListeners = super.emit(event, ...args);
    if (event === "error" && !hadListeners) {
      // Only the most recent unhandled error is retained because a subsequent
      // error usually supersedes the first as the proximate cause. Surface a
      // log line when this happens so a chained failure is not invisible.
      // When both the prior and new errors are Error instances and the new
      // one has no `cause` set, chain the prior error as its cause so
      // downstream diagnostic output (e.g. an "Error: ... { cause: ... }"
      // formatter) can still surface the earlier failure rather than losing
      // it entirely. Mutation is gated on `cause === undefined` so we never
      // overwrite a cause the caller already set, and on `incoming !==
      // bufferedError` so a re-emit of the same Error reference cannot create
      // a self-referential cause chain that loops a downstream walker.
      const incoming = args[0];
      if (this.bufferedError !== undefined) {
        this.log.warn(
          `[${this.role}] superseding earlier buffered error: ` +
            errMessage(this.bufferedError),
        );
        if (
          incoming instanceof Error &&
          incoming.cause === undefined &&
          incoming !== this.bufferedError
        ) {
          try {
            incoming.cause = this.bufferedError;
          } catch {
            /* error object is frozen; chain is best-effort. */
          }
        }
      }
      this.bufferedError = incoming;
    }
    return hadListeners;
  }

  takeBufferedError(): unknown {
    const e = this.bufferedError;
    this.bufferedError = undefined;
    return e;
  }

  /** Opens a connection from a typed config. Dispatches on `config.channel`. */
  async open(
    config: SFTPConnectionConfig | FileDropConnectionConfig,
  ): Promise<void> {
    if (config.options?.pollIntervalMs !== undefined)
      this.options.pollingFrequency = config.options.pollIntervalMs;
    if (config.options?.timestampInFilename !== undefined)
      this.options.timestampInFilename = config.options.timestampInFilename;
    if (config.options?.locklessRendezvous !== undefined)
      this.options.locklessRendezvous = config.options.locklessRendezvous;
    if (config.options?.retainFiles !== undefined)
      this.options.retainFiles = config.options.retainFiles;
    if (config.options?.peerId !== undefined) {
      this.options.peerId = config.options.peerId;
      this.id = config.options.peerId;
      this.log = getLoggerForVerbosity(
        `filesync-${this.id.substring(0, 8)}`,
        this.options.verbose,
      );
    }
    this.config = config;
    // timeToLive is computed after a successful connect (below) so that
    // retry latency during connection setup does not eat into the
    // peer-waiting budget. Applies to both peerTimeoutMs-supplied and
    // default-fallback windows.

    if (config.channel === "filedrop") {
      // Normalize backslashes to forward slashes so ${this.path}/${name}
      // constructions work on Windows (fs accepts forward slashes there).
      const normalized = config.path.replace(/\\/g, "/");
      // Strip trailing slashes but preserve root-like paths: Unix "/" stays
      // "/", Windows drive root "C:/" stays "C:/" (stripped form "C:" is not
      // a valid path argument on Windows).
      const stripped = normalized.replace(/\/+$/, "");
      const dirPath = /^[A-Za-z]:$/.test(stripped)
        ? stripped + "/"
        : stripped || "/";
      this.log.debug(`[${this.role}] opening local path ${dirPath}`);
      await this.client.connect({
        path: dirPath,
        connectTimeoutMs: config.options?.serverConnectTimeoutMs,
        maxReconnectAttempts: config.options?.maxReconnectAttempts ?? 3,
      });
      this.path = dirPath;
    } else {
      this.path = config.server.path ?? "";
      if (this.path.endsWith("/")) this.path = this.path.slice(0, -1);

      const connectOptions: Record<string, unknown> = {
        host: config.server.host,
        maxReconnectAttempts: config.options?.maxReconnectAttempts ?? 3,
      };
      if (config.server.port !== undefined)
        connectOptions["port"] = config.server.port;
      if (config.server.username !== undefined)
        connectOptions["username"] = config.server.username;
      if (config.server.password !== undefined)
        connectOptions["password"] = config.server.password;
      if (config.server.privateKey !== undefined)
        connectOptions["privateKey"] = config.server.privateKey;
      if (config.server.privateKeyPassphrase !== undefined)
        connectOptions["passphrase"] = config.server.privateKeyPassphrase;
      // serverConnectTimeoutMs for SFTP is enforced by ssh2 via readyTimeout,
      // not a Promise.race wrapper — the per-attempt deadline is equivalent.
      if (config.options?.serverConnectTimeoutMs !== undefined)
        connectOptions["readyTimeout"] = config.options.serverConnectTimeoutMs;
      // providerOptions are spread last so they can override any of the above.
      // certificate, hostKeyFingerprint, and knownHosts also belong here.
      if (config.providerOptions !== undefined)
        Object.assign(connectOptions, config.providerOptions);

      const portString =
        config.server.port !== undefined ? `:${config.server.port}` : "";
      const usernameString =
        config.server.username !== undefined
          ? ` as ${config.server.username}`
          : "";
      this.log.debug(
        `[${this.role}] connecting to ${config.server.host}` +
          `${portString}${usernameString}, path: ${this.path}`,
      );
      await this.client.connect(connectOptions);
    }

    this.connected = true;
    // Compute timeToLive only after connect() has resolved so that retry
    // latency during connection setup does not eat into the peer-waiting
    // budget. Two cases:
    //   1. No constructor timeToLive: derive from config peerTimeoutMs (or the
    //      default fallback) so the full budget is available for peer-waiting.
    //   2. Constructor timeToLive present: it wins - do not recompute it.
    if (this.options.timeToLive === undefined) {
      const ttlMs = config.options?.peerTimeoutMs ?? DEFAULT_PEER_TIMEOUT_MS;
      this.options.timeToLive = new Date(Date.now() + ttlMs);
    }
    this.log.debug(`[${this.role}] connected`);
  }

  async cleanup() {
    // In retain mode, cleanup() removes nothing: in-flight temp-*.tmp writes
    // are cleaned up inline in send()/writeReceipt() before reaching here,
    // and all protocol files are the durable transcript that must persist.
    if (this.options.retainFiles) {
      this.log.debug(
        `[${this.role}] retain mode: directory is transcript, skipping cleanup`,
      );
      return;
    }
    const responsibleFilesString =
      this.responsibleFiles.size > 0
        ? `: ${[...this.responsibleFiles].join(", ")}`
        : "";
    this.log.debug(
      `[${this.role}] cleaning up ${this.responsibleFiles.size} file(s)` +
        `${responsibleFilesString}`,
    );
    return Promise.all(
      Array.from(this.responsibleFiles).map((filename) =>
        this.client.safeDelete(`${this.path}/${filename}`),
      ),
    );
  }

  /**
   * Tears the connection down in full: stops the poll loop, sweeps the files
   * this side is responsible for, then ends the underlying client. Ordering is
   * load-bearing - the poller must stop before the client is ended (or its next
   * cycle would run against a dead client and emit a spurious error), and
   * cleanup must run before the client is ended (it deletes remote files
   * through that client).
   *
   * Before cleanup, drains the last sent file: waits for the peer to consume
   * it so a clean close never deletes an unconsumed terminal frame. The wait is
   * bounded by a fresh `peerTimeoutMs` budget from close() start (not the
   * remaining timeToLive, which may be near-zero for long exchanges). An
   * unresponsive peer causes the drain to time out and cleanup() to delete the
   * file as a fallback. Idempotent: safe to call repeatedly and on a
   * connection that was never opened.
   */
  async close() {
    this.stop();

    if (this.path !== undefined) {
      // Drain the last sent file before sweeping: a clean close must not
      // delete a terminal frame the peer has not yet consumed. Uses a fresh
      // peerTimeoutMs budget from close() start so a long exchange does not
      // leave the budget near-zero for teardown. Drain failure (list() error
      // or timeout) falls through to cleanup(), which deletes as a fallback.
      // In retain mode the last sent file is never deleted, so the drain would
      // spin to its deadline; skip it since cleanup() is a no-op anyway. This
      // is safe, not a lost terminal frame: retain mode never deletes a
      // message, so the final send persists on disk as part of the transcript
      // and the peer's poller reads it whenever it next lists -- durability is
      // decoupled from deletion. The drain exists in delete mode only to stop
      // cleanup() from deleting an unconsumed frame, a race that cannot occur
      // here. Skipping it forgoes only sender-side confirmation that the peer
      // consumed the final message, which matches the durable-receipt contract
      // (a receipt means "durably received", not "consumed by the application").
      if (this.lastSentFile !== undefined && !this.options.retainFiles) {
        const path = this.path;
        const lastSentFile = this.lastSentFile;
        const deadline =
          Date.now() +
          (this.config?.options?.peerTimeoutMs ?? DEFAULT_PEER_TIMEOUT_MS);
        const filePresent = async () =>
          (await this.client.list(path)).some((f) => f.name === lastSentFile);
        try {
          if (await filePresent()) {
            this.log.debug(
              `[${this.role}] draining ${lastSentFile} before cleanup`,
            );
            while (Date.now() < deadline && (await filePresent())) {
              await new Promise((resolve) =>
                setTimeout(resolve, this.options.pollingFrequency),
              );
            }
          }
        } catch {
          // list() failure during drain; fall through to cleanup.
        }
      }

      // Best-effort sweep: a delete failure must not stop us from ending the
      // client, so it is logged rather than propagated.
      try {
        await this.cleanup();
      } catch (err: unknown) {
        this.log.debug(
          `[${this.role}] cleanup during close: ${errMessage(err)}`,
        );
      }
    }

    if (this.connected) {
      this.log.debug(`[${this.role}] closing connection`);
      await this.client.end();
      this.connected = false;
    }
    this.path = undefined;
    this.config = undefined;
    this.resetSessionState();
  }

  /**
   * Negotiates rendezvous with the peer by exchanging `-hello.json` and
   * `.wave` files (wave-race mode) or `-hello.json` and `-hello-ack.json`
   * files (lockless mode) in the shared directory, assigning `peerId` and
   * `handshakeRole` on success.
   *
   * Failures throw synchronously rather than being emitted on the `error`
   * channel: the `error` event is reserved for asynchronous failures from the
   * poll loop (see {@link start}), which can occur at any time. Callers must
   * await this method and catch its rejection; an attached `on("error", ...)`
   * listener will not observe a synchronize-time failure.
   */
  async synchronize() {
    if (!this.connected || this.path === undefined)
      throw new Error("not connected");

    if (this.peerId) throw new Error("already synchronized");

    // Library-level defense-in-depth: the schema refine and CLI imply cover the
    // config/CLI entry points, but a direct library consumer that constructs
    // FileSyncConnection with retainFiles: true and locklessRendezvous: false
    // would otherwise reach the delete-based wave path, which is incompatible
    // with retain mode (wave rendezvous is delete-based and cannot produce the
    // whole-directory no-delete transcript). Make that combination unreachable.
    if (this.options.retainFiles && !this.options.locklessRendezvous)
      throw new UsageError(
        "retain mode requires lockless rendezvous: wave rendezvous is " +
          "delete-based and cannot produce the whole-directory no-delete " +
          "transcript required by retain mode",
      );

    // Without timestampInFilename the message filename has no NNN segment, so
    // poll()'s parseMessageNNN() returns undefined for every file and the
    // receiver silently skips every incoming message. Enforce at the class
    // boundary so a direct library consumer hits a clear error rather than a
    // stall.
    //
    // Note: a warning nudging a stable peer_id when retainFiles is true was
    // removed here. The UUID-collision-on-reuse failure that warning addressed
    // is now hard-blocked by the fresh-directory guard (synchronize() rejects a
    // non-empty directory in retain mode) plus this timestampInFilename guard
    // (which prevents the NNN parse from ever producing undefined). A stable
    // peer_id only affects audit-transcript readability, which is a docs concern
    // and not a runtime warning.
    if (this.options.retainFiles && !this.options.timestampInFilename)
      throw new UsageError(
        "retain mode requires timestamp_in_filename: without it message " +
          "filenames carry no NNN segment and the receiver cannot sequence " +
          "them (every message would be silently skipped)",
      );

    this.log.info(`[${this.role}] synchronizing at path ${this.path}`);

    let files: Array<FileInfo>;
    try {
      files = await this.client.list(this.path);
    } catch (err: unknown) {
      throw err instanceof Error ? err : new Error(errMessage(err));
    }
    const fileNames = files.map((file) => file.name);
    this.log.trace(
      `[${this.role}] found ${files.length} file(s)` +
        `${files.length > 0 ? `: ${fileNames.join(", ")}` : ""}`,
    );
    if (!this.options.retainFiles)
      this.responsibleFiles.forEach((fileName) => {
        if (!fileNames.includes(fileName))
          this.responsibleFiles.delete(fileName);
      });
    // Unified entry precondition (mode-agnostic, both delete and retain). At
    // synchronize() entry the directory must be empty except for at most one
    // peer hello -- a hello file whose id is not this party's own. That is the
    // only file kind that can legitimately predate this party's entry: a party
    // writes its own hello/wave/ack only after observing the peer's hello, and
    // messages and receipts exist only once rendezvous has completed. So the
    // only thing that can already be present is the other party's hello.
    //
    // Anything else is a protocol error: a second peer hello, a self-hello (a
    // same-id leftover from a crashed session), a wave, a handshake-ack, a
    // message, a receipt, an in-flight temp file, or any foreign file. This is
    // strict-empty by design (the directory is the state machine), so a foreign
    // file is rejected rather than ignored. The two cases that legitimately
    // pre-exist as the protocol grows -- an orphaned temp-*.tmp swept by
    // 193792285, and a directory snapshot -- are accommodated by adding their
    // names to `ignored`; until those land it stays empty and every
    // non-peer-hello file is rejected.
    const isPeerHello = (name: string) =>
      name.endsWith(HELLO_SUFFIX) &&
      name.slice(0, -HELLO_SUFFIX.length) !== this.id;
    const ignored = new Set<string>();
    const peerHellos = files.filter((file) => isPeerHello(file.name));
    const unexpected = files.filter(
      (file) => !isPeerHello(file.name) && !ignored.has(file.name),
    );

    if (unexpected.length > 0)
      throw new UsageError(
        `path ${this.path} must be empty except for a single peer hello at ` +
          "the start of the protocol, but contains " +
          `${unexpected.length} unexpected file(s): ` +
          `${unexpected.map((f) => f.name).join(", ")}. A pre-existing wave, ` +
          "handshake-ack, message, receipt, self-hello, or temp file usually " +
          "means a previous exchange was terminated by SIGKILL/OOM/power loss " +
          "before its cleanup ran, or -- in retain mode, which never deletes " +
          "-- that this directory was reused for a second exchange. Remove the " +
          "listed files after confirming no other session is using this path. " +
          "A handshake-ack specifically indicates a crashed lockless session; " +
          "if a live lockless peer is mid-rendezvous, wait for it to complete " +
          "or time out before retrying.",
      );

    if (peerHellos.length > 1)
      throw new UsageError(
        `path ${this.path} contains ${peerHellos.length} peer hello files ` +
          `(${peerHellos.map((f) => f.name).join(", ")}); only one peer may ` +
          "share a rendezvous directory -- are there other sessions using " +
          "this path?",
      );

    const helloPath = `${this.path}/${this.id}${HELLO_SUFFIX}`;

    if (peerHellos.length === 1 && !this.options.locklessRendezvous) {
      /**
       * A list
       * A hello
       * B list
       * B delete A hello
       * B hello
       * A list
       * A delete B hello
       *
       * This is B.
       */

      const otherFile = peerHellos[0];
      const otherPath = `${this.path}/${otherFile.name}`;
      const peerId = otherFile.name.slice(0, -HELLO_SUFFIX.length);

      this.log.debug(
        `[joiner] creating response ${this.id}${HELLO_SUFFIX} and ` +
          `deleting discovered ${otherFile.name}`,
      );

      // I5: read the peer hello body through the partial-sync gate before
      // deleting it. open() sets timeToLive before synchronize() runs, so
      // the non-null assertion is safe.
      await readControlFileWithGate(
        this.client,
        otherPath,
        this.options.timeToLive!,
        this.options.pollingFrequency,
      );

      // Partial-failure note: if delete(otherPath) succeeds but put(helloPath)
      // fails, the peer's hello is gone and we never wrote our own. The peer's
      // waitForPeer loop will see an empty directory and poll until
      // peerTimeoutMs before reporting a synchronization timeout. Recovery is
      // by retry of the whole exchange. We do not re-create the peer's hello
      // here because doing so races the peer's next list() and can produce a
      // two-hello state the wave protocol treats as a collision.
      try {
        await this.client.delete(otherPath);

        await this.client.put(serializeEnvelope({}), helloPath, {
          flags: "w",
          encoding: "utf-8",
        });
        if (!this.options.retainFiles)
          this.responsibleFiles.add(`${this.id}${HELLO_SUFFIX}`);
      } catch (err: unknown) {
        throw err instanceof Error ? err : new Error(errMessage(err));
      }

      // Commit role and peerId only after both writes have succeeded. If
      // either write threw above, the connection stays in its
      // pre-synchronize state: `this.peerId` remains undefined, so the
      // "already synchronized" guard does not block a retry on the same
      // instance, and `handshakeRole` does not point at a peer that may
      // not actually exist.
      if (
        peerId.startsWith(this.id + "-") ||
        this.id.startsWith(peerId + "-")
      ) {
        // Remove our hello before throwing: without this, a retry on the
        // same path (or the same instance) would find the stale file and
        // either mistake it for the peer's hello or trip the preexisting-
        // file guard. The throw escapes synchronize() directly (the joiner
        // fast-path has no enclosing catch), so no outer handler cleans up.
        await this.client.safeDelete(helloPath);
        if (!this.options.retainFiles)
          this.responsibleFiles.delete(`${this.id}${HELLO_SUFFIX}`);
        this.resetSessionState();
        throw new Error(
          `peer id '${peerId}' and this party's id '${this.id}' share a ` +
            "prefix at a '-' boundary; ids must not be prefix-extensions " +
            "of each other (e.g. 'site' / 'site-2')",
        );
      }
      this.handshakeRole = "initiator";
      this.role = "joiner";
      this.peerId = peerId;
    } else {
      /**
       * Either
       *
       * A ~ B list
       * A ~ B hello
       * A list
       * A wave
       *
       * or
       *
       * A ~ B list
       * A ~ B hello
       * A ~ B list
       * A ~ B wave
       *
       * or (lockless mode, joiner fast-path bypassed):
       *
       * A list
       * A hello
       * B list (sees A hello)
       * B hello (does not delete A hello)
       * A ~ B ack-handshake barrier
       */

      this.log.debug(
        `[${this.role}] creating initial ${this.id}${HELLO_SUFFIX}`,
      );
      await this.client.put(serializeEnvelope({}), helloPath, {
        flags: "w",
        encoding: "utf-8",
      });
      if (!this.options.retainFiles)
        this.responsibleFiles.add(`${this.id}${HELLO_SUFFIX}`);
      let wavePath: string | undefined;
      let ackPath: string | undefined;

      const waitForPeer = async () => {
        const delay = (ms: number) =>
          new Promise((resolve) => setTimeout(resolve, ms));
        if (this.options.locklessRendezvous) {
          // Lockless ack-handshake barrier: completes rendezvous using neither
          // createExclusive nor delete. Each party writes a hello, then an ack
          // on seeing the peer's hello, then completes when it sees the peer's
          // ack. A peer hello already present before entering this loop (joiner
          // fast-path bypassed) satisfies the condition on the first iteration.
          //
          // open() set timeToLive before synchronize() can run, so the
          // non-null assertion is safe here.
          while (Date.now() <= this.options.timeToLive!.getTime()) {
            const currentFiles = await this.client.list(this.path!);

            const fileNames = currentFiles.map((file) => file.name);
            if (!this.options.retainFiles)
              this.responsibleFiles.forEach((fileName) => {
                if (!fileNames.includes(fileName))
                  this.responsibleFiles.delete(fileName);
              });

            const peerHellos = currentFiles.filter(
              (file) =>
                file.name !== `${this.id}${HELLO_SUFFIX}` &&
                file.name.endsWith(HELLO_SUFFIX),
            );

            if (peerHellos.length === 0) {
              this.log.trace(`[${this.role}] no peer hello found; polling`);
              await delay(this.options.pollingFrequency);
              continue;
            }

            if (peerHellos.length > 1) {
              throw new UsageError(
                `more than one peer hello file in ${this.path} - are there ` +
                  "other sessions using this path?",
              );
            }

            const peerHello = peerHellos[0];
            const peerId = peerHello.name.slice(0, -HELLO_SUFFIX.length);

            // Write our ack once on the first sighting of the peer's hello.
            if (ackPath === undefined) {
              // I5: read the peer hello body through the partial-sync gate
              // before writing our ack, so a truncated body is not treated as
              // malformed and does not abort the handshake prematurely.
              await readControlFileWithGate(
                this.client,
                `${this.path!}/${peerHello.name}`,
                this.options.timeToLive!,
                this.options.pollingFrequency,
              );
              const ackName = `${this.id}-hello-ack.json`;
              ackPath = `${this.path}/${ackName}`;
              // Pre-track before writing so cleanup() sweeps it at close().
              if (!this.options.retainFiles) this.responsibleFiles.add(ackName);
              this.log.debug(`[${this.role}] writing handshake ack ${ackName}`);
              await this.client.put(serializeEnvelope({}), ackPath, {
                flags: "w",
                encoding: "utf-8",
              });
              // Re-enter the loop so hasPeerAck is checked against a fresh
              // listing; the pre-ack-write snapshot from this iteration may
              // miss a peer ack that arrived in the window between list() and
              // put(), adding up to pollIntervalMs of unnecessary latency on
              // slow-sync transports.
              continue;
            }

            // Barrier completes when the peer's ack is visible in the current
            // listing (always a fresh one because of the continue above).
            const peerAckName = `${peerId}-hello-ack.json`;
            const hasPeerAck = currentFiles.some(
              (file) => file.name === peerAckName,
            );

            if (!hasPeerAck) {
              this.log.trace(
                `[${this.role}] waiting for peer ack ${peerAckName}`,
              );
              await delay(this.options.pollingFrequency);
              continue;
            }

            // I5: read the peer ack body through the partial-sync gate before
            // committing roles; the ack name carries no byte-count segment.
            await readControlFileWithGate(
              this.client,
              `${this.path!}/${peerAckName}`,
              this.options.timeToLive!,
              this.options.pollingFrequency,
            );

            // Peer ack confirmed -- commit roles and peerId as the last step,
            // the same invariant as the joiner path (see above): if the ack
            // write fails before this point, this.peerId stays undefined and
            // the "already synchronized" guard allows a retry on this instance.
            const arrivedFirst = `${this.id}${HELLO_SUFFIX}` < peerHello.name;
            this.handshakeRole = arrivedFirst ? "responder" : "initiator";
            this.role = arrivedFirst ? "starter" : "joiner";
            this.peerId = peerId;

            this.log.debug(
              `[${this.role}] lockless rendezvous complete with ${peerId}`,
            );

            // Do NOT clear responsibleFiles: hello and ack remain so
            // cleanup() can sweep them at close() time, the same as the
            // wave-winner path.
            return;
          }

          throw new Error(`[${this.role}] synchronization has timed out`);
        }

        // Wave-race path.
        // open() set timeToLive before synchronize() can run, so the non-null
        // assertion is safe here.
        while (Date.now() <= this.options.timeToLive!.getTime()) {
          const currentFiles = await this.client.list(this.path!);

          const fileNames = currentFiles.map((file) => file.name);
          if (!this.options.retainFiles)
            this.responsibleFiles.forEach((fileName) => {
              if (!fileNames.includes(fileName))
                this.responsibleFiles.delete(fileName);
            });

          const otherFiles = currentFiles.filter(
            (file) =>
              file.name !== `${this.id}${HELLO_SUFFIX}` &&
              file.name.endsWith(HELLO_SUFFIX),
          );
          const theseFiles = currentFiles.filter(
            (file) => file.name === `${this.id}${HELLO_SUFFIX}`,
          );
          const waveFiles = currentFiles.filter((file) =>
            file.name.endsWith(".wave"),
          );

          if (otherFiles.length === 0) {
            this.log.trace(`[${this.role}] no peer hello found; polling`);
            await delay(this.options.pollingFrequency);
            continue;
          }

          if (waveFiles.length > 0) {
            /**
             * A ~ B list
             * A ~ B hello
             * A list
             * A wave
             * B list
             * B delete A hello, B hello, wave
             *
             * This is B
             */
            if (waveFiles.length > 1) {
              throw new UsageError(
                "more than one wave file - are there other sessions using " +
                  "this path?",
              );
            }
            if (otherFiles.length !== 1) {
              throw new UsageError(
                "wave file detected but no peer hello - are there other " +
                  "sessions using this path?",
              );
            }
            if (theseFiles.length !== 1) {
              throw new UsageError(
                "wave file detected but no self hello - are there other " +
                  "sessions using this path?",
              );
            }

            const waveFile = waveFiles[0];
            const otherFile = otherFiles[0];
            const thisFile = theseFiles[0];

            const thisId = thisFile.name.slice(0, -HELLO_SUFFIX.length);
            const otherId = otherFile.name.slice(0, -HELLO_SUFFIX.length);

            // Use hello filename order -- the same tiebreak the wave producer
            // uses (I7) -- to reconstruct the expected wave name. Do NOT fall
            // back to a raw `thisId < otherId` compare: for ids where one is a
            // prefix of the other (e.g. "Agency" / "Agency A"), space (U+0020)
            // sorts before "-" (U+002D), so hello-filename order and id-order
            // can diverge, causing a false "wave does not reference this
            // connection" throw that UUID tests would never catch.
            const arrivedFirst = thisFile.name < otherFile.name;
            const expectedWaveName = arrivedFirst
              ? `${thisId}-${otherId}.wave`
              : `${otherId}-${thisId}.wave`;

            // Pair validation via reconstruct-and-compare. A stale wave from a
            // different id-pair that happens to concatenate to the same
            // <a>-<b>.wave string is a theoretical residual; the single-wave
            // guard above (waveFiles.length > 1) is the primary protection, so
            // the peer_id charset is left unrestricted rather than working
            // around this edge case here.
            if (waveFile.name !== expectedWaveName)
              throw new Error("wave file does not reference this connection");

            // I5: read the peer hello body through the partial-sync gate
            // before committing roles. The hello name carries no byte-count
            // segment, so a half-synced body cannot be caught by a size check.
            await readControlFileWithGate(
              this.client,
              `${this.path}/${otherFile.name}`,
              this.options.timeToLive!,
              this.options.pollingFrequency,
            );

            // first to arrive => should wait for first message
            this.handshakeRole = arrivedFirst ? "responder" : "initiator";
            this.role =
              this.handshakeRole === "initiator" ? "joiner" : "starter";
            this.peerId = otherId;

            this.log.debug(`[${this.role}] parsed ${waveFile.name}`);

            await this.client.safeDelete(`${this.path}/${waveFile.name}`);
            await this.client.safeDelete(`${this.path}/${otherFile.name}`);
            await this.client.safeDelete(helloPath);

            if (!this.options.retainFiles) this.responsibleFiles.clear();

            return;
          }

          if (otherFiles.length > 1) {
            throw new UsageError(
              `more than one peer hello file in ${this.path} - are there ` +
                "other sessions using this path?",
            );
          }
          const otherFile = otherFiles[0];
          if (theseFiles.length === 0) {
            /**
             * A list
             * A hello
             * B list
             * B delete A hello
             * B hello
             * A delete B hello
             *
             * This is A
             */
            const otherPath = `${this.path}/${otherFile.name}`;

            // I5: read the joiner's hello body through the partial-sync gate
            // before deleting it. The joiner's hello carries no byte-count
            // segment so a half-synced body would be silently misread without
            // this gate.
            await readControlFileWithGate(
              this.client,
              otherPath,
              this.options.timeToLive!,
              this.options.pollingFrequency,
            );

            // arrived first, should wait for a message
            this.handshakeRole = "responder";
            this.role = "starter";
            this.peerId = otherFile.name.slice(0, -HELLO_SUFFIX.length);

            this.log.debug(
              `[${this.role}] detected ${otherFile.name}; deleting it`,
            );

            await this.client.safeDelete(otherPath);

            if (!this.options.retainFiles) this.responsibleFiles.clear();

            return;
          } else {
            if (theseFiles.length > 1) {
              throw new UsageError(
                `more than one self hello file in ${this.path} - are there ` +
                  "other sessions using this path?",
              );
            }

            const thisFile = theseFiles[0];

            // Tiebreak on hello filename order alone, never modifyTime: both
            // parties compute the identical hello filenames, so this comparison
            // is deterministic and symmetric regardless of which party runs it.
            // modifyTime is unreliable here -- sync tools stamp files with the
            // transfer time rather than the original creation time, so the two
            // parties may observe different (even contradictory) timestamps for
            // the same files.
            const arrivedFirst = thisFile.name < otherFile.name;
            this.handshakeRole = arrivedFirst ? "responder" : "initiator";
            this.role = arrivedFirst ? "starter" : "joiner";
            this.peerId = otherFile.name.slice(0, -HELLO_SUFFIX.length);

            // I5 gap: the two-hellos path (winner and EEXIST loser) reads
            // peerId from the filename but does not call readControlFileWithGate
            // on the peer hello body. The body is `{}` today so this is safe,
            // but item 193901017 (bilateral mode flags) must add the gate call
            // to both the winner path and the EEXIST cleanup path before it
            // reads any flag fields from the envelope.
            const waveName =
              `${arrivedFirst ? this.id : this.peerId}-` +
              `${arrivedFirst ? this.peerId : this.id}.wave`;
            wavePath = `${this.path}/${waveName}`;

            this.log.debug(`[${this.role}] attempting to create ${waveName}`);

            // Pre-emptively track waveName in delete mode: if createExclusive
            // only partially succeeds (file created on server but handle-close
            // fails with a non-EEXIST error), cleanup() will still attempt
            // safeDelete even though the EEXIST handler's
            // responsibleFiles.clear() is never reached. Both EEXIST branches
            // below call responsibleFiles.clear(), which also removes this
            // pre-emptive entry. In retain mode cleanup() is a no-op so
            // tracking serves no purpose.
            if (!this.options.retainFiles) this.responsibleFiles.add(waveName);
            try {
              await this.client.createExclusive(wavePath);
              this.log.debug(
                `[${this.role}] created wave file ${waveName}; waiting for ` +
                  "peer to finalize handshake",
              );

              /**
               * A ~ B list
               * A ~ B hello
               * A ~ list
               * A ~ createExclusive wave
               * ...
               *
               * This is A
               */
            } catch (err: unknown) {
              /**
               * A ~ B list
               * A ~ B hello
               * A ~ B list
               * A createExclusive wave
               * B createExclusive wave, EEXIST
               * B delete A hello, B hello, wave
               *
               * This is B
               */
              if (
                !(err instanceof Error) ||
                (err as NodeJS.ErrnoException).code !== "EEXIST"
              )
                throw err;

              const waveAlreadyExists = await this.client.exists(wavePath);

              if (!waveAlreadyExists) {
                // The winner never deletes the wave file in its normal path
                // (it returns from waitForPeer leaving the wave for the loser
                // to clean up). If the wave is gone after we received EEXIST,
                // the winner must have either crashed (their doCleanup ran
                // during the narrow window where waveName was in
                // responsibleFiles) or otherwise abandoned the handshake.
                // Either way, polling for their first protocol message would
                // stall until peerTimeoutMs. Fail fast with a clear cause so
                // the user does not wait for a peer that is not coming.
                // Best-effort tidy of both hellos before throwing so the
                // directory is left clean for a retry.
                await this.client.safeDelete(`${this.path}/${otherFile.name}`);
                await this.client.safeDelete(helloPath);
                if (!this.options.retainFiles) this.responsibleFiles.clear();
                throw new UsageError(
                  "peer appears to have abandoned the handshake: wave file " +
                    "was claimed by the peer but disappeared before this " +
                    "side could complete synchronization. Retry the exchange.",
                );
              } else {
                this.log.debug(
                  `[${this.role}] wave file creation failed, assuming race ` +
                    "condition",
                );

                await this.client.safeDelete(wavePath);
                await this.client.safeDelete(`${this.path}/${otherFile.name}`);
                await this.client.safeDelete(helloPath);

                if (!this.options.retainFiles) this.responsibleFiles.clear();
              }
            }
            return;
          }
        }

        throw new Error(`[${this.role}] synchronization has timed out`);
      };
      try {
        await waitForPeer();
        // No clear() here: branches that finish their own cleanup
        // (responder, wave-detection, EEXIST loser, lockless) clear or retain
        // explicitly before returning. The createExclusive-winner and lockless
        // paths are the exception -- they leave hello (and wave or ack) in
        // responsibleFiles so cleanup() can sweep them if the peer never
        // arrives (e.g. crash before reaching the handshake files). Clearing
        // here would lose that safety net.
        //
        // Both rendezvous modes have assigned this.peerId by this point.
        // Reject prefix-at-dash id pairs before any message is sent; both
        // parties evaluate this symmetrically.
        if (
          this.peerId!.startsWith(this.id + "-") ||
          this.id.startsWith(this.peerId! + "-")
        )
          throw new UsageError(
            `peer id '${this.peerId}' and this party's id '${this.id}' share ` +
              "a prefix at a '-' boundary; ids must not be prefix-extensions " +
              "of each other (e.g. 'site' / 'site-2')",
          );
        return;
      } catch (err: unknown) {
        if (wavePath) await this.client.safeDelete(wavePath);
        if (ackPath) await this.client.safeDelete(ackPath);
        await this.client.safeDelete(helloPath);
        if (!this.options.retainFiles) this.responsibleFiles.clear();
        // The prefix-at-dash guard fires after waitForPeer() has already
        // committed this.peerId, this.role, and this.handshakeRole. Reset
        // them so the "already synchronized" guard does not block a retry
        // and the stale role does not appear in the retry's first log line.
        this.peerId = undefined;
        this.role = "unknown role";
        this.handshakeRole = undefined;
        this.resetSessionState();
        throw err instanceof Error ? err : new Error(errMessage(err));
      }
    }
  }

  /**
   * Writes one message to the shared directory for the peer to consume.
   *
   * Failures throw synchronously rather than being emitted on the `error`
   * channel: the `error` event is reserved for asynchronous failures from the
   * poll loop (see {@link start}). Callers must await this method and catch
   * its rejection; an attached `on("error", ...)` listener will not observe
   * a send-time failure.
   */
  async send(data: unknown) {
    if (!this.connected || this.path === undefined)
      throw new Error("not connected");

    // peerId is committed by synchronize() in all rendezvous paths; guard here
    // (before mode-specific branches) so both retain and non-retain modes
    // require synchronize() to have completed first.
    if (!this.peerId) throw new Error("not synchronized");

    const path = this.path;
    // A `.tmp` extension (not `.json`) keeps this in-flight write from matching
    // a `*.json` sync-tool watch before the rename to the final name lands.
    const tempFile = `temp-${uuidv4()}.tmp`;
    const tempPath = `${path}/${tempFile}`;

    // Each message carries a distinct filename (the byte count, and optionally
    // a counter, differ per send), so a previous message the peer has not yet
    // consumed cannot be found by an exact name. Scan for any `<id>-*.json` we
    // still own and wait for it to clear, preserving the one-outstanding-
    // message-at-a-time invariant the peer's poll() relies on.
    // Typed protocol files (hello, ack, receipt) share the `<id>-` prefix and
    // `.json` extension but have a non-numeric terminal segment. Exclude them
    // via parseMessageByteCount so a renamed hello does not cause send() to
    // spin waiting for a protocol file to disappear.
    // The list() result also prunes responsibleFiles: any entry no longer on
    // the server was consumed by the peer and need not be swept at close time.
    const hasOutstandingMessage = async () => {
      const currentFiles = await this.client.list(path);
      const fileNames = currentFiles.map((f) => f.name);
      this.responsibleFiles.forEach((fileName) => {
        if (!fileNames.includes(fileName))
          this.responsibleFiles.delete(fileName);
      });
      return currentFiles.some(
        (file) =>
          file.name.startsWith(`${this.id}-`) &&
          file.name.endsWith(".json") &&
          parseMessageByteCount(file.name) !== undefined,
      );
    };

    // In retain mode, the peer never deletes our message. Instead we wait for
    // a receipt whose NNN matches the just-sent seq (and whose on-disk size has
    // reached the declared byte count). The first send proceeds without waiting.
    const hasQualifyingReceipt = async (expectedNNN: number) => {
      const currentFiles = await this.client.list(path);
      return currentFiles.some((file) => {
        if (!file.name.startsWith(`${this.peerId!}-`)) return false;
        const segs = parseReceiptSegments(file.name);
        return (
          segs !== undefined &&
          segs.nnn === expectedNNN &&
          file.size >= segs.byteCount
        );
      });
    };

    try {
      if (this.options.retainFiles) {
        // First send (seq === 0) proceeds immediately; subsequent sends wait
        // for a receipt acknowledging the previous message.
        if (this.seq > 0) {
          const expectedNNN = this.seq - 1;
          this.log.debug(
            `[${this.role}] waiting for receipt NNN=${expectedNNN} from ${this.peerId}`,
          );
          // Check for the receipt before the deadline, so a receipt already on
          // disk is honored even if the TTL elapsed in the same instant. This
          // is the do-while rationale readControlFileWithGate uses: re-reading a
          // present receipt costs one list(), whereas discarding it would fail a
          // live exchange with a spurious timeout.
          // open() set timeToLive before send() can run; assertion is safe.
          while (true) {
            if (await hasQualifyingReceipt(expectedNNN)) break;
            if (Date.now() > this.options.timeToLive!.getTime()) {
              throw new UsageError(
                `timed out waiting for receipt from ${this.peerId} for NNN=${expectedNNN}`,
              );
            }
            await new Promise((resolve) =>
              setTimeout(resolve, this.options.pollingFrequency),
            );
          }
        }
      } else {
        if (await hasOutstandingMessage()) {
          this.log.debug(
            `[${this.role}] waiting for previous message to be consumed`,
          );
          while (await hasOutstandingMessage()) {
            // open() set timeToLive before send() can run; assertion is safe.
            if (Date.now() > this.options.timeToLive!.getTime()) {
              throw new UsageError(
                `timed out waiting for message from ${this.id} to be consumed`,
              );
            }
            await new Promise((resolve) =>
              setTimeout(resolve, this.options.pollingFrequency),
            );
          }
        }
      }

      let type = "Object";
      if (data instanceof Uint8Array) {
        data = Buffer.from(data).toString("base64");
        type = "Uint8Array";
      }

      const ts = Date.now();
      // Do not increment this.seq yet: advance only after the durable rename so
      // a failed send does not leave the counter past an unwritten message.
      const seq = this.seq;
      // Serialize before constructing the filename so the encoded byte count is
      // the exact on-disk size; the peer waits until the synced file reaches
      // that many bytes before reading it, so a partial sync delivery is never
      // read as a complete message.
      const payload = Buffer.from(
        JSON.stringify({ ts, seq, type, payload: data }),
      );
      const outName = this.messageFilename(payload.byteLength, seq, ts);
      const outPath = `${path}/${outName}`;

      this.log.trace(
        `[${this.role}] message seq=${seq}, type=${type}, ` +
          `${payload.byteLength} bytes`,
      );
      this.log.debug(`[${this.role}] writing message ${tempFile}`);
      await this.client.put(payload, tempPath, {
        flags: "w",
        encoding: null,
      });

      this.log.debug(`[${this.role}] renaming ${tempFile} to ${outName}`);
      await this.client.rename(tempPath, outPath);
      if (!this.options.retainFiles) this.responsibleFiles.add(outName);
      this.lastSentFile = outName;
      // Advance after the durable rename: a write failure above leaves seq
      // unchanged so a retry can reuse this slot and the receipt gate cannot
      // block on an NNN that was never written.
      this.seq = seq + 1;
    } catch (err: unknown) {
      await this.client.safeDelete(tempPath);
      throw err instanceof Error ? err : new Error(errMessage(err));
    }
  }

  // Builds an outgoing message filename. The byte count is always the final
  // `-`-delimited segment before `.json` so the receiver can extract it with a
  // right-anchored parse (see parseMessageByteCount). When timestampInFilename
  // is set, a compact UTC timestamp and a zero-padded per-session counter are
  // inserted so sync-mediated logging can recover write order even when the
  // sync tool rewrites file mtimes.
  private messageFilename(byteCount: number, seq: number, ts: number): string {
    if (!this.options.timestampInFilename)
      return `${this.id}-${byteCount}.json`;
    // YYYYMMDDTHHMMSS in UTC: no colons or hyphens, so it is Windows-safe,
    // lexicographically time-sortable, and occupies one hyphen-delimited
    // segment.
    const timestamp = new Date(ts)
      .toISOString()
      .replace(/[-:]/g, "")
      .slice(0, 15);
    // Zero-padded to three digits for the common case; widens to four or more
    // past message 999, which keeps names unique (the byte count is still the
    // final segment) at the cost of strict three-digit width on long sessions.
    const counter = String(seq).padStart(3, "0");
    return `${this.id}-${timestamp}-${counter}-${byteCount}.json`;
  }

  // Writes a receipt for a consumed message whose NNN is `nnn`. Follows the
  // same temp-then-rename pattern as send() so the declared byte count in the
  // filename always matches the on-disk size (I5 gate). Returns the final
  // receipt filename (without directory).
  private async writeReceipt(dir: string, nnn: number): Promise<string> {
    const body = serializeEnvelope({});
    const ts = Date.now();
    const timestamp = new Date(ts)
      .toISOString()
      .replace(/[-:]/g, "")
      .slice(0, 15);
    const counter = String(nnn).padStart(3, "0");
    const name = `${this.id}-${timestamp}-${counter}-${body.byteLength}-receipt.json`;
    const tempFile = `temp-${uuidv4()}.tmp`;
    const tempPath = `${dir}/${tempFile}`;
    try {
      await this.client.put(body, tempPath, { flags: "w", encoding: null });
      await this.client.rename(tempPath, `${dir}/${name}`);
    } catch (err) {
      await this.client.safeDelete(tempPath);
      throw err instanceof Error ? err : new Error(errMessage(err));
    }
    return name;
  }

  private async poll() {
    if (!this.pollerActive) return;

    if (!this.connected || this.path === undefined)
      throw new Error("not connected");

    if (!this.peerId) throw new Error("not synchronized");

    const path = this.path;
    const peerId = this.peerId;

    let reachedGet = false;
    try {
      this.log.trace(`[${this.role}] polling for message from ${peerId}`);
      // Detect via a pattern scan rather than an exact-name exists(): the
      // message filename now encodes a per-message byte count (and optionally
      // a timestamp and counter), so the receiver cannot predict the exact
      // name. `<peerId>-*.json` matches only the peer's message files - its
      // `.hello`/`.wave` handshake files and our own `<id>-*.json` writes are
      // excluded by prefix or extension.
      //
      // A name that matches the prefix but whose final segment is not a byte
      // count (e.g. a leftover `<peerId>-backup.json`) is ignored, not treated
      // as an error: the previous exact-name lookup never matched such a file,
      // so failing the exchange over an unrelated file would be a regression.
      //
      // In retain mode, messages are never deleted so the directory accumulates
      // one entry per send. synchronize() asserts a clean directory, so recvSeq
      // starts at 0 and the next unprocessed message always has NNN === recvSeq.
      const allFiles = await this.client.list(path);

      const messages: Array<{ file: FileInfo; declaredSize: number }> = [];
      const ignored: string[] = [];
      for (const file of allFiles) {
        if (!file.name.startsWith(`${peerId}-`) || !file.name.endsWith(".json"))
          continue;
        // Receipt files share the peer prefix and `.json` extension but are
        // control files, not messages. Exclude them here so they never reach
        // the ignored array and do not produce repeated trace-log noise.
        if (file.name.endsWith("-receipt.json")) continue;
        const declaredSize = parseMessageByteCount(file.name);
        if (declaredSize === undefined) {
          ignored.push(file.name);
        } else {
          if (this.options.retainFiles) {
            const nnn = parseMessageNNN(file.name);
            if (nnn === undefined) {
              this.log.trace(
                `[${this.role}] skipping ${file.name}: no numeric NNN segment (unexpected in retain mode)`,
              );
              continue;
            }
            if (nnn !== this.recvSeq) continue;
          }
          messages.push({ file, declaredSize });
        }
      }
      if (ignored.length > 0)
        this.log.trace(
          `[${this.role}] ignoring ${ignored.length} non-message file(s) ` +
            `matching ${peerId}-*.json: ${ignored.join(", ")}`,
        );

      if (messages.length > 1) {
        // Emitted (not thrown to a caller), so no "usage" sentinel: the bridge
        // classifies every poll-loop error as a transport failure.
        if (this.options.retainFiles) {
          // In retain mode the scan is filtered to a single NNN (recvSeq), so
          // two matches mean two files share one NNN -- a protocol violation or
          // directory reuse, not necessarily a separate session.
          throw new UsageError(
            `more than one message file with NNN=${this.recvSeq} from ` +
              `${peerId} in ${path} - possible duplicate-NNN or directory reuse`,
          );
        }
        throw new Error(
          `more than one message file from ${peerId} in ${path} - are there ` +
            "other sessions using this path?",
        );
      }

      if (messages.length === 1) {
        const { file: messageFile, declaredSize } = messages[0];

        if (messageFile.size < declaredSize) {
          // The file has appeared but the sync tool has not finished
          // transferring it. Leave it untouched and re-check next cycle rather
          // than reading a truncated message. For a direct transport (SFTP),
          // the atomic rename means the size already matches on the first poll.
          this.log.trace(
            `[${this.role}] ${messageFile.name} is ${messageFile.size}/` +
              `${declaredSize} bytes; waiting for full sync`,
          );
        } else {
          const inPath = `${path}/${messageFile.name}`;
          this.log.debug(`[${this.role}] getting message ${messageFile.name}`);

          reachedGet = true;
          const message = await this.client.get(inPath, { encoding: "utf-8" });
          reachedGet = false;

          // The file has already passed the byte-count gate above, so it is
          // fully synced: a JSON-parse or schema-validation failure here is
          // genuine corruption, not a partial write, and re-reading the same
          // bytes cannot fix it. Classify it as a terminal UsageError (the
          // catch below stops the poller on a UsageError) -- the same rule
          // readControlFileWithGate applies to control files. This is
          // mode-agnostic: in retain mode the never-deleted file would
          // otherwise be re-read every poll cycle until the peer timeout; in
          // delete mode it is deleted before this runs, but the classification
          // stays uniform so a corrupt frame is a clean terminal failure rather
          // than a silently dropped message.
          const parseMessage = (): z.infer<typeof Message> => {
            let parsed: unknown;
            try {
              parsed = JSON.parse(message.toString());
            } catch (parseErr: unknown) {
              throw new UsageError(
                `message file ${messageFile.name} from ${peerId} is fully ` +
                  `synced but is not valid JSON: ${errMessage(parseErr)}`,
              );
            }
            const result = Message.safeParse(parsed);
            if (!result.success)
              throw new UsageError(
                `message file ${messageFile.name} from ${peerId} is fully ` +
                  `synced but failed schema validation: ${result.error.message}`,
              );
            return result.data;
          };

          if (this.options.retainFiles) {
            // Retain mode never deletes the message file: the directory is the
            // durable transcript, and the receipt -- written here after
            // validation and before emit -- is the consumption signal the sender
            // waits for in place of the file disappearing. Because no message is
            // ever removed, the directory accumulates one message and one receipt
            // per exchanged message on every transport (not only no-delete ones);
            // poll() re-lists and reclassifies it each cycle, so per-poll cost
            // scales with transcript length. Rotation/retention is an out-of-band
            // operator responsibility.
            const msgNNN = this.recvSeq;

            const validatedMessage = parseMessage();

            // Both the sender and receiver derive NNN from the same per-session
            // counter, so a body seq that does not match the filename NNN
            // indicates file corruption or a protocol bug. Surface it
            // immediately rather than silently receipting or delivering a
            // mismatched message.
            if (validatedMessage.seq !== msgNNN)
              throw new UsageError(
                `message body seq=${validatedMessage.seq} does not match ` +
                  `filename NNN=${msgNNN}: possible corruption or protocol bug`,
              );

            this.log.trace(
              `[${this.role}] received message seq=${validatedMessage.seq}, ` +
                `type=${validatedMessage.type}`,
            );

            // Write the receipt before emit. The receipt is the sender's
            // go-ahead signal and means "durably received", not "consumed by the
            // application": the message is a fully-synced file that retain mode
            // never deletes, so it is already durable at this point, and acking
            // before the local hand-off keeps the peer unblocked even when emit
            // fails (e.g. downstream backpressure). Do NOT reorder to
            // emit-before-receipt -- a receipt-write failure after a successful
            // emit would re-deliver an already-consumed message.
            //
            // Write only once per message: if a prior poll wrote this NNN's
            // receipt and then emit threw, recvSeq stayed at msgNNN and the
            // message is reprocessed here. Writing again would leave two receipts
            // for one message, so skip when this NNN was already receipted.
            if (this.lastReceiptedNNN !== msgNNN) {
              const receiptName = await this.writeReceipt(path, msgNNN);
              this.lastReceiptedNNN = msgNNN;
              this.log.debug(
                `[${this.role}] wrote receipt ${receiptName} for seq=${validatedMessage.seq}`,
              );
            }

            if (validatedMessage.type === "Uint8Array") {
              const bytes = Buffer.from(
                validatedMessage.payload as string,
                "base64",
              );
              this.emit("data", bytes);
            } else {
              this.emit("data", validatedMessage.payload);
            }
            // Advance only after the application has seen the payload: if emit
            // throws, recvSeq stays at msgNNN so the (never-deleted) message file
            // is reprocessed on the next poll rather than permanently lost.
            this.recvSeq++;
          } else {
            this.log.debug(
              `[${this.role}] deleting message ${messageFile.name}`,
            );
            try {
              await this.client.delete(inPath);
            } catch {
              await new Promise((resolve) =>
                setTimeout(resolve, this.options.pollingFrequency),
              );
              try {
                await this.client.delete(inPath);
              } catch (deleteErr: unknown) {
                this.log.warn(
                  `[${this.role}] failed to delete ${messageFile.name}; ` +
                    "please notify the administrator that manual cleanup " +
                    `may be required: ${errMessage(deleteErr)}`,
                );
              }
            }

            const validatedMessage = parseMessage();
            this.log.trace(
              `[${this.role}] received message seq=${validatedMessage.seq}, ` +
                `type=${validatedMessage.type}`,
            );

            if (validatedMessage.type === "Uint8Array") {
              const bytes = Buffer.from(
                validatedMessage.payload as string,
                "base64",
              );
              this.emit("data", bytes);
            } else {
              this.emit("data", validatedMessage.payload);
            }
          }
        }
      }
      this.consecutiveEnoentCount = 0;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT" && reachedGet) {
        // TOCTOU race: list() surfaced the file but get() found it gone,
        // meaning the peer cleaned up between the two calls. After a single
        // race the file is genuinely gone and subsequent list() cycles no
        // longer match it, resetting the counter on the next clean poll.
        // Consecutive ENOENTs that keep incrementing the counter indicate a
        // pathological filesystem state that will not self-resolve; emit an
        // error after MAX_CONSECUTIVE_ENOENT rather than looping silently
        // until the peer timeout fires.
        if (++this.consecutiveEnoentCount >= MAX_CONSECUTIVE_ENOENT) {
          // Stop the poller synchronously before emitting so that the
          // finally block does not reschedule another poll. The external
          // error handler (doCleanup → conn.stop()) is still called and
          // is safe when pollerActive is already false.
          this.pollerActive = false;
          this.emit(
            "error",
            err instanceof Error ? err : new Error(errMessage(err)),
          );
        } else {
          this.log.warn(
            `[${this.role}] message from ${peerId} disappeared between list ` +
              "and get; assuming peer cleaned up",
          );
        }
      } else {
        // Non-TOCTOU failure: either a non-ENOENT error from any operation, or
        // any error where reachedGet is false (e.g., exists() or message
        // parsing). Note: delete() errors cannot reach here — delete() has its
        // own inner try/catch (see above) that handles and swallows them.
        // All cases are propagated immediately as hard failures.
        this.consecutiveEnoentCount = 0;
        // A UsageError reaching this catch is terminal -- re-reading the same
        // bytes cannot help: a fully-synced message that fails to parse or
        // validate, a body-seq/filename-NNN mismatch, or a duplicate NNN. Stop
        // the poller before emitting so the finally block does not reschedule
        // and re-read the same corrupt file. A transient non-UsageError -- a
        // list/get/put/rename or receipt-write transport hiccup -- reschedules
        // instead, so the never-deleted retain message is reprocessed (I8).
        // emit("data") sits in this try too, but the sole production consumer
        // (deliver() in messageConnection.ts) cannot throw synchronously; if a
        // future handler ever threw a UsageError it would be terminal here,
        // which is the safe default.
        if (err instanceof UsageError) this.pollerActive = false;
        this.emit(
          "error",
          err instanceof Error ? err : new Error(errMessage(err)),
        );
      }
    } finally {
      if (this.pollerActive) {
        this.poller = setTimeout(
          () => this.poll(),
          this.options.pollingFrequency,
        );
      }
    }
  }

  // Resets all per-session counters and tracking to their initial state.
  // Called at the rendezvous outer catch (to allow retry on the same instance),
  // at the joiner prefix-at-dash error path, and at close() (so a closed
  // instance does not carry stale counters into a hypothetical re-open).
  private resetSessionState() {
    this.seq = 0;
    this.recvSeq = 0;
    this.lastReceiptedNNN = -1;
    this.lastSentFile = undefined;
  }

  start() {
    this.log.debug(`[${this.role}] starting poller`);
    this.pollerActive = true;
    this.consecutiveEnoentCount = 0;
    this.poll();
  }

  stop() {
    this.log.debug(`[${this.role}] stopping poller`);
    this.pollerActive = false;
    if (this.poller) clearTimeout(this.poller);
  }
}
