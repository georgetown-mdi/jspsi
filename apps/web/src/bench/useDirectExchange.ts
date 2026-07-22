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
import { failureFor } from "./useInviterExchange";

import type { DirectTransport } from "./directExchangeModel";
import type { ExchangeRun } from "./exchangeRun";
import type { JobInputSource } from "@psi/serverJobExchangeDriver";
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
  start: () => void;
  tryAgain: () => void;
  abandonRun: () => void;
} {
  const [run, setRun] = useState<ExchangeRun>(initialRun);
  const [outputs, setOutputs] = useState<RunOutputs>();
  const [failure, setFailure] = useState<RunFailure>();
  const [warnings, setWarnings] = useState<Array<string>>([]);
  const [started, setStarted] = useState(false);

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
        writeAttachment({ jobId, seat: "inviter", channel });
      },
    });

    void driver.run({
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
        setFailure(failureFor(category, error, inputSource, channel));
        setRun((current) => runWithFailure(current));
      },
    });
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
    start,
    tryAgain,
    abandonRun,
  };
}
