import canonicalize from "canonicalize";
import { z } from "zod";

import { UsageError } from "../errors.js";

// Canonical encoding for receipt and record artifacts (RFC 8785, JSON
// Canonicalization Scheme). The same logical object must serialize to a
// byte-identical string on both parties and in any independent third-party
// implementation, so that hashes and signatures over the bytes verify across
// implementations. The full normative specification -- written so an auditor
// can reproduce the bytes without reading this source -- lives in
// docs/CANONICAL_ENCODING.md. This module is the project's single
// canonicalization primitive; nothing hashed, committed, or signed may use ad
// hoc `JSON.stringify` or key-sorting instead.
//
// RFC 8785 is delegated to the `canonicalize` package (the scheme author's
// reference implementation): it sorts object keys by UTF-16 code unit, formats
// numbers and strings via ECMAScript `JSON.stringify` (which is exactly the
// RFC's number- and string-serialization rule), and emits non-ASCII characters
// as raw UTF-8 rather than `\u` escapes. What this module adds is a strict
// pre-validation pass that REJECTS, rather than silently coerces, every value
// outside the safe reproducible domain (see {@link assertCanonical}).

/**
 * The value domain {@link canonicalString} accepts: JSON primitives plus arrays
 * and plain objects, recursively. `undefined`, `bigint`, symbols, functions,
 * and non-plain objects (Date, Map, TypedArray, class instances, ...) are
 * outside the domain and are rejected at runtime -- binary data must be
 * base64url-encoded to a string by the caller before it enters a canonical
 * object. Documented as a type for reference; the encode functions accept
 * `unknown` and enforce the domain at runtime, which is the actual contract a
 * third-party reimplementation must match.
 */
export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

/**
 * Thrown when a value cannot be canonically encoded because it falls outside
 * the reproducible domain (see {@link assertCanonical}). The message names the
 * offending value's JSON path (e.g. `$.linkageKeys[0].elements[1]`) so the
 * caller can locate it. One exception: an error the boundary guard in
 * {@link canonicalString} converts -- a property getter that throws, or a
 * circular reference that overflows the traversal -- is pathed at the root `$`,
 * because the precise location is not recoverable there; the original error is
 * preserved on `.cause`, whose stack still locates it.
 *
 * It extends {@link UsageError}: a value outside the canonical domain is a
 * configuration/data problem, so any call site that lets it propagate to the
 * CLI is classified as exit 64 (EX_USAGE), not 69 (EX_UNAVAILABLE). This holds
 * even for future callers that, unlike `validateCompatibility`, do not wrap
 * `canonicalString` in their own try/catch.
 */
export class CanonicalEncodingError extends UsageError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "CanonicalEncodingError";
    // Preserve the underlying error (e.g. a throwing getter caught at the
    // canonicalString boundary) as the cause, matching the error-conversion
    // convention used elsewhere in the codebase. UsageError's constructor takes
    // only a message, so set cause directly rather than forwarding super options.
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

function fail(reason: string, path: string, cause?: unknown): never {
  throw new CanonicalEncodingError(
    `canonical encoding failed at ${path}: ${reason}`,
    // Only pass options when there is a cause, so the common origin rejections
    // (which have none) do not allocate an options object per call.
    cause === undefined ? undefined : { cause },
  );
}

function isPlainObject(value: object): boolean {
  // Reject Date, Map, Set, RegExp, TypedArray, and class instances: only object
  // literals (Object.prototype) and null-prototype maps (Object.create(null),
  // which canonicalize's Object.keys handles) are in the domain. A non-plain
  // object would otherwise be coerced by canonicalize via toJSON or its keys.
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/**
 * Reject a value that carries a callable `toJSON`. `canonicalize` tests
 * `object.toJSON instanceof Function` before it ever inspects `Array.isArray`
 * or enumerates keys (see canonicalize.js), so it would serialize the return of
 * `toJSON()` instead of the array or object actually passed -- a silent
 * coercion, and undetectable by an element/property walk (the method may be
 * non-enumerable, and on an array is never an indexed element). The
 * pre-validator must mirror that precedence and reject it. `typeof value.toJSON`
 * matches canonicalize's check, covering own and inherited, enumerable or not.
 */
function assertNoToJson(value: object, path: string): void {
  if (typeof (value as { toJSON?: unknown }).toJSON === "function")
    fail(
      "value defines a toJSON method, which would replace it during encoding; " +
        "convert it to plain data first",
      path,
    );
}

/**
 * Recursively assert that `value` is within the canonical domain, throwing a
 * {@link CanonicalEncodingError} otherwise. This runs before delegating to
 * `canonicalize` so that the cases `JSON.stringify`/`canonicalize` would
 * silently coerce -- `undefined` and symbol-valued properties dropped,
 * `undefined`/symbol array elements turned into `null`, `Date` rendered via
 * `toJSON` -- are rejected instead, and so that numbers that are not
 * portable across implementations are caught.
 *
 * Number rule: a number must be finite, and an integer-valued number must be a
 * safe integer (|n| <= 2^53 - 1). Integers beyond the safe range may not
 * round-trip identically from their source JSON across implementations, so they
 * must be string-encoded by the caller; finite non-integers are permitted and
 * formatted by the RFC 8785 (ECMAScript) number rule. Receipt/record numeric
 * fields that are hashed or signed are additionally constrained to safe
 * integers at the schema level via {@link safeIntegerSchema}.
 *
 * Absent vs null: an absent field is simply a key that is not present; `null`
 * is a distinct, permitted value. A property explicitly set to `undefined` is
 * rejected -- callers omit the key instead.
 */
function assertCanonical(value: unknown, path: string): void {
  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value))
        fail(`non-finite number (${String(value)})`, path);
      if (Number.isInteger(value) && !Number.isSafeInteger(value))
        fail(
          `integer ${String(value)} exceeds the safe range (|n| <= 2^53 - 1); ` +
            "string-encode it",
          path,
        );
      return;
    case "object": {
      if (value === null) return;
      if (Array.isArray(value)) {
        assertNoToJson(value, path);
        // canonicalize serializes only elements [0, length) (via Array.reduce),
        // so any own property it cannot reach -- a non-index string key
        // (`arr.foo`, enumerable or not) or a symbol key -- would be silently
        // dropped. Reject them so the array case is as complete as the object
        // case below. (`length` is the intrinsic own property, not an element.)
        for (const key of Object.getOwnPropertyNames(value)) {
          if (key === "length") continue;
          const index = Number(key);
          if (
            !Number.isInteger(index) ||
            index < 0 ||
            index >= value.length ||
            String(index) !== key
          )
            fail(`non-index array property (${JSON.stringify(key)})`, path);
        }
        if (Object.getOwnPropertySymbols(value).length > 0)
          fail("symbol-keyed array property", path);
        // Index loop, not forEach/for-of: both skip sparse holes (`[1,,3]`),
        // which canonicalize would silently drop. A hole is a missing element,
        // so reject it the same way an explicit `undefined` element is rejected.
        for (let index = 0; index < value.length; index++) {
          if (!(index in value))
            fail(
              "sparse array hole; use null for an explicit gap",
              `${path}[${index}]`,
            );
          assertCanonical(value[index], `${path}[${index}]`);
        }
        return;
      }
      if (!isPlainObject(value))
        fail(
          // `|| "unknown"`, not `?? "unknown"`: an anonymous constructor has
          // name === "" (falsy but not nullish), which `??` would not replace.
          `unsupported object type (${value.constructor?.name || "unknown"}); ` +
            "binary data must be base64url-encoded to a string first",
          path,
        );
      assertNoToJson(value, path);
      // Symbol-keyed properties are dropped by canonicalize (JSON.stringify
      // never emits them), so reject them rather than canonicalize a different
      // object than the caller passed. Object.entries below covers only string
      // keys, which is the canonical domain.
      const symbols = Object.getOwnPropertySymbols(value);
      if (symbols.length > 0)
        fail(
          `symbol-keyed property (${symbols[0].toString()}); ` +
            "canonical objects use string keys only",
          path,
        );
      // Object.entries includes a key explicitly set to `undefined`, so the
      // recursive call rejects it rather than letting canonicalize drop it.
      // Hazard: Object.entries reads each enumerable property value, which
      // invokes any getter -- a getter that throws escapes here as its own raw
      // error, not a CanonicalEncodingError. That is tolerated rather than
      // guarded per-property: the boundary try/catch in canonicalString converts
      // any such error so the module's single-error-type contract holds even for
      // non-schema-parsed input (the only kind that can carry a throwing getter).
      // Identifier-like keys extend the path with dot notation; any other key
      // (containing a dot, a digit-leading name, etc.) uses bracket notation so
      // the path stays unambiguous, e.g. `$["a.b"]` rather than `$.a.b`.
      for (const [key, child] of Object.entries(value)) {
        const childPath = /^[A-Za-z_$][\w$]*$/.test(key)
          ? `${path}.${key}`
          : `${path}[${JSON.stringify(key)}]`;
        assertCanonical(child, childPath);
      }
      return;
    }
    default:
      // undefined, bigint, symbol, function
      fail(`unsupported value of type ${typeof value}`, path);
  }
}

/**
 * Encode `value` to its canonical string form per RFC 8785 (JCS), restricted to
 * the reproducible value domain (see {@link CanonicalValue} and
 * {@link assertCanonical}). The same logical object yields a byte-identical
 * string regardless of input key order or platform.
 *
 * @throws {CanonicalEncodingError} if `value` contains anything outside the
 *   canonical domain.
 */
export function canonicalString(value: unknown): string {
  try {
    // assertCanonical MUST run first: the safety of the output rests entirely on
    // it catching every value canonicalize would coerce. canonicalize 2.1.0 does
    // not uniformly skip out-of-domain values -- e.g. a function-valued property
    // is stringified to the literal `undefined`, producing invalid JSON -- so the
    // pre-validator, not canonicalize, is what guarantees well-formed output.
    assertCanonical(value, "$");
    const encoded = canonicalize(value);
    // canonicalize returns undefined for any top-level value that JSON.stringify
    // drops entirely -- undefined, a function, or a symbol. assertCanonical has
    // already rejected all of those, so this only guards the declared return type.
    if (encoded === undefined) fail("value is not canonicalizable", "$");
    return encoded;
  } catch (err) {
    // Boundary guard upholding the module's contract that every rejection is a
    // CanonicalEncodingError. Both assertCanonical and canonicalize read property
    // values as they traverse, invoking any enumerable getter on the input (see
    // the Object.entries hazard note in assertCanonical). A getter that throws, a
    // circular reference that overflows the recursion, or any other unexpected
    // failure during traversal would otherwise escape as a raw error (a circular
    // input is itself un-encodable, so converting it to a usage error is correct,
    // not merely tolerated). The domain rejections fail() raises are CanonicalEncoding
    // errors already, each carrying its precise JSON path; re-throw those
    // unchanged so the path messages are preserved. Anything else is converted
    // here. The converted error is still a CanonicalEncodingError (a UsageError,
    // exit 64): a throwing getter on caller-supplied data is a data problem, not
    // an internal failure. This blanket catch also reclassifies a genuine bug in
    // assertCanonical/canonicalize as a CanonicalEncodingError; that is an
    // accepted trade for the single-error-type contract, not accidental.
    //
    // Unlike the domain rejections, a converted error is pathed at the root `$`,
    // not at the offending property (e.g. a getter at `$.outer.boom` still
    // reports `$`). Pinpointing the property would require a per-property
    // try/catch inside the traversal, reintroducing exactly the per-node overhead
    // this single boundary wrap was chosen to avoid; a getter-bearing input is
    // also exotic (only non-schema-parsed data can carry one). The original
    // error is preserved as `.cause`, so its stack still locates the property
    // even though the message says `$`. If a consumer ever feeds getter-bearing
    // objects in routinely, revisit and thread the precise path.
    if (err instanceof CanonicalEncodingError) throw err;
    fail(
      `unexpected error during traversal (${
        err instanceof Error ? err.message : String(err)
      })`,
      "$",
      err,
    );
  }
}

// Local TextEncoder so this module depends only on a platform API rather than
// on crypto.ts. UTF-8 with no BOM is the canonical byte encoding (see the spec).
const enc = new TextEncoder();

/**
 * Encode `value` to its canonical UTF-8 byte string per RFC 8785 (JCS). This is
 * the form that is hashed and signed for receipts; see {@link canonicalString}.
 *
 * @throws {CanonicalEncodingError} if `value` contains anything outside the
 *   canonical domain.
 */
export function canonicalBytes(value: unknown): Uint8Array<ArrayBuffer> {
  return enc.encode(canonicalString(value));
}

/**
 * Zod schema for a numeric field that is hashed, committed, or signed: a finite
 * safe integer (|n| <= 2^53 - 1). Receipt and record fields that carry counts
 * or sizes MUST validate with this (or be string-encoded) so the canonical
 * number format is unambiguous across implementations.
 *
 * `-0` is accepted (it is a safe integer) but canonical-encodes to `0` (see the
 * worked examples in docs/CANONICAL_ENCODING.md); do not rely on a sign on zero
 * surviving encoding. See also {@link canonicalString}.
 */
export const safeIntegerSchema: z.ZodType<number> = z
  .number()
  // Reject non-finite values first so Infinity/-Infinity report "must be a
  // finite number" rather than the misleading "safe integer" message. (NaN is
  // rejected by z.number() itself.) Number.isSafeInteger then implies integer.
  .refine((n) => Number.isFinite(n), { message: "must be a finite number" })
  .refine((n) => Number.isSafeInteger(n), {
    message: "must be a safe integer (|n| <= 2^53 - 1)",
  });
