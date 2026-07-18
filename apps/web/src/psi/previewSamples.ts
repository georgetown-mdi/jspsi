import { readRowColumn } from "@psilink/core";

import type { CSVRow } from "@psilink/core";

/**
 * Row-sample size for the before->after standardization preview: the first few
 * rows with a non-empty value for a field's input column. The preview inspects the
 * transform on representative values, so a small fixed window keeps it cheap and
 * legible; the whole-file coverage question (does the transform collapse the
 * field?) is answered separately and exhaustively by the non-empty-rate aggregate
 * ({@link ./nonEmptyAggregate}), not by widening this sample. Settled at 5.
 *
 * The server-side file profile ({@link ../jobs/workInputs}) emits per-column
 * samples of this same size and semantics, so the console authoring UI's preview
 * is fed values byte-identical to what an in-browser sample would draw.
 */
export const PREVIEW_SAMPLE_SIZE = 5;

/**
 * Pick up to `limit` non-empty raw values for `inputColumn`, in row order. A row
 * whose value is missing or blank after trimming carries no signal for the
 * preview, so it is skipped rather than shown as an empty before->after pair. The
 * raw (untrimmed) value is kept -- the preview shows the operator's own cell.
 *
 * Reads by own-property ({@link readRowColumn}) so a short row lacking the column
 * reads as absent even when the column is named an `Object.prototype` member; a
 * bare `row[inputColumn]` would surface the inherited function past the blank
 * check.
 */
export function sampleInputValues(
  rawRows: ReadonlyArray<CSVRow>,
  inputColumn: string,
  limit: number = PREVIEW_SAMPLE_SIZE,
): Array<string> {
  const values: Array<string> = [];
  for (const row of rawRows) {
    const raw = readRowColumn(row, inputColumn);
    if (raw !== undefined && raw.trim() !== "") {
      values.push(raw);
      if (values.length >= limit) break;
    }
  }
  return values;
}
