import { DownloadRow } from "./BenchRunSurface";
import styles from "./bench.module.css";

import type { JobExchangeRecordOfferState } from "./useJobExchangeRecordOffer";

/**
 * The lead the seat shows over a record whose run disclosed and then stopped. It
 * leads with the disclosure rather than the failure: the alert above already says
 * the run stopped, and an operator reading only the failure would take a stopped
 * run for one that did nothing.
 */
export const TERMINATED_RECORD_LEAD =
  "This run had already exchanged data when it stopped, and wrote the record of " +
  "that disclosure.";

/**
 * What the seat says under that lead. Two things the operator can act on: the
 * record is the accounting entry for a disclosure that happened, and the run
 * holding it is one every control on this surface can remove. It names those
 * controls generically rather than by label, since the same panel stands on the
 * run seats and on the compact recovery panel, whose controls are worded
 * differently.
 */
export const TERMINATED_RECORD_NOTICE =
  "The record states what this run disclosed -- to whom, under which agreement, " +
  "over what categories of data, and how many of your records went into it -- " +
  "which is what a disclosure accounting is written from. Download it now: " +
  "every way on from a stopped run, whether that is trying again, starting " +
  "over, or discarding it, removes this run's files from this console and the " +
  "record with them, while the disclosure it records still happened.";

/**
 * What the seat says about the keys beside a TERMINATED record, which is not what
 * it can say about a completed run's pair. All three of the record's commitments
 * re-supply from the run's result file, and a run that stopped here wrote none, so
 * there is nothing for these salts to open (docs/spec/EXCHANGE_RECORD.md, When a
 * record is owed). Said where the download is offered rather than left for the
 * operator to discover, since the pair otherwise looks exactly like a completed
 * run's.
 */
export const TERMINATED_RECORD_KEYS_NOTICE =
  "The verification keys are offered beside it, but this run left them nothing " +
  "to open: opening one of the record's commitments takes that run's result " +
  "file, and a run that stopped here wrote none. The record still states what " +
  "you disclosed and still pairs with any receipt your partner holds -- what " +
  "this pair cannot do is demonstrate that by opening a commitment. Keep the " +
  "keys private all the same.";

/** The lead the seat shows over a completed run's record it is offering here --
 * the run finished, and its own results block did not hold the pair. */
export const COMPLETED_RECORD_LEAD =
  "This console holds the exchange record for this run.";

/** What the seat says under that lead: the same keeping instruction the results
 * block's own record rows hold, said here because this is where the download is. */
export const COMPLETED_RECORD_NOTICE =
  "It states what this run disclosed and is what a disclosure accounting is " +
  "written from. Download it before you move on: removing this run takes the " +
  "record from this console along with the results.";

/**
 * The lead the seat shows over a record file the console holds and cannot read
 * as a record. It states the file's presence, which is the part that is
 * established, and not what it says, which is the part that is not.
 */
export const UNDESCRIBABLE_RECORD_LEAD =
  "This console holds a file for this run that it cannot read as an exchange " +
  "record.";

/**
 * What the seat says under that lead. The console withholds the download rather
 * than serving a pair it cannot vouch for, so the copy stands in place of a
 * download row: it says where the file is, why nothing is offered here, and that
 * every control on this surface removes it. It names the reasons the console can
 * have -- an outcome a differently-versioned psilink wrote, or a pair it cannot
 * read whole -- because that is what tells the operator which build to open it
 * with.
 */
export const UNDESCRIBABLE_RECORD_NOTICE =
  "A record file sits in this run's folder in this console's working directory, " +
  "and this psilink build cannot read it: it may state an outcome this build " +
  "does not know, or be missing the verification keys written beside it. No " +
  "download is offered here, because this page cannot say what the file " +
  "records. The file itself is untouched where it sits, and a psilink build " +
  "that recognizes it can read it. Keep this run until you have it -- every way " +
  "on from here removes this run's files from this console, that one included.";

/**
 * The lead the seat shows when the console stopped answering about a run's
 * record. It states what happened to the asking rather than the record: an
 * unanswered ask never said whether this run has one.
 */
export const RECORD_UNANSWERED_LEAD =
  "This console stopped answering about this run's exchange record.";

/**
 * What the seat says under that lead. It states the condition under which a record
 * exists rather than asserting one does -- a run that stopped before it exchanged
 * data owes none and has none -- and names the one thing to avoid meanwhile, since
 * the recovery controls above remove the run and any record with it.
 */
export const RECORD_UNANSWERED_NOTICE =
  "This page asked several times whether this run wrote an exchange record and " +
  "got no answer back, so it has stopped asking. If this run got as far as " +
  "exchanging data, the record of that disclosure is with the run's files on " +
  "this console -- reload this page to ask again, and keep the run until you " +
  "have the file, because every way on from here removes it.";

/** The states this panel renders: the ones an ask can end in that leave the seat
 * something to say. `none` and an ask still in flight render nothing at all. */
type RenderedRecordOffer = Extract<
  JobExchangeRecordOfferState,
  { kind: "available" | "undescribable" | "unanswered" }
>;

/** The lead and notice each rendered state shows, kept together so the two lines
 * of one state cannot be paired with another's. */
function recordPanelCopy(offer: RenderedRecordOffer): {
  lead: string;
  notice: string;
} {
  if (offer.kind === "unanswered")
    return { lead: RECORD_UNANSWERED_LEAD, notice: RECORD_UNANSWERED_NOTICE };
  if (offer.kind === "undescribable")
    return {
      lead: UNDESCRIBABLE_RECORD_LEAD,
      notice: UNDESCRIBABLE_RECORD_NOTICE,
    };
  return offer.outcome === "completed"
    ? { lead: COMPLETED_RECORD_LEAD, notice: COMPLETED_RECORD_NOTICE }
    : { lead: TERMINATED_RECORD_LEAD, notice: TERMINATED_RECORD_NOTICE };
}

/**
 * The self-attested exchange record a console server-job run produced, offered on
 * every console server-job seat (invite, accept, Direct, and strand recovery)
 * whenever the console holds one the run's own results block is not already
 * offering.
 *
 * The run this exists for is the one that DISCLOSED AND THEN STOPPED. A record is
 * owed from the moment the payload exchange returns, so such a run writes one to
 * the same destination a completed run's takes (docs/spec/EXCHANGE_RECORD.md, When
 * a record is owed) -- and it reaches the seat as a failure, where the completion
 * downloads render nothing at all. Without this panel the console would hold the
 * disclosure-accounting artifact its operator most needs, never show it, and offer
 * to delete it in the same breath: the failure surface's recovery controls remove
 * the run's whole folder.
 *
 * A run that failed BEFORE disclosing owes no record and wrote none, so the
 * console reports none and this renders nothing -- the absence is structural,
 * not a status test standing in for it.
 *
 * The two outcomes are not offered alike. A terminated record attests the same
 * disclosure a completed one does, but its commitments re-supply from a result file
 * that run never wrote, so the keys beside it have nothing to open; the copy says
 * so where the download is rather than leaving the pair to display as a completed
 * run's.
 *
 * A record the console holds and cannot describe renders too, with no download:
 * the console withholds a pair it cannot read whole, and a panel that stayed
 * silent would leave the operator with a confirm naming a file no surface admits
 * is there.
 *
 * The offer comes from the caller's own ask ({@link ./useJobExchangeRecordOffer}),
 * which the seat also reads to decide whether its recovery controls confirm before
 * discarding -- one ask, two consumers.
 */
export function RecordDownload({
  offer,
}: {
  /** Where this run's record stands. An ask still in flight renders nothing, as
   * does undefined -- a seat with nothing to ask about: the panel states where the
   * record stands, and neither of those knows yet. */
  offer: JobExchangeRecordOfferState | undefined;
}) {
  if (offer === undefined || offer.kind === "none" || offer.kind === "asking")
    return null;
  const terminated =
    offer.kind === "available" && offer.outcome !== "completed";
  const copy = recordPanelCopy(offer);
  return (
    <section className={styles.callout} aria-labelledby="exchange-record-title">
      <h2 id="exchange-record-title">Exchange record</h2>
      <p className={styles.calloutLead}>{copy.lead}</p>
      <p className={styles.small}>{copy.notice}</p>
      {offer.kind === "available" && (
        <>
          <DownloadRow
            label="Download record (safe to share)"
            href={offer.downloads.recordUrl}
            fileName={offer.downloads.recordFileName}
          />
          <DownloadRow
            label="Download verification keys"
            caveat="keep private"
            href={offer.downloads.keysUrl}
            fileName={offer.downloads.keysFileName}
          />
          {terminated && (
            <p className={styles.small}>{TERMINATED_RECORD_KEYS_NOTICE}</p>
          )}
        </>
      )}
    </section>
  );
}
