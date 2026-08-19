/**
 * The declared fan-out producers: which standardization functions expand ONE
 * value into several match candidates, and the membership test the compiler
 * captures per step.
 *
 * Its own module because the list steers a runtime decision -- whether an
 * over-width or unassemblable row is dropped or refused -- so the membership test
 * needs a seam the unit tests can drive without the exported list itself being
 * writable (see {@link withNoListedFanOutFunctions}). `standardization.ts`
 * re-exports the list, which is where consumers read it from.
 */

/**
 * The standardization functions that expand ONE value into several match
 * candidates -- the multi-value `FieldValue` case. Matching on a candidate set is
 * not implemented, so an exchange whose transforms declare one of these is
 * refused rather than run with the narrower matching it would actually deliver;
 * see `assertFanOutImplemented`.
 *
 * Hand-listed, because whether a factory can return a multi-value `Set` is not
 * derivable from the registry. A fan-out function added to
 * `STANDARDIZING_FUNCTIONS` without an entry here is not left to narrow silently:
 * `buildKeyStrings` carries every candidate through to the record's candidate
 * set, and the strategy that consumes it refuses a record carrying more than one
 * (`fanOutReachedMatchingRefusal`). That refusal is the point of harm rather than
 * a pre-run gate: it fires as a round is built, which is after the terms
 * exchange, so it is the DECLARED step this list carries that is refused before
 * anything reaches the wire.
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
