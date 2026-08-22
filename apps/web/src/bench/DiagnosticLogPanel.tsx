import { useEffect, useState } from "react";

import {
  fetchJobLogAvailable,
  jobDiagnosticLogFileName,
  jobDiagnosticLogUrl,
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
 * remembers requesting, which is what lets a re-attached run offer it too.
 * `settled` re-asks once the run reaches a terminal state, so a log that grew
 * after the first look is still offered; the endpoint itself is the only place
 * the file is read.
 */
export function DiagnosticLogPanel({
  jobId,
  settled = false,
}: {
  jobId: string;
  /** Whether the run has reached a terminal state; flipping it re-asks the
   * appliance. */
  settled?: boolean;
}) {
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchJobLogAvailable(jobId).then((logAvailable) => {
      if (!cancelled) setAvailable(logAvailable);
    });
    return () => {
      cancelled = true;
    };
  }, [jobId, settled]);

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
