import { prepareForExchange } from "@psilink/core";

import { acceptorExchangeDataSpec } from "@psi/acceptInvitation";

import type { CSVRow, LinkageTerms, PreparedExchange } from "@psilink/core";

import type { AcceptorDataEdits } from "@psi/acceptInvitation";

/**
 * Assemble the acceptor's prepared exchange, re-surfacing ExchangeView's acceptor
 * wiring exactly: the data spec adopts the invitation's `linkageTerms` with the
 * committed name substituted and the confirm-columns edits threaded in
 * ({@link acceptorExchangeDataSpec}), then `prepareForExchange` binds it to the
 * acquired CSV's rows and columns.
 *
 * The payload lock-in is the security-relevant part: `expectedPayloadColumns` is
 * set to the invitation's `disclosedPayloadColumns` -- the set the consent screen
 * showed -- so an inviter transmitting a different column set than it disclosed
 * aborts the exchange ({@link reconcileReceivedPayload}). An omitted disclosed set
 * (an older or metadata-unknown mint) stays undefined, and the acceptor reconciles
 * lazily; whenever it is present (including the empty set) it locks in.
 *
 * Pure and exported so the lock-in and the spec assembly are the tested boundary,
 * pinned without running the run lifecycle.
 */
export function prepareAcceptorExchange({
  linkageTerms,
  acceptorName,
  edits,
  rawRows,
  columns,
  disclosedPayloadColumns,
}: {
  linkageTerms: LinkageTerms;
  acceptorName: string;
  edits: AcceptorDataEdits;
  rawRows: Array<CSVRow>;
  columns: Array<string>;
  disclosedPayloadColumns: Array<string> | undefined;
}): PreparedExchange {
  const prepared = prepareForExchange(
    acceptorExchangeDataSpec(linkageTerms, acceptorName, edits),
    acceptorName,
    rawRows,
    columns,
  );
  prepared.expectedPayloadColumns = disclosedPayloadColumns;
  return prepared;
}
