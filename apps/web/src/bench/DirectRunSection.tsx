import { useEffect, useRef } from "react";

import { Button } from "@mantine/core";

import {
  AnotherExchangeFoot,
  DonePanel,
  DownloadRow,
  FailureAlert,
  RunWarningsAlert,
  SERVER_JOB_KEEP_OPEN_BODY,
  SERVER_JOB_PEER_WINDOW_BODY,
  WithheldResultInset,
} from "./BenchRunSurface";
import { RecurringHandoff } from "./RecurringHandoff";
import { StatusPanel } from "./StatusPanel";
import { awaitingPartner } from "./exchangeRun";
import styles from "./bench.module.css";

import type { ExchangeRun } from "./exchangeRun";
import type { RunFailure } from "./useInviterExchange";
import type { RunOutputs } from "./runOutputs";

/**
 * The direct-exchange run column, through the run's two phases: the running screen
 * (a status panel and the keep-open callout while the appliance conducts the
 * exchange) and the completion panel with the downloads -- the result, and the
 * self-attested disclosure record and its verification keys. Unlike the inviter's
 * run column there is no share phase: a direct exchange mints no invitation, so both
 * parties simply run their halves against the agreed server at once.
 *
 * The appliance carries out the exchange, so leaving the page leaves it running (the
 * strand-recovery panel is the way back); the keep-open callout says so, and the
 * peer-window callout adds that both consoles must run their halves in the same
 * window. A failed run renders the failure alert for its category, each with its one
 * concrete way forward: Try again for a retryable transport fault, Start over for a
 * terms mismatch or any other non-retryable, non-output failure.
 */
export function DirectRunSection({
  run,
  outputs,
  failure,
  warnings,
  jobId,
  onTryAgain,
  onStartOver,
  onAbandon,
}: {
  run: ExchangeRun;
  outputs: RunOutputs | undefined;
  failure: RunFailure | undefined;
  warnings: ReadonlyArray<string>;
  /** The appliance job id of this run, once created. Threads the run's job to the
   * recurring hand-off panel; undefined before the job exists. */
  jobId: string | undefined;
  onTryAgain: () => void;
  onStartOver: () => void;
  /** Discard the current server-job exchange (cancel-if-running + DELETE), fired as
   * the operator leaves for a fresh exchange from the completion workfoot, so the
   * appliance's single slot frees for the next one. */
  onAbandon: () => void;
}) {
  const done = outputs !== undefined;
  const awaiting = awaitingPartner(run);
  // A retryable failure is a transport/exchange fault; the terms mismatch is a
  // config failure, which -- like a security failure -- is not retried as-is but
  // sends the operator back to start over.
  const retryable = failure?.category === "exchange";
  const offersStartOver =
    !retryable && failure !== undefined && failure.category !== "output";

  // Move focus to the heading at completion so the results are read; the failure
  // alert owns focus while a failure shows (FailureAlert focuses itself). Skipped on
  // mount: the bench host already sends focus to the incoming section's heading.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (done) headingRef.current?.focus();
  }, [done]);

  const title = done
    ? "Exchange complete"
    : failure !== undefined
      ? "Exchange stopped"
      : "Exchange in progress";

  return (
    <>
      <h1 tabIndex={-1} ref={headingRef}>
        {title}
      </h1>
      {failure !== undefined && (
        <FailureAlert failure={failure}>
          {retryable && (
            <Button color="red" variant="light" mt="sm" onClick={onTryAgain}>
              Try again
            </Button>
          )}
          {offersStartOver && (
            <Button color="red" variant="light" mt="sm" onClick={onStartOver}>
              Start over
            </Button>
          )}
        </FailureAlert>
      )}
      {/* The keep-open callout stands through the whole running run: the appliance
          conducts the exchange, so leaving does not stop it (the recovery panel is
          the way back). The peer-window callout adds, only while the run still waits
          for the partner, that both consoles must run their halves at once. Both
          drop the moment the run finishes or fails. */}
      {!done && failure === undefined && (
        <div className={styles.callout}>
          <p className={styles.calloutLead}>Keep this tab open.</p>
          <p className={styles.small}>{SERVER_JOB_KEEP_OPEN_BODY}</p>
          {awaiting && (
            <p className={styles.small}>{SERVER_JOB_PEER_WINDOW_BODY}</p>
          )}
        </div>
      )}
      {outputs !== undefined && (
        <DonePanel
          matchedRecordCount={outputs.matchedRecordCount}
          finishedAt={run.finishedAt}
        />
      )}
      <RunWarningsAlert warnings={warnings} />
      <StatusPanel run={run} done={done} halted={failure !== undefined} />
      {outputs !== undefined && (
        <>
          <h2>Downloads</h2>
          {outputs.resultWithheld === true ? (
            <WithheldResultInset />
          ) : (
            <DownloadRow
              label="Download result"
              href={outputs.resultsUrl}
              fileName="results.csv"
            />
          )}
          {outputs.record !== undefined && (
            <>
              <DownloadRow
                label="Download record (safe to share)"
                href={outputs.record.recordUrl}
                fileName={outputs.record.recordFileName}
              />
              <DownloadRow
                label="Download verification keys"
                caveat="keep private"
                href={outputs.record.keysUrl}
                fileName={outputs.record.keysFileName}
              />
            </>
          )}
        </>
      )}
      {done && jobId !== undefined && <RecurringHandoff jobId={jobId} />}
      {(done || failure?.category === "output") && (
        <AnotherExchangeFoot onNavigate={onAbandon} confirmBeforeLeave />
      )}
    </>
  );
}
