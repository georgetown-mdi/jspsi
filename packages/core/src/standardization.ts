import { z } from "zod";
import { getLogger } from "./utils/logger.js";
import {
  OperatorConfigError,
  StandardizationTermsError,
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
} from "./config/linkageTerms.js";
import { inferMetadata } from "./config/metadata.js";
import type { ColumnMetadata } from "./config/metadata.js";
import { readRowColumn } from "./file.js";
import type { CSVRow } from "./file.js";
import { isCalendarDateValid } from "./utils/calendarDate.js";
import { expandFuzzyComparisons } from "./fuzzyComparisons.js";
import { APPLIED_SETTINGS } from "./appliedSettings.js";
import {
  declaredFanOutFunction,
  FAN_OUT_FUNCTION_NAMES,
  isListedFanOutFunction,
  MAX_KEY_CANDIDATES_PER_ROW,
} from "./fanOutFunctions.js";

export {
  declaredEffectiveKeyCount,
  FAN_OUT_FUNCTION_NAMES,
  MAX_KEY_CANDIDATES_PER_ROW,
} from "./fanOutFunctions.js";

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
 * The date-component tokens a `parse_date` format layout is built from. Exported
 * so the web consent screen can pin its own date-component detection (which
 * decides whether a `parse_date` drops a component and so broadens matching)
 * against this exact set: adding a token here breaks that consumer's build rather
 * than letting it silently miss the new component.
 *
 * `YYYY` and `YY` are both INPUT year tokens: a layout supplies the year component
 * for parsing if it carries either. Because `YY` is a prefix of `YYYY`, a consumer
 * detecting tokens must tokenize greedily (longest year token first), never by
 * substring membership, or a four-digit-year layout would false-report a two-digit
 * year. `YY` is a year ONLY when parsing an input value; in an OUTPUT format it is
 * not a substitution target (the factory's output replace fills only `YYYY`, `MM`,
 * `DD`), so it emits literally and collapses the year -- {@link dateFormatComponents}
 * separates those two contexts.
 */
export type DateFormatToken = "YYYY" | "YY" | "MM" | "DD";

/**
 * The year tokens {@link parseDateFormat} recognizes when parsing an INPUT format,
 * longest first so a greedy tokenizer consumes `YYYY` ahead of its `YY` prefix.
 * Both satisfy the factory's year-component requirement; a `YY` value resolves to a
 * four-digit year through the fixed century pivot ({@link resolveTwoDigitYear}).
 * Exported so a component-detection consumer can recover the same year vocabulary
 * rather than re-listing it.
 */
export const YEAR_FORMAT_TOKENS: readonly DateFormatToken[] = ["YYYY", "YY"];

/**
 * The fixed protocol pivot for resolving a two-digit `YY` year to four digits: a
 * two-digit `yy <= 68` resolves into the 2000s, otherwise into the 1900s, so the
 * window is 1969-2068 (the POSIX two-digit-year convention). This is a normative
 * protocol CONSTANT, not a clock read or a per-party value: both parties resolve
 * every `YY` against this same number by construction, so a boundary year cannot
 * split across centuries and silently miss the match. The trade is a fixed cutoff
 * rather than a moving "not in the future" one -- a value can resolve to a year not
 * yet reached -- which does not affect linkage because both sides resolve it
 * identically. The exact window is specified in PROTOCOL.md.
 */
const TWO_DIGIT_YEAR_PIVOT = 68;

interface ParsedDateFormat {
  /** Anchored regex source compiled to match an input date string. */
  source: string;
  /** Capture-group order, parallel to the regex's groups. */
  order: DateFormatToken[];
}

/**
 * Resolve a two-digit year to a four-digit year against the fixed
 * {@link TWO_DIGIT_YEAR_PIVOT}: a value at or below the pivot maps to the 2000s,
 * otherwise to the 1900s. With the pivot at 68 the window is 1969-2068, so `68`
 * -> `2068`, `69` -> `1969`, `00` -> `2000`, and `99` -> `1999`. The pivot is a
 * protocol constant, identical on both parties by construction, so a `YY` value
 * never silently changes century between runs or across parties -- there is no
 * clock read and no per-party reference anywhere in this path.
 */
function resolveTwoDigitYear(twoDigit: string): string {
  const value = Number(twoDigit);
  const resolved = value <= TWO_DIGIT_YEAR_PIVOT ? 2000 + value : 1900 + value;
  return String(resolved);
}

// Build the anchored regex source and capture order for a parse_date input
// format. The format is partner-controlled and its MM/DD tokens EXPAND into
// adjacent `(\d{1,2})` groups, which catastrophically backtrack on the JavaScript
// engine; that is why parseDateFactory compiles this source under the linear-time
// engine (compileLinearRegex), not `new RegExp`, even though the format is not a
// raw `tier: "regex"` pattern. The expansion is harmless under a non-backtracking
// engine, so no separate screen is needed -- the engine bounds it by construction.
function parseDateFormat(inputFormat: string): ParsedDateFormat {
  const order: DateFormatToken[] = [];
  let regexStr = "";
  let i = 0;

  while (i < inputFormat.length) {
    if (inputFormat.startsWith("YYYY", i)) {
      order.push("YYYY");
      regexStr += "(\\d{4})";
      i += 4;
    } else if (inputFormat.startsWith("YY", i)) {
      // Matched after YYYY so the four-digit year wins their shared prefix.
      order.push("YY");
      regexStr += "(\\d{2})";
      i += 2;
    } else if (inputFormat.startsWith("MM", i)) {
      order.push("MM");
      regexStr += "(\\d{1,2})";
      i += 2;
    } else if (inputFormat.startsWith("DD", i)) {
      order.push("DD");
      regexStr += "(\\d{1,2})";
      i += 2;
    } else {
      // Escape literal separator characters for use in a regex.
      regexStr += inputFormat[i].replace(/[.*+?^${}()|[\]\\]/, "\\$&");
      i++;
    }
  }

  return { source: `^${regexStr}$`, order };
}

/**
 * The date COMPONENTS a `parse_date` format layout carries, context-aware because
 * `YY` means different things on the two sides of the transform:
 *
 * - `context: "input"` -- the calendar fields the INPUT format PARSES. Both year
 *   tokens ({@link YEAR_FORMAT_TOKENS}) collapse to the single canonical `"YYYY"`
 *   year component, so an input carrying `YY` reports the year exactly as one
 *   carrying `YYYY` does: the factory resolves either to a four-digit year.
 * - `context: "output"` -- the calendar fields the OUTPUT format EMITS. The factory
 *   substitutes only `YYYY`/`MM`/`DD` into the output; a `YY` in the output format
 *   is not a substitution target, so it is emitted as the literal characters "YY"
 *   and carries NO year -- the year has collapsed to a constant. So a `YY`-only
 *   input token maps to `YYYY` here, but a `YY` in the OUTPUT contributes no year
 *   component (it is treated as a literal separator).
 *
 * `MM` and `DD` map to themselves in both contexts. Recovered from core's OWN
 * greedy tokenizer ({@link parseDateFormat}), never a substring scan -- `YY` is a
 * prefix of `YYYY`, so a `String.includes` check would double-count a four-digit
 * year. Exported so a component-detection consumer (the web consent screen's
 * date-collapse marker) shares this tokenization rather than re-deriving it and
 * drifting from the factory. The canonical components are a subset of
 * {@link DateFormatToken}, so the return type stays that set.
 */
export function dateFormatComponents(
  format: string,
  context: "input" | "output",
): Set<DateFormatToken> {
  const components = new Set<DateFormatToken>();
  for (const token of parseDateFormat(format).order) {
    if (token === "YY") {
      // A YY input token parses a year; a YY output token is an unsubstituted
      // literal that carries no year and so contributes no component.
      if (context === "input") components.add("YYYY");
    } else {
      components.add(token);
    }
  }
  return components;
}

// Parse `input_format` -> YAML camelizes keys but not values, so format
// string tokens YYYY / YY / MM / DD stay as written; delimiter characters are
// literal. Params arrive as camelCase after camelizeKeys (e.g. inputFormat).
function parseDateFactory(params: Params): StandardizingFn {
  // The wire params are z.unknown() and typed by no per-function shape, so a
  // partner can declare either format as a non-string. An absent input format
  // falls back to the complete default; a present non-string is a dead key by
  // design (the satisfiability pre-flight is pinned to that verdict), realized
  // here as an empty format that tokenizes to an all-dropping pattern -- a raw
  // non-string would instead throw in parseDateFormat (`.startsWith` on an
  // array). Guard the output format by type too: a non-string there reaches
  // `.replaceAll` on a matched row and throws, so it falls back to the absent
  // default.
  const rawInputFormat = params.inputFormat;
  const inputFormat =
    rawInputFormat == null
      ? "MM/DD/YYYY"
      : typeof rawInputFormat === "string"
        ? rawInputFormat
        : "";
  const outputFormat =
    typeof params.outputFormat === "string" ? params.outputFormat : "YYYYMMDD";

  const { source, order } = parseDateFormat(inputFormat);
  // Compile the anchored source under the linear-time engine, not `new RegExp`:
  // the MM/DD tokens expand into adjacent `(\d{1,2})` groups that backtrack
  // catastrophically on the JavaScript engine, so a partner-controlled format
  // would otherwise hang the per-row loop. The engine bounds this by construction.
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

    return outputFormat
      .replaceAll("YYYY", year)
      .replaceAll("MM", month)
      .replaceAll("DD", day);
  };
}

function substringFactory(params: Params): StandardizingFn {
  // Guard both bounds by type, not just presence: the wire params are
  // z.unknown() and typed by no per-function shape, so a partner can declare
  // either as a non-integer (a string, float, or other JSON value). An unguarded
  // non-number `length` turns `startIdx + len` into string concatenation,
  // silently producing the wrong slice rather than the intended one. A start or
  // length that is not an integer -- like the always-null `start === 0` no-op --
  // yields a fn that drops every value, the ignore path this factory already
  // takes for a degenerate bound (never crashing the partner-reachable key
  // build).
  const start = params.start;
  const len = params.length;
  if (
    typeof start !== "number" ||
    !Number.isInteger(start) ||
    typeof len !== "number" ||
    !Number.isInteger(len) ||
    start === 0
  )
    return (_s) => null;
  if (start > 0) {
    // SQL SUBSTR convention: 1-indexed positive start -- startIdx is fixed.
    const startIdx = start - 1;
    return (s) => {
      const result = s.slice(startIdx, startIdx + len);
      return result.length > 0 ? result : null;
    };
  }
  // Negative start counts from the end -- depends on string length at call time.
  return (s) => {
    const startIdx = Math.max(0, s.length + start);
    const result = s.slice(startIdx, startIdx + len);
    return result.length > 0 ? result : null;
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
  for (let idx = 1; idx < upper.length && result.length < 4; idx++) {
    const c = upper[idx];
    if (c === "H" || c === "W") continue;
    const code = SOUNDEX[c] ?? "0";
    if (code !== "0" && code !== prev) result += code;
    prev = code;
  }
  return result.padEnd(4, "0");
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
  // code-unit count -- a singleton like U+2126 -> U+03A9 stays one unit, but a
  // combining mark like U+0344 -> U+0308 U+0301 expands to two -- and padStart
  // treats a multi-unit fill as a cycling pattern, so the one-character contract
  // must hold on the normalized value that actually pads. Guard by type, not just
  // nullish: the wire params are z.unknown() and typed by no per-function
  // shape, so a partner can declare `char` as a non-string, and calling
  // `.normalize` on it would throw. A non-string falls back to the "0" default,
  // consistent with the absent default.
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
  // sequence into the key (the pattern itself is matched as authored; author it
  // in NFC to match NFC runtime values). Guard by type, not just nullish: the
  // wire params are z.unknown() and typed by no per-function shape, so a
  // partner can declare `replacement` as a non-string, and calling `.normalize`
  // on it would throw. A non-string falls back to the empty replacement,
  // consistent with the absent default.
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

// Each entry here must also be given a descriptor in
// STANDARDIZATION_FUNCTION_DESCRIPTORS below -- its drift test fails CI on a
// function added here without a descriptor, and vice versa -- and be documented
// in docs/EXCHANGE_REFERENCE.md section "Available functions", which is a prose
// obligation no test enforces.
//
// NFC-comparison contract: any step that matches an authored value, pattern, or
// delimiter against the intermediate value must NFC-normalize that value before
// matching, because an upstream step such as to_upper_case can emit non-NFC
// bytes (the six Greek code points U+0390, U+03B0, U+1FD2, U+1FD7, U+1FE2,
// U+1FE7) even from NFC input -- to_lower_case does not today, but a future
// case-fold could. The final key-string normalize in buildKeyStrings fixes the
// EMITTED key, but it runs after these mid-pipeline reads, so each step must
// normalize the value it inspects itself. The family today is null_if,
// filter_regex, extract_regex, replace_regex, split_on, and parse_date -- define
// membership by the property above, not this list, when adding a function. Two
// return styles: a step that passes the value through on a match/non-match
// (null_if, filter_regex) returns the ORIGINAL value so downstream bytes are
// untouched; a step that derives a new value (extract_regex, replace_regex,
// split_on, parse_date) derives it from the normalized value, since matching one
// form and slicing the other can misalign offsets. Either way the output for
// already-canonical (NFC or ASCII) inputs is byte-identical. This is an authoring
// reminder for new functions, not enforcement.
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

/**
 * The names of every standardization function the library recognizes, including
 * `coalesce` -- which {@link compileStep} handles specially, outside
 * {@link STANDARDIZING_FUNCTIONS}. Exported as the single source of truth for
 * "which function names core knows": {@link validateStandardizationAgainstTerms}
 * checks against it, and the web consent screen's plain-language glossary asserts
 * it covers every name here, so a function added to core cannot ship without a
 * consent-screen description silently falling through to a bare name.
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

// The message both DECLARED-step refusals carry, raised before the exchange
// runs. `functionName` is matched against FAN_OUT_FUNCTION_NAMES before it
// reaches here, so the message carries a fixed literal, never partner free text;
// the strategy the terms actually name is deliberately not interpolated, since
// nothing narrows it to a schema literal at this boundary. The two declaring
// surfaces share the wording and differ only in error class, because they differ
// in whose content the fault is -- see assertFanOutImplemented.
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
 * Refusal for a candidate set that REACHED a seam running one value per record --
 * the point of harm, where the alternative is the silent narrowing itself. Key
 * realization carries every candidate ({@link buildKeyStrings}); the seams that
 * cannot honor them are `linkViaPSI` and `linkViaCountOnlyPSI`, fan-out matching
 * being specified for single-pass alone, plus the single-pass table build of a
 * party that declared NO fan-out, whose fixed-width column carries one value per
 * (key, record). A party that DID declare one builds the ragged table instead and
 * refuses a set its advertisement cannot carry through the single-pass build's own
 * width checks (`link.ts`), which are a different refusal on the same class of
 * fault: an expansion the declared factors do not account for.
 *
 * Unreachable from a fan-out the terms declare while {@link
 * assertFanOutImplemented} gates every run path off single-pass, and
 * deliberately a check rather than a comment saying so: it also covers a fan-out
 * function that never made it into {@link FAN_OUT_FUNCTION_NAMES}, and the
 * standardization-authored half that gate cannot see on a prepared exchange
 * assembled outside `prepareForExchange`.
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
export type StandardizationFunctionTier = "standard" | "regex";

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
   * snake_case an operator writes in YAML. A defaulted param carries its default
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
 * pathological-length paste. Deliberately stricter than the factory (which compiles
 * any length), like substring's footgun rejections; the descriptor drift test pins
 * only short patterns, so this divergence does not break it.
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
    // deliberately stricter here, rejecting footgun shapes (a fractional position,
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
    // factory accepts; surfacing tokenless formats is editor guidance, not
    // validation. The length cap IS enforced here (deliberately stricter than the
    // factory, like regexPatternSchema): the factory expands the format into a
    // regex compiled under the linear-time engine, so an over-length format pays a
    // super-linear compile that a live editor preview must not incur on the main
    // thread -- the same vector regexPatternSchema bounds, through a sibling param.
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
      "Substitute a fallback value for an empty field, which can create matches that would not otherwise occur.",
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
export interface TransformParamCoercion {
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
// declared fan-out producers (FAN_OUT_FUNCTION_NAMES), captured at compile time
// because the compiled closure no longer carries its name. It is what lets a
// realization say WHICH producer expanded a value, which the width bound binds on
// (buildKeyStrings).
type CompiledStep =
  | { kind: "fn"; fn: StandardizingFn; isListedFanOutFunction: boolean }
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
  if (!factory)
    throw new Error(`unknown standardization function: "${step.function}"`);
  return {
    kind: "fn",
    fn: factory(params),
    isListedFanOutFunction: isListedFanOutFunction(step.function),
  };
}

function compileSteps(
  steps: Array<{ function: string; params?: Params }>,
): CompiledStep[] {
  return steps.map(compileStep);
}

// --- Step execution ----------------------------------------------------------

/**
 * Where a realization's multiplicity came from, threaded out of the pipeline so
 * {@link buildKeyStrings} can bind the width bound's drop to the declared
 * producers alone (docs/spec/PROTOCOL.md, Fan-out matching, whose every rule
 * binds `split_on` and it alone).
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
// what separates producing multiplicity from carrying it: a later step run
// element-wise over an already-expanded set returns one candidate per value and
// produces none of it.
function noteFanOutProducer(
  result: FieldValue,
  isListedFanOutFunction: boolean,
  provenance: FanOutProvenance | undefined,
): void {
  if (provenance === undefined || isListedFanOutFunction) return;
  if (result instanceof Set && result.size > 1)
    provenance.fromUnlistedFunction = true;
}

// `coalesce` is the only function that operates on null (or an empty array
// produced by prior null-filtering). All other functions null-propagate.
function applyStep(
  current: FieldValue,
  step: CompiledStep,
  provenance?: FanOutProvenance,
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
    for (const v of current) {
      const r = step.fn(v);
      if (r === null) continue;
      if (r instanceof Set) {
        noteFanOutProducer(r, step.isListedFanOutFunction, provenance);
        for (const sv of r) out.add(sv);
      } else {
        out.add(r);
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
   * this to keep multiplicity from any other producer fail-closed: carried
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
  private readonly fieldMap: ReadonlyMap<string, StandardizedField>;

  constructor(fields: StandardizedField[]) {
    this.fieldMap = new Map(fields.map((f) => [f.name, f]));
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
export interface FieldColumnResolution {
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
 *    carries a transformation whose `output` is the field name, the field binds
 *    to that transformation's `input` column -- whether or not the column is
 *    present in the data -- UNLESS that column is present and is not
 *    `role: linkage`, in which case the field binds to nothing: matching
 *    participation is the operator's explicit `linkage` role, and that role wins
 *    over a contradictory explicit transform naming an `identifier`, `payload`,
 *    or `ignored` column. (An ABSENT named column still binds, so the field is
 *    surfaced as unsatisfiable by presence, unchanged. When two transformations
 *    name the same output the last wins, matching the builder's field map and the
 *    checker's old mapping.)
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
  // Field output -> its explicit transformation; last wins on a duplicate output,
  // matching both the builder's StandardizedDataset field map and the checker's
  // former explicitInput map (the schema forbids duplicates, so this only differs
  // for terms not built through it).
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
      // column (surfacing as unsatisfiable through the shared checker) rather
      // than silently hashing a column the operator did not designate for
      // matching into a PSI key. An ABSENT named column is not refused here: it
      // still binds and is surfaced as unsatisfiable by presence downstream
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
    // Explicit binding carries its own steps; a type-fallback binding is the
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

  return new StandardizedDataset(fields);
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
// engine. A hostile-but-schema-valid terms set can carry far more distinct patterns
// than the engine's own compile cache holds, so per-row recompilation would thrash
// that cache into an unbounded per-row compile cost over a large dataset -- a
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
 * honest one while holding the derived value to a size the rest of the row
 * pipeline (`split_on`, the fuzzy expansion, key assembly) can carry. An
 * over-ceiling value is REFUSED, never truncated: both parties must derive
 * byte-identical keys, so a unilateral clamp would break matching and surface as
 * a terms mismatch against the hashed agreement -- the same reason the param
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
      `${rowIndex} of this party's data ` +
      `(${keyElementPath(keyIndex, elementIndex)}), longer than the ` +
      `${MAX_TRANSFORMED_VALUE_LENGTH}-character value an element carries ` +
      "into a key string. Every element's value is carried into every key " +
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
      `${MAX_TRANSFORMED_VALUE_LENGTH}-character value an element carries ` +
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
// what the next step is handed and what one key string carries; the row's total
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
function applyElementTransform(
  value: string,
  steps: TransformStep[] | undefined,
  provenance: FanOutProvenance,
  keyIndex: number | undefined,
  elementIndex: number,
  rowIndex: number,
): string[] {
  // The magnitude ceiling's base case, ahead of the no-steps early return so it
  // also binds an element that declares no transform at all and carries a raw
  // cell straight into the key.
  if (value.length > MAX_TRANSFORMED_VALUE_LENGTH)
    throw elementValueTooLongRefusal(
      keyIndex,
      elementIndex,
      rowIndex,
      value.length,
    );
  // No steps: the value passes through unchanged (the empty-pipeline identity),
  // and nothing is compiled or memoized.
  if (steps === undefined || steps.length === 0) return [value];
  let compiled = compiledElementTransforms.get(steps);
  if (compiled === undefined) {
    compiled = compileSteps(steps);
    compiledElementTransforms.set(steps, compiled);
  }
  let current: FieldValue = value;
  for (const [stepIndex, step] of compiled.entries()) {
    current = applyStep(current, step, provenance);
    const over = valueOverCeiling(current);
    if (over !== undefined)
      throw transformStepValueTooLongRefusal(
        keyIndex,
        elementIndex,
        stepIndex,
        steps[stepIndex].function,
        rowIndex,
        over,
      );
  }
  return toValueSet(current);
}

function swapElements(
  elements: LinkageKeyElement[],
  [nameA, nameB]: [string, string],
): LinkageKeyElement[] {
  const idA = elements.findIndex((e) => (e.name ?? e.field) === nameA);
  const idB = elements.findIndex((e) => (e.name ?? e.field) === nameB);
  if (idA === -1 || idB === -1) return elements;
  const swapped = [...elements];
  // Swap the field references while keeping each element's own name and
  // transforms.
  swapped[idA] = { ...elements[idA], field: elements[idB].field };
  swapped[idB] = { ...elements[idB], field: elements[idA].field };
  return swapped;
}

/**
 * The hard cap on the key strings ONE row may contribute to a single key round.
 *
 * {@link MAX_KEY_CANDIDATES_PER_ROW} bounds the record's candidate set for a key
 * and drops a record above it. This cap sits well above that one and is the
 * resource bound underneath the cross-product itself: the product multiplies each
 * element's candidate count, and the decision to expand an element comes from the
 * partner-authored linkage terms while the values expanded are local rows, so the
 * product is not something the local operator alone controls. A fan-out never
 * REFUSES on it -- a row whose product is too wide to assemble is dropped like
 * any other over-width row -- so the refusal binds only the other candidate
 * producer, `generateFuzzyComparisons` (docs/spec/PROTOCOL.md, The width bound).
 * Set well above any honest fuzzy key (three fuzzy elements over canonical dates
 * produce a few hundred candidates). The cap
 * bounds the COUNT of key strings, not their bytes: a fuzzy element's value is
 * bounded by MAX_FUZZY_EXPANSION_INPUT_LENGTH, but a non-fuzzy element in the
 * same key carries its full local cell, which the product replicates, so the
 * per-row byte total scales with the operator's own longest cell times this
 * cap. The recorded limit lives in docs/spec/CHANNEL_SECURITY.md.
 */
const MAX_KEY_STRINGS_PER_ROW = 1024;

/**
 * The hard cap on the total characters one row's key strings may carry for a
 * single key round -- the byte limb beside {@link MAX_KEY_STRINGS_PER_ROW}'s
 * count limb.
 *
 * The count cap bounds how MANY key strings a row assembles, not how large they
 * are: every combination concatenates one candidate from each element, so a row
 * at the count cap replicates each element's value across all of them. A fuzzy
 * element's own candidates are short ({@link MAX_FUZZY_EXPANSION_INPUT_LENGTH}),
 * but a non-fuzzy sibling in the same key carries its whole transformed value
 * into every combination, and that value is partner-influenced in size
 * ({@link MAX_TRANSFORMED_VALUE_LENGTH}) -- so bytes need a limb of their own.
 * It is set at the count cap times the per-value ceiling: a row may carry the
 * equivalent of one ceiling-sized element replicated across the full width the
 * count cap allows, which is orders of magnitude above any honest row (a wide
 * fuzzy key over canonical dates and names assembles a few hundred candidates of
 * a few dozen characters). Measured on the PROJECTED total, before the
 * cross-product is materialized, for the same reason the count limb is.
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
function keyStringFanOutCapRefusal(projected: number): UsageError {
  return new UsageError(
    `a linkage key expands one row into ${projected} key strings, above the ` +
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
      "per row. Every combination of the key's elements carries each " +
      "element's whole value, so a key whose elements expand -- through " +
      "fuzzy comparisons, or a step that turns one value into several " +
      "candidates -- replicates those values across the whole cross-product " +
      "and exhausts memory as it is built. The exchange is refused instead. " +
      "Declare fuzzy comparisons on fewer of the key's elements, drop the " +
      "expanding step from the transforms, or shorten the expanded fields " +
      "with an element transform.",
  );
}

// A record whose candidate set for one key is too wide contributes nothing to
// that key's round and stays eligible for later keys, exactly as a record with no
// value for the key does. The row index and the derived counts name no value; the
// key name is partner-authored free text, so it is escaped at this sink.
function dropRowFromKeyRound(
  key: LinkageKey,
  index: number,
  reason: string,
): null {
  logger.warn(
    `row ${index}, key "${redactAndSanitizeForDisplay(key.name)}": ${reason}, ` +
      "so the record contributes no value to this key's round and remains " +
      "eligible for later keys",
  );
  return null;
}

/**
 * Build the candidate key strings one record contributes to one linkage key
 * round, given a standardized dataset and a row index.
 *
 * Returns `null` when the record contributes nothing to the round: an element's
 * field value set is empty (the `NULL`/absent realization), or a candidate set a
 * function in {@link FAN_OUT_FUNCTION_NAMES} expanded exceeds
 * {@link MAX_KEY_CANDIDATES_PER_ROW}, which is dropped the same way and warned.
 * Otherwise it returns the deduplicated cross-product across the elements'
 * candidate values -- one entry per distinct combination, and a set of more than
 * one entry is a fan-out (docs/spec/PROTOCOL.md, Fan-out matching).
 *
 * All returned strings belong to the same original row at `index`; the caller
 * is responsible for preserving that association when adding entries to the PSI
 * set.
 *
 * `isReceiver` controls whether the key's `swap` directive is applied. The
 * receiver builds keys with the named elements swapped; the sender does not.
 *
 * `keyIndex` is this key's position in the agreed terms' `linkageKeys`, carried
 * only so a magnitude refusal ({@link MAX_TRANSFORMED_VALUE_LENGTH},
 * {@link MAX_ASSEMBLED_KEY_LENGTH_PER_ROW}) can locate the offending element by
 * the same issue path the terms-validation refusals use. A caller that holds one
 * key alone omits it and the path is rooted at the element.
 *
 * An element declaring `generateFuzzyComparisons` contributes its whole
 * candidate set to the cross-product rather than a single value, so a fuzzy
 * element multiplies the row's key strings by its candidate count. The expansion
 * runs on the element's TRANSFORMED value (see the note at the expansion site),
 * every candidate flows through the same final NFC pass, and the assembled count
 * is what {@link MAX_KEY_CANDIDATES_PER_ROW} measures, under the
 * {@link MAX_KEY_STRINGS_PER_ROW} assembly cap. It is gated on
 * `APPLIED_SETTINGS.fuzzyComparisons`: while that is false a fuzzy element builds
 * the same single key string as an element without one.
 */
export function buildKeyStrings(
  key: LinkageKey,
  dataset: StandardizedDataset,
  index: number,
  isReceiver = false,
  keyIndex?: number,
): Set<string> | null {
  const elements =
    isReceiver && key.swap
      ? swapElements(key.elements, key.swap)
      : key.elements;

  const elementValues: string[][] = [];
  // Whether any element contributed several candidates before fuzzy expansion --
  // the fan-out signature -- and, with the provenance beside it, what decides
  // whether an over-width or unassemblable row is dropped or refused below.
  let fansOut = false;
  // Which producer realized that multiplicity, accumulated across the row's
  // elements: the drop binds the DECLARED producers alone (see the drop sites).
  const provenance: FanOutProvenance = { fromUnlistedFunction: false };

  for (const [elementIndex, element] of elements.entries()) {
    const field = dataset.getField(element.field);
    const raw = field ? field.get(index) : [];
    if (raw.length === 0) return null;
    if (field?.fanOutFromUnlistedFunction(index))
      provenance.fromUnlistedFunction = true;

    // Candidates are appended one at a time, never spread into push: a spread
    // passes them as arguments, and a field realizing one candidate per value
    // can hand this loop more of them than the engine accepts (measured between
    // 125,000 and 150,000 here, fewer wherever the stack is smaller), which
    // raises a RangeError in place of the assembly cap's refusal below --
    // fail-closed, but reporting a fault the row does not have.
    const transformed: string[] = [];
    for (const v of raw) {
      const realized = applyElementTransform(
        v,
        element.transform,
        provenance,
        keyIndex,
        elementIndex,
        index,
      );
      for (const candidate of realized) transformed.push(candidate);
    }
    if (transformed.length === 0) return null;

    // A record contributes each DISTINCT candidate once, so duplicates collapse
    // here rather than multiplying the cross-product the width bound measures:
    // two raw values can transform to the same string, and two splits can share
    // a part. The single-candidate case -- every element of a row that does not
    // fan out -- keeps its array and allocates nothing.
    const candidates =
      transformed.length === 1 ? transformed : [...new Set(transformed)];
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
    // a linkage strategy carrying several candidates, which is refused, turning
    // the no-op the consent copy describes into an aborted exchange.
    const fuzzy = element.generateFuzzyComparisons;
    elementValues.push(
      fuzzy === undefined || !APPLIED_SETTINGS.fuzzyComparisons
        ? candidates
        : candidates.flatMap((value) => expandFuzzyComparisons(value, fuzzy)),
    );
  }

  // Dropping on exceedance is normative for the DECLARED fan-out producers and
  // for them alone -- every rule of docs/spec/PROTOCOL.md (Fan-out matching)
  // binds `split_on`. Multiplicity any other function realized is outside that
  // rule and stays fail-closed at both bounds below: it is never traded for a
  // completed run that matches fewer records than the terms describe, but carried
  // to the strategy, which refuses it (fanOutReachedMatchingRefusal), or refused
  // here when the row cannot be assembled at all.
  const dropsOnExceedance = fansOut && !provenance.fromUnlistedFunction;

  // Bound the cross-product BEFORE materializing it: it multiplies each element's
  // candidate count, so a few wide elements multiply into a per-row set large
  // enough to exhaust memory as it is built. The count is a product of array
  // lengths, so it is known without allocating the product itself.
  //
  // A row this wide is over MAX_KEY_CANDIDATES_PER_ROW too, once assembled, in
  // every case but one: distinct combinations that concatenate to the same string
  // could in principle collapse a large product into a small candidate set. That
  // collapse is not measurable without the allocation this cap exists to prevent,
  // so a fan-out row is dropped on the projected count -- the same treatment an
  // over-width row gets, and never the run refusal, which the fan-out path
  // deliberately does not take (docs/spec/PROTOCOL.md, The width bound). Fuzzy
  // expansion, whose own bound is that feature's to set, keeps the refusal, as
  // does multiplicity from a function outside FAN_OUT_FUNCTION_NAMES.
  const projectedKeyStrings = elementValues.reduce(
    (count, values) => count * values.length,
    1,
  );
  if (projectedKeyStrings > MAX_KEY_STRINGS_PER_ROW) {
    if (!dropsOnExceedance)
      throw keyStringFanOutCapRefusal(projectedKeyStrings);
    return dropRowFromKeyRound(
      key,
      index,
      `expands into ${projectedKeyStrings} key-string combinations, more than ` +
        `the ${MAX_KEY_STRINGS_PER_ROW} this exchange assembles for one row`,
    );
  }

  // The byte limb of the same projection, on the counts and candidate lengths
  // already in hand: each of the projectedKeyStrings combinations carries one
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

  // The width bound is measured on the assembled, DEDUPLICATED candidate set,
  // which is what a record contributes to the round, and it binds the declared
  // fan-out producers: a row that fans out through one at all takes the drop,
  // including one that also expands fuzzily, whose combined width the fuzzy work
  // settles when it sets its own factor. For a row that only expands fuzzily the
  // same number stays the advisory it has been -- that producer is inert here,
  // and pre-empting its width behavior would decide it from the wrong side.
  if (result.size > MAX_KEY_CANDIDATES_PER_ROW) {
    if (dropsOnExceedance)
      return dropRowFromKeyRound(
        key,
        index,
        `realizes ${result.size} candidate values, more than the ` +
          `${MAX_KEY_CANDIDATES_PER_ROW} one record may contribute to one key`,
      );
    logger.warn(
      `row ${index}, key "${redactAndSanitizeForDisplay(key.name)}": ` +
        `cross-product produced ${result.size} key strings ` +
        `(>${MAX_KEY_CANDIDATES_PER_ROW}); a wide per-record expansion in ` +
        "dual-party-output exchanges may degrade privacy guarantees",
    );
  }

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
    const result = buildKeyStrings(
      this.key,
      this.dataset,
      index,
      this.isReceiver,
      this.keyIndex,
    );
    // An empty set is the record-excluded sentinel like `null`, and a singleton
    // is unwrapped, so a set that survives to a consumer always carries two or
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
 * legitimately carry as a note. Callers gate this on `standardization !== undefined`:
 * an absent standardization is the terms-only path, reconstructed FROM the terms
 * (via `getDefaultStandardization`) and so unable to contradict them, and is
 * deliberately not gated.
 *
 * Throws {@link StandardizationTermsError} (a {@link UsageError} subclass: the CLI
 * classifies it as a configuration error, exit 64; on the web it is the one
 * prepare-time fault whose message -- naming only the authoring party's own outputs
 * and functions -- is safe to surface).
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
 * The asymmetry that half carries is why the local surface is refused here at all
 * rather than left to the strategy: an element-transform fan-out rides the agreed
 * terms and both parties refuse it in lockstep, while a standardization is
 * per-party and local, so a partner cannot derive its refusal and would be left
 * waiting on a run this party is about to abort.
 *
 * The two surfaces carry the same message under DIFFERENT error classes, because
 * they differ in whose content the fault is. A `standardization` is only ever this
 * party's own: no invitation carries one (it is per-party and local), and the
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
 * binding itself, so it cannot diverge from the runtime -- the HIGH-severity
 * direction (a field the builder cannot produce but the checker passes) is
 * impossible by construction.
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
 * Whether a transform/standardization pipeline produces NO value for every
 * possible input -- a self-defeating "dead" pipeline, determinable from the terms
 * alone without any data. Today the only value-INDEPENDENT drop core recognizes is
 * a `parse_date` whose input format omits a required component
 * ({@link parseDateInputDropsEveryRecord}); a later `coalesce` with a string
 * default RESCUES a dropped value to that constant (see {@link applyStep}'s
 * coalesce branch), so a pipeline ending in such a coalesce is NOT dead -- it
 * yields a constant key, which the linkage layer treats as benign (a duplicated
 * key contributes no match but is no silent-empty hazard, the same reason the
 * coverage sweep does not flag a constant field). A coalesce BEFORE the drop, or
 * one with no string default, does not rescue.
 *
 * Steps whose drop behavior depends on the VALUE -- a `substring` past the end of
 * a short value, a `filter_regex` no value matches -- are deliberately NOT treated
 * as always-dropping: that is the data-dependent residual the satisfiability layer
 * leaves to the runtime coverage sweep, and assuming it here could wrongly flag a
 * legitimate pipeline. Only a value-independent certainty is reported, so this can
 * never claim a producible pipeline is dead.
 */
export function pipelineAlwaysDrops(
  steps: ReadonlyArray<TransformStep> | undefined,
): boolean {
  if (steps === undefined) return false;
  let dropped = false;
  for (const step of steps) {
    if (step.function === "coalesce") {
      // A string default substitutes a constant for a dropped value, rescuing it;
      // an undefined or non-string default leaves a dropped value dropped.
      if (dropped && typeof step.params?.default === "string") dropped = false;
      continue;
    }
    // A non-coalesce step null-propagates a dropped value, so once dropped the
    // pipeline stays dropped until a rescuing coalesce.
    if (dropped) continue;
    if (
      step.function === "parse_date" &&
      parseDateInputDropsEveryRecord(step.params)
    )
      dropped = true;
  }
  return dropped;
}

/** How an input's columns fare against a set of linkage terms: which fields it
 * cannot produce, how many of the terms' linkage keys remain usable as a result,
 * and which otherwise-usable keys are self-defeating. {@link satisfiableKeyCount}
 * of 0 is the block signal -- every key references at least one unproducible
 * field, so an exchange would emit no key strings and yield a result
 * byte-indistinguishable from a legitimately empty intersection. */
export interface LinkageSatisfiability {
  /** The linkage fields the columns cannot produce (see
   * {@link unsatisfiedLinkageFields}); empty when the input satisfies every field. */
  unsatisfied: LinkageField[];
  /** The number of linkage keys all of whose element fields are satisfiable.
   * Zero means no key can match and the exchange should be blocked rather than
   * run to a silent empty result. This is the column-SHAPE verdict only -- it does
   * not subtract {@link deadKeys}, so it stays the count the differential test
   * pins against the builder's column resolution. */
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
   * verdict and a caller can warn with the right remedy (fix the terms, not the
   * CSV); the caller sanitizes the partner-controlled key names itself, as it does
   * for {@link unsatisfied}. Detection is value-independent only (see
   * {@link pipelineAlwaysDrops}): a data-dependent all-null collapse is left to
   * the runtime coverage sweep, not reported here. */
  deadKeys: LinkageKey[];
}

/**
 * Assess whether an input's `columns` can satisfy `terms`, for the satisfiability
 * pre-flight shared by the web acceptor and both CLI real-exchange paths. Combines
 * {@link unsatisfiedLinkageFields} (which fields cannot be produced) with the
 * downstream consequence (how many linkage keys survive): a key is satisfiable
 * only when EVERY element field is producible -- both declared in
 * `linkageFields` and resolvable from the columns -- since a single empty field
 * collapses the whole key for that record. The caller decides policy from the
 * result -- block when {@link LinkageSatisfiability.satisfiableKeyCount} is 0,
 * warn when it is positive but below `linkageKeys.length` -- and owns its own
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
 * the count stays the column-shape verdict, and the caller warns on `deadKeys`
 * with a terms-fix remedy distinct from the missing-column one.
 */
export function assessLinkageSatisfiability(
  columns: string[],
  terms: LinkageTerms,
  standardization?: Standardization,
  metadata?: ColumnMetadata[],
): LinkageSatisfiability {
  const unsatisfied = unsatisfiedLinkageFields(
    columns,
    terms,
    standardization,
    metadata,
  );
  const unsatisfiedNames = new Set(unsatisfied.map((f) => f.name));
  // The set of field names that are BOTH declared and producible. A key element
  // referencing a name absent from this set is unsatisfiable -- whether the field
  // is declared-but-unproducible (in `unsatisfied`) or not declared at all. The
  // latter is rejected upstream by LinkageTermsSchema's referential-integrity
  // refine (a key element `field` must name a declared linkage field), so a
  // schema-validated terms set cannot reach here with an undeclared reference;
  // this filter is kept as defense-in-depth for any terms not built through that
  // schema, since at exchange time an undeclared reference resolves to no values
  // (buildStandardizedDataset only builds declared fields, so getField returns
  // undefined and the key collapses to null) and counting such a key satisfiable
  // would let an incoherent terms set defeat the block and run to the
  // silent-empty result this pre-flight exists to prevent.
  const producibleNames = new Set(
    terms.linkageFields
      .map((f) => f.name)
      .filter((name) => !unsatisfiedNames.has(name)),
  );
  const shapeSatisfiableKeys = terms.linkageKeys.filter((k) =>
    k.elements.every((e) => producibleNames.has(e.field)),
  );
  // Among the shape-satisfiable keys, the self-defeating ones: an element whose
  // transform can never produce a value (a dead `parse_date` input format), so the
  // key passes the column check yet would run to a silent empty result. Scoped to
  // shape-satisfiable keys -- a key already excluded from satisfiableKeyCount for a
  // missing field is surfaced by that count, not double-reported as dead here.
  //
  // The scan walks each such key's element transform steps (each parse_date step a
  // parseDateFormat tokenization over a MAX_DATE_FORMAT_LENGTH-bounded format), so
  // its cost is O(total transform steps in `terms`) and needs no separate budget:
  // on the partner-controlled accept path `terms` comes from a decoded invitation
  // already bounded to MAX_ENCODED_INVITATION_LENGTH, so the step total stays small
  // (a packed-to-the-cap hostile token measures single-digit milliseconds); on the
  // operator's own committed-config path the terms are self-authored and drive
  // strictly heavier per-row compile + RE2 work at exchange time, so this pre-flight
  // scan is never the dominant cost. parseDateInputDropsEveryRecord never calls
  // parseDateFormat on a non-string, so a hostile param shape cannot make it throw.
  const deadKeys = shapeSatisfiableKeys.filter((k) =>
    k.elements.some((e) => pipelineAlwaysDrops(e.transform)),
  );
  return {
    unsatisfied,
    satisfiableKeyCount: shapeSatisfiableKeys.length,
    deadKeys,
  };
}

// --- Value-level constraints -------------------------------------------------
//
// "Does a cleaned value meet a field's declared constraints?" -- the value-level
// companion to validateStandardizationAgainstTerms (which checks only NAMES: that
// standardization outputs map to declared fields, and that step function names are
// known). The web's constraint badges and the CLI's prepare-path warnings run
// ONE implementation.
// Warn-not-enforce throughout, matching the LinkageField constraint contract ("the
// application warns if violated but does not enforce them", config/linkageTerms.ts):
// nothing here throws or rejects a value; each surface decides how to present the
// result (a web badge, a CLI warning line).
//
// Coverage is authoritative: every constraint with a CLEAN value-level test is
// checked, and one that has none is deliberately left UNFLAGGED rather than guessed
// at, so a warning never fires on a value the check cannot actually judge.
//
//   - exclude (all field types), allowedCharacters (name fields), date_of_birth
//     validOnly, ssn validOnly: checked (the four the pre-promotion web-local check
//     covered; their behavior is preserved, not changed).
//   - ssn4 validOnly: checked for the ONE SSA structural rule a bare last-four can
//     be judged against -- the serial is not 0000. The last four digits ARE the
//     serial; the area/group rules and the 9-digit-only checks have no last-four
//     analogue. The web-local check omitted ssn4; promotion adds this sound test
//     (see isStructurallyValidSsn4).
//   - affixesAllowed (name fields): NOT checked, by deliberate decision. Flagging a
//     residual honorific/suffix would mean re-running remove_affixes' heuristic
//     token-match over a fixed list (dr, miss, sir, judge, jr, sr, ...) that
//     collides with legitimate name values -- "Judge" and "Miss" are real surnames
//     -- so any such test false-positives on real data. Whether affixes were
//     removed is a pipeline choice, not a defect of the value, so there is no clean
//     value-level property to flag. This would only need revisiting if affix
//     membership became an exact, collision-free set.

/**
 * The kind of value-level constraint a cleaned value violated. A stable,
 * partner-independent discriminant a surface can branch on; the fixed
 * {@link ConstraintViolation.label} / `detail` copy is keyed off it.
 *
 * - `excluded` -- the value is on the field's agreed `exclude` denylist (any
 *   field type).
 * - `disallowedCharacters` -- a name value carries a character outside the field's
 *   `allowedCharacters` class.
 * - `invalidDate` -- a `date_of_birth` value in canonical YYYYMMDD form names no
 *   real calendar day (under `validOnly`).
 * - `invalidSsn` -- a 9-digit `ssn` value breaks an SSA structural rule (under
 *   `validOnly`).
 * - `invalidSsn4` -- a 4-digit `ssn4` value is the all-zero serial 0000, the one
 *   SSA structural rule a bare last-four can be judged against (under `validOnly`).
 */
export type ConstraintViolationKind =
  | "excluded"
  | "disallowedCharacters"
  | "invalidDate"
  | "invalidSsn"
  | "invalidSsn4";

/**
 * A single value-level constraint violation: a warn-not-enforce signal that a
 * cleaned value does not meet one of a field's declared constraints. The `kind`
 * is a stable discriminant; `label` and `detail` are FIXED copy keyed off it --
 * never a partner-controlled value -- so a surface may render them verbatim (the
 * web workbench badge) or print them (the CLI), or switch on `kind` for its own
 * wording. An empty result from {@link checkValueConstraints} means the value
 * conforms to every constraint that has a clean value-level test.
 */
export interface ConstraintViolation {
  /** Stable, partner-independent discriminant; see {@link ConstraintViolationKind}. */
  kind: ConstraintViolationKind;
  /** Short fixed badge caption (e.g. "excluded value"). */
  label: string;
  /** One-line fixed plain-language explanation of the violation. */
  detail: string;
}

/** Whether `value` contains only characters in the field's `allowedCharacters`
 * class. `allowedCharacters` is partner-controlled (it arrives in the invitation
 * token), and {@link NameConstraintsSchema} only checks that it compiles as the
 * body of a `[...]` class -- NOT that it cannot break out of one. A crafted value
 * can close the class and inject arbitrary regex structure (e.g. `x](a+)+b[y`).
 *
 * Hazards follow, each guarded here.
 *
 * (1) ReDoS: matching against an attacker-chosen pattern on the native `RegExp`
 * engine could backtrack catastrophically and hang the single, non-interruptible
 * thread. The class is compiled under the linear-time engine the transform-regex
 * paths use ({@link compileLinearRegex}, re2js) instead, so the blow-up is
 * impossible by construction -- no partner pattern ever touches the backtracking
 * engine -- and a pattern that engine cannot compile is treated as "cannot check"
 * (no violation, fail-open) rather than throwing. {@link NameConstraintsSchema}
 * validates the class under this SAME engine, so for a decoded token that fail-open
 * is a backstop, not a path: a class that would not compile here is rejected at
 * terms validation.
 *
 * (2) Warning suppression has three sub-cases, handled differently:
 *
 *   - A breakout closes the class and injects regex structure: a multi-character
 *     span (`a]|.*[b`, `(a+)+`), or an alternation with an empty-matchable branch
 *     (`a]*|` becomes `^[a]*|]$` = `(^[a]*) | (]$)`). Each value is tested one code
 *     point at a time AND as a FULL match (re2js `matches()`, anchored both ends),
 *     not an unanchored find: a multi-character span cannot match a single code
 *     point, and a branch matching only a zero-width or leading span does not satisfy
 *     a full match (an unanchored test would instead let `^[a]*`, which matches the
 *     empty string at the start anchor, pass every value). A breakout branch that
 *     genuinely matches a SINGLE code point is a different case -- see the accepted-
 *     limit sub-case below.
 *
 *   - A leading `^` makes re2js read the class as a NEGATION (`^A-Z` compiles to
 *     `[^A-Z]`), inverting the advisory: the class would admit every character
 *     EXCEPT the listed ones and so suppress the warning on arbitrary disallowed
 *     input, the opposite of a plain reading ("allow `^` and A-Z, flag the rest").
 *     This is CLOSED: a leading `^` is escaped to a literal `\^` before compiling,
 *     and a `-` immediately after it is escaped too (otherwise `\^-X` would read as
 *     a range -- `^-Z` -> `\^-Z` is reversed -- rather than the literal caret the
 *     operator meant). An exotic leading-`^` combination can still escape to a class
 *     re2js cannot compile (e.g. `^]A[`, where the literal `\^` lets a following `]`
 *     close the class): when the raw class compiled but the escaped one does not, the
 *     value is OVER-flagged rather than failed open, so a leading `^` never suppresses
 *     the advisory -- the worst case is the warn-not-enforce safe direction. A literal
 *     caret is otherwise written non-first (`A-Z^`) or escaped (`\^`), so the escape
 *     never narrows a legitimate class.
 *
 *   - A class -- or an injected alternation branch -- that genuinely ADMITS the single
 *     code point is NOT defeated, and is an accepted limit. This covers a character-
 *     class shorthand (`\w`, `\d`, `\s`) or Unicode/POSIX property class, whether or
 *     not dressed up with the leading-`]`-is-literal trick (e.g. `]|\w|[`, one class
 *     admitting every word character); it equally covers an alternation breakout whose
 *     branch admits one code point (`a]|.|[b` compiles to `(^[a]) | (.) | ([b]$)`,
 *     whose `.` branch full-matches any code point, so the class effectively admits
 *     everything). There is no transform or parse-time rule that suppresses these
 *     without rejecting or narrowing a legitimate class: `\p{L}` ("any letter") is the
 *     natural constraint for international names and is indistinguishable at the engine
 *     level from a smuggle, so neutralizing it would false-flag real non-Latin names;
 *     and an effective allow-all reached via breakout is indistinguishable by matching
 *     behavior from a legitimately permissive class such as `[\s\S]` -- only the syntax
 *     (a top-level `|`, which a genuine character class never contains) differs, and
 *     detecting that would take a full class parser, out of proportion to a warn-only
 *     advisory. The class is behaving as a class; because the check is warn-not-enforce
 *     the only consequence is a suppressed advisory badge, never a data-filtering or
 *     match-correctness effect -- so it is an accepted limit, not a hole.
 *
 * Every sub-case is pinned by tests in standardization.test.ts so the boundary
 * between what is closed and what is accepted cannot silently drift. For a
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
    // the class), our escape -- not the partner's class -- broke it: over-flag (the
    // warn-not-enforce safe direction) instead of failing open and suppressing the
    // advisory on every value, which a leading-`^` negation would otherwise achieve.
    // A class that compiles neither way is genuinely uncheckable: fail open, as
    // header (1) describes.
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
 * as badges and the CLI surfaces as warnings. Returns the violations as
 * warn-not-enforce signals; an empty array means the value conforms to every
 * constraint that has a clean value-level test. Warn, never block (see the
 * section note above): a violation is reported, never thrown.
 *
 * A constraint with no clean value-level test is intentionally NOT flagged, so a
 * warning never fires on a value the check cannot actually judge: `affixesAllowed`
 * is omitted by deliberate decision, and `date_of_birth` / `ssn` / `ssn4`
 * `validOnly` only judge a value of the constraint's canonical width (see each
 * helper). The copy returned is fixed and keyed off the violated constraint --
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
 * constraint kind. The CLI's exchange/prepare path surfaces these (one line per
 * entry) where the web workbench shows per-value badges, so it reports a COUNT --
 * not the offending values, which are the operator's own data and are never echoed
 * into a log.
 */
export interface ConstraintViolationSummary {
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
 * Warn-not-enforce: it only counts; it never throws or rejects a value, and the
 * caller decides how to surface the result (the CLI logs a warning per entry and
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
    // what bytes its name carries.
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
