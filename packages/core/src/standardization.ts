import { z } from "zod";
import { getLogger } from "./utils/logger.js";
import {
  chainDetailCauses,
  LinkageTermsUnsatisfiableError,
  OperatorConfigError,
  StandardizationTermsError,
  UnknownStandardizationFunctionError,
  UsageError,
} from "./errors.js";
import { redactAndSanitizeForDisplay } from "./utils/sanitizeErrorForDisplay.js";
import {
  compileLinearRegex,
  coerceToPatternString,
  patternConformsToDialect,
} from "./utils/linearRegex.js";
import type { CompiledLinearRegex } from "./utils/linearRegex.js";
import type {
  Standardization,
  StandardizationStep,
  StandardizationTransformation,
} from "./config/standardization.js";
import type {
  GenerateFuzzyComparisons,
  LinkageField,
  LinkageKey,
  LinkageKeyElement,
  LinkageTerms,
  TransformStep,
} from "./config/linkageTerms.js";
import {
  MAX_DATE_FORMAT_LENGTH,
  MAX_TRANSFORM_PATTERN_LENGTH,
  referencedLinkageFieldNames,
  swapPairFuzzyComparisonsDiffer,
  swapPairTransformsDiffer,
} from "./config/linkageTerms.js";
import { inferMetadata } from "./config/metadata.js";
import type { ColumnMetadata } from "./config/metadata.js";
import { readRowColumn } from "./file.js";
import type { CSVRow } from "./file.js";
import { isCalendarDateValid } from "./utils/calendarDate.js";
import {
  expandFuzzyComparisons,
  expandsOnReceiverOnly,
} from "./fuzzyComparisons.js";
import { APPLIED_SETTINGS } from "./appliedSettings.js";
import {
  DEFAULT_DATE_OUTPUT_FORMAT,
  SOUNDEX_CODE_LENGTH,
} from "./keyElementWidth.js";
import {
  declaredFanOutFunction,
  declaredKeyWidth,
  FAN_OUT_CANDIDATES_PER_ELEMENT,
  FAN_OUT_FUNCTION_NAMES,
  isListedFanOutFunction,
  localFanOutFactor,
  MAX_KEY_CANDIDATE_WIDTH,
} from "./fanOutFunctions.js";

export {
  declaredEffectiveKeyCount,
  declaredKeyWidth,
  FAN_OUT_CANDIDATES_PER_ELEMENT,
  FAN_OUT_FUNCTION_NAMES,
  localFanOutFactor,
} from "./fanOutFunctions.js";
export { DEFAULT_DATE_OUTPUT_FORMAT } from "./keyElementWidth.js";

const logger = getLogger("cleaning");

// --- Value types -------------------------------------------------------------

/**
 * The result type for a single standardization pipeline or step.
 *
 * - `string` -- a single canonical value.
 * - `null` -- no valid value; the record is excluded from any linkage key that
 *   references this field.
 * - `Set<string>` -- multiple candidate values produced by a fan-out step such
 *   as `split_on`. `Set` enforces uniqueness: duplicate values from splitting or
 *   subsequent element-wise steps are automatically deduplicated.
 *   {@link buildKeyStrings} crosses these candidates into the key's candidate
 *   set; matching on that set runs under the single-pass strategy alone, and the
 *   cascade refuses it (see {@link fanOutReachedMatchingRefusal}).
 */
export type FieldValue = string | null | Set<string>;

/**
 * One record's realized value for ONE linkage key -- the per-row element of the
 * surface `linkViaPSI` / `linkViaSinglePassPSI` consume, produced by
 * {@link StandardizedKeyIterable}.
 *
 * - `undefined` -- the record has no value for this key (a `NULL`/absent
 *   realization, or a realization the width bound dropped) and sits the key's
 *   round out. The record-excluded sentinel.
 * - `string` -- the record's single candidate value. A singleton is ALWAYS the
 *   bare string, never a one-element set, so the overwhelming case costs no
 *   allocation and a consumer needs one type test rather than a size test.
 *   `""` is a real, matchable value here (docs/spec/PROTOCOL.md, Key input data).
 * - `ReadonlySet<string>` -- two or more distinct candidate values, each of which
 *   enters the round as its own PSI entry once fan-out matching runs
 *   (docs/spec/PROTOCOL.md, Fan-out matching). Never empty and never a singleton.
 */
export type KeyCandidates = string | ReadonlySet<string> | undefined;

// --- Standardizing functions -------------------------------------------------

type Params = Record<string, unknown>;

// A compiled standardizing function: params are captured at construction time
// via the factory, so per-row calls pay no param-parsing or regex-compilation
// cost.
type StandardizingFn = (value: string) => FieldValue;

// A factory pre-processes params once and returns a StandardizingFn closure.
type StandardizingFnFactory = (params: Params) => StandardizingFn;

function noParamFactory(fn: (s: string) => string): StandardizingFnFactory {
  return (_params) => fn;
}

function removeNonAscii(s: string): string {
  return s.replace(/[^\x00-\x7F]/g, "");
}

function replaceSeparatorsWithSpaces(s: string): string {
  return s.replace(/[-'&\/\\_]/g, " ");
}

function squashSpaces(s: string): string {
  return s.replace(/\s\s+/g, " ");
}

function removePunctuation(s: string): string {
  return s.replace(/[!-/:-@[-`{-~]/g, "");
}

function removeDashes(s: string): string {
  return s.replace(/-/g, "");
}

function trimWhitespace(s: string): string {
  return s.trim();
}

function toUpperCase(s: string): string {
  return s.toUpperCase();
}

function toLowerCase(s: string): string {
  return s.toLowerCase();
}

function removeAccents(s: string): string {
  // Re-normalize to NFC after the NFD strip: a combining mark outside the
  // stripped U+0300-U+036F range (e.g. the Arabic maddah U+0653) survives, so
  // without this the step would leak a decomposed residue into the key. Every
  // pipeline already receives NFC input (see runCompiledPipeline); this keeps
  // the step's output NFC as well.
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .normalize("NFC");
}

const suffixes = [
  "esq",
  "esquire",
  "jr",
  "jnr",
  "sr",
  "snr",
  "2",
  "ii",
  "iii",
  "iv",
  "md",
  "phd",
  "j.d",
  "ll.m",
  "m.d",
  "d.o",
  "d.c",
  "p.c",
  "ph.d",
].map((x) => x.replace(/[.]/g, "\\."));

const suffixPattern = new RegExp(
  `(?<=^|\\s)(${suffixes.join("|")})\\.?(?=$|\\s|[.,!])`,
  "gi",
);

const titles = [
  "dr",
  "miss",
  "mr",
  "mrs",
  "ms",
  "prof",
  "sir",
  "frau",
  "herr",
  "hr",
  "monsieur",
  "captain",
  "doctor",
  "judge",
  "officer",
  "professor",
  "ind",
  "misc",
  "mx",
];

const titlePattern = new RegExp(
  `(?<=^|\\s)(${titles.join("|")})\\.?(?=$|\\s|[.,!])`,
  "gi",
);

function removeAffixes(s: string): string {
  return s
    .replaceAll(suffixPattern, "")
    .replaceAll(titlePattern, "")
    .replaceAll(/\s\s+/g, " ")
    .trim();
}

/**
 * The date-component tokens a `parse_date` format layout is built from. The web
 * consent screen's date-component detection pins this exact set -- adding a
 * token here breaks that consumer's build.
 *
 * `YY` is a prefix of `YYYY`, so tokenizing must go longest-first, not by
 * substring membership. `YY` parses a year only on input; in an OUTPUT format
 * it is not a substitution target and holds no year
 * ({@link dateFormatComponents} separates the two contexts).
 */
type DateFormatToken = "YYYY" | "YY" | "MM" | "DD";

/**
 * The year tokens {@link parseDateFormat} recognizes when parsing an INPUT
 * format, longest first so a greedy tokenizer consumes `YYYY` ahead of its `YY`
 * prefix. Either resolves to a four-digit year through the fixed century pivot
 * ({@link resolveTwoDigitYear}).
 */
const YEAR_FORMAT_TOKENS: readonly DateFormatToken[] = ["YYYY", "YY"];

/**
 * The protocol pivot for resolving a two-digit `YY` year to four digits: `yy <=
 * 68` resolves into the 2000s, otherwise the 1900s, giving the window
 * 1969-2068 (the POSIX two-digit-year convention). A fixed constant, not a
 * clock read: both parties resolve every `YY` against this same number
 * (window edges pinned in standardization.test.ts; full window in
 * PROTOCOL.md).
 */
const TWO_DIGIT_YEAR_PIVOT = 68;

interface ParsedDateFormat {
  /** Anchored regex source compiled to match an input date string. */
  source: string;
  /** Capture-group order, parallel to the regex's groups. */
  order: DateFormatToken[];
}

/**
 * Resolve a two-digit year to a four-digit year against
 * {@link TWO_DIGIT_YEAR_PIVOT}: `68` -> `2068`, `69` -> `1969`, `00` -> `2000`,
 * `99` -> `1999`.
 */
function resolveTwoDigitYear(twoDigit: string): string {
  const value = Number(twoDigit);
  const resolved = value <= TWO_DIGIT_YEAR_PIVOT ? 2000 + value : 1900 + value;
  return String(resolved);
}

// The tokens a format is scanned for, LONGEST FIRST so `YYYY` wins the prefix it
// shares with `YY`; the year pair is taken from YEAR_FORMAT_TOKENS rather than
// re-listed, so the two orderings cannot drift apart.
const DATE_FORMAT_TOKENS_LONGEST_FIRST: readonly DateFormatToken[] = [
  ...YEAR_FORMAT_TOKENS,
  "MM",
  "DD",
];

// The capture group each token contributes to the input-matching regex.
const DATE_TOKEN_CAPTURE_SOURCES: Readonly<Record<DateFormatToken, string>> = {
  YYYY: "(\\d{4})",
  YY: "(\\d{2})",
  MM: "(\\d{1,2})",
  DD: "(\\d{1,2})",
};

/** One run of a tokenized date format: a recognized date token, or one
 * literal character from the format. */
interface DateFormatSegment {
  /** The token this segment is, or undefined for a literal character. */
  token?: DateFormatToken;
  /** The segment exactly as the format writes it. */
  text: string;
}

// The one greedy left-to-right scan every reading of a format goes through, so
// the regex source, the component set, and the output layout below all agree on
// where a token starts and ends rather than each re-scanning the string.
function tokenizeDateFormat(format: string): DateFormatSegment[] {
  const segments: DateFormatSegment[] = [];
  let i = 0;
  while (i < format.length) {
    const token = DATE_FORMAT_TOKENS_LONGEST_FIRST.find((candidate) =>
      format.startsWith(candidate, i),
    );
    if (token === undefined) {
      segments.push({ text: format[i] });
      i += 1;
    } else {
      segments.push({ token, text: token });
      i += token.length;
    }
  }
  return segments;
}

// Build the anchored regex source and capture order for a parse_date input
// format. The format is partner-controlled; its MM/DD tokens expand into
// adjacent `(\d{1,2})` groups, which catastrophically backtrack on the
// JavaScript engine. parseDateFactory compiles this source under the
// linear-time engine (compileLinearRegex), not `new RegExp`
// (linearRegex.test.ts covers the adjacent-group expansion).
function parseDateFormat(inputFormat: string): ParsedDateFormat {
  const order: DateFormatToken[] = [];
  let regexStr = "";

  for (const segment of tokenizeDateFormat(inputFormat)) {
    if (segment.token === undefined) {
      // Escape literal separator characters for use in a regex.
      regexStr += segment.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else {
      order.push(segment.token);
      regexStr += DATE_TOKEN_CAPTURE_SOURCES[segment.token];
    }
  }

  return { source: `^${regexStr}$`, order };
}

/**
 * The date COMPONENTS a `parse_date` format layout holds. `YY` differs by
 * context: on `"input"` it parses a year and collapses to `"YYYY"`
 * ({@link YEAR_FORMAT_TOKENS}); on `"output"` it is not a substitution target,
 * so it emits literally and holds no year. `MM` and `DD` map to themselves
 * in both contexts. Tokenized via {@link parseDateFormat}'s own greedy scan,
 * not a substring check, since `YY` is a prefix of `YYYY`.
 */
export function dateFormatComponents(
  format: string,
  context: "input" | "output",
): Set<DateFormatToken> {
  const components = new Set<DateFormatToken>();
  for (const token of parseDateFormat(format).order) {
    if (token === "YY") {
      // A YY input token parses a year; a YY output token is an unsubstituted
      // literal that holds no year and so contributes no component.
      if (context === "input") components.add("YYYY");
    } else {
      components.add(token);
    }
  }
  return components;
}

// The characters a `parse_date` step emits for one date: the output format with
// EVERY occurrence of each substituted token replaced by its (padded) component
// value, in the fixed order all YYYY, then all MM, then all DD
// (docs/spec/PROTOCOL.md). The factory renders through this, and so does the
// terms-level collapse verdict below, which renders probe dates to measure what a
// later step reads out of them -- so a layout the verdict measures is the one the
// runtime actually emits.
function renderDateOutput(
  outputFormat: string,
  year: string,
  month: string,
  day: string,
): string {
  return outputFormat
    .replaceAll("YYYY", year)
    .replaceAll("MM", month)
    .replaceAll("DD", day);
}

// Parse `input_format` -> YAML camelizes keys but not values, so format
// string tokens YYYY / YY / MM / DD stay as written; delimiter characters are
// literal. Params arrive as camelCase after camelizeKeys (e.g. inputFormat).
function parseDateFactory(params: Params): StandardizingFn {
  // The wire params are z.unknown(), so a partner can declare either format as
  // a non-string. An absent input format falls back to the default; a present
  // non-string is a dead key by design, realized as an empty format that
  // tokenizes to an all-dropping pattern (a raw non-string would instead throw
  // in parseDateFormat). Guard the output format by type too: a non-string
  // reaches `.replaceAll` and throws, so it falls back to the absent default.
  const rawInputFormat = params.inputFormat;
  const inputFormat =
    rawInputFormat == null
      ? "MM/DD/YYYY"
      : typeof rawInputFormat === "string"
        ? rawInputFormat
        : "";
  const outputFormat =
    typeof params.outputFormat === "string"
      ? params.outputFormat
      : DEFAULT_DATE_OUTPUT_FORMAT;

  const { source, order } = parseDateFormat(inputFormat);
  // Compile the anchored source under the linear-time engine, not `new RegExp`:
  // the MM/DD tokens expand into adjacent `(\d{1,2})` groups that backtrack
  // catastrophically on the JavaScript engine, so a partner-controlled format
  // would otherwise hang the per-row loop; linearRegex.test.ts drives that
  // expansion through compileLinearRegex.
  const re = compileLinearRegex(source);

  return (s) => {
    // Normalize before matching (see the STANDARDIZING_FUNCTIONS contract). Date
    // separators are ASCII in practice, so this is a no-op on real input, but it
    // keeps parse_date inside the same authored-pattern-matching family as the
    // other regex steps rather than a silent exception.
    const groups = re.matchGroups(s.normalize("NFC"));
    if (groups === null) return null;

    let year: string | undefined;
    let month: string | undefined;
    let day: string | undefined;
    order.forEach((token, idx) => {
      // The source anchors every token group, so a successful whole-string match
      // populates each; guard the null only to satisfy the type and to leave the
      // component unset (caught by the presence check below) if it ever did not
      // participate.
      const value = groups[idx + 1];
      if (value === null) return;
      if (token === "YYYY") year = value;
      else if (token === "YY") year = resolveTwoDigitYear(value);
      else if (token === "MM") month = value.padStart(2, "0");
      else if (token === "DD") day = value.padStart(2, "0");
    });

    // Either year token satisfies the year component.
    if (!year || !month || !day) return null;

    if (!isCalendarDateValid(year, month, day)) return null;

    return renderDateOutput(outputFormat, year, month, day);
  };
}

function substringFactory(params: Params): StandardizingFn {
  // substringWindow holds the whole convention -- bounds coercion, SQL SUBSTR
  // indexing, and the clamps -- and needs the length of the value being sliced
  // to fix either bound, so the window is resolved per value rather than
  // hoisted out of the returned fn. A window that reads nothing is the drop
  // this step takes for a degenerate bound.
  return (s) => {
    const window = substringWindow(params, s.length);
    if (window === undefined) return null;
    return s.slice(window.start, window.end);
  };
}

const SOUNDEX: Record<string, string> = {
  B: "1",
  F: "1",
  P: "1",
  V: "1",
  C: "2",
  G: "2",
  J: "2",
  K: "2",
  Q: "2",
  S: "2",
  X: "2",
  Z: "2",
  D: "3",
  T: "3",
  L: "4",
  M: "5",
  N: "5",
  R: "6",
};

function soundex(s: string): string {
  const upper = s.toUpperCase().replace(/[^A-Z]/g, "");
  if (!upper) return "0000";
  const first = upper[0];
  let result = first;
  let prev = SOUNDEX[first] ?? "0";
  for (
    let idx = 1;
    idx < upper.length && result.length < SOUNDEX_CODE_LENGTH;
    idx++
  ) {
    const c = upper[idx];
    if (c === "H" || c === "W") continue;
    const code = SOUNDEX[c] ?? "0";
    if (code !== "0" && code !== prev) result += code;
    prev = code;
  }
  return result.padEnd(SOUNDEX_CODE_LENGTH, "0");
}

function phoneticFactory(params: Params): StandardizingFn {
  const algorithm = (params.algorithm as string | undefined) ?? "soundex";
  if (algorithm === "soundex") {
    return (s) => {
      const result = soundex(s);
      return result !== "0000" ? result : null;
    };
  }
  throw new Error(`unsupported phonetic algorithm: "${algorithm}"`);
}

function padLeftFactory(params: Params): StandardizingFn {
  const length = params.length as number | undefined;
  if (typeof length !== "number" || !Number.isInteger(length) || length <= 0)
    throw new Error(`pad_left: "length" must be a positive integer`);
  // Normalize before validating the length, not after: NFC can change the
  // code-unit count (a combining mark like U+0344 -> U+0308 U+0301 expands to
  // two), and padStart treats a multi-unit fill as a cycling pattern, so the
  // one-character contract must hold on the normalized value. Guard `char` by
  // type: the wire params are z.unknown(), and a non-string would throw on
  // `.normalize`; it falls back to the "0" default instead.
  const char = (typeof params.char === "string" ? params.char : "0").normalize(
    "NFC",
  );
  if (char.length !== 1)
    throw new Error(`pad_left: "char" must be exactly one character`);
  return (s) => s.padStart(length, char);
}

function nullIfFactory(params: Params): StandardizingFn {
  // Build the exclusion set from string entries only. The wire params are
  // z.unknown() and typed by no per-function shape, so a partner can declare
  // `values` as a non-array or with non-string elements, or `value` as a
  // non-string scalar; normalizing any of those below would throw. A non-string
  // can never equal a string cell, so a non-array `values` and any non-string
  // entry contribute no exclusion rather than crashing.
  const rawValues =
    params.values !== undefined
      ? Array.isArray(params.values)
        ? params.values
        : []
      : params.value !== undefined
        ? [params.value]
        : [];
  const values = rawValues.filter((v): v is string => typeof v === "string");
  // NFC-normalize the exclusion values so one authored in a different form
  // (e.g. NFD from a YAML file written on macOS) still matches the runtime
  // value.
  const set = new Set(values.map((v) => v.normalize("NFC")));
  // NFC-normalize the value before comparing (see the STANDARDIZING_FUNCTIONS
  // contract): an upstream case-fold can leave non-NFC bytes against which an
  // authored-NFC exclusion would otherwise silently miss. Return the original
  // value on a non-match so emitted bytes for already-canonical inputs are
  // untouched.
  return (s) => (set.has(s.normalize("NFC")) ? null : s);
}

function replaceRegexFactory(params: Params): StandardizingFn {
  const pattern = coerceToPatternString(params.pattern);
  // NFC-normalize the replacement literal so it cannot inject a non-NFC byte
  // sequence into the key (the pattern itself is matched as authored; author
  // it in NFC to match NFC runtime values). Guard by type: the wire params
  // are z.unknown(), and a non-string `replacement` would throw on
  // `.normalize`; it falls back to the empty replacement instead.
  const replacement =
    typeof params.replacement === "string"
      ? params.replacement.normalize("NFC")
      : "";
  const re = compileLinearRegex(pattern);
  // Normalize before matching (see the STANDARDIZING_FUNCTIONS contract) so an
  // authored-NFC pattern matches a value left non-NFC by an upstream case-fold;
  // the result is derived from the normalized value, byte-identical for
  // already-canonical inputs. replaceAll is global, like the old `g` flag.
  return (s) => re.replaceAll(s.normalize("NFC"), replacement);
}

function extractRegexFactory(params: Params): StandardizingFn {
  const pattern = coerceToPatternString(params.pattern);
  const re = compileLinearRegex(pattern);
  // Match AND slice on the NFC-normalized value (see the STANDARDIZING_FUNCTIONS
  // contract): an authored-NFC pattern must match a value left non-NFC by an
  // upstream case-fold, and the returned capture must come from the same
  // normalized string -- NFC can change the code-unit count, so a capture taken
  // from the original could misalign. extractFirst returns capture substrings of
  // the string it ran against, so slicing follows the normalized value for free.
  return (s) => re.extractFirst(s.normalize("NFC"));
}

function filterRegexFactory(params: Params): StandardizingFn {
  const pattern = coerceToPatternString(params.pattern);
  const re = compileLinearRegex(pattern);
  // NFC-normalize before testing (see the STANDARDIZING_FUNCTIONS contract) so
  // an authored-NFC pattern matches a value left non-NFC by an upstream
  // case-fold; return the original value on a match so emitted bytes for
  // already-canonical inputs are untouched.
  return (s) => (re.test(s.normalize("NFC")) ? s : null);
}

function splitOnFactory(params: Params): StandardizingFn {
  const delimiter = coerceToPatternString(params.delimiter);
  const includeOriginal =
    (params.includeOriginal as boolean | undefined) ?? false;
  const re = compileLinearRegex(delimiter);
  return (s) => {
    // Normalize before splitting (see the STANDARDIZING_FUNCTIONS contract) so
    // an authored-NFC delimiter matches a value left non-NFC by an upstream
    // case-fold. Parts (and the unsplit value) come from the normalized form,
    // like extract_regex, since the split offsets are computed on it; this is a
    // no-op for already-canonical inputs.
    const n = s.normalize("NFC");
    const parts = re.split(n).filter((p) => p.length > 0);
    if (parts.length <= 1) return new Set([n]);
    return includeOriginal ? new Set([n, ...parts]) : new Set(parts);
  };
}

// Each entry here needs a matching descriptor in
// STANDARDIZATION_FUNCTION_DESCRIPTORS (its drift test fails CI without one)
// and an entry in docs/EXCHANGE_REFERENCE.md, "Available functions" (no test
// enforces that).
//
// NFC-comparison contract: a step that matches an authored value, pattern, or
// delimiter against the intermediate value must NFC-normalize that value
// first -- an upstream step can emit non-NFC bytes even from NFC input, and
// buildKeyStrings normalizes only the EMITTED key, after these mid-pipeline
// reads. The family today is null_if, filter_regex, extract_regex,
// replace_regex, split_on, and parse_date, by this property rather than the
// list. A pass-through step (null_if, filter_regex) returns the ORIGINAL
// value; a deriving step (extract_regex, replace_regex, split_on,
// parse_date) derives from the normalized value.
const STANDARDIZING_FUNCTIONS: Record<string, StandardizingFnFactory> = {
  remove_non_ascii: noParamFactory(removeNonAscii),
  replace_separators_with_spaces: noParamFactory(replaceSeparatorsWithSpaces),
  squash_spaces: noParamFactory(squashSpaces),
  remove_punctuation: noParamFactory(removePunctuation),
  remove_dashes: noParamFactory(removeDashes),
  trim_whitespace: noParamFactory(trimWhitespace),
  to_upper_case: noParamFactory(toUpperCase),
  to_lower_case: noParamFactory(toLowerCase),
  remove_accents: noParamFactory(removeAccents),
  remove_affixes: noParamFactory(removeAffixes),
  substring: substringFactory,
  parse_date: parseDateFactory,
  pad_left: padLeftFactory,
  phonetic: phoneticFactory,
  null_if: nullIfFactory,
  replace_regex: replaceRegexFactory,
  extract_regex: extractRegexFactory,
  filter_regex: filterRegexFactory,
  split_on: splitOnFactory,
};

// The functions above whose compiled step can return SEVERAL candidates for
// ONE input value -- CAPABILITY, separate from FAN_OUT_FUNCTION_NAMES's
// POLICY question of whether an expansion is a declared fan-out. Capability
// must stay a property of the function, not the listing: the lever that
// stands `split_on` in for an unlisted producer moves only the listing, and
// the step it compiles still expands.
//
// Hand-listed because whether a factory can return a multi-value `Set` is not
// derivable from the registry. {@link accumulationFateAtCharge}'s runtime
// safety check catches a factory added here without an entry only where the
// expansion lands before the row's crossing; one landing after a crossing
// already resolved to a drop is invisible to it.
const MULTI_VALUE_FUNCTION_NAMES: ReadonlySet<string> = new Set(["split_on"]);

/**
 * @internal exported so the drift test can hold this classification to
 * {@link FAN_OUT_FUNCTION_NAMES}: a declared fan-out producer that cannot expand
 * a value classifies a key as producing no multiplicity, which costs the drop
 * that producer's width bound specifies.
 */
export function canProduceMultipleValues(functionName: string): boolean {
  return MULTI_VALUE_FUNCTION_NAMES.has(functionName);
}

/**
 * The names of every standardization function the library recognizes,
 * including `coalesce`, which {@link compileStep} handles specially, outside
 * {@link STANDARDIZING_FUNCTIONS}. The single source of truth for "which
 * function names core knows": {@link validateStandardizationAgainstTerms}
 * checks against it, and the web consent screen's plain-language glossary
 * asserts it covers every name here.
 */
export const STANDARDIZATION_FUNCTION_NAMES: readonly string[] = [
  ...Object.keys(STANDARDIZING_FUNCTIONS),
  "coalesce",
];

const quotedFanOutFunctionNames = FAN_OUT_FUNCTION_NAMES.map(
  (name) => `"${name}"`,
).join(", ");

// The recovery the DECLARED-step refusal closes on: the strategy that matches a
// candidate set, or no candidate set at all. Named separately because the
// refusal's two surfaces share it while differing in error class.
const FAN_OUT_STRATEGY_RECOVERY =
  "Agree linkage terms whose linkage_strategy is single-pass, or remove the " +
  `${quotedFanOutFunctionNames} step from the standardization and from every ` +
  "linkage-key element transform.";

// The message both DECLARED-step refusals hold, raised before the exchange
// runs. `functionName` is matched against FAN_OUT_FUNCTION_NAMES before it
// reaches here, so the message is a fixed literal, never partner free text;
// the strategy the terms actually name is not interpolated, since nothing
// narrows it to a schema literal at this boundary. The two refusals share the
// wording and differ only in error class, by whose content the fault is (see
// assertFanOutImplemented).
function fanOutDeclaredMessage(functionName: string): string {
  return (
    "fan-out matching runs under the single-pass linkage strategy only, but " +
    "these linkage terms name another and these transforms declare a " +
    `"${functionName}" step: it expands one value into several match ` +
    "candidates, while every other strategy matches a single value per record. " +
    "A record whose value actually splits would abort the run the moment it " +
    "reached a matching round rather than match one key per candidate, so the " +
    `exchange is refused up front instead. ${FAN_OUT_STRATEGY_RECOVERY}`
  );
}

/**
 * Refusal for a candidate set that reached a call site running one value per
 * record -- the point of harm, since the alternative is silent narrowing.
 * Key realization holds every candidate ({@link buildKeyStrings}); the call
 * sites that cannot honor them are `linkViaPSI`, `linkViaCountOnlyPSI` (fan-out
 * matching runs under single-pass alone), and the single-pass table build
 * for a party that declared no fan-out (a fixed-width column holds one
 * value per key, record). A party that DID declare one builds a ragged
 * table instead and refuses in `link.ts`'s own width checks, a different
 * refusal on the same fault: an expansion the declared factors do not
 * account for.
 *
 * Unreachable while {@link assertFanOutImplemented} gates every run path
 * off single-pass. Encoded as a check, not a comment, since it also covers
 * a fan-out function missing from {@link FAN_OUT_FUNCTION_NAMES}, and a
 * standardization-authored path a prepared exchange assembled outside
 * `prepareForExchange` hides from that gate.
 */
export function fanOutReachedMatchingRefusal(): UsageError {
  return new UsageError(
    "a transform expanded a record into several match candidates, but this " +
      "round matches a single value per record: fan-out matching runs under " +
      "the single-pass linkage strategy, and there only for a party whose " +
      "declared linkage terms and standardization account for the expansion. " +
      "Continuing would drop the record from its linkage key rather than " +
      "match it on each candidate, so the exchange is refused instead. Remove " +
      "the step that expands this record's value -- a " +
      `${quotedFanOutFunctionNames} step under another strategy, a fuzzy ` +
      "comparison, or a transform that expands one value without being a " +
      "declared fan-out function.",
  );
}

// --- Function descriptors ----------------------------------------------------

/**
 * The authoring-risk tier of a standardization function.
 *
 * - `standard` -- every function whose params are plain typed values.
 * - `regex` -- the raw-pattern family (`replace_regex`, `extract_regex`,
 *   `filter_regex`, `split_on`), whose param is an operator-authored regular
 *   expression. These patterns run under the linear-time engine (see
 *   utils/linearRegex.ts), so an unbounded pattern cannot hang on
 *   adversarial input; the tier instead marks raw-pattern inputs an editor should
 *   validate against the dialect ({@link patternConformsToDialect}, the same
 *   check {@link regexPatternSchema} applies) and present with extra care, since a
 *   pattern still shapes which records match.
 */
type StandardizationFunctionTier = "standard" | "regex";

/**
 * A single standardization function's editor-facing descriptor: enough for a web
 * step editor to render a typed, plain-language input for it without re-encoding
 * the function's parameter shape, label, or risk tier.
 *
 * The descriptor table {@link STANDARDIZATION_FUNCTION_DESCRIPTORS} is the single
 * source of truth both expert editors (the linkage-terms transform editor and the
 * metadata/standardization editor) drive their parameterized step UIs from, kept
 * in lockstep with {@link STANDARDIZATION_FUNCTION_NAMES} -- and so with the
 * {@link STANDARDIZING_FUNCTIONS} registry it derives from -- by a parity test in
 * both directions.
 */
export interface StandardizationFunctionDescriptor {
  /** The snake_case function name core dispatches on; equals the table key. */
  name: string;
  /** Human-readable label for an editor control (e.g. "Pad left"). */
  label: string;
  /** One-line plain-language description of what the function does. */
  blurb: string;
  /** The authoring-risk tier; see {@link StandardizationFunctionTier}. */
  tier: StandardizationFunctionTier;
  /**
   * Typed Zod schema for the function's `params` object, so an editor can drive
   * form fields off `params.shape` and validate authored params.
   *
   * KEYS are camelCase, matching the runtime params each factory reads AFTER
   * {@link camelizeKeys} (e.g. `inputFormat`, `includeOriginal`), not the
   * snake_case an operator writes in YAML. A defaulted param's default is set
   * via Zod `.default(...)`, so a parse of omitted params yields the same value
   * the factory falls back to. These schemas describe well-formed editor output
   * (a value, or an omitted default); they are NOT the partner-supplied wire
   * params, which stay `z.unknown()`, count-bounded and string-length-bounded
   * in `config/linkageTerms.ts`. The drift test pins each schema against its
   * factory so a descriptor cannot disagree with the function it describes.
   *
   * Typed `ZodObject<ZodRawShape>` rather than a per-function shape because the
   * table is homogeneous (a `Record` over one descriptor type). An editor drives
   * form fields by iterating `params.shape` at RUNTIME, where each entry is its
   * concrete Zod type (`ZodNumber`, `ZodEnum`, ...); the interface widens the
   * static shape to `ZodRawShape`, so a consumer that wants a param's static type
   * narrows the concrete schema, not this field.
   */
  params: z.ZodObject<z.ZodRawShape>;
}

/** Functions that take no params: their `params` schema accepts an empty object. */
const noParams = z.object({});

/**
 * A user-authored regular-expression param. Required, bounded in length, and
 * validated to compile under the linear-time dialect ({@link patternConformsToDialect})
 * -- the same engine the regex factories run, so the editor accepts the patterns an
 * exchange will execute and rejects what RE2 drops (backreferences, lookaround).
 * Under a non-backtracking engine there is no danger tier to gate, only the
 * dialect to conform to. See docs/spec/PROTOCOL.md.
 *
 * The length cap matches {@link MAX_TRANSFORM_PATTERN_LENGTH} (the same bound the
 * linkage-terms validation gate applies to wire patterns). The dialect refine below
 * re-checks the length and skips the compile when it is exceeded: Zod's string checks
 * do not abort, so a bare `.max` would still let `.refine` compile an oversized
 * source, and an in-dialect pattern compiles in time super-linear in its length --
 * which a live editor preview must never incur on the main thread for a
 * pathological-length paste. Stricter than the factory (which compiles any
 * length), by design, like substring's hazard rejections; the descriptor drift
 * test pins only short patterns, so this divergence does not break it.
 */
const regexPatternSchema = z
  .string()
  .min(1)
  .max(MAX_TRANSFORM_PATTERN_LENGTH, {
    message: `must not exceed ${MAX_TRANSFORM_PATTERN_LENGTH} characters`,
  })
  .refine(
    // Skip the compile for an over-length source: the `.max` above does not abort
    // (Zod string checks are non-aborting), so without this length re-check `.refine`
    // would compile an oversized pattern -- and RE2 compile is super-linear in length,
    // which a live editor preview must never pay on the main thread. The `.max` already
    // reports the length error; this guard only spares the compile.
    (pattern) =>
      pattern.length <= MAX_TRANSFORM_PATTERN_LENGTH &&
      patternConformsToDialect(pattern),
    {
      message:
        "must be a valid regular expression in the linear-time dialect " +
        "(RE2 syntax; backreferences and lookaround are not supported)",
    },
  );

/**
 * Editor-facing descriptor for every standardization function the library
 * recognizes -- every member of {@link STANDARDIZING_FUNCTIONS} plus `coalesce`.
 * Co-located with the registry so a new function is added beside its descriptor;
 * the parity test enforces that neither can ship without the other.
 *
 * Param schemas are pinned to their factory behavior by the drift test: each
 * accepts the well-formed param shapes its factory accepts and rejects malformed
 * ones (e.g. `pad_left` rejects a non-positive `length` and a multi-character
 * `char`, exactly as its factory throws).
 */
export const STANDARDIZATION_FUNCTION_DESCRIPTORS: Record<
  string,
  StandardizationFunctionDescriptor
> = {
  remove_non_ascii: {
    name: "remove_non_ascii",
    label: "Remove non-ASCII",
    blurb:
      "Drop every character outside the ASCII set (accented letters, emoji, symbols).",
    tier: "standard",
    params: noParams,
  },
  replace_separators_with_spaces: {
    name: "replace_separators_with_spaces",
    label: "Replace separators with spaces",
    blurb:
      "Turn hyphens, apostrophes, ampersands, slashes, and underscores into spaces.",
    tier: "standard",
    params: noParams,
  },
  squash_spaces: {
    name: "squash_spaces",
    label: "Squash spaces",
    blurb: "Collapse runs of whitespace into a single space.",
    tier: "standard",
    params: noParams,
  },
  remove_punctuation: {
    name: "remove_punctuation",
    label: "Remove punctuation",
    blurb:
      "Remove ASCII punctuation and symbols, keeping letters, digits, and spaces.",
    tier: "standard",
    params: noParams,
  },
  remove_dashes: {
    name: "remove_dashes",
    label: "Remove dashes",
    blurb: "Remove hyphens from the value.",
    tier: "standard",
    params: noParams,
  },
  trim_whitespace: {
    name: "trim_whitespace",
    label: "Trim whitespace",
    blurb: "Remove leading and trailing whitespace.",
    tier: "standard",
    params: noParams,
  },
  to_upper_case: {
    name: "to_upper_case",
    label: "Uppercase",
    blurb:
      "Convert the value to uppercase so values differing only in case can match.",
    tier: "standard",
    params: noParams,
  },
  to_lower_case: {
    name: "to_lower_case",
    label: "Lowercase",
    blurb:
      "Convert the value to lowercase so values differing only in case can match.",
    tier: "standard",
    params: noParams,
  },
  remove_accents: {
    name: "remove_accents",
    label: "Remove accents",
    blurb: "Strip accents and diacritics, keeping the base letters.",
    tier: "standard",
    params: noParams,
  },
  remove_affixes: {
    name: "remove_affixes",
    label: "Remove affixes",
    blurb: "Remove name titles (Mr., Dr.) and suffixes (Jr., III).",
    tier: "standard",
    params: noParams,
  },
  substring: {
    name: "substring",
    label: "Substring",
    blurb: "Keep a fixed slice of the value by start position and length.",
    tier: "standard",
    // The factory drops a non-integer or 0 bound to an always-null fn, but leaves
    // a negative length (which slices to empty) alone -- so the schema is
    // stricter here, by design, rejecting hazard shapes (a fractional position,
    // a non-positive length, a 0 start) at parse time with a message rather than
    // silently dropping every row. 0 is rejected because the factory treats it as
    // an always-null no-op; positions are 1-indexed, with a negative start
    // counting from the end.
    params: z.object({
      start: z
        .number()
        .int()
        .refine((n) => n !== 0, {
          message: "start must not be 0 (positions are 1-indexed)",
        }),
      length: z.number().int().positive(),
    }),
  },
  parse_date: {
    name: "parse_date",
    label: "Parse date",
    blurb:
      "Reformat a date between token layouts (YYYY, YY, MM, DD) so different formats can match.",
    tier: "standard",
    // Format strings are bounded to non-empty and to MAX_DATE_FORMAT_LENGTH (the
    // same bound the linkage-terms gate applies to wire formats), but NOT to their
    // token content: a tokenless format is accepted, mirroring the factory, which
    // builds a regex from any string and simply matches little (yielding null)
    // rather than throwing. Requiring a YYYY/MM/DD token would reject a shape the
    // factory accepts; flagging a tokenless format is editor guidance, not
    // validation. The length cap IS enforced here (stricter than the factory,
    // by design, like regexPatternSchema): the factory expands the format into
    // a regex compiled under the linear-time engine, so an over-length format
    // pays a super-linear compile that a live editor preview must not incur on
    // the main thread -- the same vector regexPatternSchema bounds, through a
    // sibling param.
    params: z.object({
      inputFormat: z
        .string()
        .min(1)
        .max(MAX_DATE_FORMAT_LENGTH, {
          message: `must not exceed ${MAX_DATE_FORMAT_LENGTH} characters`,
        })
        .default("MM/DD/YYYY"),
      outputFormat: z
        .string()
        .min(1)
        .max(MAX_DATE_FORMAT_LENGTH, {
          message: `must not exceed ${MAX_DATE_FORMAT_LENGTH} characters`,
        })
        .default("YYYYMMDD"),
    }),
  },
  pad_left: {
    name: "pad_left",
    label: "Pad left",
    blurb: "Left-pad the value with a fill character up to a target length.",
    tier: "standard",
    params: z.object({
      length: z.number().int().positive(),
      // Exactly one character after NFC normalization, mirroring the factory's
      // own check (a multi-unit fill corrupts padStart's cycling).
      char: z
        .string()
        .refine((c) => c.normalize("NFC").length === 1, {
          message: "char must be exactly one character",
        })
        .default("0"),
    }),
  },
  phonetic: {
    name: "phonetic",
    label: "Phonetic encoding",
    blurb:
      "Replace the value with a sound-alike phonetic code so names that sound alike can match; drops a value with no letters.",
    tier: "standard",
    // Only soundex is implemented; the factory throws on any other algorithm, so
    // the schema admits only what the factory accepts.
    params: z.object({
      algorithm: z.enum(["soundex"]).default("soundex"),
    }),
  },
  null_if: {
    name: "null_if",
    label: "Null if",
    blurb: "Drop the value when it matches one of the listed values.",
    tier: "standard",
    // Either a single `value` or a list of `values`; the factory reads `values`
    // first and falls back to `value`, treating neither as an empty exclusion
    // list, so both are optional.
    params: z.object({
      value: z.string().optional(),
      values: z.array(z.string()).optional(),
    }),
  },
  replace_regex: {
    name: "replace_regex",
    label: "Replace (regex)",
    blurb: "Replace every regular-expression match with a replacement string.",
    tier: "regex",
    params: z.object({
      pattern: regexPatternSchema,
      replacement: z.string().default(""),
    }),
  },
  extract_regex: {
    name: "extract_regex",
    label: "Extract (regex)",
    blurb:
      "Keep the first regular-expression capture group, or the whole match if the pattern has none; drop the value on no match or an empty result.",
    tier: "regex",
    params: z.object({
      pattern: regexPatternSchema,
    }),
  },
  filter_regex: {
    name: "filter_regex",
    label: "Filter (regex)",
    blurb: "Drop the value unless it matches the regular expression.",
    tier: "regex",
    params: z.object({
      pattern: regexPatternSchema,
    }),
  },
  split_on: {
    name: "split_on",
    label: "Split on",
    blurb:
      "Split the value on a regular-expression delimiter into several match candidates.",
    tier: "regex",
    params: z.object({
      delimiter: regexPatternSchema,
      includeOriginal: z.boolean().default(false),
    }),
  },
  coalesce: {
    name: "coalesce",
    label: "Coalesce",
    blurb:
      "Substitute a fallback value where an earlier rule left the value empty, which can create matches that would not otherwise occur.",
    tier: "standard",
    params: z.object({
      default: z.string().optional(),
    }),
  },
};

// --- Runtime-coercion contract -----------------------------------------------

/**
 * Per-function table of parameters a standardization function replaces with a
 * fixed fallback when the declared value is nullish, keyed by the camelCase
 * param name (params arrive camelCased). Each factory reads its param as
 * `(params.x ?? <fallback>)`, so a declared `null` runs as <fallback> -- the
 * headline case being `replace_regex` `replacement: null`, which executes as the
 * empty string. These are the only param coercions that make a declared term
 * differ from the executed one in a way worth surfacing; NFC normalization of a
 * present value is excluded, as it does not change the human-readable value, and
 * a function or param absent here applies its declared value as written.
 *
 * Hand-listed but pinned to the real factory behavior by a test (a declared-null
 * run must equal a declared-fallback run), and kept beside
 * {@link STANDARDIZING_FUNCTIONS} so the two are edited together. The one drift
 * this table cannot catch structurally -- a newly added function that coerces a
 * param yet gets no entry here -- closes when a function's param resolution is
 * shared with this table directly rather than duplicated.
 */
const TRANSFORM_PARAM_FALLBACKS: Record<string, Record<string, unknown>> = {
  replace_regex: { replacement: "" },
  parse_date: { inputFormat: "MM/DD/YYYY", outputFormat: "YYYYMMDD" },
  pad_left: { char: "0" },
  phonetic: { algorithm: "soundex" },
  split_on: { includeOriginal: false },
};

/**
 * One parameter whose declared value a transform function replaces at match
 * time, paired with the value it actually uses.
 */
interface TransformParamCoercion {
  /** The camelCase parameter name. */
  param: string;
  /** The value the function applies in place of the declared (nullish) one. */
  executed: unknown;
}

/**
 * The parameters of `step` whose DECLARED value the function coerces before
 * applying it -- today, the params a function defaults when they are declared
 * `null` (e.g. `replace_regex` `replacement: null` runs as the empty string).
 * Only params that are BOTH present on `step` AND coerced are returned, so a
 * caller can annotate exactly those and show every other declared param
 * verbatim; a param declared with a real value, an absent param, an
 * un-coerced param, and an unrecognized function name all yield nothing. Lets a
 * consent display state what executes off core's actual behavior, rather than a
 * web-side guess that could misstate a function it does not coerce.
 */
export function describeTransformCoercions(
  step: TransformStep,
): TransformParamCoercion[] {
  const fallbacks = TRANSFORM_PARAM_FALLBACKS[step.function];
  if (fallbacks === undefined) return [];
  const params = step.params ?? {};
  const coercions: TransformParamCoercion[] = [];
  for (const [param, executed] of Object.entries(fallbacks)) {
    // Only a declared, nullish param diverges: a declared real value is applied
    // as written, and an absent param has no displayed term to annotate. Own-
    // property check (Object.hasOwn, not `in`) so a name reachable only on the
    // prototype chain is never read as a declared param -- keeping the reported
    // coercion partner-independent even against a polluted Object.prototype.
    if (!Object.hasOwn(params, param)) continue;
    const declared = params[param];
    if (declared === null || declared === undefined)
      coercions.push({ param, executed });
  }
  return coercions;
}

// --- Step compilation --------------------------------------------------------

// `isListedFanOutFunction` records whether this step's function is one of the
// declared fan-out producers (FAN_OUT_FUNCTION_NAMES) and
// `canProduceMultipleValues` whether it can expand one value at all, both
// captured at compile time because the compiled closure no longer keeps its
// name. Together they are what lets a key say which producers its steps can
// expand it with BEFORE any of them runs, which the width bound binds on
// (buildKeyStrings).
type CompiledStep =
  | {
      kind: "fn";
      fn: StandardizingFn;
      isListedFanOutFunction: boolean;
      canProduceMultipleValues: boolean;
    }
  | { kind: "coalesce"; default: string | undefined };

function compileStep(step: {
  function: string;
  params?: Params;
}): CompiledStep {
  const params = step.params ?? {};
  if (step.function === "coalesce") {
    // NFC-normalize the literal default so coalesce cannot substitute a non-NFC
    // value into the key (it replaces the whole value, often as the last step).
    // Guard by type, not just nullish: the wire params are z.unknown() and
    // typed by no per-function shape, so a partner can declare `default` as any
    // JSON value, and calling `.normalize` on a non-string (null, number,
    // array, object) would throw while building the first row's key. Any
    // non-string behaves as an absent default; it is not String()-coerced,
    // which would mangle an array or object into a bogus substitution value.
    const rawDefault = params.default;
    return {
      kind: "coalesce",
      default:
        typeof rawDefault === "string"
          ? rawDefault.normalize("NFC")
          : undefined,
    };
  }
  const factory = STANDARDIZING_FUNCTIONS[step.function];
  // On the element-transform path the name is partner-authored free text -- the
  // wire schema types `function` as a bounded string, not as one of the names
  // this build knows -- so it is narrowed rather than echoed, as the magnitude
  // refusals narrow theirs.
  if (!factory)
    throw new UnknownStandardizationFunctionError(
      `unknown standardization function: ${transformFunctionLabel(step.function)}`,
    );
  return {
    kind: "fn",
    fn: factory(params),
    isListedFanOutFunction: isListedFanOutFunction(step.function),
    canProduceMultipleValues: canProduceMultipleValues(step.function),
  };
}

function compileSteps(
  steps: Array<{ function: string; params?: Params }>,
): CompiledStep[] {
  return steps.map(compileStep);
}

/**
 * Where a compiled pipeline can realize multiplicity: through a step that is a
 * declared fan-out producer, through one that is not, or neither.
 *
 * Read from the compiled steps rather than from a realized row, so a key's fate
 * at the accumulating bound is settled before any of its elements runs
 * ({@link keyAccumulationFate}).
 */
interface MultiplicitySources {
  readonly listed: boolean;
  readonly unlisted: boolean;
}

function pipelineMultiplicitySources(
  steps: ReadonlyArray<CompiledStep>,
): MultiplicitySources {
  let listed = false;
  let unlisted = false;
  for (const step of steps) {
    if (step.kind !== "fn" || !step.canProduceMultipleValues) continue;
    if (step.isListedFanOutFunction) listed = true;
    else unlisted = true;
  }
  return { listed, unlisted };
}

// --- Step execution ----------------------------------------------------------

/**
 * Where a realization's multiplicity came from, threaded out of the pipeline so
 * {@link buildKeyStrings} can bind the width bound's drop to the declared
 * producers alone (docs/spec/PROTOCOL.md, Fan-out matching, whose every rule
 * binds `split_on` and it alone).
 *
 * It is an observation of the steps that have already run, so it is what the
 * ASSEMBLED limbs read -- they run once every element exists -- and it is the
 * fail-closed safety check the accumulating bound reads beside its own pre-run
 * classification ({@link accumulationFateAtCharge}).
 */
interface FanOutProvenance {
  /**
   * Set once any step whose function is NOT in {@link FAN_OUT_FUNCTION_NAMES}
   * has expanded one value into several candidates.
   */
  fromUnlistedFunction: boolean;
}

// A step that returns several candidates for ONE input value is the producer of
// that multiplicity, so an unlisted producer is recorded where it expands. The
// count is read per input value rather than across the whole set because that is
// what separates producing multiplicity from merely passing it along: a later
// step run element-wise over an already-expanded set returns one candidate per
// value and produces none of it.
function noteFanOutProducer(
  result: FieldValue,
  isListedFanOutFunction: boolean,
  provenance: FanOutProvenance | undefined,
): void {
  if (provenance === undefined || isListedFanOutFunction) return;
  if (result instanceof Set && result.size > 1)
    provenance.fromUnlistedFunction = true;
}

// Add one candidate to a step's accumulating output and report the characters it
// RETAINED: a duplicate the set collapses retains nothing, so it is not charged
// to the accumulation bound.
function addCandidate(out: Set<string>, candidate: string): number {
  const size = out.size;
  out.add(candidate);
  return out.size > size ? candidate.length : 0;
}

// `coalesce` is the only function that operates on null (or an empty array
// produced by prior null-filtering). All other functions null-propagate.
//
// `site` is supplied on the partner-authored element-transform path alone: the
// magnitude bound below is the one the agreed terms make necessary, and the
// operator's own standardization pipeline -- its config and its data both local
// -- runs without it (docs/notes/bound-transformed-value.md).
function applyStep(
  current: FieldValue,
  step: CompiledStep,
  provenance?: FanOutProvenance,
  site?: CandidateAccumulationSite,
): FieldValue {
  if (step.kind === "coalesce") {
    if (current === null || (current instanceof Set && current.size === 0)) {
      return step.default ?? null;
    }
    return current;
  }

  if (current === null) return null;

  if (current instanceof Set) {
    const out = new Set<string>();
    // The row's magnitude invariant, enforced as the candidates are allocated
    // rather than once they all exist: a step runs element-wise over an expanded
    // set, so it allocates one output per candidate, and the per-value ceiling
    // (applyElementTransform) reads the finished set -- by which point a set N
    // times the ceiling has already been built. Charging each candidate as it
    // lands holds the accumulated set to the same total the assembled key
    // strings hold, plus the one candidate being produced when the total
    // crosses.
    let accumulated = 0;
    for (const v of current) {
      const r = step.fn(v);
      if (r === null) continue;
      if (r instanceof Set) {
        noteFanOutProducer(r, step.isListedFanOutFunction, provenance);
        for (const sv of r) accumulated += addCandidate(out, sv);
      } else {
        accumulated += addCandidate(out, r);
      }
      if (
        site !== undefined &&
        accumulated > MAX_ASSEMBLED_KEY_LENGTH_PER_ROW
      ) {
        // The key's own fate, decided before any of its elements ran, so which
        // step happens to be charging the crossing does not move it.
        if (
          accumulationFateAtCharge(
            site.fate,
            provenance?.fromUnlistedFunction === true,
          ) === "drop"
        )
          throw new AccumulatedCandidatesDrop(accumulated);
        throw accumulatedCandidatesTooLongRefusal(site, accumulated);
      }
    }
    return out.size === 0 ? null : out;
  }

  const result = step.fn(current);
  noteFanOutProducer(result, step.isListedFanOutFunction, provenance);
  return result;
}

// --- Pipeline ----------------------------------------------------------------

function runCompiledPipeline(
  input: string,
  steps: CompiledStep[],
  provenance?: FanOutProvenance,
): FieldValue {
  // Unicode NFC normalization is the unconditional first transform of every
  // standardized field. The cleaned string becomes the PSI set element verbatim,
  // so two parties holding the same logical value in different normalization
  // forms (precomposed NFC vs decomposed NFD -- the common macOS-filesystem vs
  // Windows/most-DB split) would otherwise emit different bytes and the same
  // person would silently fail to match. It runs here, before any step and for
  // every pipeline -- including the identity (no-steps) passthrough and custom
  // pipelines that never strip to ASCII -- rather than being gated on a
  // remove_accents step that is not guaranteed to run.
  let current: FieldValue = input.normalize("NFC");
  for (const step of steps) {
    current = applyStep(current, step, provenance);
  }
  return current;
}

/**
 * Apply a sequence of cleaning steps to a raw string value.
 *
 * Returns `null` if any step filters the value out, `Set<string>` if a fan-out
 * step (e.g. `split_on`) was applied, or a plain `string` otherwise.
 *
 * The input is normalized to NFC before the first step, but the returned value
 * is not guaranteed NFC: a step such as `to_upper_case` can leave non-NFC bytes,
 * and the canonical-key NFC guarantee is applied downstream by
 * {@link buildKeyStrings}, not here. A direct caller that needs a canonical
 * string must normalize the result itself.
 */
export function runPipeline(
  input: string,
  steps: Array<{ function: string; params?: Params }>,
): FieldValue {
  return runCompiledPipeline(input, compileSteps(steps));
}

// Convert a pipeline result to a value set. An empty array means the record
// has no valid value for this field and is excluded from the linkage protocol.
function toValueSet(result: FieldValue): string[] {
  if (result === null) return [];
  if (result instanceof Set) return [...result];
  return [result];
}

// --- Standardized field ------------------------------------------------------

// One row's standardized values plus the provenance of any multiplicity among
// them, cached together because the pipeline produces both in one pass.
interface RealizedFieldValues {
  readonly values: string[];
  readonly fanOutFromUnlistedFunction: boolean;
}

// The no-value realization. Built fresh per call rather than shared, because
// `values` is handed to callers as a mutable array.
function noRealizedValues(): RealizedFieldValues {
  return { values: [], fanOutFromUnlistedFunction: false };
}

/**
 * A lazily-evaluated, cached mapping from a raw dataset row index to the set
 * of standardized string values for one linkage field.
 *
 * An empty array indicates that the record has no valid value for this field and
 * is excluded from any linkage key that references it. More than one value is a
 * fan-out: {@link buildKeyStrings} crosses every value into the key's candidate
 * set, which the single-pass strategy matches on and every other one refuses
 * (see {@link assertFanOutImplemented}).
 */
export class StandardizedField {
  readonly name: string;

  /**
   * Which producers this field's pipeline can realize several values for one row
   * with, read from its compiled steps.
   *
   * A raw cell is one string, so every value a row realizes beyond the first
   * comes from a step here -- which is what lets {@link buildKeyStrings} settle
   * a key's fate at the accumulating bound before it reads a single row.
   */
  readonly multiplicitySources: MultiplicitySources;

  private readonly inputColumn: string;
  private readonly compiledSteps: CompiledStep[];
  private readonly rawRows: ReadonlyArray<CSVRow>;
  private readonly cache = new Map<number, RealizedFieldValues>();

  constructor(
    name: string,
    inputColumn: string,
    steps: StandardizationStep[],
    rawRows: ReadonlyArray<CSVRow>,
  ) {
    this.name = name;
    this.inputColumn = inputColumn;
    this.compiledSteps = compileSteps(steps);
    this.multiplicitySources = pipelineMultiplicitySources(this.compiledSteps);
    this.rawRows = rawRows;
  }

  /**
   * Standardize a SINGLE row's value for this field, using the pipeline compiled
   * once in the constructor and consulting no cache. An empty array signals the
   * record has no valid value for this field.
   *
   * This is the compile-once, feed-a-row entry point a STREAMING consumer uses:
   * it can construct the field once (paying the pipeline compile a single time)
   * over an empty backing row set and then hand rows in as they arrive, retaining
   * none -- the server-side coverage sweep over a CLI-scale mounted file does
   * exactly this. {@link get} is the cached, by-index counterpart for a consumer
   * that holds the whole row set in memory; both run the same compiled pipeline,
   * so the two drivers cannot diverge.
   */
  evaluateRow(row: CSVRow): string[] {
    return this.realizeRow(row).values;
  }

  /**
   * Return the standardized values for the row at `index`.
   *
   * The result is computed on first access and cached for subsequent calls.
   * An empty array signals that the record has no valid value for this field.
   */
  get(index: number): string[] {
    return this.realize(index).values;
  }

  /**
   * Whether the row at `index` realized several values through a standardizing
   * function OUTSIDE {@link FAN_OUT_FUNCTION_NAMES}.
   *
   * The width bound's drop is normative for the declared fan-out producers alone
   * (docs/spec/PROTOCOL.md, Fan-out matching), so {@link buildKeyStrings} reads
   * this to keep multiplicity from any other producer fail-closed: passed
   * through to the strategy that refuses it rather than dropped.
   */
  fanOutFromUnlistedFunction(index: number): boolean {
    return this.realize(index).fanOutFromUnlistedFunction;
  }

  private realizeRow(row: CSVRow): RealizedFieldValues {
    const raw = readRowColumn(row, this.inputColumn);
    if (raw === undefined) return noRealizedValues();
    const provenance: FanOutProvenance = { fromUnlistedFunction: false };
    const result = runCompiledPipeline(raw, this.compiledSteps, provenance);
    return {
      values: toValueSet(result),
      fanOutFromUnlistedFunction: provenance.fromUnlistedFunction,
    };
  }

  private realize(index: number): RealizedFieldValues {
    const cached = this.cache.get(index);
    if (cached !== undefined) return cached;

    const row = this.rawRows[index];
    const realized = row ? this.realizeRow(row) : noRealizedValues();
    this.cache.set(index, realized);
    return realized;
  }
}

// --- Standardized dataset ----------------------------------------------------

/**
 * A collection of {@link StandardizedField}s that bridge between a raw dataset
 * and the linkage fields required by linkage keys. Each field is lazily
 * evaluated per row index and cached.
 */
export class StandardizedDataset {
  /**
   * Whether a linkage field one of `linkageKeys`'s elements READS is cleaned by a
   * pipeline declaring a fan-out producer -- the local authoring surface the
   * partner cannot see.
   *
   * Scoped to the fields those keys read because they are the only fields the
   * exchange standardizes and matches on ({@link referencedLinkageFieldNames}),
   * so a fan-out on any other field widens no key's candidate set and declares
   * nothing. It is what {@link localFanOutFactor} multiplies this party's
   * DECLARED RECORD COUNT by, and what widens the per-key bound the row builder
   * holds a record's candidate set to.
   */
  readonly declaresFanOut: boolean;

  private readonly fieldMap: ReadonlyMap<string, StandardizedField>;

  /**
   * @param fields - The standardized fields this dataset serves.
   * @param linkageKeys - The linkage keys the dataset will be read for, which
   *   scope {@link declaresFanOut}. Pass them as AUTHORED: a `swap` only permutes
   *   `field` among a key's own elements, so the authored elements already name
   *   every field a swapped reading could reach.
   */
  constructor(
    fields: StandardizedField[],
    linkageKeys: ReadonlyArray<LinkageKey>,
  ) {
    this.fieldMap = new Map(fields.map((f) => [f.name, f]));
    const keyReadFields = referencedLinkageFieldNames(linkageKeys);
    this.declaresFanOut = fields.some(
      (field) =>
        field.multiplicitySources.listed && keyReadFields.has(field.name),
    );
  }

  /** Names of the linkage fields this dataset provides. */
  get fieldNames(): ReadonlySet<string> {
    return new Set(this.fieldMap.keys());
  }

  /**
   * Return the {@link StandardizedField} for `name`, or `undefined` if absent.
   */
  getField(name: string): StandardizedField | undefined {
    return this.fieldMap.get(name);
  }
}

// --- Column resolution -------------------------------------------------------

/**
 * How one declared linkage field resolves to an input column -- the single
 * binding the dataset builder and the satisfiability checker both consume, so
 * the two cannot encode the resolution rules independently and drift (the
 * detector-vs-runtime divergence class). Produced by {@link resolveFieldColumns}.
 *
 * @internal The return shape of an internal resolution primitive; exported only
 * because it is {@link resolveFieldColumns}'s return type, not as a supported
 * entry point.
 */
interface FieldColumnResolution {
  /**
   * The input column the field binds to, regardless of whether that column is
   * present in the data, or `undefined` when no column resolves the field. The
   * builder reads rows from this column (an absent column yields no values); a
   * presence-only consumer (the satisfiability checker) treats the field as
   * producible exactly when this is defined AND present in the input columns.
   */
  column: string | undefined;
  /**
   * The explicit standardization transformation that bound the field, when the
   * binding came from one; `undefined` for a semantic-type-fallback binding. The
   * builder takes its `steps`; presence-only consumers ignore it.
   */
  transform: StandardizationTransformation | undefined;
}

/**
 * Resolve every declared linkage field to the input column an exchange would
 * bind it to, encoding the column-to-field resolution rules in ONE place so the
 * dataset builder ({@link buildStandardizedDataset}), the satisfiability checker
 * ({@link unsatisfiedLinkageFields}), and the default-standardization derivation
 * (`getDefaultStandardization`) cannot drift apart.
 *
 * The rules, per field:
 *
 * 1. Explicit standardization preempts the type fallback: if `standardization`
 *    contains a transformation whose `output` is the field name, the field
 *    binds to that transformation's `input` column -- whether or not the
 *    column is present in the data -- UNLESS that column is present and is not
 *    `role: linkage`, in which case the field binds to nothing: matching
 *    participation is the operator's explicit `linkage` role, and that role wins
 *    over a contradictory explicit transform naming an `identifier`, `payload`,
 *    or `ignored` column. (An ABSENT named column still binds, so the field is
 *    shown as unsatisfiable by presence, unchanged. When two transformations
 *    name the same output, the last one wins.)
 * 2. Type fallback: otherwise the field binds to the FIRST `metadata` column of
 *    its semantic type that is `role: linkage`
 *    (`metadata.find(c => c.type === field.type && c.role === "linkage")`), or to
 *    nothing when no such column exists. First-match -- not "any same-typed
 *    column" -- because the exchange reads exactly that column. A column roled
 *    `identifier`, `payload`, or `ignored` is skipped even when it is the only
 *    one of its type, so it never participates in matching by type alone.
 *
 * Matching participation keys on `role: linkage`, NOT on semantic type: a
 * column is hashed into a PSI key only when the operator roled it for linkage.
 * That is a separate axis from transmission ({@link isDisclosedToPartner} =
 * `isPayload && role !== "ignored"`); a column that both matches and is sent is
 * `role: linkage` with `isPayload: true`, which binds here unchanged.
 *
 * Binding is independent of whether the bound column is present in the input:
 * the builder reads rows from the column and a presence-only consumer layers the
 * presence test on top. `metadata` is the resolved metadata the caller already
 * chose (an explicit block or `inferMetadata`); under inferred metadata every
 * column is present, so the presence test only bites under an explicit block.
 *
 * @internal Shared primitive for the resolution's three in-package consumers
 * (builder, satisfiability checker, default-standardization derivation);
 * exported for those cross-module imports, not as a supported entry point. The
 * web and CLI paths consume {@link assessLinkageSatisfiability} /
 * {@link unsatisfiedLinkageFields}, not this directly.
 */
export function resolveFieldColumns(
  terms: LinkageTerms,
  standardization: Standardization | undefined,
  metadata: ColumnMetadata[],
): Map<string, FieldColumnResolution> {
  // Field output -> its explicit transformation; last wins on a duplicate
  // output (the schema forbids duplicates, so this only differs for terms not
  // built through it).
  const explicit = new Map<string, StandardizationTransformation>();
  for (const t of standardization ?? []) explicit.set(t.output, t);

  const resolution = new Map<string, FieldColumnResolution>();
  for (const field of terms.linkageFields) {
    const transform = explicit.get(field.name);
    if (transform !== undefined) {
      // An explicit standardization binds its input column into linkage only
      // when the operator roled that column `linkage`. Matching participation is
      // a single explicit axis keyed on `role`, so a present column roled
      // `identifier` (a local row index), `payload` (sent to the partner), or
      // `ignored` (used for nothing) does NOT participate -- and that role wins
      // over a contradictory explicit transform. The field then resolves to no
      // column (reported as unsatisfiable through the shared checker) rather
      // than silently hashing a column the operator did not designate for
      // matching into a PSI key. An ABSENT named column is not refused here: it
      // still binds and is reported as unsatisfiable by presence downstream
      // (the documented preempt-the-fallback behavior). "Match and send" stays
      // expressible as a `role: linkage` column with `isPayload: true`.
      const inputColumn = metadata.find((c) => c.name === transform.input);
      if (inputColumn !== undefined && inputColumn.role !== "linkage") {
        resolution.set(field.name, { column: undefined, transform: undefined });
      } else {
        resolution.set(field.name, { column: transform.input, transform });
      }
      continue;
    }
    // Bind only a `role: linkage` column: matching participation is the
    // operator's explicit `linkage` role, not merely a matching semantic `type`.
    // A column roled `identifier`, `payload`, or `ignored` is never a default
    // match field even when its type matches the field -- so a column marked
    // sent-to-partner or row-identifier is not silently hashed into a PSI key.
    // This is the one chokepoint the builder, the satisfiability checker, and the
    // default-standardization derivation share, so narrowing it once keeps a
    // non-linkage column out of all three. Transmission is a separate axis
    // (`isDisclosedToPartner`); see this function's header.
    const col = metadata.find(
      (c) => c.type === field.type && c.role === "linkage",
    );
    resolution.set(field.name, { column: col?.name, transform: undefined });
  }
  return resolution;
}

/**
 * Build a {@link StandardizedDataset} for the linkage fields in `terms`, binding
 * each field to an input column via {@link resolveFieldColumns}: an explicit
 * standardization transformation when one names the field (its steps run on the
 * bound column), otherwise the identity transformation over the first
 * `role: linkage` metadata column of the field's semantic type.
 *
 * Linkage fields that resolve to no column are absent from the dataset; records
 * referencing those fields are excluded from the corresponding linkage keys.
 */
export function buildStandardizedDataset(
  standardization: Standardization | undefined,
  rawRows: ReadonlyArray<CSVRow>,
  metadata: ColumnMetadata[],
  terms: LinkageTerms,
): StandardizedDataset {
  const resolution = resolveFieldColumns(terms, standardization, metadata);
  const fields: StandardizedField[] = [];

  for (const field of terms.linkageFields) {
    const resolved = resolution.get(field.name);
    if (resolved === undefined || resolved.column === undefined) continue;
    // Explicit binding has its own steps; a type-fallback binding is the
    // identity transformation (pass the raw column value through unchanged).
    fields.push(
      new StandardizedField(
        field.name,
        resolved.column,
        resolved.transform?.steps ?? [],
        rawRows,
      ),
    );
  }

  return new StandardizedDataset(fields, terms.linkageKeys);
}

// --- Key building ------------------------------------------------------------

function cartesianProduct(arrays: string[][]): string[][] {
  return arrays.reduce<string[][]>(
    (acc, arr) => acc.flatMap((prefix) => arr.map((v) => [...prefix, v])),
    [[]],
  );
}

// Compiled element transforms, memoized by the step array's identity. buildKeyStrings
// calls applyElementTransform once per value PER ROW with the same `element.transform`
// array (the parsed LinkageKey is reused for every row), so without this each row
// would recompile -- and a regex step recompiles its pattern under the linear-time
// engine. A hostile-but-schema-valid terms set can contain far more distinct
// patterns than the engine's own compile cache holds, so per-row recompilation
// would thrash that cache into an unbounded per-row compile cost over a large
// dataset -- a
// fail-open CPU denial of service, the volume sibling of the catastrophic-
// backtracking vector the linear-time engine closes. Compiling each element
// transform once bounds total compile work to the (gate-bounded) distinct element
// transforms, independent of row count. A WeakMap keys on the array so entries are
// released with the terms; the swap path preserves the array reference, so a swapped
// element still hits. The compiled steps are stateless (each factory closure builds a
// fresh matcher per call), so reuse across rows is safe.
const compiledElementTransforms = new WeakMap<
  TransformStep[],
  CompiledStep[]
>();

// The compiled steps for one element's transform, memoized as above. Reached
// both by the run and by the pre-run classification below, so the fate a key's
// crossing takes is read from the same compiled steps that will produce it.
function compiledElementSteps(
  steps: TransformStep[] | undefined,
): CompiledStep[] {
  if (steps === undefined || steps.length === 0) return [];
  const memoized = compiledElementTransforms.get(steps);
  if (memoized !== undefined) return memoized;
  const compiled = compileSteps(steps);
  compiledElementTransforms.set(steps, compiled);
  return compiled;
}

/**
 * The longest single value a partner-authored key element may read or produce.
 *
 * The partner authors the element transforms and this party runs them over its
 * own rows, so the SIZE of what a row derives is partner-influenced while the
 * data is local. The wire schema bounds what the partner may WRITE (a param's
 * content length, config/linkageTerms.ts) but not what a row DERIVES from it: a
 * `replace_regex` replacement is a substitution template whose match-context
 * sequences re-insert the operator's own cell at every match position, and steps
 * compose, each fed the previous one's output. This ceiling is the bound on the
 * produced value, applied to what an element READS and to what every step
 * PRODUCES, so each step's input is bounded as well as its output and a chain
 * cannot compound past it.
 *
 * A legitimate key element is a name, a date, an identifier, or an address --
 * tens of characters, a few hundred at the outside -- so 4096 is far above any
 * legitimate one while holding the derived value to a size the rest of the row
 * pipeline (`split_on`, the fuzzy expansion, key assembly) can handle. An
 * over-ceiling value is REFUSED, never truncated: both parties must derive
 * byte-identical keys, so a unilateral clamp would break matching and show up
 * as a terms mismatch against the hashed agreement -- the same reason the param
 * bounds refuse rather than trim. The recorded rationale and the limits this
 * placement does not reach live in docs/spec/CHANNEL_SECURITY.md.
 */
const MAX_TRANSFORMED_VALUE_LENGTH = 4096;

// Every number in the refusals below is a derived integer and the step's
// function name is narrowed to a fixed literal before it is interpolated, so
// neither the value (this party's own PII) nor partner free text reaches the
// message. The key's own `name` is partner-authored, which is why the path
// locates the element by index rather than naming the key.
function transformFunctionLabel(functionName: string): string {
  return STANDARDIZATION_FUNCTION_NAMES.includes(functionName)
    ? `"${functionName}"`
    : "a function this build does not recognize";
}

// The issue path locating an element in the agreed terms. The key index is
// present on the exchange path, which is the partner-reachable one; a direct
// caller that builds keys for one key object alone has no position to report, so
// the path is rooted at the element there.
function keyElementPath(
  keyIndex: number | undefined,
  elementIndex: number,
): string {
  const root = keyIndex === undefined ? "" : `linkageKeys[${keyIndex}].`;
  return `${root}elements[${elementIndex}]`;
}

function elementValueTooLongRefusal(
  keyIndex: number | undefined,
  elementIndex: number,
  rowIndex: number,
  length: number,
): UsageError {
  return new UsageError(
    `a linkage key element reads a ${length}-character value from row ` +
      `${rowIndex} of this party's data (the column bound at ` +
      `${keyElementPath(keyIndex, elementIndex)}), longer than the ` +
      `${MAX_TRANSFORMED_VALUE_LENGTH}-character value an element may put ` +
      "into a key string. Every element's value goes into every key " +
      "string the row builds, and an element transform is free to multiply " +
      "the value it is handed, so the limit binds what the element reads as " +
      "well as what each of its steps produces. Neither can be shortened " +
      "here -- both parties must derive byte-identical keys, so a value " +
      "trimmed to fit would match nothing and contradict the agreed terms. " +
      "The exchange is refused instead. Bind the element to a shorter " +
      "column, or shorten the field in this party's own standardization " +
      "before the key element reads it.",
  );
}

function transformStepValueTooLongRefusal(
  keyIndex: number | undefined,
  elementIndex: number,
  stepIndex: number,
  functionName: string,
  rowIndex: number,
  length: number,
): UsageError {
  return new UsageError(
    "a linkage key element transform step produced a " +
      `${length}-character value from row ${rowIndex} ` +
      `(${keyElementPath(keyIndex, elementIndex)}.transform[${stepIndex}], ` +
      `${transformFunctionLabel(functionName)}), longer than the ` +
      `${MAX_TRANSFORMED_VALUE_LENGTH}-character value an element may put ` +
      "into a key string. A step can multiply what it is handed many times " +
      "over -- a replacement that re-inserts the matched context at every " +
      "match position, or a chain of steps each feeding the next -- so every " +
      "step's output is bounded, which is also what keeps the next step's " +
      "input bounded. The value cannot be shortened here: both parties must " +
      "derive byte-identical keys. The exchange is refused instead. Remove " +
      "or narrow that step in the agreed linkage terms, or shorten the field " +
      "the element reads.",
  );
}

// The first value over the ceiling, if any. A step that expands one value into
// several candidates is measured candidate by candidate, because a candidate is
// what the next step is handed and what one key string holds; the row's total
// across the candidates is bounded where the key is assembled (buildKeyStrings).
function valueOverCeiling(result: FieldValue): number | undefined {
  if (result === null) return undefined;
  if (typeof result === "string")
    return result.length > MAX_TRANSFORMED_VALUE_LENGTH
      ? result.length
      : undefined;
  for (const value of result)
    if (value.length > MAX_TRANSFORMED_VALUE_LENGTH) return value.length;
  return undefined;
}

// One element's candidate values for one row: an element-level fan-out step
// contributes its candidates to that element's position in the key's
// cross-product, exactly as a fan-out on the field feeding the element does, so
// one semantics and one width bound cover both authoring surfaces
// (docs/spec/PROTOCOL.md, Fan-out matching). Joining the candidates into one
// string instead would match on a value neither party's data holds. An empty
// array is the null realization: the record has no value for this element.
//
// The steps run through applyStep, which is what applies each later step
// element-wise across the candidates and drops a candidate a null-producing step
// filters -- the same execution the field-level pipeline uses, so the two
// surfaces cannot drift.
//
// `site` locates the element the steps are declared at; `columnElementIndex`
// locates the element that declares the COLUMN this value came from. The two
// differ only on the receiver of a key whose `swap` moved the fields, where a
// refusal on the value READ must name the column's own position.
function applyElementTransform(
  value: string,
  steps: TransformStep[] | undefined,
  provenance: FanOutProvenance,
  site: CandidateAccumulationSite,
  columnElementIndex: number,
): string[] {
  // The magnitude ceiling's base case, ahead of the no-steps early return so it
  // also binds an element that declares no transform at all and passes a raw
  // cell straight into the key.
  if (value.length > MAX_TRANSFORMED_VALUE_LENGTH)
    throw elementValueTooLongRefusal(
      site.keyIndex,
      columnElementIndex,
      site.rowIndex,
      value.length,
    );
  // No steps: the value passes through unchanged (the empty-pipeline identity),
  // and nothing is compiled or memoized.
  if (steps === undefined || steps.length === 0) return [value];
  const compiled = compiledElementSteps(steps);
  let current: FieldValue = value;
  for (const [stepIndex, step] of compiled.entries()) {
    current = applyStep(current, step, provenance, site);
    const over = valueOverCeiling(current);
    if (over !== undefined)
      throw transformStepValueTooLongRefusal(
        site.keyIndex,
        site.elementIndex,
        stepIndex,
        steps[stepIndex].function,
        site.rowIndex,
        over,
      );
  }
  return toValueSet(current);
}

// The receiver's element list for a key declaring `swap`, paired with the
// positions whose fields it exchanged. The swap moves the field references and
// leaves each element's own name and transforms where they are, so on the
// receiver the position that READS a column and the position that DECLARES it
// are different ones; `pair` is what lets a refusal name whichever of the two it
// is about. Only the receiver swaps, so the pair's two transforms have to agree
// for the round to compare like with like whichever party role resolution makes
// receiver; the terms schema binds them (config/linkageTerms.ts), which is what
// lets the transform stay with the position here.
//
// This list is the SWAPPED order alone. The receiver assembles the authored
// order beside it -- the swap's full variant, one-sided like the receiver-only
// fuzzy kinds ({@link expandsOnReceiverOnly}) and gated with them -- by
// exchanging the two positions' assembled candidate lists rather than reading
// the key a second time (see the assembly in buildKeyStringsUnderPlan).
function swapElements(
  elements: LinkageKeyElement[],
  [nameA, nameB]: [string, string],
): { elements: LinkageKeyElement[]; pair: [number, number] | undefined } {
  const idA = elements.findIndex((e) => (e.name ?? e.field) === nameA);
  const idB = elements.findIndex((e) => (e.name ?? e.field) === nameB);
  if (idA === -1 || idB === -1) return { elements, pair: undefined };
  const exchanged = [...elements];
  exchanged[idA] = { ...elements[idA], field: elements[idB].field };
  exchanged[idB] = { ...elements[idB], field: elements[idA].field };
  return { elements: exchanged, pair: [idA, idB] };
}

// The element position that DECLARES the column the element at `elementIndex`
// reads -- the same position everywhere but the two swapped positions on a
// receiver, where the value comes from the sibling's declared column while the
// transform stays the element's own.
function columnDeclaringElementIndex(
  pair: [number, number] | undefined,
  elementIndex: number,
): number {
  if (pair === undefined) return elementIndex;
  const [idA, idB] = pair;
  if (elementIndex === idA) return idB;
  if (elementIndex === idB) return idA;
  return elementIndex;
}

/**
 * The hard cap on the key strings ONE row may contribute to a single key round.
 *
 * The key's own declared width ({@link declaredKeyWidth}) bounds the record's
 * candidate set for that key, dropping a record a declared fan-out widened above
 * it and refusing one a fuzzy expansion did. This cap is the resource bound
 * underneath the cross-product itself: the product multiplies each element's
 * candidate count, and the decision to expand an element comes from the
 * partner-authored linkage terms while the values expanded are local rows, so the
 * product is not something the local operator alone controls. A fan-out never
 * REFUSES on it -- a row whose product is too wide to assemble is dropped like
 * any other over-width row -- so the refusal binds only the other candidate
 * producer, `generateFuzzyComparisons` (docs/spec/PROTOCOL.md, The width bound).
 *
 * It is {@link MAX_KEY_CANDIDATE_WIDTH}, the ceiling on any one key's declared
 * width, so the two coincide: a key the terms declare wider than a row can be
 * assembled for is refused where the width is derived, before any row is read,
 * and what reaches this cap is a row whose realized product outgrew a width the
 * terms admit. It
 * bounds the COUNT of key strings, not their bytes: a fuzzy element's value is
 * bounded by MAX_FUZZY_EXPANSION_INPUT_LENGTH, but a non-fuzzy element in the
 * same key holds its full local cell, which the product replicates, so the
 * per-row byte total would scale with the operator's own longest cell times
 * this cap. What holds it is the byte limb beside this one,
 * {@link MAX_ASSEMBLED_KEY_LENGTH_PER_ROW}, measured on the same projection.
 * Both are recorded in docs/spec/CHANNEL_SECURITY.md.
 */
const MAX_KEY_STRINGS_PER_ROW = MAX_KEY_CANDIDATE_WIDTH;

/**
 * The hard cap on the total characters one row's key strings may hold for a
 * single key round -- the byte limb beside {@link MAX_KEY_STRINGS_PER_ROW}'s
 * count limb.
 *
 * The count cap bounds how MANY key strings a row assembles, not how large they
 * are: every combination concatenates one candidate from each element, so a row
 * at the count cap replicates each element's value across all of them. A fuzzy
 * element's own candidates are short ({@link MAX_FUZZY_EXPANSION_INPUT_LENGTH}),
 * but a non-fuzzy sibling in the same key contributes its whole transformed
 * value to every combination, and that value is partner-influenced in size
 * ({@link MAX_TRANSFORMED_VALUE_LENGTH}) -- so bytes need a limb of their own.
 * It is set at the count cap times the per-value ceiling: a row may hold the
 * equivalent of one ceiling-sized element replicated across the full width the
 * count cap allows, which is orders of magnitude above any legitimate row (a
 * wide fuzzy key over canonical dates and names assembles a few hundred
 * candidates of a few dozen characters). Measured on the PROJECTED total,
 * before the cross-product is materialized, for the same reason the count
 * limb is.
 */
const MAX_ASSEMBLED_KEY_LENGTH_PER_ROW =
  MAX_KEY_STRINGS_PER_ROW * MAX_TRANSFORMED_VALUE_LENGTH;

// The value is local row data and the key name is partner-authored free text, so
// neither is interpolated; the count is a derived integer and names no value.
//
// Both openings the refusal covers are named, because the operator cannot tell
// them apart from the count: fuzzy comparisons, and a standardization or element
// step that expands one value into several candidates without being a declared
// fan-out producer (which is what routes it here rather than to the drop).
function keyStringFanOutCapRefusal(
  projected: number,
  keyIndex: number | undefined,
): UsageError {
  const key =
    keyIndex === undefined
      ? "a linkage key"
      : `the linkage key at linkageKeys[${keyIndex}]`;
  return new UsageError(
    `${key} expands one row into ${projected} key strings, above the ` +
      `${MAX_KEY_STRINGS_PER_ROW} this exchange builds per row. Every ` +
      "element's candidates multiply across the key, so a key whose elements " +
      "expand -- through fuzzy comparisons declared on several of them, or a " +
      "standardization or element-transform step that turns one value into " +
      "several candidates -- fans out far enough to exhaust memory. The " +
      "exchange is refused instead. Declare fuzzy comparisons on fewer of the " +
      "key's elements, drop the expanding step from the transforms, or " +
      "shorten the expanded fields with an element transform.",
  );
}

// The width bound's refusal for a row a fuzzy expansion widened past the width
// the key declares. The realized count and the declared width are derived
// integers and the key path locates the offender, so it echoes neither a local
// value nor the partner's free text, like the two cap refusals around it.
//
// A declared fan-out producer takes the warned drop at this same bound instead;
// what separates them is that the drop is the fan-out rules' own normative
// exceedance behavior, while every candidate a fuzzy element declares is one the
// consent surface states matches independently.
function fuzzyWidthCapRefusal(
  realized: number,
  width: number,
  keyIndex: number | undefined,
): UsageError {
  const key =
    keyIndex === undefined
      ? "a linkage key"
      : `the linkage key at linkageKeys[${keyIndex}]`;
  return new UsageError(
    `${key} expands one row into ${realized} candidate values through fuzzy ` +
      `comparisons, above the ${width} one record may contribute to it. That ` +
      "width is what the agreed terms declare for this key, so a wider row has " +
      "no slot to occupy, and contributing part of the set would match on less " +
      "than the terms declare. The exchange is refused instead. Declare fuzzy " +
      "comparisons on fewer of the key's elements, or shorten the expanded " +
      "fields with an element transform.",
  );
}

// The byte limb's refusal, on the same footing as the count limb's above: the
// projected total names no value, and the key path locates the offender where
// the exchange path supplies it.
function keyStringLengthCapRefusal(
  projected: number,
  keyIndex: number | undefined,
): UsageError {
  const key =
    keyIndex === undefined
      ? "a linkage key"
      : `the linkage key at linkageKeys[${keyIndex}]`;
  return new UsageError(
    `${key} assembles ${projected} characters of key strings for one row, ` +
      `above the ${MAX_ASSEMBLED_KEY_LENGTH_PER_ROW} this exchange builds ` +
      "per row. Every combination of the key's elements includes each " +
      "element's whole value, so a key whose elements expand -- through " +
      "fuzzy comparisons, or a step that turns one value into several " +
      "candidates -- replicates those values across the whole cross-product " +
      "and exhausts memory as it is built. The exchange is refused instead. " +
      "Declare fuzzy comparisons on fewer of the key's elements, drop the " +
      "expanding step from the transforms, or shorten the expanded fields " +
      "with an element transform.",
  );
}

/**
 * What one row contributes to a key's round once its candidates cross
 * {@link MAX_ASSEMBLED_KEY_LENGTH_PER_ROW} as they accumulate: nothing for that
 * key (`drop`, the exceedance behavior the declared fan-out producers'
 * width bound specifies, warned and leaving the row eligible for later keys), or
 * an ended exchange (`refuse`).
 */
type AccumulationFate = "drop" | "refuse";

/**
 * The fate a crossing of this key's accumulating candidates takes, decided from
 * the compiled steps of the key's elements and of the fields feeding them --
 * BEFORE any of those elements runs.
 *
 * A raw cell is one string and a compiled step is fixed for the whole run, so
 * every producer that can expand this row is knowable here. That is what makes
 * the fate a property of the (row, key) pair rather than of the moment the
 * crossing happens to land: an element order, or a crossing charged while the
 * expanding element is still being built, cannot move it.
 *
 * `refuse` unless every producer that can expand the key is a declared fan-out
 * producer. A producer outside {@link FAN_OUT_FUNCTION_NAMES} is outside the
 * width bound's rules (docs/spec/PROTOCOL.md, Fan-out matching) and stays
 * fail-closed however wide it went. A key no producer can expand at all names
 * none to bind a drop to, so it takes that same fail-closed default; what holds
 * such a key is the per-value ceiling on each of its elements
 * ({@link MAX_TRANSFORMED_VALUE_LENGTH}) rather than a crossing here.
 *
 * `swap` exchanges two elements' FIELDS while each keeps its own transforms, so
 * it re-pairs the producers below without adding or removing one: over ONE
 * dataset the sender and the receiver of a swapped key reach the same verdict,
 * and cannot end one run with a dropped row and the other with a refusal. That
 * scope is the dataset's, not the exchange's -- each party classifies from its
 * OWN local standardization's field pipelines, so two partners whose local
 * configs realize a key's fields differently can classify the same key
 * differently.
 */
function keyAccumulationFate(
  elements: ReadonlyArray<LinkageKeyElement>,
  dataset: StandardizedDataset,
): AccumulationFate {
  let listedProducer = false;
  for (const element of elements) {
    const field = dataset.getField(element.field)?.multiplicitySources;
    const transform = pipelineMultiplicitySources(
      compiledElementSteps(element.transform),
    );
    if (field?.unlisted === true || transform.unlisted) return "refuse";
    listedProducer ||= field?.listed === true || transform.listed;
  }
  return listedProducer ? "drop" : "refuse";
}

/**
 * @internal exported so the fail-closed safety check below is driven by a test
 * of its own: a correct classification leaves it unreachable, which is what
 * makes it a check rather than a branch a shape can be written for.
 *
 * The fate {@link keyAccumulationFate} settled, unless a step expanded a value
 * while unlisted -- which under a `drop` classification is a producer that
 * classification did not see as one at all. That is a fault in the
 * classification rather than a fate the row earned, so the crossing refuses
 * rather than dropping a row whose fan-out nothing declared.
 */
export function accumulationFateAtCharge(
  fate: AccumulationFate,
  unlistedProducerExpandedTheRow: boolean,
): AccumulationFate {
  return fate === "drop" && unlistedProducerExpandedTheRow ? "refuse" : fate;
}

/**
 * The key element whose candidates are accumulating, so the bound applied where
 * they are allocated ({@link applyStep}, and the row's candidate accumulation in
 * {@link buildKeyStrings}) can locate its refusal by the same issue path the
 * per-value ceiling uses, paired with the fate a crossing there takes. One per
 * (element, row) on the partner-authored path; the fate is the whole key's.
 */
interface CandidateAccumulationSite {
  readonly keyIndex: number | undefined;
  readonly elementIndex: number;
  readonly rowIndex: number;
  readonly fate: AccumulationFate;
}

// The byte limb again, measured while the candidates accumulate rather than on
// the finished projection. The row index and the total are derived integers and
// the path locates the element by index, so the message echoes neither the value
// nor the partner's free text. The total is whichever accumulation crossed --
// one step's output set, or the row's retained candidates across the key's
// elements -- and the path names the element it was accumulating at, so the
// message states the key rather than attributing the whole total to that
// element.
//
// The fate here is the refusal, which is what a key {@link keyAccumulationFate}
// classifies `refuse` takes at either of its charges: one involving a producer
// unlisted in FAN_OUT_FUNCTION_NAMES, and one no producer can expand at all.
// A key classified `drop` takes {@link AccumulatedCandidatesDrop} at both.
function accumulatedCandidatesTooLongRefusal(
  site: CandidateAccumulationSite,
  accumulated: number,
): UsageError {
  return new UsageError(
    `a linkage key accumulated ${accumulated} characters of candidate ` +
      `values from row ${site.rowIndex} of this party's data ` +
      `(${keyElementPath(site.keyIndex, site.elementIndex)}), above the ` +
      `${MAX_ASSEMBLED_KEY_LENGTH_PER_ROW} characters of key strings this ` +
      "exchange builds for one row. A step that expands one value into several " +
      "candidates hands every later step each of them in turn, so the " +
      "candidates are allocated one after another and the total is bounded as " +
      "they accumulate rather than once the whole set exists. Nothing can be " +
      "shortened to fit: both parties must derive byte-identical keys. The " +
      "exchange is refused instead. Remove or narrow the expanding step in the " +
      "agreed linkage terms, or shorten the field the element reads.",
  );
}

// The drop a step's own expansion takes when it charges the accumulating total
// of a key classified `drop` past the cap, raised where the candidates are
// allocated so the expansion stops at the crossing rather than finishing a row
// that contributes nothing. It passes the total up to {@link buildKeyStrings},
// which owns a row's fate for the key round, and it reports no fault of the
// terms, so it is not a UsageError. That it reaches no operator is pinned by a
// test rather than asserted here: the class is unexported, and the shapes that
// raise it return a dropped row rather than propagating.
class AccumulatedCandidatesDrop extends Error {
  readonly accumulated: number;

  constructor(accumulated: number) {
    super("a declared fan-out expansion crossed the row's key-string bound");
    this.accumulated = accumulated;
  }
}

/**
 * How many rows one key round reports in full before it states the rest as a
 * count. The bounds a drop is taken at are crossed by the SHAPE of the terms and
 * the data, so terms that put every row over one of them drop every row: without
 * a ceiling here the operator's log holds one line per row per key, at a volume
 * the partner's authored terms choose. A handful of lines shows which rows and
 * which bound; the round's closing summary ({@link summarizeKeyRoundDrops})
 * states the totals the suppressed lines would have counted out one at a time.
 */
export const MAX_DROP_LINES_PER_KEY_ROUND = 5;

// What one key round has dropped: every row it dropped, how many of those it
// named in a line of their own, and the dropped total its last closing line
// stated. The last two are separate notions -- the individual-line allowance
// stops at MAX_DROP_LINES_PER_KEY_ROUND while the watermark follows the total --
// so a round closed twice states each further drop once and against the right
// number. One tally per ROUND rather than per key, so a sender and a receiver
// reading the same key object in one process keep their counts apart.
interface KeyRoundDropTally {
  dropped: number;
  reportedIndividually: number;
  summarizedThrough: number;
}

// A record whose candidate set for one key is too wide contributes nothing to
// that key's round and stays eligible for later keys, exactly as a record with no
// value for the key does. The row index and the derived counts name no value; the
// key name is partner-authored free text, so it is escaped at this sink.
function dropRowFromKeyRound(
  tally: KeyRoundDropTally,
  key: LinkageKey,
  index: number,
  reason: string,
): null {
  tally.dropped += 1;
  if (tally.reportedIndividually < MAX_DROP_LINES_PER_KEY_ROUND) {
    tally.reportedIndividually += 1;
    logger.warn(
      `row ${index}, key "${redactAndSanitizeForDisplay(key.name)}": ` +
        `${reason}, so the record contributes no value to this key's round ` +
        "and remains eligible for later keys",
    );
  }
  return null;
}

// The round's closing line for the rows its sink counted but neither named
// individually nor already summarized, on the same logger and level those lines
// use. It names counts and the key alone, as they do. Advancing the watermark to
// the dropped total makes it idempotent -- a second call has nothing left to
// state -- so a caller may close a round it has already closed. A round that goes
// on dropping past a close covers the further rows at its next one, worded as a
// count against that earlier line's total rather than against the exhausted
// individual-line allowance, which only the first summary is measured from.
function summarizeKeyRoundDrops(
  key: LinkageKey,
  tally: KeyRoundDropTally,
): void {
  const covered = Math.max(tally.reportedIndividually, tally.summarizedThrough);
  if (tally.dropped <= covered) return;
  const summarizedThroughBefore = tally.summarizedThrough;
  tally.summarizedThrough = tally.dropped;
  const escapedName = redactAndSanitizeForDisplay(key.name);
  const eligibility =
    "; each contributes no value to this key's round and remains eligible " +
    "for later keys";
  if (summarizedThroughBefore === 0)
    logger.warn(
      `key "${escapedName}": ${tally.dropped} rows dropped from this key's ` +
        `round, ${tally.dropped - tally.reportedIndividually} of them beyond ` +
        `the ${MAX_DROP_LINES_PER_KEY_ROUND} reported individually` +
        eligibility,
    );
  else
    logger.warn(
      `key "${escapedName}": ${tally.dropped - summarizedThroughBefore} ` +
        "further rows dropped from this key's round since its last summary, " +
        `${tally.dropped} in total` +
        eligibility,
    );
}

/**
 * How one party reads one key, all of it fixed for the whole run: the element
 * list this party's role selects (the receiver's swapped one for a key declaring
 * `swap`), the exchanged positions a refusal names, the fuzzy expansion each
 * position applies under that same role, and the fate a crossing of the
 * accumulating bound determines ({@link keyAccumulationFate}).
 *
 * Nothing here varies with the row, so a caller iterating a key's rows
 * ({@link StandardizedKeyIterable}) reads it once rather than repeating the walk
 * over every element's compiled steps per row.
 *
 * The plan is also what makes a round a scope the drop sink can count against:
 * the rows one plan builds are one key's round, and `drops` accumulates across
 * them.
 */
interface KeyReadPlan {
  readonly elements: LinkageKeyElement[];
  readonly pair: [number, number] | undefined;
  readonly fuzzyExpansions: ReadonlyArray<GenerateFuzzyComparisons | undefined>;
  /**
   * Whether this party also assembles the key in the order the terms AUTHOR it,
   * beside the swapped order {@link KeyReadPlan.elements} holds -- the swap's
   * full variant, which is what makes a swapped key match the two elements in
   * EITHER order rather than in the exchanged one alone. True on the receiver of
   * a key whose `swap` resolves, and only while
   * `APPLIED_SETTINGS.fuzzyComparisons` is on: a second key string per row is a
   * candidate set, which the cascade and the count-only round refuse, so it
   * lands with the round that consumes one exactly as the fuzzy expansion does.
   */
  readonly assemblesSwapVariant: boolean;
  readonly fate: AccumulationFate;
  /**
   * The candidate values one record may contribute to this key's round: the
   * width the agreed terms declare ({@link declaredKeyWidth}) times this
   * party's local fan-out factor -- the multiple by which its declared record
   * count is scaled. The product of the two is exactly this party's share of
   * the key's value slots per record, so a row within this bound can never
   * outgrow the slot bound the partner derives.
   */
  readonly width: number;
  readonly drops: KeyRoundDropTally;
}

// The expansion each element position actually applies, positionally aligned with
// `elements`. A receiver-only kind ({@link expandsOnReceiverOnly}) resolves to
// `undefined` on the sender, which builds that element's exact value alone; every
// other declaration resolves to itself on both parties. The designation is bound
// to the POSITION rather than to the column, which is why it is read off the
// swapped list: `swapElements` moves the field references and leaves each
// element's own expansion where it is (the terms schema requires a swap pair to
// declare the same one, so the two readings agree).
function planFuzzyExpansions(
  elements: ReadonlyArray<LinkageKeyElement>,
  isReceiver: boolean,
): ReadonlyArray<GenerateFuzzyComparisons | undefined> {
  return elements.map((element) => {
    const kind = element.generateFuzzyComparisons;
    if (kind === undefined) return undefined;
    return !isReceiver && expandsOnReceiverOnly(kind) ? undefined : kind;
  });
}

// The receiver assembles the authored order by exchanging the swap pair's two
// assembled candidate lists, which is the authored order exactly when the pair's
// two positions declare the same transform and the same expansion -- the shape
// the terms schema requires (config/linkageTerms.ts). Reading it off the terms
// again here rather than trusting that rule keeps the assumption a check: a key
// assembled outside the schema is refused instead of matching on a set neither
// order realizes. The key path locates the offender, as the width refusals do,
// so the message echoes none of the partner's free text.
function assertSwapPairPositionsAgree(
  key: LinkageKey,
  keyIndex: number | undefined,
): void {
  if (!swapPairTransformsDiffer(key) && !swapPairFuzzyComparisonsDiffer(key))
    return;
  const site =
    keyIndex === undefined
      ? "a linkage key"
      : `the linkage key at linkageKeys[${keyIndex}]`;
  throw new UsageError(
    `${site} declares a swap whose two elements do not declare the same ` +
      "transform and generate_fuzzy_comparisons. A swap moves the field " +
      "references and leaves each element's own transform and expansion in " +
      "place, so a mismatched pair would build one order from a column the " +
      "other order never reads. The exchange is refused instead. Give the " +
      "swapped pair one transform and one expansion in the agreed linkage " +
      "terms.",
  );
}

function planKeyRead(
  key: LinkageKey,
  dataset: StandardizedDataset,
  isReceiver: boolean,
  keyIndex?: number,
): KeyReadPlan {
  const { elements, pair } =
    isReceiver && key.swap
      ? swapElements(key.elements, key.swap)
      : { elements: key.elements, pair: undefined };
  const assemblesSwapVariant =
    pair !== undefined && APPLIED_SETTINGS.fuzzyComparisons;
  if (assemblesSwapVariant) assertSwapPairPositionsAgree(key, keyIndex);
  return {
    elements,
    pair,
    fuzzyExpansions: planFuzzyExpansions(elements, isReceiver),
    assemblesSwapVariant,
    fate: keyAccumulationFate(elements, dataset),
    width:
      declaredKeyWidth(key, keyIndex) *
      localFanOutFactor(dataset.declaresFanOut),
    drops: { dropped: 0, reportedIndividually: 0, summarizedThrough: 0 },
  };
}

/**
 * Build the candidate key strings one record contributes to one linkage key
 * round, given a standardized dataset and a row index.
 *
 * Returns `null` when the record contributes nothing to the round: an element's
 * field value set is empty (the `NULL`/absent realization), or a candidate set a
 * function in {@link FAN_OUT_FUNCTION_NAMES} expanded exceeds the width the key
 * declares ({@link declaredKeyWidth}) or a magnitude bound on the key strings one
 * row builds, which is dropped the same way and warned.
 * Otherwise it returns the deduplicated cross-product across the elements'
 * candidate values -- one entry per distinct combination, and a set of more than
 * one entry is a fan-out (docs/spec/PROTOCOL.md, Fan-out matching).
 *
 * All returned strings belong to the same original row at `index`; the caller
 * is responsible for preserving that association when adding entries to the PSI
 * set.
 *
 * `isReceiver` controls whether the key's `swap` directive is applied and which
 * fuzzy expansions run. The receiver builds keys with the named elements swapped
 * and applies every declared expansion; the sender does neither the swap nor an
 * expansion {@link expandsOnReceiverOnly} classifies (see
 * {@link planFuzzyExpansions}). Under
 * `APPLIED_SETTINGS.fuzzyComparisons` the receiver assembles the key in BOTH
 * orders rather than the swapped one alone, which is what makes a swapped key
 * match the two elements in either order; one party assembling both is what the
 * whole set of one-transposition variants is for, and the second party
 * assembling them too would only double the work
 * (docs/notes/one-sided-fuzzy-expansion.md).
 *
 * `keyIndex` is this key's position in the agreed terms' `linkageKeys`, kept
 * only so a magnitude refusal ({@link MAX_TRANSFORMED_VALUE_LENGTH},
 * {@link MAX_ASSEMBLED_KEY_LENGTH_PER_ROW}) can locate the offending element by
 * the same issue path the terms-validation refusals use. A caller that holds one
 * key alone omits it and the path is rooted at the element.
 *
 * An element whose expansion this party applies contributes its whole candidate
 * set to the cross-product rather than a single value, so a fuzzy element
 * multiplies the row's key strings by its candidate count. The expansion runs on
 * the element's TRANSFORMED value (see the note at the expansion site), every
 * candidate flows through the same final NFC pass, and the assembled count is
 * bounded by {@link declaredKeyWidth} -- the width the agreed terms declare for
 * the key, which compounds its elements' factors -- under the
 * {@link MAX_KEY_STRINGS_PER_ROW} assembly cap, a row above either
 * being refused rather than narrowed. It is gated on
 * `APPLIED_SETTINGS.fuzzyComparisons`: while that is false a fuzzy element builds
 * the same single key string as an element without one.
 *
 * One call is a round of its own, so a drop it takes is always reported in full:
 * a caller building a whole round row by row through this entry point reports one
 * line per dropped row, where {@link StandardizedKeyIterable} -- the round the
 * exchange runs -- reports the first {@link MAX_DROP_LINES_PER_KEY_ROUND} and
 * summarizes the rest.
 */
export function buildKeyStrings(
  key: LinkageKey,
  dataset: StandardizedDataset,
  index: number,
  isReceiver = false,
  keyIndex?: number,
): Set<string> | null {
  return buildKeyStringsUnderPlan(
    key,
    planKeyRead(key, dataset, isReceiver, keyIndex),
    dataset,
    index,
    keyIndex,
  );
}

// The row build under a plan the caller already holds. Unexported, and the
// entry point above takes no plan: a caller-supplied fate would be a lever for
// reading a key this build classifies `refuse` as a `drop` instead.
function buildKeyStringsUnderPlan(
  key: LinkageKey,
  {
    elements,
    pair,
    fuzzyExpansions,
    assemblesSwapVariant,
    fate,
    width,
    drops,
  }: KeyReadPlan,
  dataset: StandardizedDataset,
  index: number,
  keyIndex: number | undefined,
): Set<string> | null {
  const elementValues: string[][] = [];
  // Whether a fuzzy expansion this party applies actually widened the row, which
  // is what routes the width bound below to its refusal. Measured on the
  // expansion's own output rather than on the declaration: a kind that emits no
  // candidate for this value leaves the row exactly as wide as the producers
  // beside it made it, and the fate is theirs.
  let fuzzyWidened = false;
  // Whether any element contributed several candidates before fuzzy expansion --
  // the fan-out signature -- and, with the provenance beside it, what decides
  // whether the row is dropped or refused at the ASSEMBLED limbs, which run once
  // every element exists and so read what the row actually realized.
  let fansOut = false;
  // Which producer realized that multiplicity, accumulated across the row's
  // elements: the drop binds the DECLARED producers alone (see the drop sites).
  const provenance: FanOutProvenance = { fromUnlistedFunction: false };

  // The candidate characters this ROW's elements have retained so far. The
  // assembled projection below is reachable only once every element's candidates
  // exist, and an element transform runs once per realized field value, so a
  // step that amplifies a short value builds one amplified candidate per value
  // here without ever expanding one of them -- multiplicity the per-value
  // ceiling does not see. One total across the elements, not one per element:
  // what the bound holds is the row's live candidate set, and a per-element
  // total would let the element count (MAX_KEY_ELEMENTS) multiply the cap.
  let rowCandidateCharacters = 0;

  for (const [elementIndex, element] of elements.entries()) {
    const field = dataset.getField(element.field);
    const raw = field ? field.get(index) : [];
    if (raw.length === 0) return null;
    if (field?.fanOutFromUnlistedFunction(index))
      provenance.fromUnlistedFunction = true;

    const columnElementIndex = columnDeclaringElementIndex(pair, elementIndex);
    // The accumulation refusal names the element whose candidates these are: the
    // position that declares the steps producing them, or -- where the element
    // declares no transform and the candidates are the field's own realized
    // values -- the position that declares the column they were read from, which
    // on a swapped receiver is the sibling's.
    const site: CandidateAccumulationSite = {
      keyIndex,
      elementIndex:
        element.transform === undefined || element.transform.length === 0
          ? columnElementIndex
          : elementIndex,
      rowIndex: index,
      fate,
    };

    // A record contributes each DISTINCT candidate once, so duplicates collapse
    // as they land rather than multiplying the cross-product the width bound
    // measures: two raw values can transform to the same string, and two splits
    // can share a part. Charging the row's total on what the set RETAINS
    // (addCandidate, the footing the steps inside the element use) is what keeps
    // a collapsing transform -- every value of a multi-value cell mapped to one
    // candidate -- from being charged once per value for bytes the row holds
    // once.
    const transformed = new Set<string>();
    try {
      for (const v of raw) {
        const realized = applyElementTransform(
          v,
          element.transform,
          provenance,
          site,
          columnElementIndex,
        );
        // Added one at a time, never spread into a call: a spread passes the
        // candidates as arguments, and a field realizing one candidate per value
        // can hand this loop more of them than the engine accepts (measured
        // between 125,000 and 150,000 here, fewer wherever the stack is
        // smaller), which raises a RangeError in place of the assembly cap's
        // refusal below -- fail-closed, but reporting a fault the row does not
        // have.
        for (const candidate of realized)
          rowCandidateCharacters += addCandidate(transformed, candidate);
        // The same key fate the charge inside a step takes, so a row's outcome
        // does not turn on which of the two the crossing lands at either.
        if (rowCandidateCharacters > MAX_ASSEMBLED_KEY_LENGTH_PER_ROW) {
          if (
            accumulationFateAtCharge(fate, provenance.fromUnlistedFunction) ===
            "drop"
          )
            return dropRowFromKeyRound(
              drops,
              key,
              index,
              `accumulates ${rowCandidateCharacters} characters of candidate ` +
                "values across the key's elements, more than the " +
                `${MAX_ASSEMBLED_KEY_LENGTH_PER_ROW} characters of key ` +
                "strings this exchange builds for one row",
            );
          throw accumulatedCandidatesTooLongRefusal(
            site,
            rowCandidateCharacters,
          );
        }
      }
    } catch (err) {
      if (!(err instanceof AccumulatedCandidatesDrop)) throw err;
      return dropRowFromKeyRound(
        drops,
        key,
        index,
        `accumulates ${err.accumulated} characters of candidate values as a ` +
          "step runs over the values this key's declared fan-out expands, " +
          `more than the ${MAX_ASSEMBLED_KEY_LENGTH_PER_ROW} characters of ` +
          "key strings this exchange builds for one row",
      );
    }
    if (transformed.size === 0) return null;

    const candidates = [...transformed];
    if (candidates.length > 1) fansOut = true;

    // Fuzzy expansion runs AFTER the element transform, on the value that would
    // otherwise have been hashed. The transform is what puts a value in the
    // canonical space the partner's own value occupies, and a candidate can only
    // ever match there: `adjacent_years` needs the year at a known offset, which
    // only a parse_date transform guarantees, and expanding first would then feed
    // each candidate back through a pipeline free to collapse several to one
    // string or filter one to null -- shrinking the declared candidate set
    // silently.
    //
    // Gated on APPLIED_SETTINGS.fuzzyComparisons, the single source of truth both
    // consent surfaces annotate this term from. Flipping the flag belongs with
    // the round that consumes a candidate set: a fuzzy row would otherwise reach
    // a linkage strategy holding several candidates, which is refused, turning
    // the no-op the consent copy describes into an aborted exchange.
    //
    // The expansion is the ROLE-KEYED one the plan resolved, not the element's
    // raw designation: a receiver-only kind builds candidates on the receiver
    // and the exact value alone on the sender (see planFuzzyExpansions).
    const fuzzy = fuzzyExpansions[elementIndex];
    if (fuzzy === undefined || !APPLIED_SETTINGS.fuzzyComparisons) {
      elementValues.push(candidates);
      continue;
    }
    const expanded = candidates.flatMap((value) =>
      expandFuzzyComparisons(value, fuzzy),
    );
    if (expanded.length > candidates.length) fuzzyWidened = true;
    elementValues.push(expanded);
  }

  // Dropping on exceedance is normative for the DECLARED fan-out producers and
  // for them alone -- every rule of docs/spec/PROTOCOL.md (Fan-out matching)
  // binds `split_on`. Multiplicity any other function realized is outside that
  // rule and stays fail-closed at both bounds below: it is never traded for a
  // completed run that matches fewer records than the terms describe, but
  // passed to the strategy, which refuses it (fanOutReachedMatchingRefusal), or
  // refused here when the row cannot be assembled at all.
  const dropsOnExceedance = fansOut && !provenance.fromUnlistedFunction;

  // Bound the cross-product BEFORE materializing it: it multiplies each element's
  // candidate count, so a few wide elements multiply into a per-row set large
  // enough to exhaust memory as it is built. The count is a product of array
  // lengths, so it is known without allocating the product itself.
  //
  // A row this wide is over the key's declared width too, once assembled, in
  // every case but one: distinct combinations that concatenate to the same string
  // could in principle collapse a large product into a small candidate set. That
  // collapse is not measurable without the allocation this cap exists to prevent,
  // so a fan-out row is dropped on the projected count -- the same treatment an
  // over-width row gets, and never the run refusal, which the fan-out path does
  // not take, by design (docs/spec/PROTOCOL.md, The width bound). Fuzzy
  // expansion keeps the refusal, the fate it takes at the width bound below too,
  // as does multiplicity from a function outside FAN_OUT_FUNCTION_NAMES.
  // The swap's full variant assembles the key twice -- the swapped order and the
  // authored one -- from the same candidate lists, so both projections below take
  // the product times the number of orders assembled. The two orders can only
  // collide, never diverge in size, so the doubled projection bounds the union
  // exactly as the single one bounds the product.
  const ordersAssembled = assemblesSwapVariant ? 2 : 1;

  const projectedKeyStrings =
    ordersAssembled *
    elementValues.reduce((count, values) => count * values.length, 1);
  if (projectedKeyStrings > MAX_KEY_STRINGS_PER_ROW) {
    if (!dropsOnExceedance)
      throw keyStringFanOutCapRefusal(projectedKeyStrings, keyIndex);
    return dropRowFromKeyRound(
      drops,
      key,
      index,
      `expands into ${projectedKeyStrings} key-string combinations, more than ` +
        `the ${MAX_KEY_STRINGS_PER_ROW} this exchange assembles for one row`,
    );
  }

  // The byte limb of the same projection, on the counts and candidate lengths
  // already in hand: each of the projectedKeyStrings combinations holds one
  // candidate from every element, so element i contributes its whole candidate
  // total once per combination that selects from it -- the exact assembled
  // total, without materializing the product the count limb just bounded (which
  // is what keeps the multiplication small enough to be exact).
  //
  // Both limbs take the same fate. Dropping is normative for the declared
  // fan-out producers, and a row must not take different fates depending on
  // which limb of one projection fired.
  const projectedKeyStringLength = elementValues.reduce(
    (total, values) =>
      total +
      (projectedKeyStrings / values.length) *
        values.reduce((sum, value) => sum + value.length, 0),
    0,
  );
  if (projectedKeyStringLength > MAX_ASSEMBLED_KEY_LENGTH_PER_ROW) {
    if (!dropsOnExceedance)
      throw keyStringLengthCapRefusal(projectedKeyStringLength, keyIndex);
    return dropRowFromKeyRound(
      drops,
      key,
      index,
      `assembles ${projectedKeyStringLength} characters of key strings, more ` +
        `than the ${MAX_ASSEMBLED_KEY_LENGTH_PER_ROW} this exchange builds ` +
        "for one row",
    );
  }

  // Final NFC pass on the assembled key. Each part is already NFC, but this is
  // the one chokepoint every PSI key string flows through, so it also covers the
  // element-transform path (which assembles keys outside runCompiledPipeline) and
  // the case where concatenating two NFC parts crosses a base + combining-mark
  // boundary that itself composes (NFC is not closed under concatenation).
  const result = new Set(
    cartesianProduct(elementValues).map((parts) =>
      parts.join("").normalize("NFC"),
    ),
  );

  // The swap's other order, from the lists already built: exchanging the pair's
  // two candidate lists is the authored order because the pair's two positions
  // declare one transform and one expansion, which planKeyRead checked before
  // this row was read. A row whose two swapped values are equal realizes one
  // order, not two, so the widening is measured on what the union RETAINED --
  // the same footing the fuzzy expansion's own widening is measured on.
  if (assemblesSwapVariant && pair !== undefined) {
    const [idA, idB] = pair;
    const authoredOrder = [...elementValues];
    authoredOrder[idA] = elementValues[idB];
    authoredOrder[idB] = elementValues[idA];
    const swappedOrderOnly = result.size;
    for (const parts of cartesianProduct(authoredOrder))
      result.add(parts.join("").normalize("NFC"));
    if (result.size > swappedOrderOnly) fuzzyWidened = true;
  }

  // The width bound is measured on the assembled, DEDUPLICATED candidate set,
  // which is what a record contributes to the round, and it binds both candidate
  // producers, each on the fate its own exceedance rule names. A row that fans out
  // through a declared producer at all takes the drop, one that also expands
  // fuzzily included: the drop is that producer's normative behavior and a row
  // must not take two fates for one crossing. A row only a fuzzy expansion widened
  // is refused, on the same footing as the projection caps above -- the width this
  // key declares is the cap itself (KeyReadPlan.width), so contributing part of a
  // wider set would match on less than the terms declare while every derived bound
  // was computed as though the whole set fit.
  if (result.size > width) {
    if (dropsOnExceedance)
      return dropRowFromKeyRound(
        drops,
        key,
        index,
        `realizes ${result.size} candidate values, more than the ` +
          `${width} one record may contribute to this key`,
      );
    if (fuzzyWidened) throw fuzzyWidthCapRefusal(result.size, width, keyIndex);
  }

  // The operator advisory is a gate of its own, on the fan-out cap rather than
  // on the width the key declares: a row is called wide at the same count
  // whatever its key's width, where reading the width would put a privacy line
  // in front of the operator for every row two candidates wide on a width-1 key.
  if (result.size > FAN_OUT_CANDIDATES_PER_ELEMENT)
    logger.warn(
      `row ${index}, key "${redactAndSanitizeForDisplay(key.name)}": ` +
        `cross-product produced ${result.size} key strings ` +
        `(>${FAN_OUT_CANDIDATES_PER_ELEMENT}); a wide per-record expansion in ` +
        "dual-party-output exchanges may degrade privacy guarantees",
    );

  return result;
}

// --- Standardized key iterable ----------------------------------------------

/**
 * An {@link IndexableIterable} over a single {@link LinkageKey} round,
 * bridging the {@link StandardizedDataset} + {@link buildKeyStrings} pipeline
 * to the `Array<IndexableIterable<KeyCandidates>>` interface required by
 * `linkViaPSI` and `linkViaSinglePassPSI`.
 *
 * Per-row behaviour, the three {@link KeyCandidates} cases:
 * - `null` from {@link buildKeyStrings} -> `undefined` (record excluded from
 *   this round, and eligible for later keys).
 * - Singleton `Set<string>` -> the one string, unwrapped.
 * - Multi-value `Set<string>` -> the whole set, every candidate the record
 *   realized. Narrowing it here would match on less than the terms declare;
 *   single-pass matches the whole set, and the cascade refuses it
 *   ({@link fanOutReachedMatchingRefusal}) rather than narrowing.
 */
export class StandardizedKeyIterable {
  [index: number]: KeyCandidates;

  readonly length: number;
  private readonly key: LinkageKey;
  private readonly dataset: StandardizedDataset;
  private readonly isReceiver: boolean;
  private readonly keyIndex: number | undefined;
  // Read at the first row rather than in the constructor, so an element
  // transform that does not compile refuses from the row read rather than from
  // the construction of the round's iterables.
  private plan: KeyReadPlan | undefined;

  constructor(
    key: LinkageKey,
    dataset: StandardizedDataset,
    rowCount: number,
    isReceiver = false,
    keyIndex?: number,
  ) {
    this.key = key;
    this.dataset = dataset;
    this.length = rowCount;
    this.isReceiver = isReceiver;
    this.keyIndex = keyIndex;

    return new Proxy(this, {
      get: (target, prop, receiver) => {
        if (prop === Symbol.iterator)
          return target[Symbol.iterator].bind(target);
        if (prop === "length") return target.length;
        if (typeof prop === "string" && /^[0-9]+$/.test(prop))
          return target.at(Number(prop));
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  private valueAt(index: number): KeyCandidates {
    this.plan ??= planKeyRead(
      this.key,
      this.dataset,
      this.isReceiver,
      this.keyIndex,
    );
    const result = buildKeyStringsUnderPlan(
      this.key,
      this.plan,
      this.dataset,
      index,
      this.keyIndex,
    );
    // An empty set is the record-excluded sentinel like `null`, and a singleton
    // is unwrapped, so a set that survives to a consumer always holds two or
    // more candidates. `""` is a real value and reaches the round as one.
    if (result === null || result.size === 0) return undefined;
    if (result.size === 1) return result.values().next().value as string;
    return result;
  }

  *[Symbol.iterator](): Iterator<KeyCandidates> {
    for (let i = 0; i < this.length; i++) {
      yield this.valueAt(i);
    }
  }

  at(index: number): KeyCandidates {
    if (index < 0 || index >= this.length) return undefined;
    return this.valueAt(index);
  }

  /**
   * Close the round's drop reporting, emitting one summary line for the rows
   * dropped past the {@link MAX_DROP_LINES_PER_KEY_ROUND} reported in full.
   * Silent for a round that dropped nothing, or few enough to have reported
   * every one, and idempotent. A round read on past a close covers the rows it
   * drops after it at its next close, counted against the total that line
   * stated.
   *
   * The consumer calls it: a round is read by index as well as by iteration
   * (the cascade reads only the rows still unmatched after the previous key), so
   * the rows this round will be asked for are the consumer's to know, not this
   * object's.
   */
  summarizeDroppedRows(): void {
    if (this.plan !== undefined)
      summarizeKeyRoundDrops(this.key, this.plan.drops);
  }
}

// --- Validation --------------------------------------------------------------

/**
 * Validate that every standardization transformation output name corresponds to
 * a linkage field defined in the provided terms, and that every step function
 * name is known.
 *
 * Returns a list of error messages; an empty array means the standardization
 * spec is consistent with these terms. The output and function names embedded in
 * each message are interpolated raw -- consistent with the sibling
 * `assertPayloadSendDisclosed` / `validateCompatibility` guards -- because the
 * in-repo caller composes them into a {@link StandardizationTermsError}, where
 * the display boundary escapes them once. A caller that instead renders a
 * message directly owns that escape.
 */
export function validateStandardizationAgainstTerms(
  standardization: Standardization,
  terms: LinkageTerms,
): string[] {
  const errors: string[] = [];
  const fieldNames = new Set(terms.linkageFields.map((f) => f.name));

  for (const t of standardization) {
    if (!fieldNames.has(t.output)) {
      errors.push(
        `standardization output "${t.output}" does not match any linkage ` +
          "field name",
      );
    }
    for (const step of t.steps ?? []) {
      if (!STANDARDIZATION_FUNCTION_NAMES.includes(step.function)) {
        errors.push(
          `unknown standardization function ` +
            `"${step.function}" in transformation for ` +
            `"${t.output}"`,
        );
      }
    }
  }

  return errors;
}

/**
 * Fail closed when an AUTHORED ("authoritative") standardization contradicts its
 * linkage terms -- the throwing wrapper around
 * {@link validateStandardizationAgainstTerms}, so the mint boundary
 * (`psilink invite`) and {@link prepareForExchange} refuse an inconsistent config
 * with one identical, actionable error rather than each inlining the check. The
 * standardization sibling of `assertPayloadSendDisclosed`.
 *
 * Both classes the validator reports -- a transform output naming no declared
 * linkage field, and an unknown standardization function -- are structurally fatal
 * for an authoritative config; it reports no advisory class a config might
 * legitimately hold as a note. Callers gate this on
 * `standardization !== undefined`: an absent standardization is the
 * terms-only path, reconstructed FROM the terms
 * (via `getDefaultStandardization`) and so unable to contradict them, and is
 * not gated.
 *
 * Throws {@link StandardizationTermsError} (a {@link UsageError} subclass: the CLI
 * classifies it as a configuration error, exit 64; on the web it is the one
 * prepare-time fault whose message -- naming only the authoring party's own outputs
 * and functions -- is safe to show).
 */
export function assertStandardizationMatchesTerms(
  standardization: Standardization,
  terms: LinkageTerms,
): void {
  const inconsistencies = validateStandardizationAgainstTerms(
    standardization,
    terms,
  );
  if (inconsistencies.length > 0)
    throw new StandardizationTermsError(
      "this configuration's standardization is inconsistent with its linkage " +
        `terms: ${inconsistencies.join("; ")}. Correct the standardization or ` +
        "the linkage terms so every transform output names a declared linkage " +
        "field and every step function is known.",
    );
}

/**
 * Refuse transforms that declare a fan-out step under a linkage strategy that
 * matches a single value per record, before any matching begins.
 *
 * Fan-out matching is specified for the single-pass strategy and for it alone
 * (docs/spec/PROTOCOL.md, Fan-out runs under single-pass only), so terms naming
 * anything else are refused here: the cascade -- the schema default -- has no
 * fan-out realization, and a candidate set reaching it would be narrowed to less
 * than the terms declare. The gate is an ALLOWLIST rather than a cascade-named
 * denylist, so a strategy later added to `LinkageStrategySchema` refuses a
 * fan-out until it too realizes one. It is the fan-out sibling of
 * `assertAlgorithmImplemented` and `assertDeduplicateImplemented` in
 * `exchange.ts`, and it runs at the three points those use: when terms are
 * authored or minted, at the local prepare step, and at the agreed-terms run
 * boundary.
 *
 * Both authoring surfaces a fan-out step can reach are checked, because both
 * realize a candidate set: a standardization transformation feeds
 * {@link StandardizedField}, and a linkage-key element transform feeds
 * {@link buildKeyStrings}; either way the candidates cross into the key's
 * candidate set. `standardization` is omitted where the caller no longer holds one
 * (the run boundary reads a prepared exchange, which retains the built dataset
 * rather than the spec); what covers that half there is
 * {@link fanOutReachedMatchingRefusal} on the cascade, and on single-pass the
 * declared-width check its table build runs -- both at the point of harm, but
 * after this party's terms have gone on the wire.
 *
 * The asymmetry that half holds is why the local surface is refused here at all
 * rather than left to the strategy: an element-transform fan-out rides the agreed
 * terms and both parties refuse it in lockstep, while a standardization is
 * per-party and local, so a partner cannot derive its refusal and would be left
 * waiting on a run this party is about to abort.
 *
 * The two surfaces share the same message under DIFFERENT error classes,
 * because they differ in whose content the fault is. A `standardization` is
 * only ever this party's own: no invitation holds one (it is per-party and
 * local), and the
 * accept path derives its own from the adopted terms through
 * `getDefaultStandardization`, whose steps come from the fixed per-type pipelines
 * and never include a fan-out function. So that half is an
 * {@link OperatorConfigError} -- the membership rule for the actionable "config"
 * category both front ends key off -- like `assertSigningModeImplemented`, and
 * raised as the base class because no narrower member fits (this is an
 * unimplemented-feature refusal, not the terms inconsistency
 * {@link StandardizationTermsError} names). A linkage-key element transform is
 * adopted verbatim from the partner's invitation on the accept path, so that half
 * stays a plain {@link UsageError} whose message the web's generic alert swallows,
 * for the same reason as `assertAlgorithmImplemented`. Either way the message names
 * only the fan-out functions this module recognizes -- a declared name reaches it
 * having already matched one -- so no partner free text is interpolated, and the
 * CLI classifies both as a usage error (exit 64) through the base class.
 */
export function assertFanOutImplemented(
  terms: LinkageTerms,
  standardization?: Standardization,
): void {
  if (terms.linkageStrategy === "single-pass") return;
  for (const transformation of standardization ?? []) {
    const declared = declaredFanOutFunction(transformation.steps);
    if (declared !== undefined)
      throw new OperatorConfigError(fanOutDeclaredMessage(declared));
  }
  for (const key of terms.linkageKeys) {
    for (const element of key.elements) {
      const declared = declaredFanOutFunction(element.transform);
      if (declared !== undefined)
        throw new UsageError(fanOutDeclaredMessage(declared));
    }
  }
}

/**
 * The linkage fields in `terms` that the input `columns` cannot satisfy through
 * the available data standardizations. The verdict is derived from the same
 * {@link resolveFieldColumns} binding the exchange's {@link buildStandardizedDataset}
 * uses: a field is producible exactly when the shared resolution bound it to a
 * column that is present in `columns`. The checker does not re-derive the
 * binding itself, so it cannot diverge from the runtime: there is one
 * resolution rather than two, leaving the HIGH-severity direction (a field the
 * builder cannot produce but the checker passes) no second reading to arise
 * from.
 *
 * Because the binding is shared, the resolution rules apply unchanged: an
 * explicit standardization preempts the type fallback (a field whose explicit
 * source column is absent is unsatisfiable even when a same-typed column exists),
 * and the type fallback binds to the FIRST `role: linkage` metadata column of the
 * field's type. An empty result means every configured field can be produced; a
 * non-empty result names the fields that cannot.
 *
 * Pass `metadata` to match an exchange that runs from an explicit metadata block
 * (`prepareForExchange` resolves the type fallback against
 * `metadata ?? inferMetadata`); omit it to fall back to name-based inference, the
 * accept-path default.
 */
export function unsatisfiedLinkageFields(
  columns: string[],
  terms: LinkageTerms,
  standardization?: Standardization,
  metadata?: ColumnMetadata[],
): LinkageField[] {
  const present = new Set(columns);
  const resolution = resolveFieldColumns(
    terms,
    standardization,
    metadata ?? inferMetadata(columns),
  );
  // A field is producible iff the shared resolution bound it to a column present
  // in the input. The binding rules (explicit-preempts-fallback, first-match type
  // fallback) live in resolveFieldColumns, not here, so this verdict cannot drift
  // from the builder's.
  return terms.linkageFields.filter((f) => {
    const column = resolution.get(f.name)?.column;
    return column === undefined || !present.has(column);
  });
}

/**
 * Whether a `parse_date` step's INPUT format omits a date component the factory
 * requires, making {@link parseDateFactory} return null for EVERY value -- the
 * record is dropped regardless of its data. The motivating example is
 * `input_format: "MM/DD"` (no year): with no year token, the factory's `year`
 * component is never set and its all-three-components guard drops every value.
 *
 * The year component is supplied by EITHER year token ({@link YEAR_FORMAT_TOKENS}:
 * `YYYY` or `YY`), matching the factory, which populates `year` from whichever it
 * tokenizes; month needs `MM`, day needs `DD`.
 *
 * This mirrors {@link parseDateFactory}'s coercion exactly so the verdict cannot
 * drift from the runtime. A nullish input format falls back to the factory's
 * complete `"MM/DD/YYYY"`, which drops nothing. A non-nullish NON-string (wire
 * params are `z.unknown()`, so a partner can supply one) never yields a value at
 * runtime -- the factory coerces any non-string to an empty format that tokenizes
 * to an all-dropping pattern -- so it is dead, and is reported so WITHOUT calling
 * {@link parseDateFormat} on the non-string (which would throw on an array). For a
 * string input format the present component set is recovered from core's OWN
 * tokenizer ({@link parseDateFormat}), not a re-implemented scan -- the
 * encode-the-runtime-invariant-as-a-check rule, here over a "this never produces a
 * value" claim.
 */
export function parseDateInputDropsEveryRecord(
  params: Params | undefined,
): boolean {
  const raw = params?.inputFormat;
  if (raw === null || raw === undefined) return false;
  if (typeof raw !== "string") return true;
  const present = new Set(parseDateFormat(raw).order);
  const hasYear = YEAR_FORMAT_TOKENS.some((token) => present.has(token));
  return !hasYear || !present.has("MM") || !present.has("DD");
}

/**
 * The functions whose compiled step returns a value for EVERY value it is handed:
 * it may fold, erase to the empty string, pad, or expand that value, but it never
 * returns null (and never empties a candidate set, since erasing every candidate
 * to the empty string leaves the set non-empty). Every other function can leave a
 * realized value empty, which is the only way the substituting branch of a later
 * `coalesce` is ever reached.
 *
 * An ALLOWLIST rather than a list of the emptying functions, so a function added
 * to {@link STANDARDIZING_FUNCTIONS} without a decision here is treated as able
 * to empty a value -- as does a name this build does not recognize at all. That
 * over-states a `coalesce`'s reach on a consent surface, where understating it is
 * the harmful direction.
 *
 * Name-only, not params-aware: a `null_if` with an empty exclusion list and a
 * `filter_regex` matching everything drop nothing in practice, and each is still
 * classified as able to. Pinned to the real functions by a drift test that drives
 * every one of them over a value corpus.
 */
const VALUE_PRESERVING_FUNCTION_NAMES: ReadonlySet<string> = new Set([
  "remove_non_ascii",
  "replace_separators_with_spaces",
  "squash_spaces",
  "remove_punctuation",
  "remove_dashes",
  "trim_whitespace",
  "to_upper_case",
  "to_lower_case",
  "remove_accents",
  "remove_affixes",
  "pad_left",
  "replace_regex",
  "split_on",
  "coalesce",
]);

/**
 * Whether `step` can leave a value the record realized empty -- the position half
 * of {@link coalesceSubstitutesConstant}, since a `coalesce` substitutes only
 * where some earlier step has emptied the value.
 *
 * @internal exported so the drift test can hold this classification to the real
 * functions: each is driven over a value corpus, and one classified
 * value-preserving that returns null for any of them fails.
 */
export function stepCanEmptyRealizedValue(step: TransformStep): boolean {
  return !VALUE_PRESERVING_FUNCTION_NAMES.has(step.function);
}

/**
 * Whether the `coalesce` step at a given position actually substitutes its
 * fallback there. Two conditions, both necessary:
 *
 * - Its declared `default` is a string, the only shape {@link compileStep} turns
 *   into a substitution value. Wire params are `z.unknown()` with no per-function
 *   shape, so a partner can declare `default` as any JSON value (or omit it);
 *   every non-string behaves as an absent default, which {@link applyStep}'s
 *   coalesce branch runs as a pass-through.
 * - Some step BEFORE it can empty the value ({@link stepCanEmptyRealizedValue}).
 *   The branch that substitutes fires on a null value or an empty candidate set,
 *   and a pipeline starts from a non-null string -- {@link applyElementTransform}
 *   and {@link runCompiledPipeline} both take one -- so a coalesce reached with a
 *   value still in hand returns that value untouched. An ABSENT field never
 *   reaches the step either: {@link buildKeyStrings} drops the whole row for the
 *   key when the field realizes no value, and a field whose column is missing
 *   realizes none without running its pipeline at all. So the records a
 *   substituting coalesce puts on one constant are the ones an earlier RULE
 *   emptied, never the ones whose field is absent.
 *
 * `precedingSteps` are the steps that run before `step` in the same pipeline,
 * required rather than defaulted: the verdict is a property of the position, not
 * of the step alone.
 *
 * Shared so every terms-level reading of a coalesce's effect -- the dead-pipeline
 * rescue in {@link pipelineAlwaysDrops}, and the consent header's collapse marker
 * and per-step detail copy in `invitationSummary.ts` -- turns on one predicate
 * rather than a restated test that could drift from the runtime.
 */
export function coalesceSubstitutesConstant(
  step: TransformStep,
  precedingSteps: ReadonlyArray<TransformStep>,
): boolean {
  return (
    step.function === "coalesce" &&
    typeof step.params?.default === "string" &&
    precedingSteps.some(stepCanEmptyRealizedValue)
  );
}

// The half-open `[start, end)` index range a `substring` step reads out of a
// value of `valueLength` characters, or undefined where it reads nothing. This
// is the single reading of the substring convention: substringFactory slices by
// it at runtime, and the terms-level breadth verdicts here read it against a
// rendered layout without any data, so the two cannot drift.
//
// Guard both bounds by type, not just presence: the wire params are z.unknown()
// and typed by no per-function shape, so a partner can declare either as a
// non-integer (a string, float, or other JSON value). An unguarded non-number
// `length` turns `startIndex + length` into string concatenation, silently
// producing the wrong window rather than the intended one. A non-integer bound,
// or the `start === 0` no-op, reads nothing instead -- the ignore path a
// degenerate bound takes rather than crashing the partner-reachable key build.
//
// The two ends of the `String.prototype.slice` call this describes clamp by
// different rules: a NEGATIVE `length` drives the end argument below zero, where
// slice counts back from the end of the value rather than yielding the empty
// string, so such a step reads a real window running from the start bound to
// `valueLength + length`. Both bounds are determinate only because the caller
// supplies the length of the value being sliced.
function substringWindow(
  params: Params | undefined,
  valueLength: number,
): { start: number; end: number } | undefined {
  const start = params?.start;
  const length = params?.length;
  if (
    typeof start !== "number" ||
    !Number.isInteger(start) ||
    typeof length !== "number" ||
    !Number.isInteger(length) ||
    start === 0
  )
    return undefined;
  // SQL SUBSTR convention: a positive start is 1-indexed; a negative one counts
  // back from the end and clamps at the front of the value.
  const startIndex = start > 0 ? start - 1 : Math.max(0, valueLength + start);
  const endArgument = startIndex + length;
  const from = Math.min(startIndex, valueLength);
  const to =
    endArgument < 0
      ? Math.max(valueLength + endArgument, 0)
      : Math.min(endArgument, valueLength);
  // An end at or before the start slices "", which the factory returns as null.
  return to > from ? { start: from, end: to } : undefined;
}

/**
 * Whether a `substring` step's declared bounds read NOTHING out of a value of
 * ANY length -- the value-INDEPENDENT drop {@link pipelineAlwaysDrops} is built
 * from, as opposed to a window that merely overshoots the values one input
 * happens to hold. The motivating shape is a bound the operator never filled or
 * cleared mid-edit (`substring` with no `start`), which the terms schema admits
 * as well-formed while {@link substringFactory} nulls every row.
 *
 * The conditions, each a case where {@link substringWindow} returns no window
 * whatever `valueLength` it is handed:
 *
 * - `start` is not an integer, or is `0`. Both are the guard `substringWindow`
 *   opens with, which never consults the value.
 * - `length` is not an integer. Same guard.
 * - `length` is `0`: the end argument lands exactly on the start bound, and a
 *   window closing where it opens slices `""`.
 * - `length` is negative AND the composed end argument cannot outrun the start
 *   bound for any value. Two shapes reach that. A positive `start` whose
 *   `start + length >= 1` leaves the end argument at or above zero and at or
 *   below the start bound, so the window is empty at every length. A `start` of
 *   `-1` reads from the last character onward, and no negative `length` puts an
 *   end past it -- the end argument counting back from the value's own end
 *   lands at or before that last character for every length.
 *
 * A negative `length` in any OTHER combination reads a real window once the
 * value is long enough (`slice` counts a below-zero end argument back from the
 * end of the value), so it is the data's to decide and is not claimed here.
 * Whether a value is ever that long is the acceptor's data, which the terms do
 * not contain.
 *
 * The arithmetic is a second reading of {@link substringWindow}'s, which is what
 * a differential sweep in `standardization.test.ts` exists for: it drives the
 * shipped key builder over every bound pair in a grid and every value length a
 * window could open at, and fails on any pair where this verdict and the
 * measured one disagree in either direction.
 *
 * @internal exported so that sweep can compare the two readings, and so the
 * rescue-equivalence sweep can model the same drop source the shipped predicate
 * reads.
 */
export function substringWindowDropsEveryValue(
  params: Params | undefined,
): boolean {
  const start = params?.start;
  const length = params?.length;
  if (typeof start !== "number" || !Number.isInteger(start) || start === 0)
    return true;
  if (typeof length !== "number" || !Number.isInteger(length)) return true;
  if (length > 0) return false;
  return length === 0 || start === -1 || start + length >= 1;
}

/**
 * The dates {@link substringCollapsesParsedDateToConstant} measures a pipeline
 * over. Chosen so that the first two differ in EVERY digit of every rendered
 * component -- 1971 against 2068 in all four year digits, 01 against 12 in both
 * month digits, 02 against 31 in both day digits -- which is what makes "the
 * windows agree" the property the verdict claims rather than a coincidence of
 * one sample: a window reading any character the date supplied differs between
 * those two wherever the layout put it. The other two add digit variety for a
 * step that rewrites characters rather than moving them. Every year is inside
 * the `YY` pivot window (1969-2068, {@link TWO_DIGIT_YEAR_PIVOT}) and every date
 * is a real calendar date, so each probe is a value the factory can actually
 * emit whichever input format parsed it.
 *
 * These dates are public whether or not they are exported -- they ship in source
 * an inviter can read -- which is why a probe a declared step drops leaves the
 * verdict to the surviving ones rather than withdrawing it.
 *
 * @internal exported so the test that authors a step naming a probe's rendered
 * value names a real one rather than a date it assumes is probed.
 */
export const DATE_COLLAPSE_PROBES: ReadonlyArray<{
  year: string;
  month: string;
  day: string;
}> = [
  { year: "1971", month: "01", day: "02" },
  { year: "2068", month: "12", day: "31" },
  { year: "1990", month: "05", day: "13" },
  { year: "2007", month: "11", day: "24" },
];

// What a compiled run leaves one starting value on. The shapes are read apart
// because the verdicts below turn on WHICH of them was reached, not merely on
// whether a value was:
//
// - `value`: the characters the run holds, which is what a collapse compares
//   across probes.
// - `dropped`: the run produced no value, which is the opposite of a collapse
//   and, where the run is layout-determined, is every record's fate.
// - `candidates`: a non-empty candidate set, so the record still keys -- which
//   is what a collapsed constant needs of the pipeline's TAIL. A fan-out INSIDE a
//   measured run is a can't-measure that resolves upward like `unread`, and the
//   element declares a fan-out, so the consent header ranks that breadth above
//   this verdict regardless.
// - `unread`: the run could not be reduced to one of the readings above. A step
//   that leaves the value over the per-value ceiling
//   ({@link MAX_TRANSFORMED_VALUE_LENGTH}) reports it here, as does an empty
//   candidate set or an empty string -- shapes a window neither holds as a value
//   nor drops as null. The caller resolves an `unread` probe UPWARD to the
//   broader breadth word ({@link readParsedDateRun}): an inviter could otherwise
//   inflate one probe past the ceiling to buy a milder marker while every real
//   date still collapses.
type MeasuredRunOutcome =
  | { kind: "value"; value: string }
  | { kind: "dropped" }
  | { kind: "candidates" }
  | { kind: "unread" };

// The per-VALUE ceiling ({@link MAX_TRANSFORMED_VALUE_LENGTH}) is charged here as
// the runtime does; the per-ROW assembled charge
// ({@link MAX_ASSEMBLED_KEY_LENGTH_PER_ROW}) is not, because `applyStep` runs
// without a `site`. That charge binds the candidates a single row accumulates
// across a key's elements, which this per-element, per-probe measurement never
// assembles -- one probe date cannot reach it -- so its absence changes no
// reading. A measured limit, not an omission: the ceiling the marker rests on is
// checked; the row-assembly bound the exchange also enforces is out of this
// measurement's scope.
function runCompiledSteps(
  input: string,
  compiled: ReadonlyArray<CompiledStep>,
): MeasuredRunOutcome {
  let current: FieldValue = input;
  for (const step of compiled) {
    current = applyStep(current, step);
    if (valueOverCeiling(current) !== undefined) return { kind: "unread" };
  }
  if (current === null) return { kind: "dropped" };
  if (current instanceof Set)
    return current.size > 0 ? { kind: "candidates" } : { kind: "unread" };
  return current === ""
    ? { kind: "unread" }
    : { kind: "value", value: current };
}

/**
 * The functions whose effect on a value a `parse_date` rendered is fixed by
 * the output LAYOUT alone. Every date the factory renders under one output
 * format has the same length, and the format's own characters land in the same
 * places -- only the digits differ ({@link renderDateOutput} substitutes
 * fixed-width components) -- and each function here maps any two such values to
 * values that again share a length and are null together, so a window read after
 * it lands on the same characters for every date. That composes: a run built
 * only from these leaves every date holding a value, or drops every date.
 *
 * Membership is what parts a measured all-probes drop that is really DEAD from
 * one the data decides, and its converse is the safe side: a function absent
 * from the set makes such a run report a value-DEPENDENT drop, which announces
 * the wider breadth word rather than claiming an element matches nothing. So
 * only functions that read no content are here. `null_if`, `filter_regex`,
 * `extract_regex` and `replace_regex` turn on the value's own characters;
 * `remove_affixes` and `phonetic` match word content; a nested `parse_date` can
 * parse one rendering and not another; and `split_on` leaves a candidate set
 * rather than a value.
 *
 * @internal exported so the drift test can hold this classification to the real
 * functions: each name is driven over a corpus of dates under several output
 * formats, and one whose outputs differ in length or in null-ness between two
 * dates fails. That drives one params shape per function, so it catches a listed
 * function that starts reading content, not a listed function some other params
 * shape would expose; the membership decision itself stays a review call.
 */
export const LAYOUT_DETERMINED_FUNCTION_NAMES: ReadonlySet<string> = new Set([
  "remove_non_ascii",
  "replace_separators_with_spaces",
  "squash_spaces",
  "remove_punctuation",
  "remove_dashes",
  "trim_whitespace",
  "to_upper_case",
  "to_lower_case",
  "remove_accents",
  "substring",
  "pad_left",
  "coalesce",
]);

// What running a substring run's measured steps over {@link DATE_COLLAPSE_PROBES}
// establishes about the window the run reads.
//
// `undetermined` and `cannotMeasure` are read APART because they resolve in
// opposite directions on a consent surface:
//
// - `undetermined`: the shape conditions for a measurement are not met (the index
//   is not a run end, no live `parse_date` lies ahead, or the `parse_date` drops
//   every record), or the measurement COMPLETED and the surviving probes hold
//   distinct values -- a determinate coarsening. Nothing here understates a
//   collapse, so the caller resolves it to the milder / no-marker side.
// - `cannotMeasure`: the measurement could not be completed -- a step crossed the
//   per-value ceiling ({@link MAX_TRANSFORMED_VALUE_LENGTH}), expanded into a
//   candidate set, or a step this build cannot compile or run threw -- so the
//   window's breadth is unknown. An unknown breadth resolves UP to the collapse
//   word: understating breadth is the only harmful direction on a consent
//   surface, and an inviter must not buy the milder marker by making one probe
//   unmeasurable while every real date still collapses.
type ParsedDateRunReading =
  | { kind: "collapsed"; value: string }
  | { kind: "valueDependentDrop" }
  | { kind: "layoutDeterminedDrop" }
  | { kind: "undetermined" }
  | { kind: "cannotMeasure" };

const UNDETERMINED: ParsedDateRunReading = { kind: "undetermined" };
const CANNOT_MEASURE: ParsedDateRunReading = { kind: "cannotMeasure" };

/**
 * Run the steps from the `parse_date` that laid out the value to the end of the
 * substring run at `index` over the probe dates, and report what they leave the
 * window holding. Both terms-level verdicts below read this one measurement.
 *
 * The shape conditions, all necessary before anything is run:
 *
 * - `index` is the END of a maximal run of consecutive `substring` steps. A
 *   reading taken at a link INSIDE a run describes a window the run's later
 *   links can slice back out of range; the value a run leaves is the value its
 *   last link leaves.
 * - Some `parse_date` runs ahead of that run. The NEAREST one laid out the value
 *   the run reads; steps before it are unconstrained, since they can only change
 *   whether a value parses, never the layout a parsed date renders to.
 * - That `parse_date`'s input format can parse a date at all
 *   ({@link parseDateInputDropsEveryRecord}); one that cannot supplies no value
 *   to slice, and the drop is already the one {@link pipelineAlwaysDrops} names
 *   at the `parse_date` itself.
 *
 * A DROPPED probe does not defeat the reading. The probe dates are baked into
 * shipped public source, so requiring every one of them to survive would let a
 * single authored step naming one probe's rendered value -- a `null_if` on
 * "ACME-19710102" under an `ACME-YYYYMMDD` layout -- withdraw the verdict while
 * the pipeline still put every other date on one constant. The surviving probes
 * decide instead, and where NONE survives the reading turns on whether the run
 * is layout-determined ({@link LAYOUT_DETERMINED_FUNCTION_NAMES}): a run that
 * reads no content drops every date it will ever see, while one containing a
 * value-dependent step has told the measurement nothing, and the consent
 * direction there is the wider breadth word rather than the narrower one.
 *
 * A probe the measurement cannot READ -- one a step inflates past the per-value
 * ceiling, or expands into a candidate set -- and a step this build cannot
 * compile or run yield `cannotMeasure`, distinct from the determinate readings
 * above. Both resolve upward at the caller: the window's breadth is unknown, and
 * an inviter must not be able to buy a milder marker by making one probe
 * unmeasurable (a `replace_regex` that inflates a future-dated probe over the
 * ceiling, an unrecognized function name) while every real date still collapses
 * onto one constant.
 */
function readParsedDateRun(
  steps: ReadonlyArray<TransformStep>,
  index: number,
): ParsedDateRunReading {
  if (steps[index]?.function !== "substring") return UNDETERMINED;
  if (steps[index + 1]?.function === "substring") return UNDETERMINED;
  let runStart = index;
  while (runStart > 0 && steps[runStart - 1].function === "substring")
    runStart -= 1;
  let parseDateIndex = runStart - 1;
  while (parseDateIndex >= 0 && steps[parseDateIndex].function !== "parse_date")
    parseDateIndex -= 1;
  if (parseDateIndex < 0) return UNDETERMINED;
  const parseDateStep = steps[parseDateIndex];
  if (parseDateInputDropsEveryRecord(parseDateStep.params)) return UNDETERMINED;
  const rawOutputFormat = parseDateStep.params?.outputFormat;
  const outputFormat =
    typeof rawOutputFormat === "string"
      ? rawOutputFormat
      : DEFAULT_DATE_OUTPUT_FORMAT;
  const measuredSteps = steps.slice(parseDateIndex + 1, index + 1);
  try {
    // Only the steps up to the run's end are compiled here; the rest of the
    // pipeline is compiled by the caller that needs it, and only once a collapse
    // is established, so an element that collapses nowhere costs one pass over
    // each of its runs rather than one over its whole tail.
    const compiled = compileSteps([...measuredSteps]);
    const survivors = new Set<string>();
    for (const probe of DATE_COLLAPSE_PROBES) {
      const outcome = runCompiledSteps(
        renderDateOutput(outputFormat, probe.year, probe.month, probe.day),
        compiled,
      );
      // A probe the run cannot reduce to a value -- one inflated past the ceiling
      // or expanded into a candidate set -- leaves the window's breadth unknown,
      // so the reading resolves upward rather than falling to the milder word.
      if (outcome.kind === "unread" || outcome.kind === "candidates")
        return CANNOT_MEASURE;
      if (outcome.kind === "value") survivors.add(outcome.value);
      if (survivors.size > 1) return UNDETERMINED;
    }
    const [collapsed] = survivors;
    if (collapsed !== undefined) return { kind: "collapsed", value: collapsed };
    return measuredSteps.every((step) =>
      LAYOUT_DETERMINED_FUNCTION_NAMES.has(step.function),
    )
      ? { kind: "layoutDeterminedDrop" }
      : { kind: "valueDependentDrop" };
  } catch {
    // A step this build cannot compile or run gives no reading of what the window
    // holds. That is a can't-measure, not a determinate coarsening: the caller
    // resolves it up to the collapse word so an unrecognized function name cannot
    // buy the milder marker.
    return CANNOT_MEASURE;
  }
}

/**
 * Whether the `substring` at `index` of `steps` leaves every record that
 * survives an earlier `parse_date` holding the SAME constant -- the maximal
 * match breadth, not the truncation the step's name suggests. The motivating
 * shape is a window sliced wholly inside an output format's literal region
 * (`ACME-YYYYMMDD` read as `ACME`) or onto a bare separator, where the sliced
 * value holds no character the date supplied.
 *
 * MEASURED, not derived from the step names: the steps between the `parse_date`
 * and the run are compiled and RUN over {@link DATE_COLLAPSE_PROBES}, and the
 * verdict is that every probe still holding a value leaves the run on one
 * identical, non-empty one. Whether a step preserves what a window reads is a
 * property of the function AND of the window -- `remove_dashes` collapses a
 * four-character window of `ACME-YYYYMMDD` but not a five-character one -- so a
 * name allowlist of "layout-preserving" functions decides it wrongly in both
 * directions, and a layout-preservation table is a second reading of behavior
 * the factories already define. Running the shipped steps is the reading that
 * cannot drift from them, the same reason {@link coalesceSubstitutesConstant}
 * reads a step's params and position rather than its name. The one name set the
 * measurement does consult ({@link LAYOUT_DETERMINED_FUNCTION_NAMES}) answers a
 * different question -- whether a step can read the value's CONTENT at all --
 * and only to choose which way an undecided measurement falls.
 *
 * The conditions:
 *
 * - The run reads a layout some live `parse_date` ahead of it rendered, taken at
 *   the run's END -- the shape {@link readParsedDateRun} establishes and where
 *   the reasons for each of those live.
 * - Every probe that SURVIVES the run leaves it on one identical, non-empty
 *   value. A dropped probe does not withdraw the verdict: the probe dates ship
 *   in public source, so a single step naming one of their rendered values would
 *   otherwise buy the milder word for a pipeline that still puts every other
 *   date on the constant.
 * - Where no probe survives at all, the run is announced as a collapse unless it
 *   is layout-determined ({@link LAYOUT_DETERMINED_FUNCTION_NAMES}), in which
 *   case it drops every date and is the dead pipeline
 *   {@link substringRunDropsEveryParsedDate} names instead. A value-dependent
 *   step that drops all four probes has told the measurement nothing, and on a
 *   consent surface an undecided measurement takes the wider breadth word rather
 *   than the reassuring one.
 * - The collapsed value survives the REST of the pipeline. Every surviving
 *   record holds the same value by then, so what the remaining steps do to it is
 *   determinate with no probing at all: a later step that drops that one value
 *   drops every record still in hand, and an element matching nothing is not one
 *   matching every date. The all-probes-dropped case has no such value, so it
 *   takes the wider word without a tail reading.
 *
 * The measurement is bounded by the terms the schema already bounds: the steps
 * up to the run's end run once per probe and the rest of the pipeline once, on
 * values held to the same per-value ceiling the runtime enforces. A step it
 * cannot measure -- a function name this build does not recognize, a pattern that
 * fails to compile, or one that inflates a probe past that ceiling -- takes the
 * COLLAPSE word rather than the milder one: the window's breadth is unknown, and
 * understating it is the only harmful direction on a consent surface. That closes
 * the milder-word evasion -- an inviter cannot make one probe unmeasurable to
 * drop the marker while every real date still collapses onto one constant (a
 * probe inflated past the ceiling is driven in standardization.test.ts). A
 * legitimate partial-date transform does not cross the ceiling and is not an
 * unknown function, so it still measures cleanly and keeps its true milder
 * word; only a pathological or exchange-time-throwing pipeline takes the wider
 * one.
 *
 * The limit it keeps is a value-DEPENDENT drop the terms cannot determine, and
 * it runs in the over-claiming direction alone. A `filter_regex` or `null_if`
 * between the `parse_date` and the run is measured over the probes alone, so
 * one that passes them and drops a real record leaves the verdict standing;
 * one BEFORE the `parse_date` reads the acceptor's own values, which the terms
 * do not contain, so it is not measured at all; and one that drops every probe
 * hands the run the collapse word outright. Each can leave an element earning
 * "any date" while it in fact drops records it would have collapsed. Reading a
 * drop off such a step instead is the claim {@link pipelineAlwaysDrops}
 * declines for the same reason -- it would flag a legitimate pipeline as dead
 * -- so the residual is kept where it understates nothing.
 *
 * Shared so the consent header's collapse marker in `invitationSummary.ts` turns
 * on core's own steps rather than a restated reading of them.
 */
export function substringCollapsesParsedDateToConstant(
  steps: ReadonlyArray<TransformStep>,
  index: number,
): boolean {
  const reading = readParsedDateRun(steps, index);
  // A run whose breadth cannot be measured, and a value-dependent all-probes
  // drop, both resolve UP to the collapse word (see readParsedDateRun): the safe
  // direction on a consent surface.
  if (reading.kind === "cannotMeasure" || reading.kind === "valueDependentDrop")
    return true;
  if (reading.kind !== "collapsed") return false;
  try {
    const tail = runCompiledSteps(
      reading.value,
      compileSteps([...steps.slice(index + 1)]),
    );
    // Every surviving record holds `reading.value` by the run's end, so the tail
    // is determinate with no probing. Only a measured DROP withdraws the collapse
    // -- the element then matches nothing, which the dead-key advisory speaks for.
    // A tail that keeps a value or expands it to candidates keeps the collapse;
    // and a tail this build cannot measure (an over-ceiling value, an unknown
    // function) takes the collapse word too rather than the milder one, on the
    // same can't-measure-resolves-up rule the run itself follows.
    return tail.kind !== "dropped";
  } catch {
    return true;
  }
}

/**
 * Whether the `substring` run ending at `index` drops EVERY date an earlier
 * `parse_date` can render, whatever the acceptor's data -- the value-independent
 * certainty {@link pipelineAlwaysDrops} is built from, measured rather than
 * derived from the step names. The motivating shape is a run whose composed
 * window falls back out of range (`ACME-YYYYMMDD` sliced to `ACME`, then sliced
 * again from its fifth character), which reads nothing for any record while its
 * last link is still a `substring` a breadth marker would call a truncation.
 *
 * Claimed only where the measured steps are layout-determined
 * ({@link LAYOUT_DETERMINED_FUNCTION_NAMES}), so what the probes did is what
 * every date does. A run containing a value-dependent step that happens to drop
 * all four probes is NOT dead: the data decides it, which is the residual
 * {@link pipelineAlwaysDrops} declines to read from the terms.
 *
 * @internal exported so the rescue-equivalence sweep can model the same drop
 * source the shipped predicate reads.
 */
export function substringRunDropsEveryParsedDate(
  steps: ReadonlyArray<TransformStep>,
  index: number,
): boolean {
  return readParsedDateRun(steps, index).kind === "layoutDeterminedDrop";
}

/**
 * The transform params a CONSENT VERDICT reads, by function name: the values
 * that decide what the always-visible breadth marker says about an element,
 * rather than ones that only describe the step. A consent surface shows these
 * ahead of a step's other declared params, so neither the number of entries a
 * partner declares nor what it puts in them can displace the row a marker's
 * stated limits send the reader to.
 *
 * Each entry is the params some predicate here reads. `parse_date`'s two formats
 * decide {@link parseDateInputDropsEveryRecord} and the layout
 * {@link substringCollapsesParsedDateToConstant} measures; `substring`'s bounds
 * decide the window that measurement slices, and whether it opens at all
 * ({@link substringWindowDropsEveryValue}); `coalesce`'s `default` decides
 * {@link coalesceSubstitutesConstant}. These are the params whose value can push
 * the marker toward a MILDER word, so a partner must not be able to displace their
 * detail rows past the display cap.
 *
 * The collapse measurement also compiles and RUNS every step between the
 * `parse_date` and the substring run, so a `null_if`, `filter_regex`, or other
 * content step in that span participates in the reading -- its params (the values
 * a `null_if` drops on) change which probes survive. Those functions are still
 * absent here, by design: such a step can only move the reading toward the
 * BROADER word or leave a genuine coarsening, never toward an understatement. The
 * milder-versus-collapse boundary is whether the surviving probes are one value or
 * distinct, which is fixed by the LAYOUT the window reads -- the `parse_date`
 * formats and the `substring` bounds already listed -- and a content step run over
 * an already-identical set cannot manufacture distinct survivors from a collapse.
 * A drop it adds only widens the word (an all-probes drop is treated as
 * `valueDependentDrop`, "any date") or narrows real records the acceptor is not
 * harmed by not-seeing. So the ordering guarantee holds where it matters: no param
 * that could hide breadth is droppable. A function whose marker turns on its NAME
 * alone (`phonetic`, `replace_regex`, `pad_left`, and the rest) likewise has no
 * entry -- its name alone shows its marker.
 *
 * Held to those predicates by a test that moves each listed param and requires
 * the verdict to move with it, so a name listed here names a real verdict. What
 * that cannot see is the other direction -- a NEW param that could move the marker
 * toward the milder word arriving with no entry here -- which is a review call, as
 * the coercion table beside {@link describeTransformCoercions} has the same
 * shape of gap.
 */
export const CONSENT_VERDICT_PARAM_NAMES: Readonly<
  Record<string, ReadonlyArray<string>>
> = {
  parse_date: ["inputFormat", "outputFormat"],
  substring: ["start", "length"],
  coalesce: ["default"],
};

/**
 * Whether a transform/standardization pipeline produces NO value for every
 * possible input -- a self-defeating "dead" pipeline, determinable from the terms
 * alone without any data. Three value-INDEPENDENT drops are recognized: a
 * `parse_date` whose input format omits a required component
 * ({@link parseDateInputDropsEveryRecord}); a `substring` whose declared bounds
 * read no window out of a value of any length
 * ({@link substringWindowDropsEveryValue}), which needs no layout ahead of it
 * because the bounds settle it alone; and a `substring` run whose composed
 * window falls outside every layout an earlier live `parse_date` can render
 * ({@link substringRunDropsEveryParsedDate}), which is measured over probe dates
 * rather than composed arithmetically. A later `coalesce` with a string default
 * RESCUES a dropped value to that constant (see {@link applyStep}'s coalesce
 * branch), so a pipeline ending in such a coalesce is NOT dead -- it yields a
 * constant key, which the linkage layer treats as benign (a duplicated key
 * contributes no match but is no silent-empty hazard, the same reason the
 * coverage sweep does not flag a constant field). A coalesce BEFORE the drop, or
 * one with no string default, does not rescue.
 *
 * Steps whose drop behavior depends on the VALUE -- a `substring` whose window
 * overshoots the short values one input happens to hold and reads a real one
 * out of longer values, a `filter_regex` no value matches -- are NOT treated as
 * always-dropping, by design: that is the data-dependent residual the
 * satisfiability layer leaves to the runtime coverage sweep, and assuming it here
 * could wrongly flag a legitimate pipeline. Each claim above is held to that line:
 * a declared window is claimed only where NO value length opens it, and a run
 * measured over the probes only where every step in it reads the layout rather
 * than the content ({@link LAYOUT_DETERMINED_FUNCTION_NAMES}), so this still
 * reports a value-independent certainty alone and can never claim a producible
 * pipeline is dead.
 */
export function pipelineAlwaysDrops(
  steps: ReadonlyArray<TransformStep> | undefined,
): boolean {
  if (steps === undefined) return false;
  let dropped = false;
  for (const [index, step] of steps.entries()) {
    if (step.function === "coalesce") {
      // A string default substitutes a constant for a dropped value, rescuing it;
      // an undefined or non-string default leaves a dropped value dropped. The
      // shared predicate also tests a position half this loop's own reasoning does
      // not need; that it withholds no rescue here is held by the differential
      // sweep in standardization.test.ts ("pipelineAlwaysDrops rescue
      // equivalence") rather than asserted in this comment.
      if (dropped && coalesceSubstitutesConstant(step, steps.slice(0, index)))
        dropped = false;
      continue;
    }
    // A non-coalesce step null-propagates a dropped value, so once dropped the
    // pipeline stays dropped until a rescuing coalesce.
    if (dropped) continue;
    if (
      (step.function === "parse_date" &&
        parseDateInputDropsEveryRecord(step.params)) ||
      (step.function === "substring" &&
        substringWindowDropsEveryValue(step.params)) ||
      substringRunDropsEveryParsedDate(steps, index)
    )
      dropped = true;
  }
  return dropped;
}

/** How an input's columns fare against a set of linkage terms: which fields it
 * cannot produce, how many of the terms' linkage keys remain usable as a result,
 * and which otherwise-usable keys are self-defeating. A per-key coverage readout
 * for a surface that reports it; whether a run may proceed under these terms is
 * {@link LinkageTermsVerdict.fullySatisfied}, not a threshold read off
 * {@link satisfiableKeyCount}. */
interface LinkageSatisfiability {
  /** The linkage fields the columns cannot produce (see
   * {@link unsatisfiedLinkageFields}); empty when the input satisfies every field. */
  unsatisfied: LinkageField[];
  /** The number of linkage keys all of whose element fields are satisfiable.
   * This is the column-SHAPE verdict only -- it does not subtract
   * {@link deadKeys}, so it stays the count the differential test pins against the
   * builder's column resolution. */
  satisfiableKeyCount: number;
  /**
   * Keys the column-shape verdict PASSES (every element field resolves to a
   * present column) yet that still cannot match, because an element's declared
   * standardization can never produce a value regardless of the data -- a
   * self-defeating rule such as a `parse_date` whose input format omits a required
   * component (`input_format: "MM/DD"`, no year). Distinct from {@link unsatisfied},
   * which is about MISSING columns: here the columns are present but the rule is
   * dead, so the key would run to a silent empty result. Empty when no
   * shape-satisfiable key is self-defeating. Reported separately rather than
   * folded into {@link satisfiableKeyCount} so the count stays the column-shape
   * verdict and a surface can label the key with the right remedy (fix the terms,
   * not the CSV); the caller sanitizes the partner-controlled key names itself, as
   * it does for {@link unsatisfied}. Detection is value-independent only (see
   * {@link pipelineAlwaysDrops}): a data-dependent all-null collapse is left to
   * the runtime coverage sweep, not reported here. */
  deadKeys: LinkageKey[];
}

/**
 * Assess whether an input's `columns` can satisfy `terms`, for the surfaces that
 * report per-key coverage rather than decide whether a run may proceed. A key is
 * satisfiable only when EVERY element field is producible -- both declared in
 * `linkageFields` and resolvable from the columns -- since a single empty field
 * collapses the whole key for that record.
 *
 * This is a projection of {@link decideLinkageTermsVerdict}, which is where the
 * grading lives and which is what a run is held to: whether the terms may be run
 * at all is that verdict's `fullySatisfied`, not a threshold read off
 * {@link LinkageSatisfiability.satisfiableKeyCount} here. Callers own their own
 * message wording and display sanitization.
 *
 * `standardization` and `metadata` are the spec's explicit overrides, forwarded to
 * {@link unsatisfiedLinkageFields} so the verdict matches an exchange that runs
 * from them (the CLI `exchange` path passes both from its committed config; the
 * accept and web paths pass neither and rely on name inference).
 *
 * The satisfiability check is over column SHAPE, not row VALUES: a field whose
 * same-typed column exists but whose every row standardizes to empty (e.g. an
 * all-invalid date column) is reported satisfiable yet yields no key strings at
 * runtime. That residual is data-dependent and unavoidable from columns alone;
 * it can only over-claim "satisfiable", never wrongly block. The one exception is
 * value-INDEPENDENT: a key element whose declared standardization can never
 * produce a value (a self-defeating `parse_date` input format) is reported in
 * {@link LinkageSatisfiability.deadKeys}, derivable from the terms without data.
 * That is reported separately, not subtracted from {@link satisfiableKeyCount}:
 * the count stays the column-shape verdict, and a surface can label a dead key
 * with the right remedy (fix the terms, not the CSV).
 */
export function assessLinkageSatisfiability(
  columns: string[],
  terms: LinkageTerms,
  standardization?: Standardization,
  metadata?: ColumnMetadata[],
): LinkageSatisfiability {
  const verdict = decideLinkageTermsVerdict(
    columns,
    terms,
    standardization,
    metadata,
  );
  return {
    unsatisfied: verdict.unsatisfiedFields,
    satisfiableKeyCount: verdict.keys.length - verdict.unsatisfiableKeys.length,
    deadKeys: verdict.deadKeys,
  };
}

/**
 * How one declared linkage key fares against an input's columns:
 *
 * - `satisfiable` -- every element field resolves to a present column and no
 *   element declares cleaning that drops every record, so the key can produce key
 *   strings from this input.
 * - `unsatisfiable` -- at least one element field cannot be produced from the
 *   columns, so the key collapses to nothing for every record.
 * - `dead` -- every element field resolves, but an element's declared cleaning can
 *   never produce a value whatever the data (see {@link pipelineAlwaysDrops}), so
 *   the key passes the column check and still contributes nothing. Its remedy is a
 *   correction to the terms rather than a different input file, which is why it is
 *   graded apart from `unsatisfiable`.
 */
export type LinkageKeyFitness = "satisfiable" | "unsatisfiable" | "dead";

/** One declared linkage key beside the {@link LinkageKeyFitness} this input gives
 * it. */
interface GradedLinkageKey {
  /** The declared key, verbatim from the terms. */
  key: LinkageKey;
  /** How it fares against the input's columns. */
  fitness: LinkageKeyFitness;
}

/**
 * Whether an input may be run under a set of agreed linkage terms, and everything
 * a surface needs to say why not. This is the one home of that grading: a run is
 * refused unless the terms declare at least one linkage key and EVERY declared key
 * is `satisfiable`.
 *
 * All three failing shapes are the same fault -- the run would contribute nothing
 * for a key both parties agreed to match on -- so they are one rule rather than a
 * block beside a warning. Terms declaring no key are included because a derivation
 * can produce them: `linkageTermsFromRuleSet` narrows the built-in set to the keys
 * the columns support and narrows all the way to none, which a per-key threshold
 * would pass vacuously.
 */
export interface LinkageTermsVerdict {
  /** Whether the input may be run under these terms: at least one key declared,
   * and every declared key `satisfiable`. */
  fullySatisfied: boolean;
  /** Every declared key with its grade, in declaration order. Empty when the terms
   * declare no key. */
  keys: GradedLinkageKey[];
  /** The declared keys graded `unsatisfiable`, in declaration order. */
  unsatisfiableKeys: LinkageKey[];
  /** The declared keys graded `dead`, in declaration order. */
  deadKeys: LinkageKey[];
  /** The linkage fields the columns cannot produce (see
   * {@link unsatisfiedLinkageFields}). Empty when the input satisfies every
   * declared field -- including when keys are still unsatisfiable, which happens
   * when a key element references a field the terms never declare. */
  unsatisfiedFields: LinkageField[];
}

/**
 * Grade an input's `columns` against the linkage `terms` an exchange has agreed
 * to, and decide whether it may run under them. The fail-closed gate in
 * {@link prepareForExchange} enforces this verdict, and every front end that
 * checks earlier gives advance notice of the same decision rather than holding a
 * threshold of its own.
 *
 * `standardization` and `metadata` are the spec's explicit overrides, forwarded to
 * {@link unsatisfiedLinkageFields} so the grade matches an exchange that runs from
 * them. Pass the AUTHORED pair (both `undefined` where nothing is authored), which
 * is what a run resolves its own defaults from, so the advance notice and the gate
 * grade identical inputs.
 *
 * The grade is over column SHAPE, not row VALUES, with the one value-independent
 * exception `dead` covers; see {@link assessLinkageSatisfiability} for that
 * residual and why it can only over-accept, never wrongly refuse.
 */
export function decideLinkageTermsVerdict(
  columns: string[],
  terms: LinkageTerms,
  standardization?: Standardization,
  metadata?: ColumnMetadata[],
): LinkageTermsVerdict {
  const unsatisfiedFields = unsatisfiedLinkageFields(
    columns,
    terms,
    standardization,
    metadata,
  );
  const unsatisfiedNames = new Set(unsatisfiedFields.map((f) => f.name));
  // The set of field names that are BOTH declared and producible. A key element
  // referencing a name absent from this set is unsatisfiable -- whether the field
  // is declared-but-unproducible (in `unsatisfiedFields`) or not declared at all.
  // The latter is rejected upstream by LinkageTermsSchema's referential-integrity
  // refine (a key element `field` must name a declared linkage field), so a
  // schema-validated terms set cannot reach here with an undeclared reference;
  // this filter is kept as defense-in-depth for any terms not built through that
  // schema, since at exchange time an undeclared reference resolves to no values
  // (buildStandardizedDataset only builds declared fields, so getField returns
  // undefined and the key collapses to null) and grading such a key satisfiable
  // would let an incoherent terms set defeat the refusal this grading exists to
  // raise.
  const producibleNames = new Set(
    terms.linkageFields
      .map((f) => f.name)
      .filter((name) => !unsatisfiedNames.has(name)),
  );
  // The dead scan walks a key's element transform steps; each maximal substring
  // run re-measures a growing prefix per DATE_COLLAPSE_PROBES probe, so the
  // cost is QUADRATIC in an element's step count, not linear. Needs no separate
  // budget: both bounds it depends on are capped (an element's transform at
  // MAX_TRANSFORM_STEPS, the whole partner-supplied token at
  // MAX_ENCODED_INVITATION_LENGTH), and the operator's own committed-config
  // path already drives heavier per-row compile and RE2 work at exchange time,
  // so this scan is never the dominant cost.
  // parseDateInputDropsEveryRecord never calls parseDateFormat on a non-string, so
  // a hostile param shape cannot make it throw, and the measured run catches
  // whatever its own compile or run raises.
  const keys: GradedLinkageKey[] = terms.linkageKeys.map((key) => ({
    key,
    fitness: !key.elements.every((e) => producibleNames.has(e.field))
      ? "unsatisfiable"
      : key.elements.some((e) => pipelineAlwaysDrops(e.transform))
        ? "dead"
        : "satisfiable",
  }));
  const withFitness = (fitness: LinkageKeyFitness): LinkageKey[] =>
    keys.filter((graded) => graded.fitness === fitness).map((g) => g.key);
  const unsatisfiableKeys = withFitness("unsatisfiable");
  const deadKeys = withFitness("dead");
  return {
    fullySatisfied:
      keys.length > 0 &&
      unsatisfiableKeys.length === 0 &&
      deadKeys.length === 0,
    keys,
    unsatisfiableKeys,
    deadKeys,
    unsatisfiedFields,
  };
}

/**
 * Where the terms a shortfall is stated against stand between the two parties, so
 * the shared fragment fits the seat that renders it:
 *
 * - `"agreed"` -- both parties are held to these terms: an acceptor's adopted
 *   invitation, or a configuration an established exchange runs under. The keys
 *   are named as agreed, because narrowing them is an out-of-band step rather
 *   than an edit this operator can make.
 * - `"draft"` -- the operator's own terms, which no partner holds yet: the
 *   pre-invitation mint seats, where there is nobody to have agreed anything and
 *   the keys are the operator's own to change.
 */
export type LinkageTermsStanding = "agreed" | "draft";

/**
 * State, in one sentence fragment, how a verdict falls short of its terms: which
 * of the declared linkage keys the input's columns cannot produce, and which of
 * them declare cleaning that drops every record.
 *
 * Every surface that refuses on {@link decideLinkageTermsVerdict} phrases the
 * shortfall through this, so the run-boundary refusal and the pre-flight notice
 * ahead of it cannot describe the same fault in different words. Each clause
 * counts against the whole declared set rather than the other clause's remainder,
 * so a refusal holding one clause reads as well as one holding both.
 *
 * `standing` is the one thing the fragment takes from its seat: it is required
 * rather than defaulted so a new caller states where its terms stand instead of
 * inheriting a partnership it may not have (see {@link LinkageTermsStanding}).
 *
 * The fragment is fixed copy and counts only. Names are terms content --
 * partner-authored on every accept path -- and each caller places them on cause
 * links of its own.
 *
 * Terms declaring no key are not its case and yield nothing: that refusal names
 * the absent declaration itself, in copy each caller owns.
 */
export function summarizeLinkageShortfall(
  verdict: LinkageTermsVerdict,
  standing: LinkageTermsStanding,
): string {
  const total = verdict.keys.length;
  const qualifier = standing === "agreed" ? "agreed " : "";
  const keysPhrase = (count: number): string =>
    total === 1
      ? `the one ${qualifier}linkage key`
      : count === total
        ? `all ${total} ${qualifier}linkage keys`
        : `${count} of the ${total} ${qualifier}linkage keys`;
  const shortfalls: string[] = [];
  if (verdict.unsatisfiableKeys.length > 0)
    shortfalls.push(
      `${keysPhrase(verdict.unsatisfiableKeys.length)} cannot be produced ` +
        "from this input's columns",
    );
  if (verdict.deadKeys.length > 0)
    shortfalls.push(
      `the cleaning declared for ${keysPhrase(verdict.deadKeys.length)} ` +
        "drops every record",
    );
  return shortfalls.join(", and ");
}

/**
 * Fail closed, before any credential, terms, or data are sent, on an input that
 * cannot fully satisfy the agreed linkage terms -- the run-boundary enforcement of
 * {@link decideLinkageTermsVerdict}, called from {@link prepareForExchange}.
 *
 * Terms declaring no linkage key at all are refused here too: the run would
 * have nothing to match on and would produce a result indistinguishable from an
 * empty intersection, so it is refused before any credential, terms, or data
 * are sent.
 *
 * The terms name the keys both parties consented to match on. A run that
 * contributes nothing for one of them matches on fewer keys than were agreed while
 * its exchange record still names every field the terms declare, so the shortfall
 * is settled with the partner out of band rather than run anyway. The remedy is
 * therefore stated as new terms or a conforming input, never as a retry: the same
 * input refuses identically every time.
 *
 * The summary is stated on the `"agreed"` standing: this is the boundary of a run,
 * and a run is held to the terms its partner is held to, whoever authored them.
 * The seats that hold terms no partner has yet state the same shortfall in their
 * own first-party copy, ahead of this.
 *
 * The summary holds only fixed copy and counts. The field and key names are
 * terms content -- partner-authored on every accept path -- so each category rides
 * a labelled cause link of its own, raw: the display boundary that renders the
 * chain caps each link independently and is the one altitude that escapes them, so
 * a name can only ever spend the budget of the link it shares with its own kind,
 * and the count leads each link so a truncated one still reports how much is
 * unread.
 */
export function assertLinkageTermsSatisfiable(
  columns: string[],
  terms: LinkageTerms,
  standardization?: Standardization,
  metadata?: ColumnMetadata[],
): void {
  const verdict = decideLinkageTermsVerdict(
    columns,
    terms,
    standardization,
    metadata,
  );
  if (verdict.fullySatisfied) return;

  if (verdict.keys.length === 0)
    throw new LinkageTermsUnsatisfiableError(
      "the agreed linkage terms declare no linkage key, so this exchange has " +
        "nothing to match on and is refused before any credential, terms, or " +
        "data are sent. Run it with an input whose columns can supply at " +
        "least one linkage key, or agree terms declaring one with your " +
        "partner and run the exchange under those.",
    );

  const details: string[] = [];
  if (verdict.unsatisfiedFields.length > 0)
    details.push(
      `unsatisfied linkage fields (${verdict.unsatisfiedFields.length}): ` +
        verdict.unsatisfiedFields
          .map((field) => `${field.name} (${field.type})`)
          .join(", "),
    );
  if (verdict.deadKeys.length > 0)
    details.push(
      `linkage keys whose cleaning drops every record ` +
        `(${verdict.deadKeys.length}): ` +
        verdict.deadKeys.map((key) => key.name).join(", "),
    );
  if (verdict.unsatisfiableKeys.length > 0)
    details.push(
      `linkage keys this input cannot produce ` +
        `(${verdict.unsatisfiableKeys.length}): ` +
        verdict.unsatisfiableKeys.map((key) => key.name).join(", "),
    );

  throw new LinkageTermsUnsatisfiableError(
    `this input cannot satisfy every linkage key the agreed terms declare: ` +
      `${summarizeLinkageShortfall(verdict, "agreed")}. The exchange is ` +
      "refused before any credential, terms, or data are sent: it would match " +
      "on fewer keys than both parties agreed to while its exchange record " +
      "still names every field those terms declare. Settle the shortfall with " +
      "your partner out of band -- agree terms over the keys and fields both " +
      "files can supply, and run the exchange under those -- or run it with " +
      "an input file that satisfies the terms already agreed.",
    details.length > 0
      ? { cause: chainDetailCauses(details as [string, ...string[]]) }
      : undefined,
  );
}

// --- Value-level constraints -------------------------------------------------
//
// "Does a cleaned value meet a field's declared constraints?" -- the value-level
// companion to validateStandardizationAgainstTerms (which checks only NAMES: that
// standardization outputs map to declared fields, and that step function names are
// known). The web's constraint badges and the CLI's prepare-path warnings run
// ONE implementation.
//
// Advisory throughout, matching the LinkageField constraint contract ("the
// application warns if violated but does not enforce them",
// config/linkageTerms.ts): nothing here throws or rejects a value; each
// surface decides how to present the result (a web badge, a CLI warning line).
//
// Coverage is authoritative: every constraint with a CLEAN value-level test is
// checked, and one that has none is left UNFLAGGED rather than guessed at, so
// a warning never fires on a value the check cannot actually judge.
//
//   - exclude (all field types), allowedCharacters (name fields), date_of_birth
//     validOnly, ssn validOnly: checked.
//   - ssn4 validOnly: checked for the ONE SSA structural rule a bare last-four
//     can be judged against -- the serial is not 0000. The last four digits ARE
//     the serial; the area/group rules and the 9-digit-only checks have no
//     last-four analogue (see isStructurallyValidSsn4).
//   - affixesAllowed (name fields): NOT checked, by design. Whether affixes
//     were removed is a pipeline choice, not a defect of the value: a residual-
//     honorific test would collide with legitimate name values ("Judge" and
//     "Miss" are real surnames), so there is no clean value-level property to
//     flag. This would need revisiting only if affix membership became an
//     exact, collision-free set.

/**
 * The kind of value-level constraint a cleaned value violated. A stable,
 * partner-independent discriminant a surface can branch on; the fixed
 * {@link ConstraintViolation.label} / `detail` copy is keyed off it.
 *
 * - `excluded` -- the value is on the field's agreed `exclude` denylist (any
 *   field type).
 * - `disallowedCharacters` -- a name value includes a character outside the
 *   field's `allowedCharacters` class.
 * - `invalidDate` -- a `date_of_birth` value in canonical YYYYMMDD form names no
 *   real calendar day (under `validOnly`).
 * - `invalidSsn` -- a 9-digit `ssn` value breaks an SSA structural rule (under
 *   `validOnly`).
 * - `invalidSsn4` -- a 4-digit `ssn4` value is the all-zero serial 0000, the one
 *   SSA structural rule a bare last-four can be judged against (under `validOnly`).
 */
type ConstraintViolationKind =
  | "excluded"
  | "disallowedCharacters"
  | "invalidDate"
  | "invalidSsn"
  | "invalidSsn4";

/**
 * A single value-level constraint violation: an advisory signal that a
 * cleaned value does not meet one of a field's declared constraints. The `kind`
 * is a stable discriminant; `label` and `detail` are FIXED copy keyed off it --
 * never a partner-controlled value -- so a surface may render them verbatim (the
 * web workbench badge) or print them (the CLI), or switch on `kind` for its own
 * wording. An empty result from {@link checkValueConstraints} means the value
 * conforms to every constraint that has a clean value-level test.
 */
interface ConstraintViolation {
  /** Stable, partner-independent discriminant; see {@link ConstraintViolationKind}. */
  kind: ConstraintViolationKind;
  /** Short fixed badge caption (e.g. "excluded value"). */
  label: string;
  /** One-line fixed plain-language explanation of the violation. */
  detail: string;
}

/** Whether `value` contains only characters in the field's `allowedCharacters`
 * class. `allowedCharacters` is partner-controlled (it arrives in the invitation
 * token), and {@link NameConstraintsSchema} only checks that it compiles as
 * the body of a `[...]` class -- not that it cannot break out of one. A
 * crafted value can close the class and inject regex structure (e.g.
 * `x](a+)+b[y`).
 *
 * Two hazards, both guarded here:
 *
 * (1) ReDoS: the class is compiled under the linear-time engine the
 * transform-regex paths use ({@link compileLinearRegex}, re2js), so no partner
 * pattern reaches the backtracking native engine. A pattern that engine cannot
 * compile is treated as uncheckable (no violation, fail-open); {@link
 * NameConstraintsSchema} validates the class under the same engine, so that
 * fail-open path is unreachable for a class that passed terms validation.
 *
 * (2) Warning suppression, three sub-cases:
 *   - A breakout that injects a multi-character span or an empty-matchable
 *     alternation branch (`a]|.*[b`, `(a+)+`) is closed by testing each value
 *     one code point at a time as a FULL, anchored match (re2js `matches()`),
 *     not an unanchored find.
 *   - A leading `^`, which re2js treats as class negation, is closed by
 *     escaping it (and a following `-`) to a literal. A class that fails to
 *     compile once escaped is over-flagged rather than failed open.
 *   - A class or branch that genuinely admits the single code point (a
 *     shorthand or Unicode property class, or an effective allow-all reached
 *     via breakout) is accepted as a limit rather than closed: it is
 *     indistinguishable from a legitimate permissive class, and since this
 *     check only warns rather than blocking, the consequence is a suppressed
 *     advisory badge, never a data-filtering or match-correctness effect.
 *
 * Every sub-case is pinned by tests in standardization.test.ts. For a
 * legitimate class the per-code-point test is exactly `^[allowed]*$` (every
 * character must be in the class). The empty string trivially conforms.
 */
function withinAllowedCharacters(value: string, allowed: string): boolean {
  // A leading `^` is class NEGATION in re2js (`[^...]`), which would invert this
  // check and suppress the advisory on every UNLISTED character. Escape it to a
  // literal caret; escape a `-` immediately after it too, or `\^-X` would read as a
  // range instead of a literal caret. If the escaped class still will not compile
  // (an exotic leading-`^` combination), the catch over-flags rather than failing
  // open. See the header (2) for the families this does and does not close.
  let classBody = allowed;
  if (allowed.startsWith("^-")) classBody = `\\^\\-${allowed.slice(2)}`;
  else if (allowed.startsWith("^")) classBody = `\\^${allowed.slice(1)}`;
  let oneOf: CompiledLinearRegex;
  try {
    oneOf = compileLinearRegex(`^[${classBody}]$`);
  } catch {
    // The escaped form did not compile. If the raw class does (an exotic leading-`^`
    // combination such as `^]A[`, where the literal `\^` lets a following `]` close
    // the class), our escape -- not the partner's class -- broke it: over-flag
    // rather than fail open, which would suppress the advisory on every value,
    // as a leading-`^` negation would otherwise achieve. A class that compiles
    // neither way is genuinely uncheckable: fail open, as header (1) describes.
    try {
      compileLinearRegex(`^[${allowed}]$`);
    } catch {
      return true;
    }
    return false;
  }
  for (const character of value) if (!oneOf.matches(character)) return false;
  return true;
}

/** Whether a standardized value is a valid calendar date in canonical YYYYMMDD
 * form -- the output the default `date_of_birth` pipeline produces. A value not in
 * that form is not flagged (the operator may target a different output format, and
 * a false "invalid date" badge would mislead); only an 8-digit value that names no
 * real calendar day is. */
function isValidStandardizedDate(value: string): boolean {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (match === null) return true;
  const [, year, month, day] = match;
  return isCalendarDateValid(year, month, day);
}

/** Whether a 9-digit value satisfies the SSA structural rules: area not 000 or
 * 666 and below 900, group not 00, serial not 0000. A value that is not exactly 9
 * digits is left to the format-shaping pipeline and not flagged here. */
function isStructurallyValidSsn(value: string): boolean {
  if (!/^\d{9}$/.test(value)) return true;
  const area = Number(value.slice(0, 3));
  const group = Number(value.slice(3, 5));
  const serial = Number(value.slice(5, 9));
  return (
    area !== 0 && area !== 666 && area < 900 && group !== 0 && serial !== 0
  );
}

/** Whether a 4-digit `ssn4` (last-four / serial) value satisfies the one SSA
 * structural rule a bare last-four can be judged against: the serial is not 0000.
 * The last four digits of an SSN are the serial, and the SSA never issues serial
 * 0000; the area/group rules and the 9-digit-only checks have no last-four
 * analogue, so 0000 is the whole judgeable surface. A value that is not exactly 4
 * digits is left to the format-shaping pipeline and not flagged, mirroring the
 * 9-digit scoping of {@link isStructurallyValidSsn}. */
function isStructurallyValidSsn4(value: string): boolean {
  if (!/^\d{4}$/.test(value)) return true;
  return value !== "0000";
}

// Memoized `exclude` denylists, keyed by the constraint's `exclude` ARRAY
// identity, so the membership test is an O(1) Set lookup rather than an O(n)
// `Array.includes` scan. The dataset sweep (summarizeDatasetConstraintViolations)
// calls checkValueConstraints once per produced value per row against the SAME
// field -- hence the same `exclude` array reference -- so without this a
// hostile-but-schema-valid denylist (partner-controlled, count-bounded only at the
// generous MAX_EXCLUDE_ENTRIES) would re-scan up to that bound on every row, a
// per-row cost unbounded by row count over a large dataset. This is the
// exclude-denylist sibling of {@link compiledElementTransforms}' per-row recompile
// guard. A WeakMap keyed on the array releases the Set with the terms, and the
// parsed terms reuse the array reference across rows, so a legitimate sweep builds
// each Set once; Set membership is byte-identical to Array.includes for strings.
const excludeDenylistSets = new WeakMap<readonly string[], Set<string>>();

function isExcludedValue(
  exclude: readonly string[] | undefined,
  value: string,
): boolean {
  if (exclude === undefined) return false;
  let set = excludeDenylistSets.get(exclude);
  if (set === undefined) {
    set = new Set(exclude);
    excludeDenylistSets.set(exclude, set);
  }
  return set.has(value);
}

/**
 * Report which of a linkage `field`'s declared constraints a single cleaned
 * `value` violates -- the value-level constraint check the web workbench renders
 * as badges and the CLI reports as warnings. Returns the violations as advisory
 * signals; an empty array means the value conforms to every constraint that has
 * a clean value-level test. Warn, never block (see the section note above): a
 * violation is reported, never thrown.
 *
 * A constraint with no clean value-level test is intentionally NOT flagged, so a
 * warning never fires on a value the check cannot actually judge: `affixesAllowed`
 * is omitted by design, and `date_of_birth` / `ssn` / `ssn4` `validOnly` only
 * judge a value of the constraint's canonical width (see each helper). The copy
 * returned is fixed and keyed off the violated constraint --
 * never a partner-controlled value -- so it is safe to render or print verbatim.
 */
export function checkValueConstraints(
  field: LinkageField,
  value: string,
): ConstraintViolation[] {
  const constraints = field.constraints;
  if (constraints === undefined) return [];
  const violations: ConstraintViolation[] = [];

  // `exclude` is shared by every constraint shape: the cleaned value must not be
  // one of the listed values. Membership is memoized per denylist (see
  // {@link isExcludedValue}) so a per-row sweep does not re-scan it each row.
  if (isExcludedValue(constraints.exclude, value))
    violations.push({
      kind: "excluded",
      label: "excluded value",
      detail: "This cleaned value is on the agreed excluded-values list.",
    });

  switch (field.type) {
    case "first_name":
    case "last_name": {
      // `affixesAllowed` is intentionally not checked here -- it has no clean
      // value-level test (see the section note).
      const allowed = field.constraints?.allowedCharacters;
      if (allowed !== undefined && !withinAllowedCharacters(value, allowed))
        violations.push({
          kind: "disallowedCharacters",
          label: "disallowed characters",
          detail:
            "This cleaned value contains characters outside the field's allowed set.",
        });
      break;
    }
    case "date_of_birth":
      if (
        field.constraints?.validOnly === true &&
        !isValidStandardizedDate(value)
      )
        violations.push({
          kind: "invalidDate",
          label: "invalid date",
          detail: "This cleaned value is not a valid calendar date.",
        });
      break;
    case "ssn":
      if (
        field.constraints?.validOnly === true &&
        !isStructurallyValidSsn(value)
      )
        violations.push({
          kind: "invalidSsn",
          label: "invalid SSN",
          detail:
            "This cleaned value does not meet the Social Security Administration's structural rules.",
        });
      break;
    case "ssn4":
      if (
        field.constraints?.validOnly === true &&
        !isStructurallyValidSsn4(value)
      )
        violations.push({
          kind: "invalidSsn4",
          label: "invalid SSN (last 4)",
          detail:
            "This cleaned value is the all-zero serial 0000, which the Social Security Administration never issues.",
        });
      break;
    case "phone_number":
    case "email_address":
    case "zip_code":
      // Only `exclude` (handled above) has a clean value-level test for these
      // types; nothing further to check.
      break;
  }

  return violations;
}

/**
 * A per-field aggregate of value-level constraint violations across a whole
 * standardized dataset: how many produced values of one linkage field tripped one
 * constraint kind. The CLI's exchange/prepare path reports these (one line per
 * entry) where the web workbench shows per-value badges, so it reports a COUNT --
 * not the offending values, which are the operator's own data and are never echoed
 * into a log.
 */
interface ConstraintViolationSummary {
  /** The linkage field name whose values violated. Partner-controlled on the
   * accept path (adopted from the inviter's terms via
   * {@link deriveAcceptedLinkageTerms}), so a display surface must sanitize it. */
  field: string;
  /** The constraint kind violated; see {@link ConstraintViolationKind}. */
  kind: ConstraintViolationKind;
  /** The fixed badge caption shared with {@link ConstraintViolation.label}, so a
   * caller need not re-derive copy from the kind. */
  label: string;
  /** How many produced values across the dataset tripped this kind. */
  count: number;
}

/**
 * Sweep a {@link StandardizedDataset} and aggregate the value-level constraint
 * violations its produced values trip, per (field, kind), for the linkage fields a
 * linkage key actually references. Runs the same per-value
 * {@link checkValueConstraints} the web workbench renders badges from -- one
 * implementation, so the two surfaces never disagree on whether a given value
 * violates a constraint (they differ in WHICH fields they cover: the web badges
 * the field being edited, this sweep scopes to key-referenced fields, below).
 * Advisory: it only counts; it never throws or rejects a value, and the caller
 * decides how to report the result (the CLI logs a warning per entry and
 * proceeds). An empty result means every produced value conforms.
 *
 * The sweep is scoped to key-referenced fields because the exchange standardizes
 * and consumes only those (via {@link StandardizedKeyIterable}): a constraint
 * violation on a declared field that no linkage key references cannot affect
 * matching, so warning about it would be noise and running its standardization
 * pipeline would be wasted work. A constrained field that no linkage key
 * references therefore contributes nothing and is never standardized by the sweep;
 * so does a referenced field that resolved to no column and is absent from the
 * dataset. Each row's produced value set is checked element-wise, so a fan-out
 * value (e.g. from `split_on`) is judged per candidate. The dataset caches each
 * row's values, so this pre-pass warms the same cache the key-building exchange
 * reuses rather than computing them twice.
 */
export function summarizeDatasetConstraintViolations(
  terms: LinkageTerms,
  dataset: StandardizedDataset,
  rowCount: number,
): ConstraintViolationSummary[] {
  // Scope to the fields a linkage key references -- the only fields the exchange
  // standardizes and consumes; see referencedLinkageFieldNames.
  const referencedFields = referencedLinkageFieldNames(terms.linkageKeys);
  const summaries: ConstraintViolationSummary[] = [];
  for (const field of terms.linkageFields) {
    if (field.constraints === undefined) continue;
    if (!referencedFields.has(field.name)) continue;
    const standardized = dataset.getField(field.name);
    if (standardized === undefined) continue;
    // Tally this field's violations keyed only by the closed `kind` enum, so no
    // partner-controlled field name ever enters a map key. A field is a single
    // iteration of this loop (names are unique across linkageFields), so its
    // counts cannot be misattributed to or from another field's regardless of
    // what bytes its name holds.
    const byKind = new Map<
      ConstraintViolationKind,
      ConstraintViolationSummary
    >();
    for (let index = 0; index < rowCount; index++) {
      for (const value of standardized.get(index)) {
        for (const violation of checkValueConstraints(field, value)) {
          const existing = byKind.get(violation.kind);
          if (existing === undefined)
            byKind.set(violation.kind, {
              field: field.name,
              kind: violation.kind,
              label: violation.label,
              count: 1,
            });
          else existing.count += 1;
        }
      }
    }
    summaries.push(...byKind.values());
  }
  return summaries;
}
