import { StandardizedField } from "@psilink/core";

import type { Standardization } from "@psilink/core";

/**
 * The full-CSV non-empty-rate aggregate: the silent-empty defense.
 *
 * `assessLinkageSatisfiability` guards the SHAPE of a field (does a column of the
 * right semantic type bind to it) but never its VALUE -- so a wrong `substring` or
 * `parse_date` that collapses a field to all-null passes the satisfiability gate
 * yet produces no keys, byte-indistinguishable from a real empty intersection. This
 * aggregate is the only value-level check: it runs each field's CURRENT pipeline
 * over the WHOLE parsed CSV (not the preview's row sample) and reports the fraction
 * of rows that yield at least one usable key, so an all-null collapse is visible to
 * the operator before launch.
 *
 * Pure and React-free -- the single tested boundary, so the 0%-collapse alarm, the
 * empty/empty-string/null classification, and the off-thread threshold are checked
 * here rather than through the UI. The off-main-thread plumbing that runs this on a
 * large file lives in {@link ./nonEmptyAggregateController}; the compute itself is
 * here so both the inline path and the worker call exactly this function.
 */

/**
 * Row count beyond which the aggregate is moved off the main thread (see
 * {@link ./nonEmptyAggregateController}). The per-row work is N_fields pipeline runs
 * per row, so a few thousand rows is where the synchronous sweep starts to drop a
 * frame; below it the inline cost is negligible and a worker's structured-clone
 * setup buys nothing. Settled empirically and coordinated with the preview sample
 * size ({@link PREVIEW_SAMPLE_SIZE}); tunable as the execution-target profile is
 * measured, the same way {@link MAX_CSV_FILE_BYTES} is.
 */
export const NON_EMPTY_WORKER_ROW_THRESHOLD = 5000;

/** Whether a CSV of `rowCount` rows crosses {@link NON_EMPTY_WORKER_ROW_THRESHOLD}
 * and so should have its aggregate computed off the main thread. */
export function shouldComputeOffThread(rowCount: number): boolean {
  return rowCount > NON_EMPTY_WORKER_ROW_THRESHOLD;
}

/**
 * The non-empty-rate result for one linkage field, over the whole CSV.
 *
 * `output` is the linkage-field name (the transformation `output`); it is
 * partner-controlled and must never be rendered raw -- the host shows the field's
 * safe semantic-type label instead. `input` is the operator's own column.
 */
export interface FieldNonEmptyRate {
  /** The linkage field (transformation `output`) this rate is for. */
  output: string;
  /** The operator's input column the field's pipeline reads. */
  input: string;
  /** Rows examined -- the full parsed row count. */
  total: number;
  /** Rows whose pipeline yields at least one non-empty key. */
  nonEmpty: number;
  /** {@link nonEmpty} / {@link total} in [0, 1]; 0 when {@link total} is 0. */
  rate: number;
  /**
   * True when the field's steps could not be compiled -- a step left mid-edit
   * (e.g. a `pad_left` with no length yet) throws at compile. The rate is then not
   * computable, so it MUST NOT be read as a 0% collapse: the host already gates
   * launch on a malformed pipeline, and surfacing a false silent-empty alarm for an
   * incomplete step would just be noise on top of that step's own inline error.
   */
  unavailable: boolean;
}

/** Whether a pipeline result contributes a usable key for the silent-empty count.
 * `null` (dropped) and an empty `Set` are not values. An empty STRING is also not
 * counted: it is a degenerate key shared by every row that produces it, so a field
 * that collapses every row to `""` carries no linkage signal and must trip the
 * alarm exactly as an all-null collapse does -- hence "non-empty" means at least one
 * value of non-zero length, not merely a non-null result. `StandardizedField.get`
 * has already reduced the result to its value set (`[]` for null/empty). */
function hasUsableKey(values: ReadonlyArray<string>): boolean {
  for (const value of values) if (value.length > 0) return true;
  return false;
}

/**
 * Compute the per-field non-empty rate over the WHOLE row set. For each
 * transformation, runs its pipeline over every row's input column and counts the
 * rows that yield at least one usable key ({@link hasUsableKey}).
 *
 * The sweep observes empties: a row whose input column is blank (or absent) is run
 * through the pipeline too, so a `coalesce` that substitutes a default for an empty
 * value RAISES the rate -- making demonstrable here the one transform the row-sample
 * preview cannot show (the sample skips empty values). A field whose transform drops
 * every row reports `nonEmpty: 0` and trips the silent-empty alarm.
 *
 * Each field gets its own {@link StandardizedField}, which compiles the steps once
 * (so a regex/`parse_date` pipeline is not recompiled per row); the field and its
 * per-row cache fall out of scope after its loop, so at most one field's cache is
 * resident at a time. A field whose steps do not compile is returned `unavailable`
 * rather than throwing, so one mid-edit step does not blank the whole aggregate.
 */
export function computeNonEmptyRates(
  rawRows: ReadonlyArray<Record<string, string>>,
  standardization: Standardization,
): Array<FieldNonEmptyRate> {
  const total = rawRows.length;
  return standardization.map((transformation) => {
    const base = {
      output: transformation.output,
      input: transformation.input,
      total,
    };
    try {
      const field = new StandardizedField(
        transformation.output,
        transformation.input,
        transformation.steps ?? [],
        rawRows,
      );
      let nonEmpty = 0;
      for (let index = 0; index < total; index++)
        if (hasUsableKey(field.get(index))) nonEmpty++;
      return {
        ...base,
        nonEmpty,
        rate: total > 0 ? nonEmpty / total : 0,
        unavailable: false,
      };
    } catch {
      return { ...base, nonEmpty: 0, rate: 0, unavailable: true };
    }
  });
}

/**
 * Whether a rate is the silent-empty alarm condition: a field that was computable
 * over a non-empty CSV yet produced a usable key for ZERO rows. An empty CSV
 * (`total === 0`) is not flagged -- there is no collapse to warn about, and the
 * emptiness is surfaced upstream -- and neither is an `unavailable` field (its rate
 * is unknown, not zero).
 */
export function isSilentEmpty(rate: FieldNonEmptyRate): boolean {
  return !rate.unavailable && rate.total > 0 && rate.nonEmpty === 0;
}
