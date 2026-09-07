import { expect, test } from "vitest";

import {
  errorWithPartnerCauseLinks,
  MAX_PARTNER_VALUES_SHOWN,
  partnerOriginText,
  partnerOriginTextList,
} from "../../src/utils/partnerOriginText";
import {
  COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
  DEFAULT_MAX_DISPLAY_LENGTH,
} from "../../src/utils/sanitizeForDisplay";
import {
  CAUSE_DEPTH_ELISION_MARKER,
  sanitizeErrorForDisplay,
} from "../../src/utils/sanitizeErrorForDisplay";

const BEGIN_MARKER = "-----BEGIN OPENSSH PRIVATE KEY-----";
const REDACTION = "[redacted private key]";
const LABEL = "partner said: ";
const SENTENCE = "the first-party sentence";

// What the terms exchange's `abortReasons` field admits (`MAX_ABORT_REASONS`,
// src/protocolSetup.ts): a flood bound, well past what a chain can show.
const WIRE_MAX_VALUES = 256;

// The rendered chain's link separator, read back off a two-link render rather
// than restated, so splitting a render into its links cannot drift from the
// framing the renderer emits.
const CAUSE_SEPARATOR = sanitizeErrorForDisplay(
  new Error("a", { cause: new Error("b") }),
).slice(1, -1);

// The separator between two values packed on one link, read back the same way:
// the two line breaks a first-party composition places, as the sink's escape
// renders them.
const VALUE_SEPARATOR = sanitizeErrorForDisplay(new Error("a\n\nb")).slice(
  1,
  -1,
);

const linksOf = (error: Error): string[] =>
  sanitizeErrorForDisplay(error).split(CAUSE_SEPARATOR);

const valuesOf = (error: Error): string[] =>
  linksOf(error)
    .slice(1)
    .flatMap((link) => link.split(VALUE_SEPARATOR));

const abortOver = (values: readonly string[]): Error =>
  errorWithPartnerCauseLinks(SENTENCE, LABEL, partnerOriginTextList(values));

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

// The measured edge of what the type refuses, held here so the module's stated
// bound and the compiler cannot drift apart. TypeScript special-cases both
// conversions -- neither carries an `@ts-expect-error`, so this case fails if a
// later change makes either an error, and it fails the same way if the doc
// keeps claiming they are refused.
test("an explicit conversion is not refused, so it is the review tell", () => {
  const value = partnerOriginText("the partner's value");

  expect(String(value)).toBe("the partner's value");
  expect(value.toString()).toBe("the partner's value");
});

test("the elimination keeps the first-party message free of partner bytes", () => {
  const error = errorWithPartnerCauseLinks(
    SENTENCE,
    LABEL,
    partnerOriginText("the partner's value"),
  );

  expect(error.message).toBe(SENTENCE);
  expect(linksOf(error)).toEqual([SENTENCE, `${LABEL}the partner's value`]);
});

test("each value is labelled and ordered, packed three to a link", () => {
  const links = linksOf(abortOver(["first", "second", "third", "fourth"]));

  expect(links).toEqual([
    SENTENCE,
    [`${LABEL}first`, `${LABEL}second`, `${LABEL}third`].join(VALUE_SEPARATOR),
    `${LABEL}fourth`,
  ]);
});

test("an empty list renders as the first-party sentence alone", () => {
  const error = abortOver([]);

  expect(error.message).toBe(SENTENCE);
  expect(linksOf(error)).toEqual([SENTENCE]);
  expect("cause" in error).toBe(false);
});

// The disclosure the packing exists for: a terms refusal states itself from
// eighteen reason sites -- seventeen in `validateCompatibility`
// (src/linkageTermsNegotiation.ts) and the responder's parse refusal -- and one
// link per value would have shown seven of them and elided the rest.
// The count is written out rather than read off the ceiling, so a ceiling that
// stopped covering a whole refusal reddens here.
const COMPATIBILITY_REASON_SITES = 18;

test("every reason a real refusal states reaches the operator whole", () => {
  expect(MAX_PARTNER_VALUES_SHOWN).toBeGreaterThanOrEqual(
    COMPATIBILITY_REASON_SITES,
  );
  const values = Array.from(
    { length: COMPATIBILITY_REASON_SITES },
    (_, index) => `reason number ${index + 1} of the refusal`,
  );
  const error = abortOver(values);

  expect(valuesOf(error)).toEqual(values.map((value) => `${LABEL}${value}`));
  // Nothing was cut: neither the renderer's depth bound nor its per-link cap
  // bites a chain this builds at the ceiling.
  expect(sanitizeErrorForDisplay(error)).not.toContain(
    CAUSE_DEPTH_ELISION_MARKER,
  );
  for (const link of linksOf(error))
    expect(link.length).toBeLessThanOrEqual(
      COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
    );
});

test("past the ceiling one first-party link counts what is not shown", () => {
  const values = Array.from(
    { length: WIRE_MAX_VALUES },
    (_, index) => `reason ${index + 1}`,
  );
  const links = linksOf(abortOver(values));
  const tail = links[links.length - 1]!;

  expect(valuesOf(abortOver(values)).slice(0, -1)).toEqual(
    values
      .slice(0, MAX_PARTNER_VALUES_SHOWN)
      .map((value) => `${LABEL}${value}`),
  );
  expect(tail).toBe(
    `${WIRE_MAX_VALUES - MAX_PARTNER_VALUES_SHOWN} further values the partner sent are not shown`,
  );
  // The count is what the operator reads instead of the renderer's own
  // marker, which holds none.
  expect(links.join("")).not.toContain(CAUSE_DEPTH_ELISION_MARKER);
});

test("one value past the ceiling is counted as one", () => {
  const links = linksOf(
    abortOver(
      Array.from(
        { length: MAX_PARTNER_VALUES_SHOWN + 1 },
        (_, index) => `reason ${index + 1}`,
      ),
    ),
  );

  expect(links[links.length - 1]).toBe(
    "1 further value the partner sent is not shown",
  );
});

// Redaction before the fit, not after: a block clipped first leaves a dangling
// `BEGIN` in the kept prefix, which the render boundary's own fail-closed rule
// then reads forward over everything the partner wrote behind it. The tail is
// what tells the two orders apart -- the boundary redacts each link either way,
// so a block with nothing behind it renders identically under both.
test("a planted key block is redacted before the value is fitted", () => {
  const tail = " and the rest of what the partner wrote";
  const [, link] = linksOf(
    errorWithPartnerCauseLinks(
      SENTENCE,
      LABEL,
      partnerOriginText(
        `${BEGIN_MARKER}\n${"B".repeat(400)}\n-----END OPENSSH PRIVATE KEY-----${tail}`,
      ),
    ),
  );

  expect(link).toBe(`${LABEL}${REDACTION}${tail}`);
});

test("a control character is replaced, so no link boundary can be forged", () => {
  const links = linksOf(
    errorWithPartnerCauseLinks(
      SENTENCE,
      LABEL,
      partnerOriginText("before\ncaused by: forged link\tafter"),
    ),
  );

  expect(links).toEqual([
    SENTENCE,
    `${LABEL}before<0a>caused by: forged link<09>after`,
  ]);
});

// The separator's other half: a value that spells the escape's own token still
// cannot open a value of its own, because the sink doubles the backslash it
// spelled and two tokens in a row are unspellable.
test("a value cannot forge the separator between two values", () => {
  const forged = `\\x0a\\x0a${LABEL}a reason the partner never sent`;
  const values = valuesOf(abortOver([forged, "the second reason"]));

  expect(values).toHaveLength(2);
  expect(values[0]).toBe(
    `${LABEL}\\\\x0a\\\\x0a${LABEL}a reason the partner never sent`,
  );
  expect(values[1]).toBe(`${LABEL}the second reason`);
});

test("an oversized value is fitted to the per-value budget", () => {
  const [sentence, link] = linksOf(
    errorWithPartnerCauseLinks(
      SENTENCE,
      LABEL,
      partnerOriginText("w".repeat(10_000)),
    ),
  );

  expect(sentence).toBe(SENTENCE);
  expect(link!.length).toBeLessThanOrEqual(
    LABEL.length + DEFAULT_MAX_DISPLAY_LENGTH,
  );
  expect(link!.startsWith(LABEL)).toBe(true);
});

// The label is first-party, so it is clipped rather than refused; what the
// clip protects is the arithmetic behind the link, which would otherwise let a
// long label carry a full pack of values past the renderer's per-link cap and
// have the renderer cut the last of them.
test("an oversized label cannot push a link past the per-link budget", () => {
  const links = linksOf(
    errorWithPartnerCauseLinks(
      SENTENCE,
      "L".repeat(328),
      partnerOriginTextList(
        Array.from({ length: 3 }, () => "w".repeat(10_000)),
      ),
    ),
  );

  for (const link of links)
    expect(link.length).toBeLessThanOrEqual(
      COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
    );
  expect(links[1]).toContain("...[truncated]");
});
