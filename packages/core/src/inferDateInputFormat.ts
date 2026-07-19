import type { LocalFile } from "papaparse";

import { CSV_LINE_BYTE_CEILING, loadCSVColumnSample } from "./file.js";
import { inferMetadata } from "./config/metadata.js";
import { INFER_DATE_SCAN_CAP, inferDateFormat } from "./utils/date.js";

/**
 * Resolve the date-of-birth column of a header, by running {@link inferMetadata}
 * over the column names and taking the first column it types `date_of_birth`, or
 * `undefined` when none is. The ONE definition of that selection, so every caller
 * that needs to locate the DOB column for date-format inference -- the CLI's init
 * path, the shared {@link inferDateInputFormatFromSource} below, and the web
 * server's streaming file profile -- picks the same column and cannot drift.
 */
export function inferDateOfBirthColumn(
  columns: Array<string>,
): string | undefined {
  return inferMetadata(columns).find((c) => c.type === "date_of_birth")?.name;
}

/** The header columns plus the inferred date-input format of a source's
 * date-of-birth column, as {@link inferDateInputFormatFromSource} resolves them. */
export interface InferredDateInputFormat {
  /** The CSV header field names. */
  columns: Array<string>;
  /** The date-of-birth column the format was inferred from, absent when the
   * header has none. */
  dobColumn?: string;
  /** The inferred `parse_date` input format for {@link dobColumn}, absent when
   * there is no DOB column or its values yield no format signal. */
  dateInputFormat?: string;
}

/**
 * Read a CSV source's header and infer its date-of-birth column's date-input
 * format, in one bounded streaming pass -- the composition every "derive a config
 * from a file" path shares. It locates the DOB column with
 * {@link inferDateOfBirthColumn}, samples that column's first
 * {@link INFER_DATE_SCAN_CAP} non-empty values through {@link loadCSVColumnSample}
 * (which stops as soon as the sample is full), and runs {@link inferDateFormat}
 * over the sample.
 *
 * The bound is exact, not heuristic: the sample caps at {@link INFER_DATE_SCAN_CAP}
 * non-empty values, the same cap {@link inferDateFormat} stops its own scan at, so
 * the format inferred from the bounded sample is IDENTICAL to one inferred from a
 * full-column read. That cap-exactness is what lets a caller infer the format
 * without materializing the file: the CLI's `init` and the web server's file
 * profile both rely on it, so a mounted CLI-scale file (millions of rows) profiles
 * at header-plus-one-chunk peak memory rather than scaling with the file.
 *
 * Resolves the header columns, the resolved DOB column (absent when the header has
 * none), and the inferred format (absent when there is no DOB column or the
 * sample yields no format signal); rejects on a read/parse error or a single-line
 * ceiling trip, the same contract as {@link loadCSVColumnSample}.
 */
export async function inferDateInputFormatFromSource(
  file: LocalFile,
  byteCeiling: number = CSV_LINE_BYTE_CEILING,
): Promise<InferredDateInputFormat> {
  const { columns, sampledColumn, sample } = await loadCSVColumnSample(
    file,
    inferDateOfBirthColumn,
    INFER_DATE_SCAN_CAP,
    byteCeiling,
  );
  const dateInputFormat =
    sampledColumn !== undefined ? inferDateFormat(sample) : undefined;
  return {
    columns,
    ...(sampledColumn !== undefined ? { dobColumn: sampledColumn } : {}),
    ...(dateInputFormat !== undefined ? { dateInputFormat } : {}),
  };
}
