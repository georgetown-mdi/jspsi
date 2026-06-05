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
 * shared with the CLI config writer's inverse `snakeizeKeys`, so the read and
 * write paths skip exactly the same subtrees and the write -> read round-trip
 * stays byte-stable.
 *
 * This is a key-NAME match, not a path match: a key named `provider_options`
 * (snake) / `providerOptions` (camel) at any depth is treated as opaque. No
 * other schema field uses that name, and the contents of an opaque map are
 * themselves opaque, so a nested occurrence is correctly left verbatim too.
 */
export const OPAQUE_VALUE_KEYS: ReadonlySet<string> = new Set([
  "providerOptions",
]);

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

export function camelizeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelizeKeys);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => {
        const camelKey = snakeToCamel(k);
        // An opaque map's own key is still normalized, but its value is left
        // verbatim: do not recurse, so user-authored keys (snake or camel)
        // survive byte-for-byte. Symmetric with snakeizeKeys (CLI config writer).
        return OPAQUE_VALUE_KEYS.has(camelKey)
          ? [camelKey, v]
          : [camelKey, camelizeKeys(v)];
      }),
    );
  return value;
}
