import { describe, expect, test } from "vitest";

import {
  compileLinearRegex,
  coerceToPatternString,
  patternConformsToDialect,
} from "../src/utils/linearRegex";

// --- Engine operations -------------------------------------------------------
// Each operation must be byte-identical to the JavaScript `RegExp` operation it
// replaced for in-dialect patterns; the broad equivalence corpus lives in
// transformRegexVectors.test.ts. These pin the wrapper's own contract.

describe("compileLinearRegex operations", () => {
  test("replaceAll replaces every match, with $n group references", () => {
    expect(compileLinearRegex("[^0-9]").replaceAll("(1) 2-3", "")).toBe("123");
    expect(
      compileLinearRegex("^1(\\d{10})$").replaceAll("15551234567", "$1"),
    ).toBe("5551234567");
    expect(compileLinearRegex("(a)(b)").replaceAll("ab", "$2$1")).toBe("ba");
  });

  test("extractFirst returns group 1, else the whole match, else null", () => {
    expect(compileLinearRegex("(\\d{4})$").extractFirst("5551234")).toBe(
      "1234",
    );
    // No capture group: falls back to the whole match.
    expect(compileLinearRegex("\\d+").extractFirst("abc123")).toBe("123");
    // No match.
    expect(compileLinearRegex("(\\d{4})$").extractFirst("12")).toBeNull();
    // Matches but the result is empty -> null (the `|| null` in the contract).
    expect(compileLinearRegex("(x*)").extractFirst("y")).toBeNull();
  });

  test("test is an unanchored match", () => {
    expect(compileLinearRegex("[A-Z]").test("aBc")).toBe(true);
    expect(compileLinearRegex("[A-Z]").test("abc")).toBe(false);
    expect(compileLinearRegex("^\\d{9}$").test("123456789")).toBe(true);
    expect(compileLinearRegex("^\\d{9}$").test("12345678")).toBe(false);
  });

  test("split returns the parts around matches (RE2 split semantics)", () => {
    expect(compileLinearRegex("[;,]").split("a;b,c")).toEqual(["a", "b", "c"]);
    // Unlike String.prototype.split, capture groups are NOT emitted as parts.
    expect(compileLinearRegex("(\\d)").split("a1b2")).toEqual(["a", "b", ""]);
  });

  test("matchGroups returns [whole, ...groups] or null", () => {
    const re = compileLinearRegex("^(\\d{1,2})/(\\d{1,2})/(\\d{4})$");
    expect(re.matchGroups("1/2/2020")).toEqual(["1/2/2020", "1", "2", "2020"]);
    expect(re.matchGroups("nope")).toBeNull();
  });
});

// --- Dialect conformance -----------------------------------------------------

describe("patternConformsToDialect", () => {
  test("accepts in-dialect patterns, including the bundled defaults", () => {
    for (const pattern of [
      "[^0-9]",
      "^\\d{9}$",
      "(\\d{4})$",
      "[A-Z]",
      "^1(\\d{10})$",
      "^\\d{10}$",
      "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$",
      "(a+)+$", // catastrophic on a backtracking engine; safe and in-dialect here
      "(?P<name>x)", // RE2 named-group syntax
    ]) {
      expect(patternConformsToDialect(pattern)).toBe(true);
    }
  });

  test("rejects patterns outside the dialect (fail closed)", () => {
    for (const pattern of [
      "(a)\\1", // backreference
      "a(?=b)", // lookahead
      "(?<=a)b", // lookbehind
      "\\u00e9", // RE2 uses \\x{...}, not \\uXXXX
      "(", // unparseable
      "[a-", // unparseable
    ]) {
      expect(patternConformsToDialect(pattern)).toBe(false);
    }
  });
});

// --- Param coercion ----------------------------------------------------------

describe("coerceToPatternString", () => {
  test("passes a string through unchanged", () => {
    expect(coerceToPatternString("^\\d+$")).toBe("^\\d+$");
  });

  test("renders a non-string deterministically, like the old new RegExp path", () => {
    expect(coerceToPatternString(5)).toBe("5");
    expect(coerceToPatternString(true)).toBe("true");
    expect(coerceToPatternString(null)).toBe("null");
    expect(coerceToPatternString(undefined)).toBe("undefined");
    // An array renders via String(...) to its comma-joined elements -- NOT a short
    // literal: this is the value a partner can grow without bound, so the source
    // it compiles to is what MAX_TRANSFORM_PATTERN_LENGTH must measure.
    expect(coerceToPatternString(["a", "b"])).toBe("a,b");
    expect(coerceToPatternString({})).toBe("[object Object]");
  });

  test("a coerced non-string still compiles under the engine (no TypeError)", () => {
    // RE2JS.compile throws a bare TypeError on null/undefined/array; coercing
    // first guarantees the gate and the factory see the same compilable string.
    expect(patternConformsToDialect(coerceToPatternString(5))).toBe(true);
    expect(patternConformsToDialect(coerceToPatternString(null))).toBe(true);
    expect(patternConformsToDialect(coerceToPatternString(["a", "b"]))).toBe(
      true,
    );
    expect(patternConformsToDialect(coerceToPatternString({}))).toBe(true);
  });
});

// --- Dialect semantics that differ from JavaScript RegExp --------------------
// Pinned so a future re2js change is caught. These are deliberate, documented
// divergences from JS (PROTOCOL.md): both parties run re2js, so they agree with
// each other; only a migration from the old engine sees the difference.

describe("RE2 vs JavaScript class semantics", () => {
  test("\\s is ASCII-only -- narrower than JavaScript's Unicode \\s", () => {
    expect(compileLinearRegex("\\s").test("\t")).toBe(true);
    expect(compileLinearRegex("\\s").test(" ")).toBe(true);
    // JavaScript's \s matches each of these (with or without the u flag); RE2 does not.
    for (const ws of ["\u00a0", "\u000b", "\u2028", "\u2029", "\u3000"]) {
      expect(compileLinearRegex("\\s").test(ws)).toBe(false);
    }
  });

  test(". excludes only newline -- it matches CR and Unicode line separators", () => {
    // JavaScript's . (no s flag) also excludes \r, U+2028, U+2029; RE2's does not.
    expect(compileLinearRegex("^.$").matchGroups("\n")).toBeNull();
    for (const ch of ["\r", "\u2028", "\u2029"]) {
      expect(compileLinearRegex("^.$").matchGroups(ch)).not.toBeNull();
    }
  });
});

// --- Unicode-property and case-folding semantics -----------------------------
// PROTOCOL.md admits \p{...} property classes and inline (?i) into the dialect.
// re2js bakes its Unicode property and case-folding tables into the published
// build, so a re2js upgrade carrying a newer Unicode database could silently
// shift which code points these match -- and because both parties hash the same
// partner pattern into their keys, any shift is a SILENT key divergence. These
// pin the load-bearing behavior so a drift fails CI instead. (re2js stays on a
// caret range for security and bug fixes; this is the guard that an upgrade did
// not move semantics we rely on, which is why pinning the version is unnecessary.)
// Verified against re2js 2.8.3.
//
// Note: the standardization pipeline NFC-normalizes input before the engine sees
// it, canonicalizing some of these code points (e.g. KELVIN SIGN U+212A -> "K").
// These pin the engine layer directly (no NFC), covering the dialect's documented
// surface; the NFC-stable cases (an accented letter, LATIN SMALL LETTER LONG S)
// are the ones that remain engine-dependent after normalization.

describe("Unicode-property and case-folding semantics (pinned vs re2js drift)", () => {
  test("\\p{L} matches ASCII and accented letters, not digits", () => {
    const re = compileLinearRegex("^\\p{L}+$");
    expect(re.test("Abc")).toBe(true);
    expect(re.test("\u00e9")).toBe(true); // e-acute, NFC-stable
    expect(re.test("123")).toBe(false);
  });

  test("\\p{Nd} matches decimal digits, not letters", () => {
    const re = compileLinearRegex("^\\p{Nd}+$");
    expect(re.test("123")).toBe(true);
    expect(re.test("abc")).toBe(false);
  });

  test("(?i) folds ASCII case", () => {
    expect(compileLinearRegex("(?i)^abc$").test("ABC")).toBe(true);
  });

  test("(?i) applies re2js's Unicode case-folding orbit", () => {
    // Folds drawn from re2js's bundled CASE_ORBIT table -- the surface a Unicode
    // database bump in an upgrade would move. LATIN SMALL LETTER LONG S U+017F is
    // NFC-stable and folds to 's'; KELVIN SIGN U+212A folds to 'k' (NFC also maps
    // it to 'K', so this matters only for the raw engine); LATIN CAPITAL LETTER I
    // WITH DOT ABOVE U+0130 deliberately does NOT fold to ASCII 'i'.
    expect(compileLinearRegex("(?i)^s$").test("\u017f")).toBe(true);
    expect(compileLinearRegex("(?i)^k$").test("\u212a")).toBe(true);
    expect(compileLinearRegex("(?i)^i$").test("\u0130")).toBe(false);
  });
});

// --- Linearity (the whole point) ---------------------------------------------

describe("linear-time execution", () => {
  test("a former catastrophic-backtracking pattern matches in linear time", () => {
    // (a+)+$ against a long non-matching input is the textbook ReDoS: on a
    // backtracking engine this is exponential and would hang. The linear-time
    // engine returns promptly; a generous bound makes the linearity a real check
    // (the true time is sub-millisecond) without flaking on a slow CI host.
    const re = compileLinearRegex("(a+)+$");
    const input = "a".repeat(50) + "!";
    const start = performance.now();
    expect(re.test(input)).toBe(false);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  test("a parse_date format with many adjacent groups does not backtrack", () => {
    // 30 adjacent (\d{1,2}) groups -- the parse_date expansion that hangs
    // new RegExp on a non-matching input -- returns promptly here.
    const source = "^" + "(\\d{1,2})".repeat(30) + "$";
    const re = compileLinearRegex(source);
    const start = performance.now();
    expect(re.matchGroups("1".repeat(80) + "x")).toBeNull();
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
