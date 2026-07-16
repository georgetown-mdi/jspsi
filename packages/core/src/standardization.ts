import { z } from "zod";
import { getLogger } from "./utils/logger.js";
import { StandardizationTermsError } from "./errors.js";
import { sanitizeForDisplay } from "./utils/sanitizeForDisplay.js";
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

const logger = getLogger("cleaning");

// --- Value types -------------------------------------------------------------

/**
 * The result type for a single standardization pipeline or step.
 *
 * - `string` — a single canonical value.
 * - `null` — no valid value; the record is excluded from any linkage key that
 *   references this field.
 * - `Set<string>` — multiple candidate values produced by a fan-out step such
 *   as `split_on`. Each value generates a separate PSI entry; all entries carry
 *   the original row identifier so that matches resolve back to the source row.
 *   `Set` enforces uniqueness: duplicate values from splitting or subsequent
 *   element-wise steps are automatically deduplicated.
 */
export type FieldValue = string | null | Set<string>;

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
 */
export type DateFormatToken = "YYYY" | "MM" | "DD";

interface ParsedDateFormat {
  /** Anchored regex source compiled to match an input date string. */
  source: string;
  /** Capture-group order, parallel to the regex's groups. */
  order: DateFormatToken[];
}

// The ISO-string Date constructor rolls an out-of-range day/month over (e.g.
// Feb 29 in a non-leap year becomes Mar 1) instead of returning an Invalid
// Date, so isNaN alone would accept it; round-trip the parsed UTC components
// back against the input to catch rollover.
function isCalendarDateValid(
  year: string,
  month: string,
  day: string,
): boolean {
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
  return (
    !isNaN(date.getTime()) &&
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() + 1 === Number(month) &&
    date.getUTCDate() === Number(day)
  );
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

// Parse `input_format` -> YAML camelizes keys but not values, so format
// string tokens YYYY / MM / DD stay as written; delimiter characters are
// literal. Params arrive as camelCase after camelizeKeys (e.g. inputFormat).
function parseDateFactory(params: Params): StandardizingFn {
  // The wire params are z.unknown() and only count-bounded, so a partner can
  // declare either format as a non-string. An absent input format falls back to
  // the complete default; a present non-string is a dead key by design (the
  // satisfiability pre-flight is pinned to that verdict), realized here as an
  // empty format that tokenizes to an all-dropping pattern -- a raw non-string
  // would instead throw in parseDateFormat (`.startsWith` on an array). Guard the
  // output format by type too: a non-string there reaches `.replace` on a matched
  // row and throws, so it falls back to the absent default.
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

    const parts: Partial<Record<DateFormatToken, string>> = {};
    order.forEach((token, idx) => {
      // The source anchors every token group, so a successful whole-string match
      // populates each; guard the null only to satisfy the type and to leave the
      // part unset (caught by the YYYY/MM/DD presence check below) if it ever did
      // not participate.
      const value = groups[idx + 1];
      if (value === null) return;
      parts[token] = token === "YYYY" ? value : value.padStart(2, "0");
    });

    if (!parts.YYYY || !parts.MM || !parts.DD) return null;

    if (!isCalendarDateValid(parts.YYYY, parts.MM, parts.DD)) return null;

    return outputFormat
      .replace("YYYY", parts.YYYY)
      .replace("MM", parts.MM)
      .replace("DD", parts.DD);
  };
}

function substringFactory(params: Params): StandardizingFn {
  const start = params.start as number | undefined;
  const len = params.length as number | undefined;
  if (start === undefined || len === undefined || start === 0)
    return (_s) => null;
  if (start > 0) {
    // SQL SUBSTR convention: 1-indexed positive start — startIdx is fixed.
    const startIdx = start - 1;
    return (s) => {
      const result = s.slice(startIdx, startIdx + len);
      return result.length > 0 ? result : null;
    };
  }
  // Negative start counts from the end — depends on string length at call time.
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
  // TODO: metaphone
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
  // nullish: the wire params are z.unknown() and only count-bounded, so a partner
  // can declare `char` as a non-string, and calling `.normalize` on it would
  // throw. A non-string falls back to the "0" default, consistent with the absent
  // default.
  const char = (typeof params.char === "string" ? params.char : "0").normalize(
    "NFC",
  );
  if (char.length !== 1)
    throw new Error(`pad_left: "char" must be exactly one character`);
  return (s) => s.padStart(length, char);
}

function nullIfFactory(params: Params): StandardizingFn {
  // Build the exclusion set from string entries only. The wire params are
  // z.unknown() and only count-bounded, so a partner can declare `values` as a
  // non-array or with non-string elements, or `value` as a non-string scalar;
  // normalizing any of those below would throw. A non-string can never equal a
  // string cell, so a non-array `values` and any non-string entry contribute no
  // exclusion rather than crashing.
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
  // wire params are z.unknown() and only count-bounded, so a partner can declare
  // `replacement` as a non-string, and calling `.normalize` on it would throw. A
  // non-string falls back to the empty replacement, consistent with the absent
  // default.
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
// in docs/EXCHANGE_REFERENCE.md § "Available functions", which is a prose
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

// --- Function descriptors ----------------------------------------------------

/**
 * The authoring-risk tier of a standardization function.
 *
 * - `standard` -- every function whose params are plain typed values.
 * - `regex` -- the raw-pattern family (`replace_regex`, `extract_regex`,
 *   `filter_regex`, `split_on`), whose param is an operator-authored regular
 *   expression. These patterns run under the linear-time engine (see
 *   utils/linearRegex.ts), so an unbounded pattern can no longer hang on
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
   * params, which stay `z.unknown()` and are count-bounded in
   * `config/linkageTerms.ts`. The drift test pins each schema against its factory
   * so a descriptor cannot disagree with the function it describes.
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
 * This replaces the danger-tier "catastrophic backtracking is the editor's
 * problem" gate: under a non-backtracking engine there is no danger tier to gate,
 * only the dialect to conform to. See docs/spec/PROTOCOL.md.
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
    // The factory does no numeric validation -- it relies on String.slice, which
    // tolerates fractional and negative bounds -- so the schema is deliberately
    // stricter than the factory here, rejecting footgun shapes (a fractional
    // position, a non-positive length, a 0 start) that slice would silently
    // mangle. 0 is rejected because the factory treats it as a no-op returning an
    // always-null fn; positions are 1-indexed, with a negative start counting
    // from the end.
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
      "Reformat a date between token layouts (YYYY, MM, DD) so different formats can match.",
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

type CompiledStep =
  | { kind: "fn"; fn: StandardizingFn }
  | { kind: "coalesce"; default: string | undefined };

function compileStep(step: {
  function: string;
  params?: Params;
}): CompiledStep {
  const params = step.params ?? {};
  if (step.function === "coalesce") {
    // NFC-normalize the literal default so coalesce cannot substitute a non-NFC
    // value into the key (it replaces the whole value, often as the last step).
    // Guard by type, not just nullish: the wire params are z.unknown() and only
    // count-bounded, so a partner can declare `default` as any JSON value, and
    // calling `.normalize` on a non-string (null, number, array, object) would
    // throw while building the first row's key. Any non-string behaves as an
    // absent default; it is not String()-coerced, which would mangle an array or
    // object into a bogus substitution value.
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
  return { kind: "fn", fn: factory(params) };
}

function compileSteps(
  steps: Array<{ function: string; params?: Params }>,
): CompiledStep[] {
  return steps.map(compileStep);
}

// --- Step execution ----------------------------------------------------------

// `coalesce` is the only function that operates on null (or an empty array
// produced by prior null-filtering). All other functions null-propagate.
function applyStep(current: FieldValue, step: CompiledStep): FieldValue {
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
        for (const sv of r) out.add(sv);
      } else {
        out.add(r);
      }
    }
    return out.size === 0 ? null : out;
  }

  return step.fn(current);
}

// --- Pipeline ----------------------------------------------------------------

function runCompiledPipeline(input: string, steps: CompiledStep[]): FieldValue {
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
    current = applyStep(current, step);
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

/**
 * A lazily-evaluated, cached mapping from a raw dataset row index to the set
 * of standardized string values for one linkage field.
 *
 * Each value in the returned set generates a separate PSI entry for that row,
 * while all entries retain the original row index so that matches resolve back
 * to the source record. An empty array indicates that the record has no valid
 * value for this field and is excluded from any linkage key that references it.
 */
export class StandardizedField {
  readonly name: string;
  private readonly inputColumn: string;
  private readonly compiledSteps: CompiledStep[];
  private readonly rawRows: ReadonlyArray<CSVRow>;
  private readonly cache = new Map<number, string[]>();

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
   * Return the standardized values for the row at `index`.
   *
   * The result is computed on first access and cached for subsequent calls.
   * An empty array signals that the record has no valid value for this field.
   */
  get(index: number): string[] {
    const cached = this.cache.get(index);
    if (cached !== undefined) return cached;

    const row = this.rawRows[index];
    const raw = row ? readRowColumn(row, this.inputColumn) : undefined;
    if (raw === undefined) {
      this.cache.set(index, []);
      return [];
    }
    const values = toValueSet(runCompiledPipeline(raw, this.compiledSteps));
    this.cache.set(index, values);
    return values;
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
 * the two can no longer encode the resolution rules independently and drift (the
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

// Element-level transforms must produce a single string (they do not fan out).
// If a fan-out step appears in an element transform it is collapsed by joining.
function applyElementTransform(
  value: string,
  steps: TransformStep[] | undefined,
): string | null {
  // No steps: the value passes through unchanged (the empty-pipeline identity),
  // and nothing is compiled or memoized.
  if (steps === undefined || steps.length === 0) return value;
  let compiled = compiledElementTransforms.get(steps);
  if (compiled === undefined) {
    compiled = compileSteps(steps);
    compiledElementTransforms.set(steps, compiled);
  }
  let current: FieldValue = value;
  for (const step of compiled) {
    current = applyStep(current, step);
    if (current instanceof Set) current = [...current].join("");
  }
  return current as string | null;
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

const KEY_STRING_WARN_THRESHOLD = 20;

/**
 * Build all key strings for one linkage key round given a standardized dataset
 * and a row index.
 *
 * Returns `null` if any element's field value set is empty (the record is
 * excluded from this key round). Otherwise returns one or more strings: more
 * than one arises from fan-out fields producing a cross-product across
 * elements.
 *
 * All returned strings belong to the same original row at `index`; the caller
 * is responsible for preserving that association when adding entries to the PSI
 * set.
 *
 * `isReceiver` controls whether the key's `swap` directive is applied. The
 * receiver builds keys with the named elements swapped; the sender does not.
 *
 * Note: `generateFuzzyComparisons` on individual elements is not yet applied
 * here; that expansion is handled separately by the PSI preparation layer.
 */
export function buildKeyStrings(
  key: LinkageKey,
  dataset: StandardizedDataset,
  index: number,
  isReceiver = false,
): Set<string> | null {
  const elements =
    isReceiver && key.swap
      ? swapElements(key.elements, key.swap)
      : key.elements;

  const elementValues: string[][] = [];

  for (const element of elements) {
    const field = dataset.getField(element.field);
    const raw = field ? field.get(index) : [];
    if (raw.length === 0) return null;

    const transformed: string[] = [];
    for (const v of raw) {
      const t = applyElementTransform(v, element.transform);
      if (t !== null) transformed.push(t);
    }
    if (transformed.length === 0) return null;
    elementValues.push(transformed);
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

  if (result.size > KEY_STRING_WARN_THRESHOLD) {
    logger.warn(
      `row ${index}, key "${sanitizeForDisplay(key.name)}": cross-product produced ` +
        `${result.size} key strings (>${KEY_STRING_WARN_THRESHOLD}); fan-out ` +
        "in dual-party-output exchanges may degrade privacy guarantees",
    );
  }

  return result;
}

// --- Standardized key iterable ----------------------------------------------

/**
 * An {@link IndexableIterable} over a single {@link LinkageKey} round,
 * bridging the {@link StandardizedDataset} + {@link buildKeyStrings} pipeline
 * to the `Array<IndexableIterable<string | undefined>>` interface required by
 * `linkViaPSI`.
 *
 * Per-row behaviour:
 * - `null` from {@link buildKeyStrings} -> `undefined` (record excluded).
 * - Singleton `Set<string>` -> the one string.
 * - Multi-value `Set<string>` (fan-out not yet in scope) -> `undefined`.
 */
export class StandardizedKeyIterable {
  [index: number]: string | undefined;

  readonly length: number;
  private readonly key: LinkageKey;
  private readonly dataset: StandardizedDataset;
  private readonly isReceiver: boolean;

  constructor(
    key: LinkageKey,
    dataset: StandardizedDataset,
    rowCount: number,
    isReceiver = false,
  ) {
    this.key = key;
    this.dataset = dataset;
    this.length = rowCount;
    this.isReceiver = isReceiver;

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

  private valueAt(index: number): string | undefined {
    const result = buildKeyStrings(
      this.key,
      this.dataset,
      index,
      this.isReceiver,
    );
    if (result === null || result.size === 0) return undefined;
    if (result.size > 1) return undefined;
    return result.values().next().value as string;
  }

  *[Symbol.iterator](): Iterator<string | undefined> {
    for (let i = 0; i < this.length; i++) {
      yield this.valueAt(i);
    }
  }

  at(index: number): string | undefined {
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
 * each message are routed through {@link sanitizeForDisplay} at the point of
 * interpolation -- consistent with the sibling `assertPayloadSendDisclosed` /
 * `validateCompatibility` guards -- so a caller that surfaces a message is safe
 * without re-sanitizing, rather than relying on every call site to do so.
 */
export function validateStandardizationAgainstTerms(
  standardization: Standardization,
  terms: LinkageTerms,
): string[] {
  const errors: string[] = [];
  const fieldNames = new Set(terms.linkageFields.map((f) => f.name));

  for (const t of standardization) {
    const output = sanitizeForDisplay(t.output);
    if (!fieldNames.has(t.output)) {
      errors.push(
        `standardization output "${output}" does not match any linkage ` +
          "field name",
      );
    }
    for (const step of t.steps ?? []) {
      if (!STANDARDIZATION_FUNCTION_NAMES.includes(step.function)) {
        errors.push(
          `unknown standardization function ` +
            `"${sanitizeForDisplay(step.function)}" in transformation for ` +
            `"${output}"`,
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
 * The linkage fields in `terms` that the input `columns` cannot satisfy through
 * the available data standardizations. The verdict is derived from the same
 * {@link resolveFieldColumns} binding the exchange's {@link buildStandardizedDataset}
 * uses: a field is producible exactly when the shared resolution bound it to a
 * column that is present in `columns`. The checker no longer re-derives the
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
 * The date components {@link parseDateFactory} requires to emit any value. The
 * factory populates a component only for a token its INPUT format declares, then
 * returns null unless all three are present (its unconditional
 * `!parts.YYYY || !parts.MM || !parts.DD` guard), so an input format omitting any
 * of these produces null for every value.
 */
const PARSE_DATE_REQUIRED_COMPONENTS: readonly DateFormatToken[] = [
  "YYYY",
  "MM",
  "DD",
];

/**
 * Whether a `parse_date` step's INPUT format omits a date component the factory
 * requires, making {@link parseDateFactory} return null for EVERY value -- the
 * record is dropped regardless of its data. The motivating example is
 * `input_format: "MM/DD"` (no year): with no `YYYY` token, `parts.YYYY` is never
 * set and the factory's all-three-components guard drops every value.
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
  return PARSE_DATE_REQUIRED_COMPONENTS.some((token) => !present.has(token));
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
  // latter is now rejected upstream by LinkageTermsSchema's referential-integrity
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
// known). Promoted out of the web workbench so the web's constraint badges and the
// CLI's prepare-path warnings run ONE implementation (board item 202994324).
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
