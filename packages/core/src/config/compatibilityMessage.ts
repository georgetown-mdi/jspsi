// The one seam through which a linkage-terms value enters an operator-facing
// cross-party compatibility diagnostic (`validateCompatibility`,
// config/linkageTerms.ts).
//
// Those diagnostics are first-party prose with a clause structure an operator
// reads as psilink's own -- "legal agreement reference mismatch: local is X,
// partner is Y" -- and the values they name are chosen by a mutually-distrusting
// partner. Two of them are chosen by the partner even on the side the message
// calls "local": `deriveAcceptedLinkageTerms` adopts the inviter's
// `legalAgreement` and `linkageRuleSet` verbatim into the acceptor's own terms,
// so "local" names provenance in the exchange, not trust in the bytes.
//
// This is a DELIMITING control, orthogonal to the display escape. Escaping is
// assigned to one altitude (CONTRIBUTING.md, Operator-facing escaping): a
// fragment interpolated into an `Error` composes RAW and `sanitizeErrorForDisplay`
// escapes the whole rendered chain once where it is shown. That escape
// neutralizes control characters and confusables; it leaves every printable ASCII
// byte alone, so it does nothing about a value made entirely of printable ASCII
// that reads as psilink's own clause -- a reference of `A", partner is "B` or a
// rule-set name of `hmis-keys 9.9.9 over baseline-pii`. Delimiting is what
// answers that, and it composes with the escape rather than duplicating it: the
// quoting below emits only printable ASCII and rewrites nothing the escape
// rewrites, so a delimited fragment survives the display boundary byte for byte
// and neither pass doubles the other's work.
//
// Beside the delimiting, and for the same reason at a different altitude of the
// message, the seam TREATS the control characters inside a value
// (`replaceControlCharactersForDisplay`). A composition whose own structure is a
// control character -- a block separating its lines with `\n`, escaped whole
// where it is shown -- renders that structure through the same `\xHH` the escape
// gives a value's own line break, which is a boundary the delimiters do not
// distinguish and the escape does not either. Replacing the value's leaves that
// token producible only by the composition. Like the delimiting, it is not a
// second escaping altitude: it emits printable ASCII with no backslash in it, so
// the sink's single pass finds nothing left to rewrite.
//
// The brand is what makes the sweep hold. `validateCompatibility` accumulates
// `CompatibilityMessageFragment`, not `string`, so a raw value interpolated into
// a diagnostic -- an existing message edited, or a new mismatch check added --
// does not compile. The two constructors are total and both safe, so there is no
// "trust me" entry point a later reader has to police.

import { replaceControlCharactersForDisplay } from "../utils/sanitizeForDisplay.js";

declare const compatibilityMessageBrand: unique symbol;

/**
 * A fragment that may stand in a compatibility diagnostic's clause structure:
 * either first-party text the compiler supplied ({@link compatibilityMessage}'s
 * fixed spans) or a terms value that has passed through
 * {@link quoteTermsValue}/{@link bareTermsValue}.
 *
 * Declaring the diagnostic accumulators as this rather than `string` makes
 * dropping a delimiter a compile error instead of a review catch -- a plain
 * `string`, which is what every partner-controlled value is, is not assignable to
 * it. The brand is transparent in the other direction: a fragment IS a `string`,
 * so `CompatibilityResult.errors` stays `string[]` and every consumer reads it
 * unchanged.
 *
 * The brand is a phantom property keyed by a module-private `unique symbol`, so
 * nothing outside this module satisfies it structurally: the constructors here
 * are the only way to obtain one, short of a deliberate
 * `as CompatibilityMessageFragment` assertion. It exists only in the type system
 * -- no value carries the property at runtime.
 *
 * It claims delimiting and control-character treatment, not escaping: the value
 * inside a quoted run is the raw partner value but for its control characters,
 * still carrying whatever confusables and non-ASCII it arrived with, because the
 * single-altitude rule assigns that pass to the display sink. What the brand
 * guarantees is that the value can neither leave its run nor render as a control
 * character the composition around it placed.
 */
export type CompatibilityMessageFragment = string & {
  readonly [compatibilityMessageBrand]: true;
};

/**
 * The delimiter {@link quoteTermsValue} wraps a terms value in, and the character
 * it doubles inside one.
 *
 * A double quote rather than a bracket or an angle pair because the diagnostics
 * already read that way ("local is \"MOU-001\"") and because doubling gives an
 * unambiguous grammar with no escape character: no backslash enters the message,
 * so nothing this module emits is rewritten by the display escape downstream.
 */
export const TERMS_VALUE_DELIMITER = '"';

/**
 * Longest value {@link bareTermsValue} will render undelimited.
 *
 * A bound rather than none so a value that is delimiter-free yet enormous -- a
 * 250-digit semver major, which the terms schema's 256-character name bound
 * admits -- takes the quoted form and is visibly one value, rather than running
 * through the clause as unattributed digits.
 */
export const MAX_BARE_TERMS_VALUE_LENGTH = 64;

/**
 * The CHARSET half of the shape {@link bareTermsValue} renders undelimited:
 * letters, digits, `.`, `_`, and `-`, at least one of them a DIGIT. It bounds no
 * length of its own -- {@link bareTermsValue} checks
 * {@link MAX_BARE_TERMS_VALUE_LENGTH} beside it, so this pattern matches a value
 * of any length.
 *
 * Chosen as the shape that cannot participate in a clause boundary at all. It
 * excludes {@link TERMS_VALUE_DELIMITER}, so such a value cannot close a
 * delimiter, and it excludes `,`, `[`, and `]`, the payload list's own
 * punctuation. It is printable throughout, so a value carrying a control
 * character takes the quoted form and is treated there rather than reaching a
 * composition undelimited and untreated.
 *
 * The digit is what stops it spelling a connective. Excluding the space makes a
 * bare value exactly one whitespace-delimited token, but that alone does not keep
 * it out of a connective position, because the TEMPLATE supplies the spaces
 * around a bare slot: the rule-set clause renders `<name> <version> over <name>
 * <version>`, so a letters-only version would stand in that sentence as
 * undelimited as the `over` beside it. Every value these diagnostics render bare
 * is a semver string or an ISO date, both of which carry a digit, while every
 * connective and label the templates are built from is digit-free -- so requiring
 * a digit leaves the two vocabularies in disjoint shapes, and a bare value cannot
 * be read as first-party structure whatever it says. A value with no digit takes
 * the quoted form instead, which costs the reading nothing.
 *
 * The digit-free half of that argument is executed rather than asserted:
 * `packages/core/test/compatibilityMessage.test.ts` reads the diagnostics'
 * templates out of their own module and fails if any token of first-party copy
 * they are built from meets this shape.
 */
export const BARE_TERMS_VALUE_PATTERN = /^[A-Za-z0-9._-]*[0-9][A-Za-z0-9._-]*$/;

/**
 * Render a terms value as one delimited run: its control characters replaced
 * ({@link replaceControlCharactersForDisplay}), then wrapped in
 * {@link TERMS_VALUE_DELIMITER}, with every delimiter inside it doubled.
 *
 * The doubling is the whole of the grammar -- scanning forward from the opening
 * delimiter, a delimiter followed by another is one literal character and a
 * delimiter followed by anything else closes the run -- so the encoding is
 * injective and no value can terminate its own run early. A value carrying the
 * clause's connective, its separator, or a delimiter of its own therefore reads
 * as content of one value rather than as structure the diagnostic asserted.
 *
 * Every character it emits is printable ASCII, which the display escape passes
 * through unchanged, so the run's boundaries survive to the operator exactly as
 * composed and no byte of the value renders as a control character the
 * composition placed. What can still cut a run is the display boundary's own
 * truncation (`COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH`), which drops the tail of
 * an over-long link: an operator then meets an unterminated run followed by
 * `DISPLAY_TRUNCATION_MARKER`, which reads as cut rather than as a further
 * clause.
 *
 * For DISPLAY only, like every escape beside it. The comparisons these
 * diagnostics report on run against the raw values: a quoted form is neither
 * compared, hashed, nor stored.
 */
export function quoteTermsValue(value: string): CompatibilityMessageFragment {
  const doubled = replaceControlCharactersForDisplay(value).replaceAll(
    TERMS_VALUE_DELIMITER,
    TERMS_VALUE_DELIMITER + TERMS_VALUE_DELIMITER,
  );
  return `${TERMS_VALUE_DELIMITER}${doubled}${TERMS_VALUE_DELIMITER}` as CompatibilityMessageFragment;
}

/**
 * Render a terms value the schema constrains to a delimiter-free shape -- a
 * semver string or an ISO date -- without delimiters, so the common
 * diagnostic reads as prose rather than as a row of quoted tokens.
 *
 * The constraint is RE-CHECKED here rather than assumed
 * ({@link BARE_TERMS_VALUE_PATTERN}), and a value that does not meet it falls
 * back to {@link quoteTermsValue}. That is what keeps this a second safe
 * constructor rather than an escape hatch: `validateCompatibility` takes two
 * `LinkageTerms` objects and nothing in its signature makes them schema-parsed,
 * so the "this field is constrained" premise is executed on the value in hand
 * instead of stated about the schema that usually produced it. Both branches
 * yield a fragment no value can escape from; which one runs decides only how the
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
 * Quoting per element rather than joining and quoting once is what makes the
 * rendered list's element count honest: a single column named `a,b` renders
 * `"a,b"` where two columns named `a` and `b` render `"a","b"`, so the operator
 * reading a payload mismatch sees the same partition the byte-exact,
 * element-wise comparison used to decide it.
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
 * ``compatibilityMessage`version mismatch: local is ${bareTermsValue(v)}` ``. Its
 * result is exactly the string the same template literal would have produced --
 * the tag adds no bytes -- so it is the way to keep the brand across a
 * composition, which plain concatenation and interpolation drop (both yield
 * `string`).
 *
 * What it will accept is what makes it a guarantee rather than a cast: the fixed
 * spans are the call site's own literal text, since only the compiler produces a
 * `TemplateStringsArray`, and every interpolated value is already a fragment. A
 * fragment may itself be a composed message, which is how a diagnostic assembled
 * in two places (a shared suffix over a caller's label) stays inside the brand
 * without a `string` step in between.
 *
 * The bound is the tagged-template call shape, not a proof about every caller: a
 * hand-built `TemplateStringsArray` passed as an ordinary argument bypasses it,
 * as an `as CompatibilityMessageFragment` assertion bypasses the brand itself.
 * Both are deliberate acts a reviewer sees, which is the class of misuse this
 * does not try to stop; the accidental omission is.
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
 * Render one half of a rule-set citation -- a set's name beside that half's
 * content version -- as the pair every surface that shows a citation renders.
 *
 * The grammar, stated here rather than at each of them. The name is one
 * delimited run ({@link quoteTermsValue}): it is free text admitting a space
 * and a delimiter of its own, so an undelimited name reading `hmis-keys 9.9.9`
 * would be indistinguishable from a name plus the version beside it, and a name
 * carrying a delimiter would close a run early and spell a citation of its own.
 * The version takes the checked bare form ({@link bareTermsValue}) and reads as
 * prose, falling back to the delimited run for a value outside that shape or
 * past its length bound -- checked on the value in hand, since a citation
 * reaches these surfaces from a partner's decoded invitation as readily as from
 * a schema parse.
 *
 * Shared rather than composed per surface because the pair is a grammar the
 * sites showing a citation have to agree on: core's rule-set mismatch
 * diagnostic, the CLI acceptance consent surface, the CLI citation-drift
 * warning, and the browser consent screen all render the same partner-chosen
 * values, and the two consent surfaces are read by an operator deciding whether
 * the citation on screen is the one they take it for. Composed independently,
 * one of them can bare a name or drop a delimiter without any other changing.
 *
 * It takes the two values rather than a citation object so a caller that has to
 * treat them first -- escaped for a `log.warn` sink, redacted -- hands over what
 * it treated, leaving this the last pass over what is rendered.
 */
export function ruleSetCitation(
  name: string,
  version: string,
): CompatibilityMessageFragment {
  return compatibilityMessage`${quoteTermsValue(name)} ${bareTermsValue(version)}`;
}
