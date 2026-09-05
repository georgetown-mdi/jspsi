import { StandardizedField } from "@psilink/core";

import { isStepValid } from "../standardizationAuthoring";

import type { CSVRow, Standardization } from "@psilink/core";

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
 * An empty string `""` counts as PRODUCED: a real, participating key element,
 * distinct from a dropped `null` (convertible to one with `null_if`), matching
 * the per-row preview and not misreporting a field that is blank by design as
 * a coverage failure. A field whose keys all collapse to one constant
 * (including `""`) is NOT flagged: `removeDuplicatesAndUndefineds` (core's
 * `link.ts`) already drops any key value duplicated within a dataset before
 * the PSI round, so a low-cardinality or constant key is benign rather than a
 * disclosure hazard.
 *
 * Pure and React-free -- the single tested boundary; the off-main-thread plumbing
 * lives in {@link ./nonEmptyAggregateController} and calls exactly
 * {@link computeFieldCoverage}.
 */

/**
 * Row count beyond which the aggregate is moved off the main thread (see
 * {@link ./nonEmptyAggregateController}). The per-row work is N_fields pipeline
 * runs per row, so a few thousand rows is where the synchronous sweep starts
 * to drop a frame; below it a worker's structured-clone setup buys nothing.
 * Settled empirically, coordinated with {@link PREVIEW_SAMPLE_SIZE}; tunable
 * the same way {@link MAX_CSV_FILE_BYTES} is.
 */
export const NON_EMPTY_WORKER_ROW_THRESHOLD = 5000;

/**
 * Total cell-text budget (characters) above which the sweep moves off the main
 * thread regardless of row count. Row count alone under-estimates the work
 * (cost is rows x fields x per-cell), so a file with a few very large cells,
 * or wide rows across many fields' columns, can block the main thread well
 * below {@link NON_EMPTY_WORKER_ROW_THRESHOLD}. Settled empirically alongside
 * the row threshold, tunable the same way.
 */
export const NON_EMPTY_WORKER_CHAR_THRESHOLD = 2_000_000;

/**
 * Whether a CSV should have its coverage swept off the main thread: above the
 * row threshold, or once its total cell text crosses
 * {@link NON_EMPTY_WORKER_CHAR_THRESHOLD} (the scan short-circuits once the
 * budget is passed, so it stays cheap even for a huge file). Field count is
 * not known here, so a degenerate terms set with very many linkage fields
 * all bound to one narrow column could still sweep inline -- an out-of-shape,
 * partner-bounded config.
 */
export function shouldComputeOffThread(
  rawRows: ReadonlyArray<CSVRow>,
): boolean {
  if (rawRows.length > NON_EMPTY_WORKER_ROW_THRESHOLD) return true;
  let chars = 0;
  for (const row of rawRows)
    // A CSVRow's values are `string | undefined` (a short row omits columns), so
    // an absent cell contributes no characters.
    for (const value of Object.values(row)) {
      chars += value?.length ?? 0;
      if (chars > NON_EMPTY_WORKER_CHAR_THRESHOLD) return true;
    }
  return false;
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
   * Rows whose pipeline yields at least one matchable key. `null` and an empty
   * `Set` are not a key; an empty STRING is -- a participating key element
   * distinct from a dropped value, so an all-`""` field is fully PRODUCED, not
   * zero coverage. A fan-out `Set` of two or more values counts ONCE, as the
   * single row it is (bounding the tally by {@link total}): its values enter
   * the key's candidate set the single-pass strategy matches on. A fan-out
   * under any other strategy is refused where the fault is fixable -- core's
   * `assertFanOutImplemented`, at authoring, at the mint, and at prepare --
   * so this readout does not pre-warn for it.
   */
  produced: number;
  /** {@link produced} / {@link total} in [0, 1]; 0 when {@link total} is 0. */
  rate: number;
  /**
   * True when the field's coverage is not computed. Three cases reach it: a
   * step left mid-edit (e.g. a `pad_left` with no length yet); an in-dialect
   * but over-length regex source, rejected by the length cap (both caught by
   * {@link isStepValid} before the pipeline compiles); and a pipeline that
   * compiles yet throws on a specific row's value, degrading the field rather
   * than aborting the whole sweep (see {@link FieldCoverageAccumulator.add}).
   * MUST NOT be read as a 0% collapse: the host already gates launch on a
   * malformed pipeline, and a false alarm would only add noise.
   */
  unavailable: boolean;
}

/**
 * A per-field coverage tally fed one row at a time, so the sweep can run over
 * a STREAM that retains no rows: the whole-file batch entry point
 * ({@link computeFieldCoverage}) and the server-side streaming pass over a
 * mounted CLI-scale file share this one accumulator, so the two drivers
 * count identically (equivalence pinned by test).
 *
 * Each field's {@link StandardizedField} pipeline is compiled ONCE in
 * {@link createFieldCoverageAccumulator}, so a regex/`parse_date` pipeline is
 * not recompiled per row. A field whose steps are not all valid
 * ({@link isStepValid}), or whose compile throws, is marked `unavailable`
 * without compiling on the sweep path, so one mid-edit step does not blank
 * the whole aggregate and an over-length regex never reaches the compiler.
 */
interface FieldCoverageAccumulator {
  /**
   * Fold one row into every field's tally: for each available field, count
   * the row as produced iff its pipeline yields at least one matchable key
   * (an empty STRING counts, a multi-value fan-out Set counts once; a
   * dropped null/empty-Set does not). Increments the shared row total. A
   * field whose pipeline THROWS on a row degrades to `unavailable` and stops
   * being evaluated, so one bad row never aborts the sweep (nor,
   * server-side, 400s the whole request).
   */
  add: (row: CSVRow) => void;
  /** The per-field coverage after every fed row, in the standardization's order. */
  result: () => Array<FieldValueCoverage>;
}

/**
 * Build a {@link FieldCoverageAccumulator} for `standardization`, compiling each
 * transformation's pipeline once. See {@link FieldCoverageAccumulator} for the
 * one-computation rationale and {@link computeFieldCoverage} for the sweep
 * semantics (empties observed, empty-string counted, fan-out counted once).
 */
export function createFieldCoverageAccumulator(
  standardization: Standardization,
): FieldCoverageAccumulator {
  // Each field compiles once here (over an empty backing array -- rows come through
  // add(), never by index) and its produced counter is folded per row. A field that
  // is not all-valid, or whose compile throws, holds no StandardizedField and is
  // reported unavailable; the compile is wrapped so a step that slips past the
  // validity gate yet throws is caught rather than blanking the aggregate.
  const fields = standardization.map((transformation) => {
    const steps = transformation.steps ?? [];
    const base = { output: transformation.output, input: transformation.input };
    let field: StandardizedField | null = null;
    if (steps.every(isStepValid)) {
      try {
        field = new StandardizedField(
          transformation.output,
          transformation.input,
          steps,
          [],
        );
      } catch {
        field = null;
      }
    }
    return { ...base, field, produced: 0 };
  });

  let total = 0;
  return {
    add(row: CSVRow): void {
      total++;
      for (const entry of fields) {
        if (entry.field === null) continue;
        // A step that passes the validity gate and compiles can still throw on a
        // specific row's value. Degrade that field to unavailable (and stop
        // evaluating it) rather than aborting the whole sweep -- server-side,
        // one bad row would otherwise 400 the entire coverage request. A
        // matchable key iff the value set is non-empty, a fan-out counting
        // once -- see FieldValueCoverage.produced.
        try {
          if (entry.field.evaluateRow(row).length > 0) entry.produced++;
        } catch {
          entry.field = null;
          entry.produced = 0;
        }
      }
    },
    result(): Array<FieldValueCoverage> {
      return fields.map((entry) => ({
        output: entry.output,
        input: entry.input,
        total,
        produced: entry.produced,
        rate: total > 0 ? entry.produced / total : 0,
        unavailable: entry.field === null,
      }));
    },
  };
}

/**
 * Compute per-field value coverage over the WHOLE row set: for each
 * transformation, runs its pipeline over every row's input column and counts
 * the rows that yield at least one matchable key (an empty STRING counts, a
 * fan-out counts once; a dropped null/empty-Set does not).
 *
 * A per-field proxy: measures the field's own standardization pipeline, not
 * a linkage key's element transforms or its cross-field (composite-key)
 * collapse.
 *
 * The sweep observes empties: a blank or absent input column still runs
 * through the pipeline, so a `coalesce` that substitutes a default RAISES
 * coverage -- the one transform the row-sample preview cannot show. A field
 * whose transform drops every row reports `produced: 0`
 * ({@link isSilentEmpty}).
 *
 * The whole-file batch driver over {@link createFieldCoverageAccumulator}:
 * feeds every row and reads the result, so it and the server's streaming
 * pass are one computation.
 */
export function computeFieldCoverage(
  rawRows: ReadonlyArray<CSVRow>,
  standardization: Standardization,
): Array<FieldValueCoverage> {
  const accumulator = createFieldCoverageAccumulator(standardization);
  for (const row of rawRows) accumulator.add(row);
  return accumulator.result();
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
