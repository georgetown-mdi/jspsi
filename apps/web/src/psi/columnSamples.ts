import { readRowColumn } from "@psilink/core";

import type { CSVRow } from "@psilink/core";

/**
 * The before->after preview's value sampling. The preview samples a few non-empty
 * values of a field's input column so the operator can inspect a transform on real
 * data; the whole-file coverage question (does the transform collapse the field?)
 * is answered separately and exhaustively by the non-empty-rate aggregate
 * ({@link ./nonEmptyAggregate}), not by widening this sample.
 *
 * The sample is computed from the rows on the hosted build and read from the
 * server-side file profile on the console ({@link ../jobs/workInputs}, which emits
 * per-column samples of this same size and semantics) -- so the preview receives a
 * resolved per-column map, not rows, and the console's values are byte-identical
 * to what an in-browser sample would draw.
 */

/**
 * Row-sample size for the before->after preview: the first few rows with a
 * non-empty value for the field's input column. A small fixed window keeps the
 * preview cheap and legible. Settled at 5, coordinated with the non-empty
 * aggregate and its row threshold.
 */
export const PREVIEW_SAMPLE_SIZE = 5;

/** The per-column preview samples, keyed by input-column name: the first
 * {@link PREVIEW_SAMPLE_SIZE} non-empty values of each column, in row order. */
export type ColumnSamples = ReadonlyMap<string, ReadonlyArray<string>>;

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

/** The per-column {@link sampleInputValues} for every named column -- the hosted
 * build's computation of the {@link ColumnSamples} the console reads from its
 * profile. Keyed by column so a field rebound to another column finds its sample
 * by lookup. */
export function columnSamplesFromRows(
  rawRows: ReadonlyArray<CSVRow>,
  columns: ReadonlyArray<string>,
  limit: number = PREVIEW_SAMPLE_SIZE,
): ColumnSamples {
  return new Map(
    columns.map((column) => [
      column,
      sampleInputValues(rawRows, column, limit),
    ]),
  );
}
