import { expect, test } from "vitest";
import { z } from "zod";

import { maxCodeUnits } from "../../src/utils/maxCodeUnits";

// U+1F600: one code POINT, two UTF-16 code units.
const EMOJI = "\u{1F600}";

const bounded = z.string().check(maxCodeUnits(256));

test("the installed Zod counts code points in its own .max(), which is why this check exists", () => {
  // The assumption the whole conversion rests on, driven against the real
  // package rather than assumed: a bare `.max(256)` takes 256 emoji -- 512
  // code units -- so a schema left on `.max()` would accept twice the content
  // the hand-written predicates on the same ceiling refuse. A Zod that went
  // back to counting code units would fail here rather than silently making
  // the two spellings equivalent again.
  expect(z.string().max(256).safeParse(EMOJI.repeat(256)).success).toBe(true);
  expect(z.string().max(256).safeParse(EMOJI.repeat(257)).success).toBe(false);
});

test("refuses a string past the ceiling in code units", () => {
  // Both the emoji count the bare bound accepts and the one past it.
  for (const count of [256, 257]) {
    const value = EMOJI.repeat(count);
    expect(value.length).toBe(count * 2);
    expect(bounded.safeParse(value).success).toBe(false);
  }
  expect(bounded.safeParse("a".repeat(257)).success).toBe(false);
});

test("accepts a string at the ceiling in code units", () => {
  const atCeiling = EMOJI.repeat(128);
  expect(atCeiling.length).toBe(256);
  expect(bounded.safeParse(atCeiling).success).toBe(true);
  expect(bounded.safeParse("a".repeat(256)).success).toBe(true);
});

test("reports what the Zod bound it stands in for reports", () => {
  // Same issue on an ASCII value, where the two counting units agree: a
  // conversion site keeps the message and the issue shape it had. Compared as
  // serialized text, since an issue array reaches an operator's log as JSON
  // (the record-build failure warning in exchange.ts), where key order shows.
  const over = "a".repeat(257);
  const fromBound = z.object({ f: z.string().max(256) }).safeParse({ f: over });
  const fromCheck = z.object({ f: bounded }).safeParse({ f: over });
  expect(fromCheck.success).toBe(false);
  expect(fromBound.success).toBe(false);
  if (fromBound.success || fromCheck.success) return;
  expect(JSON.stringify(fromCheck.error.issues)).toBe(
    JSON.stringify(fromBound.error.issues),
  );
});

test("takes the message a bound named for itself", () => {
  const named = z
    .string()
    .check(maxCodeUnits(4, "must not exceed 4 characters"));
  const refused = named.safeParse("abcde");
  expect(refused.success).toBe(false);
  if (refused.success) return;
  expect(refused.error.issues[0].message).toBe("must not exceed 4 characters");
});

test("does not abort the checks chained after it", () => {
  // `.max()` is non-aborting, and several schemas rely on that: a refine
  // downstream of the ceiling still runs and reports its own issue. Both
  // issues, in the chained order.
  const chained = z
    .string()
    .check(maxCodeUnits(4))
    .regex(/^[a-z]+$/, "must be lowercase letters");
  const refused = chained.safeParse("ABCDEFG");
  expect(refused.success).toBe(false);
  if (refused.success) return;
  expect(refused.error.issues.map((issue) => issue.code)).toEqual([
    "too_big",
    "invalid_format",
  ]);
});
