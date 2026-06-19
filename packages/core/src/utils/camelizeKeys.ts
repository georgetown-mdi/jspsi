/**
 * Field names whose value is an opaque map passed verbatim to an external
 * library, and whose keys must therefore NOT be case-transformed. Currently
 * only `connection.provider_options` / `providerOptions`, which is spread
 * directly into the `ssh2-sftp-client` connect options -- a namespace defined by
 * that library, whose keys are camelCase (e.g. `readyTimeout`, `algorithms`) and
 * are not psilink's to normalize. Every other map in the exchange schema is
 * psilink's own vocabulary and follows the snake_case-in-YAML <-> camelCase-in-TS
 * convention (this includes the function-specific `params` blocks, which feed
 * psilink's own standardizing-function library and are read as camelCase keys).
 *
 * The set is keyed by canonical camelCase name and is the single source of truth
 * baked into the shared recurse-and-skip walker ({@link transformKeysDeep}), so
 * the read (`camelizeKeys`) and write (`snakeizeKeys`) directions skip exactly
 * the same subtrees and the write -> read round-trip stays byte-stable.
 *
 * This is a key-NAME match, not a path match: a key named `provider_options`
 * (snake) / `providerOptions` (camel) at any depth is treated as opaque. No
 * other schema field uses that name, and the contents of an opaque map are
 * themselves opaque, so a nested occurrence is correctly left verbatim too.
 *
 * Exported (not a stable public API) so the structural-invariant test can drive
 * its assertion from this same source of truth; consumers outside the workspace
 * should not depend on its contents.
 *
 * @internal
 */
export const OPAQUE_VALUE_KEYS: ReadonlySet<string> = new Set([
  "providerOptions",
]);

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/**
 * Shared recurse-and-skip walker behind both {@link camelizeKeys} (read) and
 * {@link snakeizeKeys} (write). It recurses through arrays and objects rewriting
 * every object key with `transformKey`, except that an opaque key's value
 * (`OPAQUE_VALUE_KEYS`) is left verbatim: the key itself is still rewritten, but
 * its subtree is not entered, so a user-authored key (snake or camel) survives
 * byte-for-byte in both directions. String values are never touched, only keys.
 *
 * Opacity is decided on the canonical camelCase form of the *input* key
 * (`snakeToCamel(k)`), independent of the output transform. snakeToCamel is a
 * no-op on a key that is already camelCase, so it canonicalizes a snake_case
 * read key and a camelCase write key alike. Because the skip predicate is this
 * one fixed expression rather than a per-direction check, the read and write
 * directions provably skip the identical set of subtrees -- the structural
 * guarantee (asserted directly by a unit test driven from OPAQUE_VALUE_KEYS)
 * that keeps the write -> read round-trip byte-stable, rather than two
 * independent recursions held in agreement by prose.
 */
function transformKeysDeep(
  value: unknown,
  transformKey: (key: string) => string,
): unknown {
  if (Array.isArray(value))
    return value.map((v) => transformKeysDeep(v, transformKey));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) =>
        OPAQUE_VALUE_KEYS.has(snakeToCamel(k))
          ? [transformKey(k), v]
          : [transformKey(k), transformKeysDeep(v, transformKey)],
      ),
    );
  return value;
}

/**
 * Recursively rewrites object keys from snake_case to camelCase: the read path
 * that normalizes user-facing YAML/JSON (conventionally snake_case) into the
 * camelCase TypeScript sees before Zod parsing. Opaque-value maps
 * (`OPAQUE_VALUE_KEYS`) are left verbatim -- see {@link transformKeysDeep}.
 */
export function camelizeKeys(value: unknown): unknown {
  return transformKeysDeep(value, snakeToCamel);
}

/**
 * Recursively rewrites object keys from camelCase to snake_case: the write path
 * and exact inverse of {@link camelizeKeys} for the keys the exchange schema
 * uses, so a write-then-read round-trips unchanged. Both directions are produced
 * from the one {@link transformKeysDeep} walker, so the opaque-value skip cannot
 * diverge between them. Only keys are rewritten; string values (e.g. the
 * `firstName` in a `name: firstName` label) are left verbatim, matching the read
 * path.
 *
 * It is not a general camelCase inverse -- an embedded acronym such as `URL`
 * would snakeize to `u_r_l` -- but no such key occurs in the schema. Used by the
 * CLI config writer (`saveConfig`) to serialize a typed `ExchangeSpec` to
 * snake_case YAML; not a stable public API for consumers outside the workspace.
 *
 * @internal
 */
export function snakeizeKeys(value: unknown): unknown {
  return transformKeysDeep(value, camelToSnake);
}
