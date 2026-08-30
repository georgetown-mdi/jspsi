import { MAX_RECORD_COUNT } from "./connection/frameSize.js";

import type { LinkageCardinality } from "./link.js";

/**
 * What a run resolved to at the post-terms, pre-round seam: the matching
 * cardinality both parties derived from the agreed `deduplicate` pair, and the
 * two record counts the derived pair table's size follows from.
 *
 * Every field is settled before the first PSI round and comes from authenticated
 * session state: the cardinality from {@link resolveLinkageCardinality} over both
 * parties' agreed terms, this party's own row count from its loaded dataset, and
 * the partner's from the terms-exchange envelope, whose schema
 * (`recordCountField`, protocolSetup.ts) bounds it to a nonnegative integer no
 * larger than {@link MAX_RECORD_COUNT}. {@link runExchange} hands the triple to
 * its `onProtocolConfirmed` callback, so a front end reads the same state the run
 * resolved from rather than deriving its own.
 */
export interface ResolvedRunShape {
  readonly cardinality: LinkageCardinality;
  /** This party's own raw dataset record count. */
  readonly localRecordCount: number;
  /** The partner's record count as declared on the terms exchange. */
  readonly partnerRecordCount: number;
}

/**
 * The projected pair count above which {@link describeResolvedRunShape} composes
 * the pair-table advisory.
 *
 * Advisory only. Nothing in the protocol, the run path, or either front end
 * refuses on this number -- the both-sided expansion takes no ceiling by decision
 * (docs/spec/PROTOCOL.md, The both-sided expansion has no ceiling of its own), so
 * the value decides only whether a string is shown. Its derivation from the result
 * file's measured bytes per pair is recorded in that same section.
 */
export const PAIR_TABLE_ADVISORY_MAX_PAIRS = 10_000_000;

/**
 * A run's projected derived pair table: what the two counts multiply to, and
 * whether that product is above {@link PAIR_TABLE_ADVISORY_MAX_PAIRS}.
 */
export interface PairTableProjection {
  /** This party's own record count, one factor of the product. */
  readonly localRecordCount: number;
  /** The partner's declared record count, the other factor. */
  readonly partnerRecordCount: number;
  /**
   * The exact product of the two counts.
   *
   * A `bigint` because the counts' own bounds admit a product past
   * `Number.MAX_SAFE_INTEGER`: two parties each declaring {@link MAX_RECORD_COUNT}
   * multiply to 10^24, so a `number` product would be an approximation both in the
   * comparison below and in the figure the advisory names.
   */
  readonly projectedPairs: bigint;
  readonly exceedsAdvisoryBound: boolean;
}

// A count this projection can multiply: the bounds the terms-exchange schema
// (`recordCountField`, protocolSetup.ts) holds a declared count to, which is
// where a count outside them is refused as a `protocol` decode failure. Failing
// SOFT here rather than throwing -- an advisory is no reason to end an exchange
// -- so a count this rejects yields no projection while the cardinality is named
// as usual.
function isDeclarableRecordCount(count: number): boolean {
  return Number.isSafeInteger(count) && count >= 0 && count <= MAX_RECORD_COUNT;
}

/**
 * Project the derived pair table's size for a resolved run, or `undefined` where
 * the cardinality puts no product on it.
 *
 * Only `many-to-many` grows quadratically: both parties keep their within-dataset
 * duplicates, so the returned-list checks bound the table at this party's own row
 * count times the partner's declared record count and no derived frame or dataset
 * bound narrows it (docs/spec/PROTOCOL.md, The both-sided expansion has no ceiling
 * of its own). Under every other cardinality at most one side keeps duplicates and
 * the table is bounded by a single record count, so there is no product to project
 * and this returns `undefined`.
 *
 * The projection is the honest worst case rather than a prediction: it is what the
 * pairing produces when every record on both sides shares one value. A run that
 * matches less produces less, and no run produces more.
 */
export function projectPairTable(
  shape: ResolvedRunShape,
): PairTableProjection | undefined {
  if (shape.cardinality !== "many-to-many") return undefined;
  if (
    !isDeclarableRecordCount(shape.localRecordCount) ||
    !isDeclarableRecordCount(shape.partnerRecordCount)
  )
    return undefined;
  const projectedPairs =
    BigInt(shape.localRecordCount) * BigInt(shape.partnerRecordCount);
  return {
    localRecordCount: shape.localRecordCount,
    partnerRecordCount: shape.partnerRecordCount,
    projectedPairs,
    exceedsAdvisoryBound:
      projectedPairs > BigInt(PAIR_TABLE_ADVISORY_MAX_PAIRS),
  };
}

// An explicit locale, so the grouped digits are the same ASCII bytes on every
// host and in every browser: the CLI's console sentinel fails a line carrying a
// byte outside printable ASCII, which a locale-default separator (a non-breaking
// space in several) would put there.
function formatCount(count: number | bigint): string {
  return new Intl.NumberFormat("en-US").format(count);
}

// Exhaustive over the union with no default, so a cardinality added to the label
// set fails to compile here rather than resolving to silence by omission.
function describeCardinality(
  cardinality: LinkageCardinality,
): string | undefined {
  switch (cardinality) {
    case "one-to-one":
      return undefined;
    case "many-to-one":
      return (
        "This exchange resolved to many-to-one matching: you keep your " +
        "within-dataset duplicate values, so several of your records can match " +
        "one of your partner's. For each of its records that matched, your " +
        "partner learns how many of yours share that linkage-key value."
      );
    case "one-to-many":
      return (
        "This exchange resolved to one-to-many matching: your partner keeps " +
        "its within-dataset duplicate values, so several of its records can " +
        "match one of yours. Your result file carries one row per matched " +
        "pair, so one of your records can appear on several rows."
      );
    case "many-to-many":
      return (
        "This exchange resolved to many-to-many matching: both parties keep " +
        "their within-dataset duplicate values, so one matched value pairs " +
        "every one of your records holding it with every one of your " +
        "partner's. Your result file carries one row per matched pair, so it " +
        "can hold far more rows than either party has records."
      );
  }
}

function describePairTableProjection(projection: PairTableProjection): string {
  return (
    `This run projects up to ${formatCount(projection.projectedPairs)} matched ` +
    `pairs: your ${formatCount(projection.localRecordCount)} records times ` +
    `the ${formatCount(projection.partnerRecordCount)} your partner declared ` +
    "on the terms exchange. That is above the advisory bound of " +
    `${formatCount(PAIR_TABLE_ADVISORY_MAX_PAIRS)} pairs. Nothing refuses on ` +
    "the projection and the exchange continues, but the result file carries " +
    "one row per pair, so expect a large result file and a long run. To bring " +
    "it down, reduce either side's record count or agree terms that do not " +
    "keep both sides' duplicates."
  );
}

/** What a front end renders for a resolved run at the pre-round seam. */
export interface ResolvedRunShapeNotices {
  /**
   * Names the deduplicating cardinality this run resolved to, or `undefined`
   * under `one-to-one`, which is the shape every consent surface already
   * describes and the only one that adds no multiplicity.
   */
  readonly cardinalityNotice: string | undefined;
  /**
   * Names the projected pair count and what each side contributes to it, or
   * `undefined` while the projection is within
   * {@link PAIR_TABLE_ADVISORY_MAX_PAIRS} (and under every cardinality that
   * projects no product at all).
   */
  readonly pairTableAdvisory: string | undefined;
}

/**
 * Compose what a front end shows for a resolved run, after the terms exchange
 * and before the first round.
 *
 * The composition is pure and this module raises nothing itself: the spec makes
 * the pair-table advisory a front end's discretion (docs/spec/PROTOCOL.md, The
 * both-sided expansion has no ceiling of its own), so `runExchange` hands each
 * seat the {@link ResolvedRunShape} and each seat decides where and how loudly to
 * render what this returns. A warning emitted from the run path would decide it
 * for every seat instead.
 *
 * Both strings are first-party prose over two integers this function formats
 * itself, so no partner-authored text is interpolated into either and a display
 * sink escapes them exactly as it escapes any other message it is handed.
 */
export function describeResolvedRunShape(
  shape: ResolvedRunShape,
): ResolvedRunShapeNotices {
  const projection = projectPairTable(shape);
  return {
    cardinalityNotice: describeCardinality(shape.cardinality),
    pairTableAdvisory:
      projection !== undefined && projection.exceedsAdvisoryBound
        ? describePairTableProjection(projection)
        : undefined,
  };
}
