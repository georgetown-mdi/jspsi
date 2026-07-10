// Filename grammar for the file-sync wire protocol: the pure predicates and name
// constructors over the on-disk names the `sftp` and `filedrop` channels
// exchange (messages, hellos, locks, joining sentinels, ack markers, abort
// markers, and in-flight temp files). Everything here is a pure function of its
// string/constant inputs -- no instance state, no I/O -- so the recognizers and
// builders live in one place and cannot silently diverge between enforcement
// sites.
//
// The normative filename GRAMMAR (the name forms these functions parse and
// build) is owned by the overview-tier docs/EXCHANGE_REFERENCE.md ("Filename
// grammar"); this module implements it and does not restate it. The state
// machine that consumes these predicates -- the directory-as-state-machine, the
// enforcement sites, and the invariants -- is docs/spec/FILE_SYNC.md. That tier
// split (overview owns the grammar, spec owns the state machine) is a
// deliberate, recorded tier inversion: see docs/spec/README.md.
//
// This module is deliberately NOT re-exported by the package barrel (main.ts
// barrels fileSyncConnection.ts via `export *`, not this file), so an
// `@internal` export here stays out of the package's public runtime surface
// while a unit test can still deep-import it -- the same pattern as
// fileSyncConstants.ts. The two currently-public grammar recognizers,
// isAbortMarkerName and isExpectedAbortName, keep their public surface by being
// re-exported from fileSyncConnection.ts (which IS barrelled).

import { validate as uuidValidate, version as uuidVersion } from "uuid";

// Suffix shared by all hello files.
export const HELLO_SUFFIX = "-hello.json";

// Suffix of the lock-mode tiebreaker file (`<peer1>-<peer2>-lock.json`). Named
// for parity with HELLO_SUFFIX/JOINING_SUFFIX so the endsWith filter and both
// name-construction sites stay in sync under a future rename. Its terminal
// segment is the type word `lock` (never a `.lock` extension), so the grammar
// discriminant excludes it from the message scan -- not all-digits -- the same
// way it excludes hello and joining files.
export const LOCK_SUFFIX = "-lock.json";

// Suffix of the lock-path joiner-arrival sentinel (`<id>-joining.json`). The
// joiner publishes it before deleting the peer hello and renames it to its own
// hello once that delete lands, so the peer can tell "joiner mid-arrival" from
// "joiner crashed" across the window where the peer hello is gone but the
// joiner hello is not yet written. The terminal segment is the type word
// `joining` (never a `.joining` extension), so the grammar discriminant already
// excludes it from the message scan (it is not all-digits).
export const JOINING_SUFFIX = "-joining.json";

// Suffix of the authenticated cross-party abort marker (`<writerId>-abort.json`).
// The terminal segment before `.json` is the type word `abort`, which is not
// all-digits, so parseMessageByteCount returns undefined and the marker can
// never be mis-consumed as a message -- an additive-grammar correctness
// invariant. Named for parity with HELLO_SUFFIX/LOCK_SUFFIX/JOINING_SUFFIX.
export const ABORT_SUFFIX = "-abort.json";

// Extracts the declared byte count from a message filename by reading the last
// `-`-delimited segment before `.json`. Parsing is right-anchored so an id
// containing hyphens (a UUID, or a configured peer id) cannot corrupt the
// result regardless of how many segments precede the count. Returns undefined
// when that segment is not a non-negative integer.
/** @internal */
export const parseMessageByteCount = (name: string): number | undefined => {
  const stem = name.slice(0, -".json".length);
  const lastSegment = stem.slice(stem.lastIndexOf("-") + 1);
  if (!/^\d+$/.test(lastSegment)) return undefined;
  return Number(lastSegment);
};

// Right-anchored parse of the NNN (per-session sequence counter) from a
// timestamped message filename (<id>-<ts>-<NNN>-<byteCount>.json). NNN is the
// segment immediately before the terminal byte-count segment. Returns undefined
// when the segment is not a non-negative integer.
//
// Caller contract: only meaningful for a timestamped filename, i.e. retain
// mode, where timestampInFilename is always true. On a non-timestamped name
// (<id>-<byteCount>.json) the segment before the byte count is part of the id,
// so this returns a WRONG value rather than undefined. There is no runtime guard
// (the sole caller, poll() in retain mode, satisfies the contract); a new caller
// outside retain mode must check timestampInFilename itself.
/** @internal */
export const parseTimestampedMessageNNN = (
  name: string,
): number | undefined => {
  const stem = name.slice(0, -".json".length);
  const withoutByteCount = stem.slice(0, stem.lastIndexOf("-"));
  const nnnStr = withoutByteCount.slice(withoutByteCount.lastIndexOf("-") + 1);
  if (!/^\d+$/.test(nnnStr)) return undefined;
  return Number(nnnStr);
};

// Builds the acknowledgment-marker name for the file `<originalName>.json`:
// `<writerId>-<originalName>-ack.json`. The marker is the single construct that
// signals "I durably received your file" on transports that cannot delete --
// the lockless rendezvous ack (acking a peer hello) and the retain-mode message
// ack (acking a consumed message). `originalName` is the acknowledged file's
// name minus the `.json` extension.
//
// Construct-and-match only: ids may contain `-`, so a two-id marker name is not
// reverse-parseable into its ids -- and never needs to be, because both ends
// already hold the exact name of the acknowledged file (the receiver read it
// from the listing; the author wrote it). The waiter builds the expected name
// with this function and tests it against the listing; no site splits a marker
// name back into ids. Routing keys only on the terminal `ack` segment, so the
// name is safe even when an id contains `-` or equals the word "ack".
/** @internal */
export const ackMarkerName = (writerId: string, originalName: string): string =>
  `${writerId}-${originalName}-ack.json`;

// Recovers the peer id from a `<id><suffix>` rendezvous control name (a hello or
// a joining sentinel), returning undefined for any name that does not end with
// `suffix` OR whose recovered id is empty (a bare `<suffix>`, e.g. `-hello.json`
// or `-joining.json`). An empty recovered id is never a usable peer identity:
// adopting it would commit rendezvous to peerId="", after which poll() treats
// every "-"-prefixed file as a peer message and the lockless ack barrier waits
// for an ack no honest peer writes -- a hang/abort an unauthenticated transport
// would otherwise let any writer induce by planting a `-hello.json` mid-flight.
// This is the single notion of "recovered peer id" shared by the entry guard
// (isPeerHelloName) and every in-flight rendezvous scan, so the non-empty check
// cannot be present at one slicing site while silently omitted at another (the
// gap this hardens: the entry guard rejected an empty id, the in-flight scans
// did not).
/** @internal */
export const peerIdFromControlName = (
  name: string,
  suffix: string,
): string | undefined => {
  if (!name.endsWith(suffix)) return undefined;
  const id = name.slice(0, -suffix.length);
  return id.length > 0 ? id : undefined;
};

// True only for the protocol's OWN in-flight temp file: `temp-<uuidv4()>.tmp`,
// the exact shape send() and writeAck() write (`temp-${uuidv4()}.tmp`,
// independent of any id). Validating the stem as a v4 UUID is what lets every
// other `temp-*.tmp` -- a foreign `temp-export.tmp`, an unrelated sync-tool
// scratch file -- fall through to the foreign-file policy (tolerated) rather
// than being deleted by the entry sweep. Matching any `temp-`/`.tmp` name would
// destroy such a foreign file in a namespace collision; the v4-UUID validation
// keeps the two notions of "foreign" (here and the foreign-file snapshot) in
// agreement. uuidVersion() throws on a non-UUID stem, so the uuidValidate()
// short-circuit must precede it.
/** @internal */
export const isProtocolTempName = (name: string): boolean => {
  if (!name.startsWith("temp-") || !name.endsWith(".tmp")) return false;
  const stem = name.slice("temp-".length, -".tmp".length);
  // Match ONLY the canonical lowercase form uuidv4() emits. The uuid package's
  // validate() carries the /i flag, so without this guard a foreign
  // temp-<UPPERCASE-but-valid-v4>.tmp would be accepted and swept -- a residual
  // slice of the very namespace-collision data loss this narrowing removes.
  // uuidv4() (uuid v14) always emits lowercase, so this rejects no name our own
  // send()/writeAck() writes. toLowerCase() is locale-independent for a UUID's
  // ASCII hex/hyphen, so there is no Turkish-I hazard.
  if (stem !== stem.toLowerCase()) return false;
  return uuidValidate(stem) && uuidVersion(stem) === 4;
};

/**
 * Grammar-level abort-marker recognizer: true for any `<id>-abort.json` by
 * suffix, under ANY id.
 *
 * Used by the entry guard's isProtocolGrammarName so a leftover abort marker
 * classifies as a protocol file -- handled by the recognize-and-sweep -- rather
 * than failing the directory-clean check as a foreign file. Deliberately broader
 * than isExpectedAbortName; every name isExpectedAbortName accepts also satisfies
 * this (subset invariant, pinned by a unit test). Like the sibling suffix checks
 * in isProtocolGrammarName (HELLO/LOCK/JOINING), this is a bare endsWith with no
 * minimum-prefix guard, so the empty-prefix form `-abort.json` is also
 * grammar-recognized. That form is not sweepable -- isExpectedAbortName and the
 * entry sweep both require a non-empty id -- so it fails closed as an unexpected
 * protocol file (exit 64), the same fate as a bare `-hello.json`, and is never a
 * usable identity any honest party writes.
 */
export const isAbortMarkerName = (name: string): boolean =>
  name.endsWith(ABORT_SUFFIX);

/**
 * Exact-name abort-marker recognizer: true only for this party's or the peer's
 * marker (`<selfId>-abort.json` or `<peerId>-abort.json`).
 *
 * Used by the poll loop's isRecognizedLoopFile so the two expected markers are
 * tolerated (recognized, not unexpected) while a foreign `<other>-abort.json` an
 * admin might plant still hits the unexpected-files policy -- exact-name keeps
 * the unexpected-files exemption from silencing a planted foreign marker.
 */
export const isExpectedAbortName = (
  name: string,
  selfId: string,
  peerId: string,
): boolean =>
  name === `${selfId}${ABORT_SUFFIX}` || name === `${peerId}${ABORT_SUFFIX}`;

// Classifies a filename against the protocol filename grammar: true for any
// protocol artifact (an in-flight temp write, a hello, a lock, a joining
// sentinel, an ack marker, an abort marker, or a message whose terminal segment
// is a byte count), false for a "foreign" name that fails the grammar (a
// conflict copy, a partial download, an unrelated file). This is the single
// inverse of "foreign" the entry guard and the foreign-file snapshot share, so a
// name cannot be both snapshotted-as-foreign and a recognized protocol file --
// which would silently reintroduce the (rejected) reading where I0 tolerates
// message-shaped files at entry. A message-shaped <id>-<digits>.json MATCHES
// here and is therefore a protocol file, never foreign: at the no-flag entry
// guard it is an unexpected protocol file (rejected), and under
// --sweep-exchange-files it is swept. A `temp-*.tmp` whose stem is not a v4 UUID
// is NOT the protocol's temp shape (isProtocolTempName), so it fails the grammar
// here and is treated as foreign.
/** @internal */
export const isProtocolGrammarName = (name: string): boolean => {
  if (isProtocolTempName(name)) return true;
  if (!name.endsWith(".json")) return false;
  if (
    name.endsWith(HELLO_SUFFIX) ||
    name.endsWith(LOCK_SUFFIX) ||
    name.endsWith(JOINING_SUFFIX) ||
    // Any -abort.json counts (isAbortMarkerName), under any id: a leftover abort
    // marker is a protocol file, so the entry guard's recognize-and-sweep can
    // handle it rather than the directory-clean check rejecting it as foreign.
    isAbortMarkerName(name) ||
    // Any -ack.json counts, deliberately broad: a foreign name that happens to
    // end -ack.json is conservatively treated as a protocol file (rejected at
    // the no-flag guard, swept under the flag) rather than tolerated as foreign.
    // Erring toward protocol here is the safe side -- the inverse would let a
    // stray ack-shaped name slip past the entry guard. (isRetainMessageAck below
    // is the narrower, retain-signal-only test over this same suffix.)
    name.endsWith("-ack.json")
  )
    return true;
  return parseMessageByteCount(name) !== undefined;
};

// True for a name SHAPED like a retain-only message ack. A retain message is
// always timestamped (<id>-<ts>-<NNN>-<byteCount>.json, since retain requires
// timestamp_in_filename), so a genuine ack
// <writerId>-<id>-<ts>-<NNN>-<byteCount>-ack.json ends in TWO all-digit dash
// segments (the NNN and the byte count). Requiring both -- not just the byte
// count -- trims the common foreign collisions (notes-5-ack.json,
// report-2024-ack.json) and excludes a rendezvous hello-ack, which ends in
// `-hello` and is written in lockless-delete mode too.
//
// This is a deliberately CONSERVATIVE heuristic, not a precise classifier: a
// filename alone cannot prove writer-id structure, so a contrived foreign name
// with two trailing digit segments (e.g. backup-100-200-ack.json) still matches.
// That is acceptable. It errs toward refusing a DESTRUCTIVE sweep -- which the
// operator clears with --force-retain-sweep -- and the authoritative retain
// signal is the peer hello's retain_files flag (read below), which a retain
// directory always carries (I4b). So a miss here is harmless and a false match
// only over-asks for confirmation; neither risks data. Tightening it further
// chases false positives a filename can never fully exclude.
/** @internal */
export const isRetainMessageAck = (name: string): boolean => {
  if (!name.endsWith("-ack.json")) return false;
  // Require at least two dash-separated segments and both trailing ones all
  // digits. Split rather than walk lastIndexOf back twice: on a single-segment
  // inner ("100") the arithmetic form mis-slices (slice(0, -1) -> "10") and
  // wrongly matches; split yields ["100"], length < 2, correctly rejected.
  const segments = name.slice(0, -"-ack.json".length).split("-");
  if (segments.length < 2) return false;
  const nnn = segments[segments.length - 2];
  const byteCount = segments[segments.length - 1];
  return /^\d+$/.test(nnn) && /^\d+$/.test(byteCount);
};
