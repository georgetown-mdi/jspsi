import { UsageError } from "../errors.js";
import { exceedsOwnKeyCount } from "./objectKeyCount.js";

/**
 * Maximum object/array nesting depth {@link transformKeysDeep} will descend
 * before rejecting the input. The walker recurses once per level with native
 * recursion, so an untrusted payload nested past the call-stack limit
 * (empirically a few thousand levels) would otherwise overflow with a
 * `RangeError` before schema validation runs (`parseLinkageTerms` camelizes
 * ahead of Zod). 256 is far above any real config or exchange message (the
 * deepest schema path is under a dozen levels) yet well below the overflow
 * threshold, so the guard fires as a clean bounded rejection first --
 * protecting a later recursive consumer such as `canonicalString` too.
 */
export const MAX_NESTING_DEPTH = 256;

/**
 * Maximum total node count {@link transformKeysDeep} will rewrite before
 * rejecting the input -- the WIDTH analogue of {@link MAX_NESTING_DEPTH}. A
 * "node" is one object member or array element, counted as a single running
 * total across the whole walk, not per container.
 *
 * `camelizeKeys` runs ahead of Zod on partner input, so without this bound a
 * peer can drive a multi-second CPU burn before validation rejects the
 * payload -- or, worse, have it silently accepted: a huge object nested
 * under an unknown key is fully camelized and then silently stripped by the
 * non-strict schema, and a count-gated array is walked in full by the
 * pre-pass before its own count bound can reject it. A running total catches
 * both the wide-object case and width spread across many small arrays.
 *
 * 262144 (2^18) sits far above any realistic `ExchangeSpec` (low tens of
 * thousands of nodes) and far below the burn threshold (~1M nodes,
 * measured). Defense-in-depth, not a semantic limit: the per-collection caps
 * compose to a schema-valid maximum above this budget, so a
 * pathological-but-valid config could still trip it and fail the same clean
 * rejection. Sits above the decode layer's per-object key ceiling
 * (`MAX_JSON_OBJECT_KEYS` = 65536, boundedJson.ts), which bounds each
 * container's width before `JSON.parse`; this bounds the walker's total. See
 * docs/spec/CHANNEL_SECURITY.md.
 */
export const MAX_NODE_COUNT = 262144;

/**
 * Thrown by {@link transformKeysDeep} (and so by {@link camelizeKeys} /
 * {@link snakeizeKeys}) when input nesting exceeds {@link MAX_NESTING_DEPTH}.
 * A {@link UsageError} subclass, like the transport input-bound errors and
 * `CanonicalEncodingError`: a payload too deep to walk is a bounded
 * rejection, terminal and exit 64 at the CLI, not an internal fault. Its
 * message is fixed text holding no input bytes, so the parse-error relay
 * (`describeDecodeError`) can show it verbatim.
 */
export class NestingDepthExceededError extends UsageError {
  constructor() {
    super(`input nesting exceeds the maximum depth of ${MAX_NESTING_DEPTH}`);
    this.name = "NestingDepthExceededError";
  }
}

/**
 * Thrown by {@link transformKeysDeep} (and so by {@link camelizeKeys} /
 * {@link snakeizeKeys}) when the input's total node count exceeds
 * {@link MAX_NODE_COUNT}. The width counterpart of
 * {@link NestingDepthExceededError}: same {@link UsageError} contract
 * (terminal, exit 64 at the CLI, fixed message holding no input bytes so
 * `describeDecodeError` shows it verbatim), for a payload too WIDE to
 * rewrite rather than too deep.
 */
export class NodeCountExceededError extends UsageError {
  constructor() {
    super(`input node count exceeds the maximum of ${MAX_NODE_COUNT}`);
    this.name = "NodeCountExceededError";
  }
}

/**
 * Field names whose value is an opaque map passed verbatim to an external
 * library, whose keys must therefore NOT be case-transformed. Currently only
 * `connection.provider_options` / `providerOptions`, spread directly into
 * the `ssh2-sftp-client` connect options -- a namespace defined by that
 * library (camelCase keys like `readyTimeout`, `algorithms`), not psilink's
 * to normalize. Every other map in the exchange schema, including the
 * function-specific `params` blocks, is psilink's own vocabulary and
 * follows the snake_case-in-YAML <-> camelCase-in-TS convention.
 *
 * Keyed by canonical camelCase name and baked into the shared
 * recurse-and-skip walker ({@link transformKeysDeep}), so the read
 * (`camelizeKeys`) and write (`snakeizeKeys`) directions skip exactly the
 * same subtrees and the write -> read round-trip stays byte-stable.
 *
 * A key-NAME match, not a path match: `provider_options` / `providerOptions`
 * at any depth is opaque, since no other schema field uses that name and a
 * nested opaque map's own contents are opaque too.
 *
 * Exported (not a stable public API) so the structural-invariant test can
 * drive its assertion from this same source of truth.
 *
 * @internal
 */
export const OPAQUE_VALUE_KEYS: ReadonlySet<string> = new Set([
  "providerOptions",
]);

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Rewrite ONE camelCase key to the snake_case spelling the user-facing
 * document writes: the scalar half of {@link snakeizeKeys}, and the exact
 * inverse of the read direction for the keys the exchange schema uses.
 *
 * Exported for the schema-error render call sites: validation runs on the
 * camelized shape ({@link camelizeKeys} before Zod), so a Zod issue locates
 * its field by the camelCase name while the operator reads a document that
 * writes the key in snake_case. A call site naming a key to a human passes
 * each path segment through this, so it names the key as the file -- and
 * psilink's own writer, {@link snakeizeKeys} -- would spell it.
 *
 * It has {@link snakeizeKeys}'s limit: not a general camelCase inverse, so a
 * key with an embedded acronym (`URL`) renders `u_r_l`. Every schema-defined
 * key is lowercase words, so the inverse is exact for them; a free-form
 * record's key (a transform's `params`) is the operator's own and can fall
 * outside that convention. Not a stable public API, exactly as
 * {@link snakeizeKeys} is not.
 *
 * @internal
 */
export function snakeizeKey(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/**
 * Shared recurse-and-skip walker behind both {@link camelizeKeys} (read) and
 * {@link snakeizeKeys} (write). Recurses through arrays and objects
 * rewriting every object key with `transformKey`, except that an opaque
 * key's value (`OPAQUE_VALUE_KEYS`) is left verbatim: the key itself is
 * rewritten, but its subtree is not entered, so a user-authored key survives
 * byte-for-byte in both directions. String values are never touched, only
 * keys.
 *
 * Opacity is decided on the canonical camelCase form of the INPUT key
 * (`snakeToCamel(k)`), independent of the output transform, so a snake_case
 * read key and a camelCase write key canonicalize alike. Because the skip
 * predicate is this one fixed expression rather than a per-direction check,
 * the read and write directions provably skip the identical set of
 * subtrees -- asserted directly by a unit test driven from
 * OPAQUE_VALUE_KEYS -- rather than two independent recursions held in
 * agreement by prose.
 *
 * `depth` bounds the native recursion against an untrusted deeply-nested
 * payload: the root is depth 0, and a value at {@link MAX_NESTING_DEPTH} or
 * deeper is rejected with {@link NestingDepthExceededError} before the
 * recursion can overflow the call stack. An opaque subtree's own depth
 * never counts toward the bound, since it is not recursed into.
 *
 * `budget` is a single mutable node counter threaded across the whole walk
 * (one per top-level call), bounding the total rewrite width against an
 * untrusted wide payload -- the width counterpart of `depth`. Each array
 * element and object member counts one node; crossing
 * {@link MAX_NODE_COUNT} throws {@link NodeCountExceededError} before the
 * rewrite burns. An over-wide array is refused by its O(1) length before
 * `.map`, and an over-wide object by a streaming own-key count before
 * `Object.entries` materializes it. A skipped subtree (opaque, or
 * width-bounded below) is not recursed into and so never counts toward
 * this budget.
 *
 * `widthBoundedKeys` is an optional caller-supplied map from a (canonical
 * camelCase) key name to the maximum key count its object value may hold.
 * When a key matches and its value exceeds that count (see
 * {@link exceedsOwnKeyCount}), the value is left verbatim instead of being
 * recursed into, exactly as an opaque subtree is -- a defense against a
 * pathological-key-count partner record (`transform.params`) whose rewrite
 * would otherwise burn multiple seconds before the schema's own count
 * bound could reject it. A within-bound value is recursed and rewritten as
 * normal.
 *
 * Also like the opaque skip, this is a key-NAME match, not a path match: a
 * matching name at any depth is width-checked, so a nested over-count
 * value under a bounded name is left verbatim too -- inert, since such a
 * value is opaque content no consumer treats as camelCase. The effect is
 * version-deterministic, so it cannot diverge a cross-party canonical
 * encoding within a version.
 */
function transformKeysDeep(
  value: unknown,
  transformKey: (key: string) => string,
  depth: number,
  budget: { nodes: number },
  widthBoundedKeys?: ReadonlyMap<string, number>,
): unknown {
  if (depth >= MAX_NESTING_DEPTH) throw new NestingDepthExceededError();
  if (Array.isArray(value)) {
    // Length is O(1), so reject an over-budget array before `.map` allocates
    // and recurses (path b); a within-budget array commits its element count up
    // front and recurses as before.
    if (budget.nodes + value.length > MAX_NODE_COUNT)
      throw new NodeCountExceededError();
    budget.nodes += value.length;
    return value.map((v) =>
      transformKeysDeep(v, transformKey, depth + 1, budget, widthBoundedKeys),
    );
  }
  if (value !== null && typeof value === "object") {
    // Reject a single over-wide object before `Object.entries` MATERIALIZES
    // it (path a) -- a cheap streaming own-key count (the same early-exit
    // pass the params skip uses) against the budget still left, so a
    // multi-million-key object under an unknown key is refused rather than
    // rewritten then stripped.
    if (exceedsOwnKeyCount(value, MAX_NODE_COUNT - budget.nodes))
      throw new NodeCountExceededError();
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => {
        // The per-key check also catches the budget being exhausted by a
        // DESCENDANT of an earlier key in this same object, which the pre-pass
        // count above (this object's own width only) does not see.
        if (++budget.nodes > MAX_NODE_COUNT) throw new NodeCountExceededError();
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
          transformKeysDeep(
            v,
            transformKey,
            depth + 1,
            budget,
            widthBoundedKeys,
          ),
        ];
      }),
    );
  }
  return value;
}

/**
 * Recursively rewrites object keys from snake_case to camelCase: the read
 * path that normalizes user-facing YAML/JSON into the camelCase TypeScript
 * sees before Zod parsing. Opaque-value maps (`OPAQUE_VALUE_KEYS`) are left
 * verbatim -- see {@link transformKeysDeep}.
 *
 * Runs ahead of the schema in the `parseX`/`safeParseX` config helpers, so
 * on a pathologically deep or wide input it throws before the schema. The
 * throwing `parseX` helpers propagate that throw; the `safeParseX` helpers
 * route through `safeParseCamelized`, which converts it into a
 * `{ success: false }` result. No real config or exchange message reaches
 * either bound.
 *
 * `widthBoundedKeys` (see {@link transformKeysDeep}) lets a caller name keys
 * whose object value is left verbatim once it exceeds a given key count, so
 * a pathological-count partner record is not rewritten key by key before
 * the schema's own count bound rejects it. Callers parsing
 * partner-controlled input with a bounded record (`parseLinkageTerms`, for
 * `transform.params`) pass it; the rest omit it.
 *
 * @throws {NestingDepthExceededError} if input nesting reaches
 *   {@link MAX_NESTING_DEPTH} levels.
 * @throws {NodeCountExceededError} if the input's total node count exceeds
 *   {@link MAX_NODE_COUNT}.
 */
export function camelizeKeys(
  value: unknown,
  widthBoundedKeys?: ReadonlyMap<string, number>,
): unknown {
  return transformKeysDeep(
    value,
    snakeToCamel,
    0,
    { nodes: 0 },
    widthBoundedKeys,
  );
}

/**
 * Recursively rewrites object keys from camelCase to snake_case: the write
 * path and exact inverse of {@link camelizeKeys} for the keys the exchange
 * schema uses, so a write-then-read round-trips unchanged. Both directions
 * are produced from the one {@link transformKeysDeep} walker, so the
 * opaque-value skip cannot diverge between them. Only keys are rewritten;
 * string values are left verbatim, matching the read path.
 *
 * Not a general camelCase inverse -- an embedded acronym such as `URL` would
 * snakeize to `u_r_l` -- but no such key occurs in the schema. Used by the
 * CLI config writer (`saveConfig`) to serialize a typed `ExchangeSpec` to
 * snake_case YAML; not a stable public API. Its input is the operator's own
 * typed `ExchangeSpec`, never this deep, so the shared depth bound below is
 * incidental here.
 *
 * @throws {NestingDepthExceededError} if input nesting reaches
 *   {@link MAX_NESTING_DEPTH} levels.
 * @throws {NodeCountExceededError} if the input's total node count exceeds
 *   {@link MAX_NODE_COUNT}.
 * @internal
 */
export function snakeizeKeys(value: unknown): unknown {
  return transformKeysDeep(value, snakeizeKey, 0, { nodes: 0 });
}
