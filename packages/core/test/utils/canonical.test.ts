import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import {
  canonicalBytes,
  canonicalString,
  CanonicalEncodingError,
  safeIntegerSchema,
} from "../../src/utils/canonical";

type Vector =
  | {
      name: string;
      description: string;
      value: unknown;
      canonical: string;
      bytesHex: string;
      sha256Hex: string;
      refuses?: undefined;
    }
  | {
      name: string;
      description: string;
      value: unknown;
      refuses: true;
    };

const { vectors } = JSON.parse(
  readFileSync(new URL("../vectors/canonical-vectors.json", import.meta.url), {
    encoding: "utf8",
  }),
) as { vectors: Vector[] };

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

// --- Checked-in test vectors -------------------------------------------------
// These are the cross-implementation contract: any independent
// implementation (in any language) must reproduce `canonical`, `bytesHex`,
// and `sha256Hex` from `value`, and must reject a `refuses` vector's `value`
// rather than emit bytes for it.

describe("canonical-vectors.json", () => {
  test("the vector file is non-empty", () => {
    expect(vectors.length).toBeGreaterThan(0);
  });

  test("the corpus holds both encoding and refusal vectors", () => {
    expect(vectors.filter((vector) => vector.refuses).length).toBeGreaterThan(
      0,
    );
    expect(vectors.filter((vector) => !vector.refuses).length).toBeGreaterThan(
      0,
    );
  });

  // The file's own shape rule, which no encoder run checks:
  // docs/spec/CANONICAL_ENCODING.md states that a `refuses` vector has none of
  // `canonical`, `bytesHex`, or `sha256Hex` and that every other vector has all
  // three. A byte string left behind on a vector that became a refusal would
  // otherwise sit in the file unread, stating bytes no implementation may emit.
  test("each vector states the encoded fields its refuses flag admits", () => {
    const encodedFields = ["canonical", "bytesHex", "sha256Hex"] as const;
    const statedPerVector = Object.fromEntries(
      vectors.map((vector) => [
        vector.name,
        encodedFields.filter((field) => field in vector),
      ]),
    );
    expect(statedPerVector).toEqual(
      Object.fromEntries(
        vectors.map((vector) => [
          vector.name,
          vector.refuses ? [] : [...encodedFields],
        ]),
      ),
    );
  });

  test.each(vectors)("$name: $description", (vector) => {
    if (vector.refuses) {
      expect(() => canonicalString(vector.value)).toThrow(
        CanonicalEncodingError,
      );
      expect(() => canonicalBytes(vector.value)).toThrow(
        CanonicalEncodingError,
      );
      return;
    }

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

// --- Ordering ----------------------------------------------------------------

describe("ordering", () => {
  test("array element order IS significant", () => {
    expect(canonicalString([1, 2, 3])).not.toBe(canonicalString([3, 2, 1]));
  });
});

// --- Number edge cases -------------------------------------------------------

describe("stable output across number edge cases", () => {
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
  test("control characters and reserved characters are escaped", () => {
    expect(canonicalString({ s: '\u0000\t\n"\\' })).toBe(
      '{"s":"\\u0000\\t\\n\\"\\\\"}',
    );
  });
});

// --- Lone surrogates ---------------------------------------------------------

describe("a lone surrogate is refused rather than escaped", () => {
  test.each([
    ["a lone high surrogate", { s: "\ud834" }],
    ["a lone low surrogate", { s: "\udd1e" }],
    ["a lone high surrogate inside a longer string", { s: "ab\ud834cd" }],
    ["a low surrogate before a high one", { s: "\udd1e\ud834" }],
    ["a lone surrogate in an array element", { a: [1, "\ud834"] }],
    ["a top-level lone surrogate string", "\ud834"],
  ])("%s is rejected", (_label, value) => {
    expect(() => canonicalString(value)).toThrow(CanonicalEncodingError);
    expect(() => canonicalBytes(value)).toThrow(CanonicalEncodingError);
  });

  test("the refusal names the value's path and the offending code unit", () => {
    expect(() => canonicalString({ a: 1, s: "ab\ud834" })).toThrow(
      /\$\.s: string holds an unpaired UTF-16 surrogate at code unit 2/,
    );
  });

  test("a lone surrogate in an object KEY is rejected too", () => {
    expect(() => canonicalString({ "\ud834": 1 })).toThrow(
      CanonicalEncodingError,
    );
    expect(() => canonicalString({ "\ud834": 1 })).toThrow(
      /object key holds an unpaired UTF-16 surrogate at code unit 0/,
    );
  });

  test("the refusal message stays well-formed UTF-16", () => {
    // The JSON path is the only partner-chosen text in the message and it is
    // built with JSON.stringify, so a refused key reaches a display or log
    // sink as its escape rather than as the code unit that has no UTF-8 form.
    let message = "";
    try {
      canonicalString({ "\ud834": 1 });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('$["\\ud834"]');
    expect(message).not.toMatch(/[\uD800-\uDFFF]/);
  });

  test("a well-formed surrogate pair still encodes to raw UTF-8 bytes", () => {
    // U+1D11E, the pair whose halves the cases above reject on their own.
    expect(canonicalString({ s: "𝄞" })).toBe('{"s":"𝄞"}');
    expect(toHex(canonicalBytes({ s: "𝄞" }))).toBe("7b2273223a22f09d849e227d");
  });
});

// --- Absent vs null ----------------------------------------------------------

describe("absent vs null fields", () => {
  test("an absent field differs from an explicit null field", () => {
    expect(canonicalString({ a: 1 })).not.toBe(
      canonicalString({ a: 1, b: null }),
    );
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

  test("an array with a toJSON method is rejected, not coerced", () => {
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
  test("a throwing enumerable getter shows as a CanonicalEncodingError, not the raw error", () => {
    // Only a non-schema-parsed object can have a throwing getter here: the
    // traversal in assertCanonical (and canonicalize) reads the getter,
    // which throws. The boundary try/catch in canonicalString converts the
    // raw error so callers still see the module's one error type.
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

  test("a circular reference shows as a CanonicalEncodingError, not a raw stack overflow", () => {
    // assertCanonical recurses into the cycle until the stack overflows;
    // the boundary guard converts that RangeError to a
    // CanonicalEncodingError. Only non-schema-parsed data can form a
    // cycle, so this shares the throwing-getter reachability.
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
