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
 *
 * An empty column name is dropped rather than handed to {@link inferMetadata}:
 * this selection runs inside the read -- `loadCSVColumnSample`'s chunk handler
 * and the web server's stream consumer -- which holds no sanitized-position
 * list, so its empty-name refusal would state the wrong cause for a name the
 * bidi strip emptied, ahead of the caller's own warning. The one refusal stays
 * with that caller, which passes the positions
 * (`CSVParseMeta.bidiStrippedColumns`) and names the removal. A type is resolved
 * per name, so dropping one changes no other column's type.
 */
export function inferDateOfBirthColumn(
  columns: Array<string>,
): string | undefined {
  const named = columns.filter((name) => name.length > 0);
  // No name is empty past that filter, so no refusal can fire and there is no
  // cause to state; the read's caller raises the one that names the removal.
  return inferMetadata(named, []).find((c) => c.type === "date_of_birth")?.name;
}

/** The header columns plus the inferred date-input format of a source's
 * date-of-birth column, as {@link inferDateInputFormatFromSource} resolves them. */
interface InferredDateInputFormat {
  /** The CSV header field names. */
  columns: Array<string>;
  /** The 1-based positions of the names the read removed bidi control characters
   * from (`CSVParseMeta.bidiStrippedColumns`), so a caller authoring a config
   * from this read tells its operator what changed. */
  bidiStrippedColumns: Array<number>;
  /** The date-of-birth column the format was inferred from, absent when the
   * header has none. */
  dobColumn?: string;
  /** The inferred `parse_date` input format for {@link dobColumn}, absent when
   * there is no DOB column or its values yield no format signal. */
  dateInputFormat?: string;
}

/**
 * Read a CSV source's header and infer its date-of-birth column's
 * `parse_date` input format, in one bounded streaming pass -- the
 * composition every "derive a config from a file" path shares.
 *
 * The bound is exact, not heuristic: the sample cap matches
 * {@link inferDateFormat}'s own scan cap, so the inferred format equals one
 * from a full-column read. The CLI's `init` and the web server's file
 * profile rely on that equivalence to profile a CLI-scale file (millions of
 * rows) at bounded, not file-sized, peak memory.
 *
 * Resolves the header columns, the DOB column (absent without one), and the
 * format (absent without a DOB column or a signal in its sample); rejects,
 * like {@link loadCSVColumnSample}, on a read/parse error or line-ceiling
 * trip.
 */
export async function inferDateInputFormatFromSource(
  file: LocalFile,
  byteCeiling: number = CSV_LINE_BYTE_CEILING,
): Promise<InferredDateInputFormat> {
  const { columns, bidiStrippedColumns, sampledColumn, sample } =
    await loadCSVColumnSample(
      file,
      inferDateOfBirthColumn,
      INFER_DATE_SCAN_CAP,
      byteCeiling,
    );
  const dateInputFormat =
    sampledColumn !== undefined ? inferDateFormat(sample) : undefined;
  return {
    columns,
    bidiStrippedColumns,
    ...(sampledColumn !== undefined ? { dobColumn: sampledColumn } : {}),
    ...(dateInputFormat !== undefined ? { dateInputFormat } : {}),
  };
}
