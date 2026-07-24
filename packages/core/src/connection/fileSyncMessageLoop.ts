// The file-sync message loop (Phase 2), in two parts. First, the pure
// classification helpers: the outgoing-message filename builder, the mid-loop
// unexpected-file policy resolver, and the loop-file recognizer that judges
// whether a name found on disk belongs to the running exchange. Each is a pure
// function of its arguments -- it reads an id, the relevant option flags, a peer
// id, or the foreign-file snapshot passed in explicitly, holds no instance
// state, and does no I/O -- so the message-loop's filename grammar and policy
// defaults live in one place and cannot silently diverge between call sites.
//
// Second, the FileSyncMessageLoop coordinator: the stateful poll/ack/seq loop.
// It is a union shape -- a stateful subsystem that OWNS the nine message-loop
// counters (seq, recvSeq, lastAckedNNN, lastSentFile, consecutiveEnoentCount,
// inboundFrameCap, poller, pollerActive, warnedUnexpectedFiles), mutating them
// as plain field writes in the hot paths, AND a deps-composed coordinator that
// reaches the connection's shared/root state through a bidirectional
// MessageLoopDeps object. It holds no EventEmitter: it emits solely through
// deps.emit, a synchronous pass-through to the connection's overridden emit, so
// the unhandled-error buffering, cause-chaining, and listener delivery stay
// byte-identical. The RATIONALE -- the frame-size and liveness bounds, the
// replay/sequencing guarantees, and the durable-ack contract -- is normatively
// specified in docs/spec/FILE_SYNC.md and docs/spec/CHANNEL_SECURITY.md; this
// module implements it and does not restate it.
//
// This module is deliberately NOT re-exported by the package barrel (main.ts
// barrels fileSyncConnection.ts via `export *`, not this file), so its
// `@internal` exports stay out of the package's public runtime surface while a
// unit test can still deep-import them -- the same pattern as fileSyncNames.ts,
// fileSyncFraming.ts, and fileSyncRendezvous.ts. FileSyncConnection composes the
// coordinator and keeps thin public delegators (send/start/stop/
// setInboundFrameCap/resetSessionState and the delegating seq getter/setter) so
// its public and test surface is unchanged.

import { v4 as uuidv4 } from "uuid";

import { sanitizeForDisplay } from "../utils/sanitizeForDisplay";
import { parseBoundedJson } from "../utils/boundedJson";
import type { getLoggerForVerbosity } from "../utils/logger";
import { UsageError, FrameSizeExceededError, PeerAbortError } from "../errors";
import { MAX_FRAME_SIZE_BYTES } from "./frameSize";
import {
  MESSAGE_ENVELOPE_VERSION,
  MESSAGE_TYPE_OBJECT,
  MESSAGE_TYPE_BINARY,
  MESSAGE_HEADER_BYTES,
  messageTypeLabel,
  serializeFileSyncMessageHeader,
  deserializeFileSyncMessage,
  IncompatibleEnvelopeVersionError,
} from "./fileSyncFraming";
import type { DeserializedMessage } from "./fileSyncFraming";
import {
  HELLO_SUFFIX,
  LOCK_SUFFIX,
  parseMessageByteCount,
  parseTimestampedMessageNNN,
  ackMarkerName,
  isProtocolTempName,
  isExpectedAbortName,
} from "./fileSyncNames";
import type { FileInfo, FileTransportClient } from "./fileSyncConnection";

const errMessage = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

// Builds an outgoing message filename. The byte count is always the final
// `-`-delimited segment before `.json` so the receiver can extract it with a
// right-anchored parse (see parseMessageByteCount). When timestampInFilename
// is set, a compact UTC timestamp and a zero-padded per-session counter are
// inserted so sync-mediated logging can recover write order even when the
// sync tool rewrites file mtimes.
/** @internal */
export function messageFilename({
  id,
  timestampInFilename,
  byteCount,
  seq,
  ts,
}: {
  id: string;
  timestampInFilename: boolean;
  byteCount: number;
  seq: number;
  ts: number;
}): string {
  if (!timestampInFilename) return `${id}-${byteCount}.json`;
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
  return `${id}-${timestamp}-${counter}-${byteCount}.json`;
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
/** @internal */
export function resolveUnexpectedFilesPolicy(options: {
  unexpectedFiles?: "error" | "warn" | "ignore";
  retainFiles: boolean;
  locklessRendezvous: boolean;
}): "error" | "warn" | "ignore" {
  if (options.unexpectedFiles !== undefined) return options.unexpectedFiles;
  return options.retainFiles || options.locklessRendezvous ? "warn" : "error";
}

// True when `name` is a file legitimately present during the message loop
// (Phase 2), judged against the two known party ids and the filename grammar.
// The recognized set is: an in-flight `temp-<uuidv4()>.tmp` write; and any
// `.json` file written by either party (prefixed by `<selfId>-` or `<peerId>-`)
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
/** @internal */
export function isRecognizedLoopFile(
  name: string,
  selfId: string,
  peerId: string,
  foreignFileSnapshot: ReadonlySet<string>,
): boolean {
  // Foreign files snapshotted at synchronize() entry are tolerated for the
  // session: they predate the exchange and are not new noise. The
  // snapshot holds only grammar-FAILING names, so this never shadows the
  // message scan -- a <peerId>-<digits>.json matches the grammar, is never
  // snapshotted, and is selected then rejected by poll() rather than
  // recognized here.
  if (foreignFileSnapshot.has(name)) return true;
  // Only the protocol's own temp shape (temp-<uuidv4()>.tmp) is recognized; a
  // foreign temp-*.tmp with a non-UUID stem is not a loop file and falls to
  // the foreign-file policy, the same as any other foreign name.
  if (isProtocolTempName(name)) return true;
  // The two expected abort markers (this party's and the peer's) are
  // recognized by exact name, unconditionally -- so a not-yet-armed reader
  // still recognizes an abort-named file (it cannot trip the unexpected-files
  // policy on one) even though it does not verify it. A foreign
  // `<other>-abort.json` is not exact-name and falls through to the policy.
  if (isExpectedAbortName(name, selfId, peerId)) return true;
  if (!name.endsWith(".json")) return false;
  const ownPrefixed = name.startsWith(`${selfId}-`);
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
    name === `${selfId}${HELLO_SUFFIX}` ||
    name === `${peerId}${HELLO_SUFFIX}`
  )
    return true;
  if (
    name === `${selfId}-${peerId}${LOCK_SUFFIX}` ||
    name === `${peerId}-${selfId}${LOCK_SUFFIX}`
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
  for (const writer of [selfId, peerId]) {
    if (!inner.startsWith(`${writer}-`)) continue;
    const original = inner.slice(`${writer}-`.length);
    const isHello =
      original === `${selfId}-hello` || original === `${peerId}-hello`;
    const isMessage =
      (original.startsWith(`${selfId}-`) ||
        original.startsWith(`${peerId}-`)) &&
      parseMessageByteCount(`${original}.json`) !== undefined;
    if (isHello || isMessage) return true;
  }
  return false;
}

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

// The message-loop-relevant subset of the connection's Options, read live
// through the deps `options` accessor. The connection's full Options is a
// superset, so `() => this.options` satisfies this; naming only what poll() and
// send() read keeps the seam's dependency on the connection's config explicit
// and narrow.
/** @internal */
export interface MessageLoopOptions {
  retainFiles: boolean;
  locklessRendezvous: boolean;
  timestampInFilename: boolean;
  timeToLive?: Date;
  pollingFrequency: number;
  unexpectedFiles?: "error" | "warn" | "ignore";
}

// The connection-owned state the coordinator reads across the seam. Three kinds,
// each chosen so it cannot shift observable timing versus the inline form:
//   - SHARED SET REFERENCES (never copies): responsibleFiles and
//     foreignFileSnapshot are the same Set instances poll()/send()/cleanup()/
//     close() hold, so every add/delete/has/forEach here is observed there.
//   - LIVE ACCESSORS (read fresh per call, never hoisted): client/id/role/log/
//     options/path/outbound/peerId/connected/abortArmed. open() rebinds the
//     logger and the role commits at rendezvous, so reading them live keeps the
//     loop reflecting the current values.
//   - DELEGATES: wait forwards to the connection's cancellable wait; emit is the
//     SYNCHRONOUS pass-through to the connection's OVERRIDDEN emit, so the
//     unhandled-error buffering and cause-chaining stay intact (the loop holds
//     no emitter of its own); writeAck and verifyPeerAbortMarker forward to the
//     connection and its abort-marker subsystem.
// No setters: the loop owns its counters and mutates them in place.
/** @internal */
export interface MessageLoopDeps {
  responsibleFiles: Set<string>;
  foreignFileSnapshot: Set<string>;
  client: () => FileTransportClient;
  id: () => string;
  role: () => string;
  log: () => ReturnType<typeof getLoggerForVerbosity>;
  options: () => MessageLoopOptions;
  path: () => string | undefined;
  outbound: () => string | undefined;
  peerId: () => string | undefined;
  connected: () => boolean;
  abortArmed: () => boolean;
  wait: (ms: number) => Promise<void>;
  emit: (event: "data" | "error", arg: unknown) => boolean;
  writeAck: (dir: string, originalName: string) => Promise<string>;
  verifyPeerAbortMarker: (
    files: Array<FileInfo>,
    path: string,
    peerId: string,
  ) => Promise<boolean>;
}

/**
 * The stateful file-sync message loop (poll/ack/seq) as a self-contained
 * subsystem {@link FileSyncConnection} composes. A union shape: it OWNS the nine
 * message-loop counters and mutates them as plain field writes in poll()/send(),
 * AND reads the connection's shared/root state through {@link MessageLoopDeps}
 * accessors, sharing the responsibleFiles/foreignFileSnapshot Sets by reference.
 * It holds no EventEmitter -- it emits through deps.emit, the synchronous
 * pass-through to the connection's overridden emit -- so external behavior is
 * byte-identical to the inline form; the protocol is specified in
 * docs/spec/FILE_SYNC.md and docs/spec/CHANNEL_SECURITY.md. `seq` and
 * `lastSentFile` are public because the connection reads or delegates to them
 * (the seq getter/setter, and the close() drain via a delegating getter); the
 * remaining counters are internal to the loop.
 *
 * @internal
 */
export class FileSyncMessageLoop {
  // Per-session send-sequence counter. Public because FileSyncConnection exposes
  // it through a delegating seq getter/setter that tests read and write; every
  // other counter is reached only through this class. Advanced (in send()) only
  // after the durable rename.
  seq = 0;
  private recvSeq = 0;
  // Highest message NNN whose ack marker has already been written. The ack name
  // is a pure function of the consumed message's fixed name, so a reprocess
  // re-derives the identical name and cannot create a duplicate file; this guard
  // only saves the redundant put+rename of an already-named marker (see poll()).
  // -1 means none yet; the first message is NNN 0.
  private lastAckedNNN = -1;

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

  private poller: NodeJS.Timeout | undefined;
  private pollerActive = false;

  // The name of the last message this party sent. Read by two consumers: the
  // delete-mode drain in close() (waits for the peer to consume this exact file
  // before sweeping), and the retain-mode send gate (constructs the peer's
  // expected ack marker name from this stem and waits for it to exist). Assigned
  // on every successful send regardless of mode; only the reader differs. Public
  // because close() reads it through the connection's delegating getter.
  lastSentFile: string | undefined;
  private consecutiveEnoentCount = 0;
  // Distinct names already warned about under `unexpectedFiles: "warn"`. poll()
  // re-lists every cycle, so a recurring unexpected file would log on each pass
  // without this; membership caps it at one warning per name. Reset per session
  // (resetSessionState) so a name reused across exchanges on the same instance
  // can warn again.
  private warnedUnexpectedFiles = new Set<string>();

  constructor(private readonly deps: MessageLoopDeps) {}

  /**
   * Writes one message to the shared directory for the peer to consume. The
   * connection's public send() delegates here.
   */
  async send(data: unknown) {
    const { deps } = this;
    if (!deps.connected() || deps.path() === undefined)
      throw new Error("not connected");

    // peerId is committed by synchronize() in all rendezvous paths; guard here
    // (before mode-specific branches) so both retain and non-retain modes
    // require synchronize() to have completed first.
    if (!deps.peerId()) throw new Error("not synchronized");

    // `path` is the inbound directory: where the peer's ack of our message (and,
    // in delete mode, the consume-delete of our own last message) is observed.
    // `outboundPath` is where this party WRITES its message; the two coincide in
    // shared mode. The temp write and its atomic rename both occur within
    // outbound, so no rename crosses the two directories.
    const path = deps.path()!;
    const outboundPath = deps.outbound() ?? path;
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
      const currentFiles = await deps.client().list(path);
      const fileNames = currentFiles.map((f) => f.name);
      deps.responsibleFiles.forEach((fileName) => {
        if (!fileNames.includes(fileName))
          deps.responsibleFiles.delete(fileName);
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
      (await deps.client().list(path)).some(
        (file) => file.name === expectedAck,
      );

    try {
      if (deps.options().retainFiles) {
        // First send (seq === 0) proceeds immediately; subsequent sends wait for
        // the receiver's ack of the previously-sent message. seq advances only
        // after a durable rename, which also sets lastSentFile, so when seq > 0
        // lastSentFile is the just-sent message's name.
        if (this.seq > 0) {
          const expectedAck = ackMarkerName(
            deps.peerId()!,
            this.lastSentFile!.slice(0, -".json".length),
          );
          deps
            .log()
            .debug(
              `[${deps.role()}] waiting for ack ${sanitizeForDisplay(expectedAck)} ` +
                `from ${sanitizeForDisplay(deps.peerId()!)}`,
            );
          // Check for the ack before the deadline, so an ack already on disk is
          // honored even if the TTL elapsed in the same instant. This is the
          // do-while rationale readControlFileWithGate uses: re-listing for a
          // present ack costs one list(), whereas discarding it would fail a
          // live exchange with a spurious timeout.
          // open() set timeToLive before send() can run; assertion is safe.
          while (true) {
            if (await ackForLastSentPresent(expectedAck)) break;
            if (Date.now() > deps.options().timeToLive!.getTime()) {
              throw new UsageError(
                `timed out waiting for ack ${sanitizeForDisplay(expectedAck)} ` +
                  `from ${sanitizeForDisplay(deps.peerId()!)}`,
              );
            }
            await deps.wait(deps.options().pollingFrequency);
          }
        }
      } else {
        if (await hasOutstandingMessage()) {
          deps
            .log()
            .debug(
              `[${deps.role()}] waiting for previous message to be consumed`,
            );
          while (await hasOutstandingMessage()) {
            // open() set timeToLive before send() can run; assertion is safe.
            if (Date.now() > deps.options().timeToLive!.getTime()) {
              throw new UsageError(
                `timed out waiting for message from ${deps.id()} to be consumed`,
              );
            }
            await deps.wait(deps.options().pollingFrequency);
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
      const outName = messageFilename({
        id: deps.id(),
        timestampInFilename: deps.options().timestampInFilename,
        byteCount: byteLength,
        seq,
        ts,
      });
      const outPath = `${outboundPath}/${outName}`;

      deps
        .log()
        .trace(
          `[${deps.role()}] message seq=${seq}, type=${type}, ` +
            `${byteLength} bytes`,
        );
      deps.log().debug(`[${deps.role()}] writing message ${tempFile}`);
      // Hand put() the header and payload as a two-chunk list rather than a
      // single concatenated buffer: prepending the header no longer copies the
      // whole payload, so a binary frame holds ~1x its size live rather than ~2x.
      // The transport writes the chunks back-to-back, producing the identical
      // on-disk bytes (header || payload). The header is passed first so byte 0
      // is the version marker the receiver's deserializeFileSyncMessage keys on.
      await deps.client().put([header, payloadBytes], tempPath, {
        flags: "w",
        encoding: null,
      });

      deps.log().debug(`[${deps.role()}] renaming ${tempFile} to ${outName}`);
      await deps.client().rename(tempPath, outPath);
      if (!deps.options().retainFiles) deps.responsibleFiles.add(outName);
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
      await deps.client().safeDelete(tempPath);
      throw err instanceof Error ? err : new Error(errMessage(err));
    }
  }

  // Applies the resolved `unexpectedFiles` policy to files found mid-loop that
  // are neither recognized for the exchange nor in-flight temp writes
  // (enforcement site 3). `error` throws a terminal UsageError (CLI exit 64, a
  // usage/config condition like a wrong or shared directory) naming the files
  // and the path; `warn` logs each distinct name at most once across the
  // session; `ignore` does nothing (the pre-existing silent-skip behavior).
  private handleUnexpectedFiles(names: string[], path: string): void {
    const { deps } = this;
    const policy = resolveUnexpectedFilesPolicy(deps.options());
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
      deps
        .log()
        .warn(
          `[${deps.role()}] unexpected file ${sanitizeForDisplay(name)} in ` +
            `${sanitizeForDisplay(path)} during the ` +
            "exchange; continuing (unexpected_files: warn). If this directory is " +
            "dedicated to the exchange, this may be a conflict copy, a partial " +
            "download, or another session sharing the path.",
        );
    }
  }

  private async poll() {
    const { deps } = this;
    if (!this.pollerActive) return;

    if (!deps.connected() || deps.path() === undefined)
      throw new Error("not connected");

    // Rejects an empty peerId too ("" is falsy): the peer message scan below
    // keys on `${peerId}-`, so a committed peerId="" would match every
    // "-"-prefixed file. synchronize()'s scans now never commit an empty id, so
    // this only fires before synchronize() has run, but it also backstops that
    // invariant rather than letting the scan run wild on an empty id.
    if (!deps.peerId()) throw new Error("not synchronized");

    // `path` is the inbound directory: every peer-file read here (the listing,
    // the message get, the peer abort-marker read) is from inbound.
    // `outboundPath` is where this party writes its retain-mode ack of a
    // consumed peer message; the two coincide in shared mode.
    const path = deps.path()!;
    const outboundPath = deps.outbound() ?? path;
    const peerId = deps.peerId()!;

    let reachedGet = false;
    try {
      // Cycle-boundary reconnect for a transport in connection-per-poll mode: the
      // previous cycle released its session at the idle boundary (the finally
      // below), so re-establish one before this cycle's ops run. A no-op for the
      // default whole-exchange session and for a connectionless transport (the
      // method is absent, so the optional call short-circuits to undefined). A
      // transient re-dial failure returns false -- skip this cycle and retry on
      // the next tick (the peer-inactivity ceiling still terminates the exchange
      // if dials keep failing for the whole budget); a fatal one (host-key or
      // credential rejection) rejects and is surfaced terminally.
      let sessionReady: boolean | undefined;
      try {
        sessionReady = await deps.client().ensureConnected?.();
      } catch (dialErr: unknown) {
        // Stop the poller before emitting so the finally does not reschedule into
        // the same rejection, then surface it as the terminal error it is.
        this.pollerActive = false;
        deps.emit(
          "error",
          dialErr instanceof Error ? dialErr : new Error(errMessage(dialErr)),
        );
        return;
      }
      if (sessionReady === false) return;
      deps
        .log()
        .trace(
          `[${deps.role()}] polling for message from ` +
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
      const allFiles = await deps.client().list(path);

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
            if (deps.options().retainFiles) {
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
        if (
          !isRecognizedLoopFile(
            name,
            deps.id(),
            peerId,
            deps.foreignFileSnapshot,
          )
        )
          unexpected.push(name);
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
        deps.abortArmed() &&
        (await deps.verifyPeerAbortMarker(allFiles, path, peerId))
      ) {
        this.pollerActive = false;
        deps.emit("error", new PeerAbortError());
        return;
      }

      if (messages.length > 1) {
        // Two messages selected at once is a terminal protocol violation in
        // either mode -- re-reading cannot reconcile it -- so it is a UsageError
        // that stops the poller (I5b/I6), not a retryable transport failure.
        if (deps.options().retainFiles) {
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
          deps
            .log()
            .trace(
              `[${deps.role()}] ${sanitizeForDisplay(messageFile.name)} is ` +
                `${messageFile.size}/` +
                `${declaredSize} bytes; waiting for full sync`,
            );
        } else {
          const inPath = `${path}/${messageFile.name}`;
          deps
            .log()
            .debug(
              `[${deps.role()}] getting message ` +
                `${sanitizeForDisplay(messageFile.name)}`,
            );

          reachedGet = true;
          const message = await deps.client().get(inPath, {
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

          if (deps.options().retainFiles) {
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

            deps
              .log()
              .trace(
                `[${deps.role()}] received message seq=${validatedMessage.seq}, ` +
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
              const ackName = await deps.writeAck(
                outboundPath,
                messageFile.name.slice(0, -".json".length),
              );
              this.lastAckedNNN = msgNNN;
              deps
                .log()
                .debug(
                  `[${deps.role()}] wrote ack ${sanitizeForDisplay(ackName)} for ` +
                    `seq=${validatedMessage.seq}`,
                );
            }

            // `data` is already the value to deliver: the parsed object for a
            // JSON control message, or the raw frame bytes for a binary frame.
            deps.emit("data", validatedMessage.data);
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
            deps
              .log()
              .trace(
                `[${deps.role()}] received message seq=${validatedMessage.seq}, ` +
                  `type=${messageTypeLabel(validatedMessage.type)}`,
              );

            deps
              .log()
              .debug(
                `[${deps.role()}] deleting message ` +
                  `${sanitizeForDisplay(messageFile.name)}`,
              );
            try {
              await deps.client().delete(inPath);
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
              await deps.wait(deps.options().pollingFrequency);
              try {
                await deps.client().delete(inPath);
              } catch (deleteErr: unknown) {
                // Same terminal-on-UsageError rule for the second attempt: a stall
                // is terminal, not a "manual cleanup may be required" transient.
                if (deleteErr instanceof UsageError) throw deleteErr;
                deps.log().warn(
                  `[${deps.role()}] failed to delete ` +
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
            deps.emit("data", validatedMessage.data);
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
          // error handler (doCleanup -> conn.stop()) is still called and
          // is safe when pollerActive is already false.
          this.pollerActive = false;
          deps.emit(
            "error",
            err instanceof Error ? err : new Error(errMessage(err)),
          );
        } else {
          deps
            .log()
            .warn(
              `[${deps.role()}] message from ${sanitizeForDisplay(peerId)} ` +
                "disappeared between list and get; " +
                (deps.options().retainFiles
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
        deps.emit(
          "error",
          err instanceof Error ? err : new Error(errMessage(err)),
        );
      }
    } finally {
      if (this.pollerActive) {
        // Idle boundary: release the session for the inter-poll gap before
        // scheduling the next cycle, so a transport in connection-per-poll mode
        // does not hold one across an idle gap a server's max-session/idle cap
        // would drop. A no-op for the default whole-exchange session and for a
        // connectionless transport (the method is absent). This runs only when
        // the poller is still active -- a terminal error or stop() clears
        // pollerActive, so the last cycle before teardown does not release out
        // from under close(), which owns the final session teardown. A release
        // failure must never break the loop: this reschedule runs in a bare
        // setTimeout, so a rejection here would surface as an unhandled rejection
        // rather than a poll error -- swallow it (the session is torn down at
        // close() regardless) and reschedule.
        try {
          await deps.client().releaseForIdle?.();
        } catch (releaseErr: unknown) {
          deps
            .log()
            .debug(
              `[${deps.role()}] idle-boundary session release failed: ` +
                sanitizeForDisplay(errMessage(releaseErr)),
            );
        }
        this.poller = setTimeout(
          () => this.poll(),
          deps.options().pollingFrequency,
        );
      }
    }
  }

  // Resets all per-session counters and tracking to their initial state.
  // Called at the rendezvous outer catch (to allow retry on the same instance),
  // at the joiner prefix-at-dash error path, and at close() (so a closed
  // instance does not carry stale counters into a hypothetical re-open).
  resetSessionState() {
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

  // Owns the per-exchange inbound frame cap and its clamp; the connection's
  // public setInboundFrameCap delegates here. Clamped to
  // min(maxBytes, MAX_FRAME_SIZE_BYTES) so a per-exchange cap can only tighten,
  // never widen, the static memory backstop.
  setInboundFrameCap(maxBytes: number | undefined): void {
    this.inboundFrameCap =
      maxBytes === undefined
        ? undefined
        : Math.min(maxBytes, MAX_FRAME_SIZE_BYTES);
  }

  start() {
    this.deps.log().debug(`[${this.deps.role()}] starting poller`);
    this.pollerActive = true;
    this.consecutiveEnoentCount = 0;
    this.poll();
  }

  stop() {
    this.deps.log().debug(`[${this.deps.role()}] stopping poller`);
    this.pollerActive = false;
    if (this.poller) clearTimeout(this.poller);
  }
}
