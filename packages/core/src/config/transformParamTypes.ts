/**
 * The declared type of one transform parameter: what a document must write for
 * the step function to read it.
 *
 * - `text` -- a string. Every literal a function injects into or compares
 *   against a value (a replacement, a fill character, a pattern, a default).
 * - `integer` -- a whole number, the shape a slice or a target width takes.
 * - `boolean` -- `true` or `false`.
 * - `text-list` -- an array whose every entry is text.
 */
export type TransformParamType = "text" | "integer" | "boolean" | "text-list";

/**
 * The declared type of every parameter a standardization function reads, keyed
 * by function name and then by the camelCase param name params arrive under
 * (`camelizeKeys` runs before validation, so a document's `include_original` is
 * `includeOriginal` here). A param outside this table is not read by the
 * function that declares it and keeps whatever the document wrote.
 *
 * Both schemas that admit steps check a declared param against this table --
 * `TransformStepSchema` in `linkageTermsSchema.ts` for a linkage key element's
 * transform and `StandardizationStepSchema` in `standardizationSchema.ts` for a
 * cleaning step -- so a wrong-typed param is refused where the document is
 * decoded, on the invitation path and the operator's own config path alike. The
 * factories in `standardization.ts` read their params through the same table
 * and refuse a wrong type at compile, which is what holds a caller that builds
 * steps without a decode.
 *
 * A function's entry lists the params the factory reads today; it is kept
 * beside `STANDARDIZING_FUNCTIONS` in behavior by the decode-refusal tests,
 * which drive every row of this table through a real document.
 */
const TRANSFORM_PARAM_TYPES: Record<
  string,
  Record<string, TransformParamType>
> = {
  substring: { start: "integer", length: "integer" },
  parse_date: { inputFormat: "text", outputFormat: "text" },
  pad_left: { length: "integer", char: "text" },
  phonetic: { algorithm: "text" },
  null_if: { value: "text", values: "text-list" },
  replace_regex: { pattern: "text", replacement: "text" },
  extract_regex: { pattern: "text" },
  filter_regex: { pattern: "text" },
  split_on: { delimiter: "text", includeOriginal: "boolean" },
  coalesce: { default: "text" },
};

const EXPECTED_TYPE_LABELS: Record<TransformParamType, string> = {
  text: "text",
  integer: "a whole number",
  boolean: "true or false",
  "text-list": "a list of text",
};

/**
 * How a declared value's type is named in a refusal. Its type only: a partner
 * authors these values, and the offending value itself is located by the issue
 * path rather than echoed into the message.
 *
 * A number is named against what was expected, since "not a number" would read
 * as a contradiction where the param takes one and the document wrote a
 * fraction. A number YAML writes as `.nan` or `.inf` is neither whole nor
 * fractional, so it is named for the thing that disqualifies it.
 */
function declaredTypeLabel(
  value: unknown,
  expected: TransformParamType,
): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  switch (typeof value) {
    case "string":
      return "text";
    case "number":
      if (!Number.isFinite(value)) return "a non-finite number";
      return expected === "integer" ? "a fractional number" : "a number";
    case "boolean":
      return "a boolean";
    case "object":
      return "an object";
    default:
      return "a value of another type";
  }
}

/**
 * The refusal message for a param declared as the wrong type. The one wording
 * for both decode paths and the factories, so an operator meets the same
 * sentence wherever the document is read.
 *
 * The text case names the remedy for the way the mistake is made: an unquoted
 * number or bare `null` in a YAML document, where the operator meant a literal
 * or meant to leave the param out.
 */
export function transformParamTypeMessage(
  functionName: string,
  param: string,
  expected: TransformParamType,
  declared: unknown,
): string {
  const head = `${functionName} ${param} must be ${EXPECTED_TYPE_LABELS[expected]}, not ${declaredTypeLabel(declared, expected)}`;
  return expected === "text"
    ? `${head}; quote the value, or omit the key to leave the param unset`
    : head;
}

/**
 * The refusal message for one entry of a list-valued param declared as the
 * wrong type. Separate from {@link transformParamTypeMessage} because the
 * remedy differs: the list itself is declared, and it is the entry that has to
 * become text.
 */
export function transformParamEntryTypeMessage(
  functionName: string,
  param: string,
  declared: unknown,
): string {
  return `${functionName} ${param} must hold only text, not ${declaredTypeLabel(declared, "text")}`;
}

/** One param a step declares as a type its function does not read. */
export interface TransformParamTypeRefusal {
  /** Path to the offending value, relative to the step. */
  path: Array<string | number>;
  /** The message {@link transformParamTypeMessage} builds for it. */
  message: string;
}

function matchesDeclaredType(
  value: unknown,
  expected: TransformParamType,
): boolean {
  switch (expected) {
    case "text":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "text-list":
      return Array.isArray(value);
  }
}

/**
 * Every param of `step` declared as a type its function does not read, each
 * with the path locating it. An empty array is a step whose declared params are
 * all readable as written.
 *
 * An absent param yields nothing: a step takes its documented default by
 * omitting the key, which is the one way to leave a param unset. A declared
 * `null` is a wrong type like any other, since the function has no null to
 * read.
 *
 * Own-property lookups throughout (`Object.hasOwn`, not a bare index): the
 * function name and the param names of a linkage-key element transform are
 * partner-authored free text, and a bare index answers `constructor` or
 * `toString` with an inherited `Object.prototype` member.
 */
export function transformParamTypeRefusals(step: {
  function: string;
  params?: Record<string, unknown>;
}): TransformParamTypeRefusal[] {
  if (!Object.hasOwn(TRANSFORM_PARAM_TYPES, step.function)) return [];
  const expectedTypes = TRANSFORM_PARAM_TYPES[step.function];
  const params = step.params;
  if (params === null || typeof params !== "object") return [];
  const refusals: TransformParamTypeRefusal[] = [];
  for (const [param, expected] of Object.entries(expectedTypes)) {
    if (!Object.hasOwn(params, param)) continue;
    const declared = params[param];
    if (declared === undefined) continue;
    if (!matchesDeclaredType(declared, expected)) {
      refusals.push({
        path: ["params", param],
        message: transformParamTypeMessage(
          step.function,
          param,
          expected,
          declared,
        ),
      });
      continue;
    }
    if (expected !== "text-list") continue;
    (declared as unknown[]).forEach((entry, index) => {
      if (typeof entry === "string") return;
      refusals.push({
        path: ["params", param, index],
        message: transformParamEntryTypeMessage(step.function, param, entry),
      });
    });
  }
  return refusals;
}
