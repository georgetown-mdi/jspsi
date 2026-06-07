import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import {
  canonicalBytes,
  canonicalString,
  CanonicalEncodingError,
  safeIntegerSchema,
} from "../src/utils/canonical";

interface Vector {
  name: string;
  description: string;
  value: unknown;
  canonical: string;
  bytesHex: string;
  sha256Hex: string;
}

const { vectors } = JSON.parse(
  readFileSync(new URL("./vectors/canonical-vectors.json", import.meta.url), {
    encoding: "utf8",
  }),
) as { vectors: Vector[] };

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

// --- Checked-in test vectors -------------------------------------------------
// These are the cross-implementation contract: any independent implementation
// (in any language) must reproduce `canonical`, `bytesHex`, and `sha256Hex`
// from `value`. Asserting them here verifies our implementation against that
// contract rather than against itself.

describe("canonical-vectors.json", () => {
  test("the vector file is non-empty", () => {
    expect(vectors.length).toBeGreaterThan(0);
  });

  test.each(vectors)("$name: $description", (vector) => {
    expect(canonicalString(vector.value)).toBe(vector.canonical);

    const bytes = canonicalBytes(vector.value);
    expect(toHex(bytes)).toBe(vector.bytesHex);

    // The canonical string is exactly the UTF-8 decoding of the byte string.
    expect(new TextDecoder().decode(bytes)).toBe(vector.canonical);

    // The byte string feeds a stable hash, so receipt hashes verify across
    // implementations.
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      vector.sha256Hex,
    );
  });
});

// --- Key ordering and platform independence ----------------------------------

describe("byte-identical output regardless of input key order", () => {
  test("top-level key order does not affect the bytes", () => {
    const a = { gamma: 1, alpha: 2, beta: 3 };
    const b = { beta: 3, gamma: 1, alpha: 2 };
    expect(canonicalString(a)).toBe(canonicalString(b));
    expect(toHex(canonicalBytes(a))).toBe(toHex(canonicalBytes(b)));
  });

  test("nested key order does not affect the bytes", () => {
    const a = { outer: { y: { d: 1, c: 2 }, x: [1, 2] }, name: "n" };
    const b = { name: "n", outer: { x: [1, 2], y: { c: 2, d: 1 } } };
    expect(canonicalString(a)).toBe(canonicalString(b));
    expect(canonicalString(a)).toBe(
      '{"name":"n","outer":{"x":[1,2],"y":{"c":2,"d":1}}}',
    );
  });

  test("array element order IS significant", () => {
    expect(canonicalString([1, 2, 3])).not.toBe(canonicalString([3, 2, 1]));
  });
});

// --- Number edge cases -------------------------------------------------------

describe("stable output across number edge cases", () => {
  test("the maximum safe integer round-trips without exponent notation", () => {
    expect(canonicalString({ n: Number.MAX_SAFE_INTEGER })).toBe(
      '{"n":9007199254740991}',
    );
  });

  test("negative zero normalizes to 0", () => {
    expect(canonicalString({ n: -0 })).toBe('{"n":0}');
    expect(canonicalString({ n: -0 })).toBe(canonicalString({ n: 0 }));
  });

  test("a negative safe integer is preserved", () => {
    expect(canonicalString({ n: -42 })).toBe('{"n":-42}');
  });
});

// --- Strings and unicode -----------------------------------------------------

describe("string and unicode escaping", () => {
  test("non-ASCII characters are emitted as raw UTF-8, not \\u escapes", () => {
    const s = canonicalString({ s: "café" });
    expect(s).toBe('{"s":"café"}');
    expect(s).not.toContain("\\u");
  });

  test("control characters and reserved characters are escaped", () => {
    expect(canonicalString({ s: '\u0000\t\n"\\' })).toBe(
      '{"s":"\\u0000\\t\\n\\"\\\\"}',
    );
  });
});

// --- Absent vs null ----------------------------------------------------------

describe("absent vs null fields", () => {
  test("an absent field differs from an explicit null field", () => {
    expect(canonicalString({ a: 1 })).not.toBe(
      canonicalString({ a: 1, b: null }),
    );
  });

  test("an explicit null is preserved", () => {
    expect(canonicalString({ a: null })).toBe('{"a":null}');
  });
});

// --- Rejected values ---------------------------------------------------------

describe("values outside the canonical domain are rejected", () => {
  test("an explicit undefined property is rejected, naming its path", () => {
    expect(() => canonicalString({ a: 1, b: undefined })).toThrow(
      CanonicalEncodingError,
    );
    expect(() => canonicalString({ a: 1, b: undefined })).toThrow(/\$\.b/);
  });

  test("a key containing a dot gets an unambiguous bracketed path", () => {
    // `$["a.b"]`, not `$.a.b`, so it cannot be confused with nested keys.
    expect(() => canonicalString({ "a.b": undefined })).toThrow(/\["a\.b"\]/);
  });

  test("a nested undefined is rejected", () => {
    expect(() => canonicalString({ outer: { inner: undefined } })).toThrow(
      CanonicalEncodingError,
    );
  });

  test("a top-level undefined is rejected", () => {
    expect(() => canonicalString(undefined)).toThrow(CanonicalEncodingError);
  });

  test.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ])("a non-finite number (%s) is rejected", (_label, n) => {
    expect(() => canonicalString({ n })).toThrow(CanonicalEncodingError);
  });

  test("an integer beyond the safe range is rejected", () => {
    // 2^53 is the first integer that is not a safe integer.
    expect(() => canonicalString({ n: 2 ** 53 })).toThrow(/safe range/);
  });

  test("a bigint is rejected", () => {
    expect(() => canonicalString({ n: 10n })).toThrow(CanonicalEncodingError);
  });

  test("a symbol value is rejected", () => {
    expect(() => canonicalString({ s: Symbol("x") })).toThrow(
      CanonicalEncodingError,
    );
  });

  test.each([
    ["top-level", () => 1],
    ["an array element", { a: [1, () => 1, 3] }],
    ["an object property", { f: () => 1 }],
  ])(
    "a function (%s) is rejected; canonicalize would emit invalid JSON for it",
    (_label, value) => {
      expect(() => canonicalString(value)).toThrow(CanonicalEncodingError);
    },
  );

  test.each([
    ["a Date", { d: new Date(0) }],
    ["a Map", { m: new Map() }],
    ["a Set", { s: new Set() }],
    ["a Uint8Array", { bytes: new Uint8Array([1, 2, 3]) }],
  ])("a non-plain object (%s) is rejected", (_label, value) => {
    expect(() => canonicalString(value)).toThrow(CanonicalEncodingError);
  });

  test("an undefined array element is rejected, not coerced to null", () => {
    expect(() => canonicalString({ a: [1, undefined, 3] })).toThrow(
      CanonicalEncodingError,
    );
  });

  test("a sparse array hole is rejected, not silently dropped", () => {
    // `delete` leaves a genuine hole at index 1 (length stays 3) without a
    // sparse-array literal in the source.
    const sparse = [1, 2, 3];
    delete sparse[1];
    expect(() => canonicalString({ a: sparse })).toThrow(
      CanonicalEncodingError,
    );
    expect(() => canonicalString({ a: sparse })).toThrow(/sparse array hole/);
  });

  test("a symbol-keyed property is rejected, not silently dropped", () => {
    expect(() => canonicalString({ a: 1, [Symbol("s")]: 2 })).toThrow(
      CanonicalEncodingError,
    );
    expect(() => canonicalString({ [Symbol("s")]: 2 })).toThrow(
      /symbol-keyed property/,
    );
  });

  test("an array carrying a toJSON method is rejected, not coerced", () => {
    // canonicalize would serialize toJSON()'s return instead of the elements.
    const arr: unknown[] = [1, 2, 3];
    (arr as { toJSON?: unknown }).toJSON = () => "hijacked";
    expect(() => canonicalString({ a: arr })).toThrow(CanonicalEncodingError);
    expect(() => canonicalString({ a: arr })).toThrow(/toJSON/);
  });

  test("a plain object with a non-enumerable toJSON is rejected", () => {
    // Object.entries and the symbol scan both miss a non-enumerable toJSON, but
    // canonicalize would still invoke it; the toJSON guard catches it.
    const obj = { a: 1 };
    Object.defineProperty(obj, "toJSON", {
      value: () => ({ replaced: true }),
      enumerable: false,
    });
    expect(() => canonicalString(obj)).toThrow(CanonicalEncodingError);
    expect(() => canonicalString(obj)).toThrow(/toJSON/);
  });

  test("an array with a non-index property is rejected, not dropped", () => {
    // canonicalize's index-only reduce would silently drop arr.foo.
    const arr: unknown[] = [1, 2, 3];
    (arr as unknown as Record<string, unknown>).foo = "bar";
    expect(() => canonicalString({ a: arr })).toThrow(CanonicalEncodingError);
    expect(() => canonicalString({ a: arr })).toThrow(
      /non-index array property/,
    );
  });

  test("an array with a non-enumerable extra property is rejected", () => {
    const arr: unknown[] = [1, 2, 3];
    Object.defineProperty(arr, "foo", { value: "bar", enumerable: false });
    expect(() => canonicalString({ a: arr })).toThrow(
      /non-index array property/,
    );
  });

  test("an array with a symbol-keyed property is rejected", () => {
    const arr: unknown[] = [1, 2, 3];
    (arr as unknown as { [k: symbol]: unknown })[Symbol("s")] = 1;
    expect(() => canonicalString({ a: arr })).toThrow(
      /symbol-keyed array property/,
    );
  });
});

// --- boundary guard: every rejection is a CanonicalEncodingError --------------

describe("the boundary guard keeps the single-error-type contract", () => {
  test("a throwing enumerable getter surfaces as a CanonicalEncodingError, not the raw error", () => {
    // Only a non-schema-parsed object can carry this; the traversal in
    // assertCanonical (and canonicalize) reads the getter, which throws. The
    // boundary try/catch in canonicalString converts the raw error so callers
    // still see the module's one error type.
    const value = {
      get boom(): never {
        throw new RangeError("getter blew up");
      },
    };
    expect(() => canonicalString(value)).toThrow(CanonicalEncodingError);
    expect(() => canonicalString(value)).toThrow(
      /unexpected error during traversal/,
    );
  });

  test("the converted error preserves the original as its cause", () => {
    // The boundary message is pathed at the root `$`, so the original error --
    // attached as `.cause` -- is what still locates the offending property (via
    // its stack). Guard that the link is not dropped.
    const original = new RangeError("getter blew up");
    const value = {
      get boom(): never {
        throw original;
      },
    };
    let caught: unknown;
    try {
      canonicalString(value);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CanonicalEncodingError);
    expect((caught as CanonicalEncodingError).cause).toBe(original);
  });

  test("a throwing getter nested below the root is still converted", () => {
    const value = {
      outer: {
        get boom(): never {
          throw new RangeError("deep getter blew up");
        },
      },
    };
    expect(() => canonicalString(value)).toThrow(CanonicalEncodingError);
  });

  test("a circular reference surfaces as a CanonicalEncodingError, not a raw stack overflow", () => {
    // assertCanonical recurses into the cycle until the stack overflows; the
    // boundary guard converts that RangeError. A cyclic object is itself
    // un-encodable, so a CanonicalEncodingError (a usage error) is the correct
    // type rather than a raw RangeError escaping. Only non-schema-parsed data can
    // form a cycle, so this shares the throwing-getter reachability.
    const value: Record<string, unknown> = {};
    value.self = value;
    expect(() => canonicalString(value)).toThrow(CanonicalEncodingError);
  });

  test("an ordinary domain rejection keeps its precise JSON-path message", () => {
    // The guard re-throws a CanonicalEncodingError unchanged: it must not flatten
    // the path messages fail() produces into the generic traversal message.
    expect(() => canonicalString({ when: new Date(0) })).toThrow(
      CanonicalEncodingError,
    );
    expect(() => canonicalString({ when: new Date(0) })).toThrow(/\$\.when/);
    expect(() => canonicalString({ when: new Date(0) })).not.toThrow(
      /unexpected error during traversal/,
    );
    expect(() => canonicalString({ items: [1, 10n] })).toThrow(
      /\$\.items\[1\]/,
    );
  });
});

// --- safeIntegerSchema -------------------------------------------------------

describe("safeIntegerSchema", () => {
  test.each([0, -0, 1, -1, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER])(
    "accepts the safe integer %d",
    (n) => {
      expect(safeIntegerSchema.safeParse(n).success).toBe(true);
    },
  );

  test.each([
    ["a fraction", 1.5],
    ["2^53", 2 ** 53],
    ["-(2^53)", -(2 ** 53)],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ])("rejects %s", (_label, n) => {
    expect(safeIntegerSchema.safeParse(n).success).toBe(false);
  });
});
