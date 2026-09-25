/**
 * The rule that recognizes a stored exchange an import may duplicate when no
 * secret matches it: a stored record whose agreed terms and `side` equal the
 * imported record's (docs/spec/MANAGED_EXCHANGE_RECORD.md, "Recognizing a
 * stored exchange without a secret match"). A secret rotates at every run, so
 * a file taken before a run -- or a command line's files after one -- holds a
 * secret the stored record does not, and the secret alone no longer finds it.
 *
 * Equal terms and side can also describe two separate exchanges, so a match
 * names a record for the operator to decide on; it is never a refusal.
 */

import {
  CanonicalEncodingError,
  canonicalString,
  partnerBoundTerms,
} from "@alcove/core";

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

/** Where `stored` and `imported` part on the terms and on this party's side of
 * them: `"side"` where the sides differ, `"terms"` where the agreed terms do,
 * and `undefined` where they agree. A stored record with no side (a
 * configuration on a channel that names no role) agrees with nothing. */
export function agreedTermsAndSideMismatch(
  stored: ManagedExchangeRecord,
  imported: ManagedExchangeRecord,
): "side" | "terms" | undefined {
  if (stored.side === undefined || stored.side !== imported.side) return "side";
  const storedTerms = canonicalAgreedTerms(stored);
  return storedTerms !== undefined &&
    storedTerms === canonicalAgreedTerms(imported)
    ? undefined
    : "terms";
}

/** Whether `stored` and `imported` agree on the terms and on this party's side
 * of them ({@link agreedTermsAndSideMismatch}). */
export function sameAgreedTermsAndSide(
  stored: ManagedExchangeRecord,
  imported: ManagedExchangeRecord,
): boolean {
  return agreedTermsAndSideMismatch(stored, imported) === undefined;
}

/**
 * Every one of `records` that {@link sameAgreedTermsAndSide} matches
 * `imported` to, in store order, other than those `acknowledgedIds` names: the
 * ones the operator already confirmed installing beside. Which records are
 * asked about is the caller's: the backup import passes the live ones, the
 * command-line pair import those spent or holding a configuration only. The
 * caller settles a secret match before asking, since a secret match is the
 * same exchange by construction.
 */
export function findRecordsByTermsAndSide(
  records: Iterable<ManagedExchangeRecord>,
  imported: ManagedExchangeRecord,
  acknowledgedIds: ReadonlyArray<string> = [],
): Array<ManagedExchangeRecord> {
  const copies: Array<ManagedExchangeRecord> = [];
  for (const record of records)
    if (
      !acknowledgedIds.includes(record.id) &&
      sameAgreedTermsAndSide(record, imported)
    )
      copies.push(record);
  return copies;
}
