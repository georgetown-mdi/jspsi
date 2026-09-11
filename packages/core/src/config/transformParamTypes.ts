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
 * the `transformStepSchema(options)` factory in `linkageTermsSchema.ts` for a
 * linkage key element's transform and `StandardizationStepSchema` in
 * `standardizationSchema.ts` for a cleaning step -- so a wrong-typed param is
 * refused where the document is decoded, on the invitation path and the
 * operator's own config path alike. The factories in `standardization.ts`
 * refuse a wrong type at compile as well, which is what holds a caller that
 * builds steps without a decode. Each reads its params through a typed
 * accessor that checks its own reading against this table when the step is
 * compiled, so an accessor and a row cannot part company without the compile
 * saying so.
 *
 * A function's entry lists the params the factory reads today. The
 * decode-refusal tests drive every row through a real document, reading the row
 * list from {@link transformParamTypeRows} rather than from a copy of it.
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

/**
 * The type `functionName` reads `param` as, or undefined where the function
 * reads no such param -- which includes every function this build does not
 * implement.
 *
 * Own-property lookups (`Object.hasOwn`, not a bare index): a function name and
 * a param name of a linkage-key element transform are partner-authored free
 * text, and a bare index answers `constructor` or `toString` with an inherited
 * `Object.prototype` member.
 */
export function declaredTransformParamType(
  functionName: string,
  param: string,
): TransformParamType | undefined {
  if (!Object.hasOwn(TRANSFORM_PARAM_TYPES, functionName)) return undefined;
  const expectedTypes = TRANSFORM_PARAM_TYPES[functionName];
  return Object.hasOwn(expectedTypes, param) ? expectedTypes[param] : undefined;
}

/** One row of the declared-type table. */
export interface TransformParamTypeRow {
  /** The standardizing function that reads the param. */
  function: string;
  /** The camelCase param name, as it arrives after `camelizeKeys`. */
  param: string;
  /** The type the function reads it as. */
  type: TransformParamType;
}

/**
 * Every row of the declared-type table, so a caller drives the whole of it
 * rather than a hand-written copy of it that drifts without saying so.
 *
 * @internal read by the decode-refusal tests, which drive each row through a
 * real document.
 */
export function transformParamTypeRows(): TransformParamTypeRow[] {
  return Object.entries(TRANSFORM_PARAM_TYPES).flatMap(([name, params]) =>
    Object.entries(params).map(([param, type]) => ({
      function: name,
      param,
      type,
    })),
  );
}

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
 * How a refusal is read, which decides whether it names a remedy.
 *
 * A remedy for a text param -- quote the value, or leave the key out -- tells
 * the party who WROTE the document what to change. That is the operator
 * reading a refusal of their own configuration. It is not the acceptor reading
 * a refusal of a partner's invitation: they have no document to edit, so the
 * instruction would send them after something they cannot do. Their refusal
 * states the type and stops.
 */
export interface TransformParamRefusalOptions {
  /** Whether the party who reads this refusal can edit the refused document. */
  readerCanEditTheDocument: boolean;
}

const REFUSAL_TO_A_READER: TransformParamRefusalOptions = {
  readerCanEditTheDocument: false,
};

/**
 * The refusal message for a param declared as the wrong type. Its type
 * statement is one wording for both decode paths and the factories, so the
 * same sentence names the fault wherever the document is read; only the remedy
 * below turns on who reads it.
 *
 * The text case names the remedy for the way the mistake is made -- an
 * unquoted number or bare `null` in a YAML document, where the operator meant
 * a literal or meant to leave the param out -- for the reader who can act on
 * it (see {@link TransformParamRefusalOptions}). A caller that says nothing
 * gets the type statement alone.
 */
export function transformParamTypeMessage(
  functionName: string,
  param: string,
  expected: TransformParamType,
  declared: unknown,
  options: TransformParamRefusalOptions = REFUSAL_TO_A_READER,
): string {
  const head = `${functionName} ${param} must be ${EXPECTED_TYPE_LABELS[expected]}, not ${declaredTypeLabel(declared, expected)}`;
  return expected === "text" && options.readerCanEditTheDocument
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
 * At most ONE refusal per param, so the count of issues a step raises is
 * bounded by the params its function reads rather than by the width of a value
 * it declares. A list-valued param names the FIRST entry that is not text and
 * stops; the rest are read once that one is corrected. The bound is what keeps
 * a safe parse safe: Zod accumulates one issue per `addIssue` and spreads the
 * array up through each nested frame, so an issue per entry of a long list
 * costs heap in proportion to the list and, deep enough in, overflows the call
 * stack -- a throw out of a `safeParse` that contracts to return failure
 * instead (docs/spec/CHANNEL_SECURITY.md, "Application-layer parsed-input
 * bounds").
 *
 * `options` reaches the message builder unchanged, so a caller states there
 * whether the party reading these refusals wrote the document
 * ({@link TransformParamRefusalOptions}).
 *
 * Own-property lookups throughout (`Object.hasOwn`, not a bare index): the
 * function name and the param names of a linkage-key element transform are
 * partner-authored free text, and a bare index answers `constructor` or
 * `toString` with an inherited `Object.prototype` member.
 */
export function transformParamTypeRefusals(
  step: {
    function: string;
    params?: Record<string, unknown>;
  },
  options: TransformParamRefusalOptions = REFUSAL_TO_A_READER,
): TransformParamTypeRefusal[] {
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
          options,
        ),
      });
      continue;
    }
    if (expected !== "text-list") continue;
    const entries = declared as unknown[];
    const offending = entries.findIndex((entry) => typeof entry !== "string");
    if (offending === -1) continue;
    refusals.push({
      path: ["params", param, offending],
      message: transformParamEntryTypeMessage(
        step.function,
        param,
        entries[offending],
      ),
    });
  }
  return refusals;
}
