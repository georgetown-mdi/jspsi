import { useEffect, useRef } from "react";

import { Button } from "@mantine/core";

import { dateTimeLabel, invitationUsable } from "./inviterModel";
import { awaitingPartner } from "./exchangeRun";

import {
  AnotherExchangeFoot,
  CopyRow,
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
import { reattachedRunState } from "./reattachedRunState";
import styles from "./bench.module.css";

import type { ExchangeRun } from "./exchangeRun";
import type { GeneratedInvitation } from "@psi/invitation";
import type { JobRunStatus } from "@psi/serverJobExchangeDriver";
import type { RunFailure } from "./useInviterExchange";
import type { RunOutputs } from "./runOutputs";

/**
 * The inviter's post-create work column, through the run's three phases: the
 * share screen (copy artifacts, one-time-secret guidance, expiry) while the
 * browser listens for the partner, the running screen once a protocol stage
 * begins, and the completion panel with the downloads and their caveats. The
 * status panel spans all three from one stable mount so its live region
 * persists. A failed run renders the failure vocabulary's alert for its
 * category, each with its one concrete way forward; no failure clears what
 * the operator authored.
 */
export function InviterExchangeSection({
  invitation,
  run,
  outputs,
  failure,
  warnings,
  partnerAcceptsByCli,
  serverJob,
  jobId,
  reattached,
  reattaching,
  onTryAgain,
  onStartOver,
  onAbandon,
}: {
  invitation: GeneratedInvitation;
  run: ExchangeRun;
  outputs: RunOutputs | undefined;
  failure: RunFailure | undefined;
  /** The run's accumulated non-fatal warnings (the driver's `onWarning` slot),
   * rendered beside the status panel through every phase. */
  warnings: ReadonlyArray<string>;
  /** Whether the partner accepts through the command-line tool (the CLI
   * transports' server-job runs), whose accept takes the bare code -- the
   * share screen then offers the code beside the link. A browser partner
   * needs only the link: the accept form swallows a pasted deep link whole
   * (tokenFromInput), so the bare code adds nothing but a second secret to
   * leave on screen. */
  partnerAcceptsByCli: boolean;
  /** Whether this run executes on the console appliance (a server-job run) rather
   * than in this browser. On the appliance the CLI child conducts the exchange
   * while the tab stays open, so the keep-open callout names the running exchange
   * the tab is holding rather than a browser listener. */
  serverJob: boolean;
  /** The appliance job id of a server-job run, once created. Threads the run's job
   * to the recurring hand-off panel; undefined on a browser run. */
  jobId: string | undefined;
  /** The live status of the exchange this run re-attached to on a busy (409)
   * create, or undefined on a fresh run. When set, the surface heads with
   * recovery-style copy (it is watching an exchange the appliance already held,
   * not a fresh one) and drops the fresh-run share / keep-open framing, while
   * keeping the completion affordances -- the results summary and the recurring
   * hand-off -- so the operator still sees their run's outcome and graduation. */
  reattached: JobRunStatus | undefined;
  /** True during the brief interim between a busy (409) create being detected and
   * the liveness probe settling: the surface suppresses the fresh-run share block
   * and shows a reconnecting notice, before it resolves to the recovery view or
   * the run's alert. */
  reattaching: boolean;
  onTryAgain: () => void;
  onStartOver: () => void;
  /** Discard the current server-job exchange (cancel-if-running + DELETE), fired
   * as the operator leaves for a fresh exchange from the completion workfoot, so
   * the appliance's single slot frees for the next one. A no-op on a browser run
   * (no appliance job). */
  onAbandon: () => void;
}) {
  const phase =
    outputs !== undefined ? "done" : awaitingPartner(run) ? "share" : "running";

  // A busy (409) create at start re-attached this surface to an exchange the
  // appliance already held (a second tab, a navigate-away-and-back, or an orphaned
  // job). It then heads with recovery-style copy and drops the fresh-run share /
  // keep-open framing, so it never reads as a fresh success -- but the completion
  // affordances (the results summary and the recurring hand-off) still show, since
  // those hold however the operator reached completion.
  const reattachedRun = reattached !== undefined;
  const reattachState = reattachedRunState({
    failed: failure !== undefined,
    hasOutputs: outputs !== undefined,
    status: reattached ?? "running",
  });
  // Fresh-run framing (the share block, the keep-open callout, the fresh title) is
  // suppressed both once re-attached and during the reconnecting interim, so the
  // fresh block never flashes while the 409 is being resolved.
  const recovering = reattaching || reattachedRun;

  // A retry is genuine only while the invitation can still be accepted:
  // re-listening on a lapsed credential cannot succeed, so an expired
  // exchange failure routes to start-over and stops advertising the link.
  const retryable =
    failure?.category === "exchange" &&
    invitationUsable(invitation.expires, new Date());

  // Every non-retryable failure except output (whose exchange already succeeded, so
  // nothing here may invite a re-run) offers exactly one recovery: a fresh invitation
  // via start-over, back to Review & create with every input intact.
  const offersStartOver =
    !retryable && failure !== undefined && failure.category !== "output";

  // The phase-level focus throughline. The bench host moves focus to the h1
  // when the section mounts; within the section, focus moves again when the
  // partner connects or a retry clears the alert -- the share block or the
  // alert (either of which may hold focus, on a copy button or the Try again
  // button) unmounts, so without this the browser drops focus to <body> --
  // and at completion, so the results are read. The reconnecting-interim and
  // recovery swaps run through it too (via the deps) so an orphaned focus lands
  // on the recovery heading. The recovery moves fire only when focus was
  // actually orphaned onto <body>, so focus the user placed on a live element is
  // not stolen; completion always moves it. While a failure is showing, the
  // alert-focus effect below owns the moment.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
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
        : phase === "running"
          ? "Exchange in progress"
          : "Your invitation is ready";

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
              Start over with a fresh invitation
            </Button>
          )}
        </FailureAlert>
      )}
      {/* The copy artifacts drop out once the partner connects (nothing left
          to share) and on any failure except a retryable one -- a dead
          invitation (failed authentication, terminal config fault, lapsed
          expiry) must not keep being advertised for copying, while a
          retryable failure's link stays valid for another attempt. */}
      {phase === "share" &&
        (failure === undefined || retryable) &&
        !recovering && (
          <>
            <h2>Share this invitation</h2>
            {partnerAcceptsByCli ? (
              <p>
                Send one of these to your partner over a trusted channel (for
                example, secure email). It carries a one-time secret, so treat
                it as confidential. Keep this tab open while your partner
                accepts.
              </p>
            ) : (
              <p>
                Send this link to your partner over a trusted channel (for
                example, secure email). It carries a one-time secret, so treat
                it as confidential. If the link arrives broken, your partner can
                paste the whole link into the accept form. Keep this tab open
                while your partner accepts.
              </p>
            )}
            <CopyRow label="Invitation link" value={invitation.deepLink} />
            {partnerAcceptsByCli && (
              <CopyRow
                label="Invitation code"
                hint="Your partner accepts with this same code, whichever transport they run"
                value={invitation.encoded}
              />
            )}
            <p className={styles.small}>
              <strong>
                This invitation expires{" "}
                <span className={styles.mono}>
                  {dateTimeLabel(new Date(invitation.expires))}
                </span>
                .
              </strong>
            </p>
          </>
        )}
      {/* The keep-open callout drops the moment any failure lands: the run it
          describes has torn down, so it outlives no failure, not even a retryable
          one. On a server-job run the appliance conducts the exchange and this tab
          only watches it, so the callout persists into the running phase -- leaving
          does not stop the run, and the recovery panel is the way back. The browser
          listener's copy is share-only: once the partner connects, nothing it says
          still holds, so it does not extend past the share phase. */}
      {(phase === "share" || (phase === "running" && serverJob)) &&
        failure === undefined &&
        !recovering && (
          <div className={styles.callout}>
            <p className={styles.calloutLead}>Keep this tab open.</p>
            <p className={styles.small}>
              {serverJob
                ? SERVER_JOB_KEEP_OPEN_BODY
                : "Your browser is listening for your partner. Closing the tab cancels the invitation; reloading starts over."}
            </p>
            {serverJob && phase === "share" && (
              <p className={styles.small}>{SERVER_JOB_PEER_WINDOW_BODY}</p>
            )}
          </div>
        )}
      {phase === "done" && (
        <DonePanel
          matchedRecordCount={outputs?.matchedRecordCount}
          finishedAt={run.finishedAt}
        />
      )}
      <RunWarningsAlert warnings={warnings} />
      <StatusPanel
        run={run}
        done={phase === "done"}
        halted={failure !== undefined}
      />
      {phase === "done" && outputs !== undefined && (
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
      {phase === "done" && serverJob && jobId !== undefined && (
        <RecurringHandoff jobId={jobId} />
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
