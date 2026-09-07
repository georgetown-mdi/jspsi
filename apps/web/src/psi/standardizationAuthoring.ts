/**
 * The pure, React-free model behind the web standardization-authoring workbench:
 * the intent-grouped function menu, the descriptor-driven typed param-field model,
 * per-param validation, and the reading of a step that does nothing where it sits
 * ({@link inertCoalesceCause}). The single tested boundary -- the function
 * grouping and the Zod-shape introspection are exercised here rather than through
 * the UI. The value-level constraint check the workbench renders as badges lives
 * in core's `checkValueConstraints` (shared with the CLI), not here, and so does
 * the coalesce classification this file reads rather than restates.
 */

import {
  FAN_OUT_FUNCTION_NAMES,
  STANDARDIZATION_FUNCTION_DESCRIPTORS,
  coalesceSubstitutesConstant,
  sanitizeForDisplay,
  stepCanEmptyRealizedValue,
} from "@psilink/core";

import type {
  Standardization,
  StandardizationFunctionDescriptor,
  StandardizationStep,
  TransformStep,
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
 * Layer per-field input-column overrides onto a derived standardization: rebind
 * a field (`output`) to an operator-chosen input column. The derived steps are
 * kept unchanged -- the host only offers columns of the field's own semantic
 * type, so the recommended cleaning still applies. This is what lets two fields
 * of one semantic type bind to DISTINCT columns, since the default type fallback
 * binds every same-typed field to the FIRST column of the type (see
 * {@link resolveFieldColumns}). Pure; the host passes only overrides whose
 * column is still a valid same-typed binding, so a remap that invalidates an
 * override drops it rather than rebinding a wrong-typed column.
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
 * (an own-property check, so a name reachable only on the prototype chain is
 * never treated as a descriptor), which the editor and the function-display
 * helper depend on for an unrecognized step.
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
 * The grouping is web-local intent metadata the descriptor table does not hold;
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
 * expression: it runs under the linear-time engine (no catastrophic backtrack)
 * and the descriptor's schema bounds the pattern's length and dialect, but a
 * wrong pattern still shapes which records match -- so these sit apart from
 * {@link STANDARDIZATION_FUNCTION_GROUPS} and are never shown as a recommended
 * fix. The per-party cleaning editors offer them directly; the cross-party,
 * token-embedded element-transform editor holds them back (read-only) via the
 * same `allowRawPatterns` gate.
 *
 * A parity test ({@link expertFunctionNames}) pins this set to the descriptor
 * table's `tier: "regex"` names in both directions, so a regex-tier function
 * added to core cannot ship without a group here, and a standard-tier function
 * cannot leak into the expert menu.
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
 * The advanced groups as the add-step menu offers them: the raw-pattern family
 * minus every function core classes as fan-out (`FAN_OUT_FUNCTION_NAMES`). A
 * fan-out has consequences of its own (matching per candidate, the removal that
 * follows a match, the candidate grouping the single-pass receiver is handed)
 * that this editor gives the operator no control to weigh, so it offers no step
 * that declares one, and its Generate gate refuses one an imported document
 * holds (`advancedInviteValidation.ts`) -- wider than core's own refusal, by
 * design and not by drift.
 *
 * Derived from core's list rather than a second web-side one, so the menu
 * follows whatever core classes as a fan-out with no edit here. An imported
 * document's fan-out step still RENDERS -- {@link STANDARDIZATION_EXPERT_FUNCTION_GROUPS}
 * keeps the full family for the descriptor-backed read-only row and its parity
 * test -- so the operator can see and remove it rather than meet an unlabeled
 * step.
 */
export const OFFERED_EXPERT_FUNCTION_GROUPS: Array<StandardizationFunctionGroup> =
  STANDARDIZATION_EXPERT_FUNCTION_GROUPS.map((group) => ({
    ...group,
    functionNames: group.functionNames.filter(
      (name) => !FAN_OUT_FUNCTION_NAMES.includes(name),
    ),
  })).filter((group) => group.functionNames.length > 0);

/**
 * The plain-language label the add-step menu and the step rows show for
 * `coalesce`, in place of the descriptor's SQL term. It states the condition
 * core's descriptor states -- a value an earlier rule of the SAME pipeline
 * emptied -- rather than the "fill in for an absent or empty input" framing,
 * which would invite an author to expect blank-ish records to participate. A
 * record whose field is absent never enters the pipeline at all; semantics are
 * in `docs/EXCHANGE_REFERENCE.md`, "Null propagation".
 */
const COALESCE_LABEL = "Substitute a default where a rule emptied the value";

/**
 * The editor-facing label and one-line blurb for a function. The blurb is always
 * the descriptor's own; the label is the descriptor's except for `coalesce`,
 * which takes {@link COALESCE_LABEL}.
 *
 * Falls back to the function name as the label when no descriptor matches --
 * unreachable from the add-step menu (parity-tested) but reachable via an
 * imported linkage-terms document, whose transform `function` is free text and
 * rendered raw. The fallback name is run through {@link sanitizeForDisplay}: a
 * partner-controlled string must never reach the DOM holding control, bidi-
 * override, or homoglyph bytes that could spoof a different, benign function
 * name -- the same sanitizing the acceptor consent screen applies.
 */
export function functionDisplay(functionName: string): {
  label: string;
  blurb: string;
} {
  const descriptor = descriptorFor(functionName);
  if (descriptor === undefined)
    return { label: sanitizeForDisplay(functionName), blurb: "" };
  return {
    label: functionName === "coalesce" ? COALESCE_LABEL : descriptor.label,
    blurb: descriptor.blurb,
  };
}

// --- A coalesce that substitutes nothing where it sits -----------------------

/**
 * Why a declared `coalesce` substitutes nothing at the position it occupies:
 *
 * - `"no-emptying-rule"` -- no step before it can leave a realized value empty,
 *   so its substituting branch is never reached.
 * - `"no-text-default"` -- an emptying rule does precede it, but the `default` it
 *   declares is absent or is not text, which core runs as a pass-through.
 */
type InertCoalesceCause = "no-emptying-rule" | "no-text-default";

/**
 * Why the `coalesce` at a position substitutes nothing there, or `undefined`
 * where it does substitute (and for any other function).
 *
 * The verdict is core's: {@link coalesceSubstitutesConstant} decides whether the
 * substitution fires, {@link stepCanEmptyRealizedValue} decides its position
 * half, and the cause follows by elimination between them -- this function
 * classifies nothing of its own, so it cannot drift from the runtime. Position
 * is checked first because a coalesce with no preceding emptying rule
 * substitutes nothing regardless of its declared default.
 *
 * `precedingSteps` is required rather than defaulted: the verdict is a property
 * of the position, not of the step alone, so adding or moving an emptying step
 * re-answers this.
 */
export function inertCoalesceCause(
  step: TransformStep,
  precedingSteps: ReadonlyArray<TransformStep>,
): InertCoalesceCause | undefined {
  if (step.function !== "coalesce") return undefined;
  if (coalesceSubstitutesConstant(step, precedingSteps)) return undefined;
  return precedingSteps.some(stepCanEmptyRealizedValue)
    ? "no-text-default"
    : "no-emptying-rule";
}

/**
 * What the step editor tells an author about a coalesce that substitutes nothing
 * where it sits, one line per {@link InertCoalesceCause}, each naming the remedy
 * that reaches its own cause. Advice, not a refusal: a pipeline holding such a
 * step is valid, mints, and runs -- core runs the step as a pass-through.
 */
export const INERT_COALESCE_ADVICE: Record<InertCoalesceCause, string> = {
  "no-emptying-rule":
    "This default is never substituted here: no step before it can leave a " +
    "value empty, and a record with no value for the column never reaches " +
    "these steps at all. Move this step after a rule that can drop a value, " +
    "or add one before it.",
  "no-text-default":
    "This step substitutes nothing until it declares a text default value.",
};

/**
 * Whether a pipeline declares a `coalesce` that substitutes nothing where it
 * sits -- {@link inertCoalesceCause} over each step against the steps ahead of
 * it. The per-field question behind the authoring notice; the step editor asks
 * for the cause instead, since it has a row to attach the advice to.
 */
export function pipelineHasInertCoalesce(
  steps: ReadonlyArray<TransformStep>,
): boolean {
  return steps.some(
    (step, index) =>
      inertCoalesceCause(step, steps.slice(0, index)) !== undefined,
  );
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
type ParamFieldKind = "number" | "string" | "enum" | "stringArray" | "boolean";

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
  /** The schema-declared default, when the param holds one via `.default(...)`. */
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

// The Zod v4 internal `_def` holds the discriminant `type` and the wrapper's
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
 * message on rejection so the control can show it inline. An unknown key is
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
 * Whether every parameter of `step` is well-formed for its function: each
 * required param present and each value matching the descriptor's declared type
 * (the same check {@link validateParamValue} drives the inline input errors
 * from). This gates launch on a well-formed pipeline -- a step left mid-edit
 * (e.g. a cleared `substring.start`) is not valid, so the host keeps it out of
 * the exchange rather than running a malformed param as a silent full-field
 * exclusion or throwing at compile. A step naming a function core does not
 * recognize is invalid for the same reason: the descriptor table is core's own
 * registry, so a name absent from it is one the pipeline compile throws on, and
 * its params are not editable here -- the remedy is to remove the step.
 */
export function isStepValid(step: StandardizationStep): boolean {
  const descriptor = descriptorFor(step.function);
  if (descriptor === undefined) return false;
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
