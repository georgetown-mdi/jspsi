import { useEffect, useRef } from "react";

import { Button } from "@mantine/core";

import {
  AnotherExchangeFoot,
  DonePanel,
  DownloadRow,
  FailureAlert,
  RECONNECTING_HEADING,
  ReattachedRunNotice,
  ReattachingNotice,
  RunWarningsAlert,
  SERVER_JOB_KEEP_OPEN_BODY,
  SERVER_JOB_PEER_WINDOW_BODY,
  WithheldResultInset,
  recoveredExchangeHeading,
} from "./BenchRunSurface";
import { RecurringHandoff } from "./RecurringHandoff";
import { StatusPanel } from "./StatusPanel";
import { awaitingPartner } from "./exchangeRun";
import { reattachedRunState } from "./reattachedRunState";
import styles from "./bench.module.css";

import type { ExchangeRun } from "./exchangeRun";
import type { JobRunStatus } from "@psi/serverJobExchangeDriver";
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
  reattached,
  reattaching,
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
  /** The live status of the exchange this run re-attached to on a busy (409)
   * create, or undefined on a fresh run. When set, the surface heads with
   * recovery-style copy (it is watching an exchange the appliance already held, not
   * a fresh one) and drops the fresh-run keep-open framing, while keeping the
   * completion affordances -- the results summary and the recurring hand-off -- so
   * the operator still sees their run's outcome and graduation. */
  reattached: JobRunStatus | undefined;
  /** True during the brief interim between a busy (409) create being detected and
   * the liveness probe settling: the surface suppresses the fresh-run framing and
   * shows a reconnecting notice, before it resolves to the recovery view or the
   * run's alert. */
  reattaching: boolean;
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

  // A busy (409) create at start re-attached this surface to an exchange the
  // appliance already held (a second tab, a navigate-away-and-back, or an orphaned
  // job). It then heads with recovery-style copy and drops the fresh-run keep-open
  // framing, so it never reads as a fresh success -- but the completion affordances
  // (the results summary and the recurring hand-off) still show, since those hold
  // however the operator reached completion.
  const reattachedRun = reattached !== undefined;
  const reattachState = reattachedRunState({
    failed: failure !== undefined,
    hasOutputs: outputs !== undefined,
    status: reattached ?? "running",
  });
  // Fresh-run framing (the keep-open callout, the fresh title) is suppressed both
  // once re-attached and during the reconnecting interim, so nothing fresh-run
  // flashes while the 409 is being resolved.
  const recovering = reattaching || reattachedRun;

  // Move focus to the heading at completion so the results are read, and onto the
  // recovery heading when the reconnecting/recovery swap orphans focus (the guard
  // fires only when focus landed on <body>, so a live element the operator placed
  // it on is not stolen). The failure alert owns focus while a failure shows
  // (FailureAlert focuses itself). Skipped on mount: the bench host already sends
  // focus to the incoming section's heading.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (done) {
      headingRef.current?.focus();
      return;
    }
    if (failure !== undefined) return;
    const active = document.activeElement;
    if (!active || active === document.body) headingRef.current?.focus();
  }, [done, failure, reattaching, reattachedRun]);

  const title = reattachedRun
    ? recoveredExchangeHeading(reattachState)
    : reattaching
      ? RECONNECTING_HEADING
      : done
        ? "Exchange complete"
        : failure !== undefined
          ? "Exchange stopped"
          : "Exchange in progress";

  return (
    <>
      <h1 tabIndex={-1} ref={headingRef}>
        {title}
      </h1>
      {reattachedRun && <ReattachedRunNotice state={reattachState} />}
      {reattaching && !reattachedRun && <ReattachingNotice />}
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
      {!done && failure === undefined && !recovering && (
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
