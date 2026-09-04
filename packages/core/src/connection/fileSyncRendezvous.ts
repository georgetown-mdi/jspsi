// Rendezvous for the file-sync wire protocol.
//
// The module holds two things: pure rendezvous helpers (the hello payload
// builder, the bilateral-mode-mismatch comparison, the peer control-file
// name recognizers, and the partial-sync-gated control-file read) and the
// FileSyncRendezvous coordinator, the stateful negotiation (entry-directory
// scan and sweep, lock-joiner fast-path, and the symmetric hello-exchange).
// The coordinator reads the connection's identity/config through
// RendezvousDeps accessors and writes role/peerId/handshakeRole back
// through its setters, mutating the connection's
// responsibleFiles/foreignFileSnapshot Sets by shared reference.
//
// This module is not re-exported by the package barrel, so its @internal
// exports stay out of the public runtime surface while a unit test can
// deep-import them (fileSyncNames.ts and fileSyncFraming.ts follow the same
// pattern). FileSyncConnection's public synchronize() entry calls
// validateSynchronizeEntry() then rendezvous.run(scope).
//
// The protocol itself -- wire names, ordering, lock-vs-lockless
// negotiation, bilateral-mismatch and joiner-recovery guarantees -- is
// specified in docs/spec/FILE_SYNC.md and docs/spec/CHANNEL_SECURITY.md;
// this module implements it and does not restate it.

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

// The path/display scope a synchronize() call computes once at entry (from
// this.path/this.outbound) and threads through its phase methods, so no
// phase re-derives it. `inboundPath` is where this party reads the peer's
// files; `outboundPath` is where it writes its own (equal in shared mode);
// `split` is true only with a separate outbound directory; `dirsDisplay` is
// the operator-facing scope naming both halves in split mode.
/** @internal */
export interface RendezvousScope {
  inboundPath: string;
  outboundPath: string;
  split: boolean;
  dirsDisplay: string;
}

/**
 * Composes the operator-facing directory scope, redacting each path where
 * it is interpolated rather than the composed result: redacting the
 * composite would let a marker in the inbound path consume the split-mode
 * labels and the outbound path under the fail-closed dangling rule (see
 * {@link redactPrivateKeyMaterial}). Every production producer of a
 * {@link RendezvousScope}'s `dirsDisplay` goes through here -- a
 * convention, not a guarantee, since `dirsDisplay` is a plain string.
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
type PeerHelloProvenance = "presentAtEntry" | "appearedAfterEntry";

// Reads the hello control file through the I5 partial-sync gate: retries a
// transient get() or JSON-parse failure until timeToLive expires, then
// throws a transport Error. A typed UsageError from get() -- an over-cap
// body or a stalled read -- is terminal and not retried, since retrying
// cannot fix a usage fault and would let a hostile server hold the gate
// open until the deadline; a body that fails the envelope schema is
// terminal for the same reason. Peer-id recovery is always filename-based;
// this validates the body only.
//
// The hello is the only control file with a body (schema is always
// HelloEnvelopeSchema); the ack marker is zero-length and matched by name,
// so it needs no gate.
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
      // A typed UsageError from get() (FrameSizeExceededError,
      // TransportOperationStalledError) is terminal: rethrow so
      // synchronize() exits as the typed exit-64 failure instead of being
      // retried, which would let a hostile server hold the gate open every
      // cycle until the deadline. The malformed-payload UsageError thrown
      // below is terminal for the same reason.
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
  // A plain Error, not a UsageError: the pre-sweep retain inspection
  // classifies a UsageError from this gate as terminal (I5b) and anything
  // else as retain-uncertain, so a UsageError here would turn a bounded
  // read into a hard refusal.
  //
  // Leads with the operative sentence and recovery step, trailing the
  // path, because sanitizeErrorForDisplay truncates each cause-chain link;
  // the fixed text and the path share one 256-character link, so the
  // budget each leaves is pinned by a test, not asserted here.
  //
  // Neither text claims which of the two causes applies -- residue, or a
  // live peer still publishing -- since the recovery step (re-run, remove
  // only if it persists) is the same either way. Only the entry-present
  // read names residue as the likelier reading, since it predates this
  // run.
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

// Builds a party's hello payload: the two bilateral mode flags it advertises
// so the peer can detect a mismatch and fail fast. Written into the hello
// body in both rendezvous branches. The hello is the only control file with
// a body; the lockless ack is a zero-length marker with no flags.
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

// Compares a peer's advertised hello flags against a party's own
// configuration. Returns a BilateralModeMismatchError naming both sides'
// settings for the offending flag, or undefined when both match. Called at
// every site that reads a peer hello.
//
// retain_files is compared first, since it implies lockless_rendezvous: the
// only way both flags differ is retain=true/lockless=true vs
// retain=false/lockless=false, and naming retain_files lets the operator
// realign both in one rerun instead of landing on the invalid
// retain=true/lockless=false state. A lockless-only divergence still
// reports lockless.
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
// is not the querying party's own. The single definition of "a peer hello",
// shared by the entry guard and the in-flight lock/lockless scans: a bare
// `-hello.json` (empty id) is never a peer hello, whether present at entry
// or injected mid-rendezvous.
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
// sweepProtocolFiles), through the I5a gate: a near-future deadline, never
// the full peer timeout, so a non-resolving hello cannot stall the sweep.
// The gate's do-while still guarantees one read, so a stale directory's
// hello resolves on the first attempt; this budget only absorbs sync-tool
// flush jitter. Expressed as poll cycles, not a raw millisecond constant,
// so it tracks the configured cadence.
const RETAIN_INSPECTION_POLL_CYCLES = 2;

// Bounds every rendezvous-time peer-hello read through the same I5a gate:
// handing it the full peer timeout would let one unresolvable hello -- a
// torn or empty leftover from a crashed prior run -- hold the entire
// budget.
//
// Three times the inspection's cycles, since this read races a peer
// actively publishing rather than inspecting a stale directory, so it must
// absorb a full publish propagation, not just flush jitter. Not larger
// still: the hello publishes temp-then-rename, so its body is complete
// before its final name is visible, and what remains to absorb is
// propagation, never a write in progress.
const RENDEZVOUS_HELLO_READ_POLL_CYCLES = 6;

// Floor under every rendezvous-time bound this module derives from poll
// cycles: the poll interval is how often this party looks, not how long
// the transport takes to answer, and a bound counted purely in cycles can
// expire inside a single round trip on a slow transport. This party cannot
// measure the peer's round trip either, so the floor is wall-clock, not
// adaptive.
//
// joinerRecoveryMs is that wall-clock quantity already -- what the lock
// path allows for a peer's publish-and-rename to land -- so it is reused
// rather than adding a second constant. Neither bound below extends a wait
// past what the operator configured: the I5a hello-read bound stays capped
// at the remaining peer budget, and the entry-hello window arms only when
// it fits strictly inside that budget; below that floor the ordinary peer
// timeout fires instead.
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

// How long a peer hello already present at entry gets to acknowledge this
// party's hello before rendezvous fails terminally, as a fraction of the
// operator's remaining peer budget (with the floor below): never longer
// than the operator asked for, and scaled to the configured transport. An
// eighth leaves seven eighths of the budget for the exchange proper: 7 m
// 30 s at the default one-hour budget, against the full hour this replaces
// on an unattended re-run.
//
// The one bound this design leaves to be tuned. It, the cycle count below,
// and the wall-clock floor rendezvousBoundMs applies are the only three
// places to change it.
const ENTRY_HELLO_ACK_WINDOW_FRACTION = 1 / 8;

// Floor under that window, in poll cycles, so a fast transport (or a small
// configured budget) cannot abort inside a single round trip: this party's
// hello must reach the peer and the peer's ack must come back, each at the
// configured cadence. Passed through rendezvousBoundMs, so the wall-clock
// floor documented there applies here too, stopping this from aborting a
// live partner whose round trip outruns the poll cadence.
const ENTRY_HELLO_ACK_WINDOW_MIN_POLL_CYCLES = 6;

// The instant an entry-present peer hello stops getting the benefit of the
// doubt, or undefined when the window cannot fit strictly inside the
// remaining budget -- the ordinary peer timeout then fires instead, with
// its ordinary message.
//
// The deadline never reaches the peer timeout because arming requires
// windowMs strictly less than the remaining budget, so now + windowMs
// stays strictly inside it even under a second clock reading. The caller
// passes the clock sample the deadline is measured from, rather than this
// taking its own, so the window and the budget it is checked against are
// visibly one reading rather than two.
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
// maximum frame size, with a three-digit counter. Computed by calling
// those two constructors, so it follows a change to either name shape
// instead of restating one. The nil UUID stands in for the two identities:
// only their length reaches this arithmetic, and it has the canonical UUID
// text length without drawing randomness at module load.
//
// Reserved out of the detail link's budget for the enumeration before the
// directory scope is fitted, so an operator-chosen path cannot crowd the
// names out. A name built from a longer identity -- a configured
// `peer_id`, or a session past message 999 -- may still not fit; it is
// then counted rather than shown. A test pins that the reservation shows a
// constructor-built name whole.
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

// Composes a strict-empty entry-guard refusal: `refusalAndRecovery` becomes
// the error's own message, and the directory scope plus offending
// filenames become its own `cause` link. Both refusals are built here so
// the shape they share cannot drift.
//
// The message and the detail are split into two cause-chain links because
// sanitizeErrorForDisplay caps and truncates each link independently; one
// link could not hold the refusal, the recovery step, the directory path,
// and the filenames without competing budgets. What each message measures
// at the rendered boundary is pinned by a test.
//
// The detail link is fitted to DEFAULT_MAX_DISPLAY_LENGTH, the per-value
// budget, not the wider link cap, since it holds partner-chosen values;
// the enumeration is bounded by that budget rather than by a count, since
// a protocol filename runs from roughly 47 characters to
// ENTRY_GUARD_NAME_BUDGET_FLOOR. Each name is fit-checked in listing order
// so one long name cannot suppress shorter names behind it; a name that
// does not fit is counted rather than shown, since a chopped name reads
// like a whole one the operator could go delete.
//
// Names and the directory scope are partner-controlled and redacted before
// the fit loop (see redactPrivateKeyMaterial), so the budget is spent on
// what the operator is actually shown.
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

// The rendezvous-relevant subset of the connection's Options, read live
// through the deps `options` accessor. The connection's full Options is a
// superset, so `() => this.options` satisfies this; naming only what the
// coordinator reads keeps this boundary's dependency on the connection's
// config explicit and narrow.
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

// The connection-owned state the coordinator reads and writes across this
// boundary. Three kinds:
//   - SHARED OBJECT REFERENCES (never copies): responsibleFiles and
//     foreignFileSnapshot are the same Set instances poll()/cleanup()/close()
//     hold, so every add/delete/clear/forEach here is observed there.
//   - LIVE ACCESSORS (read fresh per call, never hoisted): signal/wait/role/
//     id/client/outbound/log/options/peerId/handshakeRole. signal() must not
//     be cached: the connection swaps its AbortController per session, so a
//     concurrent close() abort must reach an in-flight rendezvous wait.
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

  // Publishes this party's hello temp-then-rename, matching every other
  // payload-bearing publish (send()'s message write, writeAck(), the
  // joiner's sentinel): the final `<id>-hello.json` appears only at the
  // atomic rename, so no reader ever observes it torn. A hard kill
  // mid-write leaves an inert `temp-hello-<uuid>.tmp`, tolerated by the
  // next entry scan, rather than a half-written hello under its final name
  // that the I5a read gate would retry for its whole budget.
  //
  // The in-flight temp is swept inline on failure (best-effort safeDelete),
  // never tracked in responsibleFiles, matching send()/writeAck(). The
  // caller tracks the final name immediately after this resolves, with no
  // throwable statement between it and the rename (I4a).
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

  // Pre-sweep retain-signal inspection, then the protocol-file sweep for
  // --sweep-exchange-files: deletes every protocol-grammar file (this
  // party's and the peer's) so rendezvous starts against a clean slate,
  // but only after confirming the directory is not a retain-mode audit
  // transcript. Checks two signals:
  //   (a) a retain-only message ack (isRetainMessageAck) -- filename-only,
  //       body-free; does not cover an early-rendezvous retain peer that
  //       has written no ack yet.
  //   (b) the peer hello's `retain_files` flag, read through the I5a gate,
  //       bounded to RETAIN_INSPECTION_POLL_CYCLES (never the full peer
  //       timeout); an unresolved or unparseable body is retain-uncertain
  //       and refuses the bare flag.
  // Local retain mode is a signal too. When any signal is present the bare
  // flag refuses (exit 64); --force-retain-sweep permits the wipe after a
  // loud warning.
  //
  // Known gap: a peer-less, self-started retain half-start whose process
  // died before its own rollback ran, re-run in delete mode under the same
  // peer_id, is caught only by local retain mode -- a delete-mode re-run
  // loses only that operator's own abandoned half-start, never a two-party
  // transcript.
  //
  // Uses client.delete (rejects), not safeDelete (swallows): a delete
  // failure is a transport error (exit 69), not a silent "clean slate".
  // Best-effort and non-atomic -- a live peer could write between the scan
  // and the deletes -- acceptable only because the operator asserted no
  // concurrent session by passing the flag.
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

    // A retain message ack matches the protocol grammar (-ack.json) and is
    // not a peer hello, so it is already in unexpectedProtocol -- scan that
    // set rather than the raw entry listing, keeping this in step with the
    // ignored-filtered classification. In split mode this also catches a
    // retain transcript leftover in this party's own outbound directory,
    // since outbound leftovers are folded into the same set.
    const messageAck = unexpectedProtocol.find((e) =>
      isRetainMessageAck(e.file.name),
    );
    if (messageAck)
      signals.push(`a retain-mode message ack (${messageAck.file.name})`);

    // Read peer hello bodies only when no cheaper signal has decided it
    // already: the hello read is the critical check, and the only one that
    // costs a network round trip.
    if (signals.length === 0) {
      // One deadline shared across all peer hellos, bounding the total
      // inspection even in the all-readable case (a readable hello returns
      // as soon as its body resolves). The first hello that cannot be read
      // sets retainUncertain and breaks out: uncertainty is sticky and
      // already forces the refuse-or-force decision, so reading the rest
      // cannot change the outcome, and breaking caps the work a pile of
      // unreadable hellos (a hostile directory under --sweep-exchange-files)
      // can impose.
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
          // A fully-synced hello that fails the schema is a terminal
          // UsageError (I5b) -- let it propagate. A close() during
          // inspection aborts the gate read with ConnectionClosedError;
          // propagate that as a clean shutdown (exit 69), not a
          // retain-uncertain UsageError. Any other failure is an unresolved
          // read within the bounded budget: treat it as retain-uncertain,
          // and sticky -- a later hello reading retain_files=false does not
          // clear it, since the unreadable hello could itself be an unsynced
          // retain hello, and wiping it without --force-retain-sweep is the
          // data loss the guard prevents.
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

    // Dir-qualified so each file is deleted from the directory it was listed
    // in (peer hellos are inbound; unexpectedProtocol contains its own dir,
    // which is the outbound directory for a split-mode self leftover).
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
    // Unified entry precondition (mode-agnostic): the only PROTOCOL file that
    // may legitimately predate this party's entry is at most one peer hello
    // (an id that is not this party's own) -- a party writes its own
    // hello/lock/ack only after observing the peer's hello, and messages and
    // ack markers exist only once rendezvous has completed. Any other
    // protocol file is an error (a second peer hello, a self-hello, a lock,
    // an ack marker, a joining sentinel, a stale message), so the directory
    // stays strict-empty for protocol files by default, with two
    // relaxations:
    //   - FOREIGN files (names that fail the protocol grammar) are
    //     snapshotted and tolerated in both modes, deleting nothing. A
    //     message-shaped <id>-<digits>.json matches the grammar and stays a
    //     protocol file, not foreign.
    //   - --sweep-exchange-files clears every protocol file (this party's
    //     and the peer's) after a retain-signal inspection that refuses to
    //     destroy an audit transcript without --force-retain-sweep.
    //
    // The one kind that legitimately pre-exists and is not rejected is an
    // in-flight temp-*.tmp, left by a write hard-killed between the temp
    // put() and the rename to its final name. Both temp shapes land in
    // `ignored` and never abort entry, but a message/ack temp
    // (temp-<uuid>.tmp) is swept while a hello temp (temp-hello-<uuid>.tmp)
    // is left alone (see the two blocks below). `ignored` is the extension
    // point for kinds that may legitimately pre-exist as the protocol
    // grows; the foreign-file snapshot is a sibling tolerance mechanism for
    // grammar-failing names.
    //
    // A peer hello is `<peerId>-hello.json` with a non-empty id that is not
    // our own (isPeerHelloName). A bare `-hello.json` slices to an empty id
    // and is NOT a peer hello: it still matches the grammar
    // (isProtocolGrammarName), so it falls into unexpectedProtocol, is
    // rejected at the no-flag guard, and is swept under
    // --sweep-exchange-files rather than tolerated as a phantom peer. The
    // in-flight rendezvous scans share the same predicate so a mid-flight
    // injection is rejected too.
    const ignored = new Set<string>();

    // Sweep orphaned in-flight temp writes left by a prior crashed exchange:
    // match only the protocol's own message/ack temp shape,
    // temp-<uuidv4()>.tmp (isProtocolTempName minus isHelloTempName), which
    // send()/writeAck() produce -- never a final <id>.json message, and
    // never a foreign temp-*.tmp whose stem is not a v4 UUID (which falls
    // through to the foreign-file snapshot and is tolerated). Delete each
    // with the non-throwing safeDelete, then add its name to `ignored` so
    // the already-taken `files` snapshot does not re-trip the guard below.
    //
    // Sweeping unconditionally is safe because both shapes are orphaned by
    // construction: writing either requires having already seen this
    // party's hello, published only after this scan (the ordering is
    // pinned by a test), so no live in-flight write can race this delete.
    //
    // Best-effort: a safeDelete that silently fails leaves the temp on
    // disk, but entry proceeds past it and the next exchange's entry
    // re-runs this same sweep, so the litter is self-healing. Tracking the
    // orphan in `responsibleFiles` would not help, since its writer already
    // died and that process's cleanup() never runs -- the reason this sweep
    // exists.
    const orphanedTempFiles = files.filter(
      (file) => isProtocolTempName(file.name) && !isHelloTempName(file.name),
    );
    if (orphanedTempFiles.length > 0) {
      // Single breadcrumb: a process died mid-write here. Entry is not
      // aborted on its account, but the prior crash should still show in
      // the log.
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

    // A hello temp is tolerated in place, never swept: a peer that started
    // at the same instant can have one in flight in this listing, and
    // deleting it would break that peer's rename. This party's own crash
    // residue takes the same disposition, since the two are
    // indistinguishable by name, so a hello temp survives entry as inert
    // litter -- it matches the grammar (never counted as foreign), the
    // mid-loop scan recognizes it, and no reader opens it.
    // --sweep-exchange-files does not reach it either: the flag clears the
    // durable protocol files the operator's no-concurrent-session assertion
    // covers, and a temp is not one of those.
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

    // Recognize-and-sweep leftover authenticated abort markers, mirroring
    // the orphaned-temp sweep above. Every authenticated terminal failure
    // leaves a `<writerId>-abort.json`, which must persist for the peer to
    // read; a subsequent exchange reusing the directory would otherwise
    // find it and reject "directory not clean". Both parties retry under
    // fresh ids, so the sweep matches any well-formed marker
    // (`<id>-abort.json` with a non-empty recovered id via
    // peerIdFromControlName), whichever id wrote it. A bare `-abort.json`
    // recovers no id and stays an unexpected protocol file; a
    // grammar-failing name is foreign and is never touched here.
    //
    // Safe because no marker visible at entry can belong to this session:
    // a marker is written only post-handshake, and a party cannot reach
    // post-handshake before its peer has passed this same entry scan, so a
    // marker seen here is residue of a prior session whose token cannot
    // authenticate under this session's key. Sweeping it costs a still-live
    // peer its fast-fail, dropping it to the peer-silence timeout (a limit
    // stated in docs/spec/FILE_SYNC.md).
    //
    // Delete mode only: in retain mode the directory is a durable audit
    // transcript, so a leftover instead falls through to the
    // unexpectedProtocol guard and to sweepProtocolFiles' own
    // --force-retain-sweep gate, reusing that check rather than a parallel
    // one that could drift from it.
    //
    // Best-effort, like the orphaned-temp sweep: safeDelete swallows a
    // transport-level failure, so a marker that fails to delete is left on
    // disk and entry proceeds past it. It is benign: the next exchange's
    // entry re-runs this sweep, and it cannot forge a PeerAbortError in a
    // later session, since verifyPeerAbortMarker authenticates the
    // marker's token against that session's HKDF-derived peer token, which
    // a stale marker cannot satisfy.
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
    // Protocol-grammar files that are not the tolerated peer hello: a
    // self-hello, a lock, a joining sentinel, an ack marker, or a stale
    // message. A second peer hello is counted in peerHellos, not here: the
    // no-sweep path's >1 guard rejects it, and --sweep-exchange-files
    // sweeps it along with the first. Dir-qualified so the sweep below
    // deletes each from the directory it was listed in: inbound files here,
    // outbound leftovers appended in the split block below.
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

    // Split mode: the outbound directory must be as fresh as the inbound
    // one -- retain mode's fresh-directory precondition applies to both
    // halves. Peer files never land in outbound (the peer writes to its
    // own outbound, which is this party's inbound), so every
    // protocol-grammar file here is this party's own leftover: an orphaned
    // temp is swept, a foreign file is tolerated, and any other protocol
    // file is collected as unexpected, exactly as on the inbound side. That
    // same routing rule is why the sweep covers both temp shapes here while
    // the inbound side exempts the hello shape: a hello temp in this
    // directory can only be this party's own.
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
          // dirsDisplay names both halves in split mode: unexpectedProtocol
          // can hold outbound leftovers as well as inbound ones, so
          // directing the operator at the inbound path alone would mislead.
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

  // Lock-mode joiner fast-path: a single peer hello is already present and
  // this party is in lock mode, so it arrives via a `<id>-joining.json`
  // sentinel that holds its hello body, deletes the discovered peer hello,
  // and renames the sentinel into place. Commits role/peerId only after
  // both writes succeed.
  //
  //   A list
  //   A hello
  //   B list
  //   B joining                       (sentinel holding B's hello body)
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

    // Bilateral flag check. A mismatch here means the peer is lockless,
    // since only a lockless peer leaves its hello in place for a lock
    // joiner to discover. For symmetric detection the joiner writes its
    // own advertised hello before throwing (so the lockless peer reads it
    // and fails too) and must not delete the peer hello: both hellos are
    // the directory's terminal state, left untracked so close()/cleanup()
    // does not sweep them. Detection, not negotiation -- neither side
    // adapts to the other's mode.
    const mismatch = bilateralMismatch(peerEnvelope, deps.options());
    if (mismatch) {
      // Advertise our own hello so the lockless peer reads it and fails
      // symmetrically -- the one mismatch site needing a new write at
      // detection time, so it is the single point of asymmetric failure in
      // the symmetric-detection guarantee: if the put fails here, the peer
      // degrades to the peer-timeout instead. Retry the write up to
      // ADVERTISE_HELLO_RETRY_ATTEMPTS at the polling cadence to raise the
      // odds it lands before the peer times out; this does not change
      // detection.
      //
      // Whatever the write's outcome once the budget is exhausted, this
      // party still throws the genuine mismatch it detected (a UsageError,
      // exit 64): the retry must not let a transport rejection escape and
      // mask the mismatch as a generic Error (exit 69). The operator must
      // fix the diverging flag regardless of the transport.
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
              // this.wait only rejects on an abort from a concurrent
              // close() -- a plain delay never rejects -- so this catch
              // cannot swallow a real put() failure (caught and logged
              // above). Stop retrying and fall through to the reset plus
              // `throw mismatch` below, so the genuine
              // BilateralModeMismatchError (exit 64) stays the reported
              // root cause rather than the close's ConnectionClosedError
              // (exit 69): the diverging flag is the actionable cause the
              // operator must fix.
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

    // Sentinel-mediated arrival closes the joiner partial-failure window. A
    // bare delete(peer hello) then put(my hello) is observable as an
    // inconsistent state: if the delete lands but the put fails, the peer's
    // waitForPeer cannot tell "joiner mid-write" from "joiner crashed", so
    // it polls to the full peerTimeoutMs. Instead, publish a
    // `<id>-joining.json` sentinel holding our hello body, delete the peer
    // hello, then rename the sentinel to our hello. The rename is atomic,
    // so the sentinel exists across exactly the window where the peer
    // hello may already be gone but ours is not yet present, and the peer
    // recognizes it as a wait signal (see waitForPeer). We never re-create
    // the peer's hello on failure: that races the peer's next list() and
    // can trip the two-hello collision check (I1).
    const joiningName = `${deps.id()}${JOINING_SUFFIX}`;
    const joiningPath = `${scope.inboundPath}/${joiningName}`;
    const helloName = `${deps.id()}${HELLO_SUFFIX}`;
    try {
      // The `!options.retainFiles` guards below match the file-wide
      // responsibleFiles idiom (every mutation is `!retainFiles`-guarded, I4a);
      // retain mode never reaches this lock joiner fast-path.
      //
      // The sentinel holds the hello body so the rename below yields a
      // fully-valid `<id>-hello.json` the peer reads through its gate; the
      // peer itself matches the sentinel by name existence and never reads
      // it.
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
      // signal and must survive a subsequent failure. Release it from
      // responsibleFiles so a failure-path cleanup() leaves it on disk for
      // the peer's bounded-window recovery, and, if this process dies, for
      // the next run's Phase 0 guard to reject. A crashed joiner cannot
      // clean up after itself; this is the "best-effort partial-state
      // cleanup" contract.
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

          // isPeerHelloName excludes our own hello and a bare `-hello.json`
          // (empty id) injected after entry, which would otherwise be
          // adopted as peerId="".
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

            // Bilateral flag check before writing our ack. On mismatch,
            // throw without writing the ack: our hello (written before
            // this loop) stays via the outer catch's skip-sweep, so the
            // peer reads it through its own peer-hello read and fails too,
            // leaving both hellos as the directory's terminal state.
            // Covers a retain_files mismatch (both parties lockless) as
            // well as a lockless_rendezvous mismatch (peer is a lock party
            // that read our hello at its own two-hellos branch).
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
            // Track after the durable rename (delete mode only) so
            // cleanup() removes it at close(), exactly as the message write
            // in send() does: the final name appears only at the atomic
            // rename, with no throwable statement between it and the add --
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
            // Bounded recovery window, armed only when this hello predated
            // the run: its writer has already demonstrated one propagation
            // leg, so a live peer answers within a round trip, and one
            // that has not answered within the operator's own derived
            // window is more likely residue of an interrupted run than a
            // live peer. A hello that appeared after entry is an ordinary
            // peer arriving and is never timed here. The leftover is not
            // deleted: this party cannot prove it is its own, and
            // --sweep-exchange-files remains the operator's assertion that
            // no concurrent session is using the path.
            //
            // "More likely", not "is": a partner whose round trip outruns
            // the window is alive and mid-answer. rendezvousBoundMs floors
            // the window so that stays improbable but not excluded, so the
            // message names residue as a reading, not a finding, and puts
            // the re-run ahead of the removal.
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
        // indeterminate here, so emit no `[role]` prefix (unlike the lock
        // timeout below, which is reachable only as the lone starter).
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
        // (empty id) injected after entry, which would otherwise slice to
        // peerId="" at the role-commit sites below.
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
        // has begun the put(sentinel) -> delete(our hello) ->
        // rename(sentinel -> its hello) sequence the lock joiner uses in
        // place of a bare delete-then-put. Its presence distinguishes a
        // live-but-incomplete joiner from a crashed one, which a bare
        // otherFiles.length === 0 cannot. isPeerJoiningName excludes a
        // self-named sentinel and a bare `-joining.json` (empty id), so a
        // planted empty-id sentinel does not start the joiner-recovery
        // (joinerRecoveryMs) window below.
        const joiningFiles = currentFiles.filter((file) =>
          isPeerJoiningName(file.name, deps.id()),
        );

        if (otherFiles.length === 0) {
          if (joiningFiles.length > 0) {
            // Exactly one sentinel is the only valid mid-arrival state: one
            // joiner, one starter, and the starter never writes a sentinel.
            // A second is contamination from a third party, the same
            // illegal state the multi-peer-hello and multi-lock guards
            // below reject; report it the same way rather than silently
            // timing the first.
            if (joiningFiles.length > 1) {
              throw new UsageError(
                `more than one joining sentinel in ` +
                  `${redactPrivateKeyMaterial(scope.inboundPath)} - ` +
                  "are there other sessions using this path?",
              );
            }
            // Joiner is mid-arrival. Wait a bounded recovery window for the
            // rename to land -- the joiner then appears as a normal peer
            // hello and the branches below take over. If the sentinel
            // persists past the window, the joiner failed mid-arrival
            // (after writing the sentinel but before publishing its hello);
            // abort with a distinct transport error (a plain Error, exit
            // 69) instead of polling to the full peer timeout. We do not
            // re-create our own hello: that races the joiner's rename and
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
              // (joinerRecoveryMs, joinerRecoveryMs + pollingFrequency] --
              // one extra poll is immaterial against the 30 s default. The
              // crash could be on either side of the joiner's delete, so the
              // message names the bracketing operations rather than a
              // single step. Labelled [starter]: this branch is reached
              // only by the party that wrote its hello first and is
              // waiting for a joiner -- the joiner takes the entry
              // fast-path and never enters this loop -- even though
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
        // parties wrote hellos), so the recovery timer is stale. A
        // sentinel may still be visible in one benign case: the peer's own
        // rename is mid-propagation on a sync-mediated transport, so its
        // `<peerId>-joining.json` and `<peerId>-hello.json` momentarily
        // coexist (the rename is atomic at the SFTP layer, not necessarily
        // at the sync-tool layer); that same-id sentinel is the peer we
        // are about to rendezvous with, so tolerate it. A sentinel whose id
        // matches no peer hello is a third party in the directory -- the
        // same contamination the multi-hello and multi-lock guards reject
        // -- so report it as a UsageError rather than completing against
        // an inconsistent directory.
        //
        // No joiningFiles.length > 1 guard is needed here: a sentinel that
        // escapes the foreign-id check matches a present peer hello, so two
        // such sentinels would require two distinct peer hellos, already
        // terminal under the otherFiles.length > 1 guard below.
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

          // Use hello filename order -- the same tiebreak the lock
          // producer uses (I7) -- to reconstruct the expected lock name,
          // never a raw `thisId < otherId` compare: for ids where one is a
          // prefix of the other (e.g. "Agency" / "Agency A"), space
          // (U+0020) sorts before "-" (U+002D), so hello-filename order and
          // id-order can diverge, causing a false "lock does not reference
          // this connection" throw that UUID tests would never catch.
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
          // before committing roles. The hello name has no byte-count
          // segment, so a half-synced body cannot be caught by a size
          // check.
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
          // sweep below. Defense-in-depth: a lock present implies both
          // parties are in lock mode (lockless never creates a lock) and a
          // lock party always has retain_files=false, so a mismatch cannot
          // normally reach here. If a corrupt directory somehow produced
          // one, leave the two hellos as the terminal state: delete the
          // peer-written lock first (a transient, not an advertisement the
          // peer must read; safeDelete is contractually non-throwing, so it
          // cannot mask the mismatch), and leave our own hello via the
          // outer catch's skip-sweep for the peer to read.
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
          // before deleting it. The joiner's hello has no byte-count
          // segment, so a half-synced body would be silently misread
          // without this gate.
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
          // flags, before racing a lock. A lockless peer's hello can
          // coexist with our lock hello here, so this is a reachable
          // lockless_rendezvous mismatch. Running the check before
          // createExclusive pre-empts both the createExclusive-winner and
          // EEXIST-loser sub-paths, so a mismatched pair never races a
          // lock. On the throw, our own hello is left in place by the
          // outer catch's skip-sweep, so the lockless peer reads it and
          // fails too.
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
              // (it returns from waitForPeer, leaving the lock for the
              // loser to clean up). If the lock is gone after we received
              // EEXIST, the winner must have crashed (doCleanup ran during
              // the narrow window where lockName was in responsibleFiles)
              // or otherwise abandoned the handshake; polling for their
              // first protocol message would stall until peerTimeoutMs, so
              // fail fast instead. Best-effort tidy of both hellos before
              // throwing so the directory is left clean for a retry.
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
      // branch that observes one commits a role and returns), so the
      // waiter is the lone starter, never the joiner.
      //
      // If a joiner sentinel was visible on the final poll (joiningSeenAt
      // still set), the actionable cause is a stuck mid-arrival joiner, not
      // a bare timeout -- this happens when the sentinel first appears with
      // less than joinerRecoveryMs left on the TTL, so the outer loop exits
      // before the recovery check above can fire. Check both fields: they
      // are set and cleared as a pair, so testing joiningSeenName too keeps
      // that coupling type-enforced and degrades gracefully to the bare
      // timeout if they ever diverged.
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
      // (responder, lock-detection, EEXIST loser, lockless) clear or
      // retain explicitly before returning. The createExclusive-winner and
      // lockless paths are the exception -- they leave hello (and lock or
      // ack) in responsibleFiles so cleanup() can sweep them if the peer
      // never arrives. Clearing here would lose that safety net.
      //
      // Both rendezvous modes have assigned this.peerId by this point.
      // Reject an empty recovered id, then prefix-at-dash id pairs, before
      // any message is sent; both parties evaluate these symmetrically. The
      // hello scans above already exclude a bare `-hello.json`, so an empty
      // this.peerId is unreachable for a correct scan -- this is defense in
      // depth: a peerId="" slipping through would make poll() treat every
      // "-"-prefixed file as a peer message and the lockless ack barrier
      // wait on an ack no honest peer writes, so fail closed here rather
      // than proceed.
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
      // A bilateral-mode mismatch is the one terminal failure that must not
      // sweep the directory: this party's advertised hello (written before
      // the loop) is the directory's terminal state, left in place so the
      // peer reads it through its own peer-hello read and fails too. Skip
      // the on-disk safeDelete of hello/ack/lock; clearing
      // responsibleFiles (so a later close()/cleanup() does not delete the
      // advertised hello) and the in-memory reset still run, so the
      // instance is not wedged. A rerun against the leftover hellos is
      // rejected by the entry guard (I0) until the operator clears the
      // directory and fixes the mismatched flag.
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
