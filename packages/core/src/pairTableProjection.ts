import { MAX_RECORD_COUNT } from "./connection/frameSize.js";

import type { LinkageCardinality } from "./link.js";

/**
 * What a run resolved to at the post-terms, pre-round boundary: the
 * matching cardinality both parties derived from the agreed `deduplicate`
 * pair, the two record counts the derived pair table's size follows from,
 * and the two entitlements that decide which party ends up holding what the
 * pairing produces.
 *
 * Every field is fixed before the first PSI round and comes from
 * authenticated session state: the cardinality from
 * {@link resolveLinkageCardinality} over both parties' agreed terms, this
 * party's own row count from its loaded dataset and the count it declared
 * from that count and its own cleaning, the partner's from the
 * terms-exchange envelope (bounded by its schema, `recordCountField`,
 * protocolSetup.ts, to a nonnegative integer no larger than
 * {@link MAX_RECORD_COUNT}), and both entitlements from the two agreed
 * terms documents plus the resolved role. {@link runExchange} hands the
 * whole shape to its `onProtocolConfirmed` callback, so a front end reads
 * the same state the run resolved from rather than deriving its own.
 *
 * The entitlements are here because the copy composed from this shape
 * speaks about a result and about what the partner learns, and neither
 * follows from the cardinality alone: a cardinality label plus a record
 * count cannot tell a party whether it receives a result at all, so a
 * notice resting on the cardinality alone would assert an entitlement the
 * run may not have.
 */
export interface ResolvedRunShape {
  readonly cardinality: LinkageCardinality;
  /** This party's own raw dataset record count. */
  readonly localRecordCount: number;
  /**
   * This party's record count as DECLARED on the terms exchange: its raw
   * count times the fan-out factor its own standardization declares
   * (`localFanOutFactor`, fanOutFunctions.ts), so it equals
   * {@link localRecordCount} for a party whose own cleaning does not fan
   * out.
   *
   * The figure role resolution weighed, the one the partner holds for this
   * party, and the one {@link projectPairTable} multiplies -- both parties
   * hold both declared counts and neither holds the other's raw one, so a
   * projection over the declared pair is the only one the two sides agree
   * on. The raw count is kept beside it, since it is what this party's
   * rows actually number.
   */
  readonly localDeclaredRecordCount: number;
  /** The partner's record count as declared on the terms exchange. */
  readonly partnerRecordCount: number;
  /**
   * Whether this party's own agreed terms entitle it to the matched result
   * (`output.expectsOutput`).
   *
   * The same predicate gates the association table {@link runExchange}
   * returns (`heldResult`, exchange.ts), so it determines whether this
   * party writes a result file at all. A party this is false for has a
   * partner it is true for -- `validateCompatibility` refuses a pair where
   * neither expects output -- so the pairing this run produces is always
   * held by someone.
   */
  readonly localExpectsOutput: boolean;
  /**
   * Whether this run withholds the PARTNER's half of the association table
   * entirely, leaving it blind to which of its own records matched and to the
   * size of any group of this party's records standing behind one of them.
   *
   * The single-pass blind-helper case (`withholdsSenderAssociationTable`,
   * link.ts): the partner is the resolved sender, expects no output, and
   * discloses no payload, so the receiver suppresses its half rather than
   * sending it. False under the cascade, which withholds no half.
   */
  readonly partnerAssociationTableWithheld: boolean;
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
interface PairTableProjection {
  /**
   * This party's own raw dataset record count. Not a factor of the product: it
   * is the rows the advisory names behind a declared count its cleaning fanned.
   */
  readonly localRecordCount: number;
  /** This party's declared record count, one factor of the product. */
  readonly localDeclaredRecordCount: number;
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
 * Project the derived pair table's size for a resolved run, or `undefined`
 * where the cardinality puts no product on it.
 *
 * Only `many-to-many` grows quadratically: both parties keep their
 * within-dataset duplicates, so the table is bounded at the two DECLARED
 * record counts' product and no derived frame or dataset bound narrows it
 * (docs/spec/PROTOCOL.md, The both-sided expansion has no ceiling of its
 * own). Under every other cardinality at most one side keeps duplicates and
 * the table is bounded by a single record count, so there is no product to
 * project and this returns `undefined`.
 *
 * The product is DECLARED times DECLARED on both sides, so the two parties
 * project the same figure for the same run: each party holds its own raw
 * row count and neither holds the other's, so mixing a raw factor with a
 * declared one would give the two sides different totals for one run.
 *
 * The projection is the worst case rather than a prediction: what the
 * pairing produces when every record on both sides shares one value, at
 * counts a fan-out can only overstate. A run that matches less produces
 * less, and no run produces more.
 */
export function projectPairTable(
  shape: ResolvedRunShape,
): PairTableProjection | undefined {
  if (shape.cardinality !== "many-to-many") return undefined;
  if (
    !isDeclarableRecordCount(shape.localRecordCount) ||
    !isDeclarableRecordCount(shape.localDeclaredRecordCount) ||
    !isDeclarableRecordCount(shape.partnerRecordCount)
  )
    return undefined;
  const projectedPairs =
    BigInt(shape.localDeclaredRecordCount) * BigInt(shape.partnerRecordCount);
  return {
    localRecordCount: shape.localRecordCount,
    localDeclaredRecordCount: shape.localDeclaredRecordCount,
    partnerRecordCount: shape.partnerRecordCount,
    projectedPairs,
    exceedsAdvisoryBound:
      projectedPairs > BigInt(PAIR_TABLE_ADVISORY_MAX_PAIRS),
  };
}

// An explicit locale, so the grouped digits are the same ASCII bytes on
// every host and in every browser: the CLI's console sentinel fails a line
// containing a byte outside printable ASCII, which a locale-default
// separator (a non-breaking space in several) would put there.
function formatCount(count: number | bigint): string {
  return new Intl.NumberFormat("en-US").format(count);
}

// Exhaustive over the union with no default, so a cardinality added to the
// label set fails to compile here rather than resolving to silence by
// omission.
//
// Every sentence about a result file or about what the partner reads is
// chosen from the entitlements the shape holds rather than from the
// cardinality label, which determines neither: a party the agreed terms
// give no output is handed no association table at all (`heldResult`,
// exchange.ts), so naming "your result file" to it would assert an
// entitlement the run does not have. Where this party holds no result its
// partner does -- `validateCompatibility` refuses a pair where neither
// expects output -- so the pairing is always attributable to someone.
//
// Each branch spells its whole sentence rather than interpolating a phrase
// a ternary picked: the readings are fixed first-party copy, and writing
// them out keeps each one readable as the sentence an operator meets.
function describeCardinality(shape: ResolvedRunShape): string | undefined {
  switch (shape.cardinality) {
    case "one-to-one":
      return undefined;
    case "many-to-one":
      return (
        "This exchange resolved to many-to-one matching: you keep your " +
        "within-dataset duplicate values, so several of your records can match " +
        "one of your partner's. " +
        (shape.partnerAssociationTableWithheld
          ? "This run withholds your partner's half of the matched-pair " +
            "table, so it learns neither which of its own records matched nor " +
            "how many of yours share a linkage-key value."
          : "For each of its records that matched, your partner learns how " +
            "many of yours share that linkage-key value.")
      );
    case "one-to-many":
      return (
        "This exchange resolved to one-to-many matching: your partner keeps " +
        "its within-dataset duplicate values, so several of its records can " +
        "match one of yours. " +
        (shape.localExpectsOutput
          ? "Your result file has one row per matched pair, so one of " +
            "your records can appear on several rows."
          : "By the agreed terms you receive no result from this run, so " +
            "those pairs land in your partner's result file, where one of " +
            "your records can appear on several rows.")
      );
    case "many-to-many":
      return (
        "This exchange resolved to many-to-many matching: both parties keep " +
        "their within-dataset duplicate values, so one matched value pairs " +
        "every one of your records holding it with every one of your " +
        "partner's. " +
        (shape.localExpectsOutput
          ? "Your result file has one row per matched pair, so it can " +
            "hold far more rows than either party has records."
          : "By the agreed terms you receive no result from this run, so " +
            "those pairs land in your partner's result file, which has " +
            "one row per pair and can hold far more rows than either party " +
            "has records.")
      );
  }
}

// Both factors are the DECLARED counts, so the sentence names the same two
// numbers on both parties and the total it reports is the one the partner's own
// advisory reports. Where this party's cleaning fanned its declared count past
// its rows, a second sentence says so: the first sentence otherwise names a
// record count the operator cannot find in its own file.
function describePairTableProjection(projection: PairTableProjection): string {
  return (
    `This run projects up to ${formatCount(projection.projectedPairs)} matched ` +
    `pairs: the ${formatCount(projection.localDeclaredRecordCount)} records ` +
    `you declared on the terms exchange times the ` +
    `${formatCount(projection.partnerRecordCount)} your partner declared. ` +
    (projection.localDeclaredRecordCount > projection.localRecordCount
      ? `Your declared count stands for your ` +
        `${formatCount(projection.localRecordCount)} records, each of which ` +
        "your own data cleaning fans out into several candidate values. "
      : "") +
    "That is above the advisory bound of " +
    `${formatCount(PAIR_TABLE_ADVISORY_MAX_PAIRS)} pairs. Nothing refuses on ` +
    "the projection and the exchange continues, but the result has one " +
    "row per pair, so expect a large result and a long run. To bring it down, " +
    "reduce either side's record count or agree terms that do not keep both " +
    "sides' duplicates."
  );
}

/** What a front end renders for a resolved run at the pre-round boundary. */
interface ResolvedRunShapeNotices {
  /**
   * Names the deduplicating cardinality this run resolved to and what it means
   * for the result this party holds and for what the partner reads, or
   * `undefined` under `one-to-one`, which is the shape every consent surface
   * already describes and the only one that adds no multiplicity.
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
    cardinalityNotice: describeCardinality(shape),
    pairTableAdvisory:
      projection !== undefined && projection.exceedsAdvisoryBound
        ? describePairTableProjection(projection)
        : undefined,
  };
}
