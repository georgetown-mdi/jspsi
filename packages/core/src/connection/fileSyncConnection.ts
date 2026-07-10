import * as z from "zod";
import { default as EventEmitter } from "eventemitter3";
import { v4 as uuidv4 } from "uuid";

import { getLoggerForVerbosity } from "../utils/logger";
import { pathsResolveToSameDir } from "../utils/pathCompare";
import { sanitizeForDisplay } from "../utils/sanitizeForDisplay";
import {
  parseBoundedJson,
  JsonStructureBoundError,
} from "../utils/boundedJson";
import {
  computeHostKeyFingerprint,
  matchHostKeyFingerprint,
  keyTypeFromBlob,
} from "../utils/sshHostKey";
import { DEFAULT_SERVER_CONNECT_TIMEOUT_MS } from "../config/connection";
import type {
  SFTPConnectionConfig,
  FileDropConnectionConfig,
} from "../config/connection";
import type { HandshakeRole } from "../types";
import {
  UsageError,
  BilateralModeMismatchError,
  ConnectionClosedError,
  FrameSizeExceededError,
  TransportOperationStalledError,
  PeerAbortError,
} from "../errors";
import {
  HelloEnvelopeSchema,
  serializeEnvelope,
  type HelloEnvelope,
} from "./controlEnvelope";
import {
  ADVERTISE_HELLO_RETRY_ATTEMPTS,
  cancellableDelay,
} from "./fileSyncConstants";
import {
  HELLO_SUFFIX,
  LOCK_SUFFIX,
  JOINING_SUFFIX,
  ABORT_SUFFIX,
  parseMessageByteCount,
  parseTimestampedMessageNNN,
  ackMarkerName,
  peerIdFromControlName,
  isProtocolTempName,
  isExpectedAbortName,
  isProtocolGrammarName,
  isRetainMessageAck,
} from "./fileSyncNames";
// Re-export the two grammar recognizers that were part of this module's public
// surface before the grammar was split out to fileSyncNames.ts (which is not
// barrelled by main.ts). This keeps them importable from `fileSyncConnection`
// and in the package barrel exactly as before. isExpectedAbortName is also used
// internally below (imported above); isAbortMarkerName is re-exported only.
export { isAbortMarkerName, isExpectedAbortName } from "./fileSyncNames";
import {
  hostKeyBlob,
  settleVerify,
  SFTP_PROVIDER_OPTIONS_ALLOWLIST,
  SFTP_ALGORITHMS_ALLOWED_SUBKEYS,
} from "./sftpConnect";
import type { PresentedHostKey } from "./sftpConnect";
import { AbortMarkerSubsystem } from "./abortMarker";
// Re-export PresentedHostKey, which was part of this module's public surface
// before the SFTP connect/host-key concern was split out to sftpConnect.ts
// (which main.ts does not barrel). This keeps it importable from
// `fileSyncConnection` and in the package barrel exactly as before; it is also
// used internally below (imported above as a type).
export type { PresentedHostKey } from "./sftpConnect";
import { MAX_FRAME_SIZE_BYTES } from "./frameSize";

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
/**
 * Default number of reconnect attempts after a transient connection failure when
 * the connection options do not set `maxReconnectAttempts`. Exported for the same
 * reason as {@link DEFAULT_POLLING_FREQUENCY_MS}; bounded above by
 * {@link MAX_RECONNECT_ATTEMPTS}.
 */
export const DEFAULT_MAX_RECONNECT_ATTEMPTS = 3;
const DEFAULT_VERBOSITY = 1;
// Bounds the pre-sweep retain-signal inspection's peer-hello read (see
// sweepProtocolFiles). The read goes through the I5a gate, which retries a
// partially-synced body until its deadline; bounding it to a small multiple of
// the polling frequency -- a near-future deadline, never the full peer timeout
// -- keeps a non-resolving hello from stalling the sweep. The gate's do-while
// still guarantees one read, so a stale directory's hello resolves on the first
// attempt; this budget only absorbs sync-tool flush jitter on sync-mediated
// transports. Hellos are tiny (two booleans), so the read is never
// bandwidth-bound. Expressed as poll cycles rather than a raw millisecond
// magic constant so it tracks the configured cadence.
const RETAIN_INSPECTION_POLL_CYCLES = 2;
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

// Reads the hello control file through the I5 partial-sync gate. Retries on a
// transient get() failure or a JSON parse failure (indicating the sync tool has
// not finished writing the file) until timeToLive expires, then throws a
// transport Error. Any typed UsageError from get() is terminal -- today that is
// an over-cap body (FrameSizeExceededError) or a stalled read
// (TransportOperationStalledError), but the catch below is deliberately broad
// rather than enumerated: a UsageError is a non-retryable usage fault by
// definition, so re-reading cannot fix it and retrying would let a hostile
// server hold the gate open until the deadline. A fully-synced body that parses
// but fails the envelope schema (protocol mismatch, not a transient sync gap) is
// terminal for the same reason. Peer-id recovery is always filename-based; this
// function validates the body only.
//
// The hello is the only control file with a body, so the gate now reads only it
// (the schema is HelloEnvelopeSchema at every call site). The acknowledgment
// marker is a zero-length file matched by name existence, so it needs no gate:
// a zero-byte file has no partial-sync window to guard.
async function readControlFileWithGate(
  client: FileTransportClient,
  filePath: string,
  timeToLive: Date,
  pollingFrequency: number,
  schema: z.ZodType<HelloEnvelope>,
  signal: AbortSignal,
): Promise<HelloEnvelope> {
  // do-while guarantees at least one read attempt even when timeToLive has
  // already expired by the time the gate is entered (e.g. a slow polling loop
  // that exhausts the budget before reaching this call). Without this a fully-
  // present file would produce a spurious "timed out" error.
  do {
    let raw: Buffer<ArrayBufferLike>;
    try {
      raw = await client.get(filePath, {
        encoding: "utf-8",
        maxBytes: MAX_FRAME_SIZE_BYTES,
      });
    } catch (err) {
      // A typed UsageError from get() is terminal, not a partial-sync retry: a
      // hostile server could otherwise hold the gate open every cycle until the
      // deadline -- by serving an oversized hello (FrameSizeExceededError) or by
      // withholding the transfer so each read stalls
      // (TransportOperationStalledError). Both re-incur their cost on every pass,
      // so rethrow any UsageError to propagate out of synchronize() as the typed,
      // exit-64 failure rather than being swallowed and retried. (The
      // malformed-payload UsageError thrown below is terminal for the same
      // reason.)
      if (err instanceof UsageError) throw err;
      // File may not be readable yet (TOCTOU or partial sync); retry.
      await cancellableDelay(pollingFrequency, signal);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = parseBoundedJson(raw.toString());
    } catch (err) {
      // A structurally pathological control file is fully formed, not a partial
      // write -- retrying cannot make it valid -- so reject it terminally like
      // the message-body parse, rather than re-reading it every poll cycle to
      // the peer timeout. A genuine partial write fails the parse (never the
      // structural bound) and still retries.
      if (err instanceof JsonStructureBoundError)
        throw new UsageError(
          `control file at ${sanitizeForDisplay(filePath)} has a malformed ` +
            `payload: structure exceeds the permitted bound`,
        );
      // Partial write: body is not valid JSON yet; retry until fully synced.
      await cancellableDelay(pollingFrequency, signal);
      continue;
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      // Only filePath is escaped here; result.error.message is deliberately
      // left raw. The sole schema at every call site is HelloEnvelopeSchema --
      // two `z.boolean()` fields under `.strip()` -- whose zod error reports the
      // expected type and a fixed field path, never a peer-supplied value or key
      // (strip drops extras without naming them), so it carries no partner bytes.
      // This differs from poll()'s message-body parse, which escapes its
      // error text because that body is open peer-controlled JSON.
      throw new UsageError(
        `control file at ${sanitizeForDisplay(filePath)} has a malformed ` +
          `payload: ${result.error.message}`,
      );
    }
    return result.data;
  } while (Date.now() <= timeToLive.getTime());
  throw new Error(
    `timed out waiting for ${sanitizeForDisplay(filePath)} to fully sync`,
  );
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

// The path/display locals a single synchronize() call computes once at entry
// (from this.path/this.outbound, narrowed by the connected guard) and threads
// through its phase methods. Not instance state: each field is derived per
// call, so passing this scope by value keeps the phases from re-deriving it and
// from depending on the order in which the guards ran. `inboundPath` is where
// this party reads the peer's files; `outboundPath` is where it writes its own
// (they coincide in shared mode); `split` is true only with a separate outbound
// directory; `dirsDisplay` is the operator-facing scope naming both halves in
// split mode.
interface RendezvousScope {
  inboundPath: string;
  outboundPath: string;
  split: boolean;
  dirsDisplay: string;
}

// Binary message-frame envelope. Every data-plane message file -- a JSON control
// message (the pre-encryption handshake) and an encrypted binary PSI frame alike
// -- is written as raw bytes `version || type || seq || payload`:
//
//   byte 0      version/format marker (MESSAGE_ENVELOPE_VERSION)
//   byte 1      payload type (MESSAGE_TYPE_OBJECT | MESSAGE_TYPE_BINARY) -- the
//               OUTER, cleartext discriminator the reader keys on, because an
//               encrypted frame's own type tag lives inside the AEAD ciphertext
//               and cannot drive the transport read
//   bytes 2..9  per-session sequence number, 8-byte big-endian
//   bytes 10..  payload: UTF-8 JSON (MESSAGE_TYPE_OBJECT) or raw frame bytes
//               (MESSAGE_TYPE_BINARY)
//
// Carrying the payload as raw bytes -- rather than the former
// `{ ts, seq, type, payload }` JSON with a Uint8Array payload base64url-encoded
// into the `payload` string -- removes the ~4/3 base64 expansion and ends the
// read path's reliance on `Buffer.prototype.toString()` (which throws above
// Node's maximum string length), so a frame larger than that limit can be read.
// The send-time `ts` is no longer carried in the body (it was write-only there;
// a timestamped filename still records it).
/** @internal */
export const MESSAGE_ENVELOPE_VERSION = 1;
/** @internal */
export const MESSAGE_TYPE_OBJECT = 0;
/** @internal */
export const MESSAGE_TYPE_BINARY = 1;
/** @internal */
export const MESSAGE_HEADER_BYTES = 10;

// Human-readable label for a message payload type, used only in log lines (it
// preserves the pre-binary "Object"/"Uint8Array" wording so log-scraping stays
// stable across this format change).
const messageTypeLabel = (type: number): string =>
  type === MESSAGE_TYPE_BINARY ? "Uint8Array" : "Object";

// Writes the MESSAGE_HEADER_BYTES-long envelope header (version || type || seq)
// into the first 10 bytes of `out`. Every byte is assigned, so an allocUnsafe
// target leaks no uninitialized bytes. Shared by the header-only serializer (the
// streamed send path) and the whole-message serializer (test message injection)
// so the byte layout lives in one place.
const writeMessageHeader = (out: Buffer, type: number, seq: number): void => {
  out[0] = MESSAGE_ENVELOPE_VERSION;
  out[1] = type;
  out.writeBigUInt64BE(BigInt(seq), 2);
};

/**
 * Serialize just the {@link MESSAGE_HEADER_BYTES}-byte envelope header
 * (`version || type || seq`), returning a fresh Buffer holding only those bytes.
 * The send path streams this header and the payload as two chunks (see
 * {@link FileSyncConnection.send}) rather than concatenating them into one
 * buffer: prepending the 10-byte header no longer copies the whole payload, so a
 * binary frame holds ~1x its size live rather than ~2x. The on-disk bytes are
 * identical to {@link serializeFileSyncMessage}'s (`header || payload`); the byte
 * count the filename declares is `MESSAGE_HEADER_BYTES + payload.length`.
 *
 * @internal exported for the file-sync transport tests.
 */
export function serializeFileSyncMessageHeader(
  type: number,
  seq: number,
): Buffer {
  const header = Buffer.allocUnsafe(MESSAGE_HEADER_BYTES);
  writeMessageHeader(header, type, seq);
  return header;
}

/**
 * Serialize a data-plane message into its on-disk binary envelope. `payload` is
 * the raw payload bytes (UTF-8 JSON for {@link MESSAGE_TYPE_OBJECT}, the frame
 * itself for {@link MESSAGE_TYPE_BINARY}). The returned Buffer's length is the
 * exact on-disk byte count encoded into the message filename, so the receiver's
 * sync-gate can distinguish a partially-synced file from a complete one.
 *
 * The live send path does NOT use this: it streams a
 * {@link serializeFileSyncMessageHeader} header and the payload as two chunks to
 * avoid the full-payload copy this makes (`out.set`). This whole-buffer form is
 * retained for the transport tests, which inject a complete message file's bytes.
 *
 * @internal exported for the file-sync transport tests.
 */
export function serializeFileSyncMessage(
  type: number,
  seq: number,
  payload: Uint8Array,
): Buffer {
  const out = Buffer.allocUnsafe(MESSAGE_HEADER_BYTES + payload.length);
  writeMessageHeader(out, type, seq);
  out.set(payload, MESSAGE_HEADER_BYTES);
  return out;
}

interface DeserializedMessage {
  type: number;
  seq: number;
  // A view onto the source buffer (no copy): a MESSAGE_TYPE_OBJECT payload is
  // handed to parseBoundedJson, a MESSAGE_TYPE_BINARY payload is delivered as-is,
  // so the frame is never stringified regardless of its size.
  payload: Uint8Array;
}

// Thrown by deserializeFileSyncMessage when byte 0 -- the cleartext envelope
// version marker -- is not this build's MESSAGE_ENVELOPE_VERSION. That byte is
// the one signal that separates a same-version peer's (possibly corrupt) frame
// from a foreign wire format: a JSON-text control message from a peer that
// predates the binary envelope begins with '{' (0x7B), and any future
// envelope-version bump raises the byte, so an unrecognized value most likely
// means the partner is on an incompatible psilink version rather than that a
// same-version frame corrupted. The read path translates this into an
// operator-facing "likely incompatible partner version" hint instead of the raw
// "malformed envelope" text. It cannot be perfectly precise -- a foreign format
// that happens to reuse byte 0 == 1 would still fall through to the generic
// checks -- so the message is a "likely" hint, not a certain diagnosis.
class IncompatibleEnvelopeVersionError extends Error {
  constructor(readonly foundVersion: number) {
    super(`unsupported message envelope version ${foundVersion}`);
    this.name = "IncompatibleEnvelopeVersionError";
  }
}

/**
 * Parse a message file's bytes back into its envelope fields, validating the
 * version marker, the type discriminator, and the minimum length. Throws a plain
 * Error (the caller wraps it as a terminal UsageError) on any structural
 * failure. Deliberately does NOT decode the payload, so a frame larger than
 * Node's maximum string length is never converted to a string here.
 */
function deserializeFileSyncMessage(raw: Uint8Array): DeserializedMessage {
  if (raw.length < MESSAGE_HEADER_BYTES)
    throw new Error("message envelope is shorter than its header");
  if (raw[0] !== MESSAGE_ENVELOPE_VERSION)
    throw new IncompatibleEnvelopeVersionError(raw[0]);
  const type = raw[1];
  if (type !== MESSAGE_TYPE_OBJECT && type !== MESSAGE_TYPE_BINARY)
    throw new Error(`unknown message payload type ${type}`);
  // An honest writer caps seq at the per-session message counter (far below
  // 2^53), so reject anything above MAX_SAFE_INTEGER as malformed before
  // narrowing to a Number -- a Number() conversion above that range loses
  // precision, and comparing as BigInt first mirrors the AEAD decorator's
  // inbound-seq guard (handleInbound) rather than leaning on the downstream
  // retain-mode cross-check to fail-safe on the corrupted value.
  const seqBig = new DataView(
    raw.buffer,
    raw.byteOffset,
    raw.byteLength,
  ).getBigUint64(2, false);
  if (seqBig > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("message envelope sequence number exceeds safe range");
  const seq = Number(seqBig);
  return { type, seq, payload: raw.subarray(MESSAGE_HEADER_BYTES) };
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
}

/**
 * File-based rendezvous and message-passing connection. Implements the
 * `-hello.json`/`-lock.json` handshake (or the lockless ack-handshake barrier) and
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
  // Highest message NNN whose ack marker has already been written. The ack name
  // is a pure function of the consumed message's fixed name, so a reprocess
  // re-derives the identical name and cannot create a duplicate file; this guard
  // only saves the redundant put+rename of an already-named marker (see poll()).
  // -1 means none yet; the first message is NNN 0.
  private lastAckedNNN = -1;
  connected = false;

  // Per-exchange inbound frame cap, replacing MAX_FRAME_SIZE_BYTES at the poll
  // loop's read gate for the reads it spans (see setInboundFrameCap and poll()).
  // undefined restores the static cap. The single-pass receiver sets it to the
  // derived reply cap before reading the reply and clears it after, so the read
  // gate refuses a reply larger than the exchanged record counts imply rather
  // than allocating up to the static ceiling. Stored as min(value,
  // MAX_FRAME_SIZE_BYTES) so a per-exchange cap can only ever TIGHTEN the static
  // backstop, never widen it. Cleared at session reset so a stale tight cap from
  // a prior exchange cannot reject a later one.
  private inboundFrameCap: number | undefined;

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
  // The host key the SFTP server presented on this connection, recorded by the
  // enforcing host-key verifier when its pin check passed (the only success
  // path that reaches a real, authenticated session). Read post-handshake by the
  // orchestrator to advertise this party's observed fingerprint in the
  // authenticated terms exchange for cross-party reconciliation. It
  // stays `undefined` on every path that observes no host key -- a file-drop
  // mount, the browser/proxy SFTP path (neither runs ssh2's hostVerifier), and a
  // refused connection (no-pin fail-closed or a mismatch) that never establishes
  // a session -- so a party with nothing to advertise reconciles to no
  // divergence. Identity/connection-scoped like handshakeRole; not reset per
  // session.
  observedHostKey: PresentedHostKey | undefined;
  private poller: NodeJS.Timeout | undefined;
  private pollerActive: boolean;
  // Cancellation primitive threaded through every wait site (see wait() and
  // cancellableDelay). close() aborts it so an in-flight sleep rejects
  // promptly; synchronize() re-arms a fresh one per session. Constructed inline
  // so a never-opened/never-synchronized instance is safe (close() before any
  // session cannot NPE), and re-armed at session start rather than in
  // resetSessionState() so a recovery reset mid-rendezvous cannot wipe a
  // concurrent close()'s abort (see synchronize()).
  private abortController = new AbortController();
  private responsibleFiles: Set<string>;
  // The name of the last message this party sent. Read by two consumers: the
  // delete-mode drain in close() (waits for the peer to consume this exact file
  // before sweeping), and the retain-mode send gate (constructs the peer's
  // expected ack marker name from this stem and waits for it to exist). Assigned
  // on every successful send regardless of mode; only the reader differs.
  private lastSentFile: string | undefined;
  private consecutiveEnoentCount = 0;
  // Distinct names already warned about under `unexpectedFiles: "warn"`. poll()
  // re-lists every cycle, so a recurring unexpected file would log on each pass
  // without this; membership caps it at one warning per name. Reset per session
  // (resetSessionState) so a name reused across exchanges on the same instance
  // can warn again.
  private warnedUnexpectedFiles = new Set<string>();
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
  // decision one-shot) that this class used to hold inline; the delegating
  // members below (armAbort / writeAbortMarker / sealAbort / abortArmed and the
  // internal close()/poll() seams) forward to it, keeping the connection's
  // public and test surface unchanged. See ./abortMarker and
  // docs/spec/CHANNEL_SECURITY.md ("Authenticated abort marker").
  private readonly abortMarker: AbortMarkerSubsystem;

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
    this.inboundFrameCap =
      maxBytes === undefined
        ? undefined
        : Math.min(maxBytes, MAX_FRAME_SIZE_BYTES);
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
    this.pollerActive = false;
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
      // guard a caller that constructs a connection directly, and BEFORE
      // buildSftpConnectOptions/connect below, so a same-directory split is
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

      const connectOptions = this.buildSftpConnectOptions(config);

      // Host-key verification, installed AFTER providerOptions (which the
      // allowlist already strips of hostVerifier/hostHash) so a providerOptions
      // entry can never win even if the allowlist were loosened. Applies to the
      // CLI sftp channel only -- the browser/proxy SFTP path and filedrop do not
      // run ssh2's hostVerifier.
      //
      // mismatchDetails captures the human-readable failure from inside the async
      // hostVerifier callback so the enclosing catch block can re-throw with the
      // detail rather than ssh2's opaque "Host denied (verification failed)". It
      // is set before verify(false), so it is populated by the time the rejection
      // propagates from this.client.connect().
      let mismatchDetails: string | undefined;
      // One or many pinned fingerprints, normalized to a list. A list stages a
      // rotated host key alongside the current one during a rekey window: a key
      // matching ANY pin is accepted. An empty list (rejected at config parse,
      // but defended here for a direct library caller) falls through to the
      // no-pin fail-closed path below rather than accepting any key.
      const pins =
        config.server.hostKeyFingerprint === undefined
          ? []
          : Array.isArray(config.server.hostKeyFingerprint)
            ? config.server.hostKeyFingerprint
            : [config.server.hostKeyFingerprint];
      if (pins.length > 0) {
        connectOptions["hostVerifier"] = (
          keyBlob: Buffer,
          verify: (permitted: boolean) => void,
        ): void => {
          void (async () => {
            try {
              const blob = hostKeyBlob(keyBlob);
              const matched = await matchHostKeyFingerprint(blob, pins);
              if (matched !== undefined) {
                // Record the observed key for the post-handshake cross-party
                // reconciliation (see observedHostKey). `matched` is the pin the
                // server's key satisfied (already canonical, format-validated),
                // so the presented fingerprint equals it -- reuse it rather than
                // re-hash on every connect. With several pins this is the one the
                // server actually presented, which is what the partner compares.
                // keyTypeFromBlob is server-controlled and stored UNsanitized;
                // the reconciliation escapes it before display.
                this.observedHostKey = {
                  fingerprint: matched,
                  keyType: keyTypeFromBlob(blob),
                };
                settleVerify(verify, true);
              } else {
                // Re-hash on the mismatch branch (which tears the connection down
                // anyway) rather than widen matchHostKeyFingerprint's contract to
                // also surface the digest of a non-matching key.
                const presented = await computeHostKeyFingerprint(blob);
                // keyTypeFromBlob decodes UTF-8 straight from the
                // server-controlled blob, so it is escaped and quoted before it
                // reaches the operator-facing message; the presented fingerprint
                // is base64 and the pins are format-validated, so neither needs
                // it.
                const keyType = sanitizeForDisplay(keyTypeFromBlob(blob));
                // Name the presented fingerprint and the pinned set so the
                // operator can see exactly what was offered against what was
                // trusted (the singular vs. plural wording adapts to the pin
                // count).
                const pinnedDescription =
                  pins.length === 1
                    ? `the pinned fingerprint ${pins[0]}`
                    : `any of the ${pins.length} pinned fingerprints ` +
                      `(${pins.join(", ")})`;
                // A changed key is never auto-accepted (the ssh model): the
                // recovery is to verify out-of-band, then re-pin deliberately --
                // add the new value (keeping or dropping the old), or clear the
                // field and re-establish trust on first use interactively.
                mismatchDetails =
                  `the server presented a host key of type '${keyType}' with ` +
                  `fingerprint ${presented}, which does not match ` +
                  `${pinnedDescription}. This may be a legitimate key rotation ` +
                  `or an active attack -- only the server administrator can ` +
                  `disambiguate. If the key was rotated, verify the new ` +
                  `fingerprint out-of-band, then add it to ` +
                  `connection.server.host_key_fingerprint (alongside or in ` +
                  `place of the old) or remove that field and re-run ` +
                  `interactively to re-establish trust on first use. A changed ` +
                  `key is never auto-accepted.`;
                settleVerify(verify, false);
              }
            } catch (err) {
              mismatchDetails = `failed to verify host key: ` + errMessage(err);
              settleVerify(verify, false);
            }
          })();
        };
      } else {
        // No pin: fail closed (replaces the former warn-and-proceed). The CLI's
        // first-use flow normally pins the key before open(), so this path is the
        // backstop for a direct/library caller and the default posture for an
        // unpinned config. The presented fingerprint is surfaced so a caller can
        // verify it out-of-band and pin it.
        connectOptions["hostVerifier"] = (
          keyBlob: Buffer,
          verify: (permitted: boolean) => void,
        ): void => {
          void (async () => {
            try {
              const blob = hostKeyBlob(keyBlob);
              const presented = await computeHostKeyFingerprint(blob);
              const keyType = sanitizeForDisplay(keyTypeFromBlob(blob));
              mismatchDetails =
                `no host_key_fingerprint is pinned for ` +
                `${sanitizeForDisplay(config.server.host)}, so the server's ` +
                `identity cannot be verified and the connection is refused. The ` +
                `server presented a host key of type '${keyType}' with ` +
                `fingerprint ${presented}; verify it out-of-band and set ` +
                `connection.server.host_key_fingerprint to pin it.`;
              settleVerify(verify, false);
            } catch (err) {
              mismatchDetails =
                `no host_key_fingerprint is pinned and the presented host key ` +
                `could not be read (${errMessage(err)}); refusing to proceed.`;
              settleVerify(verify, false);
            }
          })();
        };
      }

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
        if (mismatchDetails !== undefined) {
          throw Object.assign(
            new Error(`SFTP host-key verification failed: ${mismatchDetails}`),
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
   * Copy the operator's opaque `providerOptions` into `connectOptions`, filtered
   * through {@link SFTP_PROVIDER_OPTIONS_ALLOWLIST}. A non-allowlisted key is
   * dropped with a warning (so an operator who relied on it can see why it had no
   * effect); `algorithms` passes through with its sub-object filtered by
   * {@link filterAlgorithms}. Called before the security-critical fields are
   * assigned, so an allowlisted key that ever collided with one of psilink's own
   * host/credential fields would still lose to the structured value assigned
   * afterward -- defense in depth atop the allowlist, which already excludes
   * every such field (the host-key-verification keys included).
   *
   * Matching is by exact key string and need not be exhaustive about ssh2's
   * spellings, precisely because this is a default-deny allowlist: any key it
   * does not name is dropped regardless of how ssh2 would have read it. That
   * distinction matters -- ssh2 honors more than the canonical names (`hostname`
   * is an alias for `host` and takes precedence over it; `user` is an alias for
   * `username`) and treats keys case-sensitively, so a deny-list would have to
   * enumerate every synonym and casing to be safe, whereas default-deny covers
   * them all by construction. This is also why providerOptions can be left
   * un-normalized.
   */
  private applyProviderOptions(
    connectOptions: Record<string, unknown>,
    providerOptions: Record<string, unknown> | undefined,
  ): void {
    if (providerOptions === undefined) return;
    for (const [key, value] of Object.entries(providerOptions)) {
      if (!SFTP_PROVIDER_OPTIONS_ALLOWLIST.has(key)) {
        this.log.warn(
          `[${this.role}] ignoring connection.providerOptions.` +
            `${sanitizeForDisplay(key)}: not in the allowed set of SFTP ` +
            `transport-tuning options. The connection target, credentials, ` +
            `and host-key verification are set from connection.server and ` +
            `cannot be overridden here; any other key is dropped as a ` +
            `default-deny precaution.`,
        );
        continue;
      }
      if (key === "algorithms") {
        const filtered = this.filterAlgorithms(value);
        if (filtered !== undefined) connectOptions["algorithms"] = filtered;
        continue;
      }
      connectOptions[key] = value;
    }
  }

  /**
   * Filter an operator-supplied ssh2 `algorithms` value to the allowed
   * sub-categories (see {@link SFTP_ALGORITHMS_ALLOWED_SUBKEYS}), dropping
   * `serverHostKey` and any unrecognized sub-key with a warning. Returns the
   * filtered object, or `undefined` when the value is not a plain object or
   * nothing survives the filter -- so the `algorithms` key is omitted entirely
   * rather than forwarded as an empty object.
   */
  private filterAlgorithms(
    value: unknown,
  ): Record<string, unknown> | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      this.log.warn(
        `[${this.role}] ignoring connection.providerOptions.algorithms: ` +
          `expected an object of algorithm categories`,
      );
      return undefined;
    }
    const filtered: Record<string, unknown> = {};
    for (const [subKey, subValue] of Object.entries(value)) {
      if (SFTP_ALGORITHMS_ALLOWED_SUBKEYS.has(subKey)) {
        filtered[subKey] = subValue;
      } else {
        this.log.warn(
          `[${this.role}] ignoring connection.providerOptions.algorithms.` +
            `${sanitizeForDisplay(subKey)}: only ` +
            `${[...SFTP_ALGORITHMS_ALLOWED_SUBKEYS].join("/")} may be tuned ` +
            `here (host-key-type negotiation is not operator-overridable)`,
        );
      }
    }
    return Object.keys(filtered).length > 0 ? filtered : undefined;
  }

  /**
   * Build the ssh2-sftp-client connect options for an sftp config, EXCEPT the
   * `hostVerifier` (the caller installs the verifier appropriate to its path:
   * enforce, fail-closed, or capture). The operator's opaque providerOptions are
   * applied FIRST through the default-deny allowlist, then psilink's own
   * security-critical fields -- host, credentials, the managed readyTimeout --
   * are assigned AFTER and always win, so a providerOptions entry can never
   * override them even if the allowlist were loosened. Shared by {@link open}
   * and {@link probeHostKeyFingerprint} so the probe negotiates with the exact
   * same options (and therefore the same host-key type) the real connect uses.
   */
  private buildSftpConnectOptions(
    config: SFTPConnectionConfig,
  ): Record<string, unknown> {
    const connectOptions: Record<string, unknown> = {};
    this.applyProviderOptions(connectOptions, config.providerOptions);

    connectOptions["host"] = config.server.host;
    connectOptions["maxReconnectAttempts"] =
      config.options?.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
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
    // Offer the keyboard-interactive auth method alongside `password` for a
    // server that disables the direct `password` method but accepts the same
    // password over keyboard-interactive (ssh2 tries password first, then
    // keyboard-interactive, exactly as a GUI SFTP client does). The transport
    // adapter reads this flag to install a handler that answers the server's
    // prompts with `password`; gated on a password being present so the handler
    // always has a value to answer with (the schema also refines this). Nothing
    // is installed unless the operator opted in, so default behavior is
    // unchanged. See SSH2SFTPClientAdapter.connect and docs/EXCHANGE_REFERENCE.md.
    if (
      config.server.keyboardInteractive === true &&
      config.server.password !== undefined
    )
      connectOptions["tryKeyboard"] = true;
    // serverConnectTimeoutMs for SFTP is enforced by ssh2 via readyTimeout, not a
    // Promise.race wrapper -- the per-attempt deadline is equivalent. Always set:
    // the schema defaults the field to DEFAULT_SERVER_CONNECT_TIMEOUT_MS, and the
    // ?? fallback covers a config built without an options block at all, so an
    // unset value gets the documented 30000 ms deadline rather than dropping to
    // ssh2's shorter (~20s) internal default.
    connectOptions["readyTimeout"] =
      config.options?.serverConnectTimeoutMs ??
      DEFAULT_SERVER_CONNECT_TIMEOUT_MS;
    return connectOptions;
  }

  /**
   * Connect only far enough to observe the server's presented host key, then
   * REFUSE the connection -- the ssh-keyscan analogue used to establish a
   * first-use pin. The installed hostVerifier records the presented
   * fingerprint/key-type and immediately calls `verify(false)`, so the handshake
   * aborts at host-key verification, BEFORE any credential is presented to the
   * (still-unverified) server, and without ever waiting on a user prompt inside
   * the handshake (which would race ssh2's `readyTimeout`). The caller then
   * decides whether to trust and pin the returned fingerprint out of band; the
   * subsequent real {@link open} re-verifies it, so a key swapped between this
   * probe and that connect is still caught.
   *
   * Uses the raw (unbounded) transport: the verifier rejects as soon as the key
   * is presented, so there is no withheld-callback window for the peer-inactivity
   * budget to guard, and the connect is already bounded by ssh2's readyTimeout.
   *
   * @throws if the connect resolves without the verifier firing (no key was
   *   observed), or rejects for a reason other than the deliberate refusal.
   */
  async probeHostKeyFingerprint(
    config: SFTPConnectionConfig,
  ): Promise<PresentedHostKey> {
    const connectOptions = this.buildSftpConnectOptions(config);
    let captured: PresentedHostKey | undefined;
    let captureError: unknown;
    let connectError: unknown;
    connectOptions["hostVerifier"] = (
      keyBlob: Buffer,
      verify: (permitted: boolean) => void,
    ): void => {
      void (async () => {
        try {
          const blob = hostKeyBlob(keyBlob);
          captured = {
            fingerprint: await computeHostKeyFingerprint(blob),
            keyType: keyTypeFromBlob(blob),
          };
        } catch (err) {
          captureError = err;
        }
        // Always refuse: this connection exists only to read the host key, never
        // to authenticate. The refusal surfaces as the expected connect rejection
        // below, from which `captured` is returned. settleVerify guards a late
        // refusal: if the handshake was already torn down (e.g. readyTimeout)
        // while computeHostKeyFingerprint was awaiting, verify(false) would throw
        // against the dead protocol and reject this void-ed IIFE.
        settleVerify(verify, false);
      })();
    };

    try {
      await this.rawClient.connect(connectOptions);
    } catch (err) {
      // A rejection is expected when the verifier fired: verify(false) aborts the
      // handshake, from which the captured key is returned below. Record the
      // cause ONLY when no key was read -- a genuine connect failure (e.g. an
      // unreachable host) -- so it is surfaced rather than masked behind the
      // generic "presented no key" message.
      if (captured === undefined) connectError = err;
    } finally {
      // verify(false) already tears the handshake down, but end() is the explicit
      // teardown; run it on every path (the success return included) so the probe
      // never leaves a client open.
      await this.rawClient.end().catch(() => {});
    }

    if (captured !== undefined) return captured;
    if (captureError !== undefined)
      throw new Error(
        `failed to read the server's host key: ${errMessage(captureError)}`,
      );
    // The connect rejected before the verifier ever fired -- the host key was
    // never presented. Preserve the original cause so the operator can tell an
    // unreachable host from any other SSH failure.
    if (connectError !== undefined)
      throw new Error(
        `could not read the server's host key: ${errMessage(connectError)}`,
        { cause: connectError },
      );
    // The connect resolved without the verifier firing: a completed connection
    // that presented no host key (not expected for SSH).
    throw new Error(
      `could not determine the server's host key: the connection did not ` +
        `present one before completing`,
    );
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
    // would kill an in-flight write -- the captured abortWriteInputs immunize only
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

  // Builds this party's hello payload: the two bilateral mode flags it
  // advertises so the peer can detect a mismatch and fail fast. Written into the
  // hello body in both rendezvous branches. The hello is the only control file
  // with a body; the lockless ack is a zero-length marker that carries no flags.
  private helloEnvelope(): HelloEnvelope {
    return {
      locklessRendezvous: this.options.locklessRendezvous,
      retainFiles: this.options.retainFiles,
    };
  }

  // Compares a peer's advertised hello flags against this party's own
  // configuration. Returns a BilateralModeMismatchError naming both sides'
  // settings for the offending flag, or undefined when both flags match.
  // Called at every site that reads a peer hello.
  //
  // retain_files is compared first because it is the implying flag: the only
  // way both flags differ is retain=true/lockless=true vs
  // retain=false/lockless=false (retain_files implies lockless_rendezvous), and
  // naming the retain_files mismatch lets the operator realign both with a
  // single rerun rather than risk the invalid retain=true/lockless=false state.
  // A lockless-only divergence (retain matches) still reports lockless.
  private bilateralMismatch(
    peer: HelloEnvelope,
  ): BilateralModeMismatchError | undefined {
    if (peer.retainFiles !== this.options.retainFiles)
      return new BilateralModeMismatchError(
        `retain_files mismatch: this party has retain_files=` +
          `${this.options.retainFiles} but the peer has retain_files=` +
          `${peer.retainFiles}; both parties must use the same setting`,
      );
    if (peer.locklessRendezvous !== this.options.locklessRendezvous)
      return new BilateralModeMismatchError(
        `lockless_rendezvous mismatch: this party has lockless_rendezvous=` +
          `${this.options.locklessRendezvous} but the peer has ` +
          `lockless_rendezvous=${peer.locklessRendezvous}; both parties must ` +
          `use the same setting`,
      );
    return undefined;
  }

  // Pre-sweep retain-signal inspection followed by the protocol-file sweep for
  // --sweep-exchange-files. Deletes every protocol-grammar file (this party's
  // and the peer's: hellos, locks, joining sentinels, acks, messages) so
  // rendezvous can start against a clean slate -- but only after confirming the
  // directory is not a retain-mode audit transcript. Retain never deletes its
  // hellos (I4b), so a retain directory in which a PEER participated always
  // carries that peer's retain hello (signal b below). The one gap is a
  // peer-less, self-started retain half-start re-run in delete mode: the body
  // read covers only PEER hellos, so it is caught only by local retain mode
  // (signal: this.options.retainFiles) -- which a delete-mode re-run does not
  // set. That loses only this operator's own abandoned half-start, not a
  // two-party transcript. The inspection checks signals with DIFFERENT coverage:
  //   (a) a retain-only message ack (isRetainMessageAck) -- a filename-only,
  //       body-free signal. Strictly additive: it does not cover an
  //       early-rendezvous retain peer that has written no message ack yet.
  //   (b) the peer hello's `retain_files` flag, read through the I5a gate. This
  //       is the load-bearing signal -- a retain directory always carries its
  //       hello, even mid-rendezvous before any message ack exists. The read is
  //       bounded (RETAIN_INSPECTION_POLL_CYCLES, never peer_timeout_ms) so a
  //       non-resolving body cannot stall the sweep; an unresolved or
  //       unparseable body is retain-uncertain and refuses the bare flag.
  // Local retain mode is a signal too. When any signal is present the bare flag
  // refuses (exit 64); --force-retain-sweep then permits the wipe after a loud
  // warning. The sweep uses client.delete (rejects), NOT safeDelete (swallows),
  // so a delete failure on a transport that cannot delete surfaces as a
  // transport error (exit 69) rather than a silent "clean slate".
  //
  // Best-effort and non-atomic: between this scan and the deletes a live peer
  // could write a file this never saw. Acceptable only because the operator
  // asserted no concurrent session by passing the flag.
  private async sweepProtocolFiles(
    inboundPath: string,
    peerHellos: Array<FileInfo>,
    unexpectedProtocol: Array<{ file: FileInfo; dir: string }>,
  ): Promise<void> {
    // The directory scope this sweep touches, for operator-facing messages: in
    // split mode the sweep deletes from BOTH directories (peer leftovers in
    // inbound, this party's own leftovers in outbound), so name both; in shared
    // mode it collapses to displayPath.
    const dirsDisplay =
      this.outbound === undefined
        ? this.displayPath
        : `${sanitizeForDisplay(inboundPath)} (inbound) and ` +
          `${sanitizeForDisplay(this.outbound)} (outbound)`;

    const signals: string[] = [];
    let retainUncertain = false;

    if (this.options.retainFiles) signals.push("this party is in retain mode");

    // A retain message ack matches the protocol grammar (-ack.json) and is not a
    // peer hello, so it is already in unexpectedProtocol -- scan that set rather
    // than the raw entry listing, keeping the retain inspection in step with the
    // ignored-filtered classification (no orphaned temp or other ignored name
    // can reach it). In split mode this also catches a retain transcript leftover
    // in THIS party's outbound directory (its own consumed-message acks), since
    // outbound leftovers are folded into the same set.
    const messageAck = unexpectedProtocol.find((e) =>
      isRetainMessageAck(e.file.name),
    );
    if (messageAck)
      signals.push(
        `a retain-mode message ack (${sanitizeForDisplay(messageAck.file.name)})`,
      );

    // Read peer hello bodies only when no cheaper signal has decided it already:
    // the hello read is the load-bearing check but the only one that costs a
    // network round trip.
    if (signals.length === 0) {
      // One deadline shared across all peer hellos: it bounds the total
      // inspection even in the all-readable case. A readable hello returns as
      // soon as its body resolves (the gate retries only on failure), so a
      // delete-mode directory's hellos read quickly. The FIRST hello that cannot
      // be read sets retainUncertain and breaks out (below): uncertainty is
      // sticky and already forces the refuse-or-force decision, so reading the
      // rest cannot change the outcome -- and breaking caps the work a pile of
      // unreadable hellos (e.g. a hostile directory under --sweep-exchange-files)
      // can impose, instead of one bounded read apiece.
      const inspectionDeadline = new Date(
        Date.now() +
          RETAIN_INSPECTION_POLL_CYCLES * this.options.pollingFrequency,
      );
      for (const hello of peerHellos) {
        try {
          const envelope = await readControlFileWithGate(
            this.client,
            `${inboundPath}/${hello.name}`,
            inspectionDeadline,
            this.options.pollingFrequency,
            HelloEnvelopeSchema,
            this.abortController.signal,
          );
          if (envelope.retainFiles) {
            signals.push(
              `peer hello ${sanitizeForDisplay(hello.name)} advertises ` +
                `retain_files=true`,
            );
            break;
          }
        } catch (err) {
          // A fully-synced hello that fails the schema (or an over-cap body) is a
          // terminal UsageError (I5b) -- let it propagate. A close() during
          // inspection aborts the gate read with the
          // ConnectionClosedError reason (close()'s abort() invariant); propagate
          // that as a clean shutdown (exit 69) rather than masking it as a
          // retain-uncertain UsageError. Any other failure is an unresolved read
          // within the bounded budget: treat it as retain-uncertain. This is
          // sticky -- a later hello reading retain_files=false does NOT clear it,
          // because the unreadable hello could itself be an unsynced retain
          // hello, and wiping it without --force-retain-sweep is exactly the data
          // loss the guard prevents. Refuse rather than risk it.
          if (err instanceof UsageError) throw err;
          if (this.abortController.signal.aborted) throw err;
          // Stop at the first unreadable hello: uncertainty is sticky and
          // already forces refuse (bare flag) or the danger warning (force), so
          // further reads cannot change the outcome and only add latency.
          retainUncertain = true;
          break;
        }
      }
    }

    const retainInPlay = signals.length > 0 || retainUncertain;

    if (retainInPlay && !this.options.forceRetainSweep) {
      // Prefer a concrete signal in the diagnostic: retainUncertain can coexist
      // with a definitive one (an earlier hello read failed, a later resolved to
      // retain_files=true), and the concrete cause is the more useful report.
      const reason =
        signals.length > 0
          ? signals.join("; ")
          : "a peer hello body that did not resolve within the inspection " +
            "budget (retain-uncertain)";
      throw new UsageError(
        `path ${dirsDisplay} shows a retain-mode signal ` +
          `(${reason}), so ` +
          "--sweep-exchange-files refuses to delete what may be a durable audit " +
          "transcript. Re-run with --force-retain-sweep to wipe the prior " +
          "transcript and start a fresh exchange, after confirming no concurrent " +
          "session is using this path.",
      );
    }

    // Dir-qualified so each file is deleted from the directory it was listed in
    // (peer hellos are inbound; unexpectedProtocol carries its own dir, which is
    // the outbound directory for a split-mode self leftover).
    const toDelete: Array<{ name: string; dir: string }> = [
      ...peerHellos.map((file) => ({ name: file.name, dir: inboundPath })),
      ...unexpectedProtocol.map((e) => ({ name: e.file.name, dir: e.dir })),
    ];

    // Nothing to delete (e.g. local retain mode is the only signal and the
    // directory holds no peer protocol files): return before the warning so it
    // never claims to be deleting zero files.
    if (toDelete.length === 0) return;

    // Entry-time logs use this.id, not this.role: the sweep runs before
    // rendezvous, so this.role is still the "unknown role" sentinel. For the
    // destructive-wipe warning especially, the party id is the useful identifier.
    if (retainInPlay && this.options.forceRetainSweep)
      this.log.warn(
        `[${this.id}] --force-retain-sweep: permanently deleting a ` +
          `retain-mode audit transcript (${toDelete.length} protocol file(s)) ` +
          `in ${dirsDisplay}. This is destructive and ` +
          `irreversible; the prior ` +
          "transcript will be lost. Only use --force-retain-sweep when you " +
          "intend to discard it.",
      );

    // A close() may have raced the inspection; do not dispatch deletes against a
    // tearing-down client. Propagate the abort reason (ConnectionClosedError) so
    // it classifies as a clean shutdown (exit 69), not a delete transport error.
    if (this.abortController.signal.aborted)
      throw this.abortController.signal.reason;

    this.log.info(
      `[${this.id}] sweeping ${toDelete.length} protocol file(s) at ` +
        `${dirsDisplay} (--sweep-exchange-files): ` +
        `${toDelete.map((f) => sanitizeForDisplay(f.name)).join(", ")}`,
    );
    // allSettled, not all: await every delete before reporting, so a single
    // rejection does not leave the others running unobserved while synchronize()
    // unwinds. The directory then reaches a known (fully-attempted) state and the
    // error names all failures. A delete failure is a transport error (exit 69),
    // never a UsageError. The non-atomicity caveat above still holds: a live peer
    // could write between the listing and these deletes.
    const results = await Promise.allSettled(
      toDelete.map((entry) => this.client.delete(`${entry.dir}/${entry.name}`)),
    );
    const failures = results.flatMap((result, i) =>
      result.status === "rejected"
        ? // The delete error's message re-embeds the same partner-controlled
          // filename via the operation path, so escape it too -- otherwise it
          // re-introduces the bytes the name sanitize on this line removed.
          [
            `${sanitizeForDisplay(toDelete[i].name)} ` +
              `(${sanitizeForDisplay(errMessage(result.reason))})`,
          ]
        : [],
    );
    if (failures.length > 0)
      throw new Error(
        `--sweep-exchange-files failed to delete ${failures.length} of ` +
          `${toDelete.length} protocol file(s) at ${dirsDisplay}: ` +
          `${failures.join("; ")}. The directory may be partially swept; ` +
          "resolve the transport error and re-run.",
      );
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
    // per-call path/display scope threaded through the phases below.
    const scope = this.validateSynchronizeEntry();

    // Scan and classify the entry directory (sweep orphaned temps and leftover
    // abort markers, snapshot foreign files, then sweep-or-reject unexpected
    // protocol files). Yields the at-most-one tolerated peer hello.
    const peerHellos = await this.scanEntryDirectory(scope);

    // This party's own hello is a self-write, so it goes to the outbound
    // directory; the peer reads it from its inbound (which is this outbound). In
    // shared mode outboundPath === inboundPath. The lock-mode branches that also
    // reference helloPath only run in shared mode (split requires retain, which
    // requires lockless), so routing it through outbound is correct there too.
    const helloPath = `${scope.outboundPath}/${this.id}${HELLO_SUFFIX}`;

    if (peerHellos.length === 1 && !this.options.locklessRendezvous) {
      await this.rendezvousAsLockJoiner(peerHellos[0], helloPath);
    } else {
      await this.rendezvousViaHelloExchange(scope, helloPath);
    }
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

  // Scans and classifies the entry directory before rendezvous: sweeps orphaned
  // in-flight temp writes and leftover abort markers, snapshots foreign files,
  // and either sweeps every protocol file (--sweep-exchange-files) or rejects
  // any unexpected protocol file. Returns the at-most-one tolerated peer hello.
  private async scanEntryDirectory(
    scope: RendezvousScope,
  ): Promise<Array<FileInfo>> {
    const { inboundPath, outboundPath, split, dirsDisplay } = scope;

    // Reset the foreign-file snapshot up front so it is rebuilt fresh on every
    // synchronize() entry even when the list() below throws: a failed entry must
    // not leave a prior session's snapshot behind for a same-instance retry.
    this.foreignFileSnapshot.clear();

    let files: Array<FileInfo>;
    try {
      files = await this.client.list(inboundPath);
    } catch (err: unknown) {
      throw err instanceof Error ? err : new Error(errMessage(err));
    }
    const fileNames = files.map((file) => file.name);
    this.log.trace(
      `[${this.role}] found ${files.length} file(s)` +
        `${
          files.length > 0
            ? `: ${fileNames.map((n) => sanitizeForDisplay(n)).join(", ")}`
            : ""
        }`,
    );
    if (!this.options.retainFiles)
      this.responsibleFiles.forEach((fileName) => {
        if (!fileNames.includes(fileName))
          this.responsibleFiles.delete(fileName);
      });
    // Unified entry precondition (mode-agnostic, both delete and retain). At
    // synchronize() entry the only PROTOCOL file that may legitimately predate
    // this party's entry is at most one peer hello -- a hello whose id is not
    // this party's own: a party writes its own hello/lock/ack only after
    // observing the peer's hello, and messages and ack markers exist only once
    // rendezvous has completed.
    //
    // Any other protocol file is an error: a second peer hello, a self-hello (a
    // same-id leftover from a crashed session), a lock, an ack marker, a joining
    // sentinel, or a stale message. The directory is the state machine, so by
    // default this stays strict-empty for protocol files, with two relaxations
    // in the foreign and sweep branches below:
    //   - FOREIGN files (names that FAIL the protocol grammar -- conflict copies,
    //     partial downloads, unrelated files) are snapshotted and tolerated in
    //     both modes, deleting nothing. A message-shaped <id>-<digits>.json is
    //     NOT foreign (it matches the grammar) and stays a protocol file.
    //   - --sweep-exchange-files clears the protocol files (this party's and the
    //     peer's) and proceeds against a clean slate, after a retain-signal
    //     inspection that refuses to destroy an audit transcript without the
    //     --force-retain-sweep guard.
    //
    // The one kind that legitimately pre-exists and is NOT rejected is an
    // orphaned temp-*.tmp -- a send()/writeAck() in-flight write whose process
    // was hard-killed between the temp put() and the rename to <id>.json. At
    // entry the message loop has not started, so any such file is necessarily
    // orphaned (no live in-flight write can race it); it is swept just below
    // (safeDelete then added to `ignored`) so a prior crash's temp artifact is
    // cleaned up rather than left as litter and entry is not aborted on its
    // account. `ignored` is the sanctioned extension point for kinds that may
    // legitimately pre-exist as the protocol grows; the foreign-file snapshot
    // below is a sibling tolerance mechanism for grammar-failing names.
    // A peer hello is `<peerId>-hello.json` with a non-empty id that is not our
    // own (isPeerHelloName). A bare `-hello.json` slices to an empty id and is
    // therefore NOT a peer hello: it still matches the grammar
    // (isProtocolGrammarName), so it falls into unexpectedProtocol below, is
    // rejected at the no-flag guard, and is swept under --sweep-exchange-files,
    // rather than being tolerated as a phantom peer. The in-flight rendezvous
    // scans share the same predicate so a mid-flight injection is rejected too.
    const ignored = new Set<string>();

    // Sweep orphaned in-flight temp writes left by a prior crashed exchange.
    // Match ONLY the protocol's own temp shape, temp-<uuidv4()>.tmp
    // (isProtocolTempName), which send()/writeAck() produce -- never a final
    // <id>.json message (in retain mode the directory is intentionally full of
    // *.json (the transcript), which can never match `.tmp`), and never a
    // FOREIGN temp-*.tmp whose stem is not a v4 UUID (a user/sync-tool
    // `temp-export.tmp`), which falls through to the foreign-file snapshot below
    // and is tolerated rather than destroyed in a namespace collision. Delete
    // each with the non-throwing safeDelete, then add its name to `ignored` so
    // the already-taken `files` snapshot does not re-trip the guard below on a
    // name we just removed.
    //
    // The delete is best-effort and the `ignored` add is unconditional (it does
    // not branch on the delete's outcome): a safeDelete that silently fails (a
    // transport error, swallowed by contract) leaves the temp on disk, but entry
    // must still proceed past it (a stale temp is benign) and the next exchange's
    // entry re-runs this same sweep, so the litter is self-healing rather than
    // permanent. Tracking the orphan in `responsibleFiles` would not help: its
    // writer already died, so that process's cleanup() never runs -- which is the
    // whole reason this rendezvous-time sweep exists.
    const orphanedTempFiles = files.filter((file) =>
      isProtocolTempName(file.name),
    );
    if (orphanedTempFiles.length > 0) {
      // Single breadcrumb: a process died mid-write here. Entry is not aborted
      // on its account, but the prior crash is worth surfacing.
      this.log.info(
        `[${this.id}] sweeping ${orphanedTempFiles.length} orphaned temp ` +
          "file(s) left by a prior crashed exchange: " +
          `${orphanedTempFiles
            .map((f) => sanitizeForDisplay(f.name))
            .join(", ")}`,
      );
      await Promise.all(
        orphanedTempFiles.map((file) =>
          this.client.safeDelete(`${inboundPath}/${file.name}`),
        ),
      );
      orphanedTempFiles.forEach((file) => ignored.add(file.name));
    }

    // All three classifications exclude `ignored`, kept symmetric with the two
    // filters below so a future `ignored` entry that could pass isPeerHelloName
    // is not silently reclassified.
    let peerHellos = files.filter(
      (file) => !ignored.has(file.name) && this.isPeerHelloName(file.name),
    );

    // Recognize-and-sweep leftover authenticated abort markers, mirroring the
    // orphaned-temp sweep above (safeDelete + add to `ignored` so the name never
    // reaches the directory-clean check). Every authenticated terminal failure
    // leaves a `<writerId>-abort.json` -- it must persist for the peer to read --
    // so a subsequent exchange reusing the directory would otherwise find it and
    // reject "directory not clean", turning a transient failure into a blocked
    // directory. Exact-name only: this party's own id, plus any peer id evidenced
    // by a peer hello present at entry (the sole notion of peer identity here --
    // peerId is committed later, in the rendezvous below). A foreign
    // `<other>-abort.json` with no matching hello is therefore NOT swept -- it
    // stays an ordinary unexpected protocol file under the normal policy.
    //
    // Delete mode only. In retain mode the directory is a durable audit
    // transcript, so auto-sweeping a marker beside it would reintroduce the
    // destruction the retain guard prevents; a retain-mode leftover instead falls
    // through to the unexpectedProtocol guard (exit-64 refusal on the no-flag
    // path) and to sweepProtocolFiles' existing --force-retain-sweep gate under
    // --sweep-exchange-files. Reusing that gate rather than a parallel retain
    // check keeps the two from drifting.
    //
    // Best-effort, exactly like the orphaned-temp sweep: safeDelete swallows a
    // transport-level delete failure and the `ignored` add is unconditional, so a
    // marker that fails to delete is left on disk and entry proceeds past it
    // rather than aborting on a transient hiccup. A persisted leftover is benign
    // and self-healing -- the next exchange's entry re-runs this sweep -- and it
    // cannot forge a PeerAbortError in a later session: verifyPeerAbortMarker
    // authenticates the marker's token against that session's HKDF-derived peer
    // token, which a stale marker from a prior session's key cannot satisfy.
    if (!this.options.retainFiles) {
      const expectedAbortIds = new Set<string>([this.id]);
      for (const hello of peerHellos) {
        const pid = peerIdFromControlName(hello.name, HELLO_SUFFIX);
        if (pid !== undefined) expectedAbortIds.add(pid);
      }
      const leftoverAbortFiles = files.filter((file) => {
        if (ignored.has(file.name)) return false;
        const id = peerIdFromControlName(file.name, ABORT_SUFFIX);
        return id !== undefined && expectedAbortIds.has(id);
      });
      if (leftoverAbortFiles.length > 0) {
        this.log.info(
          `[${this.id}] sweeping ${leftoverAbortFiles.length} leftover abort ` +
            "marker(s) from a prior failed exchange: " +
            `${leftoverAbortFiles
              .map((f) => sanitizeForDisplay(f.name))
              .join(", ")}`,
        );
        await Promise.all(
          leftoverAbortFiles.map((file) =>
            this.client.safeDelete(`${inboundPath}/${file.name}`),
          ),
        );
        leftoverAbortFiles.forEach((file) => ignored.add(file.name));
      }
    }

    // Single classification (isProtocolGrammarName), two sides: a FOREIGN file
    // fails the protocol grammar; an unexpected PROTOCOL file matches it but is
    // not the one tolerated peer hello. A name therefore cannot be both
    // snapshotted-as-foreign and a protocol file.
    const foreignFiles = files.filter(
      (file) => !ignored.has(file.name) && !isProtocolGrammarName(file.name),
    );
    // Protocol-grammar files that are not the tolerated peer hello: a self-hello,
    // a lock, a joining sentinel, an ack marker, or a stale message. A SECOND
    // peer hello is counted in peerHellos, not here: on the no-sweep path the >1
    // guard (else branch below) rejects it; under --sweep-exchange-files it is
    // swept along with the first, so that guard is not reached.
    // Dir-qualified so the sweep below deletes each from the directory it was
    // listed in and no rename/delete crosses the two directories: inbound files
    // here, outbound leftovers appended in the split block below.
    const unexpectedProtocol: Array<{ file: FileInfo; dir: string }> = files
      .filter(
        (file) =>
          !ignored.has(file.name) &&
          !this.isPeerHelloName(file.name) &&
          isProtocolGrammarName(file.name),
      )
      .map((file) => ({ file, dir: inboundPath }));

    // Foreign-file snapshot (always, both modes, flag or not). Cleared at entry
    // above and populated here; it deletes nothing, so it is safe in retain mode
    // where sync-mediated conflict copies are expected noise. Feeds the poll
    // loop's isRecognizedLoopFile so these names are tolerated and the "new
    // foreign file" warning measures only names that appear after entry.
    foreignFiles.forEach((file) => this.foreignFileSnapshot.add(file.name));
    if (foreignFiles.length > 0)
      this.log.info(
        `[${this.id}] tolerating ${foreignFiles.length} foreign file(s) ` +
          `present at entry in ${this.displayPath}: ` +
          `${foreignFiles.map((f) => sanitizeForDisplay(f.name)).join(", ")}`,
      );

    // Split mode: the OUTBOUND directory must be as fresh as the inbound one --
    // retain mode's fresh-directory precondition applies to both halves (a stale
    // self message or ack here would otherwise corrupt the send/ack gate). Peer
    // files never land in outbound (the peer writes to its own outbound, which
    // is THIS party's inbound), so every protocol-grammar file is this party's
    // own leftover from a crashed prior session: an orphaned temp is swept like
    // the inbound one (best-effort safeDelete), a foreign file is snapshotted
    // and tolerated, and any other protocol file is collected as unexpected
    // (rejected by the clean-start guard, or swept under --sweep-exchange-files)
    // exactly as on the inbound side.
    if (split) {
      const outFiles = await this.client.list(outboundPath);
      const outOrphans = outFiles.filter((file) =>
        isProtocolTempName(file.name),
      );
      if (outOrphans.length > 0) {
        this.log.info(
          `[${this.id}] sweeping ${outOrphans.length} orphaned temp file(s) ` +
            "left by a prior crashed exchange in the outbound directory " +
            `${sanitizeForDisplay(outboundPath)}: ` +
            `${outOrphans.map((f) => sanitizeForDisplay(f.name)).join(", ")}`,
        );
        await Promise.all(
          outOrphans.map((file) =>
            this.client.safeDelete(`${outboundPath}/${file.name}`),
          ),
        );
      }
      const sweptOut = new Set(outOrphans.map((file) => file.name));
      const outForeign: FileInfo[] = [];
      for (const file of outFiles) {
        if (sweptOut.has(file.name)) continue;
        if (!isProtocolGrammarName(file.name)) {
          this.foreignFileSnapshot.add(file.name);
          outForeign.push(file);
        } else {
          unexpectedProtocol.push({ file, dir: outboundPath });
        }
      }
      if (outForeign.length > 0)
        this.log.info(
          `[${this.id}] tolerating ${outForeign.length} foreign file(s) ` +
            `present at entry in the outbound directory ` +
            `${sanitizeForDisplay(outboundPath)}: ` +
            `${outForeign.map((f) => sanitizeForDisplay(f.name)).join(", ")}`,
        );
    }

    if (this.options.sweepExchangeFiles) {
      // Opt-in sweep: clear this exchange's protocol files (its own AND the
      // peer's) and rendezvous against a clean slate, after a retain-signal
      // inspection that refuses to destroy an audit transcript without
      // --force-retain-sweep. Foreign files are never swept.
      await this.sweepProtocolFiles(
        inboundPath,
        peerHellos,
        unexpectedProtocol,
      );
      // Every protocol file was deleted, so rendezvous proceeds as if the
      // directory held only the (untouched) foreign files.
      peerHellos = [];
    } else {
      // Default strict-empty entry guard: only a single peer hello and the
      // snapshotted foreign files are tolerated; any other protocol file is a
      // terminal usage error that now also points at the opt-in sweep.
      if (unexpectedProtocol.length > 0)
        throw new UsageError(
          // dirsDisplay names both halves in split mode: unexpectedProtocol can
          // carry outbound leftovers as well as inbound ones, so directing the
          // operator at the inbound path alone would mislead.
          `path ${dirsDisplay} must be empty except for a ` +
            "single peer hello at " +
            "the start of the protocol, but contains " +
            `${unexpectedProtocol.length} unexpected protocol file(s): ` +
            `${unexpectedProtocol
              .map((e) => sanitizeForDisplay(e.file.name))
              .join(", ")}. A pre-existing ` +
            "lock file (-lock.json), ack marker (-ack.json), joining sentinel " +
            "(-joining.json), message, or self-hello usually means a previous " +
            "exchange was terminated by SIGKILL/OOM/power loss before its " +
            "cleanup ran, or -- in retain mode, which never deletes -- that " +
            "this directory was reused for a second exchange. Remove the listed " +
            "files after confirming no other session is using this path, or " +
            "re-run with --sweep-exchange-files to clear all protocol files " +
            "automatically. An ack marker specifically indicates a crashed " +
            "lockless rendezvous or a reused retain-mode directory; if a live " +
            "lockless peer is mid-rendezvous, wait for it to complete or time " +
            "out before retrying.",
        );

      if (peerHellos.length > 1)
        throw new UsageError(
          `path ${this.displayPath} contains ${peerHellos.length} peer hello files ` +
            `(${peerHellos.map((f) => sanitizeForDisplay(f.name)).join(", ")}); ` +
            `only one peer may ` +
            "share a rendezvous directory -- are there other sessions using " +
            "this path?",
        );
    }

    return peerHellos;
  }

  // Lock-mode joiner fast-path: a single peer hello is already present and this
  // party is in lock mode, so it arrives via a `<id>-joining.json` sentinel that
  // carries its hello body, deletes the discovered peer hello, and renames the
  // sentinel into place. Commits role/peerId only after both writes succeed.
  //
  //   A list
  //   A hello
  //   B list
  //   B joining                       (sentinel carrying B's hello body)
  //   B delete A hello
  //   B rename joining -> B hello
  //   A list
  //   A delete B hello
  //
  // This is B.
  private async rendezvousAsLockJoiner(
    peerHello: FileInfo,
    helloPath: string,
  ): Promise<void> {
    const otherFile = peerHello;
    const otherPath = `${this.path}/${otherFile.name}`;
    const peerId = otherFile.name.slice(0, -HELLO_SUFFIX.length);

    this.log.debug(
      `[joiner] arriving via ${this.id}${JOINING_SUFFIX} sentinel, ` +
        `deleting discovered ${sanitizeForDisplay(otherFile.name)}`,
    );

    // I5: read the peer hello body through the partial-sync gate before
    // deleting it, validating the two required bilateral flags. open() sets
    // timeToLive before synchronize() runs, so the non-null assertion is safe.
    const peerEnvelope = await readControlFileWithGate(
      this.client,
      otherPath,
      this.options.timeToLive!,
      this.options.pollingFrequency,
      HelloEnvelopeSchema,
      this.abortController.signal,
    );

    // Bilateral flag check. A mismatch here means the peer runs a different
    // rendezvous protocol than this (lock) party -- it is lockless, since
    // only a lockless peer leaves its hello in place for a lock joiner to
    // discover. For symmetric detection the joiner must write its own
    // advertised hello BEFORE throwing (so the lockless peer reads it through
    // its own peer-hello read and fails too) and must NOT delete the peer
    // hello: both hellos are the directory's terminal state. The hello is
    // left untracked so close()/cleanup() does not sweep it. This is
    // detection, not negotiation -- neither side adapts to the other's mode.
    const mismatch = this.bilateralMismatch(peerEnvelope);
    if (mismatch) {
      // Advertise our own hello so the lockless peer reads it and fails
      // symmetrically. This is the one mismatch site that needs a NEW write at
      // detection time, so it is the single point of asymmetric failure in the
      // symmetric-detection guarantee: if the put fails at exactly this moment
      // there is no durable advertisement for the peer to read -- whatever the
      // write order -- and the peer degrades to the legacy peer-timeout. Retry
      // the write up to a small bounded budget at the polling cadence to raise
      // the odds it lands before the peer would otherwise time out (the peer is
      // concurrently polling, so the advertisement need not arrive on the first
      // try). It does not change detection -- see
      // ADVERTISE_HELLO_RETRY_ATTEMPTS.
      //
      // Only after the budget is exhausted do we fall through to the
      // log-and-degrade path. Whatever the write's outcome, THIS party still
      // throws the genuine mismatch it detected (a UsageError, CLI exit 64):
      // the retry must not let a transport rejection escape the catch-less
      // joiner fast-path and mask the mismatch as a generic Error (exit 69).
      // The mismatch is the actionable cause; the operator must fix the
      // diverging flag regardless of the transport.
      for (
        let attempt = 1;
        attempt <= ADVERTISE_HELLO_RETRY_ATTEMPTS;
        attempt++
      ) {
        try {
          await this.client.put(
            serializeEnvelope(this.helloEnvelope()),
            helloPath,
            {
              flags: "w",
              encoding: "utf-8",
            },
          );
          break;
        } catch (writeErr: unknown) {
          // Label is the literal `joiner`, not `this.role`: the handshake role
          // this party plays is fixed by reaching this lock-joiner branch, but
          // `this.role` is not committed until rendezvous succeeds (below the
          // mismatch gate), so it still holds "unknown role" here. This mirrors
          // the `[joiner]`/`[starter]` literals used elsewhere in synchronize()
          // before the role is committed.
          if (attempt < ADVERTISE_HELLO_RETRY_ATTEMPTS) {
            this.log.debug(
              `[joiner] advertise-hello write failed (attempt ` +
                `${attempt}/${ADVERTISE_HELLO_RETRY_ATTEMPTS}); retrying: ` +
                `${sanitizeForDisplay(errMessage(writeErr))}`,
            );
            try {
              await this.wait(this.options.pollingFrequency);
            } catch {
              // The only way this.wait rejects is an abort from a concurrent
              // close() -- a plain delay never rejects -- so this catch cannot
              // swallow a real put() failure (those are caught by the inner
              // try and logged above). Stop retrying and fall through to the
              // reset + `throw mismatch` below so the genuine
              // BilateralModeMismatchError (exit 64) stays the surfaced root
              // cause rather than the close's ConnectionClosedError (exit 69):
              // the diverging flag is the actionable cause the operator must
              // fix, and the close-during-mismatch case is unreachable except
              // under a signal anyway (where neither code is the exit code).
              // Log the cut-short retry so a close-during-mismatch is
              // diagnosable in debug logs, mirroring the exhausted-budget
              // path's degradation message in the else branch below.
              this.log.debug(
                `[joiner] advertise-hello retry aborted by connection ` +
                  `close after attempt ${attempt}/` +
                  `${ADVERTISE_HELLO_RETRY_ATTEMPTS}; peer may time out ` +
                  `instead of fast-failing`,
              );
              break;
            }
          } else {
            this.log.debug(
              `[joiner] could not advertise hello on mismatch after ` +
                `${ADVERTISE_HELLO_RETRY_ATTEMPTS} attempts; peer may time out ` +
                `instead of fast-failing: ${sanitizeForDisplay(errMessage(writeErr))}`,
            );
          }
        }
      }
      // Reset role/peer fields, mirroring the outer catch.
      this.peerId = undefined;
      this.role = "unknown role";
      this.handshakeRole = undefined;
      this.abortMarker.clear();
      this.resetSessionState();
      throw mismatch;
    }

    // Sentinel-mediated arrival (closes the joiner partial-failure window).
    // A bare delete(peer hello) then put(my hello) is observable as an
    // inconsistent state: if the delete lands but the put fails, the peer's
    // hello is gone and ours was never written, and the peer's waitForPeer
    // cannot tell "joiner mid-write" from "joiner crashed" -- so it polls to
    // the full peerTimeoutMs. Instead, publish a `<id>-joining.json` sentinel
    // carrying our hello body, delete the peer hello, then rename the sentinel
    // to our hello. The rename is atomic, so the sentinel exists across
    // exactly the window where the peer hello may already be gone but our
    // hello is not yet present, and the peer recognizes it as a wait signal
    // (see waitForPeer). We never re-create the peer's hello on failure: that
    // races the peer's next list() and can trip the two-hello collision check
    // (I1).
    const joiningName = `${this.id}${JOINING_SUFFIX}`;
    const joiningPath = `${this.path}/${joiningName}`;
    const helloName = `${this.id}${HELLO_SUFFIX}`;
    try {
      // The `!this.options.retainFiles` guards below match the file-wide
      // responsibleFiles idiom (every mutation is `!retainFiles`-guarded, I4a);
      // retain mode never reaches this lock joiner fast-path.
      //
      // The sentinel carries the hello body so the rename below yields a
      // fully-valid `<id>-hello.json` the peer reads through its gate; the
      // peer itself matches the sentinel by name existence and never reads it.
      await this.client.put(
        serializeEnvelope(this.helloEnvelope()),
        joiningPath,
        {
          flags: "w",
          encoding: "utf-8",
        },
      );
      // Track the sentinel only until the peer hello is deleted: before that
      // point a failure leaves the peer hello intact, so cleanup() may safely
      // sweep the sentinel (the peer is no worse off than if we never
      // started). The add follows the put with no throwable statement between,
      // matching the hello write in the else branch.
      if (!this.options.retainFiles) this.responsibleFiles.add(joiningName);

      await this.client.delete(otherPath);

      // The peer hello is now gone, so the sentinel is the peer's recovery
      // signal and MUST survive a subsequent failure. Release it from
      // responsibleFiles so a failure-path cleanup() (conn.close() in the
      // caller's finally) leaves it on disk for the peer's bounded-window
      // recovery -- and, if this process dies, for the next run's Phase 0
      // guard to reject. A crashed joiner cannot clean up after itself; this
      // is the "best-effort partial-state cleanup" contract.
      if (!this.options.retainFiles) this.responsibleFiles.delete(joiningName);

      await this.client.rename(joiningPath, helloPath);
      // The sentinel is now our hello: stop tracking the (gone) sentinel name
      // and own the hello so cleanup() sweeps it at close().
      if (!this.options.retainFiles) this.responsibleFiles.add(helloName);
    } catch (err: unknown) {
      // No resetSessionState() here: this.role, this.peerId,
      // this.handshakeRole, and the sequence counters are all committed only
      // after this try/catch (see below), so a throw leaves the connection in
      // its pre-synchronize state with nothing to reset.
      throw err instanceof Error ? err : new Error(errMessage(err));
    }

    // Commit role and peerId only after both writes have succeeded. If
    // either write threw above, the connection stays in its
    // pre-synchronize state: `this.peerId` remains undefined, so the
    // "already synchronized" guard does not block a retry on the same
    // instance, and `handshakeRole` does not point at a peer that may
    // not actually exist.
    if (peerId.startsWith(this.id + "-") || this.id.startsWith(peerId + "-")) {
      // Remove our hello before throwing: without this, a retry on the
      // same path (or the same instance) would find the stale file and
      // either mistake it for the peer's hello or trip the preexisting-
      // file guard. The throw escapes synchronize() directly (the joiner
      // fast-path has no enclosing catch), so no outer handler cleans up.
      await this.client.safeDelete(helloPath);
      if (!this.options.retainFiles) this.responsibleFiles.delete(helloName);
      this.resetSessionState();
      throw new Error(
        `peer id '${sanitizeForDisplay(peerId)}' and this party's id ` +
          `'${this.id}' share a prefix at a '-' boundary; ids must not be ` +
          "prefix-extensions of each other (e.g. 'site' / 'site-2')",
      );
    }
    this.handshakeRole = "initiator";
    this.role = "joiner";
    this.peerId = peerId;
  }

  // Symmetric hello-exchange rendezvous: this party writes its own hello, then
  // waits for the peer via either the lockless ack-handshake barrier or the lock
  // poll loop (waitForPeer), committing role/peerId only on completion. Reached
  // when the joiner fast-path does not apply -- no peer hello yet, or lockless
  // mode -- covering every rendezvous shape below:
  //
  //   A ~ B list
  //   A ~ B hello
  //   A list
  //   A lock
  //
  //   or
  //
  //   A ~ B list
  //   A ~ B hello
  //   A ~ B list
  //   A ~ B lock
  //
  //   or (lockless mode, joiner fast-path bypassed):
  //
  //   A list
  //   A hello
  //   B list (sees A hello)
  //   B hello (does not delete A hello)
  //   A ~ B ack-handshake barrier
  private async rendezvousViaHelloExchange(
    scope: RendezvousScope,
    helloPath: string,
  ): Promise<void> {
    const { outboundPath } = scope;

    this.log.debug(`[${this.role}] creating initial ${this.id}${HELLO_SUFFIX}`);
    await this.client.put(serializeEnvelope(this.helloEnvelope()), helloPath, {
      flags: "w",
      encoding: "utf-8",
    });
    if (!this.options.retainFiles)
      this.responsibleFiles.add(`${this.id}${HELLO_SUFFIX}`);
    let lockPath: string | undefined;
    let ackPath: string | undefined;

    const waitForPeer = async () => {
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

          // isPeerHelloName excludes our own hello and -- the defense this
          // adds -- a bare `-hello.json` (empty id) injected after entry,
          // which the previous endsWith-only filter would have adopted as
          // peerId="".
          const peerHellos = currentFiles.filter((file) =>
            this.isPeerHelloName(file.name),
          );

          if (peerHellos.length === 0) {
            this.log.trace(`[${this.role}] no peer hello found; polling`);
            await this.wait(this.options.pollingFrequency);
            continue;
          }

          if (peerHellos.length > 1) {
            throw new UsageError(
              `more than one peer hello file in ${this.displayPath} - are there ` +
                "other sessions using this path?",
            );
          }

          const peerHello = peerHellos[0];
          const peerId = peerHello.name.slice(0, -HELLO_SUFFIX.length);

          // Write our ack once on the first sighting of the peer's hello.
          if (ackPath === undefined) {
            // I5: read the peer hello body through the partial-sync gate
            // before writing our ack, so a truncated body is not treated as
            // malformed and does not abort the handshake prematurely. The
            // flag comparison runs on this peer-HELLO read, never the peer-ack
            // read below.
            const peerEnvelope = await readControlFileWithGate(
              this.client,
              `${this.path!}/${peerHello.name}`,
              this.options.timeToLive!,
              this.options.pollingFrequency,
              HelloEnvelopeSchema,
              this.abortController.signal,
            );

            // Bilateral flag check before writing our ack. On mismatch throw:
            // our hello (written before this loop) stays via the outer catch's
            // skip-sweep, so the peer reads it through its own peer-hello read
            // and fails too. We do not write the ack, leaving both hellos as
            // the directory's terminal state. Covers a retain_files mismatch
            // (both parties lockless, both in this barrier) as well as a
            // lockless_rendezvous mismatch (peer is a lock party that read our
            // hello at its own two-hellos branch).
            const mismatch = this.bilateralMismatch(peerEnvelope);
            if (mismatch) throw mismatch;

            // Acknowledge the peer's hello with a zero-length marker named
            // after it (`<myId>-<peerHelloStem>-ack.json`). This is a
            // self-write, so it goes to the outbound directory (the peer reads
            // it from its inbound); in shared mode that is the inbound path.
            // Published temp-then-rename so its final name never appears before
            // the file exists; the peer matches it by name existence, never by
            // reading a body.
            const peerHelloStem = peerHello.name.slice(0, -".json".length);
            this.log.debug(
              `[${this.role}] writing handshake ack for ` +
                `${sanitizeForDisplay(peerHello.name)}`,
            );
            const ackName = await this.writeAck(outboundPath, peerHelloStem);
            ackPath = `${outboundPath}/${ackName}`;
            // Track after the durable rename (delete mode only; retain never
            // sweeps) so cleanup() removes it at close(), exactly as the
            // message write in send() does. Both publish temp-then-rename, so
            // the final name only appears at the atomic rename and the add
            // immediately follows it with no throwable statement between --
            // unlike the lock/hello direct-writes, which pre-track because
            // createExclusive can leave the final name on a throwing call.
            // The in-flight temp-*.tmp is swept inline by writeAck.
            if (!this.options.retainFiles) this.responsibleFiles.add(ackName);
            // Re-enter the loop so hasPeerAck is checked against a fresh
            // listing; the pre-ack-write snapshot from this iteration may
            // miss a peer ack that arrived in the window between list() and
            // the write, adding up to pollIntervalMs of unnecessary latency on
            // slow-sync transports.
            continue;
          }

          // Barrier completes when the peer's ack of THIS party's hello is
          // visible in the current listing (always fresh because of the
          // continue above). Construct the expected name from our own hello's
          // stem and the peer id we already hold, then match by existence: the
          // marker is zero-length, so its name appearing is completion and no
          // body is read.
          const myHelloName = `${this.id}${HELLO_SUFFIX}`;
          const peerAckName = ackMarkerName(
            peerId,
            myHelloName.slice(0, -".json".length),
          );
          const hasPeerAck = currentFiles.some(
            (file) => file.name === peerAckName,
          );

          if (!hasPeerAck) {
            this.log.trace(
              `[${this.role}] waiting for peer ack ` +
                `${sanitizeForDisplay(peerAckName)}`,
            );
            await this.wait(this.options.pollingFrequency);
            continue;
          }

          // Peer ack confirmed -- commit roles and peerId as the last step,
          // the same invariant as the joiner path (see above): if the ack
          // write fails before this point, this.peerId stays undefined and
          // the "already synchronized" guard allows a retry on this instance.
          const arrivedFirst = `${this.id}${HELLO_SUFFIX}` < peerHello.name;
          this.handshakeRole = arrivedFirst ? "responder" : "initiator";
          this.role = arrivedFirst ? "starter" : "joiner";
          this.peerId = peerId;

          this.log.debug(
            `[${this.role}] lockless rendezvous complete with ` +
              `${sanitizeForDisplay(peerId)}`,
          );

          // Do NOT clear responsibleFiles: hello and ack remain so
          // cleanup() can sweep them at close() time, the same as the
          // lock-winner path.
          return;
        }

        // No role tag: this lockless timeout can fire after the peer hello
        // was seen and acked but the peer's return ack never arrived, where
        // hello-filename order may make this party the joiner. The role is
        // genuinely indeterminate here, so emit no `[role]` prefix (unlike
        // the lock timeout below, which is reachable only as the lone
        // starter).
        throw new Error("synchronization has timed out");
      }

      // Lock path.
      // Wall-clock instant this party first saw the joiner's mid-arrival
      // sentinel, paired with the sentinel name it belongs to (both undefined
      // when no sentinel is present). Bounds the joiner-recovery window below;
      // reset whenever a peer hello appears, the sentinel disappears, or a
      // sentinel with a different name takes its place, so a later or
      // different joiner always starts a fresh window rather than inheriting
      // an earlier one's deadline.
      let joiningSeenAt: number | undefined;
      let joiningSeenName: string | undefined;
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

        // isPeerHelloName excludes our own hello and a bare `-hello.json`
        // (empty id) injected after entry, which the previous endsWith-only
        // filter would have sliced to peerId="" at the role-commit sites below.
        const otherFiles = currentFiles.filter((file) =>
          this.isPeerHelloName(file.name),
        );
        const theseFiles = currentFiles.filter(
          (file) => file.name === `${this.id}${HELLO_SUFFIX}`,
        );
        const lockFiles = currentFiles.filter((file) =>
          file.name.endsWith(LOCK_SUFFIX),
        );
        // A `<peerId>-joining.json` sentinel marks a joiner mid-arrival: it
        // has begun the put(sentinel) -> delete(our hello) -> rename(sentinel
        // -> its hello) sequence the lock joiner uses in place of a bare
        // delete-then-put. Its presence is the signal that distinguishes a
        // live-but-incomplete joiner from a crashed one, which a bare
        // otherFiles.length === 0 cannot. isPeerJoiningName excludes a
        // self-named sentinel (for symmetry with the hello filters, though the
        // lock starter never writes one) and -- the defense this adds -- a bare
        // `-joining.json` (empty id), so a planted empty-id sentinel does not
        // start the joiner-recovery (joinerRecoveryMs) window below.
        const joiningFiles = currentFiles.filter((file) =>
          this.isPeerJoiningName(file.name),
        );

        if (otherFiles.length === 0) {
          if (joiningFiles.length > 0) {
            // Exactly one sentinel is the only valid mid-arrival state: one
            // joiner, one starter, and the starter never writes a sentinel.
            // A second is contamination from a third party, the same illegal
            // state the multi-peer-hello and multi-lock guards below reject;
            // surface it the same way rather than silently timing the first.
            if (joiningFiles.length > 1) {
              throw new UsageError(
                `more than one joining sentinel in ${this.displayPath} - are ` +
                  "there other sessions using this path?",
              );
            }
            // Joiner is mid-arrival. Wait a bounded recovery window for the
            // rename to land -- the joiner then appears as a normal peer hello
            // and the branches below take over. If the sentinel persists past
            // the window, the joiner failed mid-arrival -- after writing the
            // sentinel but before publishing its hello, on either side of the
            // delete; abort with a distinct transport error (a plain Error,
            // CLI exit 69) instead of polling to the full peer timeout. We do
            // NOT re-create our own hello: that races the joiner's rename and
            // could trip the two-hello collision check (I1).
            const joiningName = joiningFiles[0].name;
            const now = Date.now();
            // Start (or restart) the window on the first sighting, or whenever
            // the sentinel's name changes: a different peer id is a fresh
            // arrival, not a continuation of the one being timed, so it must
            // not inherit the earlier deadline. (Two distinct sentinel names
            // in one rendezvous likewise require a dedicated-directory
            // violation, but keying the timer to identity keeps that case from
            // prematurely aborting a legitimate later joiner.)
            if (
              joiningSeenAt === undefined ||
              joiningSeenName !== joiningName
            ) {
              joiningSeenAt = now;
              joiningSeenName = joiningName;
              this.log.debug(
                `[${this.role}] peer is mid-arrival ` +
                  `(${sanitizeForDisplay(joiningName)}); awaiting completion`,
              );
            } else if (now - joiningSeenAt > this.options.joinerRecoveryMs) {
              // The window is a lower bound, not exact: the check runs once
              // per poll after a delay(), so the abort fires somewhere in
              // (joinerRecoveryMs, joinerRecoveryMs + pollingFrequency]. That
              // imprecision is deliberate -- this is a bounded recovery
              // window, not a hard deadline, and one extra poll is immaterial
              // against the 30 s default. The crash could be on either side
              // of the joiner's delete, so the message names the bracketing
              // operations rather than a single step. Labelled [starter]:
              // this branch is reached only by the party that wrote its hello
              // first and is waiting for a joiner -- the joiner takes the
              // entry fast-path and never enters this loop -- even though
              // `this.role` is not committed until rendezvous succeeds.
              throw new Error(
                `[starter] peer began arriving ` +
                  `(${sanitizeForDisplay(joiningName)}) but did ` +
                  "not complete within the recovery window; it appears to " +
                  "have failed after announcing its arrival but before " +
                  "publishing its hello. Retry the exchange.",
              );
            }
          } else {
            // No sentinel: the joiner has not started, or a prior sighting
            // vanished without producing a hello (only a crash mid-cleanup
            // does this). Reset so a later sentinel starts a fresh window.
            joiningSeenAt = undefined;
            joiningSeenName = undefined;
            this.log.trace(`[${this.role}] no peer hello found; polling`);
          }
          await this.wait(this.options.pollingFrequency);
          continue;
        }

        // A peer hello is present: the joiner's rename landed (or both
        // parties wrote hellos), so the recovery timer is stale. A sentinel
        // may still be visible here in exactly one benign case: the peer's
        // own rename is mid-propagation on a sync-mediated transport, so its
        // `<peerId>-joining.json` and `<peerId>-hello.json` momentarily
        // coexist (the rename is atomic at the SFTP layer, not necessarily at
        // the sync-tool layer). That same-id sentinel is the peer we are
        // about to rendezvous with, so tolerate it. A sentinel whose id
        // matches no peer hello is a third party in the directory -- the same
        // contamination the multi-hello and multi-lock guards reject -- so
        // surface it as a UsageError rather than completing against an
        // inconsistent directory.
        //
        // No joiningFiles.length > 1 guard is needed here (unlike the
        // otherFiles === 0 branch above): a sentinel that escapes the
        // foreign-id check matches a present peer hello, so two such sentinels
        // would require two distinct peer hellos -- already terminal under the
        // otherFiles.length > 1 multi-peer-hello guard in the branches below,
        // which fires before any role is committed.
        const peerHelloIds = new Set(
          otherFiles.map((file) => file.name.slice(0, -HELLO_SUFFIX.length)),
        );
        const foreignSentinel = joiningFiles.find(
          (file) =>
            !peerHelloIds.has(file.name.slice(0, -JOINING_SUFFIX.length)),
        );
        if (foreignSentinel) {
          throw new UsageError(
            `joining sentinel ${sanitizeForDisplay(foreignSentinel.name)} ` +
              `in ${this.displayPath} ` +
              "matches no peer hello - are there other sessions using " +
              "this path?",
          );
        }
        joiningSeenAt = undefined;
        joiningSeenName = undefined;

        if (lockFiles.length > 0) {
          /**
           * A ~ B list
           * A ~ B hello
           * A list
           * A lock
           * B list
           * B delete A hello, B hello, lock
           *
           * This is B
           */
          if (lockFiles.length > 1) {
            throw new UsageError(
              "more than one lock file - are there other sessions using " +
                "this path?",
            );
          }
          if (otherFiles.length !== 1) {
            throw new UsageError(
              "lock file detected but no peer hello - are there other " +
                "sessions using this path?",
            );
          }
          if (theseFiles.length !== 1) {
            throw new UsageError(
              "lock file detected but no self hello - are there other " +
                "sessions using this path?",
            );
          }

          const lockFile = lockFiles[0];
          const otherFile = otherFiles[0];
          const thisFile = theseFiles[0];

          const thisId = thisFile.name.slice(0, -HELLO_SUFFIX.length);
          const otherId = otherFile.name.slice(0, -HELLO_SUFFIX.length);

          // Use hello filename order -- the same tiebreak the lock producer
          // uses (I7) -- to reconstruct the expected lock name. Do NOT fall
          // back to a raw `thisId < otherId` compare: for ids where one is a
          // prefix of the other (e.g. "Agency" / "Agency A"), space (U+0020)
          // sorts before "-" (U+002D), so hello-filename order and id-order
          // can diverge, causing a false "lock does not reference this
          // connection" throw that UUID tests would never catch.
          const arrivedFirst = thisFile.name < otherFile.name;
          const expectedLockName = arrivedFirst
            ? `${thisId}-${otherId}${LOCK_SUFFIX}`
            : `${otherId}-${thisId}${LOCK_SUFFIX}`;

          // Pair validation via reconstruct-and-compare. A stale lock from a
          // different id-pair that happens to concatenate to the same
          // <a>-<b>-lock.json string is a theoretical residual; the single-lock
          // guard above (lockFiles.length > 1) is the primary protection, so
          // the peer_id charset is left unrestricted rather than working
          // around this edge case here.
          if (lockFile.name !== expectedLockName)
            throw new Error("lock file does not reference this connection");

          // I5: read the peer hello body through the partial-sync gate
          // before committing roles. The hello name carries no byte-count
          // segment, so a half-synced body cannot be caught by a size check.
          const peerEnvelope = await readControlFileWithGate(
            this.client,
            `${this.path}/${otherFile.name}`,
            this.options.timeToLive!,
            this.options.pollingFrequency,
            HelloEnvelopeSchema,
            this.abortController.signal,
          );

          // Bilateral flag check before committing roles and before the
          // sweep below. Defense-in-depth: a lock present in the directory
          // implies both parties are in lock mode (lockless never creates a
          // lock) and a lock party always has retain_files=false (retain
          // requires lockless), so neither flag can differ and a mismatch
          // cannot reach here for any valid pairing. If a corrupt directory
          // somehow produced one, leave exactly the two hellos the design
          // names as the terminal state: delete the peer-written lock first --
          // it is a transient, not an advertisement the peer must read, and
          // the outer catch skips every safeDelete on a mismatch. safeDelete
          // is contractually non-throwing, so it cannot mask the mismatch. Our
          // own hello stays via that skip-sweep for the peer to read.
          const mismatch = this.bilateralMismatch(peerEnvelope);
          if (mismatch) {
            await this.client.safeDelete(`${this.path}/${lockFile.name}`);
            throw mismatch;
          }

          // first to arrive => should wait for first message
          this.handshakeRole = arrivedFirst ? "responder" : "initiator";
          this.role = this.handshakeRole === "initiator" ? "joiner" : "starter";
          this.peerId = otherId;

          this.log.debug(
            `[${this.role}] parsed ${sanitizeForDisplay(lockFile.name)}`,
          );

          await this.client.safeDelete(`${this.path}/${lockFile.name}`);
          await this.client.safeDelete(`${this.path}/${otherFile.name}`);
          await this.client.safeDelete(helloPath);

          if (!this.options.retainFiles) this.responsibleFiles.clear();

          return;
        }

        if (otherFiles.length > 1) {
          throw new UsageError(
            `more than one peer hello file in ${this.displayPath} - are there ` +
              "other sessions using this path?",
          );
        }
        const otherFile = otherFiles[0];
        if (theseFiles.length === 0) {
          /**
           * A list
           * A hello
           * B list
           * B joining
           * B delete A hello
           * B rename joining -> B hello
           * A delete B hello
           *
           * This is A
           */
          const otherPath = `${this.path}/${otherFile.name}`;

          // I5: read the joiner's hello body through the partial-sync gate
          // before deleting it. The joiner's hello carries no byte-count
          // segment so a half-synced body would be silently misread without
          // this gate.
          const peerEnvelope = await readControlFileWithGate(
            this.client,
            otherPath,
            this.options.timeToLive!,
            this.options.pollingFrequency,
            HelloEnvelopeSchema,
            this.abortController.signal,
          );

          // Bilateral flag check before deleting the peer hello. Defense-in-
          // depth: reaching this branch means our own hello was deleted, which
          // only a lock joiner does, so the peer is in lock mode and a
          // mismatch cannot normally arise; on the throw the peer-hello delete
          // and the sweep are both skipped.
          const mismatch = this.bilateralMismatch(peerEnvelope);
          if (mismatch) throw mismatch;

          // arrived first, should wait for a message
          this.handshakeRole = "responder";
          this.role = "starter";
          this.peerId = otherFile.name.slice(0, -HELLO_SUFFIX.length);

          this.log.debug(
            `[${this.role}] detected ${sanitizeForDisplay(otherFile.name)}; ` +
              `deleting it`,
          );

          await this.client.safeDelete(otherPath);

          if (!this.options.retainFiles) this.responsibleFiles.clear();

          return;
        } else {
          if (theseFiles.length > 1) {
            throw new UsageError(
              `more than one self hello file in ${this.displayPath} - are there ` +
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

          // I5 (closes the documented two-hellos gap): read the peer hello
          // body through the partial-sync gate, validating the bilateral
          // flags, BEFORE racing a lock. A lockless peer's hello can coexist
          // with our lock hello here, so this is a reachable
          // lockless_rendezvous mismatch. Running the check before
          // createExclusive pre-empts both the createExclusive-winner and the
          // EEXIST-loser sub-paths, so a mismatched pair never races a lock.
          // On the throw our own hello (already present -- it is one of the
          // two hellos) is left in place by the outer catch's skip-sweep, so
          // the lockless peer reads it and fails too.
          const peerEnvelope = await readControlFileWithGate(
            this.client,
            `${this.path}/${otherFile.name}`,
            this.options.timeToLive!,
            this.options.pollingFrequency,
            HelloEnvelopeSchema,
            this.abortController.signal,
          );
          const mismatch = this.bilateralMismatch(peerEnvelope);
          if (mismatch) throw mismatch;

          const lockName =
            `${arrivedFirst ? this.id : this.peerId}-` +
            `${arrivedFirst ? this.peerId : this.id}${LOCK_SUFFIX}`;
          lockPath = `${this.path}/${lockName}`;

          this.log.debug(
            `[${this.role}] attempting to create ` +
              `${sanitizeForDisplay(lockName)}`,
          );

          // Pre-emptively track lockName in delete mode: if createExclusive
          // only partially succeeds (file created on server but handle-close
          // fails with a non-EEXIST error), cleanup() will still attempt
          // safeDelete even though the EEXIST handler's
          // responsibleFiles.clear() is never reached. Both EEXIST branches
          // below call responsibleFiles.clear(), which also removes this
          // pre-emptive entry. In retain mode cleanup() is a no-op so
          // tracking serves no purpose.
          if (!this.options.retainFiles) this.responsibleFiles.add(lockName);
          try {
            await this.client.createExclusive(lockPath);
            this.log.debug(
              `[${this.role}] created lock file ` +
                `${sanitizeForDisplay(lockName)}; waiting for ` +
                "peer to finalize handshake",
            );

            /**
             * A ~ B list
             * A ~ B hello
             * A ~ list
             * A ~ createExclusive lock
             * ...
             *
             * This is A
             */
          } catch (err: unknown) {
            /**
             * A ~ B list
             * A ~ B hello
             * A ~ B list
             * A createExclusive lock
             * B createExclusive lock, EEXIST
             * B delete A hello, B hello, lock
             *
             * This is B
             */
            if (
              !(err instanceof Error) ||
              (err as NodeJS.ErrnoException).code !== "EEXIST"
            )
              throw err;

            const lockAlreadyExists = await this.client.exists(lockPath);

            if (!lockAlreadyExists) {
              // The winner never deletes the lock file in its normal path
              // (it returns from waitForPeer leaving the lock for the loser
              // to clean up). If the lock is gone after we received EEXIST,
              // the winner must have either crashed (their doCleanup ran
              // during the narrow window where lockName was in
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
                "peer appears to have abandoned the handshake: lock file " +
                  "was claimed by the peer but disappeared before this " +
                  "side could complete synchronization. Retry the exchange.",
              );
            } else {
              this.log.debug(
                `[${this.role}] lock file creation failed, assuming race ` +
                  "condition",
              );

              await this.client.safeDelete(lockPath);
              await this.client.safeDelete(`${this.path}/${otherFile.name}`);
              await this.client.safeDelete(helloPath);

              if (!this.options.retainFiles) this.responsibleFiles.clear();
            }
          }
          return;
        }
      }

      // TTL expired while still waiting. Both throws below are tagged
      // [starter]: reaching here means no peer hello was ever seen (every
      // branch that observes one commits a role and returns), so the waiter is
      // the lone starter -- never the joiner -- even though `this.role` is not
      // committed until rendezvous succeeds.
      //
      // If a joiner sentinel was visible on the final poll (joiningSeenAt
      // still set), the actionable cause is a stuck mid-arrival joiner, not a
      // bare timeout. This happens when the sentinel first appears with less
      // than joinerRecoveryMs left on the TTL, so the outer loop exits before
      // the recovery check (above) can fire; prefer the sentinel error so the
      // user still gets the same diagnosis the bounded window would have.
      // Check both: the two are set and cleared as a pair, so testing
      // joiningSeenName as well makes that coupling type-enforced (it narrows
      // to string inside the block) rather than relied on by convention, and
      // degrades gracefully to the bare timeout below if they ever diverged.
      if (joiningSeenAt !== undefined && joiningSeenName !== undefined) {
        throw new Error(
          `[starter] peer began arriving ` +
            `(${sanitizeForDisplay(joiningSeenName)}) but the ` +
            "exchange timed out before it completed; it appears to have " +
            "failed after announcing its arrival but before publishing its " +
            "hello. Retry the exchange.",
        );
      }
      throw new Error("[starter] synchronization has timed out");
    };
    try {
      await waitForPeer();
      // No clear() here: branches that finish their own cleanup
      // (responder, lock-detection, EEXIST loser, lockless) clear or retain
      // explicitly before returning. The createExclusive-winner and lockless
      // paths are the exception -- they leave hello (and lock or ack) in
      // responsibleFiles so cleanup() can sweep them if the peer never
      // arrives (e.g. crash before reaching the handshake files). Clearing
      // here would lose that safety net.
      //
      // Both rendezvous modes have assigned this.peerId by this point.
      // Reject an empty recovered id, then prefix-at-dash id pairs, before any
      // message is sent; both parties evaluate these symmetrically. The hello
      // scans above (isPeerHelloName) already exclude a bare `-hello.json`, so
      // an empty this.peerId is unreachable for a correct scan -- this is
      // defense in depth at the last gate before commit: a peerId="" slipping
      // through would make poll() treat every "-"-prefixed file as a peer
      // message and the lockless ack barrier wait on an ack no honest peer
      // writes, so fail closed here rather than proceed.
      if (this.peerId!.length === 0)
        throw new UsageError(
          "rendezvous recovered an empty peer id; a bare " +
            `'${HELLO_SUFFIX}' is not a usable peer hello`,
        );
      if (
        this.peerId!.startsWith(this.id + "-") ||
        this.id.startsWith(this.peerId! + "-")
      )
        throw new UsageError(
          `peer id '${sanitizeForDisplay(this.peerId!)}' and this party's ` +
            `id '${this.id}' share ` +
            "a prefix at a '-' boundary; ids must not be prefix-extensions " +
            "of each other (e.g. 'site' / 'site-2')",
        );
      return;
    } catch (err: unknown) {
      // A bilateral-mode mismatch is the one terminal failure that must NOT
      // sweep the directory: this party's advertised hello (written before
      // the loop) is the directory's terminal state, left in place so the
      // peer reads it through its own peer-hello read and fails too. Skip the
      // on-disk safeDelete of hello/ack/lock; clearing responsibleFiles (so a
      // later close()/cleanup() does not delete the advertised hello) and the
      // in-memory reset still run, so the instance is not wedged. A rerun
      // against the leftover hellos is rejected by the entry guard (I0) until
      // the operator clears the directory and fixes the mismatched flag.
      if (!(err instanceof BilateralModeMismatchError)) {
        if (lockPath) await this.client.safeDelete(lockPath);
        if (ackPath) await this.client.safeDelete(ackPath);
        await this.client.safeDelete(helloPath);
      }
      if (!this.options.retainFiles) this.responsibleFiles.clear();
      // The prefix-at-dash guard fires after waitForPeer() has already
      // committed this.peerId, this.role, and this.handshakeRole. Reset
      // them so the "already synchronized" guard does not block a retry
      // and the stale role does not appear in the retry's first log line.
      this.peerId = undefined;
      this.role = "unknown role";
      this.handshakeRole = undefined;
      this.abortMarker.clear();
      this.resetSessionState();
      throw err instanceof Error ? err : new Error(errMessage(err));
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

    // `path` is the inbound directory: where the peer's ack of our message (and,
    // in delete mode, the consume-delete of our own last message) is observed.
    // `outboundPath` is where this party WRITES its message; the two coincide in
    // shared mode. The temp write and its atomic rename both occur within
    // outbound, so no rename crosses the two directories.
    const path = this.path;
    const outboundPath = this.outbound ?? path;
    // A `.tmp` extension (not `.json`) keeps this in-flight write from matching
    // a `*.json` sync-tool watch before the rename to the final name lands.
    const tempFile = `temp-${uuidv4()}.tmp`;
    const tempPath = `${outboundPath}/${tempFile}`;

    // Wait for the EXACT message we last sent to be consumed (deleted) by the
    // peer -- this.lastSentFile -- not for any <id>-<digits>.json. Under delete
    // mode's one-outstanding-per-direction rule (I9) lastSentFile is the only
    // legitimate unconsumed own-message, and it is undefined before the first
    // send (nothing to wait for). Keying on the message grammar instead would
    // (a) require parseMessageByteCount to exclude our own hello/ack markers
    // and, worse, (b) spin forever on a foreign or stray <thisId>-<digits>.json
    // that the peer will never delete (the documented site-4 residual). Exact-
    // name matching avoids both, and mirrors the close() drain, which already
    // waits on lastSentFile by exact name.
    // The list() result also prunes responsibleFiles: any entry no longer on
    // the server was consumed by the peer and need not be swept at close time.
    const hasOutstandingMessage = async () => {
      const currentFiles = await this.client.list(path);
      const fileNames = currentFiles.map((f) => f.name);
      this.responsibleFiles.forEach((fileName) => {
        if (!fileNames.includes(fileName))
          this.responsibleFiles.delete(fileName);
      });
      return (
        this.lastSentFile !== undefined && fileNames.includes(this.lastSentFile)
      );
    };

    // In retain mode, the peer never deletes our message. Instead it writes a
    // zero-length ack marker named after the message, and we gate the next send
    // on that marker's existence. The expected name is constructed from the stem
    // we wrote (held in lastSentFile) and the peer id -- never parsed from a
    // marker on disk.
    const ackForLastSentPresent = async (expectedAck: string) =>
      (await this.client.list(path)).some((file) => file.name === expectedAck);

    try {
      if (this.options.retainFiles) {
        // First send (seq === 0) proceeds immediately; subsequent sends wait for
        // the receiver's ack of the previously-sent message. seq advances only
        // after a durable rename, which also sets lastSentFile, so when seq > 0
        // lastSentFile is the just-sent message's name.
        if (this.seq > 0) {
          const expectedAck = ackMarkerName(
            this.peerId!,
            this.lastSentFile!.slice(0, -".json".length),
          );
          this.log.debug(
            `[${this.role}] waiting for ack ${sanitizeForDisplay(expectedAck)} ` +
              `from ${sanitizeForDisplay(this.peerId!)}`,
          );
          // Check for the ack before the deadline, so an ack already on disk is
          // honored even if the TTL elapsed in the same instant. This is the
          // do-while rationale readControlFileWithGate uses: re-listing for a
          // present ack costs one list(), whereas discarding it would fail a
          // live exchange with a spurious timeout.
          // open() set timeToLive before send() can run; assertion is safe.
          while (true) {
            if (await ackForLastSentPresent(expectedAck)) break;
            if (Date.now() > this.options.timeToLive!.getTime()) {
              throw new UsageError(
                `timed out waiting for ack ${sanitizeForDisplay(expectedAck)} ` +
                  `from ${sanitizeForDisplay(this.peerId!)}`,
              );
            }
            await this.wait(this.options.pollingFrequency);
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
            await this.wait(this.options.pollingFrequency);
          }
        }
      }

      // The outer, cleartext type discriminator: a raw Uint8Array (an encrypted
      // PSI frame, or a raw binary frame on the unencrypted path) travels as its
      // own bytes; anything else is JSON-encoded. No base64: a Uint8Array is
      // carried verbatim, not expanded into a base64url string.
      let type: number;
      let payloadBytes: Uint8Array;
      if (data instanceof Uint8Array) {
        type = MESSAGE_TYPE_BINARY;
        payloadBytes = data;
      } else {
        type = MESSAGE_TYPE_OBJECT;
        payloadBytes = Buffer.from(JSON.stringify(data));
      }

      const ts = Date.now();
      // Do not increment this.seq yet: advance only after the durable rename so
      // a failed send does not leave the counter past an unwritten message.
      const seq = this.seq;
      // Build only the 10-byte header and derive the on-disk byte count from it
      // plus the payload length, so the encoded count is the exact on-disk size;
      // the peer waits until the synced file reaches that many bytes before
      // reading it, so a partial sync delivery is never read as a complete
      // message.
      const header = serializeFileSyncMessageHeader(type, seq);
      const byteLength = MESSAGE_HEADER_BYTES + payloadBytes.length;
      const outName = this.messageFilename(byteLength, seq, ts);
      const outPath = `${outboundPath}/${outName}`;

      this.log.trace(
        `[${this.role}] message seq=${seq}, type=${type}, ` +
          `${byteLength} bytes`,
      );
      this.log.debug(`[${this.role}] writing message ${tempFile}`);
      // Hand put() the header and payload as a two-chunk list rather than a
      // single concatenated buffer: prepending the header no longer copies the
      // whole payload, so a binary frame holds ~1x its size live rather than ~2x.
      // The transport writes the chunks back-to-back, producing the identical
      // on-disk bytes (header || payload). The header is passed first so byte 0
      // is the version marker the receiver's deserializeFileSyncMessage keys on.
      await this.client.put([header, payloadBytes], tempPath, {
        flags: "w",
        encoding: null,
      });

      this.log.debug(`[${this.role}] renaming ${tempFile} to ${outName}`);
      await this.client.rename(tempPath, outPath);
      if (!this.options.retainFiles) this.responsibleFiles.add(outName);
      this.lastSentFile = outName;
      // Advance after the durable rename: a write failure above leaves seq
      // unchanged so a retry can reuse this slot and the retain-mode ack gate
      // cannot block on a message that was never written.
      this.seq = seq + 1;
    } catch (err: unknown) {
      // tempPath may never have been written: both pre-write gate loops above
      // (the retain ack-wait and the delete-mode consume-wait) can throw before
      // the put -- a UsageError on timeout, or a ConnectionClosedError if
      // close() aborts the wait. safeDelete is idempotent over an absent file,
      // so the unconditional sweep is correct; the call on an unwritten temp is
      // a harmless no-op (the abort case is new, the timeout case pre-existing).
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

  // Resolves the effective mid-loop unexpected-file policy. An explicit
  // `unexpectedFiles` always wins; when unset, the default is mode-coupled:
  // `warn` on sync-mediated transports (retain mode or lockless rendezvous),
  // which legitimately produce transient conflict copies and partial downloads
  // mid-session, and `error` on plain delete-mode transports. Computed at the
  // use site rather than stored so it never depends on the order open() assigns
  // the mode flags. The policy is unilateral -- a local observation of one's
  // own directory view -- so the two parties may resolve to different values.
  // Re-evaluated per call rather than cached: the inputs are stable mid-session
  // so the value never changes, it is only consulted on the rare cycles that
  // find an unexpected file, and recomputing keeps the resolution stateless
  // (no field to invalidate).
  private resolveUnexpectedFilesPolicy(): "error" | "warn" | "ignore" {
    if (this.options.unexpectedFiles !== undefined)
      return this.options.unexpectedFiles;
    return this.options.retainFiles || this.options.locklessRendezvous
      ? "warn"
      : "error";
  }

  // True when `name` is a peer's hello (`<peerId>-hello.json`): it ends with
  // HELLO_SUFFIX, recovers a non-empty id (peerIdFromControlName), and that id
  // is not this party's own. The single definition of "a peer hello" shared by
  // the synchronize() entry guard and the in-flight lock/lockless rendezvous
  // scans, so "a valid peer hello" means the same thing at every site -- in
  // particular a bare `-hello.json` (empty id) is never a peer hello, whether it
  // is present at entry or injected mid-rendezvous.
  private isPeerHelloName(name: string): boolean {
    const id = peerIdFromControlName(name, HELLO_SUFFIX);
    return id !== undefined && id !== this.id;
  }

  // True when `name` is a peer's joining sentinel (`<peerId>-joining.json`): the
  // joining counterpart of isPeerHelloName. A bare `-joining.json` (empty id) is
  // rejected, so it is never treated as a real joiner arrival and never starts
  // the lock-path joiner-recovery (joinerRecoveryMs) window.
  private isPeerJoiningName(name: string): boolean {
    const id = peerIdFromControlName(name, JOINING_SUFFIX);
    return id !== undefined && id !== this.id;
  }

  // True when `name` is a file legitimately present during the message loop
  // (Phase 2), judged against the two known party ids and the filename grammar.
  // The recognized set is: an in-flight `temp-<uuidv4()>.tmp` write; and any
  // `.json` file written by either party (prefixed by `<this.id>-` or `<peerId>-`)
  // that is one of: the two hellos (`<id>-hello.json`) and the single lock
  // tiebreaker (`<first>-<second>-lock.json`), matched by exact name since each
  // has exactly one legal form; or -- for the cases whose names are unbounded --
  // matched by terminal grammar token: a message byte count (all digits, our
  // own writes; a peer message is taken by the scan above) or `ack` (the
  // rendezvous ack and the message ack, either writer, whose
  // `<writer>-<original>-ack.json` name is multi-segment by construction).
  // This covers both hellos, both acks, the lock,
  // both parties' messages and message-acks, and our own writes. `joining` is
  // deliberately absent: it is a rendezvous-phase sentinel a correct exchange
  // never leaves on disk once the loop is running.
  //
  // Anchored to the grammar discriminant, not a bare `<id>-*` glob, so a
  // conflict copy or partial download of a protocol file (e.g.
  // `<peerId>-100 (conflicted copy 2026-...).json`, whose terminal token is not
  // a grammar word) is NOT recognized and falls to the unexpected-file policy
  // -- the case this detection exists to catch.
  //
  // This is the single extensible baseline for site 3. Foreign files present at
  // entry are snapshotted and tolerated through this predicate -- see
  // the foreignFileSnapshot check at the top -- so the loop keeps one notion of
  // "recognized". The snapshot holds only grammar-FAILING names: a
  // `<peerId>-<digits>.json` MATCHES the message grammar, so it is a protocol
  // file (rejected at the no-flag entry guard, swept by --sweep-exchange-files),
  // never snapshotted. The seams it leaves are therefore for such a file reaching
  // the loop by another path -- appearing after entry, or surviving a flag sweep
  // that then re-races: with a matching NNN it is selected as a message in poll()
  // and rejected; in retain mode with a non-matching NNN it is silently skipped
  // by the recvSeq `continue` there. Both escape the unexpected-file policy and
  // neither is fixable by name -- such a file is indistinguishable from a
  // legitimately retained, already-consumed peer message.
  private isRecognizedLoopFile(name: string, peerId: string): boolean {
    // Foreign files snapshotted at synchronize() entry are tolerated for the
    // session: they predate the exchange and are not new noise. The
    // snapshot holds only grammar-FAILING names, so this never shadows the
    // message scan -- a <peerId>-<digits>.json matches the grammar, is never
    // snapshotted, and is selected then rejected by poll() rather than
    // recognized here.
    if (this.foreignFileSnapshot.has(name)) return true;
    // Only the protocol's own temp shape (temp-<uuidv4()>.tmp) is recognized; a
    // foreign temp-*.tmp with a non-UUID stem is not a loop file and falls to
    // the foreign-file policy, the same as any other foreign name.
    if (isProtocolTempName(name)) return true;
    // The two expected abort markers (this party's and the peer's) are
    // recognized by exact name, unconditionally -- so a not-yet-armed reader
    // still recognizes an abort-named file (it cannot trip the unexpected-files
    // policy on one) even though it does not verify it. A foreign
    // `<other>-abort.json` is not exact-name and falls through to the policy.
    if (isExpectedAbortName(name, this.id, peerId)) return true;
    if (!name.endsWith(".json")) return false;
    const ownPrefixed = name.startsWith(`${this.id}-`);
    if (!ownPrefixed && !name.startsWith(`${peerId}-`)) return false;
    // Hellos and the lock tiebreaker each have exactly one legal name, so match
    // them by exact name rather than terminal token -- a stray
    // `<id>-x-hello.json` or `<id>-x-lock.json` is no longer admitted. The lock
    // pair may appear in either arrival order (poll() does not track who
    // arrived first), but both reconstructions name the same single file. The
    // lock is recognized in either rendezvous mode on purpose: the recognized
    // set is mode-agnostic by spec, and admitting a stray lock conservatively
    // avoids a false-positive abort on a cross-mode or legacy residue.
    if (
      name === `${this.id}${HELLO_SUFFIX}` ||
      name === `${peerId}${HELLO_SUFFIX}`
    )
      return true;
    if (
      name === `${this.id}-${peerId}${LOCK_SUFFIX}` ||
      name === `${peerId}-${this.id}${LOCK_SUFFIX}`
    )
      return true;
    const stem = name.slice(0, -".json".length);
    const token = stem.slice(stem.lastIndexOf("-") + 1);
    // Our own messages carry a variable counter/byte-count terminal whose exact
    // name the receiver cannot predict, so they stay anchored to the numeric
    // grammar token. Scoped to our OWN prefix: a peer numeric-terminal file is
    // the message scan's job -- poll() routes or rejects it above and it never
    // falls here -- so recognizing one here would be unreachable today and a
    // false "recognized" for a future caller consulting this baseline directly
    // (e.g. a `<peerId>-foo-5.json` the scan rejects as malformed).
    if (ownPrefixed && /^\d+$/.test(token)) return true;
    if (token !== "ack") return false;
    // An ack marker is `<writerId>-<originalName>-ack.json`. Recognize it only
    // when `<originalName>` is itself a full, legal target for one of the two
    // ids -- the peer's or our own hello stem, or a message name -- rather than
    // accepting any >=4-segment shape. This rejects `<id>-x-y-ack.json` and
    // `<id>-<peerId>-x-ack.json` alike. The only stray names that still pass are
    // acks of a correctly-shaped target that was never actually sent (e.g.
    // `<id>-<peerId>-999-ack.json`): distinguishing those is the identity
    // question the directory snapshot owns, and such an ack is inert
    // -- zero-length and matching no expected-ack lookup. Prefix tests and the
    // byte-count parse are prefix/terminal anchored, so this stays correct even
    // if a peer_id itself contains a dash.
    const inner = stem.slice(0, -"-ack".length); // <writerId>-<originalName>
    for (const writer of [this.id, peerId]) {
      if (!inner.startsWith(`${writer}-`)) continue;
      const original = inner.slice(`${writer}-`.length);
      const isHello =
        original === `${this.id}-hello` || original === `${peerId}-hello`;
      const isMessage =
        (original.startsWith(`${this.id}-`) ||
          original.startsWith(`${peerId}-`)) &&
        parseMessageByteCount(`${original}.json`) !== undefined;
      if (isHello || isMessage) return true;
    }
    return false;
  }

  // Applies the resolved `unexpectedFiles` policy to files found mid-loop that
  // are neither recognized for the exchange nor in-flight temp writes
  // (enforcement site 3). `error` throws a terminal UsageError (CLI exit 64, a
  // usage/config condition like a wrong or shared directory) naming the files
  // and the path; `warn` logs each distinct name at most once across the
  // session; `ignore` does nothing (the pre-existing silent-skip behavior).
  private handleUnexpectedFiles(names: string[], path: string): void {
    const policy = this.resolveUnexpectedFilesPolicy();
    if (policy === "ignore") return;
    if (policy === "error")
      throw new UsageError(
        `unexpected file(s) appeared in ${sanitizeForDisplay(path)} during the exchange: ` +
          `${names.map((n) => sanitizeForDisplay(n)).join(", ")}. The ` +
          `directory must be dedicated to a single ` +
          'exchange between exactly two parties (see EXCHANGE_REFERENCE.md "Directory ' +
          'exclusivity"); a foreign file usually means another process or ' +
          "session is writing to this path, or a sync tool produced a conflict " +
          "copy or partial download. Remove the file, or set " +
          'connection.options.unexpected_files to "warn" or "ignore" if the ' +
          "directory cannot be dedicated.",
      );
    // warn: log each distinct name at most once per session (warnedUnexpected-
    // Files), since poll() re-lists every cycle and a persisting file would
    // otherwise log on each pass.
    for (const name of names) {
      if (this.warnedUnexpectedFiles.has(name)) continue;
      this.warnedUnexpectedFiles.add(name);
      this.log.warn(
        `[${this.role}] unexpected file ${sanitizeForDisplay(name)} in ` +
          `${sanitizeForDisplay(path)} during the ` +
          "exchange; continuing (unexpected_files: warn). If this directory is " +
          "dedicated to the exchange, this may be a conflict copy, a partial " +
          "download, or another session sharing the path.",
      );
    }
  }

  private async poll() {
    if (!this.pollerActive) return;

    if (!this.connected || this.path === undefined)
      throw new Error("not connected");

    // Rejects an empty peerId too ("" is falsy): the peer message scan below
    // keys on `${peerId}-`, so a committed peerId="" would match every
    // "-"-prefixed file. synchronize()'s scans now never commit an empty id, so
    // this only fires before synchronize() has run, but it also backstops that
    // invariant rather than letting the scan run wild on an empty id.
    if (!this.peerId) throw new Error("not synchronized");

    // `path` is the inbound directory: every peer-file read here (the listing,
    // the message get, the peer abort-marker read) is from inbound.
    // `outboundPath` is where this party writes its retain-mode ack of a
    // consumed peer message; the two coincide in shared mode.
    const path = this.path;
    const outboundPath = this.outbound ?? path;
    const peerId = this.peerId;

    let reachedGet = false;
    try {
      this.log.trace(
        `[${this.role}] polling for message from ` +
          `${sanitizeForDisplay(peerId)}`,
      );
      // Detect via a pattern scan rather than an exact-name exists(): the
      // message filename now encodes a per-message byte count (and optionally
      // a timestamp and counter), so the receiver cannot predict the exact
      // name. `<peerId>-*.json` with a numeric terminal segment (the grammar
      // discriminant) matches only the peer's message files; its
      // `-hello.json`/`-ack.json`/`-lock.json` control files have non-numeric
      // terminals and are recognized for the loop instead.
      //
      // Enforcement site 3 (see docs/spec/FILE_SYNC.md). The scan now classifies
      // EVERY file in the listing, not only peer-prefixed ones: a file that is
      // neither a peer message nor recognized for the loop (both hellos, both
      // acks, the lock, both parties' messages and message-acks, our own
      // writes, and in-flight `temp-*.tmp`) is an unexpected file and handled
      // per `unexpectedFiles` -- a revision of the old "non-numeric terminals
      // are ignored, not errors" rule for the post-entry window. The previous
      // behavior (unconditional silent skip) is preserved by
      // `unexpected_files: ignore`.
      //
      // In retain mode, messages are never deleted so the directory accumulates
      // one entry per send. synchronize() asserts a clean directory, so recvSeq
      // starts at 0 and the next unprocessed message always has NNN === recvSeq.
      const allFiles = await this.client.list(path);

      const messages: Array<{ file: FileInfo; declaredSize: number }> = [];
      const unexpected: string[] = [];
      for (const file of allFiles) {
        const name = file.name;

        // Peer message scan. A peer-prefixed `.json` whose terminal segment is
        // a byte count is a message (the grammar discriminant). Ack markers
        // (terminal `ack`) share the prefix but are control files, so they are
        // excluded here and fall through to the recognized-for-the-loop check.
        if (
          name.startsWith(`${peerId}-`) &&
          name.endsWith(".json") &&
          !name.endsWith("-ack.json")
        ) {
          const declaredSize = parseMessageByteCount(name);
          if (declaredSize !== undefined) {
            if (this.options.retainFiles) {
              const nnn = parseTimestampedMessageNNN(name);
              if (nnn === undefined) {
                // A byte-count terminal but no parseable NNN segment. In retain
                // mode every peer message carries an NNN: the bilateral retain
                // agreement is verified at rendezvous and synchronize() hard-
                // requires retain => timestamp on both sides, so a correctly
                // configured peer cannot produce this name. It is therefore a
                // malformed protocol file (corruption, or a foreign message-
                // shaped file), terminal regardless of the `unexpectedFiles`
                // policy, and reported BEFORE the recvSeq selection guard so it
                // is not silently skipped as a "different NNN".
                //
                // Deliberately a plain malformed-protocol UsageError, NOT a
                // BilateralModeMismatchError: by this point both sides have
                // already agreed on retain/timestamp at rendezvous, so a "your
                // settings disagree" message would misdirect the operator away
                // from the real cause (a corrupt or stray file). It is a
                // protocol error at this point, deeper than a misconfiguration.
                //
                // Names only this file -- the priority signal -- and does not
                // enumerate any other unexpected files this cycle may hold: the
                // throw fires mid-scan, so that list is itself incomplete, and a
                // clean re-run surfaces any remaining foreign files via
                // handleUnexpectedFiles. The message flags the possibility
                // rather than listing them.
                throw new UsageError(
                  `message file ${sanitizeForDisplay(name)} from ` +
                    `${sanitizeForDisplay(peerId)} in ${sanitizeForDisplay(path)} has a ` +
                    "byte-count terminal segment but no parseable NNN segment; " +
                    "a correctly configured retain-mode peer cannot produce " +
                    "this name, so the file is corrupt or does not belong to " +
                    "this exchange. The directory may contain further " +
                    "unexpected files this error does not enumerate; inspect it " +
                    "before retrying",
                );
              }
              // NNN < recvSeq is an already-consumed retained message; a higher
              // NNN is not yet current. Either way it is not this cycle's
              // message, so skip it. A foreign message-shaped file with a non-
              // matching NNN is skipped here too and so escapes the unexpected-
              // file policy -- it is indistinguishable by name from a retained
              // message. The snapshot does not cover it: a
              // `<peerId>-<digits>.json` matches the message grammar, so it is a
              // protocol file (rejected at the no-flag entry guard, swept by
              // --sweep-exchange-files), never snapshotted. This residual skip
              // applies only to such a file reaching the loop by another path
              // (appearing after entry, or surviving a sweep).
              if (nnn !== this.recvSeq) continue;
            }
            messages.push({ file, declaredSize });
            continue;
          }
          // Peer-prefixed `.json`, non-ack, non-numeric terminal (e.g. the peer
          // hello, or a stray `<peerId>-backup.json`): fall through to the
          // recognized/unexpected classification below.
        }

        // Foreign-file detection: a file neither recognized for the loop nor an
        // in-flight temp write is unexpected and handled per `unexpectedFiles`.
        if (!this.isRecognizedLoopFile(name, peerId)) unexpected.push(name);
      }

      // Apply the mid-loop unexpected-file policy before processing messages:
      // `error` throws here (terminal), `warn` logs once per name and falls
      // through, `ignore` is a no-op. Malformed protocol files (the unparseable-
      // NNN case above) are handled separately and unconditionally.
      if (unexpected.length > 0) this.handleUnexpectedFiles(unexpected, path);

      // Authenticated cross-party abort detection, after the scan and the
      // unexpected-files policy. A present-and-verified <peerId>-abort.json is a
      // definitive peer-abort signal, so fast-fail with a PeerAbortError rather
      // than riding to the peer-silence timeout. Clearing pollerActive and
      // returning BEFORE any further emit keeps the PeerAbortError the top-level
      // error the orchestrator's catch sees (and the finally below then does not
      // reschedule). An absent or unverified marker falls through and keeps
      // polling -- honest absence stays the hedge.
      //
      // Re-read every cycle by design; a first-cycle non-match is deliberately
      // NOT cached. A present-but-unverified <peerId>-abort.json is either a torn
      // or delayed atomic write (which a later cycle reads complete) or a planted
      // forgery (which the peer's genuine marker may later overwrite) -- caching
      // the non-match would blind the loop to both and lose the fast-fail. The
      // redundant read is bounded to ABORT_MARKER_MAX_BYTES (1 KiB) and refused
      // pre-get when the listing already reports it over the cap, so the repeat
      // I/O is negligible.
      if (
        this.abortArmed &&
        (await this.abortMarker.verifyPeerMarker(
          this.client,
          allFiles,
          path,
          peerId,
        ))
      ) {
        this.pollerActive = false;
        this.emit("error", new PeerAbortError());
        return;
      }

      if (messages.length > 1) {
        // Two messages selected at once is a terminal protocol violation in
        // either mode -- re-reading cannot reconcile it -- so it is a UsageError
        // that stops the poller (I5b/I6), not a retryable transport failure.
        if (this.options.retainFiles) {
          // In retain mode the scan is filtered to a single NNN (recvSeq), so
          // two matches mean two files share one NNN -- a protocol violation or
          // directory reuse, not necessarily a separate session.
          throw new UsageError(
            `more than one message file with NNN=${this.recvSeq} from ` +
              `${sanitizeForDisplay(peerId)} in ${sanitizeForDisplay(path)} - possible ` +
              `duplicate-NNN or directory reuse`,
          );
        }
        // Delete mode keeps at most one outstanding message per direction (I9),
        // so two peer messages means a concurrent session or a protocol bug.
        throw new UsageError(
          `more than one message file from ${sanitizeForDisplay(peerId)} in ` +
            `${sanitizeForDisplay(path)} - are there ` +
            "other sessions using this path?",
        );
      }

      if (messages.length === 1) {
        const { file: messageFile, declaredSize } = messages[0];

        // Frame-size bound (the primary enforcement point; see
        // docs/spec/CHANNEL_SECURITY.md). Refuse before the
        // sync-gate and before get() loads the body into memory: a hostile
        // server admin could otherwise write an arbitrarily large file and
        // exhaust memory. Checked against both the filename-declared count and
        // the listed on-disk size (either one over the cap is enough, and the
        // declared check fires even while the file is still syncing, so we never
        // wait for an over-cap file to finish). This pre-check trusts the listed
        // size the same way the sync-gate below already does; the maxBytes cap
        // passed to get() is the hard backstop for a server that under-reports
        // the size here. Terminal: a FrameSizeExceededError is a UsageError, so
        // poll()'s catch stops the poller rather than re-reading the file.
        //
        // The cap is the per-exchange inboundFrameCap when one is set (the
        // single-pass receiver tightens it to the derived reply cap before
        // reading the reply), else the static MAX_FRAME_SIZE_BYTES; the setter
        // clamps it to never exceed the static backstop. This is what "replaces
        // the static constant for that read" -- the read gate enforces the
        // exchanged-count-derived cap, not a second check above a still-static
        // one.
        const frameCap = this.inboundFrameCap ?? MAX_FRAME_SIZE_BYTES;
        if (declaredSize > frameCap || messageFile.size > frameCap) {
          throw new FrameSizeExceededError(
            `message file ${sanitizeForDisplay(messageFile.name)} from ` +
              `${sanitizeForDisplay(peerId)} in ${sanitizeForDisplay(path)} ` +
              `declares ${declaredSize} byte(s) (on disk: ${messageFile.size}), ` +
              `exceeding the maximum inbound frame size of ` +
              `${frameCap} bytes; refusing to read it into memory`,
          );
        }

        if (messageFile.size < declaredSize) {
          // The file has appeared but the sync tool has not finished
          // transferring it. Leave it untouched and re-check next cycle rather
          // than reading a truncated message. For a direct transport (SFTP),
          // the atomic rename means the size already matches on the first poll.
          this.log.trace(
            `[${this.role}] ${sanitizeForDisplay(messageFile.name)} is ` +
              `${messageFile.size}/` +
              `${declaredSize} bytes; waiting for full sync`,
          );
        } else {
          const inPath = `${path}/${messageFile.name}`;
          this.log.debug(
            `[${this.role}] getting message ` +
              `${sanitizeForDisplay(messageFile.name)}`,
          );

          reachedGet = true;
          const message = await this.client.get(inPath, {
            // Read raw bytes: a binary frame is delivered verbatim and a JSON
            // control payload is bounded-parsed from its bytes, so the body is
            // never converted to a string (a capped read always resolves to a
            // Buffer regardless, but this states the intent).
            encoding: null,
            // The hard backstop behind the pre-get size check above, for a
            // server that under-reports the file's size in its listing: the same
            // per-exchange frameCap (or the static cap when none is set).
            maxBytes: frameCap,
          });
          reachedGet = false;

          // The file has already passed the byte-count gate above, so it is
          // fully synced: an envelope or JSON-parse failure here is genuine
          // corruption, not a partial write, and re-reading the same bytes
          // cannot fix it. Classify it as a terminal UsageError (the catch below
          // stops the poller on a UsageError) -- the same rule
          // readControlFileWithGate applies to control files. This is
          // mode-agnostic: in retain mode the never-deleted file would
          // otherwise be re-read every poll cycle until the peer timeout; in
          // delete mode it is deleted before this runs, but the classification
          // stays uniform so a corrupt frame is a clean terminal failure rather
          // than a silently dropped message.
          //
          // The returned `data` is ready for emit: the parsed object for a JSON
          // control message, or the raw frame bytes for a binary frame. Only the
          // JSON path decodes to a string (through the bounded chokepoint); the
          // binary frame is never stringified, so a frame larger than Node's
          // maximum string length is read intact.
          const parseMessage = (): {
            seq: number;
            type: number;
            data: unknown;
          } => {
            let envelope: DeserializedMessage;
            try {
              envelope = deserializeFileSyncMessage(message);
            } catch (parseErr: unknown) {
              // An unrecognized envelope version byte is the file-sync signature
              // of a version-mismatched partner (a JSON-text message from a
              // pre-envelope peer leads with '{', and a future envelope bump
              // raises the byte), so name that real cause instead of the raw
              // "malformed envelope" text -- turning a cryptic frame-parse
              // failure into one obvious log line. foundVersion and
              // MESSAGE_ENVELOPE_VERSION are small header numbers, not partner
              // text; name and peerId stay sanitized as before.
              if (parseErr instanceof IncompatibleEnvelopeVersionError)
                throw new UsageError(
                  `message file ${sanitizeForDisplay(messageFile.name)} from ` +
                    `${sanitizeForDisplay(peerId)} has an unrecognized wire ` +
                    `format (envelope version byte ${parseErr.foundVersion}, ` +
                    `not this build's ${MESSAGE_ENVELOPE_VERSION}); the partner ` +
                    `is likely running an incompatible psilink version, and ` +
                    `both parties must run the same version`,
                );
              // Any other envelope failure (truncation, unknown type, out-of-
              // range seq) is genuine corruption from a same-version peer. The
              // error carries only fixed text and small header numbers, but route
              // it through the same escape as the sibling throws below for
              // uniformity.
              throw new UsageError(
                `message file ${sanitizeForDisplay(messageFile.name)} from ` +
                  `${sanitizeForDisplay(peerId)} is fully synced but has a ` +
                  `malformed envelope: ${sanitizeForDisplay(errMessage(parseErr))}`,
              );
            }
            if (envelope.type === MESSAGE_TYPE_BINARY)
              return {
                seq: envelope.seq,
                type: envelope.type,
                data: envelope.payload,
              };
            let value: unknown;
            try {
              // parseBoundedJson takes the raw payload bytes and structurally
              // bounds them before JSON.parse. Its message is sanitized too:
              // V8's JSON.parse error quotes a span of the offending input
              // (`Unexpected token 'x', "...." is not valid JSON`), so the whole
              // error string can carry the peer's raw bytes -- the same
              // control/ANSI/Unicode injection vector as the filename.
              value = parseBoundedJson(envelope.payload);
            } catch (parseErr: unknown) {
              throw new UsageError(
                `message file ${sanitizeForDisplay(messageFile.name)} from ` +
                  `${sanitizeForDisplay(peerId)} is fully synced but is not ` +
                  `valid JSON: ${sanitizeForDisplay(errMessage(parseErr))}`,
              );
            }
            return { seq: envelope.seq, type: envelope.type, data: value };
          };

          if (this.options.retainFiles) {
            // Retain mode never deletes the message file: the directory is the
            // durable transcript, and the ack marker -- written here after
            // validation and before emit -- is the consumption signal the sender
            // waits for in place of the file disappearing. Because no message is
            // ever removed, the directory accumulates one message and one ack
            // per exchanged message on every transport (not only no-delete ones);
            // poll() re-lists and reclassifies it each cycle, so per-poll cost
            // scales with transcript length. Rotation/retention is an out-of-band
            // operator responsibility.
            const msgNNN = this.recvSeq;

            const validatedMessage = parseMessage();

            // Both the sender and receiver derive NNN from the same per-session
            // counter, so a body seq that does not match the filename NNN
            // indicates file corruption or a protocol bug. Surface it
            // immediately rather than silently acking or delivering a
            // mismatched message.
            if (validatedMessage.seq !== msgNNN)
              throw new UsageError(
                `message body seq=${validatedMessage.seq} does not match ` +
                  `filename NNN=${msgNNN}: possible corruption or protocol bug`,
              );

            this.log.trace(
              `[${this.role}] received message seq=${validatedMessage.seq}, ` +
                `type=${messageTypeLabel(validatedMessage.type)}`,
            );

            // Write the ack marker before emit. The ack is the sender's go-ahead
            // signal and means "durably received", not "consumed by the
            // application": the message is a fully-synced file that retain mode
            // never deletes, so it is already durable at this point, and acking
            // before the local hand-off keeps the peer unblocked even when emit
            // fails (e.g. downstream backpressure). Do NOT reorder to
            // emit-before-ack -- an ack-write failure after a successful emit
            // would re-deliver an already-consumed message.
            //
            // The ack name is derived from the consumed message's fixed name, so
            // a reprocess re-derives the identical name and cannot create a
            // duplicate file. The per-NNN guard is therefore only an
            // optimization: if a prior poll wrote this NNN's ack and then emit
            // threw, recvSeq stayed at msgNNN and the message is reprocessed
            // here; skipping the re-write saves one put+rename of a marker that
            // would otherwise overwrite itself under the same name.
            if (this.lastAckedNNN !== msgNNN) {
              // The ack is a self-write -> outbound (the peer reads it from its
              // inbound, which is this outbound). In shared mode this is `path`.
              const ackName = await this.writeAck(
                outboundPath,
                messageFile.name.slice(0, -".json".length),
              );
              this.lastAckedNNN = msgNNN;
              this.log.debug(
                `[${this.role}] wrote ack ${sanitizeForDisplay(ackName)} for ` +
                  `seq=${validatedMessage.seq}`,
              );
            }

            // `data` is already the value to deliver: the parsed object for a
            // JSON control message, or the raw frame bytes for a binary frame.
            this.emit("data", validatedMessage.data);
            // Advance only after the application has seen the payload: if emit
            // throws, recvSeq stays at msgNNN so the (never-deleted) message file
            // is reprocessed on the next poll rather than permanently lost.
            this.recvSeq++;
          } else {
            // Parse before deleting. A corrupt fully-synced message is terminal
            // (I5b), so parsing first leaves the offending file on disk for
            // inspection instead of destroying it; a valid message is then
            // consumed by deleting it (the delete-mode go-ahead signal to the
            // sender) before emit, the same ordering relative to emit as before.
            const validatedMessage = parseMessage();
            this.log.trace(
              `[${this.role}] received message seq=${validatedMessage.seq}, ` +
                `type=${messageTypeLabel(validatedMessage.type)}`,
            );

            this.log.debug(
              `[${this.role}] deleting message ` +
                `${sanitizeForDisplay(messageFile.name)}`,
            );
            try {
              await this.client.delete(inPath);
            } catch (err: unknown) {
              // A terminal UsageError -- the per-operation liveness/size bound,
              // e.g. the stall deadline a withheld delete callback now trips -- is
              // NOT a transient delete failure and must not be swallowed: re-reading
              // and re-deleting the same file just re-hits the same stall, and the
              // emit("data") below would deliver a message whose consume-delete
              // never landed, so the file stays on disk and the next poll re-emits a
              // duplicate. Rethrow it to poll()'s outer catch, which stops the poller
              // and surfaces it -- the terminal-on-UsageError rule every other
              // transport-call site here follows. A transient (non-UsageError)
              // failure falls through to the retry-and-re-read path below.
              if (err instanceof UsageError) throw err;
              // First delete failed (transiently); retry once after a backoff. On
              // abort (close() mid-poll) this.wait rejects here, unwinding past the
              // emit("data") below into poll()'s catch, where the !pollerActive
              // guard swallows it (see below). The second delete AND the emit
              // are both skipped, so the message is left undelivered for this
              // session -- but it is still on disk (this first delete failed),
              // so a fresh connection re-reads it. Teardown defers delivery; it
              // does not lose the message.
              await this.wait(this.options.pollingFrequency);
              try {
                await this.client.delete(inPath);
              } catch (deleteErr: unknown) {
                // Same terminal-on-UsageError rule for the second attempt: a stall
                // is terminal, not a "manual cleanup may be required" transient.
                if (deleteErr instanceof UsageError) throw deleteErr;
                this.log.warn(
                  `[${this.role}] failed to delete ` +
                    `${sanitizeForDisplay(messageFile.name)}; ` +
                    "please notify the administrator that manual cleanup " +
                    // The delete error's message re-embeds the peer filename via
                    // the operation path; escape it like the name above it.
                    `may be required: ${sanitizeForDisplay(errMessage(deleteErr))}`,
                );
              }
            }

            // `data` is already the value to deliver: the parsed object for a
            // JSON control message, or the raw frame bytes for a binary frame.
            this.emit("data", validatedMessage.data);
          }
        }
      }
      this.consecutiveEnoentCount = 0;
    } catch (err: unknown) {
      // Shutdown guard (by state, not error type): close() aborts the session
      // controller, so a wait parked in the delete-retry backoff above rejects
      // with a ConnectionClosedError that lands here. Swallow it -- close()
      // already cleared pollerActive (synchronously, before this rejection
      // could surface), so the guard is true only during teardown. A genuine
      // error during active polling reaches here with pollerActive still true
      // (the pollerActive = false assignments below run later), so this cannot
      // suppress a real failure; and it is robust to a transport client that
      // wraps/rethrows the rejection, which an `instanceof` check would miss.
      // The finally then sees pollerActive === false and does not reschedule.
      // pollerActive is also cleared by the public stop(), so this guard is
      // really "stop() or close() ran" -- but stop() is only ever called from
      // close() in this codebase, so the guard still means teardown. Were a
      // future caller to invoke stop() independently mid-poll, a concurrent
      // real error would be swallowed here; that is an accepted limitation of
      // the deliberate by-state (not by-error-type) choice.
      if (!this.pollerActive) return;
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
            `[${this.role}] message from ${sanitizeForDisplay(peerId)} ` +
              "disappeared between list and get; " +
              (this.options.retainFiles
                ? "unexpected in retain mode (files are never deleted) -- " +
                  "possible external interference; retrying"
                : "assuming peer cleaned up"),
          );
        }
      } else {
        // Non-TOCTOU failure: either a non-ENOENT error from any operation, or
        // any error where reachedGet is false (e.g., exists() or message
        // parsing). A delete() failure reaches here only when it is a terminal
        // UsageError (the per-operation stall deadline): the inner delete
        // try/catch rethrows a UsageError to this catch and swallows-and-retries
        // only a transient (non-UsageError) failure. The other rejection the
        // delete-retry block can propagate is an abort (close() firing during its
        // this.wait backoff), but that is a ConnectionClosedError caught by the
        // !pollerActive guard at the top of this catch and never reaches this
        // branch. All other cases are propagated immediately as hard failures.
        this.consecutiveEnoentCount = 0;
        // A UsageError reaching this catch is terminal -- re-reading the same
        // bytes cannot help: a fully-synced message that fails to parse or
        // validate, a body-seq/filename-NNN mismatch, or a duplicate NNN. Stop
        // the poller before emitting so the finally block does not reschedule
        // and re-read the same corrupt file. A transient non-UsageError -- a
        // list/get/put/rename or ack-write transport hiccup -- reschedules
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
    this.lastAckedNNN = -1;
    this.lastSentFile = undefined;
    this.warnedUnexpectedFiles.clear();
    // Clear any per-exchange inbound cap so a stale tight cap from a prior
    // exchange on a reused connection cannot reject a later one. The protocol
    // layer clears it explicitly after each single-pass reply too; this is the
    // belt-and-suspenders reset on a fresh session.
    this.inboundFrameCap = undefined;
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
