/**
 * The browser wiring of a managed (recurring) exchange re-run: it builds the
 * platform boundary the pure orchestration in {@link ./managedRun.ts} gates,
 * out of the same building blocks the one-shot flows compose -- the
 * rendezvous, the peer message connection, the authenticated handshake,
 * core's `runExchange`, and the run-outputs builder -- with the durable
 * rotate-and-persist interposed between the handshake and the data exchange
 * (the persist-before-success ordering {@link runManagedRerun} inherits from
 * {@link runManagedExchange}).
 *
 * It reuses the one-shot flows' primitives rather than their hooks: the one-shot
 * `runExchangeLifecycle` bundles the handshake and the data exchange into one
 * unit with no call site to persist the rotated secret between them, so a
 * managed re-run cannot drive it directly. The shared primitives it composes
 * ({@link openPeerMessageConnection}, {@link authenticateExchange},
 * {@link runExchange}, {@link buildRunOutputs}) are standalone, so this composes
 * them with the rotation interposed and the one-shot flows are untouched.
 *
 * The PSI/handshake role is the side's, mirroring the one-shot flows: the inviter
 * is the responder (it listens), the acceptor the initiator (it dials). The
 * rotated secret the persist-before-success write advances is the handshake's
 * {@link AuthResult.rotatedSecret}; the current stored secret is what authenticates
 * and derives the rendezvous id, fresh this run.
 */

import log from "loglevel";

// @ts-ignore this is really there
import PSI from "@openmined/psi.js/psi_wasm_web";

import {
  describeResolvedRunShape,
  loadPsiBackend,
  runExchange,
} from "@psilink/core";

import { buildRunOutputs } from "./runOutputs";

import { CLOSE_OUTCOME_WARNINGS } from "./exchangeLifecycle";
import { HANDSHAKE_ROLE_FOR_SIDE } from "./handshakeRole";
import { acquireValidatedManagedInput } from "./managedInputHandle";
import { appendDisclosureRecordToStore } from "./disclosureAccountingStore";
import { authenticateExchange } from "./authenticateExchange";
import { beginManagedRendezvous } from "./managedRendezvous";
import { createBrowserPsiEngineFactory } from "./psiCryptoController";
import { defaultSpawnPsiCryptoWorker } from "./psiCryptoWorkerClient";
import { openPeerMessageConnection } from "./peerMessageConnection";
import { prepareManagedRerunExchange } from "./managedPreparedExchange";
import { runManagedRerun } from "./managedRun";
import { waitForIncomingConnection } from "./waitForConnection";

import type { BuiltExchangeRecord, MessageConnection } from "@psilink/core";
import type { DataConnection } from "peerjs";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";
import type Peer from "peerjs";

import type { ObjectUrls, RunOutputs } from "./runOutputs";

import type { ManagedExchangeRecord } from "./managedExchangeRecord";
import type { ManagedExchangeRunResult } from "./managedExchangeRun";
import type { ManagedInputSource } from "./managedInputHandle";
import type { ManagedRerunOptions } from "./managedRun";
import type { PeerCloseOutcome } from "./waitForPeerClose";

/** What the input phase yields to the handshake: the prepared exchange bound to
 * this run's freshly-read rows, before any connection. */
interface ManagedRerunInput {
  prepared: ReturnType<typeof prepareManagedRerunExchange>;
}

/** The held value the handshake phase hands the data exchange through the lock:
 * the open message connection, the resolved PSI library, the prepared exchange, and
 * the live peer/channel for teardown. */
interface ManagedRerunCarried {
  mc: MessageConnection;
  psiLibrary: PSILibrary;
  peer: Peer;
  conn: DataConnection;
  prepared: ReturnType<typeof prepareManagedRerunExchange>;
}

/** How a re-run reads its input this run, and how it is attended. `source` is the
 * per-run input (a persisted handle or a re-selected file); the wiring reads and
 * validates it through {@link acquireValidatedManagedInput} before any
 * connection. */
export interface ManagedRunDriverConfig {
  /** The stored record to run from. Its `side` dispatches the rendezvous, its
   * current `sharedSecret` authenticates and derives the peer id, and its
   * `exchangeFile` supplies the terms (the connection block is read only for the
   * webrtc dispatchability check -- the signaling location is the app's own; see
   * {@link beginManagedRendezvous}). */
  record: ManagedExchangeRecord;
  /** The per-run input source: read through the persisted handle (attended may
   * prompt once for a gone permission), or an operator-re-selected file. Its
   * contents are never taken from the record. */
  source: ManagedInputSource;
  /** Cancels the rendezvous, the connection, and the exchange on unmount. */
  signal: AbortSignal;
  /** The object-URL boundary the outputs are built through -- `window.URL` in the
   * app, a recording fake in tests. */
  urls: ObjectUrls;
  /** Injected clock and lock discipline (the attended path sets `lock.ifAvailable`
   * so a run already in progress elsewhere shows the benign state), plus the
   * `onDataExchangeStart` phase-boundary report a caller classifying the failure
   * for display reads. */
  options?: ManagedRerunOptions;
  /** How long this run waits for the partner's runner before giving up on it as
   * a no-show, overriding the flows' shared human-timescale ceiling. A scheduled
   * run sets it so its wait ends at the agreed window's close: reaching the close
   * as a no-show is what the window's own bookkeeping reads, whereas cutting the
   * wait with the run's abort signal would record the operator's cancellation
   * instead ({@link ./managedRun.ts}, `rerunFailureLastRun`). Absent, both flows
   * keep their default budget. */
  peerWaitTimeoutMs?: number;
  /** A non-fatal, operator-relevant notice raised mid-run, from three sources: what
   * the agreed terms resolved to ({@link describeResolvedRunShape}); the clean
   * close ending on an exit with no delivery signal ({@link CLOSE_OUTCOME_WARNINGS});
   * and {@link DISCLOSURE_NOT_FILED_WARNING}. Optional: a caller with no notice
   * surface omits it and all are dropped. Never a terminal -- the run still settles
   * exactly once, and a notice from the teardown's close can arrive after it. */
  onWarning?: (message: string) => void;
}

/**
 * Run a managed exchange re-run to completion in the browser, returning the run
 * outputs and the `succeeded` `lastRun` this run stamped. Composes the
 * pre-connection checks, the side-dispatched rendezvous, the authenticated
 * handshake, the durable rotation persist, the PSI exchange, and the outputs
 * into {@link runManagedRerun}.
 *
 * The benign pre-run states (a lapsed `expires`, an input problem, a run already
 * in progress elsewhere) and the storage tier reject before or without a
 * completed exchange; the caller classifies them through
 * {@link benignRerunOutcome}. A handshake or data-exchange failure propagates
 * unchanged for the caller's generic failure path.
 */
export function runManagedExchangeInBrowser(
  config: ManagedRunDriverConfig,
): Promise<ManagedExchangeRunResult<RunOutputs>> {
  const { record, source, signal, urls, onWarning, peerWaitTimeoutMs } = config;
  const exchangeRole = HANDSHAKE_ROLE_FOR_SIDE[record.side];

  // Two gates on the notices this run's close can raise. This run's own outputs
  // must be built: both notices speak for a completed exchange, and the failed
  // handshake's teardown drains a close whose wait ends the same way, on a run
  // that has already shown something stronger. And the run must still be live:
  // a cancelled run's teardown ends its close the same way too, and a partner
  // notice on a run the operator stopped is noise.
  let builtOutputs = false;
  const emitCloseWarning = (outcome: PeerCloseOutcome) => {
    const warning = CLOSE_OUTCOME_WARNINGS[outcome];
    if (warning === undefined || !builtOutputs || signal.aborted) return;
    onWarning?.(warning);
  };

  // The pre-round notice sink, which takes the live gate alone. The outputs gate
  // above belongs to the close: a notice raised before the first round speaks for
  // the run itself, so holding it until the outputs exist would put it after the
  // exchange it describes, and dropping it on a run that failed would lose it on
  // exactly the run whose resolved shape has to be readable afterwards.
  const emitRunNotice = (message: string) => {
    if (signal.aborted) return;
    onWarning?.(message);
  };

  return runManagedRerun<ManagedRerunInput, ManagedRerunCarried, RunOutputs>(
    record,
    {
      // The input is acquired and its columns validated against the standing terms
      // BEFORE any connection; its contents are never taken from the record. The
      // acquired rows ride the same single parse the column guard ran on, so the
      // input is read and parsed exactly once per run.
      acquireInput: async () => {
        const acquired = await acquireValidatedManagedInput(
          record.exchangeFile,
          source,
        );
        const prepared = prepareManagedRerunExchange(
          record.exchangeFile,
          acquired.rows,
          acquired.columns,
        );
        return { prepared };
      },
      // Inside the lock: open the side-dispatched rendezvous, authenticate the
      // partner, and yield the rotated secret plus the held exchange resources.
      handshake: async (input) => {
        const psiPromise = loadPsiBackend(
          { loadWasm: () => PSI() as Promise<PSILibrary> },
          { isNode: false },
        ).then((selection) => selection.library);
        // The responder (inviter) attaches its inbound listener before the library
        // resolves, so keep the promise pending and await it after the channel
        // opens; a rejecting load on a torn-down run must not go unhandled.
        void psiPromise.catch(() => undefined);

        const acquisition = await beginManagedRendezvous(
          record.side,
          record.sharedSecret,
          record.exchangeFile,
          {
            signal,
            ...(peerWaitTimeoutMs !== undefined ? { peerWaitTimeoutMs } : {}),
          },
        );
        let peer: Peer;
        let conn: DataConnection;
        try {
          if (acquisition.side === "inviter") {
            peer = acquisition.peer;
            conn = await waitForIncomingConnection(peer, {
              signal,
              ...(peerWaitTimeoutMs !== undefined
                ? { timeoutMs: peerWaitTimeoutMs }
                : {}),
            });
          } else {
            peer = acquisition.peer;
            conn = acquisition.conn;
          }
        } catch (error) {
          acquisition.peer.destroy();
          throw error;
        }

        // Closure-scoped so the catch's teardown reads whatever the try assigned:
        // a failure AFTER the wrapper opened (a failed authentication) drains it
        // through mc.close(), and only a pre-open failure hard-closes the raw
        // channel -- the same at-call-time read the one-shot lifecycle's teardown
        // uses.
        let mc: MessageConnection | undefined;
        try {
          // The signal is what lets a cancel cut the clean close's wait for the
          // peer, on this teardown and on the data exchange's: without it the
          // wait stands until the peer takes the final frame or the ceiling
          // expires, a duration the peer chooses.
          mc = await openPeerMessageConnection(conn, {
            onCloseOutcome: emitCloseWarning,
            signal,
          });
          // record.expires stays enforced at the handshake (core's pre- and
          // post-handshake guards), covering a bound that lapses between the
          // pre-connection expiry check and here; the orchestration re-maps that
          // failure to the benign expiry state (see runManagedRerun).
          const auth = await authenticateExchange(
            mc,
            exchangeRole,
            record.sharedSecret,
            record.expires,
          );
          const psiLibrary = await psiPromise;
          const carried: ManagedRerunCarried = {
            mc,
            psiLibrary,
            peer,
            conn,
            prepared: input.prepared,
          };
          return { rotatedSecret: auth.rotatedSecret, handshake: carried };
        } catch (error) {
          // The handshake failed after the channel opened but before the data
          // exchange: tear down so a failed run never leaks a registered peer or
          // an open channel. Started, not awaited: awaiting the drain here would
          // hold the single-writer lock over this record for a duration the
          // partner picks (see {@link teardown}), so the failure below is what
          // the run reports; the drain still runs to completion on its own.
          void teardown(peer, conn, mc);
          throw error;
        }
      },
      // After the durable persist and the lock release: run the PSI exchange, build
      // the outputs, and tear down regardless of outcome.
      dataExchange: async (carried) => {
        try {
          const result = await runExchange(
            carried.mc,
            exchangeRole,
            carried.prepared,
            {
              psiLibrary: carried.psiLibrary,
              psiEngineFactory: createBrowserPsiEngineFactory(
                defaultSpawnPsiCryptoWorker,
              ),
              // What the agreed terms resolved to, raised here as for every other
              // seat: an unattended re-run is where an unnoticed widening of the
              // match matters most, since nobody is watching and the terms are a
              // standing record. Core composes both strings and raises neither --
              // that is a front end's discretion (docs/spec/PROTOCOL.md, "The
              // both-sided expansion has no ceiling of its own") -- so they take
              // this wiring's own notice slot.
              onProtocolConfirmed: (_partnerTerms, _resolvedRole, runShape) => {
                const { cardinalityNotice, pairTableAdvisory } =
                  describeResolvedRunShape(runShape);
                for (const notice of [cardinalityNotice, pairTableAdvisory])
                  if (notice !== undefined) emitRunNotice(notice);
              },
            },
          );
          const outputs = buildRunOutputs(result, carried.prepared, urls);
          builtOutputs = true;
          // The disclosure has happened, so its record is appended to this
          // exchange's accounting BEFORE the run reports its outputs: an
          // unattended run has nobody to take the completion download, and an
          // attended one can have its tab closed on the completion screen.
          // Awaited, unlike the teardown below, because it is a local write of
          // bounded duration rather than a wait the partner's peer controls.
          await appendDisclosure(record.id, result.audit, onWarning);
          return outputs;
        } finally {
          // Started, not awaited: the clean close inside it waits for the peer
          // to take the final frame, up to its ceiling. Awaiting it would
          // withhold this run's outputs -- and the success bookkeeping behind
          // them -- for a duration the partner picks, so the drain runs on its
          // own while the outputs go to the caller.
          void teardown(carried.peer, carried.conn, carried.mc);
        }
      },
    },
    {
      ...config.options,
      // The abort probe the failure bookkeeping classifies "cancelled" on: an
      // operator-torn-down run is recorded as cancelled, not a transport fault.
      aborted: () => signal.aborted,
    },
  );
}

/** The notice a run raises when its disclosure could not be filed: the exchange
 * itself completed and its results stand, but this browser holds no record of what
 * it disclosed, and the remedy -- downloading the record offered beside the results
 * -- is available only while the completion surface is open. */
export const DISCLOSURE_NOT_FILED_WARNING =
  "This run's disclosure record could not be saved to this exchange's accounting of disclosures. Your results are complete. Download the record file below if you need to keep an account of this disclosure.";

/**
 * Append this run's self-attested exchange record to the exchange's accounting
 * of disclosures. Best-effort by design: the exchange has already happened, so a
 * failed append can neither undo it nor make the run a failure -- it raises the
 * notice instead.
 *
 * A result with no audit appends nothing: core omits the audit only when
 * building the record threw after the exchange already succeeded (see
 * `ExchangeResult`), and that case reaches the operator through the completion
 * surface, which offers no record download either.
 */
async function appendDisclosure(
  id: string,
  audit: BuiltExchangeRecord | undefined,
  onWarning: ((message: string) => void) | undefined,
): Promise<void> {
  if (audit === undefined) return;
  try {
    await appendDisclosureRecordToStore(id, audit.record);
  } catch (error) {
    log.error("managed re-run: filing the disclosure record failed:", error);
    onWarning?.(DISCLOSURE_NOT_FILED_WARNING);
  }
}

/**
 * Tear down the run's live resources: free the broker id, then drain and close
 * the message connection (or hard-close the raw channel when the wrapper never
 * materialized). Never throws -- a teardown fault must not clobber a more
 * accurate outcome -- which is what lets both the failed handshake and the data
 * exchange start it without awaiting it.
 *
 * The disconnect is issued FIRST: neither call site awaits this, so the run's
 * outcome resolves and the single-writer lock releases while the drain is still
 * parked on the close ceiling. Disconnecting first only bounds, not removes, the
 * resulting window: the broker frees the registration in its own socket-close
 * handler one round trip later, and a retry inside that window is refused as
 * taken (docs/spec/WEBRTC_TRANSPORT.md). `disconnect()` drops only the signaling
 * socket and leaves the data channel standing, so the close behind it still
 * waits for the peer to take the final frame (pinned in
 * test/browser/webrtcCloseDelivery.test.ts).
 *
 * Do NOT reach for `peer.destroy()` here: it routes through the abrupt
 * `RTCPeerConnection.close()`, which discards buffered outbound data and would
 * drop that frame.
 */
async function teardown(
  peer: Peer,
  conn: DataConnection,
  mc: MessageConnection | undefined,
): Promise<void> {
  try {
    peer.disconnect();
  } catch (error) {
    log.error("managed re-run teardown: disconnecting the peer failed:", error);
  }
  try {
    if (mc !== undefined) await mc.close();
    else conn.close();
  } catch (error) {
    log.error("managed re-run teardown: closing the connection failed:", error);
  }
}
