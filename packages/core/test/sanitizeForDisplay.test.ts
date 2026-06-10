import { describe, expect, test } from "vitest";

import {
  sanitizeForDisplay,
  DISPLAY_TRUNCATION_MARKER,
  DEFAULT_MAX_DISPLAY_LENGTH,
} from "../src/utils/sanitizeForDisplay";

describe("sanitizeForDisplay", () => {
  test("passes an ordinary ASCII value through unchanged", () => {
    expect(sanitizeForDisplay("MOU-2025-0042")).toBe("MOU-2025-0042");
    expect(sanitizeForDisplay("Audit and evaluation, FY25")).toBe(
      "Audit and evaluation, FY25",
    );
  });

  test("returns an empty string unchanged", () => {
    expect(sanitizeForDisplay("")).toBe("");
  });

  test("escapes an ANSI / control escape sequence", () => {
    const out = sanitizeForDisplay("\x1b[31mERROR\x1b[0m");
    // The raw ESC that drives the sequence is gone; the inert "[31m" text may
    // remain but cannot be interpreted by a terminal without the ESC.
    expect(out).not.toContain("\x1b");
    expect(out).toContain("\\x1b");
    expect(out).toContain("[31mERROR");
  });

  test("escapes a newline so it cannot spoof a log line", () => {
    const out = sanitizeForDisplay("ok\nFAKE: all clear");
    expect(out).not.toContain("\n");
    expect(out).toContain("\\x0a");
  });

  test("escapes other C0 controls and DEL", () => {
    expect(sanitizeForDisplay("\r")).toBe("\\x0d");
    expect(sanitizeForDisplay("\t")).toBe("\\x09");
    expect(sanitizeForDisplay("\x7f")).toBe("\\x7f");
    expect(sanitizeForDisplay("\x00")).toBe("\\x00");
  });

  test("neutralizes a bidi-override character (RLO)", () => {
    const out = sanitizeForDisplay("user‮EVIL");
    expect(out).not.toContain("‮");
    expect(out).toContain("\\u202e");
  });

  test("neutralizes zero-width characters", () => {
    const out = sanitizeForDisplay("a​b﻿c");
    expect(out).not.toContain("​");
    expect(out).not.toContain("﻿");
    expect(out).toBe("a\\u200bb\\ufeffc");
  });

  test("neutralizes a homoglyph / confusable (Cyrillic small a)", () => {
    // U+0430 renders identically to ASCII "a" but is a different character.
    const out = sanitizeForDisplay("cаfe");
    expect(out).not.toContain("а");
    expect(out).toBe("c\\u0430fe");
  });

  test("doubles a literal backslash so the escaping is unambiguous", () => {
    // A literal "\x1b" (four printable ASCII chars) must not be confusable with
    // a real escaped ESC: the backslash is doubled.
    expect(sanitizeForDisplay("a\\b")).toBe("a\\\\b");
    expect(sanitizeForDisplay("\\x1b")).toBe("\\\\x1b");
  });

  test("escapes an astral code point with the \\u{...} form", () => {
    expect(sanitizeForDisplay("\u{1f600}")).toBe("\\u{1f600}");
  });

  test("truncates an over-long value and appends the marker", () => {
    const value = "a".repeat(DEFAULT_MAX_DISPLAY_LENGTH + 50);
    const out = sanitizeForDisplay(value);
    expect(out).not.toContain(value);
    expect(out.startsWith("a".repeat(DEFAULT_MAX_DISPLAY_LENGTH))).toBe(true);
    expect(out.endsWith(DISPLAY_TRUNCATION_MARKER)).toBe(true);
  });

  test("respects a custom maxLength", () => {
    expect(sanitizeForDisplay("a".repeat(100), { maxLength: 10 })).toBe(
      "aaaaaaaaaa" + DISPLAY_TRUNCATION_MARKER,
    );
  });

  test("does not append the marker for a value exactly at the cap", () => {
    expect(sanitizeForDisplay("a".repeat(10), { maxLength: 10 })).toBe(
      "a".repeat(10),
    );
  });

  test("bounds the output length, not the input code-point count", () => {
    // Each astral emoji escapes to a 9-char \u{1f600} (up to 10 for a 6-hex-digit
    // code point); a code-point cap would let the output run to ~10x. The cap
    // bounds the escaped output instead, so an all-astral hostile value stays
    // small.
    const hostile = "\u{1f600}".repeat(500);
    const out = sanitizeForDisplay(hostile, { maxLength: 64 });
    expect(out.length).toBeLessThanOrEqual(
      64 + DISPLAY_TRUNCATION_MARKER.length,
    );
    expect(out.endsWith(DISPLAY_TRUNCATION_MARKER)).toBe(true);
  });

  test("appends only whole escapes when truncating (never ends mid-escape)", () => {
    // Each emoji escapes to "\u{1f600}" (9 chars); with a 20-char cap exactly two
    // fit (18 chars), the third would overflow, so the cut lands on an escape
    // boundary rather than splitting "\u{1f60...".
    const out = sanitizeForDisplay("\u{1f600}".repeat(5), { maxLength: 20 });
    expect(out).toBe("\\u{1f600}".repeat(2) + DISPLAY_TRUNCATION_MARKER);
  });
});
