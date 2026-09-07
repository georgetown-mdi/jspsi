import { z } from "zod";

import { MAX_NAME_LENGTH } from "./linkageTermsSchema.js";

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
   * Name of a linkage field in `linkage_terms.fields`. Must match exactly, and
   * is bounded to {@link MAX_NAME_LENGTH} as that field's own name is.
   */
  output: string;
  /**
   * Column name in the raw input data, bounded to {@link MAX_NAME_LENGTH} as a
   * declared column name is.
   */
  input: string;
  /**
   * Steps applied in order. If omitted the raw input value is used unchanged.
   */
  steps?: StandardizationStep[];
}

const StandardizationTransformationSchema: z.ZodType<StandardizationTransformation> =
  z.object({
    // Both name a thing rather than hold data -- a linkage field this party
    // declares and a column of this party's own input -- so each takes the
    // ceiling every other name in a configuration has. Neither is sent to the
    // partner, which is why the bound stands alone here and the terms names'
    // character rule does not (docs/spec/CHANNEL_SECURITY.md).
    output: z.string().min(1).max(MAX_NAME_LENGTH),
    input: z.string().min(1).max(MAX_NAME_LENGTH),
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
