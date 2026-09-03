/**
 * The declared fan-out producers: which standardization functions expand ONE
 * value into several match candidates, the membership test the compiler captures
 * per step, the per-key width the agreed terms declare, and the effective key
 * count the exchange's slot arithmetic is derived from.
 *
 * Its own module because the list steers a runtime decision -- whether an
 * over-width or unassemblable row is dropped or refused -- so the membership test
 * needs a seam the unit tests can drive without the exported list itself being
 * writable (see {@link withNoListedFanOutFunctions}). It carries the width
 * derivation beside the list so the connection and protocol layers, which bound a
 * partner-supplied frame from them, reach them without importing the whole
 * standardization pipeline. `standardization.ts` re-exports both, which is where
 * consumers read them from.
 */

import { APPLIED_SETTINGS } from "./appliedSettings.js";
import { MAX_LINKAGE_ENTRIES } from "./config/linkageTerms.js";
import type { LinkageKey, LinkageTerms } from "./config/linkageTerms.js";
import { UsageError } from "./errors.js";
import { fuzzyCandidateCeiling } from "./fuzzyComparisons.js";
import { elementValueWidthBound } from "./keyElementWidth.js";

/**
 * The standardization functions that expand ONE value into several match
 * candidates -- the multi-value `FieldValue` case. An exchange whose transforms
 * declare one of these matches on every candidate under the single-pass strategy,
 * and is refused under every other rather than run with the narrower matching one
 * of those would actually deliver; see `assertFanOutImplemented`.
 *
 * It is also what {@link declaredKeyWidth} reads to decide an element's candidate
 * factor, so an entry here widens every derived single-pass bound for an exchange
 * whose agreed key elements the named function feeds.
 *
 * Hand-listed, because whether a factory can return a multi-value `Set` is not
 * derivable from the registry. A fan-out function added to
 * `STANDARDIZING_FUNCTIONS` without an entry here is not left to narrow silently:
 * `buildKeyStrings` carries every candidate through to the record's candidate
 * set, and the seam that consumes it refuses a record carrying more than the
 * declared width admits -- `fanOutReachedMatchingRefusal` on the cascade and on a
 * single-pass party this list left declaring no fan-out. That refusal is the
 * point of harm rather than a pre-run gate: it fires as a round is built, which
 * is after the terms exchange, so it is the DECLARED step this list carries that
 * is refused before anything reaches the wire.
 *
 * The list is also what the width-bound drop binds: multiplicity produced by a
 * function named here is dropped when it exceeds the bound, and multiplicity from
 * any other function is carried through to that refusal instead
 * (`buildKeyStrings`), so an unlisted producer stays fail-closed at every width.
 *
 * Frozen, not merely `readonly`: `readonly` is erased at run time, and this list
 * decides drop versus refusal per compiled step, so a consumer that mutated it in
 * place would silently retune a fail-closed control.
 */
export const FAN_OUT_FUNCTION_NAMES: readonly string[] = Object.freeze([
  "split_on",
]);

// The membership `compileStep` captures per step. Derived from the frozen list,
// which stays the single source of truth; the binding is separate only so the
// test lever below can stand a listed producer in for an unlisted one.
let listedFanOutFunctions: ReadonlySet<string> = new Set(
  FAN_OUT_FUNCTION_NAMES,
);

/**
 * Whether `functionName` is one of the declared fan-out producers.
 */
export function isListedFanOutFunction(functionName: string): boolean {
  return listedFanOutFunctions.has(functionName);
}

/**
 * @internal exported so the unit tests can drive the case core has no occupant
 * for -- a standardizing function that expands one value into several candidates
 * without being listed as a fan-out producer. Running `body` with no function
 * listed makes `split_on` compile as that producer, which is what a registry
 * entry added without a matching entry in {@link FAN_OUT_FUNCTION_NAMES} would
 * be. It moves the compile-time capture alone: the exported list is unchanged, so
 * the declared-step gate and the consent surfaces still read `split_on` as the
 * fan-out producer it is. Synchronous bodies only -- a thenable return is
 * refused -- and a nested call restores its caller's override rather than the
 * full list.
 */
export function withNoListedFanOutFunctions<T>(body: () => T): T {
  const previous = listedFanOutFunctions;
  listedFanOutFunctions = new Set();
  try {
    const result = body();
    if (
      typeof (result as { then?: unknown } | null | undefined)?.then ===
      "function"
    ) {
      throw new Error(
        "withNoListedFanOutFunctions supports synchronous bodies only: the listing is restored when body returns, so an async body would run with it restored",
      );
    }
    return result;
  } finally {
    listedFanOutFunctions = previous;
  }
}

/**
 * The candidate values ONE declared fan-out step contributes to the element it
 * runs on: `split_on` shatters a cell into at most this many parts as far as the
 * declared width is concerned (docs/spec/PROTOCOL.md, The width bound).
 *
 * The value is an arbitrary working figure with no privacy, protocol, or
 * disclosure meaning: it is set where it covers the honest shapes seen so far
 * with margin -- a hyphenated name plus a compound field is sixteen candidates at
 * four parts each -- and nothing else picks it. Raise it whenever a use case
 * needs more; the only constraint is the arithmetic, since it multiplies into the
 * template-wide width total ({@link MAX_EFFECTIVE_KEY_COUNT}) that keeps the slot
 * product exact in a double (connection/frameSize.ts), which the tests pin. It is
 * not operator-configurable, because a partner-supplied frame's element and byte
 * bounds are derived from the widths built on it, so moving it re-derives those.
 *
 * The operator advisory raised for a wide per-record expansion shares this
 * figure as its own threshold, whatever width the key it fires on declares; it
 * shares the number rather than explaining it.
 *
 * A record realizing more candidates for a key than that key's declared width
 * admits contributes NONE of them to the round: `buildKeyStrings` drops it
 * exactly as an absent (`NULL`) realization is dropped, warns the operator, and
 * leaves the record eligible for later keys. Deliberately not a run refusal --
 * the transforms are partner-authored while the values expanded are this party's
 * own rows, so failing the run would let a partner end an exchange by authoring a
 * delimiter that shatters one local value.
 *
 * It is also the factor a party's own standardization contributes to its DECLARED
 * RECORD COUNT ({@link localFanOutFactor}): local cleaning that fans out is the
 * party's own business and rides no agreed term, so it is declared as the extra
 * records it stands for rather than as extra width.
 */
export const FAN_OUT_CANDIDATES_PER_ELEMENT = 20;

/**
 * The ceiling on any ONE key's declared width: the candidates a single record may
 * contribute to a single linkage key's round.
 *
 * Equal by construction to the count limb of the key-string assembly cap
 * (`MAX_KEY_STRINGS_PER_ROW`, standardization.ts), so the width a key declares and
 * the cross-product the row builder will assemble for it are bounded by the same
 * number: a key whose declared width would exceed what the builder can assemble is
 * refused when the width is derived, before any row is read, rather than dropping
 * every row at the assembly cap.
 */
export const MAX_KEY_CANDIDATE_WIDTH = 1024;

/**
 * The ceiling on the SUM of a party's per-key declared widths -- its effective key
 * count, the multiplier on its record count in every derived single-pass bound
 * (`valueSlots`, connection/frameSize.ts).
 *
 * Bounding the sum rather than the per-key width times the key count is what keeps
 * the slot arithmetic's exact-integer premise literally unchanged: at
 * {@link MAX_KEY_CANDIDATE_WIDTH} per key across the {@link MAX_LINKAGE_ENTRIES}
 * keys the terms schema admits, `effectiveKeyCount * MAX_RECORD_COUNT` would leave
 * the range a double represents exactly, while this bound holds that product where
 * it has always been (docs/spec/PROTOCOL.md, The width bound).
 */
export const MAX_EFFECTIVE_KEY_COUNT =
  MAX_LINKAGE_ENTRIES * FAN_OUT_CANDIDATES_PER_ELEMENT;

/**
 * The name of the first declared fan-out producer among `steps`, or `undefined`
 * when none of them declares one. Reads the frozen
 * {@link FAN_OUT_FUNCTION_NAMES} list rather than the compile-time membership
 * binding above, so the declared-step gates and the effective key count are
 * unaffected by the test lever.
 */
export function declaredFanOutFunction(
  steps: ReadonlyArray<{ function: string }> | undefined,
): string | undefined {
  return steps?.find((step) => FAN_OUT_FUNCTION_NAMES.includes(step.function))
    ?.function;
}

// The key's position in the agreed terms, for a refusal that must locate the
// offender without echoing the partner-authored key name.
function keySite(keyIndex: number | undefined): string {
  return keyIndex === undefined
    ? "a linkage key"
    : `the linkage key at linkageKeys[${keyIndex}]`;
}

/**
 * The width one linkage key declares: the candidate values one record may
 * contribute to that key's round, derived from the AGREED terms alone
 * (docs/spec/PROTOCOL.md, The width bound).
 *
 * It is the PRODUCT over the key's elements of each element's own candidate
 * factor, because `buildKeyStrings` assembles the key from the cross-product of
 * its elements' candidate lists: an element whose `transform` declares a fan-out
 * contributes {@link FAN_OUT_CANDIDATES_PER_ELEMENT}, one declaring a fuzzy
 * comparison contributes that kind's {@link fuzzyCandidateCeiling}, an element
 * declaring both contributes their product, and an element declaring neither
 * contributes 1. Taking the larger of the two factors instead would under-declare
 * against what the row builder actually assembles and refuse honest rows at the
 * width seam.
 *
 * A fuzzy element's factor is taken at the width its own transforms bound its
 * value to ({@link elementValueWidthBound}), since every kind's candidate count
 * grows with that width; an element whose transforms bound no width takes the
 * global expansion limit. The bound is a function of the agreed terms, so both
 * parties derive the same factor.
 *
 * Read WITHOUT regard to the role this party resolves to: an expansion
 * {@link expandsOnReceiverOnly} classifies runs on one party alone, but the width
 * is fixed before the roles are, so both parties declare the receiver-case
 * ceiling and derive the identical number from terms they have both agreed.
 *
 * `swap` exchanges two of a key's element FIELDS while each element keeps its own
 * transforms and fuzzy declaration, so it permutes no factor in the product and
 * the sender and the receiver reach the same width.
 *
 * The fuzzy factor is gated on `APPLIED_SETTINGS.fuzzyComparisons`: declaring
 * width for candidates no row realizes would spend this party's share of the
 * single-pass ceiling on slots that stay empty.
 *
 * Throws a {@link UsageError} for a key whose declared width exceeds
 * {@link MAX_KEY_CANDIDATE_WIDTH} -- a width no row could assemble in full, so
 * every row of that key would be dropped or refused at the assembly cap.
 */
export function declaredKeyWidth(key: LinkageKey, keyIndex?: number): number {
  let width = 1;
  for (const element of key.elements) {
    if (declaredFanOutFunction(element.transform) !== undefined)
      width *= FAN_OUT_CANDIDATES_PER_ELEMENT;
    if (
      APPLIED_SETTINGS.fuzzyComparisons &&
      element.generateFuzzyComparisons !== undefined
    )
      width *= fuzzyCandidateCeiling(
        element.generateFuzzyComparisons,
        elementValueWidthBound(element.transform),
      );
    if (width > MAX_KEY_CANDIDATE_WIDTH)
      throw new UsageError(
        `${keySite(keyIndex)} declares a width of more than the ` +
          `${MAX_KEY_CANDIDATE_WIDTH} candidate values one record may ` +
          "contribute to one key: every element's candidates multiply across " +
          "the key, so expanding steps on several of its elements compound. " +
          "The exchange is refused instead. Declare the expansion on fewer of " +
          "the key's elements, or split the key into keys of fewer elements.",
      );
  }
  return width;
}

/**
 * A party's **effective key count**: the sum of {@link declaredKeyWidth} over the
 * agreed linkage keys. It equals the plain key count exactly when no key's
 * elements declare an expansion (docs/spec/PROTOCOL.md, The width bound).
 *
 * Derived from the agreed terms alone, so both parties compute it for BOTH sides
 * with no round-trip and no advertisement: multiplied by a party's declared record
 * count it gives that party's **value slots**, the authenticated upper bound on
 * its distinct-value count that replaces `keyCount * recordCount` in every derived
 * single-pass bound.
 *
 * A party's own local standardization is deliberately not read here. Cleaning that
 * fans out is per-party and invisible to the partner, so it rides the party's
 * DECLARED RECORD COUNT instead ({@link localFanOutFactor}), which keeps this
 * number a property of terms both parties hold.
 *
 * Throws a {@link UsageError} when the sum exceeds {@link MAX_EFFECTIVE_KEY_COUNT}.
 */
export function declaredEffectiveKeyCount(terms: LinkageTerms): number {
  let effectiveKeyCount = 0;
  for (const [keyIndex, key] of terms.linkageKeys.entries())
    effectiveKeyCount += declaredKeyWidth(key, keyIndex);
  if (effectiveKeyCount > MAX_EFFECTIVE_KEY_COUNT)
    throw new UsageError(
      `these linkage terms declare ${effectiveKeyCount} candidate value slots ` +
        `per record, above the ${MAX_EFFECTIVE_KEY_COUNT} an exchange derives ` +
        "its frame and element bounds from. The exchange is refused instead. " +
        "Declare fewer linkage keys, or declare the expanding steps on fewer " +
        "of their elements.",
    );
  return effectiveKeyCount;
}

/**
 * The factor a party's OWN standardization multiplies its declared record count
 * by: {@link FAN_OUT_CANDIDATES_PER_ELEMENT} when any of its linkage fields is
 * cleaned by a pipeline declaring a fan-out step, else 1.
 *
 * A local fan-out rides no agreed term -- the partner cannot see the
 * standardization, and a party that pre-fanned its file outside psilink would
 * present the same wire behavior -- so it is declared as the extra RECORDS it
 * stands for rather than as extra width. Role resolution therefore reads the
 * fanned count, which is the one consequence the specification states
 * (docs/spec/PROTOCOL.md, Role resolution and work minimization).
 *
 * `declaresLocalFanOut` is the party's own reading of the cleaning pipelines
 * behind the fields its linkage keys READ (`StandardizedDataset.declaresFanOut`),
 * not of the authored standardization, so a fan-out on a field no linkage key
 * reads changes nothing.
 */
export function localFanOutFactor(declaresLocalFanOut: boolean): number {
  return declaresLocalFanOut ? FAN_OUT_CANDIDATES_PER_ELEMENT : 1;
}
