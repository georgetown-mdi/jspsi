// The runtime rules a set of agreed linkage terms is held to, as opposed to the
// shape a terms document must parse into (config/linkageTerms.ts): which
// linkage strategies implement `deduplicate` and many-to-many matching, what a
// count-only (`psi-c`) document may not carry, and which swap-paired key
// elements a single transform would read differently on the two parties.
//
// Each rule is stated once here and read from both directions: the terms schema
// refuses a document that breaks it at parse time, and the exchange re-asserts
// it over the terms actually agreed.

import { UsageError } from "./errors.js";
import { canonicalString, CanonicalEncodingError } from "./utils/canonical.js";
import type {
  LinkageKey,
  LinkageKeyElement,
  LinkageStrategy,
  LinkageTerms,
} from "./config/linkageTerms.js";

/**
 * Which of the count-only shape rules a `psi-c` terms document breaks. The
 * rules this document holds only: the fifth refusal the specification lists
 * reads this party's own INPUT METADATA, which no linkage-terms document
 * holds, and lives beside the disclosure predicate it asks
 * ({@link countOnlyTransmitsColumn}, `config/metadata.ts`).
 */
export type CountOnlyShapeViolation =
  "linkageKeys" | "linkageStrategy" | "deduplicate" | "payload";

/**
 * The refusal message for each count-only shape rule, keyed by the rule
 * broken. Read by every enforcement point -- the {@link LinkageTermsSchema}
 * refines below, {@link assertCountOnlyTermsShape}, and the surfaces' own
 * gates -- so an operator meets the same account wherever the document is
 * stopped.
 *
 * Each message names the rule broken and the two ways out: bring the
 * document into the count-only shape, or ask for the identifier-revealing
 * algorithm that admits it. Fixed literals only, never a value read off the
 * document -- a `psi-c` document can arrive on a partner's invitation, and
 * the parse-error path is left unsanitized (see protocolSetup).
 *
 * The rules and the reasoning behind each: docs/spec/PROTOCOL.md, PSI-C.
 */
export const COUNT_ONLY_SHAPE_REFUSALS: Readonly<
  Record<CountOnlyShapeViolation | "transmittedColumns", string>
> = {
  linkageKeys:
    'count-only ("psi-c") linkage terms must declare exactly one linkage ' +
    "key: a count-only exchange is one PSI round over one key, and a " +
    "multi-key count is not specified, so these terms are refused rather " +
    "than narrowed to the first key. Declare a single linkage key, or set " +
    'the algorithm to "psi" to match on several.',
  linkageStrategy:
    'count-only ("psi-c") linkage terms must set the linkage strategy to ' +
    '"cascade": no count-only single-pass round is specified, so these ' +
    "terms are refused rather than run under a strategy neither party " +
    'agreed to. Set the linkage strategy to "cascade", or set the algorithm ' +
    'to "psi".',
  deduplicate:
    'count-only ("psi-c") linkage terms must set deduplicate to false: a ' +
    "count-only exchange reports the size of the intersection and hands " +
    "neither party a record-by-record pairing, so there is no matching " +
    "multiplicity for it to honor. Set deduplicate to false, or set the " +
    'algorithm to "psi".',
  payload:
    'count-only ("psi-c") linkage terms must declare no payload columns in ' +
    "either direction: a count-only exchange reveals the size of the " +
    "intersection and nothing else, so it sends no data column whichever " +
    "party the terms entitle to the count. Remove the payload send and " +
    'receive columns, or set the algorithm to "psi".',
  transmittedColumns:
    'a count-only ("psi-c") exchange transmits no data columns, but this ' +
    "input's metadata marks one or more columns to send to the partner. The " +
    "algorithm sends no payload in either direction, so the exchange is " +
    "refused rather than run over a disclosure it cannot make. Clear the " +
    'payload marking on those columns, or set the algorithm to "psi".',
};

/**
 * Which count-only shape rule a terms document breaks, or `undefined` when
 * it breaks none -- including for every `psi` document, which these rules
 * leave untouched.
 *
 * The single reading of the specified shape (docs/spec/PROTOCOL.md, PSI-C:
 * one key, one round, cascade only, no deduplication, no payload), so the
 * schema, the asserts, and the two front ends' own gates cannot come to
 * different verdicts. Order is the specification's listing order; a
 * document breaking several rules reports the first, and fixing it surfaces
 * the next.
 *
 * A document already in the specified shape is NOT a violation here: whether
 * the algorithm has a run path at all is `assertAlgorithmImplemented`'s
 * question, not this function's.
 */
export function countOnlyShapeViolation(
  terms: LinkageTerms,
): CountOnlyShapeViolation | undefined {
  if (terms.algorithm !== "psi-c") return undefined;
  if (terms.linkageKeys.length > 1) return "linkageKeys";
  if (terms.linkageStrategy !== "cascade") return "linkageStrategy";
  if (terms.deduplicate) return "deduplicate";
  if (
    (terms.payload?.send?.length ?? 0) > 0 ||
    (terms.payload?.receive?.length ?? 0) > 0
  )
    return "payload";
  return undefined;
}

/**
 * Refuse a `psi-c` terms document outside the shape the specification
 * admits, fail-closed: an over-broad count-only document is never narrowed
 * to one key, never promoted off `cascade`, and never downgraded to a `psi`
 * run -- narrowing or downgrading would deliver a disclosure the operator
 * did not agree to.
 *
 * Applied where a document is authored or minted, and again where a
 * received one is accepted ({@link deriveAcceptedLinkageTerms}); every PARSE
 * path inherits the same rules from {@link LinkageTermsSchema}'s refines, so
 * this is the boundary for a document built or mutated without a parse.
 *
 * Distinct from what `assertDeduplicateImplemented` and
 * `resolveLinkageCardinality` refuse: a count-only run reports a size and
 * hands neither party a record-by-record result, so there is no
 * multiplicity for those to reach.
 *
 * Plain {@link UsageError}, not an `OperatorConfigError`: on the accept side
 * these values are adopted verbatim from the partner's invitation, so the
 * fault is not unconditionally this operator's own. The messages hold only
 * fixed literals.
 */
export function assertCountOnlyTermsShape(terms: LinkageTerms): void {
  const violation = countOnlyShapeViolation(terms);
  if (violation === undefined) return;
  throw new UsageError(COUNT_ONLY_SHAPE_REFUSALS[violation]);
}

/**
 * Which linkage strategies realize a deduplicating match, one entry per
 * strategy. Both do: the cascade re-expands a match on a kept value across
 * the group in each round (`linkViaPSI`), and `single-pass` applies the same
 * per-side rules in the receiver's local replay over the index table it
 * already ships (`linkViaSinglePassPSI`).
 *
 * A total table over {@link LinkageStrategy} rather than a comparison
 * against one named strategy, so a strategy added to the union states its
 * own verdict here or the build fails -- neither the refusal below nor the
 * consent copy reading the same verdict can be left behind by an addition.
 * Typed `boolean` rather than the literal values so each reader's gate gives
 * a genuine runtime branch.
 *
 * @internal exported for the tests that drive its readers over every
 * strategy, here and in the web editor's own Generate gate.
 */
export const DEDUPLICATE_IMPLEMENTED_BY_STRATEGY: Record<
  LinkageStrategy,
  boolean
> = {
  cascade: true,
  "single-pass": true,
};

/**
 * Whether an exchange on `strategy` honors a `deduplicate: true` term.
 *
 * The one predicate behind both readers of that verdict:
 * {@link assertDeduplicateImplemented} refuses the pair it returns `false`
 * for, and the consent summary's `deduplicateApplied` withholds the
 * grouping disclosure copy on the same answer (`invitationSummary.ts`), so
 * the two cannot silently diverge.
 */
export function deduplicateIsImplementedForStrategy(
  strategy: LinkageStrategy,
): boolean {
  return DEDUPLICATE_IMPLEMENTED_BY_STRATEGY[strategy];
}

/**
 * Refuse a linkage-terms `deduplicate: true` the run cannot honor, before
 * any matching begins: the term under a linkage strategy that does not
 * match a deduplicating cardinality
 * ({@link deduplicateIsImplementedForStrategy}).
 *
 * Both shipped strategies match one today, so this refuses nothing an
 * operator can configure currently; it stays as the boundary a strategy
 * answering `false` in {@link DEDUPLICATE_IMPLEMENTED_BY_STRATEGY} is
 * stopped at. The combination that IS refused today is the agreed
 * `(true, true)` pair under a strategy that pairs no both-sided
 * cardinality, which this guard cannot express since it reads one party's
 * document alone -- its own boundary is
 * {@link assertBothSidedDeduplicateImplemented}.
 *
 * Applied where a document is authored or minted, where a received
 * invitation is accepted ({@link deriveAcceptedLinkageTerms}), and for both
 * parties' agreed terms by `resolveLinkageCardinality` after the terms
 * exchange, before the PSI rounds begin. The accept boundary is what keeps
 * a crafted pair off the consent surfaces.
 *
 * Reads the whole terms document rather than the two values, so a caller
 * cannot pass one party's `deduplicate` against the other's strategy.
 *
 * Plain {@link UsageError}, not an `OperatorConfigError`: the refusing party
 * is not necessarily the one whose value refuses, since
 * `resolveLinkageCardinality` asserts over the PARTNER's terms document too,
 * so the fault is not unconditionally this operator's own. The message
 * holds only fixed literals.
 */
export function assertDeduplicateImplemented(terms: LinkageTerms): void {
  if (!terms.deduplicate) return;
  if (deduplicateIsImplementedForStrategy(terms.linkageStrategy)) return;
  throw new UsageError(
    "deduplicated matching is not implemented for the linkage strategy these " +
      'terms name: a "deduplicate: true" term would be matched one-to-one ' +
      "rather than honored, so the exchange is refused before matching " +
      "begins. Set linkage_strategy to cascade or single-pass to run a " +
      "deduplicating match, or set deduplicate to false.",
  );
}

/**
 * Which linkage strategies pair the BOTH-sided deduplicating cardinality,
 * one entry per strategy. The cascade does, applying the "many" rule to
 * each party so a matched value contributes the two groups' product;
 * `single-pass` does not (docs/spec/PROTOCOL.md, Deduplicating
 * cardinalities: many-to-X matching).
 *
 * Separate from {@link DEDUPLICATE_IMPLEMENTED_BY_STRATEGY}: that table asks
 * whether a strategy honors one party's `deduplicate: true` at all, this
 * asks whether it pairs the cardinality the agreed PAIR resolves to when
 * both parties declare it. Single-pass answers `true` to the first and
 * `false` to the second.
 *
 * A total table over {@link LinkageStrategy}, typed `boolean`, for the same
 * reason as its sibling.
 *
 * @internal exported for the tests that drive its readers over every
 * strategy.
 */
export const MANY_TO_MANY_IMPLEMENTED_BY_STRATEGY: Record<
  LinkageStrategy,
  boolean
> = {
  cascade: true,
  "single-pass": false,
};

/**
 * Whether an exchange on `strategy` pairs the both-sided deduplicating
 * cardinality.
 *
 * The one predicate behind both readers of that verdict:
 * {@link assertBothSidedDeduplicateImplemented} refuses the agreed pair it
 * returns `false` for, and the strategy's own fail-closed half reads it at
 * the boundary that would otherwise pair it (`singlePassResolves`,
 * `link.ts`), so the two cannot silently diverge.
 */
export function manyToManyIsImplementedForStrategy(
  strategy: LinkageStrategy,
): boolean {
  return MANY_TO_MANY_IMPLEMENTED_BY_STRATEGY[strategy];
}

/**
 * Refuse the agreed `(true, true)` pair on a linkage strategy that does not
 * pair the both-sided cardinality it resolves to, before any matching
 * begins.
 *
 * The both-sided sibling of {@link assertDeduplicateImplemented}: a
 * per-party reading answers `true` for a single-pass party whose own
 * `deduplicate: true` is perfectly runnable one-sided, so only a check over
 * BOTH documents can refuse the combination the strategy will not pair.
 *
 * Called from `resolveLinkageCardinality` (`exchange.ts`) after the terms
 * exchange and before the first round. Symmetric in the pair -- it reads
 * both documents' strategies and refuses if EITHER fails to hold the
 * cardinality, so a refused pair aborts both parties at the same point.
 *
 * The message names the STRATEGY rather than the pair, read off
 * {@link MANY_TO_MANY_IMPLEMENTED_BY_STRATEGY} so a strategy that later
 * pairs the cardinality is named the moment its entry says so.
 *
 * Plain {@link UsageError}, not an `OperatorConfigError`, for the same
 * reason as its sibling: this check reads the PARTNER's document as well as
 * this party's, so the fault is not unconditionally this operator's own.
 */
export function assertBothSidedDeduplicateImplemented(
  localTerms: LinkageTerms,
  partnerTerms: LinkageTerms,
): void {
  if (!(localTerms.deduplicate && partnerTerms.deduplicate)) return;
  if (
    manyToManyIsImplementedForStrategy(localTerms.linkageStrategy) &&
    manyToManyIsImplementedForStrategy(partnerTerms.linkageStrategy)
  )
    return;
  const pairing = (
    Object.keys(MANY_TO_MANY_IMPLEMENTED_BY_STRATEGY) as Array<LinkageStrategy>
  )
    .filter(manyToManyIsImplementedForStrategy)
    .sort();
  const oneSidedRemedy =
    "deduplicate to false on one of the two parties to run a many-to-one " +
    "match.";
  throw new UsageError(
    "the linkage strategy these terms name does not match a many-to-many " +
      "cardinality, which is what both parties setting deduplicate to true " +
      "resolves to: each party's records may then group the other's, and the " +
      "strategy this exchange runs pairs one side's grouping only. The " +
      "exchange is refused before matching begins rather than matched to less " +
      "than the terms declare. " +
      (pairing.length > 0
        ? `Set linkage_strategy to ${pairing.join(" or ")} to run the pair, ` +
          `or set ${oneSidedRemedy}`
        : `Set ${oneSidedRemedy}`),
  );
}

// The two elements a key's `swap` names, or undefined when the key declares no
// swap or when a target resolves to no element of that key -- the dangling case
// the referential-integrity refine owns, which every rule about a PAIR passes
// over so the document is answered by the one message about its actual fault.
// Element identity is `el.name ?? el.field`, the same expression the
// element-identifier-uniqueness refine uses, so the rules cannot disagree about
// which two elements a swap names.
function swapPairedElements(
  key: LinkageKey,
): [LinkageKeyElement, LinkageKeyElement] | undefined {
  if (key.swap === undefined) return undefined;
  const [first, second] = key.swap.map((target) =>
    key.elements.find((el) => (el.name ?? el.field) === target),
  );
  if (first === undefined || second === undefined) return undefined;
  return [first, second];
}

// Whether two swap-paired positions declare the same transform pipeline. An
// absent `transform` and an empty one are both the identity pipeline, so
// both normalize to the empty list. Equality is by canonical encoding
// rather than a structural walk, since a `params` record's key order is not
// significant to the agreed terms, which are hashed in this same canonical
// form.
//
// `transform.params` values are `z.unknown()`, so a partner value outside
// the reproducible canonical domain (a JSON integer beyond 2^53) survives
// schema parsing and then fails to encode. Such a pair is reported as
// DIFFERING rather than propagating the throw: a pipeline that cannot be
// encoded cannot be shown to match its partner position.
function swapPairDeclaresOneTransform(
  first: LinkageKeyElement,
  second: LinkageKeyElement,
): boolean {
  try {
    return (
      canonicalString(first.transform ?? []) ===
      canonicalString(second.transform ?? [])
    );
  } catch (err) {
    if (err instanceof CanonicalEncodingError) return false;
    throw err;
  }
}

/**
 * Whether the two elements this key's `swap` names declare DIFFERENT
 * transforms, the shape {@link LinkageTermsSchema} refuses.
 *
 * A swap moves the field references and leaves each element's own transform
 * on its position, so only a pair whose transforms agree compares
 * like-normalized values on both sides of the swapped key. An omitted
 * transform and an empty one are the same identity pipeline, and two
 * `params` records differing only in key order are one pipeline.
 *
 * False for a key declaring no swap, and for one whose swap target resolves
 * to no element -- the dangling case the schema answers by its own rule.
 *
 * Exported so an authoring surface can name this fault before the schema
 * refuses the document.
 */
export function swapPairTransformsDiffer(key: LinkageKey): boolean {
  const paired = swapPairedElements(key);
  return (
    paired !== undefined && !swapPairDeclaresOneTransform(paired[0], paired[1])
  );
}

/**
 * Whether the two elements this key's `swap` names declare DIFFERENT
 * `generateFuzzyComparisons`, the sibling shape {@link LinkageTermsSchema}
 * refuses beside {@link swapPairTransformsDiffer}.
 *
 * A swap moves only the field references and leaves each position's own
 * expansion where it is, so a mismatched pair would expand a column one way
 * on the party that swaps and another on the party that does not.
 *
 * False for a key declaring no swap, and for one whose swap target resolves
 * to no element -- the dangling case the schema answers by its own rule.
 *
 * Exported for the key-read layer, which reads the pair's two positions as
 * interchangeable when it assembles the swapped order (`planKeyRead`,
 * standardization.ts).
 */
export function swapPairFuzzyComparisonsDiffer(key: LinkageKey): boolean {
  const paired = swapPairedElements(key);
  return (
    paired !== undefined &&
    paired[0].generateFuzzyComparisons !== paired[1].generateFuzzyComparisons
  );
}
