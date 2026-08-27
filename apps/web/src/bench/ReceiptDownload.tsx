import { useEffect, useState } from "react";

import { fetchJobReceiptOffer } from "@psi/jobReceipt";

import { DownloadRow } from "./BenchRunSurface";
import styles from "./bench.module.css";

import type { JobReceiptOffer } from "@psi/jobReceipt";

/**
 * The lead the seat shows when a run that asked for a signed receipt has none on
 * the appliance. It states the artifact's absence, not the exchange's outcome,
 * which the panel above it already carries.
 */
export const RECEIPT_MISSING_LEAD = "This run has no signed receipt.";

/**
 * What the seat says under that lead. This renders on any settled run, not only a
 * completed one, so it cannot claim the exchange finished: a receipt is written
 * once the signature swap completes, and a run that stopped before that point
 * never had one to lose. What holds either way is that the loss is settled --
 * running the exchange again produces a receipt for that run, not this one.
 */
export const RECEIPT_MISSING_NOTICE =
  "This exchange asked for a signed receipt and this appliance holds none for " +
  "it, so there is nothing to download here. A receipt is written once both " +
  "parties have exchanged signatures, so a run that stopped before that point " +
  "produced none at all. Running the exchange again produces a receipt for " +
  "that run, not this one -- a receipt covers the run that produced it, and " +
  "neither party can recreate one afterwards.";

/**
 * The dual-signed receipt a console server-job run produced, offered on every
 * console server-job seat (invite, accept, Direct, and strand recovery) whenever
 * the appliance holds one. Renders nothing for a run that signed nothing, so a
 * seat mounts it unconditionally and an ordinary run shows no trace of it.
 *
 * Deliberately NOT gated on the run having succeeded. The receipt is written once
 * the signature swap completes, independently of the local record build and of
 * the exit code, so a persistence-loss exit -- a completed exchange whose local
 * write failed -- is precisely the run whose receipt may be the only
 * third-party-verifiable artifact left. It is offered beside a failure exactly as
 * beside a completion, which is why it hangs off the appliance's answer rather
 * than off the success-gated run outputs.
 *
 * It is gated on the run being SETTLED, which is a different claim: the file
 * appears at the signature swap, so an ask before the terminal would read a
 * receipt that has not been written yet as one the run does not have. By the time
 * a run has settled the file is written or it never will be, and one ask answers
 * for good.
 *
 * A receipt the appliance says it does not hold is stated rather than omitted, so
 * an operator who authored a certificate-mode exchange is never left reading an
 * absent control as an absent feature. An ask that fails states nothing: it
 * established neither that the receipt exists nor that it does not.
 */
export function ReceiptDownload({
  jobId,
  settled,
}: {
  jobId: string;
  /** Whether the run has reached a terminal state; while it is false the
   * appliance is not asked at all. */
  settled: boolean;
}) {
  // The job the ask resolved for, rather than a bare offer: a seat handed a
  // different id (a retry creates a new job) must ask for that run rather than
  // show the previous one's.
  const [resolved, setResolved] = useState<{
    jobId: string;
    offer: JobReceiptOffer;
  }>();
  const offer = resolved?.jobId === jobId ? resolved.offer : undefined;

  useEffect(() => {
    if (!settled || offer !== undefined) return;
    // A plain flag rather than an AbortController: the ask is one status GET
    // whose answer this seat stops caring about, and a controller here would
    // abort nothing the reader passes a signal to.
    let dropped = false;
    void fetchJobReceiptOffer(jobId).then((asked) => {
      if (!dropped) setResolved({ jobId, offer: asked });
    });
    return () => {
      dropped = true;
    };
  }, [jobId, offer, settled]);

  if (offer === undefined || offer.kind === "none") return null;
  if (offer.kind === "available")
    return (
      <DownloadRow
        label="Download signed receipt (safe to share)"
        href={offer.receiptUrl}
        fileName={offer.receiptFileName}
      />
    );
  return (
    <div className={styles.callout}>
      <p className={styles.calloutLead}>{RECEIPT_MISSING_LEAD}</p>
      <p className={styles.small}>{RECEIPT_MISSING_NOTICE}</p>
    </div>
  );
}
