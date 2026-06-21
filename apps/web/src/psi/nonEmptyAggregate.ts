import { StandardizedField } from "@psilink/core";

import type { Standardization } from "@psilink/core";

/**
 * Whole-CSV per-field value coverage: the silent-empty defense.
 *
 * `assessLinkageSatisfiability` guards the SHAPE of a field (does a column of the
 * right semantic type bind to it) but never its VALUE -- so a wrong `substring` or
 * `parse_date` that collapses a field to all-null can pass the satisfiability gate
 * yet produce no keys, byte-indistinguishable from a real empty intersection. This
 * module runs each field's CURRENT pipeline over the WHOLE parsed CSV (not the
 * preview's row sample) and reports the share of rows that produce a key, so the
 * operator sees an all-null collapse before launch.
 *
 * An empty string `""` is counted as PRODUCED, not as "no value": it is a real,
 * participating key element, distinct from a dropped `null` (and convertible to one
 * with `null_if`), so conflating the two would contradict the per-row preview and
 * misreport a deliberately-blank field as a coverage failure. A field whose keys all
 * collapse to one constant (including `""`) is NOT flagged: the linkage procedure
 * already drops any key value that is duplicated within a dataset before the PSI
 * round (`removeDuplicatesAndUndefineds` in core's `link.ts` keeps only values seen
 * exactly once -- a constant key thus contributes no matches and those records fall
 * through to later keys), so a low-cardinality or constant key is benign rather than
 * a disclosure hazard, and warning on it would cry wolf on legitimate repeated-key
 * designs.
 *
 * Pure and React-free -- the single tested boundary; the off-main-thread plumbing
 * lives in {@link ./nonEmptyAggregateController} and calls exactly
 * {@link computeFieldCoverage}.
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
 * and so should have its coverage computed off the main thread. */
export function shouldComputeOffThread(rowCount: number): boolean {
  return rowCount > NON_EMPTY_WORKER_ROW_THRESHOLD;
}

/**
 * The value-coverage result for one linkage field, over the whole CSV.
 *
 * `output` is the linkage-field name (the transformation `output`); it is
 * partner-controlled and must never be rendered raw -- the host shows the field's
 * safe semantic-type label instead. `input` is the operator's own column.
 */
export interface FieldValueCoverage {
  /** The linkage field (transformation `output`) this coverage is for. */
  output: string;
  /** The operator's input column the field's pipeline reads. */
  input: string;
  /** Rows examined -- the full parsed row count. */
  total: number;
  /**
   * Rows whose pipeline yields at least one key. `null` and an empty `Set` are not a
   * key; an empty STRING is -- it is a participating key element, distinct from a
   * dropped value -- so an all-`""` field is fully PRODUCED, not zero coverage.
   */
  produced: number;
  /** {@link produced} / {@link total} in [0, 1]; 0 when {@link total} is 0. */
  rate: number;
  /**
   * True when the field's steps could not be compiled -- a step left mid-edit (e.g.
   * a `pad_left` with no length yet) throws at compile. Coverage is then not
   * computable, so it MUST NOT be read as a 0% collapse: the host already gates
   * launch on a malformed pipeline, and a false alarm would be noise on top of that
   * step's own inline error.
   */
  unavailable: boolean;
}

/**
 * Compute per-field value coverage over the WHOLE row set. For each transformation,
 * runs its pipeline over every row's input column and counts the rows that yield a
 * key (a non-null, non-empty-Set value set; an empty STRING counts).
 *
 * The sweep observes empties: a row whose input column is blank (or absent) is run
 * through the pipeline too, so a `coalesce` that substitutes a default for an empty
 * value RAISES coverage -- making demonstrable here the one transform the row-sample
 * preview cannot show. A field whose transform drops every row reports `produced: 0`
 * ({@link isSilentEmpty}).
 *
 * Each field gets its own {@link StandardizedField}, which compiles the steps once
 * (so a regex/`parse_date` pipeline is not recompiled per row); the field and its
 * per-row cache fall out of scope after its loop. A field whose steps do not compile
 * is returned `unavailable` rather than throwing, so one mid-edit step does not blank
 * the whole aggregate.
 */
export function computeFieldCoverage(
  rawRows: ReadonlyArray<Record<string, string>>,
  standardization: Standardization,
): Array<FieldValueCoverage> {
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
      let produced = 0;
      for (let index = 0; index < total; index++)
        // `StandardizedField.get` has reduced the result to its value set: `[]` for a
        // dropped (null) or empty-Set value, otherwise the produced key(s).
        if (field.get(index).length > 0) produced++;
      return {
        ...base,
        produced,
        rate: total > 0 ? produced / total : 0,
        unavailable: false,
      };
    } catch {
      return { ...base, produced: 0, rate: 0, unavailable: true };
    }
  });
}

/**
 * Whether coverage is the silent-empty alarm condition: a field that was computable
 * over a non-empty CSV yet produced a key for ZERO rows -- an all-`null` collapse,
 * byte-indistinguishable from a real empty intersection. An empty CSV (`total === 0`)
 * is not flagged (there is no collapse to warn about), and neither is an
 * `unavailable` field (its coverage is unknown, not zero).
 */
export function isSilentEmpty(coverage: FieldValueCoverage): boolean {
  return !coverage.unavailable && coverage.total > 0 && coverage.produced === 0;
}
