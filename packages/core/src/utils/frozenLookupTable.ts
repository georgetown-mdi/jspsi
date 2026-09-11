/**
 * Registry tables a name from a decoded document indexes.
 *
 * A transform step's `function` and its param names arrive in a linkage-terms
 * document a counterparty authors, so every table keyed by one of them is read
 * with a name this build may not know. A table built here has no prototype, so
 * a name that resolves only on `Object.prototype` -- `constructor`,
 * `toString`, `__proto__`, `hasOwnProperty` -- resolves to nothing, and it is
 * frozen, so no later assignment replaces a row that decides how a step
 * compiles or whether a pattern is screened.
 */

/**
 * `entries` as a table carrying no prototype and no writable rows. The
 * returned type has no string index signature, so indexing it by an arbitrary
 * name does not compile; {@link frozenLookupTableEntry} is the read path for
 * a name that is not a literal.
 */
export function frozenLookupTable<T extends object>(entries: T): Readonly<T> {
  const table = Object.assign(Object.create(null) as T, entries);
  return Object.freeze(table);
}

/**
 * The row `key` names, or `undefined` where the table holds no such row. `key`
 * is arbitrary text, so the read is an own-property one whatever the table was
 * built from.
 */
export function frozenLookupTableEntry<V>(
  table: Readonly<Record<string, V>>,
  key: string,
): V | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}
