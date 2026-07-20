// The pure classification helpers of the file-sync message loop (Phase 2): the
// outgoing-message filename builder, the mid-loop unexpected-file policy
// resolver, and the loop-file recognizer that judges whether a name found on
// disk belongs to the running exchange. Each is a pure function of its
// arguments -- it reads an id, the relevant option flags, a peer id, or the
// foreign-file snapshot passed in explicitly, holds no instance state, and does
// no I/O -- so the message-loop's filename grammar and policy defaults live in
// one place and cannot silently diverge between call sites.
//
// This module is deliberately NOT re-exported by the package barrel (main.ts
// barrels fileSyncConnection.ts via `export *`, not this file), so its
// `@internal` exports stay out of the package's public runtime surface while a
// unit test can still deep-import them -- the same pattern as fileSyncNames.ts,
// fileSyncFraming.ts, and fileSyncRendezvous.ts. FileSyncConnection keeps thin
// private forwarding wrappers over these functions so its message-loop call
// sites read unchanged.

import {
  HELLO_SUFFIX,
  LOCK_SUFFIX,
  parseMessageByteCount,
  isProtocolTempName,
  isExpectedAbortName,
} from "./fileSyncNames";

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
