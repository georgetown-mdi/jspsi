import { z } from "zod";

// --- Standardizing step ------------------------------------------------------

/**
 * A single step in a data standardization pipeline. Function names match the
 * cleaning and standardizing function library (snake_case); params keys are
 * camelCase after YAML parsing.
 */
export interface StandardizationStep {
  function: string;
  params?: Record<string, unknown>;
}

const StandardizationStepSchema: z.ZodType<StandardizationStep> = z.object({
  function: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
});

// --- Standardizing transformation --------------------------------------------

/**
 * A single data standardization transformation. Takes one input column from the
 * raw data, applies a sequence of steps, and makes the result available for use
 * as the linkage field with the given name.
 *
 * A step may produce `null` (excluding the record from any key that references
 * this field) or a `Set<string>` via `split_on` (each value produces a separate
 * PSI entry while retaining the original row identifier).
 */
export interface StandardizationTransformation {
  /**
   * Name of a linkage field in `linkage_terms.fields`. Must match exactly.
   */
  output: string;
  /** Column name in the raw input data. */
  input: string;
  /**
   * Steps applied in order. If omitted the raw input value is used unchanged.
   */
  steps?: StandardizationStep[];
}

const StandardizationTransformationSchema: z.ZodType<StandardizationTransformation> =
  z.object({
    output: z.string().min(1),
    input: z.string().min(1),
    steps: z.array(StandardizationStepSchema).optional(),
  });

// --- Standardization ---------------------------------------------------------

/**
 * The full set of data standardization transformations for one party's exchange
 * specification. Each entry produces one linkage field; a field may appear as
 * `output` at most once.
 */
export type Standardization = StandardizationTransformation[];

export const StandardizationSchema: z.ZodType<Standardization> = z
  .array(StandardizationTransformationSchema)
  .refine(
    (ts) => {
      const outputs = ts.map((t) => t.output);
      return outputs.length === new Set(outputs).size;
    },
    { message: "each linkage field may appear as output at most once" },
  );
