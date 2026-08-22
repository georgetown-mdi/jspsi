import { useEffect, useState } from "react";

import {
  fetchJobLogAvailable,
  jobDiagnosticLogFileName,
  jobDiagnosticLogUrl,
  watchJobLogAvailable,
} from "@psi/jobDiagnosticLog";

import { DownloadRow } from "./BenchRunSurface";
import styles from "./bench.module.css";

/**
 * The diagnostic log a run captured, offered on every console server-job seat
 * (invite, accept, Direct, and strand recovery) whenever the appliance holds
 * one. Renders nothing otherwise, so a seat mounts it unconditionally and an
 * ordinary run -- which passes no log flags at all -- shows no trace of it.
 *
 * Deliberately NOT gated on the run having succeeded: the log exists for the run
 * that misbehaved, so it is offered beside a failure exactly as beside a
 * completion, and a run still stalled can be read while it stalls.
 *
 * Availability comes from the appliance rather than from what this tab
 * remembers requesting, which is what lets a re-attached run offer it too. A run
 * in progress is asked repeatedly until the appliance holds the log, because the
 * ask at mount races the CLI child's own creation of the file; a settled run is
 * asked once, its log being either written or never captured. The endpoint
 * itself is the only place the file is read.
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
  // The job whose log the appliance confirmed, rather than a bare flag: a panel
  // handed a different id must ask for that run rather than offer the previous
  // one's log. A confirmed log is not withdrawn -- the file stays for as long as
  // the appliance holds the job, and the endpoint answers for it either way.
  const [availableJobId, setAvailableJobId] = useState<string>();
  const available = availableJobId === jobId;

  useEffect(() => {
    if (available) return;
    const controller = new AbortController();
    void (
      settled
        ? fetchJobLogAvailable(jobId)
        : watchJobLogAvailable(jobId, controller.signal)
    ).then((logAvailable) => {
      if (logAvailable && !controller.signal.aborted) setAvailableJobId(jobId);
    });
    return () => {
      controller.abort();
    };
  }, [available, jobId, settled]);

  if (!available) return null;

  return (
    <section className={styles.callout} aria-labelledby="diagnostic-log-title">
      <h2 id="diagnostic-log-title">Diagnostic log</h2>
      <p className={styles.small}>
        This run recorded a detailed log of what the exchange did. Download it
        to read it, or to send it to whoever is helping you. It can name your
        partner, the linkage keys, and the columns involved, so treat it like
        the results.
      </p>
      <DownloadRow
        label="Download run log"
        caveat="keep private"
        href={jobDiagnosticLogUrl(jobId)}
        fileName={jobDiagnosticLogFileName(jobId)}
      />
    </section>
  );
}
