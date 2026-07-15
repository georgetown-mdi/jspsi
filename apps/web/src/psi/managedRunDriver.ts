/**
 * The browser wiring of a managed (recurring) exchange re-run: it builds the
 * platform seams the pure orchestration in {@link ./managedRun.ts} gates, out of
 * the same building blocks the one-shot flows compose -- the rendezvous, the peer
 * message connection, the authenticated handshake, core's `runExchange`, and the
 * run-outputs builder -- with the durable rotate-and-persist interposed between
 * the handshake and the data exchange (the persist-before-success ordering
 * {@link runManagedRerun} inherits from {@link runManagedExchange}).
 *
 * It reuses the one-shot flows' primitives rather than their hooks: the one-shot
 * `runExchangeLifecycle` bundles the handshake and the data exchange into one
 * unit with no seam to persist the rotated secret between them, so a managed
 * re-run cannot drive it directly. The shared primitives it composes
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

import { loadPsiBackend, runExchange } from "@psilink/core";

import { buildRunOutputs } from "@bench/runOutputs";

import { acquireValidatedManagedInput } from "./managedInputHandle";
import { authenticateExchange } from "./authenticateExchange";
import { beginManagedRendezvous } from "./managedRendezvous";
import { createBrowserPsiEngineFactory } from "./psiCryptoController";
import { defaultSpawnPsiCryptoWorker } from "./psiCryptoWorkerClient";
import { openPeerMessageConnection } from "./peerMessageConnection";
import { prepareManagedRerunExchange } from "./managedPreparedExchange";
import { runManagedRerun } from "./managedRun";
import { waitForIncomingConnection } from "./waitForConnection";

import type { HandshakeRole, MessageConnection } from "@psilink/core";
import type { DataConnection } from "peerjs";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";
import type Peer from "peerjs";

import type { ObjectUrls, RunOutputs } from "@bench/runOutputs";

import type { ManagedExchangeRecord } from "./managedExchangeRecord";
import type { ManagedExchangeRunResult } from "./managedExchangeRun";
import type { ManagedInputSource } from "./managedInputHandle";
import type { ManagedRerunOptions } from "./managedRun";

/** This party's PSI/handshake role for its `side`: the inviter listens (the PSI
 * responder), the acceptor dials (the PSI initiator) -- the same mapping the
 * one-shot flows assign. */
const HANDSHAKE_ROLE_FOR_SIDE: Record<
  ManagedExchangeRecord["side"],
  HandshakeRole
> = {
  inviter: "responder",
  acceptor: "initiator",
};

/** What the input phase yields to the handshake: the prepared exchange bound to
 * this run's freshly-read rows, before any connection. */
interface ManagedRerunInput {
  prepared: ReturnType<typeof prepareManagedRerunExchange>;
}

/** The carried value the handshake phase hands the data exchange through the lock:
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
   * so a run already in progress elsewhere surfaces the benign state). */
  options?: ManagedRerunOptions;
}

/**
 * Run a managed exchange re-run to completion in the browser, returning the
 * exchange result (the run outputs) and the `succeeded` `lastRun` this run
 * stamped. Composes the pre-connection checks, the side-dispatched rendezvous, the
 * authenticated handshake, the durable rotation persist, the PSI exchange, and the
 * outputs into {@link runManagedRerun}.
 *
 * The benign pre-run states (a lapsed `expires`, an input problem, a run already in
 * progress elsewhere) and the storage tier reject before or without a completed
 * exchange; the caller classifies them through {@link benignRerunOutcome}. A
 * handshake or data-exchange failure propagates unchanged for the caller's generic
 * failure path.
 */
export function runManagedExchangeInBrowser(
  config: ManagedRunDriverConfig,
): Promise<ManagedExchangeRunResult<RunOutputs>> {
  const { record, source, signal, urls } = config;
  const exchangeRole = HANDSHAKE_ROLE_FOR_SIDE[record.side];

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
      // partner, and yield the rotated secret plus the carried exchange resources.
      handshake: async (input) => {
        const psiPromise = loadPsiBackend(
          { loadWasm: () => PSI() as Promise<PSILibrary> },
          { isNode: false },
        ).then((selection) => selection.library);
        // The responder (inviter) attaches its inbound listener before the library
        // resolves, so keep the promise pending and await it after the channel
        // opens; a rejecting load on a torn-down run must not surface unhandled.
        void psiPromise.catch(() => undefined);

        const acquisition = await beginManagedRendezvous(
          record.side,
          record.sharedSecret,
          record.exchangeFile,
          { signal },
        );
        let peer: Peer;
        let conn: DataConnection;
        try {
          if (acquisition.side === "inviter") {
            peer = acquisition.peer;
            conn = await waitForIncomingConnection(peer, { signal });
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
          mc = await openPeerMessageConnection(conn);
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
          // exchange: tear down so a failed run never leaks a registered peer or an
          // open channel.
          await teardown(peer, conn, mc);
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
            },
          );
          return buildRunOutputs(result, carried.prepared, urls);
        } finally {
          await teardown(carried.peer, carried.conn, carried.mc);
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

/** Tear down the run's live resources: drain and close the message connection (or
 * hard-close the raw channel when the wrapper never materialized), then free the
 * broker id. Mirrors the one-shot lifecycle's teardown, never throwing -- a
 * teardown fault must not clobber a more accurate outcome. */
async function teardown(
  peer: Peer,
  conn: DataConnection,
  mc: MessageConnection | undefined,
): Promise<void> {
  try {
    if (mc !== undefined) await mc.close();
    else conn.close();
  } catch (error) {
    log.error("managed re-run teardown: closing the connection failed:", error);
  }
  try {
    peer.disconnect();
  } catch (error) {
    log.error("managed re-run teardown: disconnecting the peer failed:", error);
  }
}
