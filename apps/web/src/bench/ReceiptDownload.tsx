import { useEffect, useState } from "react";

import { askJobReceiptOffer } from "@psi/jobReceipt";

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
  "This exchange asked for a signed receipt and this console holds none for " +
  "it, so there is nothing to download here. A receipt is written once both " +
  "parties have exchanged signatures, so a run that stopped before that point " +
  "produced none at all. Running the exchange again produces a receipt for " +
  "that run, not this one -- a receipt covers the run that produced it, and " +
  "neither party can recreate one afterwards.";

/**
 * The lead the seat shows when the appliance stopped answering about a run's
 * receipt. It states what happened to the asking rather than the receipt: an
 * unanswered ask never said whether this run has one.
 */
export const RECEIPT_UNANSWERED_LEAD =
  "This console stopped answering about this run's receipt.";

/**
 * What the seat says under that lead. It names the one thing the operator can do
 * from here -- ask again by reloading, which re-attaches to the run -- and the
 * one thing to avoid meanwhile, since discarding the run takes any receipt with
 * it. It claims neither that the receipt exists nor that it does not.
 */
export const RECEIPT_UNANSWERED_NOTICE =
  "This page asked several times whether this run has a signed receipt and got " +
  "no answer back, so it has stopped asking. If this exchange signed one it may " +
  "still be with the run's files on this console -- reload this page to ask " +
  "again, and keep the run until you have the file, because discarding the run " +
  "removes the receipt along with the results.";

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
 * a run has settled the file is written or it never will be, so one answered ask
 * settles it for good.
 *
 * A receipt the appliance says it does not hold is stated rather than omitted, so
 * an operator who authored a certificate-mode exchange is never left reading an
 * absent control as an absent feature. So is an appliance that stops answering
 * about the receipt: an ask that fails establishes neither that the receipt
 * exists nor that it does not, and a seat that rendered nothing for it would
 * hide a real receipt behind one failed request at the moment the run settled.
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
    const controller = new AbortController();
    void askJobReceiptOffer(jobId, controller.signal).then((asked) => {
      if (!controller.signal.aborted) setResolved({ jobId, offer: asked });
    });
    return () => {
      controller.abort();
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
  const unanswered = offer.kind === "unanswered";
  return (
    <div className={styles.callout}>
      <p className={styles.calloutLead}>
        {unanswered ? RECEIPT_UNANSWERED_LEAD : RECEIPT_MISSING_LEAD}
      </p>
      <p className={styles.small}>
        {unanswered ? RECEIPT_UNANSWERED_NOTICE : RECEIPT_MISSING_NOTICE}
      </p>
    </div>
  );
}
