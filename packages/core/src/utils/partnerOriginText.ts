import { redactPrivateKeyMaterial } from "./sanitizeErrorForDisplay";
import {
  clipToRenderedCost,
  DEFAULT_MAX_DISPLAY_LENGTH,
  renderedDisplayCost,
  replaceControlCharactersForDisplay,
} from "./sanitizeForDisplay";

declare const partnerOriginBrand: unique symbol;

/**
 * One string whose bytes the partner chose, as it leaves a wire-frame decode.
 *
 * The type is deliberately NOT assignable to `string`: `+`, template
 * interpolation and assignment to a `string` field are compile errors, so a
 * partner fragment cannot enter first-party copy at any site, present or
 * future. {@link errorWithPartnerCauseLinks} is the ONE way to get the bytes
 * back out, and it hands them to the operator as a labelled cause link rather
 * than as text inside a message. Adding a second way out removes the
 * guarantee.
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
 * value a link of its own.
 */
export type PartnerOriginTextList = symbol & {
  readonly [partnerOriginBrand]: "many";
};

/**
 * Brand one decoded wire-frame string as partner-chosen. Called at the decode
 * chokepoint (a wire schema's `.transform`), never at a consumer: a value that
 * reaches a consumer unbranded has already lost the guarantee.
 */
export const partnerOriginText = (value: string): PartnerOriginText =>
  value as unknown as PartnerOriginText;

/** {@link partnerOriginText} for a wire field holding several values. */
export const partnerOriginTextList = (
  values: readonly string[],
): PartnerOriginTextList => values as unknown as PartnerOriginTextList;

/**
 * What one labelled link may render to: the per-value display budget every
 * other chooser's fragment is fitted to
 * (`apps/cli/src/connection/causeLink.ts`, and the budgets
 * `test/connection/transportRefusalBudget.test.ts` pins). A link holds its
 * label plus one value and nothing else, so the label's own rendered cost
 * comes out of the same budget.
 *
 * Well under the renderer's per-link cap
 * ({@link COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH}) by design: that cap is a
 * ceiling on a whole link, and the clip here only ever bites a value that is
 * itself the anomaly.
 */
const PARTNER_LINK_VALUE_BUDGET = DEFAULT_MAX_DISPLAY_LENGTH;

/**
 * One labelled link: the label's first-party text, then the partner's value
 * redacted, control-replaced and fitted to what is left of
 * {@link PARTNER_LINK_VALUE_BUDGET}.
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
 */
const labelledLink = (label: string, value: string): string =>
  `${label}${clipToRenderedCost(
    replaceControlCharactersForDisplay(redactPrivateKeyMaterial(value)),
    PARTNER_LINK_VALUE_BUDGET - renderedDisplayCost(label),
  )}`;

/**
 * The ONE elimination form for {@link PartnerOriginText}: an `Error` whose own
 * message is `message` -- first-party text, and only first-party text -- and
 * whose `cause` chain holds one labelled link per partner value, in order.
 *
 * It returns the `Error` rather than the link text because the guarantee is
 * about where a partner byte can land: a helper returning a string would put
 * the "give it a link of its own" step back on the composition site, which is
 * the convention this type replaces. `Error.message` therefore holds no
 * partner byte on any path this type reaches, and stays a plain `string`, so
 * classification by `instanceof` and equality on the message are unchanged.
 *
 * Each value is bounded on its own link, so one value can neither spend
 * another's display budget nor delete the first-party sentence: the renderer
 * caps every link of a cause chain separately
 * ({@link sanitizeErrorForDisplay}). A chain longer than
 * {@link MAX_ERROR_CAUSE_DEPTH} is cut by that renderer, which marks the cut
 * rather than dropping it silently.
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
  let cause: Error | undefined;
  for (let i = values.length - 1; i >= 0; i--) {
    const text = labelledLink(label, values[i]!);
    cause = cause === undefined ? new Error(text) : new Error(text, { cause });
  }
  return cause === undefined
    ? new Error(message)
    : new Error(message, { cause });
}
