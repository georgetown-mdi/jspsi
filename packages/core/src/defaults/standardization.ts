import { resolveFieldColumns } from "../standardization.js";

import type {
  Standardization,
  StandardizationStep,
} from "../config/standardization.js";
import type { ColumnMetadata } from "../config/metadata.js";
import type { LinkageTerms } from "../config/linkageTerms.js";

// --- Step arrays -------------------------------------------------------------

// Explicitly allow invalid SSNs for now.
const SSN_STEPS: StandardizationStep[] = [
  { function: "trim_whitespace" },
  { function: "remove_non_ascii" },
  { function: "remove_dashes" },
  // Remove any remaining non-digit characters (spaces, dots, parens).
  { function: "replace_regex", params: { pattern: "[^0-9]", replacement: "" } },
  // Zero-pad to 9 digits for SSNs stored without a leading zero.
  { function: "pad_left", params: { length: 9 } },
  // Reject anything that isn't exactly 9 digits.
  { function: "filter_regex", params: { pattern: "^\\d{9}$" } },
  {
    function: "null_if",
    params: { values: ["000000000", "111111111", "123456789"] },
  },
];

// SSN4 accepts either a bare 4-digit value or a full 9-digit SSN and extracts
// the last 4 digits in both cases.
const SSN4_STEPS: StandardizationStep[] = [
  { function: "trim_whitespace" },
  { function: "remove_non_ascii" },
  { function: "remove_dashes" },
  { function: "replace_regex", params: { pattern: "[^0-9]", replacement: "" } },
  // Zero-pad to 4 digits for SSN4 values stored without a leading zero.
  { function: "pad_left", params: { length: 4 } },
  { function: "extract_regex", params: { pattern: "(\\d{4})$" } },
  { function: "filter_regex", params: { pattern: "^\\d{4}$" } },
  { function: "null_if", params: { values: ["0000"] } },
];

// Shared pipeline for first and last names. Produces uppercase letters and
// spaces only, with affixes (Dr., Jr., etc.) removed, matching the
// `allowedCharacters: "A-Z "` constraint on the default linkage fields.
const NAME_STEPS: StandardizationStep[] = [
  { function: "trim_whitespace" },
  // Normalize diacritics before stripping non-ASCII so é->e, ñ->n, etc.
  { function: "remove_accents" },
  { function: "remove_non_ascii" },
  { function: "to_upper_case" },
  // Convert hyphens, apostrophes, and similar word separators to spaces so
  // O'Brien -> O BRIEN and Mary-Jane -> MARY JANE are treated as multi-token
  // names.
  { function: "replace_separators_with_spaces" },
  { function: "remove_affixes" },
  { function: "remove_punctuation" },
  { function: "squash_spaces" },
  { function: "trim_whitespace" },
  // Null out values that are empty after cleaning.
  { function: "filter_regex", params: { pattern: "[A-Z]" } },
];

function dateOfBirthSteps(inputFormat: string): StandardizationStep[] {
  return [
    { function: "trim_whitespace" },
    { function: "remove_non_ascii" },
    {
      function: "parse_date",
      params: { inputFormat, outputFormat: "YYYYMMDD" },
    },
  ];
}

// US 10-digit phone (digits only). A leading US country code (+1 or 1) on an
// 11-digit number is stripped before validation.
const PHONE_NUMBER_STEPS: StandardizationStep[] = [
  { function: "trim_whitespace" },
  { function: "remove_non_ascii" },
  { function: "replace_regex", params: { pattern: "[^0-9]", replacement: "" } },
  {
    function: "replace_regex",
    params: { pattern: "^1(\\d{10})$", replacement: "$1" },
  },
  { function: "filter_regex", params: { pattern: "^\\d{10}$" } },
];

const EMAIL_ADDRESS_STEPS: StandardizationStep[] = [
  { function: "trim_whitespace" },
  { function: "remove_non_ascii" },
  { function: "to_lower_case" },
  {
    function: "filter_regex",
    params: { pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$" },
  },
];

// --- Default standardization -------------------------------------------------

export interface DefaultStandardizationOptions {
  /**
   * Input date format for the `date_of_birth` pipeline, passed as `inputFormat`
   * to `parse_date`. Defaults to `"MM/DD/YYYY"` when omitted. Pair with
   * {@link inferDateFormat} to detect the format automatically.
   */
  dateInputFormat?: string;
}

function stepsForType(
  semanticType: string,
  opts: DefaultStandardizationOptions,
): StandardizationStep[] | undefined {
  switch (semanticType) {
    case "ssn":
      return SSN_STEPS;
    case "ssn4":
      return SSN4_STEPS;
    case "first_name":
      return NAME_STEPS;
    case "last_name":
      return NAME_STEPS;
    case "date_of_birth":
      return dateOfBirthSteps(opts.dateInputFormat ?? "MM/DD/YYYY");
    case "phone_number":
      return PHONE_NUMBER_STEPS;
    case "email_address":
      return EMAIL_ADDRESS_STEPS;
    default:
      return undefined;
  }
}

/**
 * Generates a default {@link Standardization} for the linkage fields in
 * `terms`, sourcing input column names from `metadata`.
 *
 * For each linkage field whose semantic type has a known default pipeline, a
 * transformation is produced that maps the first matching metadata column to
 * the field name. Semantic types without defaults (`identifier`, `other`) are
 * silently skipped, as are linkage fields whose type cannot be found in
 * metadata.
 *
 * The returned value can be passed directly to {@link buildStandardizedDataset}
 * and is appropriate when the user has not provided explicit standardization
 * configuration.
 *
 * **Date format**: the `date_of_birth` pipeline uses `options.dateInputFormat`
 * when provided, otherwise defaults to `"MM/DD/YYYY"`. Pair with
 * {@link inferDateFormat} to detect the format automatically from column data.
 */
export function getDefaultStandardization(
  metadata: ColumnMetadata[],
  terms: LinkageTerms,
  options: DefaultStandardizationOptions = {},
): Standardization {
  // Derive each field's input column from the same resolution primitive the
  // builder and satisfiability checker use, so the default-term mapping cannot
  // diverge from how the exchange actually binds columns. With no explicit
  // standardization this is the pure type fallback (first metadata column of the
  // field's type). Fields whose semantic type has no default pipeline
  // (`identifier`/`other`) are still skipped here and fall through to the
  // builder's own identity type-fallback at exchange time.
  const resolution = resolveFieldColumns(terms, undefined, metadata);
  const result: Standardization = [];

  for (const field of terms.linkageFields) {
    const steps = stepsForType(field.type, options);
    if (steps === undefined) continue;
    const column = resolution.get(field.name)?.column;
    if (column === undefined) continue;
    result.push({ output: field.name, input: column, steps });
  }

  return result;
}
