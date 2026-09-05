import { useEffect, useRef } from "react";

import { invitationUsable } from "@psi/formatting";

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
import { reattachedRunState } from "./reattachedRunState";
import { useJobExchangeRecordOffer } from "./useJobExchangeRecordOffer";

import type { AcceptableInvitation } from "@psi/acceptInvitation";
import type { ExchangeRun } from "./exchangeRun";
import type { JobRunStatus } from "@psi/jobClient/serverJobExchangeDriver";
import type { RunFailure } from "./useInviterExchange";
import type { RunOutputs } from "@psi/runOutputs";

/**
 * The acceptor's run/completion work column, re-using the shared run furniture
 * ({@link RunSurface}) with the acceptor's own vocabulary. Unlike the
 * inviter, the acceptor has no share phase: it dials on arrival, so the column
 * opens at the running screen and ends at the completion panel. The status
 * panel spans both from one stable mount so its live region persists.
 *
 * The run's own non-fatal warnings -- the console's rendezvous preflight among
 * them -- show through the shared {@link RunWarningsAlert}, which a failure
 * does not clear.
 *
 * A failed run renders the failure vocabulary's alert for its category, each
 * with its one concrete way forward -- an acceptor seat cannot mint, so every
 * non-retryable recovery is a link to the quick path to paste a fresh
 * invitation, and a config fault returns to the confirm-columns step. No failure
 * clears any operator input.
 */
export function AcceptorExchangeSection({
  invitation,
  run,
  outputs,
  failure,
  runWarnings,
  serverJob,
  jobId,
  reattached,
  reattaching,
  onTryAgain,
  onFixColumns,
  onAbandon,
}: {
  invitation: AcceptableInvitation;
  run: ExchangeRun;
  outputs: RunOutputs | undefined;
  failure: RunFailure | undefined;
  /** The run's accumulated non-fatal warnings (the driver's `onWarning` slot),
   * rendered through the shared alert as the inviter seat renders them. These
   * survive a failure: a preflight warning the failure may have followed from must
   * not vanish with the run. */
  runWarnings: ReadonlyArray<string>;
  /** Whether this accept executes on the console (a server-job run)
   * rather than in this browser. On the console the CLI child conducts the
   * exchange while the tab stays open, so the keep-open callout names the running
   * exchange the tab is holding. */
  serverJob: boolean;
  /** The console job id of a server-job accept, once created. Threads the run's
   * job to the recurring hand-off panel; undefined on a browser accept. */
  jobId: string | undefined;
  /** The live status of the exchange this accept re-attached to on a busy (409)
   * create, or undefined on a fresh run. When set, the surface heads with
   * recovery-style copy (it is watching an exchange the console already held,
   * not a fresh one) and drops the fresh-run keep-open framing, while keeping the
   * completion affordances -- the results summary and the recurring hand-off -- so
   * the operator still sees their run's outcome and graduation. */
  reattached: JobRunStatus | undefined;
  /** True during the brief interim between a busy (409) create being detected and
   * the liveness probe settling: the surface suppresses the fresh-run framing and
   * shows a reconnecting notice, before it resolves to the recovery view or the
   * run's alert. */
  reattaching: boolean;
  onTryAgain: () => void;
  /** Return to the confirm-columns step with every setting intact -- a prepare-time
   * config failure's recovery, since the acceptor fixes its own settings there. */
  onFixColumns: () => void;
  /** Discard the current server-job exchange (cancel-if-running + DELETE), fired as
   * the operator leaves for a fresh invitation (the start-over link) or a new
   * exchange (the completion workfoot), so the console's single slot frees. A
   * no-op on a browser run. */
  onAbandon: () => void;
}) {
  const phase = outputs !== undefined ? "done" : "running";
  // The run reached a terminal, which is what the three console-artifact
  // panels below key on: each states its artifact's standing once the run is
  // past producing it.
  const settled = phase === "done" || failure !== undefined;

  // Where this run's exchange record stands on the console -- the one ask that
  // both offers the record and decides whether the failure recoveries, each of
  // which DELETEs the run's folder, confirm before doing so.
  const recordOffer = useJobExchangeRecordOffer(
    serverJob ? jobId : undefined,
    settled && outputs?.record === undefined,
  );
  const recordConfirm = untakenRecordConfirm(recordOffer);

  // A busy (409) create at start re-attached this surface to an exchange the
  // console already held (a second tab, a navigate-away-and-back, or an orphaned
  // job). It then heads with recovery-style copy and drops the fresh-run keep-open
  // framing, so it never displays as a fresh success -- but the completion affordances
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

  // A retry is genuine only while the invitation can still be accepted:
  // re-dialing a lapsed credential cannot succeed, so an expired exchange failure
  // routes to the fresh-invitation link instead. A token without `expires`
  // has no deadline and stays retryable.
  const expires = invitation.token.expires;
  const retryable =
    failure?.category === "exchange" &&
    (expires === undefined || invitationUsable(expires, new Date()));

  // The section-level focus throughline. On mount the h1 is focused (this is the
  // entry move -- the acceptor pressed "Start the exchange", whose button
  // unmounts, so a keyboard/screen-reader user lands on the run screen rather
  // than on nothing; the console host does not drive focus for this step). Within
  // the section focus moves again at completion (so the results are read) and
  // after a retry clears the alert -- the alert (which may hold focus, on Try
  // again) unmounts, orphaning focus onto <body>, so it is recovered onto the
  // heading. The recovery move fires only when focus was actually orphaned;
  // completion always moves it. While a failure is showing, FailureAlert owns the
  // moment (focus and completion are mutually exclusive -- a failed run never
  // reaches `done`).
  const headingRef = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      // Entry: FailureAlert takes focus on its own mount when a failure is
      // already present, so do not fight it.
      if (failure === undefined) headingRef.current?.focus();
      return;
    }
    if (phase === "done") {
      headingRef.current?.focus();
      return;
    }
    if (failure !== undefined) return;
    const active = document.activeElement;
    if (!active || active === document.body) headingRef.current?.focus();
  }, [phase, failure, reattaching, reattachedRun]);

  const title = reattachedRun
    ? recoveredExchangeHeading(reattachState)
    : reattaching
      ? RECONNECTING_HEADING
      : phase === "done"
        ? "Exchange complete"
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
          {/* The acceptor cannot mint a fresh invitation, so the fresh-start
              recovery is a link to the quick path, where a new invitation is
              pasted. Offered for a security failure, an expired invitation, and
              a lapsed (non-retryable) exchange failure -- everything except a
              config fault (which the acceptor fixes in place) and an output
              fault (whose exchange already succeeded). */}
          {!retryable &&
            (failure.category === "security" ||
              failure.category === "exchange") && (
              <FailureRecoveryButton
                label="Start over with a fresh invitation"
                onAct={onAbandon}
                to="/quick"
                recordConfirm={recordConfirm}
              />
            )}
          {/* A prepare-time fault in this party's own settings: the acceptor
              fixes it on the confirm-columns step with every input intact, so
              the recovery returns there rather than re-running as-is. */}
          {failure.category === "config" && (
            <FailureRecoveryButton
              label="Back to your columns"
              onAct={onFixColumns}
              recordConfirm={recordConfirm}
            />
          )}
        </FailureAlert>
      )}
      {/* The console conducts this accept and the tab only watches it: leaving
          does not stop the run, and the recovery panel is the way back. The callout
          drops the moment a failure lands (the run it describes has torn down), so
          it outlives no failure. Absent for the hosted in-browser accept, which owns
          no such run. */}
      {phase === "running" &&
        failure === undefined &&
        serverJob &&
        !recovering && (
          <div className={styles.callout}>
            <p className={styles.calloutLead}>Keep this tab open.</p>
            <p className={styles.small}>{SERVER_JOB_KEEP_OPEN_BODY}</p>
            <p className={styles.small}>{SERVER_JOB_PEER_WINDOW_BODY}</p>
          </div>
        )}
      {phase === "done" && (
        <DonePanel outputs={outputs} finishedAt={run.finishedAt} />
      )}
      <RunWarningsAlert warnings={runWarnings} />
      <StatusPanel
        run={run}
        done={phase === "done"}
        halted={failure !== undefined}
      />
      {phase === "done" && outputs !== undefined && (
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
      {serverJob && jobId !== undefined && (
        <>
          <ReceiptDownload jobId={jobId} settled={settled} />
          <DiagnosticLogPanel jobId={jobId} settled={settled} />
        </>
      )}
      {/* Available from job creation onward, collapsed until the run completes
          -- the inviter seat's rule, applied identically here. */}
      {serverJob && jobId !== undefined && failure === undefined && (
        <RecurringHandoff jobId={jobId} collapsible={phase !== "done"} />
      )}
      {(phase === "done" || failure?.category === "output") && (
        <AnotherExchangeFoot
          onNavigate={onAbandon}
          confirmBeforeLeave={serverJob}
        />
      )}
    </>
  );
}
