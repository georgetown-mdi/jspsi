/**
 * The pure, React-free model behind the web standardization-authoring workbench:
 * the intent-grouped function menu, the descriptor-driven typed param-field model,
 * and per-param validation. The single tested boundary -- the function grouping and
 * the Zod-shape introspection are exercised here rather than through the UI. The
 * value-level constraint check the workbench renders as badges lives in core's
 * `checkValueConstraints` (shared with the CLI), not here.
 */

import {
  STANDARDIZATION_FUNCTION_DESCRIPTORS,
  sanitizeForDisplay,
} from "@psilink/core";

import type {
  Standardization,
  StandardizationFunctionDescriptor,
  StandardizationStep,
} from "@psilink/core";

import type { ZodType } from "zod";

/**
 * The operator's per-field authored step list, paired with the input column it was
 * authored against. The column is what makes a re-bind detectable: an override is
 * applied only while the field still binds to {@link FieldStepOverride.input} (see
 * {@link applyStepOverrides}).
 */
export interface FieldStepOverride {
  /** The input column the steps were authored against. */
  input: string;
  /** The authored pipeline steps. */
  steps: Array<StandardizationStep>;
}

/**
 * Layer per-field authored step overrides onto a derived standardization, keyed by
 * the field name (`output`) but gated on the input column: an override applies only
 * while the field is still bound to the column it was authored against. A field
 * re-bound to a DIFFERENT column drops its now-stale override and falls back to the
 * re-derived recommended pipeline, so steps authored to clean one column never
 * silently drive a different column after a remap; a field whose binding is
 * unchanged keeps its override across an unrelated metadata edit. Pure over its
 * inputs; the host re-derives `base` from the current metadata each render.
 */
export function applyStepOverrides(
  base: Standardization,
  overrides: ReadonlyMap<string, FieldStepOverride>,
): Standardization {
  return base.map((transformation) => {
    const override = overrides.get(transformation.output);
    return override !== undefined && override.input === transformation.input
      ? { ...transformation, steps: override.steps }
      : transformation;
  });
}

/**
 * Layer per-field input-column overrides onto a derived standardization: rebind a
 * field (`output`) to an operator-chosen input column. The derived steps are kept
 * unchanged -- the host only offers columns of the field's own semantic type, so the
 * recommended cleaning still applies. This is what lets two fields of one semantic
 * type bind to DISTINCT columns: the default type fallback binds every same-typed
 * field to the FIRST column of the type (see {@link resolveFieldColumns}), so an
 * explicit per-field input is the only way to give the second its own column. Pure;
 * the host re-derives `base` from the current metadata each render and passes only
 * overrides whose column is still a valid same-typed binding, so a remap that
 * invalidates an override drops it rather than rebinding a wrong-typed column.
 */
export function applyInputOverrides(
  base: Standardization,
  overrides: ReadonlyMap<string, string>,
): Standardization {
  return base.map((transformation) => {
    const column = overrides.get(transformation.output);
    return column !== undefined && column !== transformation.input
      ? { ...transformation, input: column }
      : transformation;
  });
}

/**
 * The descriptor for a function name, or `undefined` for a name core does not
 * recognize. The descriptor table is a total `Record`, so a bare index is typed
 * as always-present; the `Object.hasOwn` guard models the genuinely-absent case
 * (an own-property check, so a name reachable only on the prototype chain is never
 * read as a descriptor), which the editor and the function-display helper depend
 * on for an unrecognized step.
 */
export function descriptorFor(
  name: string,
): StandardizationFunctionDescriptor | undefined {
  return Object.hasOwn(STANDARDIZATION_FUNCTION_DESCRIPTORS, name)
    ? STANDARDIZATION_FUNCTION_DESCRIPTORS[name]
    : undefined;
}

// --- Function intent grouping ------------------------------------------------

/**
 * One intent group in the "add a step" menu: a plain-language heading and the
 * standardization functions filed under it, in display order. The function names
 * are core's snake_case keys into {@link STANDARDIZATION_FUNCTION_DESCRIPTORS}; the
 * editor renders each with the descriptor's own `label` and `blurb`, never the raw
 * name.
 */
export interface StandardizationFunctionGroup {
  /** Plain-language heading for the group (e.g. "Letter case"). */
  label: string;
  /** Core function names in this group, in display order. */
  functionNames: Array<string>;
}

/**
 * The standard-tier standardization functions, grouped by authoring intent for the
 * add-step menu. Covers exactly the functions whose descriptor `tier` is
 * `"standard"` (`coalesce` is one of them; the four `tier: "regex"` raw-pattern
 * functions are the only ones excluded); a parity test
 * ({@link authorableFunctionNames}) pins this set against the descriptor table in
 * both directions, so a standard-tier function added to core cannot ship without a
 * group here, and a regex-tier function cannot leak into the menu.
 *
 * The grouping is web-local intent metadata the descriptor table does not carry;
 * the per-function label and one-line blurb come from the descriptor.
 */
export const STANDARDIZATION_FUNCTION_GROUPS: Array<StandardizationFunctionGroup> =
  [
    { label: "Letter case", functionNames: ["to_upper_case", "to_lower_case"] },
    {
      label: "Whitespace",
      functionNames: ["trim_whitespace", "squash_spaces"],
    },
    {
      label: "Remove characters",
      functionNames: [
        "remove_accents",
        "remove_non_ascii",
        "remove_punctuation",
        "remove_dashes",
        "replace_separators_with_spaces",
      ],
    },
    { label: "Names", functionNames: ["remove_affixes", "phonetic"] },
    {
      label: "Reshape the value",
      functionNames: ["substring", "pad_left", "parse_date"],
    },
    { label: "Drop or default", functionNames: ["null_if", "coalesce"] },
  ];

/**
 * Every function name the workbench lets an operator add, flattened from
 * {@link STANDARDIZATION_FUNCTION_GROUPS}. Exported so the parity test can assert
 * this set equals the descriptor table's `tier: "standard"` names in both
 * directions.
 */
export const authorableFunctionNames: ReadonlySet<string> = new Set(
  STANDARDIZATION_FUNCTION_GROUPS.flatMap((group) => group.functionNames),
);

/**
 * The raw-pattern functions (`tier: "regex"`), grouped under the "advanced"
 * section of the add-step menu. Each authors an operator-supplied regular
 * expression: it runs under the linear-time engine (so a pattern cannot backtrack
 * catastrophically) and the descriptor's schema bounds the pattern's length and
 * rejects out-of-dialect syntax, but a wrong pattern still shapes which records
 * match. So they sit apart from {@link STANDARDIZATION_FUNCTION_GROUPS} (the
 * standard menu) and are never surfaced as a recommended fix. The per-party
 * cleaning editors offer these directly; only the cross-party, token-embedded
 * element-transform editor holds them back (read-only), via the same
 * `allowRawPatterns` gate.
 *
 * A parity test ({@link expertFunctionNames}) pins this set to the descriptor
 * table's `tier: "regex"` names in both directions, so a regex-tier function added
 * to core cannot ship without a group here, and a standard-tier function cannot
 * leak into the expert menu.
 */
export const STANDARDIZATION_EXPERT_FUNCTION_GROUPS: Array<StandardizationFunctionGroup> =
  [
    {
      label: "Raw patterns (advanced)",
      functionNames: [
        "filter_regex",
        "extract_regex",
        "replace_regex",
        "split_on",
      ],
    },
  ];

/**
 * Every function name the advanced group lets an operator add, flattened from
 * {@link STANDARDIZATION_EXPERT_FUNCTION_GROUPS}. Exported so the parity test can
 * assert this set equals the descriptor table's `tier: "regex"` names in both
 * directions, and that it is disjoint from {@link authorableFunctionNames}.
 */
export const expertFunctionNames: ReadonlySet<string> = new Set(
  STANDARDIZATION_EXPERT_FUNCTION_GROUPS.flatMap(
    (group) => group.functionNames,
  ),
);

/**
 * The editor-facing label and one-line blurb for a function, taken from its
 * descriptor -- except `coalesce`, whose generic "Coalesce" name is replaced with
 * the plain-language framing the acceptance criteria call for ("If empty,
 * substitute a default"), since an operator should not need to know the SQL term.
 * Falls back to the function name as the label when no descriptor matches. That
 * branch is unreachable from the add-step menu (which only offers descriptor-backed
 * functions, asserted by the parity test) BUT IS reachable via an imported linkage-
 * terms document, whose transform `function` is free text: an unrecognized name is
 * rendered raw here. So the fallback name is run through {@link sanitizeForDisplay}
 * -- a partner-controlled string must never reach the DOM (even as escaped text or
 * an aria-label) carrying control / bidi-override / homoglyph bytes that could spoof
 * a different, benign function name. The acceptor consent screen sanitizes the same
 * value; this closes it on the inviter's editing surface too.
 */
export function functionDisplay(functionName: string): {
  label: string;
  blurb: string;
} {
  if (functionName === "coalesce")
    return {
      label: "If empty, substitute a default",
      blurb:
        "Replace an empty (dropped) value with a fixed default, which can create matches that would not otherwise occur.",
    };
  const descriptor = descriptorFor(functionName);
  return descriptor === undefined
    ? { label: sanitizeForDisplay(functionName), blurb: "" }
    : { label: descriptor.label, blurb: descriptor.blurb };
}

// --- Typed param fields ------------------------------------------------------

/**
 * The input widget a parameter renders as, classified from its Zod type so the
 * editor shows a typed control rather than a raw text box.
 *
 * - `number` -- a numeric input.
 * - `enum` -- a select over {@link ParamField.enumOptions}.
 * - `stringArray` -- a multi-value (tag) input.
 * - `boolean` -- a switch (e.g. `split_on`'s `includeOriginal`).
 * - `string` -- a plain text input (the fallback; the regex-family `pattern` /
 *   `delimiter` params render here too and validate against the descriptor's
 *   dialect-and-length schema).
 */
export type ParamFieldKind =
  "number" | "string" | "enum" | "stringArray" | "boolean";

/**
 * One parameter of a standardization function, reduced to what the editor needs to
 * render a typed control and seed it: the param key (camelCase, matching the
 * runtime params a factory reads), a human label, the widget kind, whether it is
 * optional, its default value if the schema declares one, and the option list for
 * an enum. Derived from the descriptor's `params` Zod shape by
 * {@link describeParamFields}.
 */
export interface ParamField {
  /** The camelCase parameter key core's factory reads. */
  key: string;
  /** Plain-language label for the input. */
  label: string;
  /** The widget kind, classified from the Zod type. */
  kind: ParamFieldKind;
  /** True when the schema marks the param `.optional()` (no value is required). */
  optional: boolean;
  /** The schema-declared default, when the param carries one via `.default(...)`. */
  defaultValue?: unknown;
  /** The allowed values, present only for an `enum` param. */
  enumOptions?: Array<string>;
}

/** Plain-language labels for the known param keys, so a control never shows a raw
 * camelCase key. A key with no entry falls back to its raw form (unreachable for a
 * bundled function's params; this is exhaustive across the standard and expert
 * tiers, pinned by the label-coverage test). */
const PARAM_LABELS: Record<string, string> = {
  start: "Start position",
  length: "Length",
  inputFormat: "Input format",
  outputFormat: "Output format",
  char: "Fill character",
  algorithm: "Algorithm",
  value: "Value to drop",
  values: "Values to drop",
  default: "Default value",
  pattern: "Pattern",
  delimiter: "Delimiter pattern",
  replacement: "Replacement",
  includeOriginal: "Keep the original value too",
};

// The Zod v4 internal `_def` carries the discriminant `type` and the wrapper's
// `innerType`/`defaultValue`/`entries`; reading it is the documented way to drive
// editor form fields off a schema (see the descriptor table's `params` JSDoc).
// `_def` is intentionally outside Zod's public type surface, so this narrows the
// shape via `unknown` -- not `any` -- at the one boundary that touches it.
interface ZodInternalDef {
  type?: string;
  innerType?: unknown;
  defaultValue?: unknown;
  entries?: Record<string, unknown>;
}

function zodDef(schema: unknown): ZodInternalDef | undefined {
  return (schema as { _def?: ZodInternalDef })._def;
}

// Unwrap the Zod wrapper chain (`.optional()`, `.nullable()`, `.default(...)`) to
// the inner concrete type, capturing whether the param is optional and its
// declared default. Iterative with a hard cap so a pathological nesting cannot
// loop; the bundled descriptors nest at most two wrappers deep.
function unwrapParamSchema(schema: unknown): {
  type: string | undefined;
  optional: boolean;
  defaultValue: unknown;
  inner: unknown;
} {
  let current: unknown = schema;
  let optional = false;
  let defaultValue: unknown;
  for (let i = 0; i < 8; i++) {
    const def = zodDef(current);
    if (def?.innerType === undefined) break;
    if (def.type === "optional" || def.type === "nullable") {
      optional = true;
      current = def.innerType;
    } else if (def.type === "default" || def.type === "prefault") {
      const declared = def.defaultValue;
      defaultValue = typeof declared === "function" ? declared() : declared;
      current = def.innerType;
    } else {
      break;
    }
  }
  return {
    type: zodDef(current)?.type,
    optional,
    defaultValue,
    inner: current,
  };
}

/**
 * Reduce a function descriptor's `params` Zod object to the ordered list of typed
 * {@link ParamField}s the editor renders. Iterates `descriptor.params.shape` and
 * classifies each entry by its (unwrapped) Zod type into a widget kind, so the
 * authoring surface exposes typed inputs -- never a raw snake_case key or an
 * untyped text box. A no-param function yields an empty list.
 */
export function describeParamFields(
  descriptor: StandardizationFunctionDescriptor,
): Array<ParamField> {
  const shape = descriptor.params.shape;
  return Object.entries(shape).map(([key, schema]) => {
    const unwrapped = unwrapParamSchema(schema);
    let kind: ParamFieldKind;
    let enumOptions: Array<string> | undefined;
    switch (unwrapped.type) {
      case "number":
        kind = "number";
        break;
      case "enum":
        // Zod v4 stores the enum members as the keys of `_def.entries`.
        enumOptions = Object.keys(zodDef(unwrapped.inner)?.entries ?? {});
        kind = "enum";
        break;
      case "array":
        kind = "stringArray";
        break;
      case "boolean":
        kind = "boolean";
        break;
      default:
        kind = "string";
        break;
    }
    return {
      key,
      label: PARAM_LABELS[key] ?? key,
      kind,
      optional: unwrapped.optional,
      defaultValue: unwrapped.defaultValue,
      enumOptions,
    };
  });
}

/**
 * Validate a single authored param value against its declared type in the
 * descriptor, so the editor accepts or rejects an input exactly as core's schema
 * would (a fractional `substring` start, a multi-character `pad_left` fill, a `0`
 * start position all fail; a well-formed value passes). Returns the first issue's
 * message on rejection so the control can surface it inline. An unknown key is
 * rejected rather than silently passed.
 */
export function validateParamValue(
  descriptor: StandardizationFunctionDescriptor,
  key: string,
  value: unknown,
): { ok: boolean; message?: string } {
  if (!Object.hasOwn(descriptor.params.shape, key))
    return { ok: false, message: "unknown parameter" };
  const schema = descriptor.params.shape[key] as unknown as ZodType;
  const result = schema.safeParse(value);
  if (result.success) return { ok: true };
  return { ok: false, message: result.error.issues[0]?.message };
}

/**
 * Whether every parameter of `step` is well-formed for its function: each required
 * param present and each value matching the descriptor's declared type (the same
 * check {@link validateParamValue} drives the inline input errors from). This is
 * the basis for gating launch on a well-formed pipeline -- a step the operator left
 * mid-edit (e.g. a cleared `substring.start`, which the `NumberInput` reports as an
 * empty string) is not valid, so the host keeps it out of the exchange, where a
 * malformed param would otherwise run as a silent full-field exclusion or throw at
 * compile. A step naming a function core does not recognize is treated as valid:
 * it is not authored through this surface and its params are not editable, so there
 * is nothing here to judge.
 */
export function isStepValid(step: StandardizationStep): boolean {
  const descriptor = descriptorFor(step.function);
  if (descriptor === undefined) return true;
  return describeParamFields(descriptor).every((field) => {
    const value = step.params?.[field.key];
    const isEmpty =
      value === undefined ||
      value === "" ||
      (Array.isArray(value) && value.length === 0);
    if (field.optional && isEmpty) return true;
    return validateParamValue(descriptor, field.key, value).ok;
  });
}
