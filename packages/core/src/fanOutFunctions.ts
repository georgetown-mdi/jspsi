/**
 * The declared fan-out producers: which standardization functions expand ONE
 * value into several match candidates, the membership test the compiler captures
 * per step, the normative per-(record, key) width bound, and the effective key
 * count the exchange's slot arithmetic is derived from.
 *
 * Its own module because the list steers a runtime decision -- whether an
 * over-width or unassemblable row is dropped or refused -- so the membership test
 * needs a seam the unit tests can drive without the exported list itself being
 * writable (see {@link withNoListedFanOutFunctions}). It carries the width bound
 * and the effective-key-count derivation beside the list so the connection and
 * protocol layers, which bound a partner-supplied frame from them, reach them
 * without importing the whole standardization pipeline. `standardization.ts`
 * re-exports both, which is where consumers read them from.
 */

import type { LinkageKey, LinkageTerms } from "./config/linkageTerms.js";
import type { Standardization } from "./config/standardization.js";

/**
 * The standardization functions that expand ONE value into several match
 * candidates -- the multi-value `FieldValue` case. An exchange whose transforms
 * declare one of these matches on every candidate under the single-pass strategy,
 * and is refused under every other rather than run with the narrower matching one
 * of those would actually deliver; see `assertFanOutImplemented`.
 *
 * It is also what {@link declaredEffectiveKeyCount} reads to decide a key's
 * candidate factor, so an entry here widens every derived single-pass bound for
 * a party whose keys the named function feeds.
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
 * The normative per-(record, key) fan-out width bound: one record contributes at
 * most this many candidate values to one linkage key's round
 * (docs/spec/PROTOCOL.md, The width bound). Not operator-configurable -- it is
 * what a partner-supplied frame's element and byte bounds are derived from, so
 * changing it re-derives those.
 *
 * A record realizing more candidates than this contributes NONE of them to that
 * key's round: `buildKeyStrings` drops it exactly as an absent (`NULL`)
 * realization is dropped, warns the operator, and leaves the record eligible for
 * later keys. Deliberately not a run refusal -- the transforms are
 * partner-authored while the values expanded are this party's own rows, so
 * failing the run would let a partner end an exchange by authoring a delimiter
 * that shatters one local value.
 *
 * It binds `split_on`, the fan-out producer, and it is also the count at which a
 * cross-product earns an operator advisory: a wide expansion weakens the
 * guarantee a dual-party-output exchange otherwise gives, because each candidate
 * can independently reveal co-possession. Past the bound that width is not the
 * operator's call to make per row, and the consequence of an authored fan-out
 * within the bound is surfaced where the operator consents to the terms. For the
 * other candidate producer, `generateFuzzyComparisons`, the number is the
 * advisory alone -- its own width factor is that feature's to set when its
 * matching lands.
 */
export const MAX_KEY_CANDIDATES_PER_ROW = 20;

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

// The linkage fields a party's own standardization fans out: the `output` of
// every transformation carrying a declared fan-out step. A key referencing one of
// those fields fans out even when its element transforms declare nothing, which
// is why the effective key count below is per-party rather than derivable from
// the agreed terms alone.
function fanOutStandardizedFields(
  standardization: Standardization | undefined,
): ReadonlySet<string> {
  const fields = new Set<string>();
  for (const transformation of standardization ?? [])
    if (declaredFanOutFunction(transformation.steps) !== undefined)
      fields.add(transformation.output);
  return fields;
}

function keyDeclaresFanOut(
  key: LinkageKey,
  fanOutFields: ReadonlySet<string>,
): boolean {
  // `swap` exchanges two of a key's element FIELDS while each element keeps its
  // own transforms, so it permutes neither set this verdict reads and the sender
  // and the receiver reach the same one.
  return key.elements.some(
    (element) =>
      declaredFanOutFunction(element.transform) !== undefined ||
      fanOutFields.has(element.field),
  );
}

/**
 * A party's declared **effective key count**: the sum, over the agreed linkage
 * keys, of its declared candidate factor for each -- {@link
 * MAX_KEY_CANDIDATES_PER_ROW} for a key some declared fan-out produces values
 * for, and 1 otherwise. It equals the plain key count exactly when the party
 * declares no fan-out (docs/spec/PROTOCOL.md, The width bound).
 *
 * Multiplied by the party's record count it gives that party's **value slots**,
 * the authenticated upper bound on its distinct-value count that replaces
 * `keyCount * recordCount` in every derived single-pass bound. It is a property
 * of this party's declared configuration, not an observation of its data, so both
 * a fan-out that never splits a row and one that splits every row advertise the
 * same number.
 *
 * Both authoring surfaces count: an element transform in the agreed `terms`
 * (which the partner can see, and which fixes the floor the partner's advertised
 * value is held to) and a step in this party's own local `standardization`
 * (which the partner cannot see, and which is why a party may advertise more than
 * that floor). Passing no `standardization` yields exactly that floor.
 *
 * `generateFuzzyComparisons` is a second per-record candidate producer and does
 * NOT raise the count: it expands nothing while `APPLIED_SETTINGS.fuzzyComparisons`
 * is false, and setting its own width factor here is that feature's work to do
 * before the flag flips. A fuzzy row that reached a round without one would
 * exceed the slots this count bounds, which the single-pass build refuses rather
 * than ships (see `link.ts`).
 */
export function declaredEffectiveKeyCount(
  terms: LinkageTerms,
  standardization?: Standardization,
): number {
  const fanOutFields = fanOutStandardizedFields(standardization);
  let effectiveKeyCount = 0;
  for (const key of terms.linkageKeys)
    effectiveKeyCount += keyDeclaresFanOut(key, fanOutFields)
      ? MAX_KEY_CANDIDATES_PER_ROW
      : 1;
  return effectiveKeyCount;
}
