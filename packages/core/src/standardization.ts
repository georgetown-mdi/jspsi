import { z } from "zod";
import { getLogger } from "./utils/logger.js";
import { sanitizeForDisplay } from "./utils/sanitizeForDisplay.js";
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
import { inferMetadata } from "./config/metadata.js";
import type { ColumnMetadata } from "./config/metadata.js";

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
    .replaceAll(/\s\+/g, " ")
    .trim();
}

// Parse `input_format` -> YAML camelizes keys but not values, so format
// string tokens YYYY / MM / DD stay as written; delimiter characters are
// literal. Params arrive as camelCase after camelizeKeys (e.g. inputFormat).
function parseDateFactory(params: Params): StandardizingFn {
  const inputFormat =
    (params.inputFormat as string | undefined) ?? "MM/DD/YYYY";
  const outputFormat =
    (params.outputFormat as string | undefined) ?? "YYYYMMDD";

  type Token = "YYYY" | "MM" | "DD";
  const order: Token[] = [];
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

  const re = new RegExp(`^${regexStr}$`);

  return (s) => {
    // Normalize before matching (see the STANDARDIZING_FUNCTIONS contract). Date
    // separators are ASCII in practice, so this is a no-op on real input, but it
    // keeps parse_date inside the same authored-pattern-matching family as the
    // other regex steps rather than a silent exception.
    const m = s.normalize("NFC").match(re);
    if (!m) return null;

    const parts: Partial<Record<Token, string>> = {};
    order.forEach((token, idx) => {
      parts[token] =
        token === "YYYY" ? m[idx + 1] : m[idx + 1].padStart(2, "0");
    });

    if (!parts.YYYY || !parts.MM || !parts.DD) return null;

    // Reject calendar-invalid dates (e.g. month 13).
    const asDate = new Date(`${parts.YYYY}-${parts.MM}-${parts.DD}`);
    if (isNaN(asDate.getTime())) return null;

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

// Soundex: standard US English encoding, 4-character result.
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
  // must hold on the normalized value that actually pads.
  const char = ((params.char as string | undefined) ?? "0").normalize("NFC");
  if (char.length !== 1)
    throw new Error(`pad_left: "char" must be exactly one character`);
  return (s) => s.padStart(length, char);
}

function nullIfFactory(params: Params): StandardizingFn {
  const values =
    params.values !== undefined
      ? (params.values as string[])
      : params.value !== undefined
        ? [params.value as string]
        : [];
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
  const pattern = params.pattern as string;
  // NFC-normalize the replacement literal so it cannot inject a non-NFC byte
  // sequence into the key (the pattern itself is matched as authored; author it
  // in NFC to match NFC runtime values).
  const replacement = (
    (params.replacement as string | undefined) ?? ""
  ).normalize("NFC");
  const re = new RegExp(pattern, "g");
  // Normalize before matching (see the STANDARDIZING_FUNCTIONS contract) so an
  // authored-NFC pattern matches a value left non-NFC by an upstream case-fold;
  // the result is derived from the normalized value, byte-identical for
  // already-canonical inputs.
  return (s) => s.normalize("NFC").replace(re, replacement);
}

function extractRegexFactory(params: Params): StandardizingFn {
  const pattern = params.pattern as string;
  const re = new RegExp(pattern);
  // Match AND slice on the NFC-normalized value (see the STANDARDIZING_FUNCTIONS
  // contract): an authored-NFC pattern must match a value left non-NFC by an
  // upstream case-fold, and the returned capture must come from the same
  // normalized string -- NFC can change the code-unit count, so a capture taken
  // from the original could misalign. `match` returns capture substrings of the
  // string it ran against, so slicing follows the normalized value for free.
  return (s) => {
    const m = s.normalize("NFC").match(re);
    if (!m) return null;
    return (m[1] ?? m[0]) || null;
  };
}

function filterRegexFactory(params: Params): StandardizingFn {
  const pattern = params.pattern as string;
  const re = new RegExp(pattern);
  // NFC-normalize before testing (see the STANDARDIZING_FUNCTIONS contract) so
  // an authored-NFC pattern matches a value left non-NFC by an upstream
  // case-fold; return the original value on a match so emitted bytes for
  // already-canonical inputs are untouched.
  return (s) => (re.test(s.normalize("NFC")) ? s : null);
}

function splitOnFactory(params: Params): StandardizingFn {
  const delimiter = params.delimiter as string;
  const includeOriginal =
    (params.includeOriginal as boolean | undefined) ?? false;
  const re = new RegExp(delimiter);
  return (s) => {
    // Normalize before splitting (see the STANDARDIZING_FUNCTIONS contract) so
    // an authored-NFC delimiter matches a value left non-NFC by an upstream
    // case-fold. Parts (and the unsplit value) come from the normalized form,
    // like extract_regex, since the split offsets are computed on it; this is a
    // no-op for already-canonical inputs.
    const n = s.normalize("NFC");
    const parts = n.split(re).filter((p) => p.length > 0);
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
 *   expression. This is the danger tier: an editor must gate raw-pattern
 *   authoring behind a catastrophic-backtracking-aware affordance, because an
 *   unbounded user pattern can hang on adversarial input. The descriptor marks
 *   the tier; enforcing the gate is the editor's responsibility.
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
 * A user-authored regular-expression param. Required, and validated to compile,
 * mirroring each regex factory's `new RegExp(pattern)` (which throws on an
 * invalid pattern; `replace_regex` adds the global flag, which does not affect
 * validity). The danger-tier gate against catastrophic backtracking is the
 * editor's responsibility; this only rejects a syntactically invalid pattern.
 */
const regexPatternSchema = z
  .string()
  .min(1)
  .refine(
    (pattern) => {
      try {
        new RegExp(pattern);
        return true;
      } catch {
        return false;
      }
    },
    { message: "must be a valid regular expression" },
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
    // Format strings are bounded to non-empty only, not their token content: a
    // tokenless format is accepted, mirroring the factory, which builds a regex
    // from any string and simply matches little (yielding null) rather than
    // throwing. Requiring a YYYY/MM/DD token would reject a shape the factory
    // accepts; surfacing tokenless formats is editor guidance, not validation.
    params: z.object({
      inputFormat: z.string().min(1).default("MM/DD/YYYY"),
      outputFormat: z.string().min(1).default("YYYYMMDD"),
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
    const rawDefault = params.default as string | undefined;
    return {
      kind: "coalesce",
      default:
        rawDefault === undefined ? undefined : rawDefault.normalize("NFC"),
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
  private readonly rawRows: ReadonlyArray<Record<string, string>>;
  private readonly cache = new Map<number, string[]>();

  constructor(
    name: string,
    inputColumn: string,
    steps: StandardizationStep[],
    rawRows: ReadonlyArray<Record<string, string>>,
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
    const raw = row?.[this.inputColumn];
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
 *    present in the data -- UNLESS that column is `role: ignored`, in which case
 *    the field binds to nothing: `ignored` ("never participates in linkage")
 *    wins over a contradictory explicit transform. (When two transformations name
 *    the same output the last wins, matching the builder's field map and the
 *    checker's old mapping.)
 * 2. Type fallback: otherwise the field binds to the FIRST `metadata` column of
 *    its semantic type that is not `role: ignored`
 *    (`metadata.find(c => c.type === field.type && c.role !== "ignored")`), or to
 *    nothing when no such column exists. First-match -- not "any same-typed
 *    column" -- because the exchange reads exactly that column. An ignored column
 *    is skipped even when it is the only one of its type, so it never links.
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
      // An explicit standardization naming a `role: ignored` column must not
      // bind it into linkage: `ignored` means "never participates in linkage",
      // and that wins over a contradictory explicit transform. The field then
      // resolves to no column (surfacing as unsatisfiable through the shared
      // checker) rather than silently linking a column the operator excluded.
      const inputIgnored =
        metadata.find((c) => c.name === transform.input)?.role === "ignored";
      if (inputIgnored) {
        resolution.set(field.name, { column: undefined, transform: undefined });
      } else {
        resolution.set(field.name, { column: transform.input, transform });
      }
      continue;
    }
    // Skip `role: ignored` columns: the linkage path keys on `type`, not
    // `role`, so an ignored column of the field's type would otherwise bind here
    // and participate in linkage. This is the one chokepoint the builder, the
    // satisfiability checker, and the default-standardization derivation share,
    // so excluding it once keeps an ignored column out of all three.
    const col = metadata.find(
      (c) => c.type === field.type && c.role !== "ignored",
    );
    resolution.set(field.name, { column: col?.name, transform: undefined });
  }
  return resolution;
}

/**
 * Build a {@link StandardizedDataset} for the linkage fields in `terms`, binding
 * each field to an input column via {@link resolveFieldColumns}: an explicit
 * standardization transformation when one names the field (its steps run on the
 * bound column), otherwise the identity transformation over the first metadata
 * column of the field's semantic type that is not `role: ignored`.
 *
 * Linkage fields that resolve to no column are absent from the dataset; records
 * referencing those fields are excluded from the corresponding linkage keys.
 */
export function buildStandardizedDataset(
  standardization: Standardization | undefined,
  rawRows: ReadonlyArray<Record<string, string>>,
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

// Element-level transforms must produce a single string (they do not fan out).
// If a fan-out step appears in an element transform it is collapsed by joining.
function applyElementTransform(
  value: string,
  steps: TransformStep[],
): string | null {
  const compiled = compileSteps(steps);
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
      const t = applyElementTransform(v, element.transform ?? []);
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
 * spec is consistent with these terms.
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
          `unknown standardization function "${step.function}" in ` +
            `transformation for "${t.output}"`,
        );
      }
    }
  }

  return errors;
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
 * and the type fallback binds to the FIRST non-`ignored` metadata column of the
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

/** How an input's columns fare against a set of linkage terms: which fields it
 * cannot produce, and how many of the terms' linkage keys remain usable as a
 * result. {@link satisfiableKeyCount} of 0 is the block signal -- every key
 * references at least one unproducible field, so an exchange would emit no key
 * strings and yield a result byte-indistinguishable from a legitimately empty
 * intersection. */
export interface LinkageSatisfiability {
  /** The linkage fields the columns cannot produce (see
   * {@link unsatisfiedLinkageFields}); empty when the input satisfies every field. */
  unsatisfied: LinkageField[];
  /** The number of linkage keys all of whose element fields are satisfiable.
   * Zero means no key can match and the exchange should be blocked rather than
   * run to a silent empty result. */
  satisfiableKeyCount: number;
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
 * it can only over-claim "satisfiable", never wrongly block.
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
  const satisfiableKeyCount = terms.linkageKeys.filter((k) =>
    k.elements.every((e) => producibleNames.has(e.field)),
  ).length;
  return { unsatisfied, satisfiableKeyCount };
}
