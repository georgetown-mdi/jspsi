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
  // Drop a value that cleaned to empty (a blank or all-non-digit cell) here,
  // before pad_left can mask it: an empty string would otherwise pad to
  // "000000000" and be dropped only as a side effect of the placeholder null_if
  // below happening to list that value. Since item 203074741 the linkage layer
  // no longer drops "" together with the no-key sentinel, so the blank-cell
  // footgun is prevented explicitly here -- and stays prevented even if an
  // operator removes "000000000" from the placeholder list for their own data.
  { function: "null_if", params: { value: "" } },
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
  // Drop a value that cleaned to empty before pad_left masks it as "0000"; see
  // SSN_STEPS for why this explicit blank-drop is needed since item 203074741.
  { function: "null_if", params: { value: "" } },
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

// US 5-digit ZIP. Strip every non-digit (which subsumes a leading trim and
// non-ASCII removal), keep the first 5 digits so a ZIP+4 collapses to its
// 5-digit prefix, then zero-pad a short value to 5 (a New England ZIP stored
// without its leading zero). The explicit null_if drops a value that cleaned to
// empty (a blank or all-non-digit cell) before pad_left can mask it as "00000";
// substring already nulls an empty slice, so this mirrors the SSN pipeline's
// belt-and-suspenders null-before-pad rather than adding new coverage. Unlike
// SSN there is no placeholder null_if: "00000" is a real ZIP (USPS bulk/dummy
// and the floor of zero-padding), not a sentinel to drop, so none is excluded.
const ZIP_CODE_STEPS: StandardizationStep[] = [
  { function: "replace_regex", params: { pattern: "[^0-9]", replacement: "" } },
  { function: "substring", params: { start: 1, length: 5 } },
  { function: "null_if", params: { value: "" } },
  { function: "pad_left", params: { length: 5 } },
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
    case "zip_code":
      return ZIP_CODE_STEPS;
    default:
      return undefined;
  }
}

/**
 * Generates a default {@link Standardization} for the linkage fields in
 * `terms`, sourcing input column names from `metadata`.
 *
 * For each linkage field whose semantic type has a known default pipeline, a
 * transformation is produced that maps the first `role: linkage` metadata column
 * of that type to the field name. Semantic types without defaults (`identifier`,
 * `other`) are silently skipped, as are linkage fields with no `role: linkage`
 * column of their type.
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
  // standardization this is the pure type fallback (first `role: linkage`
  // metadata column of the field's type). Fields whose semantic type has no
  // default pipeline (`identifier`/`other`) are still skipped here and fall
  // through to the builder's own identity type-fallback at exchange time.
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
