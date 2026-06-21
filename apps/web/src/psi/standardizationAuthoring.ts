import { STANDARDIZATION_FUNCTION_DESCRIPTORS } from "@psilink/core";

import type {
  LinkageField,
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

/**
 * The pure, React-free model behind the web standardization-authoring workbench:
 * the intent-grouped function menu, the descriptor-driven typed param-field model,
 * per-param validation, and the thin web value-level constraint check. The single
 * tested boundary -- the function grouping, the Zod-shape introspection, and the
 * constraint check are all exercised here rather than through the UI.
 *
 * Everything authoring-related is driven from core's
 * {@link STANDARDIZATION_FUNCTION_DESCRIPTORS}, the shared descriptor table, so the
 * editor never re-encodes a function's parameter shape, label, or risk tier. The
 * add menu offers exactly the functions whose descriptor `tier` is `"standard"`
 * (`coalesce` among them); the `tier: "regex"` family (raw-pattern authoring) is
 * the deferred expert tier (see board item 202533670), so it is excluded from the
 * menu here -- a default pipeline's existing regex steps are still rendered and
 * reorderable by the editor, just not authored from scratch.
 */

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
 * The editor-facing label and one-line blurb for a function, taken from its
 * descriptor -- except `coalesce`, whose generic "Coalesce" name is replaced with
 * the plain-language framing the acceptance criteria call for ("If empty,
 * substitute a default"), since an operator should not need to know the SQL term.
 * Returns the raw name as a last-resort label for a function with no descriptor
 * (unreachable for an authorable function; the parity test guarantees coverage).
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
    ? { label: functionName, blurb: "" }
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
 * - `string` -- a plain text input (the fallback).
 */
export type ParamFieldKind = "number" | "string" | "enum" | "stringArray";

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
 * bundled function's params; this is exhaustive for the standard tier). */
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

// --- Value-level constraint check --------------------------------------------

/**
 * A single value-level constraint violation, a warn-not-enforce signal the
 * workbench surfaces as a badge: a cleaned value does not meet one of the field's
 * declared constraints. `label` is a short badge caption; `detail` is a one-line
 * explanation. Both are fixed copy keyed off the constraint kind -- never a
 * partner-controlled value -- so they are safe to render verbatim.
 */
export interface ConstraintViolation {
  /** Short badge caption (e.g. "excluded value"). */
  label: string;
  /** One-line plain-language explanation of the violation. */
  detail: string;
}

/** Whether `value` contains only characters in the field's `allowedCharacters`
 * class. `allowedCharacters` is partner-controlled (it arrives in the invitation
 * token), and NameConstraintsSchema only checks that it compiles as the body of a
 * `[...]` class -- NOT that it cannot break out of one. A crafted value can close
 * the class and inject arbitrary regex structure (e.g. `x](a+)+b[y`), so matching
 * the WHOLE value against `^[allowed]*$` would run an attacker-chosen pattern that
 * could backtrack catastrophically (ReDoS) on the local thread -- the same class of
 * hazard the transform-regex engine swap (#248) closed for key-building.
 *
 * This is a local advisory, not a key-building step, so it does not reach that
 * linear-time engine; instead it bounds every subject this regex sees to a single
 * code point. Catastrophic backtracking needs a long subject to fan out over, so a
 * length-1 subject makes the match cost bounded by the pattern length regardless of
 * what was injected -- ReDoS-safe by construction. For a legitimate class this is
 * exactly `^[allowed]*$` (every character must be in the class); it differs only on
 * an adversarial breakout, which has no faithful semantics to preserve anyway. The
 * compile is still guarded so an unexpectedly invalid class is treated as "cannot
 * check" (no violation) rather than throwing. The empty string trivially conforms. */
function withinAllowedCharacters(value: string, allowed: string): boolean {
  let oneOf: RegExp;
  try {
    oneOf = new RegExp(`^[${allowed}]$`);
  } catch {
    return true;
  }
  for (const character of value) if (!oneOf.test(character)) return false;
  return true;
}

/** Whether a standardized value is a valid calendar date in canonical YYYYMMDD
 * form -- the output the default `date_of_birth` pipeline produces. A value not in
 * that form is not flagged (the operator may target a different output format and a
 * false "invalid date" badge would mislead); only an 8-digit value that names no
 * real calendar day is. */
function isValidStandardizedDate(value: string): boolean {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (match === null) return true;
  const [, year, month, day] = match;
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
  return (
    !Number.isNaN(date.getTime()) &&
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() + 1 === Number(month) &&
    date.getUTCDate() === Number(day)
  );
}

/** Whether a 9-digit value satisfies the SSA structural rules: area not 000 or
 * 666 and below 900, group not 00, serial not 0000. A value that is not exactly 9
 * digits is left to the format-shaped pipeline and not flagged here. */
function isStructurallyValidSsn(value: string): boolean {
  if (!/^\d{9}$/.test(value)) return true;
  const area = Number(value.slice(0, 3));
  const group = Number(value.slice(3, 5));
  const serial = Number(value.slice(5, 9));
  return (
    area !== 0 && area !== 666 && area < 900 && group !== 0 && serial !== 0
  );
}

/**
 * The thin web value-level constraint check: does a single cleaned `value` meet
 * the declared constraints of the linkage `field` it is produced for? Returns the
 * violations as warn-not-enforce signals; an empty array means the value conforms
 * to every checkable constraint. Warn, never block -- a violation surfaces as a
 * badge, mirroring the application's "warns if violated but does not enforce"
 * contract for constraints (see `LinkageField`).
 *
 * Web-LOCAL and intentionally thin: core's `validateStandardizationAgainstTerms`
 * checks only names, so this is the first value-level check, and a follow-up
 * promotes it to core for CLI reuse (board item filed alongside this slice).
 * Covered today: the `exclude` denylist (every field type), name
 * `allowedCharacters`, `date_of_birth` `validOnly` (canonical YYYYMMDD), and `ssn`
 * `validOnly` (SSA structural rules). Constraints with no clean value-level test --
 * name `affixesAllowed` and `ssn4` `validOnly` -- are deliberately not flagged
 * rather than guessed, so a badge never fires on a value it cannot actually judge.
 */
export function checkValueConstraints(
  field: LinkageField,
  value: string,
): Array<ConstraintViolation> {
  const constraints = field.constraints;
  if (constraints === undefined) return [];
  const violations: Array<ConstraintViolation> = [];

  // `exclude` is shared by every constraint shape: the cleaned value must not be
  // one of the listed values.
  if (constraints.exclude?.includes(value))
    violations.push({
      label: "excluded value",
      detail: "This cleaned value is on the agreed excluded-values list.",
    });

  switch (field.type) {
    case "first_name":
    case "last_name": {
      const allowed = field.constraints?.allowedCharacters;
      if (allowed !== undefined && !withinAllowedCharacters(value, allowed))
        violations.push({
          label: "disallowed characters",
          detail:
            "This cleaned value contains characters outside the field's allowed set.",
        });
      break;
    }
    case "date_of_birth":
      if (
        field.constraints?.validOnly === true &&
        !isValidStandardizedDate(value)
      )
        violations.push({
          label: "invalid date",
          detail: "This cleaned value is not a valid calendar date.",
        });
      break;
    case "ssn":
      if (
        field.constraints?.validOnly === true &&
        !isStructurallyValidSsn(value)
      )
        violations.push({
          label: "invalid SSN",
          detail:
            "This cleaned value does not meet the Social Security Administration's structural rules.",
        });
      break;
    case "ssn4":
    case "phone_number":
    case "email_address":
      // Only `exclude` (handled above) has a clean value-level test for these
      // types; nothing further to check.
      break;
  }

  return violations;
}
