import { prepareForExchange } from "@psilink/core";

import { acceptorExchangeDataSpec } from "@psi/acceptInvitation";

import type { CSVRow, LinkageTerms, PreparedExchange } from "@psilink/core";

import type { AcceptorDataEdits } from "@psi/acceptInvitation";

/**
 * Assemble the acceptor's prepared exchange: the data spec adopts the
 * invitation's `linkageTerms` with the committed name substituted and the
 * confirm-columns edits threaded in ({@link acceptorExchangeDataSpec}), then
 * `prepareForExchange` binds it to the acquired CSV's rows and columns.
 *
 * The payload commitment is the security-relevant part: `expectedPayloadColumns`
 * is set to the invitation's `disclosedPayloadColumns` -- the set the consent
 * screen showed -- so an inviter transmitting a different column set than it
 * disclosed aborts the exchange ({@link reconcileReceivedPayload}). An omitted
 * disclosed set (an older or metadata-unknown mint) stays undefined, and the
 * acceptor reconciles lazily; whenever it is present (including the empty set)
 * it is committed.
 *
 * The terms-side commitment beside it is `expectedPartnerDeduplicate`, the value
 * the invitation declared for the inviter's own side: the consent screen stated
 * it, and nothing in the agreed terms compares the two -- so an inviter
 * presenting a different value at the terms exchange aborts the run before any
 * key or payload moves ({@link assertPresentedDeduplicateMatchesInvitation}).
 * It is read off the invitation, never off `deduplicate` below, which is this
 * party's own side and binds the inviter to nothing.
 *
 * Pure and exported so the commitments and the spec assembly are the tested
 * boundary, pinned without running the run lifecycle.
 */
export function prepareAcceptorExchange({
  linkageTerms,
  acceptorName,
  edits,
  rawRows,
  columns,
  disclosedPayloadColumns,
  deduplicate,
}: {
  linkageTerms: LinkageTerms;
  acceptorName: string;
  edits: AcceptorDataEdits;
  rawRows: Array<CSVRow>;
  columns: Array<string>;
  disclosedPayloadColumns: Array<string> | undefined;
  /** Whether several of THIS party's records may match one of the partner's, as
   * the accepting operator set it at the seat. */
  deduplicate: boolean;
}): PreparedExchange {
  const prepared = prepareForExchange(
    acceptorExchangeDataSpec(linkageTerms, acceptorName, edits, deduplicate),
    acceptorName,
    rawRows,
    columns,
  );
  prepared.expectedPayloadColumns = disclosedPayloadColumns;
  prepared.expectedPartnerDeduplicate = linkageTerms.deduplicate;
  return prepared;
}
