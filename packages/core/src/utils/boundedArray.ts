import * as z from "zod";

/**
 * Wrap an array schema so a pathological ELEMENT COUNT is rejected with a single
 * bounded issue BEFORE per-element validation runs.
 *
 * A plain `z.array(element).max(maxEntries)` does NOT suffice on a partner-
 * controlled wire/config path: Zod v4 validates every element first (one issue
 * per invalid element) and applies the length check only after, so a partner
 * array of millions of invalid elements accumulates millions of issues before
 * `.max()` can fire -- which Zod then either spreads up through >=2 enclosing
 * array/record/tuple frames and overflows its call stack on (~130k elements,
 * `RangeError: Maximum call stack size exceeded`), or, for a flat array with no
 * such frame, throws `RangeError: Invalid string length` building the error
 * string from the issues (~3.5M elements). Both verified on Zod 4.4.3; the same
 * ordering subtlety the `transform.params` bound handles (board item 202609308).
 *
 * The permissive `z.array(z.unknown())` first stage accepts the array without
 * validating elements, the count refine rejects an over-count array with one
 * issue, and `.pipe` re-validates the now count-capped array against the real
 * `element` schema -- preserving every per-element check, and its issue path, for
 * an in-range array. `min`, when given, is the preserved lower-bound floor
 * applied on the validated stage.
 *
 * The count refine is `abort`: an over-count array stops this value's parse
 * rather than letting the still-RAW `unknown[]` flow onward. This matters when
 * the bounded array is the target of a sibling/cross-field refine (e.g. the
 * top-level `linkageKeys`, whose terms-level refines do `key.elements.map(...)`):
 * without `abort` the count failure is non-fatal, the raw array passes through,
 * and those refines then run on unvalidated elements and throw a TypeError on a
 * raw non-object. `abort` skips every downstream refine for this value, so an
 * over-count collection always fails as the clean count issue.
 *
 * Use this for partner-controlled collections whose legitimate count is small (a
 * count cap is appropriate). For collections legitimately in the millions (PSI
 * indices, payload rows), use {@link singleIssueArray} instead, which caps issue
 * accumulation at one without rejecting a large valid array.
 */
export function boundedArray<T>(
  element: z.ZodType<T>,
  maxEntries: number,
  message: string,
  min?: number,
): z.ZodType<T[]> {
  const validated =
    min === undefined ? z.array(element) : z.array(element).min(min);
  return z
    .array(z.unknown())
    .refine((value) => value.length <= maxEntries, { message, abort: true })
    .pipe(validated);
}
