import { expect, test } from "vitest";

import {
  errorWithPartnerCauseLinks,
  partnerOriginText,
  partnerOriginTextList,
} from "../../src/utils/partnerOriginText";
import { DEFAULT_MAX_DISPLAY_LENGTH } from "../../src/utils/sanitizeForDisplay";
import { sanitizeErrorForDisplay } from "../../src/utils/sanitizeErrorForDisplay";

const BEGIN_MARKER = "-----BEGIN OPENSSH PRIVATE KEY-----";
const REDACTION = "[redacted private key]";

// The rendered chain's link separator, read back off a two-link render rather
// than restated, so splitting a render into its links cannot drift from the
// framing the renderer emits.
const CAUSE_SEPARATOR = sanitizeErrorForDisplay(
  new Error("a", { cause: new Error("b") }),
).slice(1, -1);

const linksOf = (error: Error): string[] =>
  sanitizeErrorForDisplay(error).split(CAUSE_SEPARATOR);

// Every form that would put a partner's bytes into first-party copy, each
// refused by `tsc` rather than by review. `npm run typecheck` is what runs
// these: an `@ts-expect-error` over a line that compiles is itself an error,
// so a brand that stopped refusing one of these forms fails the build.
//
// The expressions still RUN under vitest, which transpiles without checking:
// the brand is a phantom with no runtime form, so each yields the string the
// decode branded -- which is what makes the guarantee cost nothing at runtime.
test("the type refuses every form that composes a partner value into copy", () => {
  const value = partnerOriginText("the partner's value");
  const list = partnerOriginTextList(["one", "two"]);

  // @ts-expect-error a partner value is not assignable to a string
  const assigned: string = value;
  // @ts-expect-error concatenation with first-party copy does not compile
  const concatenated = "first-party lead: " + value;
  // @ts-expect-error interpolation into first-party copy does not compile
  const interpolated = `first-party lead: ${value}`;
  // @ts-expect-error a list of partner values has no join to merge them with
  const joined = list.join("; ");

  expect(assigned).toBe("the partner's value");
  expect(concatenated).toBe("first-party lead: the partner's value");
  expect(interpolated).toBe("first-party lead: the partner's value");
  expect(joined).toBe("one; two");
});

test("the elimination keeps the first-party message free of partner bytes", () => {
  const error = errorWithPartnerCauseLinks(
    "the first-party sentence",
    "partner said: ",
    partnerOriginText("the partner's value"),
  );

  expect(error.message).toBe("the first-party sentence");
  expect(linksOf(error)).toEqual([
    "the first-party sentence",
    "partner said: the partner's value",
  ]);
});

test("each value of a list takes a labelled link of its own, in order", () => {
  const links = linksOf(
    errorWithPartnerCauseLinks(
      "the first-party sentence",
      "partner said: ",
      partnerOriginTextList(["first", "second", "third"]),
    ),
  );

  expect(links).toEqual([
    "the first-party sentence",
    "partner said: first",
    "partner said: second",
    "partner said: third",
  ]);
});

test("an empty list renders as the first-party sentence alone", () => {
  const error = errorWithPartnerCauseLinks(
    "the first-party sentence",
    "partner said: ",
    partnerOriginTextList([]),
  );

  expect(error.message).toBe("the first-party sentence");
  expect(linksOf(error)).toEqual(["the first-party sentence"]);
  expect("cause" in error).toBe(false);
});

// Redaction before the fit, not after: a block clipped first leaves a dangling
// `BEGIN` in the kept prefix, which the render boundary's own fail-closed rule
// then reads forward over everything the partner wrote behind it. The tail is
// what tells the two orders apart -- the boundary redacts each link either way,
// so a block with nothing behind it renders identically under both.
test("a planted key block is redacted before the link is fitted", () => {
  const tail = " and the rest of what the partner wrote";
  const [, link] = linksOf(
    errorWithPartnerCauseLinks(
      "the first-party sentence",
      "partner said: ",
      partnerOriginText(
        `${BEGIN_MARKER}\n${"B".repeat(400)}\n-----END OPENSSH PRIVATE KEY-----${tail}`,
      ),
    ),
  );

  expect(link).toBe(`partner said: ${REDACTION}${tail}`);
});

test("a control character is replaced, so no link boundary can be forged", () => {
  const links = linksOf(
    errorWithPartnerCauseLinks(
      "the first-party sentence",
      "partner said: ",
      partnerOriginText("before\ncaused by: forged link\tafter"),
    ),
  );

  expect(links).toEqual([
    "the first-party sentence",
    "partner said: before<0a>caused by: forged link<09>after",
  ]);
});

test("an oversized value is fitted to the per-value budget, label included", () => {
  const label = "partner said: ";
  const [sentence, link] = linksOf(
    errorWithPartnerCauseLinks(
      "the first-party sentence",
      label,
      partnerOriginText("w".repeat(10_000)),
    ),
  );

  expect(sentence).toBe("the first-party sentence");
  expect(link!.length).toBeLessThanOrEqual(DEFAULT_MAX_DISPLAY_LENGTH);
  expect(link!.startsWith(label)).toBe(true);
});
