import { UsageError } from "../errors.js";
import { exceedsOwnKeyCount } from "./objectKeyCount.js";

/**
 * Maximum object/array nesting depth {@link transformKeysDeep} will descend
 * through before rejecting the input. The walker recurses once per level with
 * native recursion, so an untrusted payload nested past the call-stack limit
 * (empirically a few thousand levels, and lower on a smaller stack) would
 * otherwise overflow with a `RangeError` BEFORE any schema validation runs --
 * `parseLinkageTerms` camelizes ahead of Zod, so a deeply-nested partner payload
 * (a few tens of KB of JSON, trivially within the invitation and frame caps)
 * reaches this walker first. 256 is far above any real config or exchange message
 * -- the deepest schema path is under a dozen levels, and a `transform.params`
 * value (the deepest partner-controlled spot, typed `z.unknown()`) holds shallow
 * scalars -- yet well below the overflow threshold on any stack, so the guard
 * fires as a clean bounded rejection long before native recursion would fault.
 * Rejecting here, at the single shared camelize/snakeize chokepoint and ahead of
 * Zod, also keeps a deep value from surviving validation (under `z.unknown()`)
 * only to overflow a later recursive consumer such as `canonicalString`.
 */
export const MAX_NESTING_DEPTH = 256;

/**
 * Thrown by {@link transformKeysDeep} (and so by {@link camelizeKeys} /
 * {@link snakeizeKeys}) when input nesting exceeds {@link MAX_NESTING_DEPTH}. A
 * {@link UsageError} subclass, like the transport input-bound errors and
 * `CanonicalEncodingError`: a payload too deep to walk is a bounded rejection of
 * untrusted input, terminal and (at the CLI) exit 64, not an internal fault. Its
 * message is fixed text carrying no input bytes, so the parse-error relay
 * (`describeDecodeError`) can surface it verbatim.
 */
export class NestingDepthExceededError extends UsageError {
  constructor() {
    super(`input nesting exceeds the maximum depth of ${MAX_NESTING_DEPTH}`);
    this.name = "NestingDepthExceededError";
  }
}

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
 *
 * `depth` bounds the native recursion against an untrusted deeply-nested payload:
 * the root value is at depth 0, so a value at depth {@link MAX_NESTING_DEPTH} or
 * deeper -- past the documented {@link MAX_NESTING_DEPTH} levels -- is rejected
 * with a clean {@link NestingDepthExceededError} before the recursion can
 * overflow the call stack with a `RangeError`; values shallower than that are
 * walked normally. The opaque-key skip does not recurse, so an opaque subtree's
 * own depth never counts toward the bound.
 *
 * `widthBoundedKeys` is an optional caller-supplied map from a (canonical
 * camelCase) key name to the maximum key count its object value may carry. When
 * a key matches and its object value exceeds that count -- decided by a key count
 * (see {@link exceedsOwnKeyCount}; O(n) in keys, but the cheapest such pass) --
 * the value is left verbatim instead of being recursed into and rewritten key by
 * key, exactly as an opaque subtree is. This is a defense against a
 * pathological-key-count partner record (the `transform.params` map, board item
 * 202722105) whose snake->camel rewrite would otherwise burn multiple seconds
 * before the schema's own count bound could reject it: leaving it verbatim hands
 * the over-count record to the matching schema (which rejects it with a single
 * clean issue) for the cost of one key count instead of the far more expensive
 * rewrite. A within-bound value is recursed into and rewritten as normal, so a
 * legitimate record is unaffected; like the opaque skip, only the value is left
 * verbatim, the key itself is still rewritten.
 *
 * Also like the opaque skip, this is a key-NAME match, not a path match: a
 * matching name at any depth is width-checked. A nested over-count value sharing
 * a bounded name (e.g. a key literally named `params` inside another `params`
 * value, which is `z.unknown()` content) is therefore left verbatim too -- inert,
 * because such a value is opaque content no consumer reads as camelCase, and a
 * legitimate config never nests an over-count map under that name. The effect is
 * version-deterministic (both parties on the same code skip identically), so it
 * cannot diverge a cross-party canonical encoding within a version.
 */
function transformKeysDeep(
  value: unknown,
  transformKey: (key: string) => string,
  depth: number,
  widthBoundedKeys?: ReadonlyMap<string, number>,
): unknown {
  if (depth >= MAX_NESTING_DEPTH) throw new NestingDepthExceededError();
  if (Array.isArray(value))
    return value.map((v) =>
      transformKeysDeep(v, transformKey, depth + 1, widthBoundedKeys),
    );
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => {
        const camel = snakeToCamel(k);
        if (OPAQUE_VALUE_KEYS.has(camel)) return [transformKey(k), v];
        const widthBound = widthBoundedKeys?.get(camel);
        if (
          widthBound !== undefined &&
          v !== null &&
          typeof v === "object" &&
          !Array.isArray(v) &&
          exceedsOwnKeyCount(v, widthBound)
        )
          return [transformKey(k), v];
        return [
          transformKey(k),
          transformKeysDeep(v, transformKey, depth + 1, widthBoundedKeys),
        ];
      }),
    );
  return value;
}

/**
 * Recursively rewrites object keys from snake_case to camelCase: the read path
 * that normalizes user-facing YAML/JSON (conventionally snake_case) into the
 * camelCase TypeScript sees before Zod parsing. Opaque-value maps
 * (`OPAQUE_VALUE_KEYS`) are left verbatim -- see {@link transformKeysDeep}.
 *
 * Runs ahead of the schema in the `parseX`/`safeParseX` config helpers, so on a
 * pathologically deep input it throws BEFORE the schema -- meaning even a
 * `safeParseX` wrapper that calls it can throw rather than return a failure
 * result. No real config or exchange message reaches the bound.
 *
 * `widthBoundedKeys` (see {@link transformKeysDeep}) lets a caller name keys
 * whose object value is left verbatim once it exceeds a given key count, so a
 * pathological-count partner record is not rewritten key by key before the
 * schema's own count bound rejects it. Callers that parse partner-controlled
 * input with a bounded record (`parseLinkageTerms`, for `transform.params`) pass
 * it; the rest omit it and the pre-pass is unchanged.
 *
 * @throws {NestingDepthExceededError} if input nesting reaches
 *   {@link MAX_NESTING_DEPTH} levels.
 */
export function camelizeKeys(
  value: unknown,
  widthBoundedKeys?: ReadonlyMap<string, number>,
): unknown {
  return transformKeysDeep(value, snakeToCamel, 0, widthBoundedKeys);
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
 * Its input is the operator's own typed `ExchangeSpec`, never this deep, so the
 * shared depth bound below is incidental here.
 *
 * @throws {NestingDepthExceededError} if input nesting reaches
 *   {@link MAX_NESTING_DEPTH} levels.
 * @internal
 */
export function snakeizeKeys(value: unknown): unknown {
  return transformKeysDeep(value, camelToSnake, 0);
}
