import * as z from "zod";

/**
 * An array schema whose elements are validated in a SINGLE pass that emits at
 * most ONE issue, rather than Zod's default one-issue-per-invalid-element.
 *
 * Why this exists, not a plain `z.array(element)` or a count `.max()`: a
 * partner-controlled post-handshake wire message can carry an array of hundreds
 * of thousands of INVALID elements. Under `z.array(element)` Zod accumulates one
 * issue per element and then overflows its own call stack spreading that issue
 * array up through the surrounding array/tuple frames -- a `RangeError`,
 * reproduced at ~130k elements on Zod 4.4.3 (the same mechanism the
 * `transform.params` bound forestalls in config/linkageTerms.ts, board item
 * 202609308). A count `.max()` cannot fix it here and is not even reached in
 * time: Zod v4 validates every element BEFORE the array length check, so the
 * overflow happens first; and these collections (PSI association-table indices,
 * payload rows) are legitimately in the millions -- a single frame holds on the
 * order of 6 million elements (docs/spec/CHANNEL_SECURITY.md) -- so any count
 * bound low enough to forestall the overflow would reject a real exchange.
 *
 * Validating the element TYPE in one `every` pass caps issue accumulation at one
 * regardless of count: an arbitrarily large VALID message still parses, while a
 * hostile one fails as a clean, bounded rejection -- surfaced as a
 * `ConnectionError("protocol")` by `receiveParsed` -- instead of an uncaught
 * `RangeError`. The receive path already caught the `RangeError` harmlessly; this
 * turns that ungraceful internal exception into a clean validation failure.
 *
 * `isElement` must mirror exactly the element schema it replaces, so the set of
 * accepted messages is unchanged. The `T` type parameter is the element type and
 * is not inferred from `isElement` -- pass it explicitly.
 */
export function singleIssueArray<T>(
  isElement: (value: unknown) => boolean,
  message: string,
): z.ZodType<T[]> {
  return z.custom<T[]>(
    (value) => Array.isArray(value) && value.every(isElement),
    { message },
  );
}
