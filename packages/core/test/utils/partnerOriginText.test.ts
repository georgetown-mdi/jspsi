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

// The first-party text opening the value at a 1-based position: the position
// the elimination leads every label with, then the label itself.
const labelAt = (position: number): string => `${position}. ${LABEL}`;

// One link's labelled values, partitioned where the next value's label opens
// rather than on the separator alone: a value ending in the escape's own token
// renders a separator-shaped span of its own four characters ahead of the one
// the composition placed, and the label behind it is what tells the two apart.
const valuesOnLink = (link: string, first: number): string[] => {
  const values: string[] = [];
  let cursor = 0;
  for (let position = first + 1; ; position++) {
    const opening = link.indexOf(
      `${VALUE_SEPARATOR}${labelAt(position)}`,
      cursor,
    );
    if (opening === -1) {
      values.push(link.slice(cursor));
      return values;
    }
    values.push(link.slice(cursor, opening));
    cursor = opening + VALUE_SEPARATOR.length;
  }
};

// Every value the chain renders, in order. The counted tail link holds no
// label, so it arrives as one trailing entry.
const valuesOf = (error: Error): string[] => {
  const values: string[] = [];
  for (const link of linksOf(error).slice(1))
    values.push(...valuesOnLink(link, values.length + 1));
  return values;
};

const labelled = (values: readonly string[]): string[] =>
  values.map((value, index) => `${labelAt(index + 1)}${value}`);

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
  expect(linksOf(error)).toEqual([
    SENTENCE,
    `${labelAt(1)}the partner's value`,
  ]);
});

test("each value is labelled by position and ordered, three to a link", () => {
  const links = linksOf(abortOver(["first", "second", "third", "fourth"]));

  expect(links).toEqual([
    SENTENCE,
    [`${labelAt(1)}first`, `${labelAt(2)}second`, `${labelAt(3)}third`].join(
      VALUE_SEPARATOR,
    ),
    `${labelAt(4)}fourth`,
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

  expect(valuesOf(error)).toEqual(labelled(values));
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
    labelled(values.slice(0, MAX_PARTNER_VALUES_SHOWN)),
  );
  expect(tail).toBe(
    `${WIRE_MAX_VALUES - MAX_PARTNER_VALUES_SHOWN} further values the partner sent are not shown`,
  );
  // The count is what the operator reads instead of the renderer's own
  // marker, which holds none.
  expect(links.join("")).not.toContain(CAUSE_DEPTH_ELISION_MARKER);
});

// The partner picks the bytes, so it can repeat them. The renderer drops a
// cause link whose raw message repeats the previous link's, which would take
// whole packs of a repeated value off the operator's screen -- uncounted,
// since the tail states what the ceiling left out and not what the renderer
// dropped -- if every label did not lead with the value's own position.
const REPEATED = "the partner repeated this reason";

test("identical values each keep a labelled place of their own", () => {
  const values = Array.from(
    { length: MAX_PARTNER_VALUES_SHOWN },
    () => REPEATED,
  );
  const error = abortOver(values);

  expect(valuesOf(error)).toEqual(labelled(values));
  const rendered = sanitizeErrorForDisplay(error);
  expect(rendered).not.toContain("further value");
  expect(rendered).not.toContain(CAUSE_DEPTH_ELISION_MARKER);
});

test("identical values past the ceiling are counted exactly", () => {
  const values = Array.from({ length: WIRE_MAX_VALUES }, () => REPEATED);
  const error = abortOver(values);
  const links = linksOf(error);

  expect(valuesOf(error).slice(0, -1)).toEqual(
    labelled(values.slice(0, MAX_PARTNER_VALUES_SHOWN)),
  );
  expect(links[links.length - 1]).toBe(
    `${WIRE_MAX_VALUES - MAX_PARTNER_VALUES_SHOWN} further values the partner sent are not shown`,
  );
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

  expect(link).toBe(`${labelAt(1)}${REDACTION}${tail}`);
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
    `${labelAt(1)}before<0a>caused by: forged link<09>after`,
  ]);
});

// The separator's other half: a value that spells the escape's own token still
// cannot open a value of its own, because the sink doubles the backslash it
// spelled and two tokens in a row are unspellable.
test("a value cannot forge the separator between two values", () => {
  const forged = `\\x0a\\x0a${labelAt(2)}a reason the partner never sent`;
  const values = valuesOf(abortOver([forged, "the second reason"]));

  expect(values).toHaveLength(2);
  expect(values[0]).toBe(
    `${labelAt(1)}\\\\x0a\\\\x0a${labelAt(2)}a reason the partner never sent`,
  );
  expect(values[1]).toBe(`${labelAt(2)}the second reason`);
});

// A stated limit rather than a pre-clip: the value handed to the treatments is
// bounded by the transport's frame cap alone, since the terms exchange sets no
// inbound cap on a reason, so the fit measures an escaped form it materializes
// whole -- what clipToRenderedCost asks its caller to bound first. A raw-length
// clip ahead of the redaction would satisfy that and change which bytes reach
// the operator, so the limit is recorded here instead.
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
    labelAt(1).length + DEFAULT_MAX_DISPLAY_LENGTH,
  );
  expect(link!.startsWith(labelAt(1))).toBe(true);
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

// The clip's other half, and what the module's doc rests the anti-suppression
// guarantee on: the position leads the label, so a label at or over the label
// budget is cut behind it and two packs of one repeated value stay distinct.
// Cutting the position away instead makes the packs byte-identical, and the
// renderer's duplicate-link suppression takes a whole pack off the operator's
// screen -- uncounted, since the tail states what the ceiling left out.
test("a clipped label keeps every value's leading position", () => {
  const links = linksOf(
    errorWithPartnerCauseLinks(
      SENTENCE,
      "L".repeat(328),
      partnerOriginTextList(
        Array.from({ length: 6 }, () => "w".repeat(10_000)),
      ),
    ),
  );

  expect(links).toHaveLength(3);
  expect(links[1]).not.toBe(links[2]);
  const packed = [
    ...links[1]!.split(VALUE_SEPARATOR),
    ...links[2]!.split(VALUE_SEPARATOR),
  ];
  expect(packed).toHaveLength(6);
  packed.forEach((value, index) =>
    expect(value.startsWith(`${index + 1}. `)).toBe(true),
  );
});
