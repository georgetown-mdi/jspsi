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

import { sanitizeForDisplay } from "../utils/sanitizeForDisplay";
import {
  parseBoundedJson,
  JsonStructureBoundError,
} from "../utils/boundedJson";
import type { getLoggerForVerbosity } from "../utils/logger";
import type { HandshakeRole } from "../types";
import { UsageError, BilateralModeMismatchError } from "../errors";
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
  isProtocolTempName,
  isProtocolGrammarName,
  isRetainMessageAck,
} from "./fileSyncNames";
import {
  HelloEnvelopeSchema,
  serializeEnvelope,
  type HelloEnvelope,
} from "./controlEnvelope";
import type { FileInfo, FileTransportClient } from "./fileSyncConnection";

const errMessage = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

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
/** @internal */
export async function readControlFileWithGate(
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
// Three kinds, each chosen so it cannot shift observable timing versus the
// inline form:
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
 * reference. External behavior is byte-identical to the inline form; the
 * protocol is specified in docs/spec/FILE_SYNC.md and
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

    if (peerHellos.length === 1 && !deps.options().locklessRendezvous) {
      await this.rendezvousAsLockJoiner(scope, peerHellos[0], helloPath);
    } else {
      await this.rendezvousViaHelloExchange(scope, helloPath);
    }
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
  // (signal: options.retainFiles) -- which a delete-mode re-run does not
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
    const { deps } = this;
    // The directory scope this sweep touches, for operator-facing messages: in
    // split mode the sweep deletes from BOTH directories (peer leftovers in
    // inbound, this party's own leftovers in outbound), so name both; in shared
    // mode it collapses to the inbound display path.
    const dirsDisplay =
      deps.outbound() === undefined
        ? sanitizeForDisplay(inboundPath)
        : `${sanitizeForDisplay(inboundPath)} (inbound) and ` +
          `${sanitizeForDisplay(deps.outbound()!)} (outbound)`;

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
            deps.signal(),
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

    // Entry-time logs use the party id, not the role: the sweep runs before
    // rendezvous, so the role is still the "unknown role" sentinel. For the
    // destructive-wipe warning especially, the party id is the useful identifier.
    if (retainInPlay && deps.options().forceRetainSweep)
      deps
        .log()
        .warn(
          `[${deps.id()}] --force-retain-sweep: permanently deleting a ` +
            `retain-mode audit transcript (${toDelete.length} protocol file(s)) ` +
            `in ${dirsDisplay}. This is destructive and ` +
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
      toDelete.map((entry) =>
        deps.client().delete(`${entry.dir}/${entry.name}`),
      ),
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
      throw err instanceof Error ? err : new Error(errMessage(err));
    }
    const fileNames = files.map((file) => file.name);
    deps
      .log()
      .trace(
        `[${deps.role()}] found ${files.length} file(s)` +
          `${
            files.length > 0
              ? `: ${fileNames.map((n) => sanitizeForDisplay(n)).join(", ")}`
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
      deps
        .log()
        .info(
          `[${deps.id()}] sweeping ${orphanedTempFiles.length} orphaned temp ` +
            "file(s) left by a prior crashed exchange: " +
            `${orphanedTempFiles
              .map((f) => sanitizeForDisplay(f.name))
              .join(", ")}`,
        );
      await Promise.all(
        orphanedTempFiles.map((file) =>
          deps.client().safeDelete(`${inboundPath}/${file.name}`),
        ),
      );
      orphanedTempFiles.forEach((file) => ignored.add(file.name));
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
    if (!deps.options().retainFiles) {
      const expectedAbortIds = new Set<string>([deps.id()]);
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
        deps
          .log()
          .info(
            `[${deps.id()}] sweeping ${leftoverAbortFiles.length} leftover abort ` +
              "marker(s) from a prior failed exchange: " +
              `${leftoverAbortFiles
                .map((f) => sanitizeForDisplay(f.name))
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
            `present at entry in ${sanitizeForDisplay(scope.inboundPath)}: ` +
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
              `${sanitizeForDisplay(outboundPath)}: ` +
              `${outOrphans.map((f) => sanitizeForDisplay(f.name)).join(", ")}`,
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
              `${sanitizeForDisplay(outboundPath)}: ` +
              `${outForeign.map((f) => sanitizeForDisplay(f.name)).join(", ")}`,
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
          `path ${sanitizeForDisplay(scope.inboundPath)} contains ${peerHellos.length} peer hello files ` +
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
          `deleting discovered ${sanitizeForDisplay(otherFile.name)}`,
      );

    // I5: read the peer hello body through the partial-sync gate before
    // deleting it, validating the two required bilateral flags. open() sets
    // timeToLive before synchronize() runs, so the non-null assertion is safe.
    const peerEnvelope = await readControlFileWithGate(
      deps.client(),
      otherPath,
      deps.options().timeToLive!,
      deps.options().pollingFrequency,
      HelloEnvelopeSchema,
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
          await deps
            .client()
            .put(serializeEnvelope(helloEnvelope(deps.options())), helloPath, {
              flags: "w",
              encoding: "utf-8",
            });
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
                  `${sanitizeForDisplay(errMessage(writeErr))}`,
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
              // fix, and the close-during-mismatch case is unreachable except
              // under a signal anyway (where neither code is the exit code).
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
                  `instead of fast-failing: ${sanitizeForDisplay(errMessage(writeErr))}`,
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
      throw err instanceof Error ? err : new Error(errMessage(err));
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
      throw new Error(
        `peer id '${sanitizeForDisplay(peerId)}' and this party's id ` +
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
  ): Promise<void> {
    const { deps } = this;
    const { outboundPath } = scope;

    deps
      .log()
      .debug(`[${deps.role()}] creating initial ${deps.id()}${HELLO_SUFFIX}`);
    await deps
      .client()
      .put(serializeEnvelope(helloEnvelope(deps.options())), helloPath, {
        flags: "w",
        encoding: "utf-8",
      });
    if (!deps.options().retainFiles)
      deps.responsibleFiles.add(`${deps.id()}${HELLO_SUFFIX}`);
    let lockPath: string | undefined;
    let ackPath: string | undefined;

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
              `more than one peer hello file in ${sanitizeForDisplay(scope.inboundPath)} - are there ` +
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
              deps.client(),
              `${scope.inboundPath}/${peerHello.name}`,
              deps.options().timeToLive!,
              deps.options().pollingFrequency,
              HelloEnvelopeSchema,
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
                  `${sanitizeForDisplay(peerHello.name)}`,
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
            deps
              .log()
              .trace(
                `[${deps.role()}] waiting for peer ack ` +
                  `${sanitizeForDisplay(peerAckName)}`,
              );
            await deps.wait(deps.options().pollingFrequency);
            continue;
          }

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
                `more than one joining sentinel in ${sanitizeForDisplay(scope.inboundPath)} - are ` +
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
              deps
                .log()
                .debug(
                  `[${deps.role()}] peer is mid-arrival ` +
                    `(${sanitizeForDisplay(joiningName)}); awaiting completion`,
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
            `joining sentinel ${sanitizeForDisplay(foreignSentinel.name)} ` +
              `in ${sanitizeForDisplay(scope.inboundPath)} ` +
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
            deps.options().timeToLive!,
            deps.options().pollingFrequency,
            HelloEnvelopeSchema,
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
              `[${deps.role()}] parsed ${sanitizeForDisplay(lockFile.name)}`,
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
            `more than one peer hello file in ${sanitizeForDisplay(scope.inboundPath)} - are there ` +
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
          const otherPath = `${scope.inboundPath}/${otherFile.name}`;

          // I5: read the joiner's hello body through the partial-sync gate
          // before deleting it. The joiner's hello carries no byte-count
          // segment so a half-synced body would be silently misread without
          // this gate.
          const peerEnvelope = await readControlFileWithGate(
            deps.client(),
            otherPath,
            deps.options().timeToLive!,
            deps.options().pollingFrequency,
            HelloEnvelopeSchema,
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
              `[${deps.role()}] detected ${sanitizeForDisplay(otherFile.name)}; ` +
                `deleting it`,
            );

          await deps.client().safeDelete(otherPath);

          if (!deps.options().retainFiles) deps.responsibleFiles.clear();

          return;
        } else {
          if (theseFiles.length > 1) {
            throw new UsageError(
              `more than one self hello file in ${sanitizeForDisplay(scope.inboundPath)} - are there ` +
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
            deps.options().timeToLive!,
            deps.options().pollingFrequency,
            HelloEnvelopeSchema,
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
          if (!deps.options().retainFiles) deps.responsibleFiles.add(lockName);
          try {
            await deps.client().createExclusive(lockPath);
            deps
              .log()
              .debug(
                `[${deps.role()}] created lock file ` +
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
          `peer id '${sanitizeForDisplay(deps.peerId()!)}' and this party's ` +
            `id '${deps.id()}' share ` +
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
      throw err instanceof Error ? err : new Error(errMessage(err));
    }
  }
}
