/**
 * How large a scheduled run's results file is projected to be, and the size above
 * which this browser keeps none of it.
 *
 * Both figures rest on one measurement. A results file holds one row per matched
 * pair under every cardinality, so a projected pair count converts to a file size
 * through the writer's bytes per pair -- the arithmetic behind the pair-table
 * advisory (docs/spec/PROTOCOL.md, "The both-sided expansion has no ceiling of its
 * own"), applied here to the one thing that does refuse on a size: what a run with
 * nobody present keeps at rest for the next visit
 * ({@link ./parkedResults.ts}).
 *
 * Pure arithmetic over two integers, so the bound a surface states and the bound
 * the delivery applies are the same number derived the same way.
 */

import { MAX_CSV_FILE_BYTES } from "@components/csvIntake";

/**
 * The largest results file a run with nobody present keeps in this browser. A
 * result above it is kept nowhere here: nothing is parked and nothing is
 * truncated, and the run records that state for the operator's next visit.
 *
 * Derived from the CSV intake cap rather than stated as a size of its own, so
 * raising what this app will read raises what it will keep in the same edit. The
 * two are the same question asked twice: a result this app would not read back as
 * an input is not one it holds at rest for the operator, and the intake cap is
 * the figure measured against a browser tab's memory
 * ({@link MAX_CSV_FILE_BYTES}). A test pins the derivation.
 */
export const MAX_PARKED_RESULT_BYTES = MAX_CSV_FILE_BYTES;

/**
 * What one matched pair costs in the results file, in bytes.
 *
 * Measured over the real writer and recorded in docs/spec/PROTOCOL.md ("The
 * both-sided expansion has no ceiling of its own"): 6 to 15 bytes for the
 * narrowest result an exchange can produce, and 32 to 41 where the result holds a
 * UUID identifier or three payload columns. The widest of those is what a
 * projection multiplies, because the projection warns rather than refuses: it
 * reaches the bound while a narrower result of the same pair count still fits,
 * which is what makes it a warning about approaching the bound. The refusal
 * itself weighs the built file's own bytes and projects nothing.
 */
export const RESULT_BYTES_PER_PAIR = 41;

/**
 * The two record counts whose product bounds a run's pair table: this party's and
 * the partner's, both as DECLARED at the terms exchange, so the two parties
 * project the same figure for the same run (`projectPairTable` in
 * `@alcove/core`).
 *
 * A run holds them only where the agreed cardinality makes the table their
 * product -- `many-to-many`, where both parties keep their within-dataset
 * duplicates. Under every other cardinality a single record count bounds the
 * table, there is no product to project, and nothing here speaks for the run.
 */
export interface PairTableFactors {
  /** This party's declared record count. */
  local: number;
  /** The partner's declared record count. */
  partner: number;
}

/**
 * The pairs a run on these terms can produce: the worst case, where every record
 * on both sides shares one linkage value. A `bigint` because the two declared
 * counts' own bounds admit a product past `Number.MAX_SAFE_INTEGER`.
 */
export function projectedPairs(factors: PairTableFactors): bigint {
  return BigInt(factors.local) * BigInt(factors.partner);
}

/** The bytes a results file holding {@link projectedPairs} rows costs the writer
 * ({@link RESULT_BYTES_PER_PAIR}). */
export function projectedResultBytes(factors: PairTableFactors): bigint {
  return projectedPairs(factors) * BigInt(RESULT_BYTES_PER_PAIR);
}

/** Whether a run on these terms projects a results file this browser would not
 * keep ({@link MAX_PARKED_RESULT_BYTES}). */
export function projectionOverParkedBound(factors: PairTableFactors): boolean {
  return projectedResultBytes(factors) > BigInt(MAX_PARKED_RESULT_BYTES);
}

/** Whether a results file of `bytes` is one this browser keeps. Weighed on the
 * built file rather than on any projection: what is at rest is the file itself. */
export function resultFitsParkedBound(bytes: number): boolean {
  return bytes <= MAX_PARKED_RESULT_BYTES;
}
