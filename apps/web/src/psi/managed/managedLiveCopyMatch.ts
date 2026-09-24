/**
 * The rule that recognizes a stored exchange an import may duplicate when no
 * secret matches it: a live record whose agreed terms and `side` equal the
 * imported record's (docs/spec/MANAGED_EXCHANGE_RECORD.md, "Recognizing a live
 * copy without a secret match"). A live copy's secret rotates at every run, so
 * a file taken before a run holds a secret the copy has moved past, and the
 * secret alone no longer finds it.
 *
 * Equal terms and side can also describe two separate exchanges, so a match
 * names a record for the operator to decide on; it is never a refusal.
 */

import {
  CanonicalEncodingError,
  canonicalString,
  partnerBoundTerms,
} from "@psilink/core";

import type { ManagedExchangeRecord } from "./managedExchangeRecord";

/** The agreed terms of `record` in the canonical form two records are compared
 * in: the part of the linkage terms a partner refuses an exchange over, which
 * leaves out this party's own name and the terms' date. Undefined where the
 * encoding refuses them, which then match nothing. */
function canonicalAgreedTerms(
  record: ManagedExchangeRecord,
): string | undefined {
  try {
    return canonicalString(partnerBoundTerms(record.exchangeFile.linkageTerms));
  } catch (error) {
    if (error instanceof CanonicalEncodingError) return undefined;
    throw error;
  }
}

/** Whether `stored` and `imported` agree on the terms and on this party's side
 * of them. A record with no side (a configuration on a channel that names no
 * role) matches nothing. */
export function sameAgreedTermsAndSide(
  stored: ManagedExchangeRecord,
  imported: ManagedExchangeRecord,
): boolean {
  if (stored.side === undefined || stored.side !== imported.side) return false;
  const storedTerms = canonicalAgreedTerms(stored);
  return (
    storedTerms !== undefined && storedTerms === canonicalAgreedTerms(imported)
  );
}

/**
 * Every one of `liveRecords` that {@link sameAgreedTermsAndSide} matches
 * `imported` to, in store order, other than those `acknowledgedIds` names: the
 * ones the operator already confirmed installing beside. The caller passes
 * only live records -- none a hand-off or a migration spent -- and settles a
 * secret match before asking, since a secret match is the same exchange by
 * construction.
 */
export function findLiveCopiesByTermsAndSide(
  liveRecords: Iterable<ManagedExchangeRecord>,
  imported: ManagedExchangeRecord,
  acknowledgedIds: ReadonlyArray<string> = [],
): Array<ManagedExchangeRecord> {
  const copies: Array<ManagedExchangeRecord> = [];
  for (const record of liveRecords)
    if (
      !acknowledgedIds.includes(record.id) &&
      sameAgreedTermsAndSide(record, imported)
    )
      copies.push(record);
  return copies;
}
