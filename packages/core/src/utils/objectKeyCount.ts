/**
 * True if `obj` has MORE than `max` own enumerable keys.
 *
 * The loop stops the instant a (max + 1)th own key is seen, so it does the
 * minimum BODY work to answer the question -- but the honest cost is O(n) in the
 * object's key count, NOT a sub-linear "examine only max + 1 keys" probe: V8
 * builds the full own-key enumeration for `for...in` up front, before the body
 * runs, so the early return saves the per-key body work but not that
 * enumeration. A materialized object offers no sub-linear own-key count (every
 * own-key primitive -- `for...in`, `Object.keys`, `Reflect.ownKeys` -- enumerates
 * eagerly), and the input here is already a fully materialized `JSON.parse`
 * object by the time it reaches this check.
 *
 * Its value is being the CHEAPEST of the O(n) passes over a pathological-count
 * partner record (a `transform.params` map of millions of keys, board item
 * 202722105): the boolean it returns lets the parse reject the record while
 * SKIPPING the two far more expensive O(n) passes the record would otherwise
 * incur -- the snake->camel camelize rebuild and the permissive Zod record
 * stage's per-key schema validation -- so the multi-second burn is cut to roughly
 * one key enumeration, not eliminated. It is preferred over
 * `Object.keys(obj).length > max` because it allocates no result array and stops
 * the body early. The `hasOwnProperty` guard keeps the count to own keys even on
 * an object with enumerable inherited properties.
 */
export function exceedsOwnKeyCount(obj: object, max: number): boolean {
  let count = 0;
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      if (++count > max) return true;
    }
  }
  return false;
}
