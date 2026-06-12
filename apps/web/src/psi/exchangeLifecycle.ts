import { ConnectionError, getLogger, runExchange } from "@psilink/core";

import { authenticateExchange } from "./authenticateExchange";
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
 * drop. It is the one category keyed off {@link ConnectionError} kind
 * (`"security"`); `"exchange"` and `"output"` are owner-local discriminants (an
 * output-generation failure is not a connection error). */
export type ExchangeErrorCategory = "exchange" | "output" | "security";

/** Maps a lifecycle failure to the alert {@link ExchangeErrorCategory} the UI
 * shows. A `security`-kind {@link ConnectionError} -- the authenticated key
 * exchange failing closed on a wrong secret/tamper/replay -- is a trust failure
 * the user must not silently retry; every other exchange-phase failure is the
 * retryable generic `"exchange"`. (An `"output"` failure is classified at its own
 * call site, since the exchange already succeeded there.) Keying off the
 * connection-error kind rather than the handshake step means a future
 * `EncryptedMessageConnection` surfacing a `security` failure mid-exchange is
 * routed the same way for free. */
function classifyExchangeFailure(error: unknown): ExchangeErrorCategory {
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

/** The self-attested record and its private opening data as paired downloads.
 * A single object so the two can never be present apart (mirrors
 * {@link ExchangeResult.audit}, where the record and opening are one field). */
export interface RecordDownloads {
  /** The self-attested exchange record (JSON); safe to retain or share. */
  recordUrl: string;
  /** Download filename for {@link recordUrl}, timestamped per exchange so
   * repeated downloads in one session accumulate an audit trail rather than
   * collide (mirrors the CLI's timestamped default path). */
  recordFileName: string;
  /** The private opening data (JSON); as sensitive as the matched data. */
  openingUrl: string;
  /** Download filename for {@link openingUrl}, timestamped to match
   * {@link recordFileName}. */
  openingFileName: string;
}

/** The downloadable artifacts produced after a successful exchange: the results
 * file plus the self-attested audit record and its private opening data, each an
 * object URL the UI exposes as a download with a timestamped filename. */
export interface ExchangeOutputs {
  /** The matched results (CSV). */
  resultsUrl: string;
  /** The record and opening downloads as a single optional group, present or
   * absent together. Absent only when building the record failed (the exchange
   * still succeeded and the results remain available; see
   * {@link ExchangeResult.audit}). */
  record?: RecordDownloads;
}

/** Pure output-generation step: build the local results file plus the record
 * and opening artifacts from the exchange result and return their URLs. May
 * throw (classified as `"output"`); runs inside the owner after the exchange and
 * before teardown. */
export type GenerateOutput = (
  result: ExchangeResult,
  prepared: PreparedExchange,
) => ExchangeOutputs;

/** Options for {@link runExchangeLifecycle}. */
export interface RunExchangeLifecycleOptions {
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
  generateOutput: GenerateOutput;
  onStages: (stages: Array<StageDefinition>) => void;
  onStage: (stageId: string) => void;
  onResult: (outputs: ExchangeOutputs) => void;
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
export async function runExchangeLifecycle(
  options: RunExchangeLifecycleOptions,
): Promise<void> {
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
    // nothing here for the owner to release. On abort, emitError no-ops.
    emitError({ category: "exchange", error });
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
      onStage: emitStage,
    });
    // The privacy-sensitive exchange has succeeded here. A failure building the
    // local results file is an "output" failure, never an "exchange" one, so the
    // user is not told to re-run a PSI exchange that in fact already completed.
    let outputs: ExchangeOutputs;
    try {
      outputs = generateOutput(result, prepared);
    } catch (error) {
      emitError({ category: "output", error });
      return;
    }
    emitResult(outputs);
  } catch (error) {
    emitError({ category: classifyExchangeFailure(error), error });
  } finally {
    signal.removeEventListener("abort", onAbort);
    await teardown();
  }
}
