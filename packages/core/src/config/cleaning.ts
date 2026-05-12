import { z } from "zod";

// ─── Cleaning step ────────────────────────────────────────────────────────────

/**
 * A single step in a data cleaning pipeline. Function names match the cleaning
 * function library (snake_case); params keys are camelCase after YAML parsing.
 */
export interface CleaningStep {
  /** Name of the function to apply. */
  function: string;
  /** Function-specific parameters. */
  params?: Record<string, unknown>;
}

const CleaningStepSchema: z.ZodType<CleaningStep> = z.object({
  function: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
});

// ─── Cleaning transformation ──────────────────────────────────────────────────

/**
 * A single data cleaning transformation. Reads one input column from the raw
 * data, applies a sequence of steps, and writes the result under a linkage
 * field name.
 *
 * A step may produce `null` (excluding the record from any key that references
 * this field) or a `string[]` via `split_on` (each value produces a separate
 * PSI entry while retaining the original row identifier).
 */
export interface CleaningTransformation {
  /**
   * Name of a linkage field in `linkage_terms.fields`. Must match exactly.
   */
  output: string;
  /** Column name in the raw input data. */
  input: string;
  /**
   * Steps applied in order. If omitted the raw input value is used unchanged.
   */
  steps?: CleaningStep[];
}

const CleaningTransformationSchema: z.ZodType<CleaningTransformation> =
  z.object({
    output: z.string().min(1),
    input: z.string().min(1),
    steps: z.array(CleaningStepSchema).optional(),
  });

// ─── Cleaning ─────────────────────────────────────────────────────────────────

/**
 * The full set of data cleaning transformations for one party's exchange
 * specification. Each entry produces one linkage field; a field may appear as
 * `output` at most once.
 */
export type Cleaning = CleaningTransformation[];

export const CleaningSchema: z.ZodType<Cleaning> = z
  .array(CleaningTransformationSchema)
  .refine(
    (ts) => {
      const outputs = ts.map((t) => t.output);
      return outputs.length === new Set(outputs).size;
    },
    { message: "each linkage field may appear as output at most once" },
  );
