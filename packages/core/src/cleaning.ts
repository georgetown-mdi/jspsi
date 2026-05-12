import { getLogger } from "./utils/logger.js";
import type { Cleaning, CleaningStep } from "./config/cleaning.js";
import type {
  LinkageKey,
  LinkageKeyElement,
  LinkageTerms,
  TransformStep,
} from "./config/linkageTerms.js";
import type { ColumnMetadata } from "./config/metadata.js";

const logger = getLogger("cleaning");

// ─── Value types ─────────────────────────────────────────────────────────────

/**
 * The result type for a single cleaning pipeline or step.
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

// ─── Cleaning functions ──────────────────────────────────────────────────────

type Params = Record<string, unknown>;
type CleaningFn = (value: string, params: Params) => FieldValue;

function removePunctuation(s: string): string {
  return s.replace(/[^a-zA-Z0-9\s]/g, "");
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
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
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

function stripAffixes(s: string): string {
  return s
    .replaceAll(suffixPattern, "")
    .replaceAll(titlePattern, "")
    .replaceAll(/\s\+/g, " ")
    .trim();
}

// Parse `input_format` -> YAML camelizes keys but not values, so format
// string tokens YYYY / MM / DD stay as written; delimiter characters are
// literal. Params arrive as camelCase after camelizeKeys (e.g. inputFormat).
function parseDateFn(s: string, params: Params): string | null {
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

  const m = s.match(new RegExp(`^${regexStr}$`));
  if (!m) return null;

  const parts: Partial<Record<Token, string>> = {};
  order.forEach((token, idx) => {
    parts[token] = token === "YYYY" ? m[idx + 1] : m[idx + 1].padStart(2, "0");
  });

  if (!parts.YYYY || !parts.MM || !parts.DD) return null;

  // Reject calendar-invalid dates (e.g. month 13).
  const asDate = new Date(`${parts.YYYY}-${parts.MM}-${parts.DD}`);
  if (isNaN(asDate.getTime())) return null;

  return outputFormat
    .replace("YYYY", parts.YYYY)
    .replace("MM", parts.MM)
    .replace("DD", parts.DD);
}

function substringFn(s: string, params: Params): string | null {
  const start = params.start as number | undefined;
  const length = params.length as number | undefined;
  if (start === undefined || length === undefined || start === 0) return null;
  // SQL SUBSTR convention: 1-indexed; negative start counts from the end.
  const startIdx = start > 0 ? start - 1 : Math.max(0, s.length + start);
  const result = s.slice(startIdx, startIdx + length);
  return result.length > 0 ? result : null;
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

function phoneticFn(s: string, params: Params): string | null {
  const algorithm = (params.algorithm as string | undefined) ?? "soundex";
  if (algorithm === "soundex") {
    const result = soundex(s);
    return result !== "0000" ? result : null;
  }
  throw new Error(`unsupported phonetic algorithm: "${algorithm}"`);
}

function nullIfFn(s: string, params: Params): string | null {
  const values =
    params.values !== undefined
      ? (params.values as string[])
      : params.value !== undefined
        ? [params.value as string]
        : [];
  return values.includes(s) ? null : s;
}

function replaceRegexFn(s: string, params: Params): string {
  const pattern = params.pattern as string;
  const replacement = (params.replacement as string | undefined) ?? "";
  return s.replace(new RegExp(pattern, "g"), replacement);
}

function extractRegexFn(s: string, params: Params): string | null {
  const pattern = params.pattern as string;
  const m = s.match(new RegExp(pattern));
  if (!m) return null;
  return (m[1] ?? m[0]) || null;
}

function filterRegexFn(s: string, params: Params): string | null {
  const pattern = params.pattern as string;
  return new RegExp(pattern).test(s) ? s : null;
}

function splitOnFn(s: string, params: Params): Set<string> {
  const delimiter = params.delimiter as string;
  const includeOriginal =
    (params.includeOriginal as boolean | undefined) ?? false;
  const parts = s.split(new RegExp(delimiter)).filter((p) => p.length > 0);
  if (parts.length <= 1) return new Set([s]);
  return includeOriginal ? new Set([s, ...parts]) : new Set(parts);
}

const CLEANING_FUNCTIONS: Record<string, CleaningFn> = {
  remove_punctuation: removePunctuation,
  remove_dashes: removeDashes,
  trim_whitespace: trimWhitespace,
  to_upper_case: toUpperCase,
  to_lower_case: toLowerCase,
  remove_accents: removeAccents,
  strip_affixes: stripAffixes,
  parse_date: parseDateFn,
  substring: substringFn,
  phonetic: phoneticFn,
  null_if: nullIfFn,
  replace_regex: replaceRegexFn,
  extract_regex: extractRegexFn,
  filter_regex: filterRegexFn,
  split_on: splitOnFn,
};

// ─── Step execution ──────────────────────────────────────────────────────────

function applyStepToString(
  value: string,
  fn: string,
  params: Params,
): FieldValue {
  const impl = CLEANING_FUNCTIONS[fn];
  if (!impl) throw new Error(`unknown cleaning function: "${fn}"`);
  return impl(value, params);
}

// `coalesce` is the only function that operates on null (or an empty array
// produced by prior null-filtering). All other functions null-propagate.
function applyStep(
  current: FieldValue,
  step: { function: string; params?: Params },
): FieldValue {
  const params = step.params ?? {};

  if (step.function === "coalesce") {
    if (current === null || (current instanceof Set && current.size === 0)) {
      return (params.default as string | undefined) ?? null;
    }
    return current;
  }

  if (current === null) return null;

  if (current instanceof Set) {
    const out = new Set<string>();
    for (const v of current) {
      const r = applyStepToString(v, step.function, params);
      if (r === null) continue;
      if (r instanceof Set) {
        for (const sv of r) out.add(sv);
      } else {
        out.add(r);
      }
    }
    return out.size === 0 ? null : out;
  }

  return applyStepToString(current, step.function, params);
}

// ─── Pipeline ────────────────────────────────────────────────────────────────

/**
 * Apply a sequence of cleaning steps to a raw string value.
 *
 * Returns `null` if any step filters the value out, `Set<string>` if a fan-out
 * step (e.g. `split_on`) was applied, or a plain `string` otherwise.
 */
export function runPipeline(
  input: string,
  steps: Array<{ function: string; params?: Params }>,
): FieldValue {
  let current: FieldValue = input;
  for (const step of steps) {
    current = applyStep(current, step);
  }
  return current;
}

// Convert a pipeline result to a value set. An empty array means the record
// has no valid value for this field and is excluded from the linkage protocol.
function toValueSet(result: FieldValue): string[] {
  if (result === null) return [];
  if (result instanceof Set) return [...result];
  return [result];
}

// ─── Standardized field ──────────────────────────────────────────────────────

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
  private readonly steps: CleaningStep[];
  private readonly rawRows: ReadonlyArray<Record<string, string>>;
  private readonly cache = new Map<number, string[]>();

  constructor(
    name: string,
    inputColumn: string,
    steps: CleaningStep[],
    rawRows: ReadonlyArray<Record<string, string>>,
  ) {
    this.name = name;
    this.inputColumn = inputColumn;
    this.steps = steps;
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
    const values = toValueSet(runPipeline(raw, this.steps));
    this.cache.set(index, values);
    return values;
  }
}

// ─── Standardized dataset ────────────────────────────────────────────────────

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

// Maps linkage field semantic types to the ColumnType values used in metadata.
const SEMANTIC_TO_METADATA: Record<string, string> = {
  ssn: "ssn",
  ssnLast4: "ssn4",
  firstName: "firstName",
  lastName: "lastName",
  dateOfBirth: "dateOfBirth",
  phoneNumber: "phoneNumber",
  emailAddress: "emailAddress",
};

/**
 * Build a {@link StandardizedDataset} from:
 *
 * 1. Explicit `cleaning` transformations (when provided).
 * 2. Identity transformations for linkage fields not covered by an explicit
 *    transformation, resolved by matching the field's semantic type against
 *    column metadata.
 *
 * Linkage fields that cannot be resolved by either mechanism are absent from
 * the dataset; records referencing those fields are excluded from the
 * corresponding linkage keys.
 */
export function buildStandardizedDataset(
  cleaning: Cleaning | undefined,
  rawRows: ReadonlyArray<Record<string, string>>,
  metadata: ColumnMetadata[],
  terms: LinkageTerms,
): StandardizedDataset {
  const fields: StandardizedField[] = [];
  const covered = new Set<string>();

  for (const t of cleaning ?? []) {
    fields.push(
      new StandardizedField(t.output, t.input, t.steps ?? [], rawRows),
    );
    covered.add(t.output);
  }

  for (const field of terms.linkageFields) {
    if (covered.has(field.name)) continue;
    const metadataType = SEMANTIC_TO_METADATA[field.semanticType];
    if (!metadataType) continue;
    const col = metadata.find((c) => c.type === metadataType);
    if (!col) continue;
    // Identity transformation: pass the raw column value through unchanged.
    fields.push(new StandardizedField(field.name, col.name, [], rawRows));
  }

  return new StandardizedDataset(fields);
}

// ─── Key building ────────────────────────────────────────────────────────────

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
  let current: FieldValue = value;
  for (const step of steps) {
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
  // Swap the field references while keeping each element's own name and transforms.
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

  const result = new Set(
    cartesianProduct(elementValues).map((parts) => parts.join("")),
  );

  if (result.size > KEY_STRING_WARN_THRESHOLD) {
    logger.warn(
      `row ${index}, key "${key.name}": cross-product produced ` +
        `${result.size} key strings (>${KEY_STRING_WARN_THRESHOLD}); fan-out ` +
        "in dual-party-output exchanges may degrade privacy guarantees",
    );
  }

  return result;
}

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * Validate that every cleaning transformation output name corresponds to a
 * linkage field defined in the provided terms, and that every step function
 * name is known.
 *
 * Returns a list of error messages; an empty array means the cleaning spec is
 * consistent with these terms.
 */
export function validateCleaningAgainstTerms(
  cleaning: Cleaning,
  terms: LinkageTerms,
): string[] {
  const errors: string[] = [];
  const fieldNames = new Set(terms.linkageFields.map((f) => f.name));

  for (const t of cleaning) {
    if (!fieldNames.has(t.output)) {
      errors.push(
        `cleaning output "${t.output}" does not match any linkage field name`,
      );
    }
    for (const step of t.steps ?? []) {
      if (
        step.function !== "coalesce" &&
        !(step.function in CLEANING_FUNCTIONS)
      ) {
        errors.push(
          `unknown cleaning function "${step.function}" in transformation ` +
            `for "${t.output}"`,
        );
      }
    }
  }

  return errors;
}
