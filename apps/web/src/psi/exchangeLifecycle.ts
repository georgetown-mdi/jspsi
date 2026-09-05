import {
  ConnectionError,
  LinkageTermsUnsatisfiableError,
  OperatorConfigError,
  describeResolvedRunShape,
  getLogger,
  runExchange,
} from "@psilink/core";

import { authenticateExchange } from "./authenticateExchange";
import { createBrowserPsiEngineFactory } from "./workers/psiCryptoController";
import { defaultSpawnPsiCryptoWorker } from "./workers/psiCryptoWorkerClient";
import { openPeerMessageConnection } from "./transport/peerMessageConnection";

import type { DataConnection } from "peerjs";
import type Peer from "peerjs";
import type { PeerCloseOutcome } from "./transport/waitForPeerClose";

import type {
  ExchangeResult,
  MessageConnection,
  PreparedExchange,
  ProcessState,
} from "@psilink/core";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

const log = getLogger("exchangeLifecycle");

/**
 * Operator notice for a run that reported its result whose clean close then
 * waited for the peer up to the ceiling without the peer's take signal
 * arriving: this side's exchange finished, but the partner's may not have.
 * Composed raw and escaped once at the display boundary
 * (`apps/web/src/psi/runWarnings.ts`). Names no duration -- the operator
 * does not set or see the ceiling -- and directs the operator to confirm with
 * the partner, since only the partner's result is in doubt.
 */
export const FINAL_FRAME_UNCONFIRMED_WAIT_EXPIRED_WARNING =
  "your partner did not confirm taking the final message before the wait " +
  "for them ran out, so their exchange may have ended without it. Your own " +
  "results are complete; check with your partner that their exchange " +
  "finished before either of you relies on their copy.";

/**
 * Operator notice for the same run when the close ends because the link went
 * instead -- the peer connection died, the channel was already closed when
 * the wait began, or the run was cancelled mid-wait. A separate message from
 * the one above because delivery is unknowable here: the message may have
 * reached the partner before the link died, or never gone at all. The wording
 * claims neither, and gives the same closing instruction, since the same
 * check resolves it.
 */
export const FINAL_FRAME_UNCONFIRMED_LINK_LOST_WARNING =
  "the connection closed before your partner could confirm taking the final " +
  "message, so they may or may not have received it. Your own results are " +
  "complete; check with your partner that their exchange finished before " +
  "either of you relies on their copy.";

/**
 * What a run tells its operator about each way the clean close's wait for the
 * peer can end ({@link PeerCloseOutcome}). `undefined` means silence by
 * design: the peer's own close is the delivery signal, so that exit has
 * nothing to report; every other exit means the partner's copy is in doubt,
 * and states which kind. A total map, so a new outcome fails to compile here
 * until this layer decides what it says; which notices actually reach an
 * operator is a separate emit gate in each run wiring ({@link
 * runExchangeLifecycle} for a one-shot run and the managed re-run driver for
 * a recurring one, both withholding every notice from a failed or cancelled
 * run).
 */
export const CLOSE_OUTCOME_WARNINGS: Record<
  PeerCloseOutcome,
  string | undefined
> = {
  "peer-closed": undefined,
  ceiling: FINAL_FRAME_UNCONFIRMED_WAIT_EXPIRED_WARNING,
  "peer-gone": FINAL_FRAME_UNCONFIRMED_LINK_LOST_WARNING,
  "channel-not-open": FINAL_FRAME_UNCONFIRMED_LINK_LOST_WARNING,
  "run-aborted": FINAL_FRAME_UNCONFIRMED_LINK_LOST_WARNING,
};

/** A single rendered stage in the progress UI (a superset of core's
 * `ExchangeStageDefinition`, adding the UI {@link ProcessState}). */
export interface StageDefinition {
  id: string;
  label: string;
  state: ProcessState;
}

/** Which half of the lifecycle a failure came from, so the UI can choose its
 * alert. `"exchange"` (acquire/open/run) invites a re-run. `"output"` means
 * the exchange already succeeded and only local results-file generation
 * failed -- never re-run. `"security"` is the trust-boundary subset of an
 * exchange failure: the authenticated key exchange (or, once wrapped, the
 * AEAD layer) reported a wrong secret, tamper, or replay, so the UI shows it
 * as an authentication failure rather than a retryable transport drop.
 * `"config"` is an {@link OperatorConfigError} raised in the PREPARE phase
 * (inside `acquire`, before any peer connection), whose message names only
 * this party's own configuration -- not a transport drop, so retrying as-is
 * fails identically and the message is safe to show. Scoped to that type
 * only: a sibling prepare-phase `UsageError` whose message can embed
 * partner-influenced values (e.g. the accept side's disclosure check) stays
 * the generic `"exchange"`.
 *
 * {@link LinkageTermsUnsatisfiableError} also classifies `"config"`, for the
 * no-retry affordance rather than the message: it is a deterministic
 * pre-connection refusal whose message names the agreed terms' own key and
 * field names, partner-authored on every accept path, so the alert builder
 * supplies fixed copy instead of rendering it. */
export type ExchangeErrorCategory =
  "exchange" | "output" | "security" | "config";

/** Maps a lifecycle failure to the {@link ExchangeErrorCategory} the UI
 * shows, for the given `phase`. A `security`-kind {@link ConnectionError} --
 * the authenticated key exchange failing closed on a wrong secret, tamper, or
 * replay -- routes on its `kind`, not the handshake step, so a future
 * `security` failure anywhere in the exchange classifies the same way; every
 * other failure is the retryable generic `"exchange"`. (An `"output"`
 * failure is classified at its own call site.) An {@link OperatorConfigError}
 * classifies `"config"` only in the `"prepare"` phase (`acquire`, which runs
 * `prepareForExchange`); the same error type mid-`"run"` -- e.g. a signing
 * run's certificate/terms refusal -- falls through to `"exchange"` instead,
 * since its message is not guaranteed to be local-only there. The CLI's
 * `classifyTerminalError` drops the phase, since its category has to agree
 * with an exit code this alert has no counterpart for. See {@link
 * ExchangeErrorCategory} for what each category means and for {@link
 * LinkageTermsUnsatisfiableError}'s membership. */
function classifyExchangeFailure(
  error: unknown,
  phase: "prepare" | "run",
): ExchangeErrorCategory {
  if (
    phase === "prepare" &&
    (error instanceof OperatorConfigError ||
      error instanceof LinkageTermsUnsatisfiableError)
  )
    return "config";
  return error instanceof ConnectionError && error.kind === "security"
    ? "security"
    : "exchange";
}

/** The live resources an {@link Acquire} hands the owner on success. */
export interface AcquiredExchange {
  peer: Peer;
  conn: DataConnection;
  /** The PSI WASM library. Resolved already for the client (it awaits early, to
   * fail before publishing its peer id); still pending for the server (the
   * responder must attach its inbound listener before the library resolves), so
   * the owner does a single uniform `await` that is instant for the client and
   * real for the server. */
  psi: Promise<PSILibrary>;
  prepared: PreparedExchange;
}

/** The `signal` and stage-reporting hooks an {@link Acquire} uses while it
 * loads/prepares and draws in the peer. Every hook no-ops once `signal`
 * aborts. */
export interface AcquireContext {
  signal: AbortSignal;
  /** Activate a stage (e.g. "waiting for peer" immediately before a wait). */
  onStage: (stageId: string) => void;
  /** Emit the full per-exchange stage tree, once, after load/prepare. */
  onStages: (stages: Array<StageDefinition>) => void;
}

/**
 * Role-specific acquisition: load/prepare locally, then draw in the peer (last
 * step), returning the live resources. The only role difference in the
 * lifecycle. Must be atomic: a failure inside acquisition tears down anything it
 * built (e.g. `peer.destroy()`) before rejecting, so the owner's teardown latch
 * only ever covers a successfully-returned `{peer, conn}`.
 */
export type Acquire = (context: AcquireContext) => Promise<AcquiredExchange>;

/** The two exchange-record downloads: the shareable record and its private
 * verification keys, offered as separate files (mirroring the CLI's two-file
 * split) so the record can be handed to an auditor without the keys. */
export interface RecordDownloads {
  /** The shareable record (JSON: commitments + a non-secret governance summary,
   * never matched data). Safe to share with an auditor; still owner-retained by
   * default. */
  recordUrl: string;
  /** Download filename for {@link recordUrl}, timestamped per exchange so
   * repeated downloads in one session accumulate an audit trail rather than
   * collide (mirrors the CLI's timestamped default path). */
  recordFileName: string;
  /** The private verification keys (JSON: per-commitment salts only, no matched
   * data). Kept private -- with the record they can open the commitments. */
  keysUrl: string;
  /** Download filename for {@link keysUrl}, paired with {@link recordFileName}
   * (same timestamp stem, `.keys.json` suffix). */
  keysFileName: string;
}

/** Fields common to all three shapes of {@link ExchangeOutputs}. */
interface ExchangeOutputsBase {
  /** The exchange-record downloads (the shareable record plus its private
   * verification keys), present or absent as a whole. Absent only when building
   * the record failed (the exchange still succeeded and the result, if any,
   * remains available; see {@link ExchangeResult.audit}). Offered to a receiver
   * and a helper alike -- the helper's record is produced even though it does not
   * bind the result table. */
  record?: RecordDownloads;
}

/** A receiver's outputs: the matched results file (CSV), plus the optional record
 * downloads. */
interface ReceivedExchangeOutputs extends ExchangeOutputsBase {
  kind: "matched";
  /** The matched results (CSV), as an object URL the UI exposes as a download. */
  resultsUrl: string;
}

/** A non-receiving helper's outputs: no results file, only the optional record
 * downloads. The exchange withheld the result table from this party (its agreed
 * terms give it no output; `ExchangeResult.associationTable` is undefined), so the
 * UI shows that it contributed to the match but receives no result table, rather
 * than an empty CSV that looks like a zero-match run. */
interface WithheldExchangeOutputs extends ExchangeOutputsBase {
  kind: "withheld";
}

/** A count-only (`psi-c`) receiver's outputs: the intersection size, and no results
 * file -- that run produces no matched pairing for anyone to download, so there is
 * nothing withheld from this party either. The count is the run's whole result
 * (`ExchangeResult.intersectionCount`), which is why it is its own case rather than
 * a receiver with an empty CSV or a helper that got nothing. */
interface CountOnlyExchangeOutputs extends ExchangeOutputsBase {
  kind: "counted";
  intersectionCount: number;
  /** Whether the count arrived as the PARTNER's report rather than as a figure this
   * party computed (`countIsPartnerReported` in `@psilink/core`). The sender seat of
   * a both-entitled count-only run reads a number it cannot check, so the UI shows
   * the trust-contingent caveat; the receiver computed its own and does
   * not. */
  countReportedByPartner: boolean;
}

/** The downloadable artifacts produced after a successful exchange: each is an
 * object URL the UI exposes as a download with a timestamped filename. The matched
 * result is present XOR withheld XOR counted, so the cases are a discriminated union
 * over `kind` rather than independent optionals -- the invalid states ("both a result
 * and withheld", "neither") are unrepresentable, and an unhandled fourth outcome is
 * a compile error rather than a case silently rendered as one of the others. */
export type ExchangeOutputs =
  ReceivedExchangeOutputs | WithheldExchangeOutputs | CountOnlyExchangeOutputs;

/** Pure output-generation step: build the local results file plus the
 * exchange-record artifacts (record + verification keys) from the exchange result
 * and return their URLs. May throw (classified as `"output"`); runs inside the
 * owner after the exchange and before teardown. `TOutputs` lets an owner return
 * a widened {@link ExchangeOutputs} (extra owner-local fields such as a matched
 * count) and receive the same type back in `onResult` without a cast. */
export type GenerateOutput<TOutputs extends ExchangeOutputs = ExchangeOutputs> =
  (result: ExchangeResult, prepared: PreparedExchange) => TOutputs;

/** Options for {@link runExchangeLifecycle}. */
export interface RunExchangeLifecycleOptions<
  TOutputs extends ExchangeOutputs = ExchangeOutputs,
> {
  acquire: Acquire;
  /** This party's PSI handshake role: the web client is the `"initiator"`, the
   * web server the `"responder"`. The same role drives the pre-exchange
   * authenticated key exchange. */
  exchangeRole: "initiator" | "responder";
  /** The invitation's shared secret (base64url), fed to the authenticated key
   * exchange the owner runs against `mc` before `runExchange`. Both peers
   * must hold the same value; a mismatch fails the handshake closed and never
   * reaches the PSI exchange. */
  sharedSecret: string;
  /** The invitation's `expires` (ISO 8601), if present, threaded
   * alongside `sharedSecret` into the authenticated key exchange so core's pre-
   * and post-handshake expiry guards evaluate it -- an invitation that lapses
   * before or during the handshake fails closed before any PSI frame. Undefined
   * for an unbounded credential, leaving the guards no-op. */
  expires?: string;
  signal: AbortSignal;
  generateOutput: GenerateOutput<TOutputs>;
  onStages: (stages: Array<StageDefinition>) => void;
  onStage: (stageId: string) => void;
  onResult: (outputs: TOutputs) => void;
  onError: (failure: {
    category: ExchangeErrorCategory;
    error: unknown;
  }) => void;
  /** A non-fatal, operator-relevant notice raised mid-run. Two sources, arriving
   * at opposite ends of the run: what the agreed terms resolved to, raised
   * right after the terms resolve and before the first round, composed by core
   * ({@link describeResolvedRunShape}); and the clean close ending on any exit
   * that has no delivery signal rather than on the peer's close
   * ({@link CLOSE_OUTCOME_WARNINGS}), which is raised only on a run that reported
   * its result. Optional: an owner with no warning sink omits it and the
   * notice is dropped. Never a terminal; the run still ends in exactly one
   * `onResult`/`onError`, and a notice raised during teardown arrives after
   * that one. */
  onWarning?: (message: string) => void;
}

/**
 * Single owner of the per-exchange lifecycle for both roles. Acquires the
 * resource (the role's only difference, via `acquire`), runs the exchange, and
 * guarantees teardown regardless of where a failure lands or whether an unmount
 * aborts mid-flight.
 *
 * Guarantees:
 * - **Teardown always runs, exactly once, and never throws** (F1, F2). It is a
 *   run-once latch: even when two triggers race (a wait timeout and an
 *   unmount-abort), the effect runs once. A teardown-only failure is logged and
 *   raises no alert -- the results are available and there is nothing for the
 *   operator to act on.
 * - **The exchange-vs-output distinction survives** (F2). A failure from
 *   acquire/open/run is `"exchange"`, except a trust failure from the
 *   authenticated key exchange (a `security`-kind {@link ConnectionError}), which
 *   is `"security"` so the UI shows an authentication failure rather than a
 *   retryable transport drop; a `generateOutput` throw (the exchange already
 *   succeeded) is `"output"`; a teardown-only throw raises neither.
 * - **The broker socket drops on the first inbound frame** (F4), while the data
 *   channel stays open for the exchange. Best-effort: a throw in that listener
 *   cannot fail the exchange.
 * - **Abort tears down in any phase** (F1, F3). On abort the owner closes the
 *   connection regardless of phase; an in-flight `runExchange` then rejects with
 *   a `closed` ConnectionError and lands in the same latched teardown. Every
 *   owner-driven hook no-ops once aborted, so no setState fires after unmount on
 *   any path (success, progress, or error).
 */
export async function runExchangeLifecycle<
  TOutputs extends ExchangeOutputs = ExchangeOutputs,
>(options: RunExchangeLifecycleOptions<TOutputs>): Promise<void> {
  const {
    acquire,
    exchangeRole,
    sharedSecret,
    expires,
    signal,
    generateOutput,
    onStages,
    onStage,
    onResult,
    onError,
    onWarning,
  } = options;

  // Every owner-driven React callback is a no-op once the signal aborts, so an
  // unmount that lands in the same tick as a resolving stage/result/error
  // cannot setState on an unmounted component.
  const ifLive =
    <TArgs extends Array<unknown>>(fn: (...args: TArgs) => void) =>
    (...args: TArgs) => {
      if (!signal.aborted) fn(...args);
    };
  const emitStages = ifLive(onStages);
  const emitStage = ifLive(onStage);
  let reportedResult = false;
  const emitResult = ifLive((outputs: TOutputs) => {
    reportedResult = true;
    onResult(outputs);
  });
  const emitError = ifLive(onError);
  // Two gates guard emitWarning, the one callback that can still fire during
  // teardown: the live gate, which also silences a cancelled run's teardown
  // close (it ends without a delivery signal the same way a finished run's
  // can); and the reportedResult gate, since the notice claims the exchange
  // finished ("Your own results are complete") -- not true of a run that
  // failed, which has already told the operator something stronger through
  // onError.
  const emitWarning = ifLive((message: string) => {
    if (reportedResult) onWarning?.(message);
  });
  // The mid-run notice sink, gated on `signal` alone. The reportedResult gate
  // above is specific to the teardown close: a notice raised before the first
  // round speaks for the run the operator is watching right now, so gating it
  // on a result not yet reached would hold it until after the exchange it
  // describes, or drop it entirely on a run that fails -- exactly the run
  // whose resolved shape the operator most needs to read.
  const emitRunNotice = ifLive((message: string) => onWarning?.(message));

  let acquired: AcquiredExchange;
  try {
    acquired = await acquire({
      signal,
      onStage: emitStage,
      onStages: emitStages,
    });
  } catch (error) {
    // acquire is atomic: it has already torn down anything it built, so there is
    // nothing here for the owner to release. On abort, emitError no-ops. This is
    // the PREPARE phase: acquire runs prepareForExchange, so a prepare-phase
    // OperatorConfigError -- the type whose message is composed only of this
    // party's own configuration -- classifies as the actionable "config" alert
    // rather than the generic retryable "exchange" one; a plain load/transport
    // failure -- and every other prepare-phase UsageError -- stays "exchange".
    emitError({ category: classifyExchangeFailure(error, "prepare"), error });
    return;
  }

  const { peer, conn, psi, prepared } = acquired;
  let mc: MessageConnection | undefined;

  // F4 trigger: drop the broker signaling socket on the first inbound frame,
  // keeping the data channel (already open and bidirectional by the time a frame
  // flows) alive for the exchange. Best-effort and non-throwing: it fires from a
  // PeerJS listener the run's try/finally cannot catch, and a failed early
  // disconnect must not fail an otherwise-successful exchange - the end-of-life
  // latch still drops the peer.
  const dropBrokerOnFirstFrame = () => {
    try {
      peer.disconnect();
    } catch (err) {
      log.error("early broker disconnect failed:", err);
    }
  };

  // Run-once teardown latch (stronger than idempotent): the effect runs exactly
  // once even if the function is invoked twice by a timeout/abort race, and it
  // never throws, so it cannot clobber a more accurate alert.
  let toreDown = false;
  const teardown = async () => {
    if (toreDown) return;
    toreDown = true;
    // A late inbound frame must not fire a stray disconnect post-teardown.
    conn.off("data", dropBrokerOnFirstFrame);
    try {
      if (mc !== undefined) {
        // Flushing close: waits for the peer to take the final outbound frame
        // and detaches the channel listeners. On a run that reported its
        // result, a wait that ends on anything but the peer's close raises the
        // matching operator warning through emitWarning (see
        // openPeerMessageConnection), which is why teardown can emit after the
        // run's terminal event; a failed or cancelled run drains the same
        // close silently.
        await mc.close();
      } else {
        // The wrapper never materialized (abort/timeout before the open await
        // resolved); hard-close the raw channel so a pending open rejects.
        conn.close();
      }
    } catch (err) {
      log.error("teardown: closing the connection failed:", err);
    }
    // disconnect() frees the broker id and leaves the data channel alive by
    // design: the close above waits for the peer to take the final frame, and
    // on its ceiling path the frame can still be in flight (the send/close
    // delivery contract; see docs/COMMUNICATION.md and the Connection interface
    // in core). Do NOT upgrade this to peer.destroy(): it routes through the
    // abrupt RTCPeerConnection.close(), which discards buffered outbound data
    // and would drop the final frame. The local connection is still reaped --
    // via the data channel's native onclose on a clean close, or by
    // ICE-failure detection if the peer vanished.
    try {
      peer.disconnect();
    } catch (err) {
      log.error("teardown: disconnecting the peer failed:", err);
    }
  };

  // Already aborted between acquire resolving and here: addEventListener would
  // never fire post-abort, so tear down what acquire handed us and leave.
  if (signal.aborted) {
    await teardown();
    return;
  }
  const onAbort = () => {
    void teardown();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  conn.once("data", dropBrokerOnFirstFrame);

  try {
    // Fixed order. openPeerMessageConnection attaches the QueuedMessageConnection's
    // inbound `data` listener synchronously in its constructor (the server's
    // listener-first guarantee, F6), so the initiator's first frame -- its
    // handshake frame -- is buffered rather than dropped no matter how long
    // this side then takes to read it.
    mc = await openPeerMessageConnection(conn, {
      onCloseOutcome: (outcome) => {
        const warning = CLOSE_OUTCOME_WARNINGS[outcome];
        if (warning !== undefined) emitWarning(warning);
      },
      // The run's signal reaches the transport only here: it is what lets a
      // cancel cut the clean close's wait for the peer, whose duration is
      // otherwise the peer's to choose up to the ceiling.
      signal,
    });
    // Authenticate the peer before any PSI frame is sent: the P-256 key exchange
    // fails closed on a wrong secret or tampered/malformed frame, so an
    // unauthenticated peer never reaches runExchange. Its 32-byte session key is
    // discarded here (web is single-use and, under DTLS, declines the AEAD wrap --
    // see authenticateExchange); deriving it is the act of authenticating. A
    // trust failure is a security-kind ConnectionError, routed by the catch
    // below to the distinct authentication-failure alert.
    //
    // This runs BEFORE `await psi`: the handshake needs no PSI library, and
    // authenticating first keeps the responder's WASM load out of the handshake's
    // critical path -- a load that approached the per-message kex timeout could
    // otherwise time out the initiator's wait for the responder's reply -- and
    // spends no WASM load on a peer that fails authentication.
    await authenticateExchange(mc, exchangeRole, sharedSecret, expires);
    // Resolves before runExchange: instant for the initiator (it loaded the
    // library during acquire), the real WASM wait for the responder, overlapping
    // the wait for the peer's first PSI frame.
    const psiLibrary = await psi;
    const result = await runExchange(mc, exchangeRole, prepared, {
      psiLibrary,
      // Run the PSI masking in a Web Worker off the UI thread, so the tab stays
      // responsive and the WebRTC peer keepalives keep firing during a round.
      // runExchange disposes this engine on every exchange-end path
      // (success, error, abort), which terminates the worker -- no leak. psiLibrary
      // above stays the in-process fallback core requires; the worker loads its own.
      psiEngineFactory: createBrowserPsiEngineFactory(
        defaultSpawnPsiCryptoWorker,
      ),
      onStage: emitStage,
      // What the agreed terms resolved to, named for the operator after the
      // terms exchange and before the first round: a deduplicating cardinality
      // and, where the both-sided one projects a pair table past the advisory
      // bound, what each side contributes to that projection. Core composes both
      // and raises neither -- the advisory is a front end's discretion
      // (docs/spec/PROTOCOL.md, The both-sided expansion has no ceiling of its
      // own) -- so this seat renders them through the same notice slot its
      // transport warnings take, and the owning hook escapes what it folds.
      onProtocolConfirmed: (_partnerTerms, _resolvedRole, runShape) => {
        const { cardinalityNotice, pairTableAdvisory } =
          describeResolvedRunShape(runShape);
        for (const notice of [cardinalityNotice, pairTableAdvisory])
          if (notice !== undefined) emitRunNotice(notice);
      },
    });
    // The privacy-sensitive exchange has succeeded here. A failure building the
    // local results file is an "output" failure, never an "exchange" one, so the
    // user is not told to re-run a PSI exchange that in fact already completed.
    let outputs: TOutputs;
    try {
      outputs = generateOutput(result, prepared);
    } catch (error) {
      emitError({ category: "output", error });
      return;
    }
    emitResult(outputs);
  } catch (error) {
    emitError({ category: classifyExchangeFailure(error, "run"), error });
  } finally {
    signal.removeEventListener("abort", onAbort);
    await teardown();
  }
}
