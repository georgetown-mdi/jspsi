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
  RunWarningsAlert,
  WithheldResultInset,
} from "./BenchRunSurface";
import { StatusPanel } from "./StatusPanel";
import styles from "./bench.module.css";

import type { ExchangeRun } from "./exchangeRun";
import type { GeneratedInvitation } from "@psi/invitation";
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
  onTryAgain,
  onStartOver,
}: {
  invitation: GeneratedInvitation;
  run: ExchangeRun;
  outputs: RunOutputs | undefined;
  failure: RunFailure | undefined;
  /** The run's accumulated non-fatal warnings (the driver's `onWarning` slot),
   * rendered beside the status panel through every phase. */
  warnings: ReadonlyArray<string>;
  onTryAgain: () => void;
  onStartOver: () => void;
}) {
  const phase =
    outputs !== undefined ? "done" : awaitingPartner(run) ? "share" : "running";

  // A retry is genuine only while the invitation can still be accepted:
  // re-listening on a lapsed credential cannot succeed, so an expired
  // exchange failure routes to start-over and stops advertising the link.
  const retryable =
    failure?.category === "exchange" &&
    invitationUsable(invitation.expires, new Date());

  // The phase-level focus throughline. The bench host moves focus to the h1
  // when the section mounts; within the section, focus moves again when the
  // partner connects or a retry clears the alert -- the share block or the
  // alert (either of which may hold focus, on a copy button or the Try again
  // button) unmounts, so without this the browser drops focus to <body> --
  // and at completion, so the results are read. The recovery moves fire only
  // when focus was actually orphaned onto <body>, so focus the user placed on
  // a live element is not stolen; completion always moves it. While a failure
  // is showing, the alert-focus effect below owns the moment.
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
  }, [phase, failure]);

  const title =
    phase === "done"
      ? "Exchange complete"
      : phase === "running"
        ? "Exchange in progress"
        : "Your invitation is ready";

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
          {/* Every non-retryable failure except "output" (whose exchange
              already succeeded, so nothing here may invite a re-run) offers
              exactly one recovery: a fresh invitation. */}
          {!retryable && failure.category !== "output" && (
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
      {phase === "share" && (failure === undefined || retryable) && (
        <>
          <h2>Share this invitation</h2>
          <p>
            Send one of these to your partner over a trusted channel (for
            example, secure email). It carries a one-time secret, so treat it as
            confidential. Keep this tab open while your partner accepts.
          </p>
          <CopyRow
            label="Invitation link"
            hint="Opens the accept page with the invitation prefilled"
            value={invitation.deepLink}
          />
          <CopyRow
            label="Invitation code"
            hint="Paste into the accept form if the link cannot be used"
            value={invitation.encoded}
          />
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
      {/* The "listening" claim is false the moment any failure lands (the
          lifecycle tore down), so the callout outlives no failure -- not even
          a retryable one. */}
      {phase === "share" && failure === undefined && (
        <div className={styles.callout}>
          <p className={styles.calloutLead}>Keep this tab open.</p>
          <p className={styles.small}>
            Your browser is listening for your partner. Closing the tab cancels
            the invitation; reloading starts over.
          </p>
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
              <div className={styles.callout}>
                <p className={styles.calloutLead}>Keep a record.</p>
                <p className={styles.small}>
                  File the record JSON with your project documentation - it is
                  safe to share and lets either party verify this run later. The
                  verification keys prove the record came from this exchange;
                  store them where only you can read them.
                </p>
              </div>
            </>
          )}
        </>
      )}
      {(phase === "done" || failure?.category === "output") && (
        <AnotherExchangeFoot />
      )}
    </>
  );
}
