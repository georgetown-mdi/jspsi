import { useEffect, useState } from "react";

import {
  jobDiagnosticLogFileName,
  jobDiagnosticLogUrl,
  watchJobDiagnosticLog,
} from "@psi/jobClient/jobDiagnosticLog";

import styles from "@styles/app.module.css";

import { DownloadRow } from "./RunSurface";

/**
 * The lead the seat shows when the console stopped answering about a run's
 * log. It states what happened to the asking rather than promising a log: an
 * unanswered ask never said whether this run captured one.
 */
export const DIAGNOSTIC_LOG_UNANSWERED_LEAD =
  "This console stopped answering about this run's log.";

/**
 * What the seat says under that lead. It names the one thing the operator can do
 * from here -- ask again by reloading, which re-attaches to the run and starts a
 * fresh watch -- and does not claim the log exists or that it does not.
 */
export const DIAGNOSTIC_LOG_UNANSWERED_NOTICE =
  "This page asked several times whether this run recorded a diagnostic log " +
  "and got no answer back, so it has stopped asking. If this was a diagnostic " +
  "run, its log may still be on the console -- reload this page to ask again.";

/**
 * The diagnostic log a run captured, offered on every console server-job seat
 * (invite, accept, Direct, and strand recovery) whenever the console holds
 * one. Renders nothing while the console is answering and has no log to
 * offer, so a seat mounts it unconditionally and an ordinary run -- which passes
 * no log flags at all -- shows no trace of it.
 *
 * Not gated on the run having succeeded: the log is offered beside a failure
 * exactly as beside a completion, and a stalled run's log can be read while
 * it stalls.
 *
 * Availability is polled from the console rather than from what this tab
 * remembers requesting, so a re-attached run offers it too. A run
 * in progress that asked for a log is asked repeatedly until the console holds
 * it, because the ask at mount races the CLI child's own creation of the file; a
 * run that asked for none says so on the first ask and is not asked again, and a
 * settled run is asked once, its log being either written or never captured. A
 * console that answers none of those asks resolves to the unanswered state
 * rather than waiting indefinitely. The endpoint itself is the only place the
 * file is read.
 */
export function DiagnosticLogPanel({
  jobId,
  settled = false,
}: {
  jobId: string;
  /** Whether the run has reached a terminal state; while it is false the
   * console is asked again until it holds the log. */
  settled?: boolean;
}) {
  // The job the watch resolved for, rather than a bare outcome: a panel handed a
  // different id must ask for that run rather than show the previous one's. A
  // confirmed log is not withdrawn -- the file stays for as long as the
  // console holds the job, and the endpoint answers for it either way -- and
  // a console that went quiet for this run is not re-asked behind the notice
  // that says so.
  const [resolved, setResolved] = useState<{
    jobId: string;
    outcome: "available" | "unanswered";
  }>();
  const outcome = resolved?.jobId === jobId ? resolved.outcome : undefined;

  useEffect(() => {
    if (outcome !== undefined) return;
    const controller = new AbortController();
    void watchJobDiagnosticLog(jobId, controller.signal, { settled }).then(
      (watched) => {
        if (watched === "unavailable" || controller.signal.aborted) return;
        setResolved({ jobId, outcome: watched });
      },
    );
    return () => {
      controller.abort();
    };
  }, [jobId, outcome, settled]);

  if (outcome === undefined) return null;

  return (
    <section className={styles.callout} aria-labelledby="diagnostic-log-title">
      <h2 id="diagnostic-log-title">Diagnostic log</h2>
      {outcome === "available" ? (
        <>
          <p className={styles.small}>
            This run recorded a detailed log of what the exchange did. Download
            it to read it, or to send it to whoever is helping you. It can name
            your partner, the linkage keys, and the columns involved, so treat
            it like the results.
          </p>
          <DownloadRow
            label="Download run log"
            caveat="keep private"
            href={jobDiagnosticLogUrl(jobId)}
            fileName={jobDiagnosticLogFileName(jobId)}
          />
        </>
      ) : (
        <>
          <p className={styles.calloutLead}>{DIAGNOSTIC_LOG_UNANSWERED_LEAD}</p>
          <p className={styles.small}>{DIAGNOSTIC_LOG_UNANSWERED_NOTICE}</p>
        </>
      )}
    </section>
  );
}
