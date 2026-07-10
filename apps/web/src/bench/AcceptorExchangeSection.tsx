import { useEffect, useRef } from "react";

import { Alert, Button } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";

import { invitationUsable } from "./inviterModel";

import {
  AnotherExchangeFoot,
  DonePanel,
  DownloadRow,
  FailureAlert,
  WithheldResultInset,
} from "./BenchRunSurface";
import { StatusPanel } from "./StatusPanel";
import styles from "./bench.module.css";

import type { AcceptableInvitation } from "@psi/acceptInvitation";
import type { AlertContent } from "@components/FileAcquire";
import type { ExchangeRun } from "./exchangeRun";
import type { InviterRunOutputs } from "./inviterRunOutputs";
import type { RunFailure } from "./useInviterExchange";

/**
 * The acceptor's run/completion work column, re-using the shared run furniture
 * ({@link BenchRunSurface}) with the acceptor's own vocabulary. Unlike the
 * inviter, the acceptor has no share phase: it dials on arrival, so the column
 * opens at the running screen and settles at the completion panel. The status
 * panel spans both from one stable mount so its live region persists.
 *
 * The partial-coverage advisory the confirm-columns step raised surfaces here as
 * an amber alert (the run column's half of that advisory; the rail carries the
 * other half). A failed run renders the failure vocabulary's alert for its
 * category, each with its one concrete way forward -- an acceptor seat cannot
 * mint, so every non-retryable recovery is a link back to the lobby to paste a
 * fresh invitation, and a config fault returns to the confirm-columns step. No
 * failure clears any operator input.
 */
export function AcceptorExchangeSection({
  invitation,
  run,
  outputs,
  failure,
  warning,
  onTryAgain,
  onFixColumns,
}: {
  invitation: AcceptableInvitation;
  run: ExchangeRun;
  outputs: InviterRunOutputs | undefined;
  failure: RunFailure | undefined;
  /** The confirm-columns step's partial-coverage advisory, kept visible through
   * the run and cleared on a failure. */
  warning: AlertContent | undefined;
  onTryAgain: () => void;
  /** Return to the confirm-columns step with every setting intact -- the config
   * failure's recovery, since the acceptor fixes its own settings there. */
  onFixColumns: () => void;
}) {
  const phase = outputs !== undefined ? "done" : "running";

  // A retry is genuine only while the invitation can still be accepted:
  // re-dialing a lapsed credential cannot succeed, so an expired exchange failure
  // routes to the fresh-invitation link instead. A token without `expires`
  // carries no deadline and stays retryable.
  const expires = invitation.token.expires;
  const retryable =
    failure?.category === "exchange" &&
    (expires === undefined || invitationUsable(expires, new Date()));

  // The section-level focus throughline. On mount the h1 is focused (this is the
  // entry move -- the acceptor pressed "Start the exchange", whose button
  // unmounts, so a keyboard/screen-reader user lands on the run screen rather
  // than on nothing; the bench host does not drive focus for this step). Within
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
  }, [phase, failure]);

  const title = phase === "done" ? "Exchange complete" : "Exchange in progress";

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
          {/* The acceptor cannot mint a fresh invitation, so the fresh-start
              recovery is a link back to the lobby, where a new invitation is
              pasted. Offered for a security failure, an expired invitation, and
              a lapsed (non-retryable) exchange failure -- everything except a
              config fault (which the acceptor fixes in place) and an output
              fault (whose exchange already succeeded). */}
          {!retryable &&
            (failure.category === "security" ||
              failure.category === "exchange") && (
              <Button
                component={Link}
                to="/bench"
                color="red"
                variant="light"
                mt="sm"
              >
                Start over with a fresh invitation
              </Button>
            )}
          {/* A prepare-time fault in this party's own settings: the acceptor
              fixes it on the confirm-columns step with every input intact, so
              the recovery returns there rather than re-running as-is. */}
          {failure.category === "config" && (
            <Button color="red" variant="light" mt="sm" onClick={onFixColumns}>
              Back to your columns
            </Button>
          )}
        </FailureAlert>
      )}
      {/* The confirm-columns partial-coverage advisory, kept visible through the
          run and cleared by the hook on a failure so it cannot read as the
          cause. */}
      {warning !== undefined && failure === undefined && (
        <Alert
          color="yellow"
          icon={<IconAlertTriangle aria-hidden />}
          title={warning.title}
          mb="md"
        >
          {warning.message}
        </Alert>
      )}
      {phase === "done" && (
        <DonePanel
          matchedRecordCount={outputs?.matchedRecordCount}
          finishedAt={run.finishedAt}
        />
      )}
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
