/**
 * Assemble a re-run's {@link PreparedExchange} from the stored record's
 * exchange-file document and the input acquired THIS run. The record's
 * `exchangeFile` already holds this party's OWN-perspective document -- the
 * linkage terms, metadata, standardization, and payload commitments composed at
 * deposit time (the inviter's minted terms, or the acceptor's derived
 * perspective) -- so a re-run binds those persisted terms to the freshly-read
 * rows and columns and locks in the received-payload set exactly as the one-shot
 * accept path does.
 *
 * The received-payload lock-in is the security-relevant part, and it mirrors the
 * one-shot flows: {@link PreparedExchange.expectedPayloadColumns} is set to the
 * record's persisted `expectedPayloadColumns` (the partner's committed send set,
 * locked in at accept and carried in the document), so a re-run fails CLOSED if
 * the partner transmits a different set than was consented to -- the same lock-in
 * `prepareAcceptorExchange` applies from the invitation's disclosed set. An absent
 * persisted set (a lazy token) stays undefined and the party reconciles lazily.
 *
 * Pure and exported so the terms binding and the lock-in are the tested boundary,
 * pinned without a connection.
 */

import { prepareForExchange } from "@psilink/core";

import type { CSVRow, ExchangeSpec, PreparedExchange } from "@psilink/core";

/**
 * Build the re-run's prepared exchange. `identity` is read from the persisted
 * terms' own identity (this party's, composed at deposit), so the run carries the
 * same identity the exchange record commits to. The metadata and standardization
 * ride the persisted document when authored, otherwise core infers them from the
 * columns exactly as the quick path does. The persisted `expectedPayloadColumns`
 * is threaded onto the prepared object after `prepareForExchange` (the same seam
 * the accept path uses), never inferred here.
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
    },
    exchangeFile.linkageTerms.identity,
    rawRows,
    columns,
  );
  // The received-payload lock-in, mirrored from the persisted document exactly as
  // the accept path mirrors it from the invitation's disclosed set: passed AS-IS,
  // so an absent set (lazy) stays undefined and an empty set is a strict "receive
  // nothing" lock-in. runExchange prefers this explicit lock-in over the
  // payload.receive fallback.
  prepared.expectedPayloadColumns = exchangeFile.expectedPayloadColumns;
  return prepared;
}
