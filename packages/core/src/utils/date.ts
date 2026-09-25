import { dateOfBirthSteps } from "../defaults/builtInStandardization.js";
import { readRowColumn } from "../file.js";
import type { CSVRow } from "../file.js";
import { compileSteps, runCompiledPipeline } from "../standardization.js";

/**
 * Candidate date input formats tried by {@link inferDateFormat}, ordered from
 * most- to least-preferred. When two formats parse the same number of values
 * (e.g. all days <= 12), the earlier entry wins.
 */
export const CANDIDATE_DATE_FORMATS = [
  "MM/DD/YYYY",
  "YYYY-MM-DD",
  "YYYYMMDD",
  "MM-DD-YYYY",
  "MM/DD/YY",
  "YYYY/MM/DD",
  "DD/MM/YYYY",
  "DD-MM-YYYY",
] as const;

/** One of {@link CANDIDATE_DATE_FORMATS}. */
export type CandidateDateFormat = (typeof CANDIDATE_DATE_FORMATS)[number];

/**
 * Maximum number of non-empty values scanned by {@link inferDateFormat}.
 *
 * The cap counts every non-empty value iterated, including values that no
 * candidate can parse (noise). A column with many leading noise values may
 * exhaust the cap before any format is inferred.
 */
export const INFER_DATE_SCAN_CAP = 1000;

type CandidateParser = readonly [
  CandidateDateFormat,
  (value: string) => boolean,
];

let candidateParsers: ReadonlyArray<CandidateParser> | undefined;

// Each candidate is tested with the default date_of_birth pipeline the run
// applies, so inference and the run agree on what a format accepts.
function getCandidateParsers(): ReadonlyArray<CandidateParser> {
  candidateParsers ??= CANDIDATE_DATE_FORMATS.map((format) => {
    const steps = compileSteps(dateOfBirthSteps(format));
    return [
      format,
      (value: string) => runCompiledPipeline(value, steps) !== null,
    ] as const;
  });
  return candidateParsers;
}

/** What {@link inferDateFormatWithCounts} found in a column's values. */
export interface DateFormatInference {
  /** The inferred format, absent when no candidate qualifies. */
  format?: CandidateDateFormat;
  /** The non-empty values scanned, at most {@link INFER_DATE_SCAN_CAP}. */
  scanned: number;
  /** The scanned values {@link format} does not parse: all of them when no
   * format is inferred. */
  unparsed: number;
}

/**
 * An incremental {@link inferDateFormatWithCounts}, fed one value at a time so
 * a streaming reader can infer several columns in one pass.
 */
export interface DateFormatInferrer {
  /** Scan one value; an empty value is ignored. Returns false once the scan
   * cap is reached, after which every value is ignored. */
  add(value: string | undefined): boolean;
  /** The inference over the values scanned so far. */
  result(): DateFormatInference;
}

/** Start an incremental date-format inference; see {@link DateFormatInferrer}. */
export function createDateFormatInferrer(): DateFormatInferrer {
  const parsers = getCandidateParsers();
  const counts = parsers.map(() => 0);
  let scanned = 0;
  let parsedByAny = 0;

  return {
    add(value) {
      if (scanned >= INFER_DATE_SCAN_CAP) return false;
      if (value === undefined || value.trim() === "") return true;
      let parsedHere = false;
      parsers.forEach(([, parses], index) => {
        if (parses(value)) {
          counts[index] += 1;
          parsedHere = true;
        }
      });
      if (parsedHere) parsedByAny += 1;
      scanned += 1;
      return scanned < INFER_DATE_SCAN_CAP;
    },
    result() {
      let best = 0;
      counts.forEach((count, index) => {
        if (count > counts[best]) best = index;
      });
      if (counts[best] * 2 <= parsedByAny)
        return { scanned, unparsed: scanned };
      return {
        format: parsers[best][0],
        scanned,
        unparsed: scanned - counts[best],
      };
    },
  };
}

/**
 * Infers the date format of a column from its values, and counts the scanned
 * values the result does not parse.
 *
 * Each of the first {@link INFER_DATE_SCAN_CAP} non-empty values is tested
 * against every {@link CANDIDATE_DATE_FORMATS} entry with the default
 * `date_of_birth` pipeline, the rule the run applies. The result is the
 * candidate that parses the most values, the earliest in the table on a tie
 * (a column whose days are all 12 or under parses equally as `MM/DD/YYYY` and
 * `DD/MM/YYYY`). A value no candidate parses is noise and supports none. The
 * result is refused unless it parses more than half of the values some
 * candidate parses, so a few mistyped values cannot choose the format, and a
 * column split between two layouts yields none.
 *
 * The `values` iterable is consumed lazily in a single pass: empty values are
 * skipped without consuming the scan budget, and iteration stops at the cap, so
 * a large or unbounded source (e.g. {@link columnValues} over a whole file) is
 * read only up to that bound rather than materialized in full.
 */
export function inferDateFormatWithCounts(
  values: Iterable<string>,
): DateFormatInference {
  const inferrer = createDateFormatInferrer();
  for (const value of values) {
    if (!inferrer.add(value)) break;
  }
  return inferrer.result();
}

/**
 * The format {@link inferDateFormatWithCounts} infers, or `undefined` when
 * the values yield none.
 */
export function inferDateFormat(values: Iterable<string>): string | undefined {
  return inferDateFormatWithCounts(values).format;
}

/**
 * Lazily yields one column's value per row (the empty string when the column is
 * absent from a row), so {@link inferDateFormat} can scan a bounded prefix of a
 * large file without first materializing the whole column. Pair the two:
 * `inferDateFormat(columnValues(rows, dobColumn))`.
 */
export function* columnValues(
  rows: Iterable<CSVRow>,
  column: string,
): Generator<string> {
  for (const row of rows) yield readRowColumn(row, column) ?? "";
}
