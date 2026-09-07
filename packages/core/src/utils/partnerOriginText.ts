import {
  MAX_ERROR_CAUSE_DEPTH,
  redactPrivateKeyMaterial,
} from "./sanitizeErrorForDisplay";
import {
  clipToRenderedCost,
  COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
  DEFAULT_MAX_DISPLAY_LENGTH,
  renderedDisplayCost,
  replaceControlCharactersForDisplay,
} from "./sanitizeForDisplay";

declare const partnerOriginBrand: unique symbol;

/**
 * One string whose bytes the partner chose, as it leaves a wire-frame decode.
 *
 * The type is deliberately NOT assignable to `string`, which refuses the four
 * forms that compose a value into first-party copy: assignment to a `string`,
 * `+`, template interpolation, and (on the list form) `join`. Each is a
 * compile error, so a partner fragment cannot enter first-party copy at any
 * site, present or future, through the forms a composition actually uses.
 * {@link errorWithPartnerCauseLinks} is the ONE way to get the bytes back out,
 * and it hands them to the operator as a labelled cause link rather than as
 * text inside a message. Adding a second way out removes the guarantee.
 *
 * The bound is measured, not total: TypeScript special-cases `String(value)`
 * and `value.toString()`, which compile on any type and return the partner's
 * bytes as a plain `string`. No type refuses them, and a lint rule that would
 * is not in place, so an explicit conversion at a composition site is a review
 * tell rather than a build failure. `test/utils/partnerOriginText.test.ts`
 * records both forms compiling, so the bound stated here cannot drift from
 * what the compiler does.
 *
 * The brand is a phantom keyed by a module-private `unique symbol` over
 * `symbol`, not over `string`: a `string`-based brand stays assignable to
 * `string`, which leaves concatenation and interpolation compiling (measured
 * against `tsc` -- an object brand blocks assignment but not `+` or a template
 * literal, while a `symbol` brand blocks all three). Nothing outside this
 * module can satisfy it, so the value's real runtime type -- a `string`, or a
 * `readonly string[]` for the list -- is visible only here, which is why the
 * two casts each introduction needs are confined to this file.
 *
 * The brand marks WHO CHOSE THE BYTES, not what they mean: a value used as a
 * protocol token rather than shown to an operator (a base64url secret, an
 * enum) is pinned by its own schema and is not branded, since a lexically
 * pinned field has no free bytes to plant anything in.
 */
export type PartnerOriginText = symbol & {
  readonly [partnerOriginBrand]: "one";
};

/**
 * An ordered list of {@link PartnerOriginText}, for a wire field the partner
 * fills with several values (the terms exchange's abort reasons).
 *
 * A list of its own rather than `readonly PartnerOriginText[]` because an
 * array's `join` is declared over any element type, so joining the partner's
 * values into one string would still compile; on this type `join`, `map` and
 * `length` do not exist, and {@link errorWithPartnerCauseLinks} gives each
 * value a labelled place of its own.
 */
export type PartnerOriginTextList = symbol & {
  readonly [partnerOriginBrand]: "many";
};

/**
 * Brand one decoded wire-frame string as partner-chosen. Called at the decode
 * chokepoint (a wire schema's `.transform`), never at a consumer: a value that
 * reaches a consumer unbranded has already lost the guarantee.
 *
 * No wire schema takes it yet -- the branded chokepoint is the abort reasons'
 * LIST -- and it is exported for the scalar field the next chokepoint brands,
 * so that PR adds a `.transform` rather than this form beside it.
 */
export const partnerOriginText = (value: string): PartnerOriginText =>
  value as unknown as PartnerOriginText;

/** {@link partnerOriginText} for a wire field holding several values. */
export const partnerOriginTextList = (
  values: readonly string[],
): PartnerOriginTextList => values as unknown as PartnerOriginTextList;

/**
 * What one whole cause link may render to: the renderer's own per-link cap
 * ({@link COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH}), which is the width a link
 * built here is fitted to. Past it the renderer clips the link as one string,
 * taking the last values packed on it with the clip.
 */
const PARTNER_LINK_BUDGET = COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH;

/**
 * What the label before each value may render to. The label is first-party
 * copy, so this is not a defense but a FLOOR under the room left for the
 * values: it keeps the arithmetic below independent of the label a call site
 * passes, so no label can spend a value's budget or push a link past
 * {@link PARTNER_LINK_BUDGET}. A label longer than this is clipped like any
 * other over-budget text, which is visible in the output rather than silent.
 */
const PARTNER_LABEL_BUDGET = 64;

/**
 * What one partner value may render to: the per-value display budget every
 * other chooser's fragment is fitted to
 * (`apps/cli/src/connection/causeLink.ts`, and the budgets
 * `test/connection/transportRefusalBudget.test.ts` pins).
 */
const PARTNER_VALUE_BUDGET = DEFAULT_MAX_DISPLAY_LENGTH;

/**
 * The separator between two labelled values on one link: two line breaks,
 * placed by this composition and by nothing else.
 *
 * No value can forge it. Each is control-replaced before it is packed, so a
 * control character it holds arrives as the replacement's `<0a>` marker rather
 * than as the escape's `\xHH` token, and the sink's escape doubles a literal
 * backslash the value spells itself -- a value writing `\x0a` renders as
 * `\\x0a`. That doubling still leaves ONE token spellable as a substring of
 * the value's own rendering, which is why the separator is two: a rendered
 * lone backslash only ever opens an escape for a code point outside printable
 * ASCII, and the code point that would spell this token is a control character
 * the replacement has already taken out, so a second token can never follow
 * the first.
 *
 * It cannot forge a link boundary either. The renderer joins its links after
 * escaping them, so the raw line breaks here are escaped into text, while the
 * boundary is a raw one the join adds afterwards.
 */
const PARTNER_VALUE_SEPARATOR = "\n\n";

/**
 * How many labelled values one link carries: as many as the three budgets
 * admit WHOLE, which is three at today's values.
 *
 * A link per value would put the whole disclosure inside the renderer's depth
 * bound: it walks {@link MAX_ERROR_CAUSE_DEPTH} links, so seven reasons would
 * reach the operator and a real mismatch -- a terms refusal states itself from
 * eighteen reason sites -- would arrive mostly as the renderer's elision
 * marker. Packing spends the per-link budget instead, which is four times the
 * per-value one.
 *
 * Derived rather than written down, so the renderer's own per-link clip can
 * never bite a link this builds: `n` values cost
 * `n * (label + value) + (n - 1) * separator`, which is inside
 * {@link PARTNER_LINK_BUDGET} exactly while `n * (label + value + separator)`
 * is inside that budget plus one separator. The floor of one carries the
 * degenerate case where a single value does not fit at all, where the
 * renderer's clip governs and nothing here could help.
 */
const PARTNER_VALUES_PER_LINK = Math.max(
  1,
  Math.floor(
    (PARTNER_LINK_BUDGET + renderedDisplayCost(PARTNER_VALUE_SEPARATOR)) /
      (PARTNER_LABEL_BUDGET +
        PARTNER_VALUE_BUDGET +
        renderedDisplayCost(PARTNER_VALUE_SEPARATOR)),
  ),
);

/**
 * How many values reach the operator before the counted tail link: every link
 * the renderer's depth admits, less the error's own first-party message and
 * the tail itself.
 *
 * Sized to carry a whole refusal rather than the wire's `MAX_ABORT_REASONS`,
 * which bounds a flood and not a disclosure: eighteen covers every reason site
 * a terms refusal states itself from -- seventeen in `validateCompatibility`
 * (src/linkageTermsNegotiation.ts) and the responder's parse refusal.
 */
export const MAX_PARTNER_VALUES_SHOWN =
  PARTNER_VALUES_PER_LINK * (MAX_ERROR_CAUSE_DEPTH - 2);

/**
 * One value as it sits on a link: the label's first-party text, then the
 * partner's value redacted, control-replaced and fitted to
 * {@link PARTNER_VALUE_BUDGET}.
 *
 * The order of the three treatments is what makes the link safe. Redaction
 * runs first, since clipping first could leave a `BEGIN` marker in the kept
 * prefix for {@link clipToRenderedCost}'s fail-closed dangling rule to consume
 * along with the truncation marker. Control replacement runs before the fit,
 * so the value is fitted to what the operator is shown rather than to a width
 * a later treatment changes; its order against redaction does not matter,
 * since neither can make or unmake the other's match. What is kept is raw and
 * escaped exactly once at the display sink (CONTRIBUTING.md, Operator-facing
 * escaping).
 *
 * Each value carries the label rather than the link carrying it once, so the
 * text opening a value is first-party on every value: a value that spells the
 * separator's shape still cannot open a labelled one.
 */
const labelledValue = (label: string, value: string): string =>
  `${label}${clipToRenderedCost(
    replaceControlCharactersForDisplay(redactPrivateKeyMaterial(value)),
    PARTNER_VALUE_BUDGET,
  )}`;

/**
 * The first-party link closing a chain that hit {@link MAX_PARTNER_VALUES_SHOWN},
 * stating how many values it left out. A count rather than the renderer's own
 * elision marker, which cannot hold one: this composition knows the length of
 * the list it was given, so the operator reads a stated loss instead of
 * inferring one from a chain that stops.
 */
const elidedValuesLink = (count: number): string =>
  count === 1
    ? "1 further value the partner sent is not shown"
    : `${count} further values the partner sent are not shown`;

/**
 * The ONE elimination form for {@link PartnerOriginText}: an `Error` whose own
 * message is `message` -- first-party text, and only first-party text -- and
 * whose `cause` chain holds the partner's values, in order, each labelled and
 * fitted, packed {@link PARTNER_VALUES_PER_LINK} to a link.
 *
 * It returns the `Error` rather than the link text because the guarantee is
 * about where a partner byte can land: a helper returning a string would put
 * the "give it a labelled place of its own" step back on the composition site,
 * which is the convention this type replaces. `Error.message` therefore holds
 * no partner byte on any path this type reaches, and stays a plain `string`,
 * so classification by `instanceof` and equality on the message are unchanged.
 *
 * Each value is bounded on its own, so one value can neither spend another's
 * display budget nor delete the first-party sentence, and a whole link is
 * bounded under the renderer's per-link cap, so the pack that carries a value
 * cannot cost it its budget either.
 *
 * Past {@link MAX_PARTNER_VALUES_SHOWN} the chain ends in one first-party link
 * counting what it does not show. That ceiling is what the renderer's depth
 * bound leaves; sending more values than it admits is the only way a partner
 * can keep any value off the operator's screen, and the count is what makes
 * that visible.
 *
 * An empty list yields the bare first-party `Error`, so a partner that sends
 * `abortReasons: []` reads the same as one that sends none.
 */
export function errorWithPartnerCauseLinks(
  message: string,
  label: string,
  partnerText: PartnerOriginText | PartnerOriginTextList,
): Error {
  const raw = partnerText as unknown as string | readonly string[];
  const values = typeof raw === "string" ? [raw] : raw;
  const fittedLabel = clipToRenderedCost(label, PARTNER_LABEL_BUDGET);
  const links: string[] = [];
  const shown = Math.min(values.length, MAX_PARTNER_VALUES_SHOWN);
  for (let i = 0; i < shown; i += PARTNER_VALUES_PER_LINK) {
    const packed: string[] = [];
    for (let j = i; j < Math.min(i + PARTNER_VALUES_PER_LINK, shown); j++)
      packed.push(labelledValue(fittedLabel, values[j]!));
    links.push(packed.join(PARTNER_VALUE_SEPARATOR));
  }
  if (values.length > shown)
    links.push(elidedValuesLink(values.length - shown));
  let cause: Error | undefined;
  for (let i = links.length - 1; i >= 0; i--)
    cause =
      cause === undefined
        ? new Error(links[i]!)
        : new Error(links[i]!, { cause });
  return cause === undefined
    ? new Error(message)
    : new Error(message, { cause });
}
