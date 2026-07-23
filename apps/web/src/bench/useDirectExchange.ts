import { useEffect, useMemo, useRef, useState } from "react";

import { sanitizeForDisplay } from "@psilink/core";

import {
  createFetchJobApiClient,
  createServerJobZeroSetupDriver,
} from "@psi/serverJobExchangeDriver";
import { discardServerJob, writeAttachment } from "@psi/consoleJobAttachment";

import { whenDiagnostic } from "@utils/diagnostics";

import {
  initialRun,
  runWithCompletion,
  runWithFailure,
  runWithStage,
  runWithStages,
} from "./exchangeRun";
import { isExchangeBusyError, reattachOnBusy } from "./reattachOnBusy";
import { failureFor } from "./useInviterExchange";

import type {
  JobInputSource,
  JobRunStatus,
} from "@psi/serverJobExchangeDriver";
import type { DirectTransport } from "./directExchangeModel";
import type { ExchangeDriverEvents } from "@psi/exchangeDriver";
import type { ExchangeErrorCategory } from "@psi/exchangeLifecycle";
import type { ExchangeRun } from "./exchangeRun";
import type { JobZeroSetupLinkageStrategy } from "@jobs/intent";
import type { RunFailure } from "./useInviterExchange";
import type { RunOutputs } from "./runOutputs";

/**
 * The run half of the direct-exchange bench. Unlike the inviter bench, which
 * auto-starts the moment an invitation is minted, a direct exchange starts on an
 * explicit Run press (after the trust affirmation), so this hook exposes an
 * imperative {@link start} rather than an invitation-keyed effect. It always
 * drives the console appliance (a zero-setup server job) -- there is no browser or
 * save-file path -- so it owns no peer connection or PSI library and folds the
 * appliance's SSE stream onto the same {@link ExchangeRun} model the other benches
 * use.
 *
 * The single AbortController is torn down on unmount, carrying NO cancel intent:
 * leaving the page leaves the appliance's run going (the strand-recovery panel is
 * the way back). Only the deliberate paths -- {@link tryAgain} and
 * {@link abandonRun} -- discard the appliance job and free its single slot.
 */
export function useDirectExchange({
  channel,
  inputSource,
  identity,
  linkageStrategy,
}: {
  /** The agreed transport; maps to the zero-setup intent's channel. */
  channel: DirectTransport;
  /** Where the appliance reads this party's input from -- the console picker's
   * mounted-file reference. Undefined until a file is committed; {@link start}
   * refuses to run without it. */
  inputSource: JobInputSource | undefined;
  /** The optional operator label threaded to the CLI's `--identity`, so the
   * previewed identity and the disclosure record's attribution match the run.
   * Omitted when blank. */
  identity?: string;
  /** The optional linkage strategy forwarded to the CLI's `--linkage-strategy`. */
  linkageStrategy?: JobZeroSetupLinkageStrategy;
}): {
  run: ExchangeRun;
  outputs: RunOutputs | undefined;
  failure: RunFailure | undefined;
  warnings: ReadonlyArray<string>;
  started: boolean;
  /** The appliance job id of the current run, once created; undefined before the
   * job exists. Drives the completed-run recurring hand-off panel. */
  jobId: string | undefined;
  /** The live status of the exchange this run re-attached to on a busy (409)
   * create, or undefined on a fresh run. Set when a start-time 409 re-attaches to
   * the exchange holding the appliance's single slot -- the run surface then heads
   * with recovery-style copy rather than fresh-success copy. */
  reattached: JobRunStatus | undefined;
  /** True from the moment a busy (409) create is detected until the liveness probe
   * settles: the interim during which the run surface suppresses the fresh-run
   * framing and shows a brief reconnecting notice, before it either resolves to the
   * recovery view (`reattached`) or falls back to the run's alert. */
  reattaching: boolean;
  start: () => void;
  tryAgain: () => void;
  reset: () => void;
  abandonRun: () => void;
} {
  const [run, setRun] = useState<ExchangeRun>(initialRun);
  const [outputs, setOutputs] = useState<RunOutputs>();
  const [failure, setFailure] = useState<RunFailure>();
  const [warnings, setWarnings] = useState<Array<string>>([]);
  const [started, setStarted] = useState(false);
  // The status of an exchange this run re-attached to on a busy (409) create, else
  // undefined. Drives the run surface's recovery-style copy; reset when a run
  // restarts or is reset.
  const [reattached, setReattached] = useState<JobRunStatus>();
  // True while a detected busy (409) create is being resolved to a re-attachment,
  // before the liveness probe settles. Drives the interim reconnecting notice and
  // the fresh-run framing suppression; reset when a run restarts or is reset.
  const [reattaching, setReattaching] = useState(false);
  // The current run's appliance job id as reactive state (the ref below drives the
  // synchronous discard paths). Set on create, cleared when a run restarts or is
  // reset, so the recurring hand-off panel reads only the live run.
  const [currentJobId, setCurrentJobId] = useState<string>();

  // One job-API client for the deliberate-discard paths (try again, run another);
  // the driver keeps its own default client, both riding the same same-origin
  // fetch seam.
  const jobApiClient = useMemo(() => createFetchJobApiClient(), []);

  // The appliance job id of the current run, stamped by the driver's onJobCreated.
  // Read by tryAgain (to DELETE the failed job before recreating, which
  // reject-until-DELETE would otherwise 409) and abandonRun (to discard on a
  // deliberate leave). Undefined until the first job is created.
  const currentJobIdRef = useRef<string | undefined>(undefined);

  // Drives the run's AbortSignal; the unmount cleanup aborts it so an in-flight
  // stream stops being consumed. It carries no cancel intent, matching the
  // inviter path: the appliance keeps running and the recovery panel is the way
  // back.
  const abortRef = useRef<AbortController | undefined>(undefined);
  useEffect(
    () => () => {
      abortRef.current?.abort();
      abortRef.current = undefined;
    },
    [],
  );

  function start() {
    // Guard re-entry: a run in flight owns the AbortController; starting a second
    // would orphan the first's signal and race two folds. tryAgain clears the ref
    // first.
    if (abortRef.current) return;
    if (inputSource === undefined) return;
    const controller = new AbortController();
    abortRef.current = controller;

    setStarted(true);
    setRun(initialRun());
    setOutputs(undefined);
    setFailure(undefined);
    setWarnings([]);
    setCurrentJobId(undefined);
    setReattached(undefined);
    setReattaching(false);

    const transport = { channel } as const;
    const driver = createServerJobZeroSetupDriver({
      transport,
      inputSource,
      ...(identity !== undefined ? { identity } : {}),
      ...(linkageStrategy !== undefined ? { linkageStrategy } : {}),
      // Persist the created job's id so a reload or hard tab close can re-attach,
      // and track it for the deliberate-discard paths. The strand-recovery record
      // carries a seat only to label the re-attached run's waiting stage; a direct
      // exchange is symmetric, and "Waiting for your partner" reads correctly for
      // it, so it rides the inviter seat rather than widening the seat union.
      onJobCreated: (jobId) => {
        currentJobIdRef.current = jobId;
        setCurrentJobId(jobId);
        writeAttachment({ jobId, seat: "inviter", channel });
      },
    });

    // Raise a failure's alert and freeze the run: the terminal path for every
    // error except a busy (409) create, which re-attaches below instead.
    const raiseFailure = (category: ExchangeErrorCategory, error: unknown) => {
      setFailure(failureFor(category, error, inputSource, channel));
      setRun((current) => runWithFailure(current));
    };

    // The run's lifecycle callbacks, built once so a busy (409) re-attach folds
    // the already-running exchange's stream onto the SAME surface. A busy create
    // at start re-attaches to the exchange holding the appliance's single slot
    // (recovery-style copy, `reattached`) rather than dead-ending on the "already
    // running" alert; every other failure raises its alert.
    const runEvents: ExchangeDriverEvents<RunOutputs> = {
      signal: controller.signal,
      onStages: (stages) => setRun((current) => runWithStages(current, stages)),
      onStage: (stageId) =>
        setRun((current) => runWithStage(current, stageId, new Date())),
      onResult: (generated) => {
        setOutputs(generated);
        setRun((current) => runWithCompletion(current, new Date()));
      },
      // Server/CLI-controlled text sanitized at this display boundary, like
      // failureFor's alert content; accumulated so no notice displaces an earlier.
      onWarning: (message) =>
        setWarnings((current) => [...current, sanitizeForDisplay(message)]),
      onError: ({ category, error }) => {
        // Dev-gated: the raw error can embed server/CLI-controlled bytes, so a
        // production console carries none of it; the user-facing alert is
        // separately sanitized in failureFor.
        whenDiagnostic(() => console.error(error));
        if (isExchangeBusyError(error)) {
          // Enter the reconnecting interim the instant the 409 is known, before
          // the liveness probe round trip -- this suppresses the fresh-run framing
          // (which would otherwise flash) and announces the reconnect.
          setReattaching(true);
          void reattachOnBusy({
            error,
            client: jobApiClient,
            seat: "inviter",
            channel,
            events: runEvents,
            onReattaching: (id, status) => {
              currentJobIdRef.current = id;
              setCurrentJobId(id);
              setReattaching(false);
              setReattached(status);
            },
          }).then((didReattach) => {
            if (!didReattach) {
              setReattaching(false);
              raiseFailure(category, error);
            }
          });
          return;
        }
        raiseFailure(category, error);
      },
    };

    void driver.run(runEvents);
  }

  // Offered by the retryable-failure alert alone: the run is over (the appliance
  // reconciled a terminal), so a fresh run cannot race it. A server-job retry must
  // DELETE the failed (already-terminal) job before recreating, or reject-until-
  // DELETE 409s the create while the prior run still occupies the single slot.
  function tryAgain() {
    if (failure?.category !== "exchange") return;
    abortRef.current?.abort();
    abortRef.current = undefined;
    const failedJobId = currentJobIdRef.current;
    if (failedJobId !== undefined) {
      currentJobIdRef.current = undefined;
      void discardServerJob(jobApiClient, failedJobId).then(() => start());
      return;
    }
    start();
  }

  // Start over after a terminal, non-retryable failure (a terms mismatch or any
  // other non-output stop). Unlike tryAgain it does NOT restart -- the operator
  // returns to the file step to begin afresh -- so it clears started/failure/outputs
  // (re-enabling Run and unlocking the stepper) AND discards the terminal job through
  // the same seam tryAgain uses, freeing the appliance's single slot so the fresh run
  // creates rather than 409ing. Clearing abortRef too is essential: start()'s
  // re-entry guard bails while it holds the finished run's controller.
  function reset() {
    abortRef.current?.abort();
    abortRef.current = undefined;
    const jobId = currentJobIdRef.current;
    if (jobId !== undefined) {
      currentJobIdRef.current = undefined;
      void discardServerJob(jobApiClient, jobId);
    }
    setStarted(false);
    setFailure(undefined);
    setOutputs(undefined);
    setRun(initialRun());
    setWarnings([]);
    setCurrentJobId(undefined);
    setReattached(undefined);
    setReattaching(false);
  }

  // Discard the current server-job exchange when the operator deliberately leaves
  // (run another): cancel-if-running, DELETE, clear the recovery record. This is
  // what frees the appliance's single slot for the next exchange. Fire-and-forget
  // -- the caller navigates away -- and a no-op before any job exists.
  function abandonRun() {
    const jobId = currentJobIdRef.current;
    if (jobId === undefined) return;
    currentJobIdRef.current = undefined;
    void discardServerJob(jobApiClient, jobId);
  }

  return {
    run,
    outputs,
    failure,
    warnings,
    started,
    jobId: currentJobId,
    reattached,
    reattaching,
    start,
    tryAgain,
    reset,
    abandonRun,
  };
}
