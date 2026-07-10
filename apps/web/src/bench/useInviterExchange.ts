import log from "loglevel";

import { useEffect, useRef, useState } from "react";

// @ts-ignore this is really there
import PSI from "@openmined/psi.js/psi_wasm_web";

import {
  buildOutputTable,
  errorMessage,
  loadPsiBackend,
  prepareForExchange,
  sanitizeForDisplay,
  serializeExchangeRecord,
  serializeVerificationKeys,
} from "@psilink/core";

import { inviterExchangeDataSpec } from "@psi/advancedInvite";
import { listenAsInviter } from "@psi/rendezvous";
import { runExchangeLifecycle } from "@psi/exchangeLifecycle";
import { waitForIncomingConnection } from "@psi/waitForConnection";

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

import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import type {
  Acquire,
  ExchangeErrorCategory,
  ExchangeOutputs,
  GenerateOutput,
} from "@psi/exchangeLifecycle";
import type { ExchangeRun } from "./exchangeRun";
import type { GeneratedInvitation } from "@psi/invitation";

/** The bench run's downloadable artifacts: the lifecycle's outputs widened
 * with the matched-row count the completion header states. Present exactly
 * when the result table is (a withheld result has no count to state). */
export type InviterRunOutputs = ExchangeOutputs & {
  matchedRecordCount?: number;
};

/** A failed run, ready to render: the lifecycle's category (which decides the
 * recovery the alert offers) and the operator-facing alert content, composed
 * here so the sanitize-at-the-display-boundary discipline stays beside the
 * error it applies to. */
export interface RunFailure {
  category: ExchangeErrorCategory;
  title: string;
  message: string;
}

function failureFor(
  category: ExchangeErrorCategory,
  error: unknown,
): RunFailure {
  if (category === "output") {
    // The exchange succeeded; only results-file generation failed. The user
    // must not be told to re-run a privacy-sensitive exchange, so unlike the
    // other categories this alert offers no way to run again. Sanitized at
    // the display boundary: the output error is local, but the alert is
    // operator-facing, so escape it like any other.
    return {
      category,
      title: "Results unavailable",
      message:
        "The linkage completed, but generating the results file failed: " +
        sanitizeForDisplay(errorMessage(error)),
    };
  }
  if (category === "config") {
    // A prepare-time fault in the operator's OWN config, safe to surface
    // because an OperatorConfigError's message names only local content (the
    // lifecycle scopes "config" to that type). Not a transport drop: retrying
    // as-is fails identically, so the message -- actionable -- is surfaced and
    // the alert steers back to the settings rather than to a retry.
    return {
      category,
      title: "Could not prepare the exchange",
      message: sanitizeForDisplay(errorMessage(error)),
    };
  }
  if (category === "security") {
    // The authenticated key exchange failed closed: this connection could not
    // be confirmed as the invited partner. Not retryable -- a silent retry
    // would re-run into the same wrong secret, or into a peer that is
    // tampering -- so the copy forbids it and the alert steers to a fresh
    // invitation. The underlying error is dev-gated to the console (below)
    // and deliberately kept out of the alert: the kex failure message is
    // intentionally non-oracular.
    return {
      category,
      title: "Could not verify your partner",
      message:
        "The check that proves the other side holds this invitation's " +
        "secret did not pass. Do not retry; start over with a fresh " +
        "invitation.",
    };
  }
  // Generic, retryable transport/exchange failure. The raw error reads as an
  // internal/developer message and can embed partner-/server-controlled
  // bytes, so the alert uses a fixed, friendly message; the detailed error
  // stays in the dev-gated console.error for diagnosis.
  return {
    category,
    title: "Exchange failed",
    message:
      "The exchange could not be completed - usually a temporary " +
      "connection problem. Your data stayed on your device.",
  };
}

/**
 * The run half of the inviter bench, started the moment the invitation is
 * minted: listen on the invitation's derived id, run the exchange when the
 * partner connects, and surface the downloads. The connection lifecycle
 * (acquire/open/run/teardown, abort in any phase) is {@link runExchangeLifecycle},
 * exactly as the current exchange screen drives it; this hook owns the single
 * AbortController per invitation and folds the lifecycle's events into the
 * bench's pure {@link ExchangeRun} model for the timeline and status panel.
 *
 * A regenerated invitation (a new object after start-over) restarts the whole
 * run: the effect keyed on `invitation` aborts the old lifecycle and starts a
 * fresh one, the bench-side equivalent of the current app keying its exchange
 * subtree by the shared secret.
 */
export function useInviterExchange({
  invitation,
  inviterName,
}: {
  invitation: GeneratedInvitation | undefined;
  inviterName: string;
}): {
  run: ExchangeRun;
  outputs: InviterRunOutputs | undefined;
  failure: RunFailure | undefined;
  tryAgain: () => void;
} {
  const [run, setRun] = useState<ExchangeRun>(initialRun);
  const [outputs, setOutputs] = useState<InviterRunOutputs>();
  const [failure, setFailure] = useState<RunFailure>();

  // Drives the lifecycle's AbortSignal; the effect cleanup below aborts it so
  // an unmount (or a superseded invitation) tears down any in-flight wait or
  // exchange and every owner-driven seam stops firing. The cleanup also
  // clears the ref: under React StrictMode's mount/unmount/mount the start
  // effect re-runs, and a stale aborted controller left in the ref would trip
  // the re-entry guard and the real run would never start.
  const abortRef = useRef<AbortController | undefined>(undefined);

  // Revoke this run's object URLs when they are replaced or the owner
  // unmounts: createObjectURL keeps each Blob alive until revoked, and the
  // verification-keys blob is private material, so it should not outlive the
  // run that backs it.
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

  function start(minted: GeneratedInvitation) {
    // Guard against re-entry: once a run is in flight its AbortController is
    // stored here, and starting a second would orphan the first's signal and
    // race two lifecycles on shared state. A deliberate restart (try again,
    // a new invitation) clears the ref first.
    if (abortRef.current) return;
    const controller = new AbortController();
    abortRef.current = controller;

    setRun(initialRun());
    setOutputs(undefined);
    setFailure(undefined);

    // Pure output-generation half: the current exchange screen's, plus the
    // matched-row count the completion header states. The object URLs are
    // revoked when they are replaced or the bench unmounts (effect above).
    const generateOutput: GenerateOutput<InviterRunOutputs> = (
      result,
      prepared,
    ) => {
      log.info("linkage complete, generating results and record files");
      const jsonUrl = (text: string): string =>
        window.URL.createObjectURL(
          new Blob([text], { type: "application/json" }),
        );
      // The exchange withholds the result table from a party whose agreed
      // terms give it no output (a one-sided exchange where this party is the
      // PSI sender/helper): produce no results file -- the completion panel
      // shows it contributed but receives no result -- while still offering
      // the record downloads below.
      const generated: InviterRunOutputs =
        result.associationTable === undefined
          ? { resultWithheld: true }
          : (() => {
              const { headers, rows } = buildOutputTable(
                result.associationTable,
                prepared.rawRows,
                prepared.metadata,
                result.partnerPayload,
              );
              const csv =
                headers.join(",") +
                "\n" +
                rows.map((r) => r.join(",") + "\n").join("");
              return {
                resultsUrl: window.URL.createObjectURL(
                  new Blob([csv], { type: "text/csv" }),
                ),
                matchedRecordCount: rows.length,
              };
            })();
      // The record downloads are produced only when the audit pair exists;
      // absent if building the record failed after a successful exchange, in
      // which case they are intentionally omitted without a blocking alert.
      // Filenames are timestamped per exchange (the record's own createdAt,
      // made filesystem-safe) so repeated downloads accumulate rather than
      // collide.
      if (result.audit !== undefined) {
        const stamp = result.audit.record.createdAt.replace(/[:.]/g, "-");
        generated.record = {
          recordUrl: jsonUrl(serializeExchangeRecord(result.audit.record)),
          recordFileName: `psilink-record-${stamp}.json`,
          keysUrl: jsonUrl(serializeVerificationKeys(result.audit.keys)),
          keysFileName: `psilink-record-${stamp}.keys.json`,
        };
      }
      return generated;
    };

    // The inviter is the PSI responder: it must attach its inbound listener
    // before the WASM library resolves, so `psi` stays a pending promise here
    // and the lifecycle awaits it late (after the message connection opens).
    const acquire: Acquire = async ({ signal, onStage, onStages }) => {
      const psi = loadPsiBackend(
        { loadWasm: () => PSI() as Promise<PSILibrary> },
        { isNode: false },
      ).then((selection) => selection.library);
      // The owner awaits `psi` late; if connection setup fails or the signal
      // aborts first, that await is never reached. A fire-and-forget handler
      // keeps a rejecting PSI() on a torn-down exchange from surfacing as an
      // unhandled rejection -- the real `await psi` still throws.
      void psi.catch(() => undefined);

      // The exchange runs on the very terms embedded in the token (the
      // acceptor adopts them from the invitation), with this party's authored
      // metadata and standardization threaded in locally -- the same spec
      // assembly the current exchange screen performs, through the same
      // builder that reconciles authored standardization to the terms.
      const prepared = prepareForExchange(
        inviterExchangeDataSpec(minted.linkageTerms, {
          metadata: minted.metadata,
          standardization: minted.standardization,
        }),
        inviterName,
        minted.rawRows,
        minted.columns,
      );
      onStages(stagesFor(prepared));

      onStage(WAITING_STAGE_ID);
      // Listen on the derived inviter id, then await the acceptor's inbound
      // connection. Destroy the peer on a wait failure so acquisition stays
      // atomic (the lifecycle's teardown only ever covers a returned
      // {peer, conn}).
      const peer = await listenAsInviter(minted.sharedSecret, { signal });
      try {
        const conn = await waitForIncomingConnection(peer, { signal });
        return { peer, conn, psi, prepared };
      } catch (error) {
        peer.destroy();
        throw error;
      }
    };

    void runExchangeLifecycle<InviterRunOutputs>({
      acquire,
      exchangeRole: "responder",
      sharedSecret: minted.sharedSecret,
      expires: minted.expires,
      signal: controller.signal,
      generateOutput,
      onStages: (stages) => setRun((current) => runWithStages(current, stages)),
      onStage: (stageId) =>
        setRun((current) => runWithStage(current, stageId, new Date())),
      onResult: (generated) => {
        setOutputs(generated);
        setRun((current) => runWithCompletion(current, new Date()));
      },
      onError: ({ category, error }) => {
        // Dev-gated: the raw Error object's message/cause can embed partner-/
        // server-controlled bytes, so a production console carries none of it,
        // while a developer (or a deployed client with the diagnostics toggle
        // on) keeps the full object. The user-facing alert is separately
        // sanitized in failureFor.
        whenDiagnostic(() => console.error(error));
        setFailure(failureFor(category, error));
        setRun((current) => runWithFailure(current));
      },
    });
  }

  // Start the run the moment an invitation exists -- the bench's partner may
  // open the link right away, so the inviter listens without a Start press,
  // exactly as the current app's post-generate screen does. Keyed on the
  // invitation: a superseded or discarded invitation aborts its run, and a
  // fresh mint after start-over begins a fresh one.
  const startRef = useRef(start);
  startRef.current = start;
  useEffect(() => {
    if (invitation === undefined) {
      // Start-over discarded the invitation: drop the finished run's state so
      // the output URLs are revoked now (the revocation effect's cleanup)
      // rather than lingering until the bench unmounts.
      setRun(initialRun());
      setOutputs(undefined);
      setFailure(undefined);
      return;
    }
    startRef.current(invitation);
    return () => {
      abortRef.current?.abort();
      abortRef.current = undefined;
    };
  }, [invitation]);

  // Offered by the retryable-failure alert alone: the run is over (the
  // lifecycle tore down), so a fresh listen on the same invitation cannot race
  // it, and the same secret stays valid for the partner's original link --
  // the security category instead forces a fresh invitation, and an output
  // failure must not re-run an exchange that already succeeded.
  function tryAgain() {
    if (invitation === undefined || failure?.category !== "exchange") return;
    abortRef.current?.abort();
    abortRef.current = undefined;
    start(invitation);
  }

  return { run, outputs, failure, tryAgain };
}
