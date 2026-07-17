import {
  ConnectionError,
  OperatorConfigError,
  getLogger,
  runExchange,
} from "@psilink/core";

import { authenticateExchange } from "./authenticateExchange";
import { createBrowserPsiEngineFactory } from "./psiCryptoController";
import { defaultSpawnPsiCryptoWorker } from "./psiCryptoWorkerClient";
import { openPeerMessageConnection } from "./peerMessageConnection";

import type { DataConnection } from "peerjs";
import type Peer from "peerjs";

import type {
  ExchangeResult,
  MessageConnection,
  PreparedExchange,
  ProcessState,
} from "@psilink/core";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

const log = getLogger("exchangeLifecycle");

/** A single rendered stage in the progress UI (a superset of core's
 * `ExchangeStageDefinition`, adding the UI {@link ProcessState}). */
export interface StageDefinition {
  id: string;
  label: string;
  state: ProcessState;
}

/** Which half of the lifecycle a failure came from, so the UI can choose its
 * alert: an `"exchange"` failure (acquire/open/run) invites a re-run, whereas an
 * `"output"` failure means the privacy-sensitive exchange already succeeded and
 * only local results-file generation failed - the user must not re-run it. A
 * `"security"` failure is the trust-boundary subset of an exchange failure: the
 * authenticated key exchange (or, once it is wrapped, the AEAD layer) reported a
 * wrong secret, tamper, or replay, so the user must NOT silently re-run it -- it
 * is surfaced as an authentication failure rather than a retryable transport
 * drop. A `"config"` failure is an {@link OperatorConfigError} raised during the
 * PREPARE phase (inside `acquire`, before any peer connection): a prepare-time
 * fault whose message names only this party's OWN configuration -- today an
 * authored standardization that contradicts the linkage terms. Not a transport
 * drop, so retrying as-is fails identically; the message is actionable and safe to
 * surface. It is scoped to that base type, NOT to any prepare-phase `UsageError`:
 * a sibling guard whose message can embed partner-influenced column names (the
 * accept side's payload-send disclosure check) stays a plain `UsageError` and lands
 * in the generic (message-swallowing) `"exchange"` alert. Keying on the type lets
 * a future local-config check -- e.g. the disclosure-commitment drift a recurring
 * web exchange reaches -- join the `config` alert by extending `OperatorConfigError`
 * at its throw site, with no change here. `"exchange"` and `"output"` are
 * owner-local discriminants (an output-generation failure is not a connection
 * error). */
export type ExchangeErrorCategory =
  "exchange" | "output" | "security" | "config";

/** Maps a lifecycle failure to the alert {@link ExchangeErrorCategory} the UI
 * shows, given the `phase` it came from. A `security`-kind {@link ConnectionError}
 * -- the authenticated key exchange failing closed on a wrong secret/tamper/replay
 * -- is a trust failure the user must not silently retry; every other failure is
 * the retryable generic `"exchange"`. (An `"output"` failure is classified at its
 * own call site, since the exchange already succeeded there.) Keying off the
 * connection-error kind rather than the handshake step means a future
 * `EncryptedMessageConnection` surfacing a `security` failure mid-exchange is
 * routed the same way for free. An {@link OperatorConfigError} is classified
 * `config` ONLY in the `"prepare"` phase, which runs `prepareForExchange`. Both
 * discriminants are structural: the TYPE narrows it to a prepare-phase fault whose
 * message is composed only of local config (see `OperatorConfigError`), keeping
 * the partner-influenceable payload-send `UsageError` out of the message-surfacing
 * alert; the PHASE keeps an `OperatorConfigError` surfacing mid-`"run"` (none does
 * today) from being mislabeled -- neither is a prose claim about what the other
 * half throws. */
function classifyExchangeFailure(
  error: unknown,
  phase: "prepare" | "run",
): ExchangeErrorCategory {
  if (phase === "prepare" && error instanceof OperatorConfigError)
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

/** The seams an {@link Acquire} drives while it loads/prepares and draws in the
 * peer. All no-op once the owner's signal aborts. */
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

/** Fields common to both shapes of {@link ExchangeOutputs}. */
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
 * downloads. `resultWithheld` is necessarily absent/false here. */
interface ReceivedExchangeOutputs extends ExchangeOutputsBase {
  /** The matched results (CSV), as an object URL the UI exposes as a download. */
  resultsUrl: string;
  resultWithheld?: false;
}

/** A non-receiving helper's outputs: no results file, only the optional record
 * downloads. The exchange withheld the result table from this party (its agreed
 * terms give it no output; `ExchangeResult.associationTable` is undefined), so the
 * UI shows that it contributed to the match but receives no result table, rather
 * than an empty CSV that reads like a zero-match run. `resultsUrl` is necessarily
 * absent here. */
interface WithheldExchangeOutputs extends ExchangeOutputsBase {
  resultWithheld: true;
  resultsUrl?: undefined;
}

/** The downloadable artifacts produced after a successful exchange: each is an
 * object URL the UI exposes as a download with a timestamped filename. The matched
 * result is present XOR withheld, so the two cases are a discriminated union rather
 * than two independent optionals -- the invalid states ("both a result and
 * withheld", "neither") are unrepresentable. */
export type ExchangeOutputs = ReceivedExchangeOutputs | WithheldExchangeOutputs;

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
   * exchange the owner runs at the `mc` seam before `runExchange`. Both peers
   * must hold the same value; a mismatch fails the handshake closed and never
   * reaches the PSI exchange. */
  sharedSecret: string;
  /** The invitation's `expires` (ISO 8601), if it carries one, threaded
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
 *   surfaces no alert - the results are available and it is not user-actionable.
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
 *   owner-driven seam no-ops once aborted, so no setState fires after unmount on
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
  } = options;

  // Every owner-driven React seam is a no-op once the signal aborts, so an
  // unmount that lands in the same tick as a resolving stage/result/error
  // cannot setState on an unmounted component.
  const ifLive =
    <TArgs extends Array<unknown>>(fn: (...args: TArgs) => void) =>
    (...args: TArgs) => {
      if (!signal.aborted) fn(...args);
    };
  const emitStages = ifLive(onStages);
  const emitStage = ifLive(onStage);
  const emitResult = ifLive(onResult);
  const emitError = ifLive(onError);

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
    // the PREPARE phase: acquire runs prepareForExchange, whose local-config faults
    // (an OperatorConfigError -- today a standardization contradicting its terms)
    // surface as an actionable "config" alert rather than the generic retryable
    // "exchange" one; a plain load/transport failure -- and every other
    // prepare-phase UsageError -- stays "exchange".
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
        // Flushing close: drains the final outbound frame and detaches the
        // channel listeners. This is the teardown-exclusive effect.
        await mc.close();
      } else {
        // The wrapper never materialized (abort/timeout before the open await
        // resolved); hard-close the raw channel so a pending open rejects.
        conn.close();
      }
    } catch (err) {
      log.error("teardown: closing the connection failed:", err);
    }
    // disconnect() frees the broker id but deliberately leaves the data channel
    // alive so the flushing close above can finish draining the final frame to
    // the peer (the send/close delivery contract; see docs/COMMUNICATION.md and
    // the Connection interface in core). Do NOT "upgrade" this to peer.destroy():
    // destroy() routes through the abrupt RTCPeerConnection.close(), which
    // discards buffered outbound data and would drop the final frame. The local
    // connection is reaped without it - via the data channel's native onclose on
    // a clean close, or by ICE-failure detection if the peer vanished.
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
    // listener-first guarantee, F6), so the initiator's unprompted first frame --
    // now its first handshake frame -- is buffered rather than dropped no matter
    // how long this side then takes to read it.
    mc = await openPeerMessageConnection(conn);
    // Authenticate the peer before any PSI frame is sent: the X25519 key exchange
    // fails closed on a wrong secret or tampered/malformed frame, so an
    // unauthenticated peer never reaches runExchange. Its 32-byte session key is
    // discarded here (web is single-use and, under DTLS, declines the AEAD wrap --
    // see authenticateExchange); deriving it is the act of authenticating. A trust
    // failure surfaces as a security-kind ConnectionError, which the catch below
    // routes to the distinct authentication-failure alert.
    //
    // This runs BEFORE `await psi`: the handshake needs no PSI library, and
    // authenticating first keeps the responder's WASM load out of the handshake's
    // critical path -- otherwise a load that approached the per-message kex
    // timeout could time out the initiator's wait for the responder's reply -- and
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
