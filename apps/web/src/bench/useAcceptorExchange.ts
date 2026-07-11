import log from "loglevel";

import { useEffect, useRef, useState } from "react";

// @ts-ignore this is really there
import PSI from "@openmined/psi.js/psi_wasm_web";

import { loadPsiBackend } from "@psilink/core";

import { dialAsAcceptor } from "@psi/rendezvous";
import { runExchangeLifecycle } from "@psi/exchangeLifecycle";

import { whenDiagnostic } from "@utils/diagnostics";

import {
  WAITING_STAGE_ID,
  initialRun,
  runWithCompletion,
  runWithFailure,
  runWithStage,
  runWithStages,
  stagesFor,
} from "./exchangeRun";
import { buildRunOutputs } from "./runOutputs";
import { failureFor } from "./useInviterExchange";
import { invitationUsable } from "./inviterModel";
import { prepareAcceptorExchange } from "./acceptorExchange";

import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import type {
  AcceptableInvitation,
  AcceptorDataEdits,
} from "@psi/acceptInvitation";
import type { Acquire, GenerateOutput } from "@psi/exchangeLifecycle";
import type { CSVRow } from "@psilink/core";
import type { ExchangeRun } from "./exchangeRun";
import type { RunFailure } from "./useInviterExchange";
import type { RunOutputs } from "./runOutputs";

/** The launch the acceptor commits to on "Start the exchange": the decoded
 * invitation, the committed name recorded in the exchange record, the acquired
 * CSV, and the confirm-columns edits. A fresh object per launch keys the run
 * effect, so a superseded or discarded launch aborts and resets. */
export interface AcceptorLaunch {
  invitation: AcceptableInvitation;
  acceptorName: string;
  rawRows: Array<CSVRow>;
  columns: Array<string>;
  edits: AcceptorDataEdits;
}

/**
 * The run half of the acceptor bench, started the moment the launch appears (the
 * confirm-columns step's "Start the exchange" is the start; no second press).
 * It mirrors {@link useInviterExchange}'s shape -- a single AbortController per
 * run, StrictMode/re-entry guards, the URL-revocation effect, and an effect keyed
 * on the launch so a superseded launch aborts and resets -- with the acceptor's
 * differences re-surfaced from the legacy exchange screen's acceptor role:
 *
 *  - The acceptor is the PSI INITIATOR (`exchangeRole: "initiator"`), and the
 *    WASM library is awaited EARLY (before dialing, to fail fast) -- the inverse
 *    of the inviter's late await.
 *  - It DIALS the inviter's derived id ({@link dialAsAcceptor}), which tears down
 *    its own peer on failure, so no redundant destroy here.
 *  - The prepared exchange adopts the invitation's terms with the committed name
 *    and the confirm-columns edits, and locks in the received-payload columns to
 *    the invitation's disclosed set ({@link prepareAcceptorExchange}).
 *
 * Try again (the retryable "exchange" category only) re-dials the same invitation
 * while it is still usable, exactly like the inviter's re-listen.
 */
export function useAcceptorExchange({
  launch,
}: {
  launch: AcceptorLaunch | undefined;
}): {
  run: ExchangeRun;
  outputs: RunOutputs | undefined;
  failure: RunFailure | undefined;
  tryAgain: () => void;
} {
  const [run, setRun] = useState<ExchangeRun>(() => initialRun("acceptor"));
  const [outputs, setOutputs] = useState<RunOutputs>();
  const [failure, setFailure] = useState<RunFailure>();

  // Drives the lifecycle's AbortSignal; the effect cleanup below aborts it so an
  // unmount (or a superseded launch) tears down any in-flight dial or exchange
  // and every owner-driven seam stops firing. The cleanup also clears the ref:
  // under React StrictMode's mount/unmount/mount the start effect re-runs, and a
  // stale aborted controller left in the ref would trip the re-entry guard and
  // the real run would never start.
  const abortRef = useRef<AbortController | undefined>(undefined);

  // Revoke this run's object URLs when they are replaced or the owner unmounts:
  // createObjectURL keeps each Blob alive until revoked, and the verification-
  // keys blob is private material, so it should not outlive the run that backs it.
  useEffect(() => {
    if (outputs === undefined) return;
    return () => {
      if (outputs.resultsUrl !== undefined)
        window.URL.revokeObjectURL(outputs.resultsUrl);
      if (outputs.record !== undefined) {
        window.URL.revokeObjectURL(outputs.record.recordUrl);
        window.URL.revokeObjectURL(outputs.record.keysUrl);
      }
    };
  }, [outputs]);

  function start(current: AcceptorLaunch) {
    // Guard against re-entry: once a run is in flight its AbortController is
    // stored here, and starting a second would orphan the first's signal and
    // race two lifecycles on shared state. A deliberate restart (try again)
    // clears the ref first.
    if (abortRef.current) return;
    const controller = new AbortController();
    abortRef.current = controller;

    setRun(initialRun("acceptor"));
    setOutputs(undefined);
    setFailure(undefined);

    const { invitation, acceptorName, rawRows, columns, edits } = current;
    const { token, endpoint } = invitation;

    // Output-generation half. The URLs the build creates are revoked when the
    // outputs are replaced or the bench unmounts (effect above); a throw
    // mid-build revokes its own partial URLs (see buildRunOutputs).
    const generateOutput: GenerateOutput<RunOutputs> = (result, prepared) => {
      log.info("linkage complete, generating results and record files");
      return buildRunOutputs(result, prepared, {
        create: (blob) => window.URL.createObjectURL(blob),
        revoke: (url) => window.URL.revokeObjectURL(url),
      });
    };

    // The acceptor is the PSI initiator: it awaits the WASM library EARLY, to
    // fail before dialing, then dials the inviter's derived id. The inverse of
    // the inviter's late await.
    const acquire: Acquire = async ({ signal, onStage, onStages }) => {
      const psi = loadPsiBackend(
        { loadWasm: () => PSI() as Promise<PSILibrary> },
        { isNode: false },
      ).then((selection) => selection.library);

      // The exchange runs on the invitation's terms (adopted with this party's
      // identity), with the confirm-columns edits threaded in locally and the
      // received-payload columns locked to the disclosed set -- the same spec
      // assembly and lock-in the legacy exchange screen performs.
      const prepared = prepareAcceptorExchange({
        linkageTerms: token.linkageTerms,
        acceptorName,
        edits,
        rawRows,
        columns,
        disclosedPayloadColumns: token.disclosedPayloadColumns,
      });
      onStages(stagesFor(prepared, "acceptor"));

      // Fail fast: await the WASM library before dialing, so a WASM-load failure
      // surfaces before this party publishes anything on the wire -- the inverse
      // of the inviter's late await. The owner's later `await psi` on the same
      // (now-resolved) promise is then instant.
      await psi;

      onStage(WAITING_STAGE_ID);
      // Dial the inviter's derived id. dialAsAcceptor tears down its own peer on
      // failure, so acquisition stays atomic without a redundant destroy here.
      const [peer, conn] = await dialAsAcceptor(token.sharedSecret, endpoint, {
        signal,
      });
      return { peer, conn, psi, prepared };
    };

    void runExchangeLifecycle<RunOutputs>({
      acquire,
      exchangeRole: "initiator",
      sharedSecret: token.sharedSecret,
      expires: token.expires,
      signal: controller.signal,
      generateOutput,
      onStages: (stages) => setRun((prev) => runWithStages(prev, stages)),
      onStage: (stageId) =>
        setRun((prev) => runWithStage(prev, stageId, new Date())),
      onResult: (generated) => {
        setOutputs(generated);
        setRun((prev) => runWithCompletion(prev, new Date()));
      },
      onError: ({ category, error }) => {
        // Dev-gated: the raw Error object's message/cause can embed partner-/
        // server-controlled bytes, so a production console carries none of it,
        // while a developer (or a deployed client with the diagnostics toggle
        // on) keeps the full object. The user-facing alert is separately
        // sanitized in failureFor.
        whenDiagnostic(() => console.error(error));
        setFailure(failureFor(category, error));
        setRun((prev) => runWithFailure(prev));
      },
    });
  }

  // Start the run the moment a launch exists -- the columns step's "Start the
  // exchange" is the start, so the acceptor dials without a second press, exactly
  // as the inviter listens on the minted invitation. Keyed on the launch: a
  // superseded or discarded launch aborts its run and resets.
  const startRef = useRef(start);
  startRef.current = start;
  useEffect(() => {
    if (launch === undefined) {
      setRun(initialRun("acceptor"));
      setOutputs(undefined);
      setFailure(undefined);
      return;
    }
    startRef.current(launch);
    return () => {
      abortRef.current?.abort();
      abortRef.current = undefined;
    };
  }, [launch]);

  // Offered by the retryable-failure alert alone: the run is over (the lifecycle
  // tore down), so a fresh dial on the same invitation cannot race it, and the
  // same secret stays valid for the original link -- the security category
  // instead forces a fresh invitation, and an output failure must not re-run an
  // exchange that already succeeded. Gated on the invitation's expiry as well:
  // re-dialing a lapsed credential cannot succeed (no peer can pass it). A token
  // without an `expires` carries no deadline, so it stays retryable.
  function tryAgain() {
    if (launch === undefined || failure?.category !== "exchange") return;
    const expires = launch.invitation.token.expires;
    if (expires !== undefined && !invitationUsable(expires, new Date())) return;
    abortRef.current?.abort();
    abortRef.current = undefined;
    start(launch);
  }

  return { run, outputs, failure, tryAgain };
}
