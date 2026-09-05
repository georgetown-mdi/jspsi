/**
 * Assemble a re-run's {@link PreparedExchange} from the stored record's
 * exchange-file document and the input acquired THIS run. The record's
 * `exchangeFile` already holds this party's OWN-perspective document -- the
 * linkage terms, metadata, standardization, and payload commitments composed at
 * deposit time (the inviter's minted terms, or the acceptor's derived
 * perspective) -- so a re-run binds those persisted terms to the freshly-read
 * rows and columns and commits to the received-payload set exactly as the
 * one-shot accept path does.
 *
 * The received-payload enforcement is the security-relevant part, and it mirrors
 * the one-shot flows: {@link PreparedExchange.expectedPayloadColumns} is set to
 * the record's persisted `expectedPayloadColumns` (the partner's committed send
 * set, pinned at accept and recorded in the document), so a re-run fails CLOSED
 * if the partner transmits a different set than was consented to -- the same
 * enforcement `prepareAcceptorExchange` applies from the invitation's disclosed
 * set. An absent persisted set (a lazy token) stays undefined and the party
 * reconciles lazily.
 *
 * The terms-side enforcement beside it is the acceptor's persisted
 * `expectedPartnerDeduplicate` -- the `deduplicate` the invitation declared for
 * the inviter's own side -- threaded onto
 * {@link PreparedExchange.expectedPartnerDeduplicate} so a re-run refuses an
 * inviter presenting any other value at the terms exchange
 * (`assertPresentedDeduplicateMatchesInvitation`), before any key or payload
 * moves. Absent on an inviter's record, and on a document composed from no
 * acceptance, where nothing was declared to bind.
 *
 * The send side has its own persisted gate: the acceptor's `outboundPayloadConsent`
 * rides the document into `prepareForExchange`, which refuses before connecting if
 * the set this re-run resolves is not the one the operator confirmed at accept
 * (`assertOutboundPayloadConsented`). Absent on every other party, where it is a
 * no-op.
 *
 * Pure and exported so the terms binding and the enforcement are the tested
 * boundary, pinned without a connection.
 */

import { prepareForExchange } from "@psilink/core";

import type { CSVRow, ExchangeSpec, PreparedExchange } from "@psilink/core";

/**
 * Build the re-run's prepared exchange. `identity` is read from the persisted
 * terms' own identity (this party's, composed at deposit), so the run holds the
 * same identity the exchange record commits to. The metadata and standardization
 * ride the persisted document when authored, otherwise core infers them from the
 * columns exactly as the quick path does. The persisted `expectedPayloadColumns`
 * and the persisted `expectedPartnerDeduplicate` are threaded onto the prepared
 * object after `prepareForExchange` (the same call site the accept path uses),
 * never inferred here.
 */
export function prepareManagedRerunExchange(
  exchangeFile: ExchangeSpec,
  rawRows: Array<CSVRow>,
  columns: Array<string>,
): PreparedExchange {
  const prepared = prepareForExchange(
    {
      linkageTerms: exchangeFile.linkageTerms,
      ...(exchangeFile.metadata !== undefined
        ? { metadata: exchangeFile.metadata }
        : {}),
      ...(exchangeFile.standardization !== undefined
        ? { standardization: exchangeFile.standardization }
        : {}),
      ...(exchangeFile.disclosedPayloadColumns !== undefined
        ? { disclosedPayloadColumns: exchangeFile.disclosedPayloadColumns }
        : {}),
      ...(exchangeFile.outboundPayloadConsent !== undefined
        ? { outboundPayloadConsent: exchangeFile.outboundPayloadConsent }
        : {}),
    },
    exchangeFile.linkageTerms.identity,
    rawRows,
    columns,
  );
  // The received-payload enforcement, mirrored from the persisted document exactly
  // as the accept path mirrors it from the invitation's disclosed set: passed
  // AS-IS, so an absent set (lazy) stays undefined and an empty set is a strict
  // "receive nothing" commitment. runExchange prefers this explicit commitment
  // over the payload.receive fallback.
  prepared.expectedPayloadColumns = exchangeFile.expectedPayloadColumns;
  // The terms-side enforcement, mirrored from the persisted document exactly as
  // the accept path mirrors it from the invitation's declared terms: passed
  // AS-IS, so an absent declaration (an inviter's record, or a document no
  // acceptance composed) stays undefined and binds nothing.
  prepared.expectedPartnerDeduplicate = exchangeFile.expectedPartnerDeduplicate;
  return prepared;
}
