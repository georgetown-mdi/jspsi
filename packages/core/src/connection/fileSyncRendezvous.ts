// Rendezvous for the file-sync wire protocol, in two parts. First, the pure
// rendezvous helpers: the hello payload builder, the bilateral-mode-mismatch
// comparison, the peer control-file name recognizers, and the partial-sync-gated
// control-file read. Each is a pure function of its arguments -- it reads the two
// bilateral mode flags, an id, or a transport client passed in explicitly, holds
// no instance state, and does no I/O beyond the transport client it is handed.
// This module also defines RendezvousScope, the per-call path/display scope a
// synchronize() call computes once at entry and threads through the negotiation.
//
// Second, the FileSyncRendezvous coordinator: the stateful rendezvous
// negotiation (the entry-directory scan and sweep, the lock-joiner fast-path, and
// the symmetric hello-exchange with its lockless-ack-barrier and lock branches).
// It is a coordinator over connection-owned state rather than an owner of durable
// state: it reads the connection's identity/config through accessor deps and
// WRITES role/peerId/handshakeRole back through setter deps at the commit sites,
// and it mutates the connection's responsibleFiles/foreignFileSnapshot Sets by
// shared reference. That bidirectional deps object is why it is a class the
// connection composes rather than the read-only-getter shape of the abortMarker
// and sftpSession subsystems. The rendezvous protocol RATIONALE -- the wire
// names, the ordering, the lock-vs-lockless negotiation, and the
// bilateral-mismatch and joiner-recovery guarantees -- is normatively specified
// in docs/spec/FILE_SYNC.md and docs/spec/CHANNEL_SECURITY.md; this module
// implements it and does not restate it.
//
// This module is deliberately NOT re-exported by the package barrel (main.ts
// barrels fileSyncConnection.ts via `export *`, not this file), so its
// `@internal` exports stay out of the package's public runtime surface while a
// unit test can deep-import them -- the same pattern as fileSyncNames.ts and
// fileSyncFraming.ts. FileSyncConnection keeps the thin public synchronize()
// entry (validateSynchronizeEntry() plus rendezvous.run(scope)) and injects the
// identity/config/Set deps the coordinator negotiates over.

import * as z from "zod";
import { NIL as NIL_UUID } from "uuid";

import {
  clipToRenderedCost,
  renderedDisplayCost,
  DEFAULT_MAX_DISPLAY_LENGTH,
} from "../utils/sanitizeForDisplay";
import {
  redactAndSanitizeForDisplay,
  redactPrivateKeyMaterial,
} from "../utils/sanitizeErrorForDisplay";
import {
  parseBoundedJson,
  JsonStructureBoundError,
} from "../utils/boundedJson";
import type { getLoggerForVerbosity } from "../utils/logger";
import type { HandshakeRole } from "../types";
import {
  UsageError,
  BilateralModeMismatchError,
  markPeerWaitTimeout,
} from "../errors";
import {
  ADVERTISE_HELLO_RETRY_ATTEMPTS,
  cancellableDelay,
} from "./fileSyncConstants";
import { MAX_FRAME_SIZE_BYTES } from "./frameSize";
import {
  HELLO_SUFFIX,
  LOCK_SUFFIX,
  JOINING_SUFFIX,
  ABORT_SUFFIX,
  ackMarkerName,
  peerIdFromControlName,
  helloTempName,
  isHelloTempName,
  isProtocolTempName,
  isProtocolGrammarName,
  isRetainMessageAck,
} from "./fileSyncNames";
import { messageFilename } from "./fileSyncMessageLoop";
import {
  HelloEnvelopeSchema,
  serializeEnvelope,
  type HelloEnvelope,
} from "./controlEnvelope";
import { errorMessage } from "./messageConnection";
import type { FileInfo, FileTransportClient } from "./fileSyncConnection";

// The path/display locals a single synchronize() call computes once at entry
// (from this.path/this.outbound, narrowed by the connected guard) and threads
// through its phase methods. Not instance state: each field is derived per
// call, so passing this scope by value keeps the phases from re-deriving it and
// from depending on the order in which the guards ran. `inboundPath` is where
// this party reads the peer's files; `outboundPath` is where it writes its own
// (they coincide in shared mode); `split` is true only with a separate outbound
// directory; `dirsDisplay` is the operator-facing scope naming both halves in
// split mode.
/** @internal */
export interface RendezvousScope {
  inboundPath: string;
  outboundPath: string;
  split: boolean;
  dirsDisplay: string;
}

/**
 * Compose the operator-facing directory scope, redacting each path where it is
 * interpolated rather than the composed result. The split form carries
 * first-party labels BETWEEN two paths, so redacting the composite would let a
 * marker in the inbound path consume the labels and the operator's own outbound
 * path under the fail-closed dangling rule -- the shape
 * {@link redactPrivateKeyMaterial} exists to contain. Every production producer
 * of a {@link RendezvousScope}'s `dirsDisplay`, and the sweep's own scope
 * string, goes through here -- a convention, not a guarantee: `dirsDisplay` is a
 * plain string, so a producer composing one by hand is not rejected by the type.
 *
 * @internal
 */
export function composeDirsDisplay(
  inboundPath: string,
  outboundPath: string | undefined,
): string {
  const inbound = redactPrivateKeyMaterial(inboundPath);
  return outboundPath === undefined
    ? inbound
    : `${inbound} (inbound) and ` +
        `${redactPrivateKeyMaterial(outboundPath)} (outbound)`;
}

// What a caller of the read gate knows about the hello it is asking for: whether
// it was in the directory when this run scanned it, or appeared afterwards. The
// same distinction the bounded ack window is armed on, and for the same reason:
// the entry-present hello is the only one an interrupted run in this directory
// can have left behind, so it is the only one an operator-facing message may
// attribute to residue.
/** @internal */
export type PeerHelloProvenance = "presentAtEntry" | "appearedAfterEntry";

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
// The hello is the only control file with a body, so the gate reads only it
// (the schema is HelloEnvelopeSchema at every call site). The acknowledgment
// marker is a zero-length file matched by name existence, so it needs no gate:
// a zero-byte file has no partial-sync window to guard.
/** @internal */
export async function readControlFileWithGate(
  client: FileTransportClient,
  filePath: string,
  timeToLive: Date,
  pollingFrequency: number,
  schema: z.ZodType<HelloEnvelope>,
  provenance: PeerHelloProvenance,
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
          `control file at ${redactPrivateKeyMaterial(filePath)} has a ` +
            `malformed payload: structure exceeds the permitted bound`,
        );
      // Partial write: body is not valid JSON yet; retry until fully synced.
      await cancellableDelay(pollingFrequency, signal);
      continue;
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new UsageError(
        `control file at ${redactPrivateKeyMaterial(filePath)} has a ` +
          `malformed payload: ${result.error.message}`,
      );
    }
    return result.data;
  } while (Date.now() <= timeToLive.getTime());
  // Deliberately a plain Error, not a UsageError: the pre-sweep retain
  // inspection classifies a UsageError from this gate as terminal (I5b) and
  // anything else as retain-uncertain, so promoting this exhausted-budget throw
  // would turn its bounded read into a hard refusal.
  //
  // Leads with the operative sentence and the recovery step, trailing the path,
  // because each cause-chain link is truncated at the rendered boundary (see
  // sanitizeForDisplay). Both texts are kept short deliberately: the fixed text
  // and the path share one 256-character link, so every character here is one
  // the path does not get, and the path is what the recovery step acts on. The
  // budget each leaves is pinned by a test, not asserted here.
  //
  // Neither text asserts which of the two indistinguishable causes it is
  // looking at, because from here they are indistinguishable: the recovery step
  // is a re-run in both, with removal conditioned on surviving it. Only the
  // entry-present read names residue as the likelier reading -- a hello that
  // appeared after this run's entry scan was written or propagated while the run
  // was watching, so a peer whose publish is still landing explains it at least
  // as well as a leftover does.
  throw new Error(
    provenance === "presentAtEntry"
      ? "peer hello never became readable; it predates this run and may be " +
          "residue. Re-run; remove only if it persists and no session shares " +
          `this path: ${filePath}`
      : "peer hello never became readable; it appeared during this run, so a " +
          "peer may still be publishing. Re-run; remove only if it persists: " +
          `${filePath}`,
  );
}

// Builds a party's hello payload: the two bilateral mode flags it advertises so
// the peer can detect a mismatch and fail fast. Written into the hello body in
// both rendezvous branches. The hello is the only control file with a body; the
// lockless ack is a zero-length marker that carries no flags.
/** @internal */
export function helloEnvelope(flags: {
  locklessRendezvous: boolean;
  retainFiles: boolean;
}): HelloEnvelope {
  return {
    locklessRendezvous: flags.locklessRendezvous,
    retainFiles: flags.retainFiles,
  };
}

// Compares a peer's advertised hello flags against a party's own configuration.
// Returns a BilateralModeMismatchError naming both sides' settings for the
// offending flag, or undefined when both flags match. Called at every site that
// reads a peer hello.
//
// retain_files is compared first because it is the implying flag: the only
// way both flags differ is retain=true/lockless=true vs
// retain=false/lockless=false (retain_files implies lockless_rendezvous), and
// naming the retain_files mismatch lets the operator realign both with a
// single rerun rather than risk the invalid retain=true/lockless=false state.
// A lockless-only divergence (retain matches) still reports lockless.
/** @internal */
export function bilateralMismatch(
  peer: HelloEnvelope,
  own: { locklessRendezvous: boolean; retainFiles: boolean },
): BilateralModeMismatchError | undefined {
  if (peer.retainFiles !== own.retainFiles)
    return new BilateralModeMismatchError(
      `retain_files mismatch: this party has retain_files=` +
        `${own.retainFiles} but the peer has retain_files=` +
        `${peer.retainFiles}; both parties must use the same setting`,
    );
  if (peer.locklessRendezvous !== own.locklessRendezvous)
    return new BilateralModeMismatchError(
      `lockless_rendezvous mismatch: this party has lockless_rendezvous=` +
        `${own.locklessRendezvous} but the peer has ` +
        `lockless_rendezvous=${peer.locklessRendezvous}; both parties must ` +
        `use the same setting`,
    );
  return undefined;
}

// True when `name` is a peer's hello (`<peerId>-hello.json`): it ends with
// HELLO_SUFFIX, recovers a non-empty id (peerIdFromControlName), and that id
// is not the querying party's own. The single definition of "a peer hello"
// shared by the synchronize() entry guard and the in-flight lock/lockless
// rendezvous scans, so "a valid peer hello" means the same thing at every site
// -- in particular a bare `-hello.json` (empty id) is never a peer hello,
// whether it is present at entry or injected mid-rendezvous.
/** @internal */
export function isPeerHelloName(name: string, selfId: string): boolean {
  const id = peerIdFromControlName(name, HELLO_SUFFIX);
  return id !== undefined && id !== selfId;
}

// True when `name` is a peer's joining sentinel (`<peerId>-joining.json`): the
// joining counterpart of isPeerHelloName. A bare `-joining.json` (empty id) is
// rejected, so it is never treated as a real joiner arrival and never starts
// the lock-path joiner-recovery (joinerRecoveryMs) window.
/** @internal */
export function isPeerJoiningName(name: string, selfId: string): boolean {
  const id = peerIdFromControlName(name, JOINING_SUFFIX);
  return id !== undefined && id !== selfId;
}

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

// Bounds every RENDEZVOUS-time peer-hello read through the same I5a gate, for
// the same reason the inspection bounds its own: the gate retries a body it
// cannot resolve until its deadline, so handing it the full peer timeout lets a
// single unresolvable hello -- a torn or empty leftover from a crashed prior run
// -- hold the entire budget in every mode.
//
// Three times the inspection's cycles, because this read races a peer that is
// actively publishing rather than inspecting a stale directory, so it must
// absorb a full publish propagation on a sync-mediated transport and not merely
// flush jitter. It is not larger still because the hello is published
// temp-then-rename: the final name appears only at the atomic rename, so the
// body is complete before the name is visible and what remains is propagation,
// never a write in progress.
const RENDEZVOUS_HELLO_READ_POLL_CYCLES = 6;

// Floor under every rendezvous-time bound this module derives from poll cycles.
//
// The poll interval is how often this party LOOKS; it says nothing about how
// long the transport takes to ANSWER, and the two are independent. An operator
// polling a high-latency server every 20 ms has a cadence three orders of
// magnitude below its round trip, and a bound counted purely in cycles then
// expires inside a single one: measured against two live connections, a 6-cycle
// bound aborted a genuinely live partner mid-round-trip in under a second and
// prescribed deleting its hello. This party cannot measure the round trip
// itself either -- the slow side is the PARTNER, whose operations it never
// observes -- so the floor is wall-clock, not adaptive.
//
// joinerRecoveryMs is that wall-clock quantity, already: it is what the lock
// path allows for a peer's publish-and-rename to land on this transport, which
// is the same wait these bounds are absorbing. Reusing it keeps one knob for one
// question rather than a second constant to tune. Neither bound below extends a
// wait past what the operator configured: the I5a hello-read bound stays capped
// at the remaining peer budget, while the entry-hello window is armed only
// while it fits strictly inside that budget rather than capped to it -- on a
// budget too small to hold the floor, the ordinary peer timeout fires instead,
// with its ordinary message.
const rendezvousBoundMs = (
  options: RendezvousOptions,
  pollCycles: number,
): number =>
  Math.max(pollCycles * options.pollingFrequency, options.joinerRecoveryMs);

// The near-future deadline a rendezvous-time hello read is given, capped at the
// remaining peer budget so it is never longer than the operator asked for.
// open() sets timeToLive before synchronize() runs, so the non-null assertion is
// safe at every call site.
const helloReadDeadline = (options: RendezvousOptions): Date =>
  new Date(
    Math.min(
      Date.now() +
        rendezvousBoundMs(options, RENDEZVOUS_HELLO_READ_POLL_CYCLES),
      options.timeToLive!.getTime(),
    ),
  );

// Classifies the hello a rendezvous-time read is about against the at-most-one
// hello the entry scan found, so no call site has to reason about which of its
// branches a leftover can reach: a site the entry-present hello cannot reach
// passes an undefined entryPeerHello and classifies as appearedAfterEntry by
// the comparison rather than by an assertion in a comment.
const peerHelloProvenance = (
  name: string,
  entryPeerHello: string | undefined,
): PeerHelloProvenance =>
  name === entryPeerHello ? "presentAtEntry" : "appearedAfterEntry";

// How long a peer hello that was ALREADY PRESENT at entry gets to acknowledge
// this party's hello before rendezvous fails terminally, as a fraction of the
// operator's own remaining peer budget (with the floor below). Deriving it from
// that budget rather than fixing a constant keeps it never longer than the
// operator asked for and scales it with the transport they configured. An eighth
// leaves seven eighths of the budget for the exchange proper and is still orders
// of magnitude above any plausible rendezvous round trip: 7 m 30 s at the
// default one-hour budget, against the full hour this replaces on every
// invocation of an unattended re-run.
//
// This is the one bound the design left to be tuned. It, the cycle count below,
// and the wall-clock floor rendezvousBoundMs applies are the only three places
// to change it.
const ENTRY_HELLO_ACK_WINDOW_FRACTION = 1 / 8;

// Floor under that window, in poll cycles, so a fast transport (or a small
// configured budget) cannot abort inside a single round trip: this party's hello
// must reach the peer and the peer's ack must come back, each at the configured
// cadence. Carried through rendezvousBoundMs, so the wall-clock floor documented
// there applies to this window too -- which is what stops it aborting a live
// partner whose round trip outruns the poll cadence.
const ENTRY_HELLO_ACK_WINDOW_MIN_POLL_CYCLES = 6;

// The instant an entry-present peer hello stops being given the benefit of the
// doubt, or undefined when the window cannot fit strictly inside the remaining
// budget -- the ordinary peer timeout then fires instead, with its ordinary
// message.
//
// The guarantee that the deadline never reaches the peer timeout is carried by
// strict arming, not by which clock reading the window is measured from:
// arming requires windowMs strictly less than the remaining budget, so
// now + windowMs stays strictly inside that budget even if now were read a
// second time -- a later reading only shrinks the remaining budget the window
// is checked against, which tightens the bound rather than loosening it. The
// caller passes the clock sample the deadline is measured from rather than
// this taking its own as supporting hygiene on top of that guarantee: it keeps
// the window and the budget it is weighed against visibly one reading, rather
// than two a reader has to work through the strict-arming argument to trust.
const entryHelloAckDeadline = (
  options: RendezvousOptions,
  now: number,
): number | undefined => {
  const remaining = options.timeToLive!.getTime() - now;
  const windowMs = Math.max(
    rendezvousBoundMs(options, ENTRY_HELLO_ACK_WINDOW_MIN_POLL_CYCLES),
    remaining * ENTRY_HELLO_ACK_WINDOW_FRACTION,
  );
  return windowMs < remaining ? now + windowMs : undefined;
};

// The longest filename the protocol's own constructors build from UUID
// identities: a retain-mode message ack over a timestamped message at the
// maximum frame size, with a three-digit counter. Computed by calling those two
// constructors, so it follows a change to either name shape instead of
// restating one. The nil UUID stands in for the two identities: only their
// length reaches this arithmetic, and it carries the canonical UUID text length
// without drawing randomness at module load.
//
// Reserved out of the detail link's budget for the enumeration before the
// directory scope is fitted, so an operator-chosen path cannot crowd the names
// out. A name built from a longer identity -- a configured `peer_id`, or a
// session past message 999 -- may still not fit; it is then counted rather than
// shown. That the reservation really does show a constructor-built name whole is
// pinned by a test that builds the shape from those same constructors.
const ENTRY_GUARD_NAME_BUDGET_FLOOR = renderedDisplayCost(
  ackMarkerName(
    NIL_UUID,
    messageFilename({
      id: NIL_UUID,
      timestampInFilename: true,
      byteCount: MAX_FRAME_SIZE_BYTES,
      seq: 999,
      ts: 0,
    }).slice(0, -".json".length),
  ),
);

const andMoreSuffix = (count: number): string => ` (and ${count} more)`;

// Composes a strict-empty entry-guard refusal: `refusalAndRecovery` -- the
// sentence naming what is wrong and the step that clears it -- becomes the
// error's own message, and the directory scope plus the offending filenames
// become a `cause` link of its own. Both refusals are built here so the shape
// they share cannot drift.
//
// The split is what the display boundary forces. sanitizeErrorForDisplay caps
// EACH link of a rendered cause chain independently, and it truncates before the
// links are joined, so one link would have to carry the refusal, the recovery
// step, an operator-chosen directory path, and a list of filenames inside a
// single budget -- with the path and the names, the two parts nothing here
// bounds, competing against the two the operator has to read. Giving the detail
// its own link gives it a second budget, and leaves the first carrying only
// fixed text. What each message actually measures at the rendered boundary is
// pinned by a test rather than claimed here.
//
// The detail link is fitted to DEFAULT_MAX_DISPLAY_LENGTH rather than to the
// wider link budget the renderer allows: what it carries is a chooser's own
// values, and the per-value cap is the size those are budgeted at everywhere
// else. Fitting under the renderer's cap is always safe -- it is a ceiling, not
// a quota -- and spending the whole of it on an enumeration of partner-chosen
// names would be the opposite of what partitioning by chooser is for.
//
// The enumeration is bounded by that budget rather than by a count: a protocol
// filename runs from roughly 47 characters (a uuid-id hello) to
// ENTRY_GUARD_NAME_BUDGET_FLOOR, so any fixed count either spends less of the
// budget than it could or overruns it. Each name is fit-checked on its own and
// in listing order; one that does not fit is skipped and the next is tested, so
// a single long name cannot suppress the shorter ones behind it. A name that
// does not fit is counted rather than shown, because a name the cap chopped
// reads like a whole name the operator could go and delete.
//
// The names and the directory scope are partner-controlled and are redacted
// here, so a name shaped like a PEM header is replaced where it stands instead
// of taking the count, the scope and the names behind it with it (see
// redactPrivateKeyMaterial). Redacting before the fit loop spends the budget on
// what the operator is actually shown, and the replacement is shorter than the
// shortest marker it can stand in for, so it never widens a fitted name.
const entryGuardRefusal = (
  refusalAndRecovery: string,
  kindPlural: string,
  rawDirsDisplay: string,
  rawNames: string[],
): UsageError => {
  const dirsDisplay = redactPrivateKeyMaterial(rawDirsDisplay);
  const names = rawNames.map(redactPrivateKeyMaterial);
  const head = `${names.length} ${kindPlural} in `;
  // The floor plus the widest count suffix the enumeration can end on, held
  // back before the directory scope is fitted.
  const namesFloor =
    ENTRY_GUARD_NAME_BUDGET_FLOOR +
    (names.length > 1
      ? renderedDisplayCost(andMoreSuffix(names.length - 1))
      : 0);
  const dirs = clipToRenderedCost(
    dirsDisplay,
    DEFAULT_MAX_DISPLAY_LENGTH -
      renderedDisplayCost(head) -
      renderedDisplayCost(": ") -
      namesFloor,
  );
  const prefix = `${head}${dirs}: `;
  const namesBudget = DEFAULT_MAX_DISPLAY_LENGTH - renderedDisplayCost(prefix);
  let listed = "";
  let listedCost = 0;
  let shown = 0;
  // `remaining` is what the count suffix would say if this name were the last
  // one shown, so the width reserved on the iteration that admits the final name
  // is exactly the width the enumeration ends on, and every earlier iteration
  // reserves at least it -- skipping a name only lowers the final count.
  for (const name of names) {
    const candidate = shown === 0 ? name : `, ${name}`;
    const remaining = names.length - shown - 1;
    const cost =
      listedCost +
      renderedDisplayCost(candidate) +
      (remaining > 0 ? renderedDisplayCost(andMoreSuffix(remaining)) : 0);
    if (cost > namesBudget) continue;
    listed += candidate;
    listedCost += renderedDisplayCost(candidate);
    shown += 1;
  }
  const omitted = names.length - shown;
  return new UsageError(refusalAndRecovery, {
    cause: new Error(
      shown === 0
        ? `${prefix}name(s) too long to display`
        : omitted > 0
          ? `${prefix}${listed}${andMoreSuffix(omitted)}`
          : `${prefix}${listed}`,
    ),
  });
};

// The rendezvous-relevant subset of the connection's Options, read live through
// the deps `options` accessor. The connection's full Options is a superset, so
// `() => this.options` satisfies this; naming only what the coordinator reads
// keeps the seam's dependency on the connection's config explicit and narrow.
/** @internal */
export interface RendezvousOptions {
  timeToLive?: Date;
  pollingFrequency: number;
  locklessRendezvous: boolean;
  retainFiles: boolean;
  sweepExchangeFiles: boolean;
  forceRetainSweep: boolean;
  joinerRecoveryMs: number;
}

// The connection-owned state the coordinator reads and writes across the seam.
// Three kinds:
//   - SHARED OBJECT REFERENCES (never copies): responsibleFiles and
//     foreignFileSnapshot are the same Set instances poll()/cleanup()/close()
//     hold, so every add/delete/clear/forEach here is observed there.
//   - LIVE ACCESSORS (read fresh per call, never hoisted): signal/wait/role/id/
//     client/outbound/log/options/peerId/handshakeRole. signal() in particular
//     must not be cached: the connection swaps its AbortController per session,
//     so a concurrent close() abort has to reach an in-flight rendezvous wait.
//   - FIELD-BACKED SETTERS AND DELEGATES: setRole/setPeerId/setHandshakeRole
//     commit identity in place at the current commit sites; resetSessionState,
//     clearAbortMarker, and writeAck forward to the connection.
/** @internal */
export interface RendezvousDeps {
  responsibleFiles: Set<string>;
  foreignFileSnapshot: Set<string>;
  client: () => FileTransportClient;
  id: () => string;
  role: () => string;
  outbound: () => string | undefined;
  log: () => ReturnType<typeof getLoggerForVerbosity>;
  options: () => RendezvousOptions;
  signal: () => AbortSignal;
  wait: (ms: number) => Promise<void>;
  peerId: () => string | undefined;
  handshakeRole: () => HandshakeRole | undefined;
  setRole: (role: string) => void;
  setPeerId: (peerId: string | undefined) => void;
  setHandshakeRole: (role: HandshakeRole | undefined) => void;
  // Records the peer hello found in the directory at entry, and clears it (with
  // undefined) at the first observation attributable to a LIVE peer. The
  // connection exposes the surviving value so a consumer can distinguish "a peer
  // completed the rendezvous and then went silent" from "this run rendezvoused
  // against a hello nothing has confirmed", which the entry-time directory
  // contents are the only local evidence for.
  setEntryPeerHello: (name: string | undefined) => void;
  resetSessionState: () => void;
  clearAbortMarker: () => void;
  writeAck: (dir: string, originalName: string) => Promise<string>;
}

/**
 * The stateful file-sync rendezvous negotiation as a coordinator
 * {@link FileSyncConnection} composes. It owns no durable state: it reads the
 * connection's identity/config through {@link RendezvousDeps} accessors and
 * writes role/peerId/handshakeRole back through its setters at the commit sites,
 * mutating the connection's responsibleFiles/foreignFileSnapshot Sets by shared
 * reference. The protocol is specified in docs/spec/FILE_SYNC.md and
 * docs/spec/CHANNEL_SECURITY.md.
 *
 * @internal
 */
export class FileSyncRendezvous {
  constructor(private readonly deps: RendezvousDeps) {}

  /**
   * Negotiates rendezvous with the peer: scans and classifies the entry
   * directory, then dispatches to the lock-joiner fast-path or the symmetric
   * hello-exchange. The connection's public synchronize() validates entry and
   * threads the resulting {@link RendezvousScope} here.
   */
  async run(scope: RendezvousScope): Promise<void> {
    const { deps } = this;

    // Scan and classify the entry directory (sweep orphaned temps and leftover
    // abort markers, snapshot foreign files, then sweep-or-reject unexpected
    // protocol files). Yields the at-most-one tolerated peer hello.
    const peerHellos = await this.scanEntryDirectory(scope);

    // This party's own hello is a self-write, so it goes to the outbound
    // directory; the peer reads it from its inbound (which is this outbound). In
    // shared mode outboundPath === inboundPath. The lock-mode branches that also
    // reference helloPath only run in shared mode (split requires retain, which
    // requires lockless), so routing it through outbound is correct there too.
    const helloPath = `${scope.outboundPath}/${deps.id()}${HELLO_SUFFIX}`;

    // The at-most-one peer hello that PREDATED this run. It is the only hello
    // whose writer has already demonstrated a propagation leg, and equally the
    // only one that can be residue of an interrupted run in this directory --
    // the two are indistinguishable on disk, which is why both the bounded
    // window below and the connection's unconfirmed-hello fact are armed on this
    // case alone. A hello that appears AFTER entry is an ordinary peer arriving.
    const entryPeerHello =
      peerHellos.length === 1 ? peerHellos[0].name : undefined;
    deps.setEntryPeerHello(entryPeerHello);

    if (peerHellos.length === 1 && !deps.options().locklessRendezvous) {
      await this.rendezvousAsLockJoiner(scope, peerHellos[0], helloPath);
    } else {
      await this.rendezvousViaHelloExchange(scope, helloPath, entryPeerHello);
    }
  }

  // Publishes this party's hello temp-then-rename, the discipline every other
  // payload-bearing publish already follows (the message write in send(), the
  // ack in writeAck(), and the joiner's own sentinel): the final
  // `<id>-hello.json` appears only at the atomic rename, so no reader can ever
  // observe it torn. A hard kill mid-write then leaves a `temp-hello-<uuid>.tmp`
  // -- inert, and tolerated by the next entry scan -- rather than an empty or
  // half-written hello under its final name, which the I5a read gate would
  // retry against for its whole budget in every mode.
  //
  // The in-flight temp is swept inline on failure (best-effort safeDelete),
  // never tracked in responsibleFiles, matching send()/writeAck(). The CALLER
  // tracks the final name immediately after this resolves, with no throwable
  // statement between it and the rename (I4a).
  private async publishHello(dir: string, helloPath: string): Promise<void> {
    const { deps } = this;
    const tempPath = `${dir}/${helloTempName()}`;
    try {
      await deps
        .client()
        .put(serializeEnvelope(helloEnvelope(deps.options())), tempPath, {
          flags: "w",
          encoding: "utf-8",
        });
      await deps.client().rename(tempPath, helloPath);
    } catch (err: unknown) {
      await deps.client().safeDelete(tempPath);
      throw err instanceof Error ? err : new Error(errorMessage(err));
    }
  }

  // Pre-sweep retain-signal inspection followed by the protocol-file sweep for
  // --sweep-exchange-files. Deletes every protocol-grammar file (this party's
  // and the peer's: hellos, locks, joining sentinels, acks, messages) so
  // rendezvous can start against a clean slate -- but only after confirming the
  // directory is not a retain-mode audit transcript. The only retain-mode
  // deletion that reaches a hello is the terminal rendezvous failure's rollback
  // of this party's own artifacts (I4b), and a rendezvous that failed
  // terminally produced no exchange -- so a retain directory holding a
  // transcript still carries the hello of the party that wrote it (signal b
  // below), and a directory whose hello that rollback removed holds nothing the
  // inspection has to protect. The one gap is a peer-less, self-started retain
  // half-start whose process died before the rollback ran, re-run in delete mode
  // under that same peer_id: the body read covers only PEER hellos, so a
  // leftover SELF hello is caught only by local retain mode (signal:
  // options.retainFiles) -- which a delete-mode re-run does not set. That loses
  // only this operator's own abandoned half-start, not a two-party transcript.
  // The inspection checks signals with DIFFERENT coverage:
  //   (a) a retain-only message ack (isRetainMessageAck) -- a filename-only,
  //       body-free signal. Strictly additive: it does not cover an
  //       early-rendezvous retain peer that has written no message ack yet.
  //   (b) the peer hello's `retain_files` flag, read through the I5a gate. This
  //       is the load-bearing signal -- a retain party carries its hello from
  //       the moment it writes it, so a live peer is covered mid-rendezvous,
  //       before any message ack exists. The read is bounded
  //       (RETAIN_INSPECTION_POLL_CYCLES, never peer_timeout_ms) so a
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
    const { deps } = this;
    // The directory scope this sweep touches, for operator-facing messages: in
    // split mode the sweep deletes from BOTH directories (peer leftovers in
    // inbound, this party's own leftovers in outbound), so name both; in shared
    // mode it collapses to the inbound display path.
    const dirsDisplay = composeDirsDisplay(inboundPath, deps.outbound());

    const signals: string[] = [];
    let retainUncertain = false;

    if (deps.options().retainFiles)
      signals.push("this party is in retain mode");

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
      signals.push(`a retain-mode message ack (${messageAck.file.name})`);

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
          RETAIN_INSPECTION_POLL_CYCLES * deps.options().pollingFrequency,
      );
      for (const hello of peerHellos) {
        try {
          const envelope = await readControlFileWithGate(
            deps.client(),
            `${inboundPath}/${hello.name}`,
            inspectionDeadline,
            deps.options().pollingFrequency,
            HelloEnvelopeSchema,
            // These hellos are the entry scan's own listing.
            "presentAtEntry",
            deps.signal(),
          );
          if (envelope.retainFiles) {
            signals.push(
              `peer hello ${hello.name} advertises retain_files=true`,
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
          if (deps.signal().aborted) throw err;
          // Stop at the first unreadable hello: uncertainty is sticky and
          // already forces refuse (bare flag) or the danger warning (force), so
          // further reads cannot change the outcome and only add latency.
          retainUncertain = true;
          break;
        }
      }
    }

    const retainInPlay = signals.length > 0 || retainUncertain;

    if (retainInPlay && !deps.options().forceRetainSweep) {
      // Prefer a concrete signal in the diagnostic: retainUncertain can coexist
      // with a definitive one (an earlier hello read failed, a later resolved to
      // retain_files=true), and the concrete cause is the more useful report.
      const reason =
        signals.length > 0
          ? signals.join("; ")
          : "a peer hello body that did not resolve within the inspection " +
            "budget (retain-uncertain)";
      throw new UsageError(
        `path ${redactPrivateKeyMaterial(dirsDisplay)} shows a retain-mode ` +
          `signal (${redactPrivateKeyMaterial(reason)}), so ` +
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

    // Entry-time logs use the party id, not the role: the sweep runs before
    // rendezvous, so the role is still the "unknown role" sentinel. For the
    // destructive-wipe warning especially, the party id is the useful identifier.
    if (retainInPlay && deps.options().forceRetainSweep)
      deps
        .log()
        .warn(
          `[${deps.id()}] --force-retain-sweep: permanently deleting a ` +
            `retain-mode audit transcript (${toDelete.length} protocol file(s)) ` +
            `in ${redactAndSanitizeForDisplay(dirsDisplay)}. This is destructive and ` +
            `irreversible; the prior ` +
            "transcript will be lost. Only use --force-retain-sweep when you " +
            "intend to discard it.",
        );

    // A close() may have raced the inspection; do not dispatch deletes against a
    // tearing-down client. Propagate the abort reason (ConnectionClosedError) so
    // it classifies as a clean shutdown (exit 69), not a delete transport error.
    if (deps.signal().aborted) throw deps.signal().reason;

    deps
      .log()
      .info(
        `[${deps.id()}] sweeping ${toDelete.length} protocol file(s) at ` +
          `${redactAndSanitizeForDisplay(dirsDisplay)} (--sweep-exchange-files): ` +
          `${toDelete.map((f) => redactAndSanitizeForDisplay(f.name)).join(", ")}`,
      );
    // allSettled, not all: await every delete before reporting, so a single
    // rejection does not leave the others running unobserved while synchronize()
    // unwinds. The directory then reaches a known (fully-attempted) state and the
    // error names all failures. A delete failure is a transport error (exit 69),
    // never a UsageError. The non-atomicity caveat above still holds: a live peer
    // could write between the listing and these deletes.
    const results = await Promise.allSettled(
      toDelete.map((entry) =>
        deps.client().delete(`${entry.dir}/${entry.name}`),
      ),
    );
    // Name and transport error are partner- or server-controlled and sit ahead
    // of the "partially swept" warning and the re-run step in this one link (see
    // redactPrivateKeyMaterial).
    const failures = results.flatMap((result, i) =>
      result.status === "rejected"
        ? [
            `${redactPrivateKeyMaterial(toDelete[i].name)} ` +
              `(${redactPrivateKeyMaterial(errorMessage(result.reason))})`,
          ]
        : [],
    );
    if (failures.length > 0)
      throw new Error(
        `--sweep-exchange-files failed to delete ${failures.length} of ` +
          `${toDelete.length} protocol file(s) at ` +
          `${redactPrivateKeyMaterial(dirsDisplay)}: ` +
          `${failures.join("; ")}. The directory may be partially swept; ` +
          "resolve the transport error and re-run.",
      );
  }

  // Scans and classifies the entry directory before rendezvous: sweeps orphaned
  // in-flight temp writes and leftover abort markers, snapshots foreign files,
  // and either sweeps every protocol file (--sweep-exchange-files) or rejects
  // any unexpected protocol file. Returns the at-most-one tolerated peer hello.
  private async scanEntryDirectory(
    scope: RendezvousScope,
  ): Promise<Array<FileInfo>> {
    const { deps } = this;
    const { inboundPath, outboundPath, split, dirsDisplay } = scope;

    // Reset the foreign-file snapshot up front so it is rebuilt fresh on every
    // synchronize() entry even when the list() below throws: a failed entry must
    // not leave a prior session's snapshot behind for a same-instance retry.
    deps.foreignFileSnapshot.clear();

    let files: Array<FileInfo>;
    try {
      files = await deps.client().list(inboundPath);
    } catch (err: unknown) {
      throw err instanceof Error ? err : new Error(errorMessage(err));
    }
    const fileNames = files.map((file) => file.name);
    deps
      .log()
      .trace(
        `[${deps.role()}] found ${files.length} file(s)` +
          `${
            files.length > 0
              ? `: ${fileNames.map((n) => redactAndSanitizeForDisplay(n)).join(", ")}`
              : ""
          }`,
      );
    if (!deps.options().retainFiles)
      deps.responsibleFiles.forEach((fileName) => {
        if (!fileNames.includes(fileName))
          deps.responsibleFiles.delete(fileName);
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
    // in-flight temp-*.tmp -- a write hard-killed between the temp put() and the
    // rename to its final name. Both temp shapes land in `ignored` below and so
    // never abort entry, but they are disposed of differently: a message or ack
    // temp (temp-<uuid>.tmp) is swept, a hello temp (temp-hello-<uuid>.tmp) is
    // left alone. See the two blocks below for why the sweep does not extend to
    // the hello shape. `ignored` is the sanctioned extension point for kinds
    // that may legitimately pre-exist as the protocol grows; the foreign-file
    // snapshot below is a sibling tolerance mechanism for grammar-failing names.
    // A peer hello is `<peerId>-hello.json` with a non-empty id that is not our
    // own (isPeerHelloName). A bare `-hello.json` slices to an empty id and is
    // therefore NOT a peer hello: it still matches the grammar
    // (isProtocolGrammarName), so it falls into unexpectedProtocol below, is
    // rejected at the no-flag guard, and is swept under --sweep-exchange-files,
    // rather than being tolerated as a phantom peer. The in-flight rendezvous
    // scans share the same predicate so a mid-flight injection is rejected too.
    const ignored = new Set<string>();

    // Sweep orphaned in-flight temp writes left by a prior crashed exchange.
    // Match ONLY the protocol's own message/ack temp shape, temp-<uuidv4()>.tmp
    // (isProtocolTempName minus isHelloTempName), which send()/writeAck()
    // produce -- never a final <id>.json message (in retain mode the directory is
    // intentionally full of *.json (the transcript), which can never match
    // `.tmp`), and never a FOREIGN temp-*.tmp whose stem is not a v4 UUID (a
    // user/sync-tool `temp-export.tmp`), which falls through to the foreign-file
    // snapshot below and is tolerated rather than destroyed in a namespace
    // collision. Delete each with the non-throwing safeDelete, then add its name
    // to `ignored` so the already-taken `files` snapshot does not re-trip the
    // guard below on a name we just removed.
    //
    // Sweeping unconditionally is licensed by these two shapes being orphaned by
    // construction: writing either requires having already seen this party's
    // hello, which is published only after this scan (the ordering is pinned by
    // a test), so no live in-flight write of either can race this delete.
    //
    // The delete is best-effort and the `ignored` add is unconditional (it does
    // not branch on the delete's outcome): a safeDelete that silently fails (a
    // transport error, swallowed by contract) leaves the temp on disk, but entry
    // must still proceed past it (a stale temp is benign) and the next exchange's
    // entry re-runs this same sweep, so the litter is self-healing rather than
    // permanent. Tracking the orphan in `responsibleFiles` would not help: its
    // writer already died, so that process's cleanup() never runs -- which is the
    // whole reason this rendezvous-time sweep exists.
    const orphanedTempFiles = files.filter(
      (file) => isProtocolTempName(file.name) && !isHelloTempName(file.name),
    );
    if (orphanedTempFiles.length > 0) {
      // Single breadcrumb: a process died mid-write here. Entry is not aborted
      // on its account, but the prior crash is worth surfacing.
      deps
        .log()
        .info(
          `[${deps.id()}] sweeping ${orphanedTempFiles.length} orphaned temp ` +
            "file(s) left by a prior crashed exchange: " +
            `${orphanedTempFiles
              .map((f) => redactAndSanitizeForDisplay(f.name))
              .join(", ")}`,
        );
      await Promise.all(
        orphanedTempFiles.map((file) =>
          deps.client().safeDelete(`${inboundPath}/${file.name}`),
        ),
      );
      orphanedTempFiles.forEach((file) => ignored.add(file.name));
    }

    // A hello temp is tolerated in place, never swept: publishing a hello
    // requires nothing from this party, so a peer that started at the same
    // instant can have one in flight in this very listing, and deleting it would
    // break that peer's rename and fail its exchange. This party's own crash
    // residue takes the same disposition -- the two are indistinguishable by
    // name -- so a hello temp survives entry as inert litter: it matches the
    // grammar (so it is never counted as a foreign file), the mid-loop scan
    // recognizes it, and no reader ever opens it. `--sweep-exchange-files` does
    // not reach it either: the flag clears protocol files whose deletion the
    // operator's no-concurrent-session assertion covers, and a temp is not one
    // of the durable protocol files that assertion is about.
    const helloTempFiles = files.filter((file) => isHelloTempName(file.name));
    if (helloTempFiles.length > 0) {
      deps
        .log()
        .info(
          `[${deps.id()}] tolerating ${helloTempFiles.length} in-flight hello ` +
            "publish(es) left in place (a concurrently starting peer's write, " +
            "or residue from a prior crashed publish): " +
            `${helloTempFiles
              .map((f) => redactAndSanitizeForDisplay(f.name))
              .join(", ")}`,
        );
      helloTempFiles.forEach((file) => ignored.add(file.name));
    }

    // All three classifications exclude `ignored`, kept symmetric with the two
    // filters below so a future `ignored` entry that could pass isPeerHelloName
    // is not silently reclassified.
    let peerHellos = files.filter(
      (file) =>
        !ignored.has(file.name) && isPeerHelloName(file.name, deps.id()),
    );

    // Recognize-and-sweep leftover authenticated abort markers, mirroring the
    // orphaned-temp sweep above (safeDelete + add to `ignored` so the name never
    // reaches the directory-clean check). Every authenticated terminal failure
    // leaves a `<writerId>-abort.json` -- it must persist for the peer to read --
    // so a subsequent exchange reusing the directory would otherwise find it and
    // reject "directory not clean", turning a transient failure into a blocked
    // directory. Both parties retry under FRESH ids, so on the case that matters
    // the leftover is named by neither of them nor by either hello; the sweep
    // therefore matches any WELL-FORMED marker, whichever id wrote it -- the
    // `<id>-abort.json` grammar with a non-empty recovered id, sliced by the same
    // peerIdFromControlName every other control-name site routes through. A bare
    // `-abort.json` recovers no id, is attributable to no party, and stays an
    // unexpected protocol file under the normal policy; a name that fails the
    // grammar is foreign and is never touched here.
    //
    // Sweeping a marker no id in this session names is safe because at entry no
    // marker can BELONG to this session: a marker is written only post-handshake,
    // and a party cannot reach post-handshake before its peer has passed this
    // same entry scan, so a marker visible here is necessarily residue of a prior
    // session, whose token cannot authenticate under this session's key. The
    // residual is a directory a live peer is still using in violation of
    // directory exclusivity: sweeping there costs that peer its fast-fail and
    // drops it back to the peer-silence timeout, a limit stated in
    // docs/spec/FILE_SYNC.md.
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
    // rather than aborting on a transient hiccup. Such a leftover is benign: the
    // next exchange's entry re-runs this sweep over it under whatever ids that
    // exchange draws, and it cannot forge a PeerAbortError in a later session
    // because verifyPeerAbortMarker authenticates the marker's token against that
    // session's HKDF-derived peer token, which a stale marker from a prior
    // session's key cannot satisfy.
    if (!deps.options().retainFiles) {
      const leftoverAbortFiles = files.filter(
        (file) =>
          !ignored.has(file.name) &&
          peerIdFromControlName(file.name, ABORT_SUFFIX) !== undefined,
      );
      if (leftoverAbortFiles.length > 0) {
        deps
          .log()
          .info(
            `[${deps.id()}] sweeping ${leftoverAbortFiles.length} leftover abort ` +
              "marker(s) from a prior failed exchange: " +
              `${leftoverAbortFiles
                .map((f) => redactAndSanitizeForDisplay(f.name))
                .join(", ")}`,
          );
        await Promise.all(
          leftoverAbortFiles.map((file) =>
            deps.client().safeDelete(`${inboundPath}/${file.name}`),
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
          !isPeerHelloName(file.name, deps.id()) &&
          isProtocolGrammarName(file.name),
      )
      .map((file) => ({ file, dir: inboundPath }));

    // Foreign-file snapshot (always, both modes, flag or not). Cleared at entry
    // above and populated here; it deletes nothing, so it is safe in retain mode
    // where sync-mediated conflict copies are expected noise. Feeds the poll
    // loop's isRecognizedLoopFile so these names are tolerated and the "new
    // foreign file" warning measures only names that appear after entry.
    foreignFiles.forEach((file) => deps.foreignFileSnapshot.add(file.name));
    if (foreignFiles.length > 0)
      deps
        .log()
        .info(
          `[${deps.id()}] tolerating ${foreignFiles.length} foreign file(s) ` +
            `present at entry in ${redactAndSanitizeForDisplay(scope.inboundPath)}: ` +
            `${foreignFiles.map((f) => redactAndSanitizeForDisplay(f.name)).join(", ")}`,
        );

    // Split mode: the OUTBOUND directory must be as fresh as the inbound one --
    // retain mode's fresh-directory precondition applies to both halves (a stale
    // self message or ack here would otherwise corrupt the send/ack gate). Peer
    // files never land in outbound (the peer writes to its own outbound, which
    // is THIS party's inbound), so every protocol-grammar file is this party's
    // own leftover from a crashed prior session: an orphaned temp is swept
    // (best-effort safeDelete), a foreign file is snapshotted and tolerated, and
    // any other protocol file is collected as unexpected (rejected by the
    // clean-start guard, or swept under --sweep-exchange-files) exactly as on the
    // inbound side. That same "no peer file lands here" routing rule is why the
    // sweep covers BOTH temp shapes here while the inbound one exempts the hello
    // shape: a hello temp in this directory can only be this party's own.
    if (split) {
      const outFiles = await deps.client().list(outboundPath);
      const outOrphans = outFiles.filter((file) =>
        isProtocolTempName(file.name),
      );
      if (outOrphans.length > 0) {
        deps
          .log()
          .info(
            `[${deps.id()}] sweeping ${outOrphans.length} orphaned temp file(s) ` +
              "left by a prior crashed exchange in the outbound directory " +
              `${redactAndSanitizeForDisplay(outboundPath)}: ` +
              `${outOrphans.map((f) => redactAndSanitizeForDisplay(f.name)).join(", ")}`,
          );
        await Promise.all(
          outOrphans.map((file) =>
            deps.client().safeDelete(`${outboundPath}/${file.name}`),
          ),
        );
      }
      const sweptOut = new Set(outOrphans.map((file) => file.name));
      const outForeign: FileInfo[] = [];
      for (const file of outFiles) {
        if (sweptOut.has(file.name)) continue;
        if (!isProtocolGrammarName(file.name)) {
          deps.foreignFileSnapshot.add(file.name);
          outForeign.push(file);
        } else {
          unexpectedProtocol.push({ file, dir: outboundPath });
        }
      }
      if (outForeign.length > 0)
        deps
          .log()
          .info(
            `[${deps.id()}] tolerating ${outForeign.length} foreign file(s) ` +
              `present at entry in the outbound directory ` +
              `${redactAndSanitizeForDisplay(outboundPath)}: ` +
              `${outForeign.map((f) => redactAndSanitizeForDisplay(f.name)).join(", ")}`,
          );
    }

    if (deps.options().sweepExchangeFiles) {
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
      // terminal usage error pointing at the opt-in sweep.
      if (unexpectedProtocol.length > 0)
        throw entryGuardRefusal(
          "the exchange directory must be empty except for a single peer " +
            "hello, but holds unexpected protocol files. Remove them after " +
            "confirming no other session is using this path, or re-run with " +
            "--sweep-exchange-files to clear every protocol file.",
          "unexpected protocol file(s)",
          // dirsDisplay names both halves in split mode: unexpectedProtocol can
          // carry outbound leftovers as well as inbound ones, so directing the
          // operator at the inbound path alone would mislead.
          dirsDisplay,
          unexpectedProtocol.map((e) => e.file.name),
        );

      if (peerHellos.length > 1)
        throw entryGuardRefusal(
          "only one peer may share a rendezvous directory, but multiple peer " +
            "hello files are present -- are there other sessions using this " +
            "path?",
          "peer hello files",
          scope.inboundPath,
          peerHellos.map((f) => f.name),
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
    scope: RendezvousScope,
    peerHello: FileInfo,
    helloPath: string,
  ): Promise<void> {
    const { deps } = this;
    const otherFile = peerHello;
    const otherPath = `${scope.inboundPath}/${otherFile.name}`;
    const peerId = otherFile.name.slice(0, -HELLO_SUFFIX.length);

    deps
      .log()
      .debug(
        `[joiner] arriving via ${deps.id()}${JOINING_SUFFIX} sentinel, ` +
          `deleting discovered ${redactAndSanitizeForDisplay(otherFile.name)}`,
      );

    // I5: read the peer hello body through the partial-sync gate before
    // deleting it, validating the two required bilateral flags. Bounded by
    // helloReadDeadline, so a hello that never resolves fails here instead of
    // holding the peer budget.
    const peerEnvelope = await readControlFileWithGate(
      deps.client(),
      otherPath,
      helloReadDeadline(deps.options()),
      deps.options().pollingFrequency,
      HelloEnvelopeSchema,
      // This fast path exists only for the hello the entry scan found.
      "presentAtEntry",
      deps.signal(),
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
    const mismatch = bilateralMismatch(peerEnvelope, deps.options());
    if (mismatch) {
      // Advertise our own hello so the lockless peer reads it and fails
      // symmetrically. This is the one mismatch site that needs a NEW write at
      // detection time, so it is the single point of asymmetric failure in the
      // symmetric-detection guarantee: if the put fails at exactly this moment
      // there is no durable advertisement for the peer to read -- whatever the
      // write order -- and the peer degrades to the peer-timeout. Retry
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
          await this.publishHello(scope.outboundPath, helloPath);
          break;
        } catch (writeErr: unknown) {
          // Label is the literal `joiner`, not `this.role`: the handshake role
          // this party plays is fixed by reaching this lock-joiner branch, but
          // `this.role` is not committed until rendezvous succeeds (below the
          // mismatch gate), so it still holds "unknown role" here. This mirrors
          // the `[joiner]`/`[starter]` literals used elsewhere in synchronize()
          // before the role is committed.
          if (attempt < ADVERTISE_HELLO_RETRY_ATTEMPTS) {
            deps
              .log()
              .debug(
                `[joiner] advertise-hello write failed (attempt ` +
                  `${attempt}/${ADVERTISE_HELLO_RETRY_ATTEMPTS}); retrying: ` +
                  `${redactAndSanitizeForDisplay(errorMessage(writeErr))}`,
              );
            try {
              await deps.wait(deps.options().pollingFrequency);
            } catch {
              // The only way this.wait rejects is an abort from a concurrent
              // close() -- a plain delay never rejects -- so this catch cannot
              // swallow a real put() failure (those are caught by the inner
              // try and logged above). Stop retrying and fall through to the
              // reset + `throw mismatch` below so the genuine
              // BilateralModeMismatchError (exit 64) stays the surfaced root
              // cause rather than the close's ConnectionClosedError (exit 69):
              // the diverging flag is the actionable cause the operator must
              // fix, and a close arriving inside this retry is a deliberate
              // local shutdown -- the only rejector of deps.wait, per the
              // reasoning above -- where neither code is the exit code.
              // Log the cut-short retry so a close-during-mismatch is
              // diagnosable in debug logs, mirroring the exhausted-budget
              // path's degradation message in the else branch below.
              deps
                .log()
                .debug(
                  `[joiner] advertise-hello retry aborted by connection ` +
                    `close after attempt ${attempt}/` +
                    `${ADVERTISE_HELLO_RETRY_ATTEMPTS}; peer may time out ` +
                    `instead of fast-failing`,
                );
              break;
            }
          } else {
            deps
              .log()
              .debug(
                `[joiner] could not advertise hello on mismatch after ` +
                  `${ADVERTISE_HELLO_RETRY_ATTEMPTS} attempts; peer may time out ` +
                  `instead of fast-failing: ${redactAndSanitizeForDisplay(errorMessage(writeErr))}`,
              );
          }
        }
      }
      // Reset role/peer fields, mirroring the outer catch.
      deps.setPeerId(undefined);
      deps.setRole("unknown role");
      deps.setHandshakeRole(undefined);
      deps.clearAbortMarker();
      deps.resetSessionState();
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
    const joiningName = `${deps.id()}${JOINING_SUFFIX}`;
    const joiningPath = `${scope.inboundPath}/${joiningName}`;
    const helloName = `${deps.id()}${HELLO_SUFFIX}`;
    try {
      // The `!options.retainFiles` guards below match the file-wide
      // responsibleFiles idiom (every mutation is `!retainFiles`-guarded, I4a);
      // retain mode never reaches this lock joiner fast-path.
      //
      // The sentinel carries the hello body so the rename below yields a
      // fully-valid `<id>-hello.json` the peer reads through its gate; the
      // peer itself matches the sentinel by name existence and never reads it.
      await deps
        .client()
        .put(serializeEnvelope(helloEnvelope(deps.options())), joiningPath, {
          flags: "w",
          encoding: "utf-8",
        });
      // Track the sentinel only until the peer hello is deleted: before that
      // point a failure leaves the peer hello intact, so cleanup() may safely
      // sweep the sentinel (the peer is no worse off than if we never
      // started). The add follows the put with no throwable statement between,
      // matching the hello write in the else branch.
      if (!deps.options().retainFiles) deps.responsibleFiles.add(joiningName);

      await deps.client().delete(otherPath);

      // The peer hello is now gone, so the sentinel is the peer's recovery
      // signal and MUST survive a subsequent failure. Release it from
      // responsibleFiles so a failure-path cleanup() (conn.close() in the
      // caller's finally) leaves it on disk for the peer's bounded-window
      // recovery -- and, if this process dies, for the next run's Phase 0
      // guard to reject. A crashed joiner cannot clean up after itself; this
      // is the "best-effort partial-state cleanup" contract.
      if (!deps.options().retainFiles)
        deps.responsibleFiles.delete(joiningName);

      await deps.client().rename(joiningPath, helloPath);
      // The sentinel is now our hello: stop tracking the (gone) sentinel name
      // and own the hello so cleanup() sweeps it at close().
      if (!deps.options().retainFiles) deps.responsibleFiles.add(helloName);
    } catch (err: unknown) {
      // No resetSessionState() here: this.role, this.peerId,
      // this.handshakeRole, and the sequence counters are all committed only
      // after this try/catch (see below), so a throw leaves the connection in
      // its pre-synchronize state with nothing to reset.
      throw err instanceof Error ? err : new Error(errorMessage(err));
    }

    // Commit role and peerId only after both writes have succeeded. If
    // either write threw above, the connection stays in its
    // pre-synchronize state: `this.peerId` remains undefined, so the
    // "already synchronized" guard does not block a retry on the same
    // instance, and `handshakeRole` does not point at a peer that may
    // not actually exist.
    if (
      peerId.startsWith(deps.id() + "-") ||
      deps.id().startsWith(peerId + "-")
    ) {
      // Remove our hello before throwing: without this, a retry on the
      // same path (or the same instance) would find the stale file and
      // either mistake it for the peer's hello or trip the preexisting-
      // file guard. The throw escapes synchronize() directly (the joiner
      // fast-path has no enclosing catch), so no outer handler cleans up.
      await deps.client().safeDelete(helloPath);
      if (!deps.options().retainFiles) deps.responsibleFiles.delete(helloName);
      deps.resetSessionState();
      throw new UsageError(
        `peer id '${redactPrivateKeyMaterial(peerId)}' and this party's id ` +
          `'${deps.id()}' share a prefix at a '-' boundary; ids must not be ` +
          "prefix-extensions of each other (e.g. 'site' / 'site-2')",
      );
    }
    deps.setHandshakeRole("initiator");
    deps.setRole("joiner");
    deps.setPeerId(peerId);
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
    entryPeerHello: string | undefined,
  ): Promise<void> {
    const { deps } = this;
    const { outboundPath } = scope;

    deps
      .log()
      .debug(`[${deps.role()}] creating initial ${deps.id()}${HELLO_SUFFIX}`);
    await this.publishHello(outboundPath, helloPath);
    // Tracked after the durable rename (delete mode only), with no throwable
    // statement between it and the rename inside publishHello, exactly as the
    // ack write does: the final name only appears at that atomic step, so there
    // is no orphan window a pre-track would cover (I4a).
    if (!deps.options().retainFiles)
      deps.responsibleFiles.add(`${deps.id()}${HELLO_SUFFIX}`);
    let lockPath: string | undefined;
    let ackPath: string | undefined;

    // Deadline for the bounded recovery window on an entry-present peer hello,
    // armed only when one predated this run (see run()) and the remaining
    // budget can hold the window. Measured from here, the instant this party's
    // own hello is on disk: before that there is nothing for a live peer to
    // acknowledge, so an earlier start would charge the peer for this party's
    // own publish.
    const entryHelloDeadline =
      entryPeerHello === undefined
        ? undefined
        : entryHelloAckDeadline(deps.options(), Date.now());

    const waitForPeer = async () => {
      if (deps.options().locklessRendezvous) {
        // Lockless ack-handshake barrier: completes rendezvous using neither
        // createExclusive nor delete. Each party writes a hello, then an ack
        // on seeing the peer's hello, then completes when it sees the peer's
        // ack. A peer hello already present before entering this loop (joiner
        // fast-path bypassed) satisfies the condition on the first iteration.
        //
        // open() set timeToLive before synchronize() can run, so the
        // non-null assertion is safe here.
        while (Date.now() <= deps.options().timeToLive!.getTime()) {
          const currentFiles = await deps.client().list(scope.inboundPath);

          const fileNames = currentFiles.map((file) => file.name);
          if (!deps.options().retainFiles)
            deps.responsibleFiles.forEach((fileName) => {
              if (!fileNames.includes(fileName))
                deps.responsibleFiles.delete(fileName);
            });

          // isPeerHelloName excludes our own hello and -- the defense this
          // adds -- a bare `-hello.json` (empty id) injected after entry,
          // which the previous endsWith-only filter would have adopted as
          // peerId="".
          const peerHellos = currentFiles.filter((file) =>
            isPeerHelloName(file.name, deps.id()),
          );

          if (peerHellos.length === 0) {
            deps.log().trace(`[${deps.role()}] no peer hello found; polling`);
            await deps.wait(deps.options().pollingFrequency);
            continue;
          }

          if (peerHellos.length > 1) {
            throw new UsageError(
              `more than one peer hello file in ` +
                `${redactPrivateKeyMaterial(scope.inboundPath)} - are ` +
                "there other sessions using this path?",
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
              deps.client(),
              `${scope.inboundPath}/${peerHello.name}`,
              helloReadDeadline(deps.options()),
              deps.options().pollingFrequency,
              HelloEnvelopeSchema,
              peerHelloProvenance(peerHello.name, entryPeerHello),
              deps.signal(),
            );

            // Bilateral flag check before writing our ack. On mismatch throw:
            // our hello (written before this loop) stays via the outer catch's
            // skip-sweep, so the peer reads it through its own peer-hello read
            // and fails too. We do not write the ack, leaving both hellos as
            // the directory's terminal state. Covers a retain_files mismatch
            // (both parties lockless, both in this barrier) as well as a
            // lockless_rendezvous mismatch (peer is a lock party that read our
            // hello at its own two-hellos branch).
            const mismatch = bilateralMismatch(peerEnvelope, deps.options());
            if (mismatch) throw mismatch;

            // Acknowledge the peer's hello with a zero-length marker named
            // after it (`<myId>-<peerHelloStem>-ack.json`). This is a
            // self-write, so it goes to the outbound directory (the peer reads
            // it from its inbound); in shared mode that is the inbound path.
            // Published temp-then-rename so its final name never appears before
            // the file exists; the peer matches it by name existence, never by
            // reading a body.
            const peerHelloStem = peerHello.name.slice(0, -".json".length);
            deps
              .log()
              .debug(
                `[${deps.role()}] writing handshake ack for ` +
                  `${redactAndSanitizeForDisplay(peerHello.name)}`,
              );
            const ackName = await deps.writeAck(outboundPath, peerHelloStem);
            ackPath = `${outboundPath}/${ackName}`;
            // Track after the durable rename (delete mode only; retain never
            // sweeps) so cleanup() removes it at close(), exactly as the
            // message write in send() does. Both publish temp-then-rename, so
            // the final name only appears at the atomic rename and the add
            // immediately follows it with no throwable statement between --
            // unlike the lock/hello direct-writes, which pre-track because
            // createExclusive can leave the final name on a throwing call.
            // The in-flight temp-*.tmp is swept inline by writeAck.
            if (!deps.options().retainFiles) deps.responsibleFiles.add(ackName);
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
          const myHelloName = `${deps.id()}${HELLO_SUFFIX}`;
          const peerAckName = ackMarkerName(
            peerId,
            myHelloName.slice(0, -".json".length),
          );
          const hasPeerAck = currentFiles.some(
            (file) => file.name === peerAckName,
          );

          if (!hasPeerAck) {
            // Bounded recovery window, armed only when THIS hello predated the
            // run (see run()). Its writer has already demonstrated one
            // propagation leg, so a live peer answers within a round trip; one
            // that has not answered within the operator's own derived window is
            // more likely residue of an interrupted run in this directory, and
            // waiting the remaining budget only defers the same failure. A hello
            // that appeared after entry is an ordinary peer arriving and is
            // never timed here. The leftover is NOT deleted: this party cannot
            // prove it is its own, and --sweep-exchange-files remains the
            // operator's assertion that no concurrent session is using the path.
            //
            // "More likely", not "is": the window is wall-clock, and a partner
            // whose transport round trip outruns it is alive and mid-answer.
            // rendezvousBoundMs floors the window so that stays improbable, but
            // it cannot be excluded, so the text names residue as a reading
            // rather than a finding and puts the re-run ahead of the removal.
            if (
              entryHelloDeadline !== undefined &&
              peerHello.name === entryPeerHello &&
              Date.now() > entryHelloDeadline
            )
              throw new UsageError(
                "peer hello present at start never answered; it may be " +
                  "residue, not a live peer. Re-run; remove only if it " +
                  "persists and no session shares this path: " +
                  `${peerHello.name}`,
              );
            deps
              .log()
              .trace(
                `[${deps.role()}] waiting for peer ack ` +
                  `${redactAndSanitizeForDisplay(peerAckName)}`,
              );
            await deps.wait(deps.options().pollingFrequency);
            continue;
          }

          // The peer's ack of a hello this party published after its own entry
          // scan: an observation attributable to a LIVE peer, which is what
          // clears an entry-present hello from the unconfirmed-residue case.
          deps.setEntryPeerHello(undefined);

          // Peer ack confirmed -- commit roles and peerId as the last step,
          // the same invariant as the joiner path (see above): if the ack
          // write fails before this point, this.peerId stays undefined and
          // the "already synchronized" guard allows a retry on this instance.
          const arrivedFirst = `${deps.id()}${HELLO_SUFFIX}` < peerHello.name;
          deps.setHandshakeRole(arrivedFirst ? "responder" : "initiator");
          deps.setRole(arrivedFirst ? "starter" : "joiner");
          deps.setPeerId(peerId);

          deps
            .log()
            .debug(
              `[${deps.role()}] lockless rendezvous complete with ` +
                `${redactAndSanitizeForDisplay(peerId)}`,
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
        throw markPeerWaitTimeout(new Error("synchronization has timed out"));
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
      while (Date.now() <= deps.options().timeToLive!.getTime()) {
        const currentFiles = await deps.client().list(scope.inboundPath);

        const fileNames = currentFiles.map((file) => file.name);
        if (!deps.options().retainFiles)
          deps.responsibleFiles.forEach((fileName) => {
            if (!fileNames.includes(fileName))
              deps.responsibleFiles.delete(fileName);
          });

        // isPeerHelloName excludes our own hello and a bare `-hello.json`
        // (empty id) injected after entry, which the previous endsWith-only
        // filter would have sliced to peerId="" at the role-commit sites below.
        const otherFiles = currentFiles.filter((file) =>
          isPeerHelloName(file.name, deps.id()),
        );
        const theseFiles = currentFiles.filter(
          (file) => file.name === `${deps.id()}${HELLO_SUFFIX}`,
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
          isPeerJoiningName(file.name, deps.id()),
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
                `more than one joining sentinel in ` +
                  `${redactPrivateKeyMaterial(scope.inboundPath)} - ` +
                  "are there other sessions using this path?",
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
              deps
                .log()
                .debug(
                  `[${deps.role()}] peer is mid-arrival ` +
                    `(${redactAndSanitizeForDisplay(joiningName)}); awaiting completion`,
                );
            } else if (now - joiningSeenAt > deps.options().joinerRecoveryMs) {
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
                  `(${redactPrivateKeyMaterial(joiningName)}) but did ` +
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
            deps.log().trace(`[${deps.role()}] no peer hello found; polling`);
          }
          await deps.wait(deps.options().pollingFrequency);
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
            `joining sentinel ${redactPrivateKeyMaterial(foreignSentinel.name)} ` +
              `in ${redactPrivateKeyMaterial(scope.inboundPath)} ` +
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
            deps.client(),
            `${scope.inboundPath}/${otherFile.name}`,
            helloReadDeadline(deps.options()),
            deps.options().pollingFrequency,
            HelloEnvelopeSchema,
            peerHelloProvenance(otherFile.name, entryPeerHello),
            deps.signal(),
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
          const mismatch = bilateralMismatch(peerEnvelope, deps.options());
          if (mismatch) {
            await deps
              .client()
              .safeDelete(`${scope.inboundPath}/${lockFile.name}`);
            throw mismatch;
          }

          // first to arrive => should wait for first message
          deps.setHandshakeRole(arrivedFirst ? "responder" : "initiator");
          deps.setRole(
            deps.handshakeRole() === "initiator" ? "joiner" : "starter",
          );
          deps.setPeerId(otherId);

          deps
            .log()
            .debug(
              `[${deps.role()}] parsed ${redactAndSanitizeForDisplay(lockFile.name)}`,
            );

          await deps
            .client()
            .safeDelete(`${scope.inboundPath}/${lockFile.name}`);
          await deps
            .client()
            .safeDelete(`${scope.inboundPath}/${otherFile.name}`);
          await deps.client().safeDelete(helloPath);

          if (!deps.options().retainFiles) deps.responsibleFiles.clear();

          return;
        }

        if (otherFiles.length > 1) {
          throw new UsageError(
            `more than one peer hello file in ` +
              `${redactPrivateKeyMaterial(scope.inboundPath)} - are ` +
              "there other sessions using this path?",
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
          const otherPath = `${scope.inboundPath}/${otherFile.name}`;

          // I5: read the joiner's hello body through the partial-sync gate
          // before deleting it. The joiner's hello carries no byte-count
          // segment so a half-synced body would be silently misread without
          // this gate.
          const peerEnvelope = await readControlFileWithGate(
            deps.client(),
            otherPath,
            helloReadDeadline(deps.options()),
            deps.options().pollingFrequency,
            HelloEnvelopeSchema,
            peerHelloProvenance(otherFile.name, entryPeerHello),
            deps.signal(),
          );

          // Bilateral flag check before deleting the peer hello. Defense-in-
          // depth: reaching this branch means our own hello was deleted, which
          // only a lock joiner does, so the peer is in lock mode and a
          // mismatch cannot normally arise; on the throw the peer-hello delete
          // and the sweep are both skipped.
          const mismatch = bilateralMismatch(peerEnvelope, deps.options());
          if (mismatch) throw mismatch;

          // arrived first, should wait for a message
          deps.setHandshakeRole("responder");
          deps.setRole("starter");
          deps.setPeerId(otherFile.name.slice(0, -HELLO_SUFFIX.length));

          deps
            .log()
            .debug(
              `[${deps.role()}] detected ${redactAndSanitizeForDisplay(otherFile.name)}; ` +
                `deleting it`,
            );

          await deps.client().safeDelete(otherPath);

          if (!deps.options().retainFiles) deps.responsibleFiles.clear();

          return;
        } else {
          if (theseFiles.length > 1) {
            throw new UsageError(
              `more than one self hello file in ` +
                `${redactPrivateKeyMaterial(scope.inboundPath)} - are ` +
                "there other sessions using this path?",
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
          deps.setHandshakeRole(arrivedFirst ? "responder" : "initiator");
          deps.setRole(arrivedFirst ? "starter" : "joiner");
          deps.setPeerId(otherFile.name.slice(0, -HELLO_SUFFIX.length));

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
            deps.client(),
            `${scope.inboundPath}/${otherFile.name}`,
            helloReadDeadline(deps.options()),
            deps.options().pollingFrequency,
            HelloEnvelopeSchema,
            peerHelloProvenance(otherFile.name, entryPeerHello),
            deps.signal(),
          );
          const mismatch = bilateralMismatch(peerEnvelope, deps.options());
          if (mismatch) throw mismatch;

          const lockName =
            `${arrivedFirst ? deps.id() : deps.peerId()}-` +
            `${arrivedFirst ? deps.peerId() : deps.id()}${LOCK_SUFFIX}`;
          lockPath = `${scope.inboundPath}/${lockName}`;

          deps
            .log()
            .debug(
              `[${deps.role()}] attempting to create ` +
                `${redactAndSanitizeForDisplay(lockName)}`,
            );

          // Pre-emptively track lockName in delete mode: if createExclusive
          // only partially succeeds (file created on server but handle-close
          // fails with a non-EEXIST error), cleanup() will still attempt
          // safeDelete even though the EEXIST handler's
          // responsibleFiles.clear() is never reached. Both EEXIST branches
          // below call responsibleFiles.clear(), which also removes this
          // pre-emptive entry. In retain mode cleanup() is a no-op so
          // tracking serves no purpose.
          if (!deps.options().retainFiles) deps.responsibleFiles.add(lockName);
          try {
            await deps.client().createExclusive(lockPath);
            deps
              .log()
              .debug(
                `[${deps.role()}] created lock file ` +
                  `${redactAndSanitizeForDisplay(lockName)}; waiting for ` +
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

            const lockAlreadyExists = await deps.client().exists(lockPath);

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
              await deps
                .client()
                .safeDelete(`${scope.inboundPath}/${otherFile.name}`);
              await deps.client().safeDelete(helloPath);
              if (!deps.options().retainFiles) deps.responsibleFiles.clear();
              throw new UsageError(
                "peer appears to have abandoned the handshake: lock file " +
                  "was claimed by the peer but disappeared before this " +
                  "side could complete synchronization. Retry the exchange.",
              );
            } else {
              deps
                .log()
                .debug(
                  `[${deps.role()}] lock file creation failed, assuming race ` +
                    "condition",
                );

              await deps.client().safeDelete(lockPath);
              await deps
                .client()
                .safeDelete(`${scope.inboundPath}/${otherFile.name}`);
              await deps.client().safeDelete(helloPath);

              if (!deps.options().retainFiles) deps.responsibleFiles.clear();
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
            `(${redactPrivateKeyMaterial(joiningSeenName)}) but the ` +
            "exchange timed out before it completed; it appears to have " +
            "failed after announcing its arrival but before publishing its " +
            "hello. Retry the exchange.",
        );
      }
      throw markPeerWaitTimeout(
        new Error("[starter] synchronization has timed out"),
      );
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
      if (deps.peerId()!.length === 0)
        throw new UsageError(
          "rendezvous recovered an empty peer id; a bare " +
            `'${HELLO_SUFFIX}' is not a usable peer hello`,
        );
      if (
        deps.peerId()!.startsWith(deps.id() + "-") ||
        deps.id().startsWith(deps.peerId()! + "-")
      )
        throw new UsageError(
          `peer id '${redactPrivateKeyMaterial(deps.peerId()!)}' and this ` +
            `party's id '${deps.id()}' share ` +
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
        if (lockPath) await deps.client().safeDelete(lockPath);
        if (ackPath) await deps.client().safeDelete(ackPath);
        await deps.client().safeDelete(helloPath);
      }
      if (!deps.options().retainFiles) deps.responsibleFiles.clear();
      // The prefix-at-dash guard fires after waitForPeer() has already
      // committed this.peerId, this.role, and this.handshakeRole. Reset
      // them so the "already synchronized" guard does not block a retry
      // and the stale role does not appear in the retry's first log line.
      deps.setPeerId(undefined);
      deps.setRole("unknown role");
      deps.setHandshakeRole(undefined);
      deps.clearAbortMarker();
      deps.resetSessionState();
      throw err instanceof Error ? err : new Error(errorMessage(err));
    }
  }
}
