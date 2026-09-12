import { holdsPrivateKeyMaterial } from "../utils/sanitizeErrorForDisplay.js";

/**
 * Upper bound on the number of transform parameters one step may declare, and
 * the number the consent summary shows per step
 * (`packages/core/src/consent/invitationSummary.ts`). One constant for both,
 * because the summary states a step's parameters as a list and the count past
 * the list as a number: a step declaring more than it shows would state a
 * count where the run applies values.
 *
 * A real function takes a handful, so the bound is far above any authored
 * step and far below `MAX_PARAMS_ENTRIES`, the count a partner's record is
 * stopped at before its keys are read (`linkageTermsSchema.ts`).
 */
export const MAX_DISPLAYED_PARAMS = 16;

/**
 * The parameters a step declares, in declaration order: the entries
 * {@link transformParamDisplayRefusals} counts against
 * {@link MAX_DISPLAYED_PARAMS} and the entries the consent summary orders,
 * shows, and states the remainder of as a count (`orderedParamEntries`,
 * `packages/core/src/consent/invitationSummary.ts`). One function for both,
 * so the count refused and the count shown are one expression rather than two
 * that have to be read against each other.
 *
 * An own key whose value is `undefined` is a declared parameter here, because
 * the summary paints a row for it: a record schema keeps such a key, which an
 * in-process caller can pass (no JSON or YAML document holds `undefined`).
 * A `params` that is not a plain object declares none -- an array's indices
 * name no parameter, and neither schema admits one.
 */
export function declaredParamEntries(
  params: unknown,
): Array<[string, unknown]> {
  if (params === null || typeof params !== "object" || Array.isArray(params))
    return [];
  return Object.entries(params);
}

/**
 * Render a transform parameter value for display. Primitives become their
 * plain string form; anything structured is JSON-encoded (best effort). The
 * result is sanitized and length-bounded by the caller, so it need not be
 * safe on its own.
 */
export function describeTransformParamValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (value === null) return "null";
  if (value === undefined) return "";
  try {
    // A value past the checks above is an object/array from a JSON-parsed
    // params record, so JSON.stringify yields a string (and throws only on the
    // unreachable circular/bigint cases, caught below).
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

/**
 * The `key: value` line the consent summary renders one declared parameter
 * as, before the display sanitizer reads it. Shared with the summary so a
 * refusal below judges the same characters the sanitizer would.
 */
export function describedTransformParamEntry(
  param: string,
  value: unknown,
): string {
  return `${param}: ${describeTransformParamValue(value)}`;
}

/**
 * Refusal message for a step declaring both of `null_if`'s two parameters.
 * The run reads `values` and ignores `value` (`nullIfFactory`,
 * `packages/core/src/standardization.ts`), while a summary states both.
 */
export const NULL_IF_BOTH_VALUE_PARAMS_MESSAGE =
  "null_if must declare value or values, not both";

/**
 * Refusal message for a parameter whose displayed line the private-key
 * redaction would replace. A fixed literal echoing neither the parameter's
 * name nor its value, which the issue path locates instead.
 */
export const PRIVATE_KEY_PARAM_MESSAGE =
  "a transform param must not contain private key material";

/** Refusal message for a step declaring more parameters than are displayed. */
export const TRANSFORM_PARAM_COUNT_MESSAGE = `a transform step must not declare more than ${MAX_DISPLAYED_PARAMS} params`;

/** One parameter shape a consent summary cannot state as the run applies it. */
export interface TransformParamDisplayRefusal {
  /** Path to the offending value, relative to the step. */
  path: Array<string | number>;
  /** The fixed message stating which shape was declared. */
  message: string;
}

/**
 * Every parameter shape of `step` a consent summary would state as something
 * other than what the run applies. An empty array is a step whose declared
 * parameters the summary states as they run.
 *
 * Three shapes, each refused where the document is decoded rather than shown
 * as it stands: `null_if` declaring both `value` and `values`, of which the
 * run applies only `values`; a parameter whose displayed line the private-key
 * redaction would replace with its marker; and a step declaring more
 * parameters than the summary shows, whose remainder it states as a count.
 *
 * An over-count step yields that refusal alone, so the issues one step raises
 * stay bounded by {@link MAX_DISPLAYED_PARAMS} however many entries the
 * record holds -- the bound the safe-parse contract rests on
 * (docs/spec/CHANNEL_SECURITY.md, "Application-layer parsed-input bounds").
 *
 * Own-property lookups throughout: a step's function name and parameter names
 * are partner-authored free text, and a name reaching only `Object.prototype`
 * (`constructor`, `toString`) names no declared parameter.
 */
export function transformParamDisplayRefusals(step: {
  function: string;
  params?: Record<string, unknown>;
}): TransformParamDisplayRefusal[] {
  const params = step.params;
  // The shape guard {@link declaredParamEntries} makes, repeated to narrow
  // `params` for the own-property lookups below, which throw on a null.
  if (params === null || typeof params !== "object" || Array.isArray(params))
    return [];
  const entries = declaredParamEntries(params);
  if (entries.length > MAX_DISPLAYED_PARAMS)
    return [{ path: ["params"], message: TRANSFORM_PARAM_COUNT_MESSAGE }];
  const refusals: TransformParamDisplayRefusal[] = [];
  // Declared as `nullIfFactory` reads it: `textParam` passes over an undefined
  // value, so neither the refusal nor the run counts one.
  const declares = (param: string): boolean =>
    Object.hasOwn(params, param) && params[param] !== undefined;
  if (step.function === "null_if" && declares("value") && declares("values"))
    refusals.push({
      path: ["params"],
      message: NULL_IF_BOTH_VALUE_PARAMS_MESSAGE,
    });
  for (const [param, value] of entries)
    if (holdsPrivateKeyMaterial(describedTransformParamEntry(param, value)))
      refusals.push({
        path: ["params", param],
        message: PRIVATE_KEY_PARAM_MESSAGE,
      });
  return refusals;
}
