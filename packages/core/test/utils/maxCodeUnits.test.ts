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

// What a `.max(4)` bound renders for the same refusal, measured by driving Zod
// 4.4.3, whose `.max()` counted code units: the rendering this check stands in
// for. Both forms are pinned because both reach a reader -- the issue array is
// what a caller walks (`linkageTermsNegotiation.ts` renders each issue's path
// and message), and the ZodError's own message is the indented JSON an uncaught
// parse failure prints. Key order shows in both, so a refusal that names its
// own message is pinned beside the default one.
const RENDERED = {
  default: {
    issues:
      '[{"origin":"string","code":"too_big","maximum":4,"inclusive":true,"path":[],"message":"Too big: expected string to have <=4 characters"}]',
    text: `[
  {
    "origin": "string",
    "code": "too_big",
    "maximum": 4,
    "inclusive": true,
    "path": [],
    "message": "Too big: expected string to have <=4 characters"
  }
]`,
  },
  custom: {
    issues:
      '[{"origin":"string","code":"too_big","maximum":4,"inclusive":true,"path":[],"message":"must not exceed 4 characters"}]',
    text: `[
  {
    "origin": "string",
    "code": "too_big",
    "maximum": 4,
    "inclusive": true,
    "path": [],
    "message": "must not exceed 4 characters"
  }
]`,
  },
  nested: {
    issues:
      '[{"origin":"string","code":"too_big","maximum":4,"inclusive":true,"path":["column","name"],"message":"Too big: expected string to have <=4 characters"}]',
    text: `[
  {
    "origin": "string",
    "code": "too_big",
    "maximum": 4,
    "inclusive": true,
    "path": [
      "column",
      "name"
    ],
    "message": "Too big: expected string to have <=4 characters"
  }
]`,
  },
  array: {
    issues:
      '[{"expected":"string","code":"invalid_type","path":[],"message":"Invalid input: expected string, received array"},{"origin":"array","code":"too_big","maximum":4,"inclusive":true,"path":[],"message":"Too big: expected array to have <=4 items"}]',
    text: `[
  {
    "expected": "string",
    "code": "invalid_type",
    "path": [],
    "message": "Invalid input: expected string, received array"
  },
  {
    "origin": "array",
    "code": "too_big",
    "maximum": 4,
    "inclusive": true,
    "path": [],
    "message": "Too big: expected array to have <=4 items"
  }
]`,
  },
};

const refusalOf = (schema: z.ZodType, input: unknown) => {
  const result = schema.safeParse(input);
  if (result.success) throw new Error("expected the value to be refused");
  return {
    issues: JSON.stringify(result.error.issues),
    text: String(result.error),
  };
};

test("renders a refusal as the bound it stands in for rendered it", () => {
  expect(refusalOf(z.string().check(maxCodeUnits(4)), "abcde")).toEqual(
    RENDERED.default,
  );
});

test("renders a bound's own message where that bound named one", () => {
  expect(
    refusalOf(
      z.string().check(maxCodeUnits(4, "must not exceed 4 characters")),
      "abcde",
    ),
  ).toEqual(RENDERED.custom);
});

test("renders the field's path in a nested document", () => {
  const document = z.object({
    column: z.object({ name: z.string().check(maxCodeUnits(4)) }),
  });
  expect(refusalOf(document, { column: { name: "abcde" } })).toEqual(
    RENDERED.nested,
  );
});

test("reports both issues for a non-string value that has a length", () => {
  // A value that failed the string type check still reaches the ceiling, and
  // the ceiling reports against the kind of value it got: an array of five
  // elements is refused as an array, past the type refusal, exactly as the
  // bound this stands in for refused it.
  expect(
    refusalOf(z.string().check(maxCodeUnits(4)), ["a", "b", "c", "d", "e"]),
  ).toEqual(RENDERED.array);
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
