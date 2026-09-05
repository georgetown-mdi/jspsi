// The one boundary through which a linkage-terms value enters an
// operator-facing cross-party compatibility diagnostic
// (`validateCompatibility`, linkageTermsNegotiation.ts). Those diagnostics are
// first-party prose an operator reads as psilink's own -- "legal agreement
// reference mismatch: local is X, partner is Y" -- and the values they
// name are partner-chosen, including two on the "local" side that
// `deriveAcceptedLinkageTerms` adopts verbatim from the inviter.
//
// This is a DELIMITING control, orthogonal to the display escape
// (CONTRIBUTING.md, Operator-facing escaping), which neutralizes control
// characters and confusables but leaves printable ASCII alone -- so it does
// nothing about a value that renders as psilink's own clause (a reference of
// `A", partner is "B`). Delimiting answers that: it emits only printable
// ASCII and rewrites nothing the escape rewrites, so a delimited fragment
// survives the display boundary unchanged and neither pass duplicates the
// other's work. This boundary also treats a value's own control characters
// (`replaceControlCharactersForDisplay`), so a value's `\n` cannot be
// confused with a control character the composition placed.
//
// The brand is what makes the sweep hold: `validateCompatibility`
// accumulates `CompatibilityMessageFragment`, not `string`, so a raw value
// interpolated into a diagnostic does not compile. The two constructors are
// total and safe, so there is no "trust me" entry point to police.

import { replaceControlCharactersForDisplay } from "../utils/sanitizeForDisplay.js";

declare const compatibilityMessageBrand: unique symbol;

/**
 * A fragment that may stand in a compatibility diagnostic's clause
 * structure: either first-party text the compiler supplied
 * ({@link compatibilityMessage}'s fixed spans) or a terms value that has
 * passed through {@link quoteTermsValue}/{@link bareTermsValue}.
 *
 * Declaring the diagnostic accumulators as this rather than `string` makes
 * dropping a delimiter a compile error: a plain `string`, which every
 * partner-controlled value is, is not assignable to it. The brand is
 * transparent the other way -- a fragment IS a `string`, so
 * `CompatibilityResult.errors` stays `string[]`.
 *
 * A phantom property keyed by a module-private `unique symbol`: only the
 * constructors here can produce one, short of an `as
 * CompatibilityMessageFragment` assertion; no value carries it at runtime.
 * It claims delimiting and control-character treatment, not escaping -- a
 * quoted run keeps the raw partner value's confusables and non-ASCII,
 * since escaping is the display sink's job; the brand guarantees only that
 * the value cannot leave its run or render as a placed control character.
 */
export type CompatibilityMessageFragment = string & {
  readonly [compatibilityMessageBrand]: true;
};

/**
 * The delimiter {@link quoteTermsValue} wraps a terms value in, and the
 * character it doubles inside one.
 *
 * A double quote rather than a bracket or angle pair: the diagnostics
 * already read that way ("local is \"MOU-001\""), and doubling gives an
 * unambiguous grammar with no escape character, so nothing this module
 * emits is rewritten by the display escape downstream.
 */
export const TERMS_VALUE_DELIMITER = '"';

/**
 * Longest value {@link bareTermsValue} will render undelimited.
 *
 * A bound rather than none: a delimiter-free yet enormous value -- a
 * 250-digit semver major, which the terms schema's 256-character name
 * bound admits -- takes the quoted form and is visibly one value, rather
 * than running through the clause as unattributed digits.
 */
export const MAX_BARE_TERMS_VALUE_LENGTH = 64;

/**
 * The CHARSET half of the shape {@link bareTermsValue} renders undelimited:
 * letters, digits, `.`, `_`, and `-`, at least one of them a DIGIT. No
 * length bound of its own -- {@link bareTermsValue} checks
 * {@link MAX_BARE_TERMS_VALUE_LENGTH} beside it.
 *
 * Chosen as a shape that cannot participate in a clause boundary: it
 * excludes {@link TERMS_VALUE_DELIMITER} (cannot close a delimiter) and
 * `,`, `[`, `]` (the payload list's own punctuation), and is printable
 * throughout, so a value with a control character takes the quoted form.
 *
 * The digit requirement stops a bare value spelling a connective: every
 * value these diagnostics render bare is a semver string or an ISO date
 * (both carry a digit), while every connective and label the templates are
 * built from is digit-free, so a bare value can never be read as
 * first-party structure. `compatibilityMessage.test.ts` executes the
 * digit-free half of that claim by reading the diagnostics' own templates.
 */
export const BARE_TERMS_VALUE_PATTERN = /^[A-Za-z0-9._-]*[0-9][A-Za-z0-9._-]*$/;

/**
 * Render a terms value as one delimited run: its control characters
 * replaced ({@link replaceControlCharactersForDisplay}), then wrapped in
 * {@link TERMS_VALUE_DELIMITER}, with every delimiter inside it doubled.
 *
 * The doubling is the whole grammar: a delimiter followed by another is
 * one literal character, a delimiter followed by anything else closes the
 * run, so the encoding is injective and no value can terminate its own run
 * early. Every character it emits is printable ASCII, so the run's
 * boundaries survive the display escape unchanged. The display boundary's
 * own truncation can still cut a run
 * (`COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH`); an operator then meets an
 * unterminated run followed by `DISPLAY_TRUNCATION_MARKER`, reading as cut
 * rather than a further clause.
 *
 * For DISPLAY only: the comparisons these diagnostics report on run
 * against the raw values, never a quoted form.
 */
export function quoteTermsValue(value: string): CompatibilityMessageFragment {
  const doubled = replaceControlCharactersForDisplay(value).replaceAll(
    TERMS_VALUE_DELIMITER,
    TERMS_VALUE_DELIMITER + TERMS_VALUE_DELIMITER,
  );
  return `${TERMS_VALUE_DELIMITER}${doubled}${TERMS_VALUE_DELIMITER}` as CompatibilityMessageFragment;
}

/**
 * Render a terms value the schema constrains to a delimiter-free shape --
 * a semver string or an ISO date -- without delimiters, so the common
 * diagnostic renders as prose rather than a row of quoted tokens.
 *
 * The constraint is RE-CHECKED here rather than assumed
 * ({@link BARE_TERMS_VALUE_PATTERN}): a value that does not meet it falls
 * back to {@link quoteTermsValue}. That keeps this a second safe
 * constructor rather than an unchecked shortcut, since
 * `validateCompatibility` takes two `LinkageTerms` objects with nothing in
 * its signature guaranteeing they were schema-parsed. Both branches yield
 * a fragment no value can escape; which one runs decides only how the
 * diagnostic reads.
 */
export function bareTermsValue(value: string): CompatibilityMessageFragment {
  if (
    value.length <= MAX_BARE_TERMS_VALUE_LENGTH &&
    BARE_TERMS_VALUE_PATTERN.test(value)
  )
    return value as CompatibilityMessageFragment;
  return quoteTermsValue(value);
}

/**
 * Render a list of terms values -- the payload column names -- as
 * comma-separated delimited runs, each quoted by {@link quoteTermsValue}.
 *
 * Quoting per element, rather than joining then quoting once, keeps the
 * rendered element count accurate: a single column named `a,b` renders
 * `"a,b"` where two columns `a` and `b` render `"a","b"`, matching the
 * byte-exact, element-wise comparison that decided the mismatch.
 */
export function quoteTermsValueList(
  values: readonly string[],
): CompatibilityMessageFragment {
  return values
    .map((value) => quoteTermsValue(value))
    .join(",") as CompatibilityMessageFragment;
}

/**
 * Compose fixed first-party copy with already-delimited values into a
 * {@link CompatibilityMessageFragment}, as a tagged template:
 * ``compatibilityMessage`version mismatch: local is ${bareTermsValue(v)}` ``.
 * The result is exactly what the same template literal would produce, so
 * this is how the brand survives a composition that plain concatenation
 * or interpolation would drop (both yield `string`).
 *
 * The fixed spans are the call site's own literal text, since only the
 * compiler produces a `TemplateStringsArray`, and every interpolated value
 * is already a fragment -- including a fragment that is itself a composed
 * message, so a diagnostic assembled in two places stays inside the brand.
 *
 * The bound is the tagged-template call shape, not a proof about every
 * caller: a hand-built `TemplateStringsArray`, like an `as
 * CompatibilityMessageFragment` assertion, bypasses it -- both are
 * deliberate acts a reviewer sees; the class of misuse this stops is the
 * accidental omission.
 */
export function compatibilityMessage(
  fixedSpans: TemplateStringsArray,
  ...values: readonly CompatibilityMessageFragment[]
): CompatibilityMessageFragment {
  let composed = fixedSpans[0];
  for (let index = 0; index < values.length; index += 1)
    composed += values[index] + fixedSpans[index + 1];
  return composed as CompatibilityMessageFragment;
}

/**
 * Render one half of a rule-set citation -- a set's name beside that
 * half's content version -- as the pair every surface that shows a
 * citation renders.
 *
 * The name is one delimited run ({@link quoteTermsValue}): it is free
 * text admitting a space and a delimiter of its own, so an undelimited
 * name would be indistinguishable from a name plus its version, or could
 * close a run early. The version takes the checked bare form
 * ({@link bareTermsValue}), falling back to the delimited run outside
 * that shape -- checked on the value in hand, since a citation reaches
 * these surfaces from a partner's decoded invitation as readily as from a
 * schema parse.
 *
 * Shared rather than composed per surface: core's rule-set mismatch
 * diagnostic, the CLI acceptance consent surface, the CLI citation-drift
 * warning, and the browser consent screen all render the same
 * partner-chosen values, and the two consent surfaces are read by an
 * operator deciding whether the citation on screen is the one they take
 * it for. Composed independently, one surface could bare a name or drop a
 * delimiter without the others changing.
 *
 * Takes the two values rather than a citation object so a caller that
 * treats them first (escaped for a `log.warn` sink, redacted) hands over
 * what it treated, leaving this the last pass over what is rendered.
 */
export function ruleSetCitation(
  name: string,
  version: string,
): CompatibilityMessageFragment {
  return compatibilityMessage`${quoteTermsValue(name)} ${bareTermsValue(version)}`;
}
