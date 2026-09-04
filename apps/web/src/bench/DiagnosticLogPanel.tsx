import { useEffect, useState } from "react";

import {
  jobDiagnosticLogFileName,
  jobDiagnosticLogUrl,
  watchJobDiagnosticLog,
} from "@psi/jobDiagnosticLog";

import { DownloadRow } from "./BenchRunSurface";
import styles from "./bench.module.css";

/**
 * The lead the seat shows when the appliance stopped answering about a run's
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
 * (invite, accept, Direct, and strand recovery) whenever the appliance holds
 * one. Renders nothing while the appliance is answering and has no log to
 * offer, so a seat mounts it unconditionally and an ordinary run -- which passes
 * no log flags at all -- shows no trace of it.
 *
 * Deliberately NOT gated on the run having succeeded: the log exists for the run
 * that misbehaved, so it is offered beside a failure exactly as beside a
 * completion, and a run still stalled can be read while it stalls.
 *
 * Availability comes from the appliance rather than from what this tab
 * remembers requesting, which is what lets a re-attached run offer it too. A run
 * in progress that asked for a log is asked repeatedly until the appliance holds
 * it, because the ask at mount races the CLI child's own creation of the file; a
 * run that asked for none says so on the first ask and is not asked again, and a
 * settled run is asked once, its log being either written or never captured. An
 * appliance that answers none of those asks is stated rather than waited on --
 * silence is what leaves an operator watching a stalled run with nothing. The
 * endpoint itself is the only place the file is read.
 */
export function DiagnosticLogPanel({
  jobId,
  settled = false,
}: {
  jobId: string;
  /** Whether the run has reached a terminal state; while it is false the
   * appliance is asked again until it holds the log. */
  settled?: boolean;
}) {
  // The job the watch resolved for, rather than a bare outcome: a panel handed a
  // different id must ask for that run rather than show the previous one's. A
  // confirmed log is not withdrawn -- the file stays for as long as the
  // appliance holds the job, and the endpoint answers for it either way -- and
  // an appliance that went quiet for this run is not re-asked behind the notice
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
