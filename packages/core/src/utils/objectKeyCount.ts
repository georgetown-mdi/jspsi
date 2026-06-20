/**
 * True if `obj` has MORE than `max` own enumerable keys, decided with an early
 * exit after at most `max + 1` keys -- O(min(n, max + 1)), never a full O(n)
 * traversal of every key.
 *
 * The early exit is the point: it lets a pathological-count partner record (a
 * `transform.params` map of millions of keys, board item 202722105) be rejected
 * cheaply, ahead of the snake->camel camelize pre-pass and the permissive Zod
 * record stage that would each otherwise walk every key first. `Object.keys(obj)
 * .length` cannot serve here -- it materializes the whole key array up front, the
 * very O(n) work this avoids. The `hasOwnProperty` guard keeps the count to own
 * keys even on an object with enumerable inherited properties.
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
