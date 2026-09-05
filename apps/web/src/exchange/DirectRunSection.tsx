import { useEffect, useRef } from "react";

import { RecurringHandoff } from "@recurring/RecurringHandoff";
import styles from "@styles/app.module.css";

import {
  AnotherExchangeFoot,
  DonePanel,
  DownloadRow,
  FailureAlert,
  FailureRecoveryButton,
  NoResultFileInset,
  RECONNECTING_HEADING,
  ReattachedRunNotice,
  ReattachingNotice,
  RunWarningsAlert,
  SERVER_JOB_KEEP_OPEN_BODY,
  SERVER_JOB_PEER_WINDOW_BODY,
  recoveredExchangeHeading,
  untakenRecordConfirm,
} from "./RunSurface";
import { DiagnosticLogPanel } from "./DiagnosticLogPanel";
import { ReceiptDownload } from "./ReceiptDownload";
import { RecordDownload } from "./RecordDownload";
import { StatusPanel } from "./StatusPanel";
import { awaitingPartner } from "./exchangeRun";
import { reattachedRunState } from "./reattachedRunState";
import { useJobExchangeRecordOffer } from "./useJobExchangeRecordOffer";

import type { ExchangeRun } from "./exchangeRun";
import type { JobRunStatus } from "@psi/jobClient/serverJobExchangeDriver";
import type { RunFailure } from "./useInviterExchange";
import type { RunOutputs } from "@psi/runOutputs";

/**
 * The direct-exchange run column: the running screen (status panel plus the
 * keep-open callout while the console conducts the exchange) then the completion
 * panel with downloads -- the result, and the self-attested disclosure record and
 * its verification keys. Unlike the inviter's run column there is no share phase:
 * a direct exchange mints no invitation, so both parties run their halves against
 * the agreed server at once.
 *
 * Leaving the page does not stop the run (the strand-recovery panel is the way
 * back); the keep-open callout says so, and the peer-window callout adds that
 * both consoles must run their halves in the same window while still awaiting
 * the partner. A failed run shows the failure alert for its category: Try again
 * for a retryable transport fault, Start over for a terms mismatch or any other
 * non-retryable, non-output failure.
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
  /** The console job id of this run, once created. Threads the run's job to the
   * recurring hand-off panel; undefined before the job exists. */
  jobId: string | undefined;
  /** The live status of the exchange this run re-attached to on a busy (409)
   * create, or undefined on a fresh run. When set, the surface heads with
   * recovery-style copy (it is watching an exchange the console already held, not
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
   * console's single slot frees for the next one. */
  onAbandon: () => void;
}) {
  const done = outputs !== undefined;
  // The run reached a terminal, which is what the three console-artifact
  // panels below key on: each states its artifact's standing once the run is
  // past producing it.
  const settled = done || failure !== undefined;
  // Where this run's exchange record stands on the console -- the one ask that
  // both offers the record and decides whether the failure recoveries, each of
  // which DELETEs the run's folder, confirm before doing so.
  const recordOffer = useJobExchangeRecordOffer(
    jobId,
    settled && outputs?.record === undefined,
  );
  const recordConfirm = untakenRecordConfirm(recordOffer);
  const awaiting = awaitingPartner(run);
  // A retryable failure is a transport/exchange fault; the terms mismatch is a
  // config failure, which -- like a security failure -- is not retried as-is but
  // sends the operator back to start over.
  const retryable = failure?.category === "exchange";
  const offersStartOver =
    !retryable && failure !== undefined && failure.category !== "output";

  // A busy (409) create at start re-attached this surface to an exchange the
  // console already held (a second tab, a navigate-away-and-back, or an orphaned
  // job). It then heads with recovery-style copy and drops the fresh-run keep-open
  // framing, so it never displays as a fresh success -- but the completion
  // affordances (the results summary and the recurring hand-off) still show, since
  // those hold however the operator reached completion.
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
  // (FailureAlert focuses itself). Skipped on mount: the console host already sends
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
            <FailureRecoveryButton
              label="Try again"
              onAct={onTryAgain}
              recordConfirm={recordConfirm}
            />
          )}
          {offersStartOver && (
            <FailureRecoveryButton
              label="Start over"
              onAct={onStartOver}
              recordConfirm={recordConfirm}
            />
          )}
        </FailureAlert>
      )}
      {/* The keep-open callout stands through the whole running run: the console
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
        <DonePanel outputs={outputs} finishedAt={run.finishedAt} />
      )}
      <RunWarningsAlert warnings={warnings} />
      <StatusPanel run={run} done={done} halted={failure !== undefined} />
      {outputs !== undefined && (
        <>
          <h2>Downloads</h2>
          {outputs.kind === "matched" ? (
            <DownloadRow
              label="Download result"
              href={outputs.resultsUrl}
              fileName="results.csv"
            />
          ) : (
            <NoResultFileInset outputs={outputs} />
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
      <RecordDownload offer={recordOffer} />
      {jobId !== undefined && (
        <>
          <ReceiptDownload jobId={jobId} settled={settled} />
          <DiagnosticLogPanel jobId={jobId} settled={settled} />
        </>
      )}
      {/* Available from job creation onward, collapsed until the run completes
          -- the inviter seat's rule, applied identically here. */}
      {jobId !== undefined && failure === undefined && (
        <RecurringHandoff jobId={jobId} collapsible={!done} />
      )}
      {(done || failure?.category === "output") && (
        <AnotherExchangeFoot onNavigate={onAbandon} confirmBeforeLeave />
      )}
    </>
  );
}
