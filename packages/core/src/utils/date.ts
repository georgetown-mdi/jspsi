import { DateTime } from "luxon";

// ─── Date format inference ────────────────────────────────────────────────────

/**
 * Candidate date input formats tried by {@link inferDateFormat}, ordered from
 * most- to least-preferred. When two formats parse the same number of values
 * (e.g. all days ≤ 12), the earlier entry wins.
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

type CandidateDateFormat = (typeof CANDIDATE_DATE_FORMATS)[number];

/**
 * Maximum number of non-empty rows scanned by {@link inferDateFormat}.
 *
 * The cap counts every non-empty value iterated, including rows that no
 * candidate can parse (noise). A column with many leading noise rows may
 * exhaust the cap before any format is inferred.
 */
export const INFER_DATE_SCAN_CAP = 1000;

// Luxon format tokens for each candidate. Single-letter M/d accept both
// padded ("01") and bare ("1") months/days. YYYYMMDD uses a length guard
// because Luxon's M/d tokens accept 1-2 digits, so "1990115" would otherwise
// parse greedily as month=11, day=5.
const CANDIDATE_LUXON_FORMATS: Record<CandidateDateFormat, string> = {
  "MM/DD/YYYY": "M/d/yyyy",
  "YYYY-MM-DD": "yyyy-M-d",
  "YYYYMMDD":   "yyyyMMdd",
  "MM-DD-YYYY": "M-d-yyyy",
  "MM/DD/YY":   "M/d/yy",
  "YYYY/MM/DD": "yyyy/M/d",
  "DD/MM/YYYY": "d/M/yyyy",
  "DD-MM-YYYY": "d-M-yyyy",
};

function buildDateParser(format: CandidateDateFormat): (s: string) => boolean {
  const luxonFmt = CANDIDATE_LUXON_FORMATS[format];
  if (format === "YYYYMMDD") {
    return (s: string) => {
      const t = s.trim();
      return t.length === 8 && DateTime.fromFormat(t, luxonFmt).isValid;
    };
  }
  return (s: string) => DateTime.fromFormat(s.trim(), luxonFmt).isValid;
}

/**
 * Infers the date format used in a column of string values by scanning rows
 * and eliminating candidates that fail to parse.
 *
 * Starts with all {@link CANDIDATE_DATE_FORMATS} as candidates. For each
 * non-empty row, if at least one candidate parses the value, any candidate
 * that fails is eliminated. Rows that no candidate can parse are skipped
 * (treated as noise). Scanning stops as soon as only one candidate remains
 * or {@link INFER_DATE_SCAN_CAP} rows have been examined.
 *
 * Returns `undefined` when the column is empty or when scanning exhausts all
 * candidates.
 *
 * **Tie-breaking**: when more than one candidate survives (e.g. all days ≤ 12
 * so MM/DD and DD/MM are never disproved), the candidate that appears earliest
 * in {@link CANDIDATE_DATE_FORMATS} is returned — but only because it is
 * consistent with the data, not as a blind default.
 */
export function inferDateFormat(values: string[]): string | undefined {
  const nonEmpty = values.filter((v) => v !== undefined && v.trim() !== "");
  if (nonEmpty.length === 0) return undefined;

  const remaining = new Map<string, (s: string) => boolean>(
    CANDIDATE_DATE_FORMATS.map((fmt) => [fmt, buildDateParser(fmt)]),
  );

  let rowsScanned = 0;
  let anyElimination = false;

  for (const value of nonEmpty) {
    if (remaining.size <= 1 || rowsScanned >= INFER_DATE_SCAN_CAP) break;

    const survivors: string[] = [];
    for (const [fmt, parse] of remaining) {
      if (parse(value)) survivors.push(fmt);
    }

    if (survivors.length > 0) {
      if (survivors.length < remaining.size) anyElimination = true;
      const survivorSet = new Set(survivors);
      for (const fmt of Array.from(remaining.keys())) {
        if (!survivorSet.has(fmt)) remaining.delete(fmt);
      }
    }

    rowsScanned++;
  }

  // Return the top-ranked survivor only if scanning produced useful signal
  // (at least one format was eliminated). If every row was noise, we have no
  // evidence for any candidate.
  return anyElimination && remaining.size >= 1
    ? remaining.keys().next().value
    : undefined;
}
