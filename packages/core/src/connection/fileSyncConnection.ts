import { default as EventEmitter } from "eventemitter3";
import { v4 as uuidv4 } from "uuid";

import { getLoggerForVerbosity } from "../utils/logger";
import { pathsResolveToSameDir } from "../utils/pathCompare";
import { sanitizeForDisplay } from "../utils/sanitizeForDisplay";
import {
  DEFAULT_SERVER_CONNECT_TIMEOUT_MS,
  DEFAULT_MAX_RECONNECT_ATTEMPTS,
} from "../config/connection";
import type {
  SFTPConnectionConfig,
  FileDropConnectionConfig,
} from "../config/connection";
import type { HandshakeRole } from "../types";
import { ConnectionError } from "./messageConnection";
import {
  UsageError,
  ConnectionClosedError,
  TransportOperationStalledError,
} from "../errors";
import { cancellableDelay } from "./fileSyncConstants";
import { ackMarkerName } from "./fileSyncNames";
// Re-export the two grammar recognizers that were part of this module's public
// surface before the grammar was split out to fileSyncNames.ts (which is not
// barrelled by main.ts). This keeps them importable from `fileSyncConnection`
// and in the package barrel exactly as before; neither is used internally here.
export { isAbortMarkerName, isExpectedAbortName } from "./fileSyncNames";
import { FileSyncMessageLoop } from "./fileSyncMessageLoop";
import type { PresentedHostKey } from "./sftpConnect";
import { AbortMarkerSubsystem } from "./abortMarker";
import { SftpSession } from "./sftpSession";
// Re-export PresentedHostKey, which was part of this module's public surface
// before the SFTP connect/host-key concern was split out to sftpConnect.ts
// (which main.ts does not barrel). This keeps it importable from
// `fileSyncConnection` and in the package barrel exactly as before; it is also
// used internally below (imported above as a type).
export type { PresentedHostKey } from "./sftpConnect";
// Re-export the message-framing codec symbols that were part of this module's
// public surface before the codec was split out to fileSyncFraming.ts (which
// main.ts does not barrel). This keeps them importable from `fileSyncConnection`
// and in the package barrel exactly as before. The message loop that consumes
// them internally lives in fileSyncMessageLoop.ts.
export {
  MESSAGE_ENVELOPE_VERSION,
  MESSAGE_TYPE_OBJECT,
  MESSAGE_TYPE_BINARY,
  MESSAGE_HEADER_BYTES,
  serializeFileSyncMessageHeader,
  serializeFileSyncMessage,
} from "./fileSyncFraming";
import { FileSyncRendezvous, type RendezvousScope } from "./fileSyncRendezvous";

const errMessage = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/**
 * Canonicalize a `filedrop` connection path to the form the connection uses on
 * disk: fold backslashes to forward slashes (so `${path}/${name}` constructions
 * work on Windows, where `fs` accepts forward slashes), then strip trailing
 * slashes while preserving root-like paths -- Unix "/" stays "/", and a Windows
 * drive root "C:/" stays "C:/" (the stripped form "C:" is not a valid path
 * argument on Windows). {@link FileSyncConnection.open} applies this to the
 * configured path before use.
 *
 * Exported so a caller that compares two filedrop paths for equality -- the
 * CLI's config reconcile -- can decide it exactly as the live connection would,
 * by normalizing both sides through this one function rather than
 * reimplementing, and drifting from, the rule.
 */
export function normalizeFiledropPath(rawPath: string): string {
  const normalized = rawPath.replace(/\\/g, "/");
  const stripped = normalized.replace(/\/+$/, "");
  return /^[A-Za-z]:$/.test(stripped) ? stripped + "/" : stripped || "/";
}

// Builds the terminal error for a transport await that outran the peer-inactivity
// budget. `operation` names the call and its target (e.g. "file write to
// .../temp-x.tmp"). It is a TransportOperationStalledError -- a UsageError, so the
// poll loop treats it as terminal (stops rather than retrying into the same hang)
// and the CLI classifies it exit-64 -- the same typed failure the CLI adapter's
// per-operation read bounds raise, so a hang surfaces identically wherever it is
// caught. See docs/spec/CHANNEL_SECURITY.md.
//
// `operation` is routed through sanitizeForDisplay: the target it names is a
// transport path, and on a get/delete of a peer message file that path embeds
// the partner-chosen filename, so a stalled read of a hostile name would
// otherwise echo its control/ANSI/Unicode bytes raw to the operator. This is the
// core-side whole-exchange-budget twin of the CLI adapter's per-operation
// transportOperationStalledError, which escapes its path the same way.
const transportBudgetExceededError = (
  operation: string,
  budgetMs: number,
): TransportOperationStalledError =>
  new TransportOperationStalledError(
    `transport ${sanitizeForDisplay(operation)} exceeded the ${budgetMs} ms ` +
      `peer-inactivity budget; the peer or server has not responded within the ` +
      `budget, so the exchange is failing rather than waiting on it further`,
  );

// Races a transport operation against the peer-inactivity budget so a server that
// withholds its callback cannot hang the await past `budgetMs`: settles with the
// operation's own result if it finishes first, otherwise rejects with
// `makeError()` once the budget elapses. This is the consumer-layer, op-agnostic
// backstop beneath the CLI adapter's per-operation READ bounds (see
// boundTransport): those fast-fail a stalled read in 60 s, this bounds EVERY await
// -- writes, stat, delete, the filedrop/local-FS path, and any future op -- so a
// withheld callback fails the exchange within the budget instead of hanging
// forever (the silent-poller-stop S1 finding).
//
// It is the core-side analogue of the CLI adapter's `withSftpOperationDeadline`,
// re-implemented here because `apps/` depends on `packages/core`, not the reverse,
// so the adapter helper cannot be imported up into core. Both share the same two
// load-bearing properties: the timer is `unref`'d so the safety bound never holds
// the process open on its own, and a `promise` that loses the race and later
// rejects is absorbed by a no-op `catch` (it has no other consumer) rather than
// surfacing as an unhandled rejection -- without changing the race outcome, since
// `settled` is what `Promise.race` observes either way. When the budget wins, the
// underlying operation keeps running and is abandoned; the session tears down on
// the terminal error.
function withTransportBudget<T>(
  op: Promise<T>,
  budgetMs: number,
  makeError: () => TransportOperationStalledError,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(makeError()), budgetMs);
    timer.unref();
  });
  const settled = op.finally(() => clearTimeout(timer));
  void settled.catch(() => {});
  return Promise.race([settled, deadline]);
}

// safeDelete variant of withTransportBudget: bounds the wait the same way but
// RESOLVES (void) when the budget wins rather than rejecting, preserving
// safeDelete's "never rejects" contract so callers may keep using it in `catch`
// blocks. A hung safeDelete on a cleanup path is thus bounded for liveness without
// turning best-effort cleanup into a thrown error. The underlying op should never
// reject (safeDelete swallows its own errors), but a stray rejection is absorbed
// for the same reason as above.
function withTransportBudgetVoid(
  op: Promise<void>,
  budgetMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, budgetMs);
    timer.unref();
  });
  const settled = op.finally(() => clearTimeout(timer));
  void settled.catch(() => {});
  return Promise.race([settled, deadline]);
}

/**
 * Default peer-inactivity budget (1 hour) used when `peerTimeoutMs` is not
 * supplied in the connection options. Bounds how long this side waits for the
 * peer before treating silence as a transport failure: it is the fallback both
 * for the file-sync rendezvous time-to-live and for the CLI's
 * {@link fromEventConnection} inactivity deadline.
 */
export const DEFAULT_PEER_TIMEOUT_MS = 1000 * 60 * 60;
// Teardown-only bound on the close() terminal-frame drain (delete mode). The
// drain waits for the peer to consume (delete) the last sent frame before
// cleanup() sweeps it; unlike the live exchange's peer-inactivity budget this
// wait protects nothing durable -- the exchange result is already computed and
// persisted, and cleanup() deletes the frame as a fallback if the drain times
// out (durability is decoupled from deletion; see close()). So it is bounded by
// this short fixed budget, sized to a sync tool's flush latency (a peer's poller
// listing the directory, consuming the frame, and the deletion propagating back)
// and on the same order as the per-operation liveness bounds, NOT the full
// peerTimeoutMs (default one hour): a clean close against a crashed or departed
// peer then fast-fails in seconds instead of parking for up to the hour. close()
// applies it as min(this, peerTimeoutMs) so an operator who configures a tiny
// peer budget still never gets a LONGER teardown than they asked for. Kept above
// single-digit seconds so an ordinary sync-mediated (filedrop) last-frame
// propagation is not routinely lost to a too-tight race, and internal-only (not
// a config knob) for the same reason as DEFAULT_JOINER_RECOVERY_MS: the value
// only matters when a peer is mid-consumption at teardown, which a correct peer
// resolves well inside it.
/** @internal */
export const TERMINAL_FRAME_DRAIN_TIMEOUT_MS = 1000 * 60;
/**
 * Default interval, in milliseconds, between polls for a partner's file when the
 * connection options do not set `pollIntervalMs`. Exported so the CLI's
 * configuration-template emitter pre-fills the same value it documents as the
 * default, instead of a literal that could drift from this one.
 *
 * Deliberately conservative, NOT a sub-second value: the per-round PSI encryption
 * dominates an exchange's wall-clock time, so poll latency is negligible for a
 * real dataset, whereas a sub-second interval hammers the server with directory
 * listings and can trip an SFTP server's anti-flood/DoS protection and drop the
 * connection (observed in a partner deployment at 100 ms). A demo that wants a
 * snappier, WebRTC-like poll should set `pollIntervalMs` explicitly rather than
 * lowering this default.
 */
export const DEFAULT_POLLING_FREQUENCY_MS = 5000;
const DEFAULT_VERBOSITY = 1;

// Bounded window the lock-path peer waits for a joiner that has begun arriving
// (its `<id>-joining.json` sentinel is visible) to finish renaming the sentinel
// to its hello. The joiner's remaining work is one delete plus one rename --
// milliseconds on a direct transport, seconds on a sync-mediated one -- so a
// window well under peerTimeoutMs distinguishes a slow-but-live joiner from a
// crashed one without making the peer wait the full inactivity budget. This is
// the timing heuristic the sentinel narrows to a short, well-defined window
// rather than the full hour. Internal-only (not a user-facing config option):
// the default suits both transport classes and the value only matters when a
// joiner fails mid-arrival, which a correct peer never causes.
const DEFAULT_JOINER_RECOVERY_MS = 1000 * 30;

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
  // Policy for a file that appears mid-loop and is neither recognized for the
  // exchange nor an in-flight temp write. Left optional (the raw preference):
  // an unset value resolves to a mode-coupled effective default at the use
  // site (see resolveUnexpectedFilesPolicy), so the resolution does not depend
  // on the order in which retainFiles/locklessRendezvous are assigned during
  // open(). An explicit value always wins.
  unexpectedFiles?: "error" | "warn" | "ignore";
  // CLI-only, NON-persistable runtime controls for the entry sweep
  // (--sweep-exchange-files / --force-retain-sweep). Deliberately NOT mirrored
  // on FileSyncOptions / the Zod config schema: anything there is persistable in
  // psilink.yaml by construction, which contradicts "invocation-scoped, never
  // persisted". They reach this type only through the constructor's
  // Partial<Options> (the verbose/joinerRecoveryMs precedent), never from
  // config.options in open(). The CLI command layer threads them on a path
  // separate from config construction (see docs/spec/FILE_SYNC.md).
  sweepExchangeFiles: boolean;
  // Escalation of sweepExchangeFiles: permits the sweep to wipe a directory that
  // shows a retain signal (a durable audit transcript). Meaningless without
  // sweepExchangeFiles, which the CLI enforces by rejecting it on its own.
  forceRetainSweep: boolean;
  // How long the lock-path peer waits for a mid-arrival joiner (a visible
  // `<id>-joining.json` sentinel) to finish before treating it as crashed. Not
  // surfaced in the public config; defaults to DEFAULT_JOINER_RECOVERY_MS.
  // Tests lower it to exercise the abort path without a real-time wait.
  joinerRecoveryMs: number;
}

const getDefaultOptions = (): Options => {
  return {
    pollingFrequency: DEFAULT_POLLING_FREQUENCY_MS,
    verbose: DEFAULT_VERBOSITY,
    timestampInFilename: false,
    locklessRendezvous: false,
    retainFiles: false,
    sweepExchangeFiles: false,
    forceRetainSweep: false,
    joinerRecoveryMs: DEFAULT_JOINER_RECOVERY_MS,
  };
};

export interface FileInfo {
  name: string;
  // Kept for downstream transport consumers. The rendezvous tiebreaker (see
  // waitForPeer) does not read it -- it orders on UUID alone, because sync tools
  // stamp transfer time rather than creation time.
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

/**
 * Body accepted by {@link FileTransportClient.put}. Either a single contiguous
 * `Buffer` (a hello, a zero-length ack, an abort marker) or an ORDERED LIST of
 * `Uint8Array` chunks written back-to-back as one file WITHOUT concatenating
 * them in memory -- the message send path hands `put` its `[header, payload]`
 * pair this way so a binary frame holds ~1x its size live rather than ~2x (see
 * {@link FileSyncConnection.send}). A `string` (an SFTP local-file path to copy
 * from) and a one-shot `NodeJS.ReadableStream` remain in the transport-agnostic
 * surface but are not produced by this codebase. A `Uint8Array[]` src is
 * re-iterable, so an adapter that retries a failed upload can rebuild its source
 * from it per attempt, exactly as it can from a `Buffer` (a one-shot stream
 * cannot, which is why a stream gets a single attempt).
 */
export type PutSource = string | Buffer | Uint8Array[] | NodeJS.ReadableStream;

export interface GetOptions {
  mode?: number | string;
  flags?: "r";
  encoding?: null | string;
  handle?: null | string;
  /**
   * Maximum number of bytes the read may pull into memory. A file larger than
   * this is refused with a {@link FrameSizeExceededError} -- before any read for
   * a stat-capable adapter, or after at most one stream chunk past the cap for a
   * streaming one -- so allocation stays bounded to roughly `maxBytes` rather
   * than the (possibly attacker-chosen) file size. This is the hard backstop
   * behind the poll loop's pre-`get()` size check; it is what still bounds the
   * read when a server under-reports a file's size in its directory listing.
   * Omit for an uncapped read.
   *
   * A capped read always resolves to a raw Buffer; `encoding` is not applied
   * (the streaming adapter drops it so the running byte count stays exact).
   * Callers that need a string decode the result with `.toString()`, as they
   * already do for the always-raw-Buffer {@link LocalFSClient}.
   */
  maxBytes?: number;
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
  put: (src: PutSource, dest: string, options?: PutOptions) => Promise<unknown>;
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
   * exists, giving atomic "only one winner" semantics for the lock-file race.
   */
  createExclusive: (path: string) => Promise<void>;
  exists: (remotePath: string) => Promise<boolean>;
  /**
   * Optional cycle-boundary signal for a session-holding transport running in
   * connection-per-poll (ephemeral-session) mode: the poll loop invokes it at an
   * idle boundary (the inter-poll reschedule) so the transport may release its
   * session for the idle gap rather than holding it across a server's
   * max-session/idle cap. Modeled on {@link MessageConnection.setInboundFrameCap}:
   * core calls it only when the transport implements it, so a connectionless
   * transport (`LocalFSClient`) simply omits it and is unaffected, and a
   * session-holding transport with the mode off implements it as a no-op. The
   * release MUST be non-terminal -- it must not tear the transport down in a way
   * that disables the next cycle's reconnect. See
   * docs/notes/connection-per-poll-sftp.md.
   */
  releaseForIdle?: () => Promise<void>;
  /**
   * Optional companion to {@link FileTransportClient.releaseForIdle}: the poll
   * loop invokes it at the START of a cycle (and close() invokes it before the
   * terminal-frame drain) so a transport that released its session for the idle
   * gap re-establishes one before the cycle's ops run, rather than lazily
   * re-dialing on the next op's rejection. Resolves `true` once a session is live
   * and `false` when the re-dial failed transiently (the caller skips this cycle
   * and retries on the next tick); rejects only on a genuinely fatal condition (a
   * host-key or credential rejection) that must terminate the exchange. Optional
   * and mode-gated exactly like {@link FileTransportClient.releaseForIdle}.
   */
  ensureConnected?: () => Promise<boolean>;
  /**
   * Optional teardown signal for a session-holding transport that bounds its
   * mid-exchange reconnections: {@link FileSyncConnection.close} invokes it once at
   * the top of teardown so the transport can mark that the re-dials teardown still
   * issues -- the authenticated abort-marker write and the terminal-frame drain --
   * are exempt from that reconnection cap and neither counted nor warned. Without
   * it a capping server that exhausted the budget mid-exchange would refuse the
   * marker write's own re-dial, dropping the fast-fail marker exactly when a
   * waiting peer most needs it. Optional and no-op-when-absent exactly like
   * {@link FileTransportClient.releaseForIdle}: a connectionless transport
   * (`LocalFSClient`) simply omits it.
   */
  beginTeardown?: () => void;
}

/**
 * File-based rendezvous and message-passing connection. Implements the
 * `-hello.json`/`-lock.json` handshake (or the lockless ack-handshake barrier) and
 * `.json` polling protocol over any {@link FileTransportClient} -- an SFTP
 * server via {@link SSH2SFTPClientAdapter} or a locally-mounted folder via
 * `LocalFSClient`.
 */
export class FileSyncConnection extends EventEmitter<Events, never> {
  private client: FileTransportClient;
  id: string;
  role: string;
  options: Options;
  log: ReturnType<typeof getLoggerForVerbosity>;
  // The per-session send-sequence counter lives on the composed message loop;
  // expose it through a delegating getter/setter so external readers and tests
  // that read or set conn.seq are unchanged (mirrors observedHostKey).
  get seq(): number {
    return this.messageLoop.seq;
  }
  set seq(value: number) {
    this.messageLoop.seq = value;
  }
  connected = false;

  // The inbound directory: where this party READS the peer's files (hello,
  // messages, acks, the peer's abort marker). `path` is the inbound directory's
  // historical name, kept because tests and callers set it directly. undefined
  // outside an open session.
  path: string | undefined;
  // The configured separate OUTBOUND directory (split mode), or undefined when
  // inbound and outbound are the same shared directory. When set it requires
  // retain mode (enforced at config validation), so only the lockless+retain
  // code paths ever observe a value different from `path`. Public so tests can
  // set it directly, mirroring the `path`/`connected` direct-set pattern; open()
  // sets it from the config. See docs/spec/FILE_SYNC.md (Split directories).
  outbound: string | undefined;
  private config: SFTPConnectionConfig | FileDropConnectionConfig | undefined;

  peerId: string | undefined;
  handshakeRole: HandshakeRole | undefined;
  // The host key the SFTP server presented on this connection, or `undefined` on
  // every path that observes no host key (a file-drop mount, the browser/proxy
  // SFTP path, or a refused connection that never establishes a session). Read
  // post-handshake by the orchestrator to advertise this party's observed
  // fingerprint for cross-party reconciliation. The live state lives on the
  // sftpSession subsystem, written by the enforcing host-key verifier on its
  // pin-match branch; this getter keeps the value readable where it always was.
  get observedHostKey(): PresentedHostKey | undefined {
    return this.sftpSession.observedHostKey;
  }
  // Cancellation primitive threaded through every wait site (see wait() and
  // cancellableDelay). close() aborts it so an in-flight sleep rejects
  // promptly; synchronize() re-arms a fresh one per session. Constructed inline
  // so a never-opened/never-synchronized instance is safe (close() before any
  // session cannot NPE), and re-armed at session start rather than in
  // resetSessionState() so a recovery reset mid-rendezvous cannot wipe a
  // concurrent close()'s abort (see synchronize()).
  private abortController = new AbortController();
  private responsibleFiles: Set<string>;
  // Foreign (grammar-failing) file names present in the directory at
  // synchronize() entry. Recorded so the poll loop tolerates them
  // (isRecognizedLoopFile) and the "new foreign file" warning measures
  // only names that appear AFTER entry. Grammar-MATCHING names are never stored
  // here: a message-shaped <id>-<digits>.json is a protocol file, rejected at
  // the no-flag entry guard or swept under --sweep-exchange-files, never
  // snapshotted (see I0). Rebuilt fresh at each synchronize() entry; deliberately
  // NOT cleared in resetSessionState, whose mid-rendezvous recovery resets would
  // otherwise wipe a snapshot taken before the rendezvous loop.
  private foreignFileSnapshot = new Set<string>();
  // An `error` emitted while no listener is registered is held here so the
  // next protocol-layer receive can detect failures that arrived in the gap
  // between listener-registration cycles. Reading clears the value; only the
  // most recent unhandled error is retained, since a subsequent error would
  // supersede the first as the proximate cause.
  private bufferedError: unknown;

  // The raw, unwrapped transport (this.client is its boundTransport wrap). Held
  // so the abort marker write can be short-bounded directly (see
  // writeAbortMarker / the abortMarker subsystem) instead of inheriting the
  // 1h per-op budget the wrap applies. It is the same underlying transport as
  // this.client, so what protects the marker write from client.end() killing it
  // is the await-before-end() ordering in close(), not this separate reference.
  private rawClient: FileTransportClient;

  // The authenticated cross-party abort-marker subsystem (armed post-handshake,
  // cleared with the handshake identity). It owns the abort state (the two
  // role-derived tokens, the captured write inputs, and the write-vs-seal
  // decision one-shot); the delegating members below (armAbort / writeAbortMarker
  // / sealAbort / abortArmed and the internal close()/poll() seams) forward to
  // it, keeping the connection's public and test surface unchanged. See
  // ./abortMarker and docs/spec/CHANNEL_SECURITY.md ("Authenticated abort marker").
  private readonly abortMarker: AbortMarkerSubsystem;

  // The SFTP session-setup subsystem: builds the connect options, installs the
  // connect path's host-key verifier, and runs the host-key probe. It owns the
  // observedHostKey state the connection exposes through its delegating getter;
  // the probeHostKeyFingerprint member below forwards to it. See ./sftpSession,
  // docs/SECURITY_DESIGN.md (Transport-layer authentication), and
  // docs/spec/CHANNEL_SECURITY.md (SFTP host-key verification).
  private readonly sftpSession: SftpSession;

  // The stateful rendezvous coordinator: owns the entry scan/sweep and the
  // lock-joiner and hello-exchange negotiations, writing this connection's
  // role/peerId/handshakeRole through setter deps and mutating its
  // responsibleFiles/foreignFileSnapshot Sets by shared reference. synchronize()
  // validates entry and delegates to it. See ./fileSyncRendezvous,
  // docs/spec/FILE_SYNC.md, and docs/spec/CHANNEL_SECURITY.md.
  private readonly rendezvous: FileSyncRendezvous;

  // The stateful poll/ack/seq message loop: owns the nine per-session counters
  // and drives poll()/send() over the connection's shared/root state through
  // MessageLoopDeps accessors, emitting only through this connection's overridden
  // emit. The public send/start/stop/setInboundFrameCap/resetSessionState methods
  // and the delegating seq getter/setter forward to it. See ./fileSyncMessageLoop,
  // docs/spec/FILE_SYNC.md, and docs/spec/CHANNEL_SECURITY.md.
  private readonly messageLoop: FileSyncMessageLoop;

  // True once armAbort() has run (derived, not stored): only an armed connection
  // writes or verifies abort markers. Read by the orchestrator's catch gate and
  // by close()/poll().
  get abortArmed(): boolean {
    return this.abortMarker.armed;
  }

  // Bound the next inbound frame the poll loop reads to `maxBytes`, replacing
  // MAX_FRAME_SIZE_BYTES at the read gate until cleared (undefined restores the
  // static cap). Clamped to min(maxBytes, MAX_FRAME_SIZE_BYTES) so a per-exchange
  // cap can only tighten, never widen, the static memory backstop. Implements
  // Connection.setInboundFrameCap; the single-pass receiver sets the derived
  // reply cap before reading the reply and clears it after (see link.ts). It is
  // safe against the poll loop's read-ahead because single-pass sets it after
  // sending its request and before the reply -- one full peer round trip away --
  // so no frame is read between the set and the read it governs; and even a lost
  // race only falls back to the static cap plus the decode-time count/length
  // coherence checks, never to an unbounded read.
  setInboundFrameCap(maxBytes: number | undefined): void {
    this.messageLoop.setInboundFrameCap(maxBytes);
  }

  // The last message this party sent, owned by the message loop; close()'s
  // delete-mode drain reads it through this delegating getter so its teardown
  // sequencing is unchanged.
  private get lastSentFile(): string | undefined {
    return this.messageLoop.lastSentFile;
  }

  // The rendezvous path escaped for operator-facing logs and thrown errors. On an
  // offline-accept-seeded config the path is partner-reachable (the partner's
  // charset-unconstrained invitation endpoint, copied verbatim), so it can carry
  // control/ANSI/Unicode bytes; every display sink routes it through here while
  // the byte-exact this.path is reserved for transport-path construction. The ""
  // fallback covers the post-handshake/close window where close() nulls this.path;
  // a display sink only ever runs with it set, so the fallback never shows.
  private get displayPath(): string {
    return sanitizeForDisplay(this.path ?? "");
  }

  // The directory self-written files go to: the configured outbound directory
  // in split mode, else the inbound `path` (shared mode). undefined only outside
  // an open session (mirrors `path`). Every self-write site (the hello, message,
  // ack, abort-marker, and in-flight temp writes) routes through this so a
  // configured outbound directory takes effect uniformly; peer-file reads stay
  // on `path` (inbound). In shared mode the two coincide, preserving the
  // single-directory behavior exactly.
  private get outboundPath(): string | undefined {
    return this.outbound ?? this.path;
  }

  constructor(client: FileTransportClient, options?: Partial<Options>) {
    super();
    // Retain the raw transport for the short-bounded abort marker write, then
    // wrap it so every data-plane await is backstopped by the peer-inactivity
    // budget (see boundTransport). The wrap reads the budget lazily per call, so
    // wrapping here -- before open() populates this.config -- is safe: no budget
    // is read until a transport call is actually made.
    this.rawClient = client;
    this.client = this.boundTransport(client);
    // No peerId validation here: Options is an internal type, not the public
    // FileSyncOptions. The validation boundary is FileSyncOptionsSchema
    // (enforced by parseFileSyncOptions / applyConnectionOverrides). All
    // production callers go through that path before reaching this constructor.
    this.id = options?.peerId ?? uuidv4();
    this.role = "unknown role";
    this.responsibleFiles = new Set();

    this.options = { ...getDefaultOptions(), ...options } as Options;
    this.log = getLoggerForVerbosity(
      `filesync-${this.id.substring(0, 8)}`,
      this.options.verbose,
    );
    // Inject the transport-budget primitives (owned here, shared with
    // boundTransport and close()'s drain) and the log/role accessors; the
    // subsystem holds the rest of the abort state itself. `role` is read live so
    // a post-construction role assignment is reflected in the marker's log lines.
    this.abortMarker = new AbortMarkerSubsystem({
      log: this.log,
      role: () => this.role,
      runBudgeted: withTransportBudget,
      stalledError: transportBudgetExceededError,
    });
    // `log` and `role` are read live: open() rebinds this.log to a peerId-named
    // logger, and this.role is assigned at rendezvous, both after this point.
    // rawClient is the raw, unwrapped transport the host-key probe dials; it is
    // set above and never reassigned, so it is injected by value.
    this.sftpSession = new SftpSession({
      log: () => this.log,
      role: () => this.role,
      rawClient: this.rawClient,
    });
    // The rendezvous coordinator reads identity/config/client live (all are
    // reassigned or mutated after this point -- id/log/path by open(), role at
    // rendezvous, options fields by open()) and mutates the connection's
    // responsibleFiles/foreignFileSnapshot by shared reference; signal() is read
    // fresh per call so a concurrent close() abort reaches an in-flight
    // rendezvous wait (the controller is swapped per session). Identity is
    // committed in place through the setters at the coordinator's commit sites.
    this.rendezvous = new FileSyncRendezvous({
      responsibleFiles: this.responsibleFiles,
      foreignFileSnapshot: this.foreignFileSnapshot,
      client: () => this.client,
      id: () => this.id,
      role: () => this.role,
      outbound: () => this.outbound,
      log: () => this.log,
      options: () => this.options,
      signal: () => this.abortController.signal,
      wait: (ms) => this.wait(ms),
      peerId: () => this.peerId,
      handshakeRole: () => this.handshakeRole,
      setRole: (role) => {
        this.role = role;
      },
      setPeerId: (peerId) => {
        this.peerId = peerId;
      },
      setHandshakeRole: (role) => {
        this.handshakeRole = role;
      },
      resetSessionState: () => this.resetSessionState(),
      clearAbortMarker: () => this.abortMarker.clear(),
      writeAck: (dir, originalName) => this.writeAck(dir, originalName),
    });
    // The message loop owns the poll/ack/seq counters and reads the connection's
    // shared/root state live. It shares the responsibleFiles/foreignFileSnapshot
    // Sets by reference (never copies); emit() is the SYNCHRONOUS pass-through to
    // this connection's overridden emit, so a poll-loop error still buffers when
    // no listener is registered; writeAck and verifyPeerAbortMarker forward to
    // the connection and the abort-marker subsystem (the latter over the same
    // boundTransport-wrapped this.client the read gate uses).
    this.messageLoop = new FileSyncMessageLoop({
      responsibleFiles: this.responsibleFiles,
      foreignFileSnapshot: this.foreignFileSnapshot,
      client: () => this.client,
      id: () => this.id,
      role: () => this.role,
      log: () => this.log,
      options: () => this.options,
      path: () => this.path,
      outbound: () => this.outbound,
      peerId: () => this.peerId,
      connected: () => this.connected,
      abortArmed: () => this.abortArmed,
      wait: (ms) => this.wait(ms),
      emit: (event, arg) => this.emit(event, arg),
      writeAck: (dir, originalName) => this.writeAck(dir, originalName),
      verifyPeerAbortMarker: (files, path, peerId) =>
        this.abortMarker.verifyPeerMarker(this.client, files, path, peerId),
    });
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
            // The buffered error can be a raw transport error whose message
            // embeds a partner-controlled path (both the SFTP and filedrop
            // adapters concatenate the operation path into their error text), so
            // escape it before it reaches the operator's log.
            sanitizeForDisplay(errMessage(this.bufferedError)),
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

  // Cancellable replacement for `new Promise((r) => setTimeout(r, ms))` at every
  // in-session wait site. Reads this.abortController.signal fresh per call. Do
  // not hoist the signal: the controller is swapped at session start
  // (synchronize()), so a cached `const signal = this.abortController.signal`
  // above a loop would observe a stale controller and become uncancellable.
  private wait(ms: number): Promise<void> {
    return cancellableDelay(ms, this.abortController.signal);
  }

  // The whole-exchange liveness backstop (THE security control for the
  // withheld-callback DoS; see docs/spec/CHANNEL_SECURITY.md). Wraps
  // the transport so every data-plane await is raced against the peer-inactivity
  // budget and cannot hang past it. It is the universal layer beneath the CLI
  // adapter's per-operation READ bounds: those fast-fail a stalled list()/get()/
  // createExclusive() in 60 s, but the always-executed write/stat/delete ops
  // (put/rename/delete/exists) have no per-op bound, so without this a hostile or
  // dead server that withholds the callback on the first put/delete hangs the
  // exchange forever -- in synchronize()/send() the awaited call never settles,
  // and in poll() the reschedule sits in a `finally` the hung await never reaches,
  // so the poller stops silently. Bounding here, at the single consumer seam every
  // transport call already flows through, is op-agnostic (covers ops not
  // enumerated here and any added later) and adapter-agnostic (covers the SFTP
  // adapter, and the filedrop/local-FS LocalFSClient whose post-connect ops are
  // otherwise unbounded).
  //
  // Budget granularity: each await is raced against a FRESH peerTimeoutMs (the
  // peer-inactivity budget), not the remaining time until the rendezvous
  // timeToLive. The budget bounds a single unresponsive await (silence FROM the
  // peer), not total exchange duration: poll() runs unbounded by timeToLive today
  // (it reschedules indefinitely), so racing it against an absolute open()+budget
  // deadline would newly kill a healthy long-running exchange at the budget mark.
  // A fresh per-await budget defeats the hang identically -- the first withheld
  // callback fails after peerTimeoutMs and propagates -- without imposing a
  // duration cap. It is the same single coarse knob the operator already tunes
  // (peerTimeoutMs / DEFAULT_PEER_TIMEOUT_MS), deliberately coarse rather than a
  // tight per-op timeout that would risk false-failing a legitimately large/slow
  // transfer. close()'s ops get the same fresh per-await budget here; its
  // terminal-frame drain is the one site that does NOT use a fresh peerTimeoutMs
  // deadline -- it bounds itself by the short TERMINAL_FRAME_DRAIN_TIMEOUT_MS and
  // races each list() against the time remaining to that drain deadline rather
  // than this (now potentially far larger) per-await budget (see close()).
  //
  // The bound reads the budget lazily per call (config is populated by open()), so
  // the wrap is installed once in the constructor. On a SFTP read the adapter's
  // 60 s bound settles the op first and this race's timer is cleared, so the same
  // hang is never failed twice; this budget is the sole bound only where no per-op
  // bound exists (every write/stat/delete, and all LocalFSClient ops).
  private boundTransport(raw: FileTransportClient): FileTransportClient {
    const budgetMs = (): number =>
      this.config?.options?.peerTimeoutMs ?? DEFAULT_PEER_TIMEOUT_MS;
    const bound = <T>(op: Promise<T>, operation: string): Promise<T> => {
      const ms = budgetMs();
      return withTransportBudget(op, ms, () =>
        transportBudgetExceededError(operation, ms),
      );
    };
    return {
      // connect() runs before open() sets the budget and is already bounded by
      // its own per-attempt deadline (ssh2 readyTimeout; LocalFSClient's
      // withTimeout), so it passes through unwrapped.
      connect: (options) => raw.connect(options),
      end: () => bound(raw.end(), "connection close"),
      list: (path) => bound(raw.list(path), `directory listing of ${path}`),
      get: (path, options) =>
        bound(raw.get(path, options), `file read of ${path}`),
      put: (src, dest, options) =>
        bound(raw.put(src, dest, options), `file write to ${dest}`),
      delete: (path) => bound(raw.delete(path), `delete of ${path}`),
      rename: (fromPath, toPath) =>
        bound(
          raw.rename(fromPath, toPath),
          `rename of ${fromPath} to ${toPath}`,
        ),
      createExclusive: (path) =>
        bound(raw.createExclusive(path), `exclusive create of ${path}`),
      exists: (path) => bound(raw.exists(path), `existence check of ${path}`),
      // safeDelete must never reject (callers use it in catch blocks), so it is
      // bounded by the void variant: a hung cleanup delete stops waiting at the
      // budget and resolves rather than throwing.
      safeDelete: (path) =>
        withTransportBudgetVoid(raw.safeDelete(path), budgetMs()),
      // Forward the optional cycle-boundary signals unwrapped, and only when the
      // transport implements them: releaseForIdle is a local session close (no
      // peer round-trip to bound) and ensureConnected's re-dial carries its own
      // connect-time bounds, so neither belongs under the peer-inactivity budget.
      // A connectionless transport omits them, leaving them undefined here so the
      // poll loop's optional calls no-op.
      releaseForIdle: raw.releaseForIdle?.bind(raw),
      ensureConnected: raw.ensureConnected?.bind(raw),
      // Forward the teardown signal unwrapped (it is a synchronous local latch
      // set, no peer round-trip to bound), and only when the transport implements
      // it, exactly like the two cycle-boundary signals above.
      beginTeardown: raw.beginTeardown?.bind(raw),
    };
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
    if (config.options?.unexpectedFiles !== undefined)
      this.options.unexpectedFiles = config.options.unexpectedFiles;
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
      // Split mode (a separate outbound directory) requires both halves of the
      // pair; the config schema rejects a half-set pair, mixing with `path`, and
      // a split without retain mode, so by here either `path` or the full pair is
      // present. Fold backslashes and strip trailing slashes to the on-disk form
      // (see normalizeFiledropPath); the CLI reconcile compares paths through the
      // same function so its verdict matches what this connection actually opens.
      const split =
        config.inboundPath !== undefined && config.outboundPath !== undefined;
      const inboundDir = normalizeFiledropPath(
        split ? config.inboundPath! : config.path!,
      );
      const outboundDir = split
        ? normalizeFiledropPath(config.outboundPath!)
        : inboundDir;
      // Same distinctness rule the config schema applies (pathsResolveToSameDir),
      // re-checked here so a caller that constructs a connection directly --
      // bypassing the schema -- is still guarded: two paths that resolve to the
      // same directory (e.g. "/x" vs "/x/", "/x//y" vs "/x/y", "/x/./y" vs
      // "/x/y") would silently collapse split mode into a shared directory,
      // defeating the separate-audit-trail purpose. See pathsResolveToSameDir for
      // the textual cases it catches and the residuals (.. , Windows case) it
      // cannot.
      if (split && pathsResolveToSameDir(inboundDir, outboundDir))
        throw new UsageError(
          "filedrop inbound and outbound directories resolve to the same " +
            "directory after normalization; they must be distinct",
        );
      this.log.debug(
        `[${this.role}] opening local path ${sanitizeForDisplay(inboundDir)}` +
          (split
            ? ` (inbound) and ${sanitizeForDisplay(outboundDir)} (outbound)`
            : ""),
      );
      const connectTimeoutMs =
        // ?? covers a config built without an options block at all (the schema
        // default only fires when options is present); LocalFSClient applies the
        // same 30000 ms as its own fallback, so the value is supplied explicitly
        // here rather than relied on downstream.
        config.options?.serverConnectTimeoutMs ??
        DEFAULT_SERVER_CONNECT_TIMEOUT_MS;
      const maxReconnectAttempts =
        config.options?.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
      await this.client.connect({
        path: inboundDir,
        connectTimeoutMs,
        maxReconnectAttempts,
      });
      // In split mode probe the outbound directory too, so an inaccessible
      // write target fails fast at connect (with the access-retry the probe
      // applies) rather than only at the first write. Safe to call connect()
      // twice here: filedrop is always backed by LocalFSClient, whose connect()
      // is a stateless read/write access check, not a persistent session.
      if (split)
        await this.client.connect({
          path: outboundDir,
          connectTimeoutMs,
          maxReconnectAttempts,
        });
      this.path = inboundDir;
      this.outbound = split ? outboundDir : undefined;
    } else {
      // Split mode for SFTP mirrors filedrop: the schema guarantees either
      // `server.path` (shared, possibly unset for login-home) or the full
      // inbound/outbound pair. A single SSH session serves both directories;
      // their existence is validated lazily at the first list/write, the same as
      // `server.path` already is.
      const split =
        config.server.inboundPath !== undefined &&
        config.server.outboundPath !== undefined;
      const stripTrailingSlash = (p: string): string =>
        p.endsWith("/") ? p.slice(0, -1) : p;
      const inboundDir = stripTrailingSlash(
        split ? config.server.inboundPath! : (config.server.path ?? ""),
      );
      const outboundDir = split
        ? stripTrailingSlash(config.server.outboundPath!)
        : inboundDir;
      // Distinctness check for split mode. The stored paths above keep their
      // exact form (only a single trailing slash stripped, unchanged from shared
      // mode); the comparison runs pathsResolveToSameDir on the raw configured
      // paths -- the same rule, on the same inputs, that the config schema
      // applies -- so the schema and the live connection give the same verdict,
      // and textual near-misses ("in" vs "in//", "./in" vs "in", "a/./in" vs
      // "a/in") are caught instead of silently collapsing split mode into one
      // directory. It cannot settle every server-side equivalence -- a relative
      // path and the absolute path it expands to under the (client-side-unknown)
      // login home are indistinguishable, as are ".." segments across a symlink
      // -- so that residual is the operator's responsibility (see
      // docs/EXCHANGE_REFERENCE.md). Re-checked here (not only in the schema) to
      // guard a caller that constructs a connection directly, and BEFORE the
      // connect-option build and connect below, so a same-directory split is
      // refused without ever dialing the server.
      if (
        split &&
        pathsResolveToSameDir(
          config.server.inboundPath!,
          config.server.outboundPath!,
        )
      )
        throw new UsageError(
          "sftp inbound and outbound directories resolve to the same " +
            "directory; they must be distinct",
        );
      this.path = inboundDir;
      this.outbound = split ? outboundDir : undefined;

      const connectOptions = this.sftpSession.buildConnectOptions(config, {
        includeCredentials: true,
      });
      // Install the connect path's host-key verifier onto the options AFTER
      // buildConnectOptions has applied providerOptions, so a providerOptions
      // entry can never win even if the allowlist were loosened. The handle
      // exposes the human-readable failure the verifier captures, which the
      // connect catch below maps to a security-kind ConnectionError.
      const hostKeyVerifier = this.sftpSession.installEnforcingVerifier(
        connectOptions,
        config,
      );

      const portString =
        config.server.port !== undefined ? `:${config.server.port}` : "";
      // The configured SFTP username is a credential component, so log only that
      // one is set, never its value -- consistent with redactUrlCredentials,
      // which strips userinfo from any echoed URL. (The password is never
      // logged.) A debug log reaches the terminal, shell history, and any
      // --log-file, so the value must not ride along.
      const usernameString =
        config.server.username !== undefined ? " as a configured user" : "";
      // Escape the host and remote path before they reach the debug log. Both are
      // partner-reachable: on an offline-accept-seeded config they come from the
      // partner's invitation endpoint, whose host/path are charset-unconstrained
      // and copied verbatim, so they can carry CR/LF or other control/ANSI/Unicode
      // bytes; emitted raw they would enable log-line forging/spoofing on the
      // operator's terminal or --log-file. This routes them through
      // sanitizeForDisplay like every other partner/server-controlled string in
      // this file. The port is a validated integer and the username is logged
      // only as a presence marker, so neither needs escaping.
      this.log.debug(
        `[${this.role}] connecting to ` +
          `${sanitizeForDisplay(config.server.host)}${portString}` +
          `${usernameString}, path: ${this.displayPath}` +
          // Name the outbound directory too in split mode, so a misconfigured
          // outbound path is diagnosable from the connect log rather than only
          // at the first write. Mirrors the filedrop open() log above.
          (split
            ? ` (inbound), outbound: ${sanitizeForDisplay(outboundDir)}`
            : ""),
      );
      try {
        await this.client.connect(connectOptions);
      } catch (err) {
        const mismatchDetails = hostKeyVerifier.mismatchDetails();
        if (mismatchDetails !== undefined) {
          // A host-identity failure -- a pinned-fingerprint mismatch or the
          // no-pin fail-closed refusal (both verifier branches settle through
          // mismatchDetails) -- is a trust-boundary fault, so it carries the
          // security kind consumers classify on; the message and the cause
          // chain are unchanged.
          throw new ConnectionError(
            `SFTP host-key verification failed: ${mismatchDetails}`,
            "security",
            { cause: err },
          );
        }
        throw err;
      }
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

  /**
   * Connect only far enough to observe the server's presented host key, then
   * REFUSE the connection -- the ssh-keyscan analogue used to establish a
   * first-use pin. Delegates to the sftpSession subsystem, which drives the raw
   * transport and returns the presented fingerprint/key-type without ever
   * authenticating; see {@link SftpSession.probeHostKeyFingerprint}. The
   * signature and behavior are unchanged from when this lived inline: the CLI's
   * first-use trust flow (apps/cli/src/hostKeyTrust.ts) calls it directly.
   */
  async probeHostKeyFingerprint(
    config: SFTPConnectionConfig,
  ): Promise<PresentedHostKey> {
    return this.sftpSession.probeHostKeyFingerprint(config);
  }

  async cleanup() {
    // In retain mode, cleanup() removes nothing: in-flight temp-*.tmp writes
    // are cleaned up inline in send()/writeAck() before reaching here,
    // and all protocol files are the durable transcript that must persist.
    if (this.options.retainFiles) {
      this.log.debug(
        `[${this.role}] retain mode: directory is transcript, skipping cleanup`,
      );
      return;
    }
    const responsibleFilesString =
      this.responsibleFiles.size > 0
        ? `: ${[...this.responsibleFiles]
            .map((name) => sanitizeForDisplay(name))
            .join(", ")}`
        : "";
    this.log.debug(
      `[${this.role}] cleaning up ${this.responsibleFiles.size} file(s)` +
        `${responsibleFilesString}`,
    );
    // responsibleFiles holds this party's own writes (hello, lock, joining, ack,
    // message), which are all self-writes and therefore live in the OUTBOUND
    // directory; sweep them there. cleanup() is a no-op in retain mode (the early
    // return above), and a config-derived split connection requires retain, so in
    // practice this only runs in shared mode (outbound === path); routing through
    // outboundPath additionally keeps a direct-set library caller who configured a
    // split outbound without retain mode from orphaning files in the wrong place.
    return Promise.all(
      Array.from(this.responsibleFiles).map((filename) =>
        this.client.safeDelete(`${this.outboundPath}/${filename}`),
      ),
    );
  }

  /**
   * Arms the authenticated cross-party abort marker, called by the orchestrator
   * once post-handshake with the two derived per-direction tokens (self = the
   * token written into `<myId>-abort.json` on a fault; peer = the token a
   * `<peerId>-abort.json` is verified against). Delegates to the abortMarker
   * subsystem, threading this party's id and the current OUTBOUND write directory
   * (the abort marker is a self-write; see the subsystem's arm() capture comment)
   * plus the raw transport the short-bounded write rides. Must be called after
   * open() so a path is available; if it is not, the write degrades to a no-op
   * rather than throwing.
   */
  armAbort(
    selfToken: Uint8Array<ArrayBuffer>,
    peerToken: Uint8Array<ArrayBuffer>,
  ): void {
    this.abortMarker.arm(
      selfToken,
      peerToken,
      this.id,
      this.outboundPath,
      this.rawClient,
    );
  }

  /**
   * Triggered by the orchestrator's catch on a terminal organic fault (directory
   * still writable). Delegates to the abortMarker subsystem, which resolves the
   * abort decision to "write" (pre-empting a later sealAbort) and memoizes the
   * bounded marker write, returning the same promise to every caller -- the
   * parked close() and the catch both await it. Idempotent and best-effort: a
   * faulted write simply leaves no marker, and the peer falls back to the
   * existing peer-silence hedge. Rejection is absorbed by both awaiters (close()
   * must stay non-throwing).
   */
  writeAbortMarker(): Promise<void> {
    return this.abortMarker.writeMarker();
  }

  /**
   * Declares "no marker coming" -- called at the top of the orchestrator's
   * doCleanup on every terminal path. A no-op once a writeAbortMarker() has
   * pre-empted it. This is the single chokepoint that frees a parked close() on
   * the clean-completion, signal, and echo paths so teardown does not block on
   * the backstop grace. Pure synchronous one-shot; safe on an unarmed connection
   * (it just latches the resolution that the skipped close() gate never reads).
   */
  sealAbort(): void {
    this.abortMarker.seal();
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
   * bounded by the short fixed {@link TERMINAL_FRAME_DRAIN_TIMEOUT_MS} (capped
   * at `peerTimeoutMs`), not the full peer-inactivity budget -- the result is
   * already persisted by close() time and cleanup() deletes the frame as a
   * fallback, so a departed peer fast-fails teardown in seconds rather than
   * parking for up to an hour. An unresponsive peer causes the drain to time
   * out and cleanup() to delete the file as a fallback. Idempotent: safe to
   * call repeatedly and on a connection that was never opened.
   */
  async close() {
    // Signal teardown to the transport FIRST, before the abort-marker gate below,
    // so the terminal-frame drain's re-dial (and the marker write's, when close()
    // wins the race with the catch-path write) is exempt from the transport's
    // mid-exchange reconnection cap and is neither counted nor warned. No-op on a
    // transport that does not bound reconnections. The abort-marker write also
    // signals this itself, because a catch-path write can precede this close().
    this.client.beginTeardown?.();
    // Abort-marker decision gate, FIRST -- before stop()/the drain/client.end()
    // and before identity/token fields are cleared. On a connection-originated
    // fault the bridge fire-and-forgets this close() BEFORE the error reaches the
    // orchestrator's catch, so a marker write issued from the catch would race
    // its own teardown. If armed and the decision is still unresolved, wait for
    // whichever of {the decision resolving, the backstop grace} comes first; on
    // "write", await the bounded marker write IN FULL (rejection-safe -- close()
    // must stay non-throwing). The grace bounded only the wait for the decision
    // above, never this write -- the write carries its own per-op budget (see
    // the marker write's own per-op budget). The await MUST precede client.end():
    // the marker write rides the same underlying transport, so an earlier end()
    // would kill an in-flight write -- the write inputs the abort subsystem captured
    // at arm time immunize only
    // against the path/config nulling, not against end(). Gated on abortArmed &&
    // decision-unresolved so the idempotent second/third close() from doCleanup
    // re-enters as a clean no-op. That no-op cannot race the write even though it
    // skips this await: the orchestrator's catch awaits writeAbortMarker() to
    // completion BEFORE its finally runs doCleanup (which seals, then re-closes),
    // so by the time the second close reaches client.end() the write has already
    // settled -- there is no in-flight write left for it to truncate. This delays
    // teardown only in the fault window (process already failing); the
    // clean/echo/signal paths seal the decision in doCleanup before this runs, so
    // they proceed without the grace delay.
    if (this.abortArmed && !this.abortMarker.decisionResolved) {
      const decision = await this.abortMarker.awaitDecisionOrGrace();
      const pendingWrite = this.abortMarker.pendingWrite;
      if (decision === "write" && pendingWrite !== undefined)
        await pendingWrite.catch(() => {
          /* best-effort; teardown proceeds regardless of write outcome */
        });
    }

    this.stop();

    // Cancel any in-flight wait (a rendezvous/send sleep parked between polls)
    // so it rejects promptly instead of resuming against a connection that is
    // tearing down. stop() (above) already cleared pollerActive and the poller
    // timer -- both synchronous -- so by the time an abort-induced rejection
    // reaches poll()'s catch, the !pollerActive guard swallows it. The drain
    // loop below stays on a plain setTimeout (it is the teardown wait itself;
    // see its comment). INVARIANT: every abort() in this class passes a
    // ConnectionClosedError reason -- cancellableDelay rejects with
    // signal.reason, and the plain-Error (exit 69) classification depends on it.
    this.abortController.abort(
      new ConnectionClosedError("connection closed during wait"),
    );

    if (this.path !== undefined) {
      // Connection-per-poll mode released the last cycle's session, so
      // re-establish one BEFORE the drain deadline clock starts below: a re-dial
      // handshake billed to the terminal-frame drain budget could time the drain
      // out and drop the terminal frame to the cleanup fallback, silently
      // regressing the fast-fail abort guarantee, and cleanup()'s sweeps below
      // also need a live session. No-op when a session is already live (the
      // default whole-exchange mode, or the abort-marker write above already
      // re-dialed via the transport's within-cycle recovery) and when the
      // transport does not implement it (filedrop). Best-effort and non-throwing,
      // as close() must be: a failed or refused re-dial leaves the drain to its
      // cleanup fallback and cleanup() to its swallowed delete, exactly as a
      // still-dropped session does. The abort-marker write above was NOT preceded
      // by this call on purpose -- it rides its own within-cycle recovery, so a
      // re-dial here would race that write's re-dial on the one shared session.
      try {
        await this.client.ensureConnected?.();
      } catch {
        /* best-effort; teardown proceeds against whatever session state results */
      }
      // Drain the last sent file before sweeping: a clean close must not
      // delete a terminal frame the peer has not yet consumed. Bounded by the
      // short fixed TERMINAL_FRAME_DRAIN_TIMEOUT_MS (min'd with peerTimeoutMs),
      // NOT the full peer-inactivity budget: at teardown the result is already
      // persisted and cleanup() deletes the frame as a fallback, so a long wait
      // protects nothing and would hang a clean close against a departed peer
      // for up to peerTimeoutMs (default one hour). Drain failure (list() error
      // or timeout) falls through to cleanup(), which deletes as a fallback.
      // In retain mode the last sent file is never deleted, so the drain would
      // spin to its deadline; skip it since cleanup() is a no-op anyway. This
      // is safe, not a lost terminal frame: retain mode never deletes a
      // message, so the final send persists on disk as part of the transcript
      // and the peer's poller reads it whenever it next lists -- durability is
      // decoupled from deletion. The drain exists in delete mode only to stop
      // cleanup() from deleting an unconsumed frame, a race that cannot occur
      // here. Skipping it forgoes only sender-side confirmation that the peer
      // consumed the final message, which matches the durable-ack contract
      // (an ack means "durably received", not "consumed by the application").
      if (this.lastSentFile !== undefined && !this.options.retainFiles) {
        const path = this.path;
        const lastSentFile = this.lastSentFile;
        const peerBudgetMs =
          this.config?.options?.peerTimeoutMs ?? DEFAULT_PEER_TIMEOUT_MS;
        // min() so a configured peer budget smaller than the fixed drain budget
        // still caps teardown below it rather than above it (see
        // TERMINAL_FRAME_DRAIN_TIMEOUT_MS).
        const drainTimeoutMs = Math.min(
          TERMINAL_FRAME_DRAIN_TIMEOUT_MS,
          peerBudgetMs,
        );
        const deadline = Date.now() + drainTimeoutMs;
        // Bound each drain list() by the time remaining to `deadline`, not the
        // per-call transport budget: boundTransport arms a fresh peerTimeoutMs on
        // every list() -- now potentially far LARGER than this short drain
        // deadline -- so a list issued late in the drain could otherwise run a
        // full peer budget PAST `deadline`, blocking teardown well beyond it.
        // Racing it against the remaining window keeps total teardown within the
        // drain deadline (the documented "drain times out" contract). This is
        // teardown-specific and does not contradict the fresh-per-await budget
        // the live exchange uses: the drain has its own short deadline to honor,
        // whereas a healthy long-running poll deliberately has none. A list()
        // that loses this race rejects and the enclosing catch falls through to
        // cleanup(), exactly as a list() error already does.
        const filePresent = async () => {
          const remaining = Math.max(0, deadline - Date.now());
          const files = await withTransportBudget(
            this.client.list(path),
            remaining,
            () =>
              new TransportOperationStalledError(
                `drain of ${lastSentFile} did not complete within the ` +
                  `${remaining} ms teardown window`,
              ),
          );
          return files.some((f) => f.name === lastSentFile);
        };
        try {
          if (await filePresent()) {
            // lastSentFile is NOT routed through sanitizeForDisplay, unlike the
            // partner/server-reachable strings elsewhere in close(). It is this
            // party's own message filename (set only from send()'s outName, never
            // adopted from a listing), whose sole non-numeric input is this.id --
            // a local uuidv4() or the operator's own config peer_id. The partner
            // ingress (the invitation endpoint) is a strict-object schema with no
            // peerId key, so a peer cannot inject one; the name carries no
            // partner-controlled bytes even at default verbosity.
            this.log.info(
              `[${this.role}] close: waiting up to ${drainTimeoutMs} ms for ` +
                `peer to consume ${lastSentFile} before cleanup`,
            );
            this.log.debug(
              `[${this.role}] draining ${lastSentFile} before cleanup`,
            );
            // Tracks the last OBSERVED presence so the deadline-fired log gates
            // on "peer never consumed the file", not on the clock alone. The
            // loop exits on either deadline expiry or filePresent() going false;
            // a clock-only check would mislabel a clean drain whose final
            // filePresent() returned false at/after the deadline as a timeout.
            let stillPresent = true;
            while (Date.now() < deadline) {
              stillPresent = await filePresent();
              if (!stillPresent) break;
              // Deliberately a plain setTimeout, not this.wait(): this drain IS
              // the teardown wait and runs after the session controller is
              // already aborted (above), so wiring it to that signal would make
              // it reject on the first iteration and skip its bounded wait. It
              // is hard-bounded by `Date.now() < deadline` and its catch
              // swallows failures, so a separate controller buys nothing.
              await new Promise((resolve) =>
                setTimeout(resolve, this.options.pollingFrequency),
              );
            }
            if (stillPresent) {
              this.log.info(
                `[${this.role}] close: drain deadline reached after ` +
                  `${drainTimeoutMs} ms; deleting ${lastSentFile} as fallback`,
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
          // cleanup() deletes responsibleFiles (lock/ack names embed the
          // peerId), so a delete error's message can carry partner bytes via the
          // path; escape it.
          `[${this.role}] cleanup during close: ` +
            `${sanitizeForDisplay(errMessage(err))}`,
        );
      }
    }

    if (this.connected) {
      this.log.debug(`[${this.role}] closing connection`);
      // Clear `connected` BEFORE awaiting end(): the budget wrap can make end()
      // reject when a server withholds the session-close callback, and close() is
      // a best-effort teardown that must stay non-throwing and idempotent.
      // Clearing first means a bounded end() rejection neither leaves `connected`
      // stuck true nor lets a second close() re-enter this branch and call end()
      // again on the abandoned client; the rejection is logged like the cleanup()
      // failure above rather than propagated to the caller.
      this.connected = false;
      try {
        await this.client.end();
      } catch (err: unknown) {
        this.log.debug(
          `[${this.role}] end() during close: ${sanitizeForDisplay(errMessage(err))}`,
        );
      }
    }
    this.path = undefined;
    this.outbound = undefined;
    this.config = undefined;
    // Clear the role-derived abort tokens with the handshake identity they
    // derive from. close() does not clear peerId/handshakeRole today, so this is
    // a new line, not an addition to an existing clear. resetSessionState resets
    // only per-session message counters, so the abort fields are cleared here
    // (and at the two rendezvous recovery sites), NOT there.
    this.abortMarker.clear();
    this.resetSessionState();
  }

  /**
   * Negotiates rendezvous with the peer by exchanging `-hello.json` and
   * `<peer1>-<peer2>-lock.json` files (lock mode) or `-hello.json` and
   * zero-length `-ack.json` acknowledgment markers (lockless mode) in the
   * shared directory, assigning `peerId` and `handshakeRole` on success.
   *
   * Failures throw synchronously rather than being emitted on the `error`
   * channel: the `error` event is reserved for asynchronous failures from the
   * poll loop (see {@link start}), which can occur at any time. Callers must
   * await this method and catch its rejection; an attached `on("error", ...)`
   * listener will not observe a synchronize-time failure.
   */
  async synchronize() {
    // Entry preconditions, cancellation re-arm, and the mode guards; returns the
    // per-call path/display scope threaded through the coordinator, which owns
    // the scan/sweep and the lock-joiner and hello-exchange negotiations.
    const scope = this.validateSynchronizeEntry();
    return this.rendezvous.run(scope);
  }

  // Entry preconditions for synchronize(): the connected/re-entry guards, the
  // per-session cancellation re-arm, and the three mode guards, plus the
  // entry-time log line. Returns the path/display scope the phases below thread.
  private validateSynchronizeEntry(): RendezvousScope {
    if (!this.connected || this.path === undefined)
      throw new Error("not connected");

    // Captured once, narrowed by the guard above (this.path is reset to
    // undefined only by close(), which a single-caller synchronize() never races
    // -- see the abortController note below). `inboundPath` is where this party
    // reads the peer's files; `outboundPath` is where it writes its own. They
    // coincide in shared mode; `split` is true only when a separate outbound
    // directory is configured (which requires retain mode).
    const inboundPath = this.path;
    const outboundPath = this.outbound ?? this.path;
    const split = this.outbound !== undefined;
    // Operator-facing directory scope for entry-time logs and errors: both
    // directories in split mode (the entry scan reads inbound and reaches into
    // outbound for the freshness check), or just the inbound path otherwise.
    // Mirrors sweepProtocolFiles' dirsDisplay so a split exchange names both
    // halves consistently wherever a path appears.
    const dirsDisplay = split
      ? `${sanitizeForDisplay(inboundPath)} (inbound) and ` +
        `${sanitizeForDisplay(outboundPath)} (outbound)`
      : this.displayPath;

    if (this.peerId) throw new Error("already synchronized");

    // Re-arm cancellation per session: each genuine rendezvous (including a
    // retry on the same instance after a failed synchronize()) starts with a
    // fresh signal. Placed here, after the re-entry guard, NOT in
    // resetSessionState() -- that helper runs three times INSIDE a live
    // synchronize() (the recovery resets), so re-arming there could wipe a
    // concurrent close()'s abort mid-unwind. A no-op re-entry call throws at the
    // guard above and never reaches this line, so it cannot swap a live
    // session's controller. The teardown-stays-aborted invariant relies on a
    // single, non-concurrent synchronize() caller per instance (the CLI drives
    // exactly one at a time); a concurrent re-sync during a close() window is
    // out of scope and not reachable in production.
    this.abortController = new AbortController();

    // Library-level defense-in-depth, sibling to the two retain guards below: a
    // configured outbound directory requires retain mode (the config schema
    // rejects split-without-retain). A direct library consumer that sets
    // `this.outbound` without retainFiles would otherwise reach a lock/delete
    // path with two directories, where the lock branch's joining sentinel is
    // written to inbound while the hello is written to outbound -- a
    // cross-directory rename that is not atomic. Make that combination
    // unreachable here, where the other mode guards already live, so it never
    // depends on how `outbound` was set. (retain then forces lockless and
    // timestamp via the two guards below, so this one check suffices.)
    if (this.outbound !== undefined && !this.options.retainFiles)
      throw new UsageError(
        "a separate outbound directory requires retain mode: without it the " +
          "rendezvous can take a lock/delete path that renames across the two " +
          "directories, which is not atomic",
      );

    // Library-level defense-in-depth: the schema refine and CLI imply cover the
    // config/CLI entry points, but a direct library consumer that constructs
    // FileSyncConnection with retainFiles: true and locklessRendezvous: false
    // would otherwise reach the delete-based lock path, which is incompatible
    // with retain mode (lock rendezvous is delete-based and cannot produce the
    // whole-directory no-delete transcript). Make that combination unreachable.
    if (this.options.retainFiles && !this.options.locklessRendezvous)
      throw new UsageError(
        "retain mode requires lockless rendezvous: lock rendezvous is " +
          "delete-based and cannot produce the whole-directory no-delete " +
          "transcript required by retain mode",
      );

    // Without timestampInFilename the message filename has no NNN segment, so
    // poll()'s parseTimestampedMessageNNN() returns undefined for every file and the
    // receiver silently skips every incoming message. Enforce at the class
    // boundary so a direct library consumer hits a clear error rather than a
    // stall.
    if (this.options.retainFiles && !this.options.timestampInFilename)
      throw new UsageError(
        "retain mode requires timestamp_in_filename: without it message " +
          "filenames carry no NNN segment and the receiver cannot sequence " +
          "them (every message would be silently skipped)",
      );

    this.log.info(`[${this.role}] synchronizing at path ${dirsDisplay}`);

    return { inboundPath, outboundPath, split, dirsDisplay };
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
  send(data: unknown): Promise<void> {
    return this.messageLoop.send(data);
  }

  // Writes a zero-length acknowledgment marker for the file `<originalName>.json`,
  // named `<myId>-<originalName>-ack.json` (see {@link ackMarkerName}). The same
  // construct is used for the lockless rendezvous ack and the retain-mode
  // message ack; `originalName` is the acknowledged file's name minus `.json`.
  //
  // Published temp-then-rename so the final name never appears before the file
  // is committed; the marker is matched by name existence only and is never read
  // for content, so the body is zero bytes (no serialized empty envelope). The
  // name is a pure function of this party's id and the acknowledged file's fixed
  // name, so a re-write after a reprocess yields the identical name and cannot
  // create a duplicate file (idempotent by construction). Returns the final
  // marker filename (without directory).
  private async writeAck(dir: string, originalName: string): Promise<string> {
    const name = ackMarkerName(this.id, originalName);
    const tempFile = `temp-${uuidv4()}.tmp`;
    const tempPath = `${dir}/${tempFile}`;
    try {
      await this.client.put(Buffer.alloc(0), tempPath, {
        flags: "w",
        encoding: null,
      });
      await this.client.rename(tempPath, `${dir}/${name}`);
    } catch (err) {
      await this.client.safeDelete(tempPath);
      throw err instanceof Error ? err : new Error(errMessage(err));
    }
    return name;
  }

  // Resets all per-session counters and tracking to their initial state. Called
  // by the rendezvous coordinator's recovery resets (to allow retry on the same
  // instance and at the joiner prefix-at-dash error path) and by close() (so a
  // closed instance does not carry stale counters into a hypothetical re-open).
  // The counters live on the message loop, so this forwards to it.
  private resetSessionState() {
    this.messageLoop.resetSessionState();
  }

  start() {
    this.messageLoop.start();
  }

  stop() {
    this.messageLoop.stop();
  }
}
