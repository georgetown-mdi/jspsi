import { z } from "zod";
import { AlgorithmSchema } from "../types.js";
import type { Algorithm } from "../types.js";
import { camelizeKeys, MAX_NESTING_DEPTH } from "../utils/camelizeKeys.js";
import { safeParseCamelized } from "./safeParseCamelized.js";
import { boundedArray } from "../utils/boundedArray.js";
import {
  coerceToPatternString,
  patternConformsToDialect,
} from "../utils/linearRegex.js";
import {
  linkageTermsHaveNonConformantTransformRegex,
  REGEX_STEP_PATTERN_PARAM,
} from "./transformRegexDialect.js";
import { exceedsOwnKeyCount } from "../utils/objectKeyCount.js";
import { loneSurrogateIndex } from "../utils/wellFormedString.js";
import {
  COUNT_ONLY_SHAPE_REFUSALS,
  countOnlyShapeViolation,
  swapPairFuzzyComparisonsDiffer,
  swapPairTransformsDiffer,
} from "../linkageTermsPolicy.js";

// --- Untrusted-input bounds --------------------------------------------------

// These terms travel inside an invitation token from an unauthenticated
// counterparty, and again off the exchange wire under the far larger
// MAX_FRAME_SIZE_BYTES cap (connection/frameSize.ts). Every partner-controlled
// free-text string has a generous length `.max()`, and every
// partner-controlled collection has a count bound applied before per-element
// validation: `boundedArray` for an array, or an equivalent count-refine +
// pipe for the `transform.params` record, which `boundedArray` does not
// cover. The exchange-wire arrays whose real count is legitimately in the
// millions (payloadExchange.ts, participant.ts, link.ts) use a single-issue
// element validator instead (utils/singleIssueArray.ts). The Connection,
// Standardization, and Metadata schemas are operator-local, not
// partner-controlled, and have no such bound. Full reasoning:
// docs/spec/CHANNEL_SECURITY.md, "Application-layer parsed-input bounds".

/**
 * Upper bound on a short partner-controlled identifier- or spec-like string: a
 * linkage key, field, or element `name`, an element `field` reference, an
 * element-`swap` reference, a transform `function` name and its `params` keys,
 * a payload column `name`, a legal-agreement `reference`, the `version`
 * string, and a name-constraint `allowedCharacters` class. Also reused by the
 * operator-local metadata `ColumnMetadata.name` (config/metadata.ts).
 */
export const MAX_NAME_LENGTH = 256;

/**
 * Upper bound on a prose-like or data-value free-text field: a party
 * `identity`, a legal-agreement `purpose`, a payload column `description`, or
 * a constraint `exclude` value. Larger than {@link MAX_NAME_LENGTH} since
 * these hold a sentence or a long data value rather than a single label. The
 * same four fields apply {@link TEXT_CONTROL_CHAR_PATTERN} without exception.
 */
export const MAX_TEXT_LENGTH = 1024;

/**
 * The control characters refused in every {@link MAX_TEXT_LENGTH}-bounded
 * free-text field of a terms document -- party `identity`, legal-agreement
 * `purpose`, payload column `description`, and each constraint `exclude`
 * entry: the C0 range (NUL included), DEL, and C1, with no exception for tab,
 * line feed, or carriage return.
 *
 * Enforced once at parse so every seat that reads a live document -- the
 * operator's own config load, the post-handshake wire re-parse
 * (`parseLinkageTerms`), the invitation-token decode, and the exchange-file
 * and job-intent schemas that embed {@link LinkageTermsSchema} -- inherits it,
 * rather than each consumer holding a guard of its own.
 *
 * A reader of an already-recorded value -- the exchange-record reader
 * (exchangeRecord.ts) and the wire-certificate schema (signedReceipt.ts) --
 * is outside this rule and relies on its own display-escaping instead.
 *
 * Letters outside ASCII are untouched: the ranges stop below U+00A0.
 *
 * The web console applies these same ranges to an operator's `--identity`
 * label (`IDENTITY_CONTROL_CHAR_PATTERN`, apps/web/src/jobs/intentSchemas.ts,
 * held equal by apps/web/test/unit/jobs/identityLabelParity.test.ts) and is
 * stricter, also refusing a leading `-`.
 */
export const TEXT_CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Shared refusal message for every free-text control-character rejection, so
 * the document reports the same thing about the same class of value wherever
 * it fires. A fixed literal naming no submitted value: the offending field is
 * located by the issue `path`, which `describeDecodeError` escapes segment by
 * segment, as the unsanitized parse-error path (protocolSetup) requires.
 */
export const TEXT_CONTROL_CHAR_MESSAGE =
  "a linkage terms free-text value must not contain control characters";

/**
 * Shared refusal message for a terms string -- a member value, an array
 * element, or an object KEY -- that is not well-formed UTF-16. A fixed literal
 * naming no submitted value: the offending string is located by the issue
 * `path`, which `describeDecodeError` escapes segment by segment, as the
 * unsanitized parse-error path (protocolSetup) requires.
 */
export const LONE_SURROGATE_MESSAGE =
  "a linkage terms text value must not contain an unpaired UTF-16 surrogate";

/**
 * Shared refusal message for a terms document that nests deeper than
 * {@link MAX_NESTING_DEPTH}, which the well-formedness walk reports rather than
 * recursing into. A fixed literal naming no submitted value, for the reason
 * {@link LONE_SURROGATE_MESSAGE} gives.
 */
export const NESTING_DEPTH_MESSAGE = `a linkage terms value must not nest deeper than ${MAX_NESTING_DEPTH} levels`;

/**
 * Upper bound on the COUNT of entries in the `linkageFields` and
 * `linkageKeys` arrays, applied before per-element validation. The `.min(1)`
 * floor and the most-to-least-precise ordering of `linkageKeys` are
 * unaffected.
 */
export const MAX_LINKAGE_ENTRIES = 256;

/**
 * Upper bound on the COUNT of entries in a transform step's `params` record,
 * enforced by a bare key count ({@link exceedsOwnKeyCount}, on
 * {@link TransformStep}'s schema) that fires before the per-key length
 * validation, so an over-count record is rejected with a single issue rather
 * than one per key. The same bound short-circuits the camelize pre-pass for
 * an over-count record (see {@link parseLinkageTerms}).
 */
export const MAX_PARAMS_ENTRIES = 256;

/**
 * Upper bound on the numeric `length` param of a `pad_left` transform step
 * (the uniform string bound {@link MAX_TRANSFORM_PARAM_LENGTH} does not
 * cover a number). `pad_left` runs per row in the key-building pipeline
 * ({@link applyElementTransform}); an unbounded `length` drives an unbounded
 * `padStart` allocation on every row. The factory's own positive-integer
 * check (standardization.ts) remains the runtime safety check for the
 * operator-local path, which never reaches this schema. Full reasoning:
 * docs/spec/CHANNEL_SECURITY.md, "Unbounded transform-parameter rejection".
 */
export const MAX_PAD_LEFT_LENGTH = 256;

/**
 * Upper bound on the `inputFormat` and `outputFormat` params of a
 * `parse_date` transform step, stricter than the uniform string bound every
 * param value has ({@link MAX_TRANSFORM_PARAM_LENGTH}): both drive a per-row
 * regex build and output allocation in the key-building pipeline
 * ({@link applyElementTransform}). `parse_date` compiles its regex under the
 * linear-time engine (standardization.ts), so this cap bounds per-row work
 * size rather than guarding against backtracking. Full reasoning:
 * docs/spec/CHANNEL_SECURITY.md, "Unbounded transform-parameter rejection".
 */
export const MAX_DATE_FORMAT_LENGTH = 256;

/**
 * Upper bound on the length of a raw partner-controlled regex pattern: the
 * `pattern` of `replace_regex` / `extract_regex` / `filter_regex` and the
 * `delimiter` of `split_on`. These compile per row under the linear-time
 * engine, which cannot backtrack catastrophically but whose compile cost is
 * super-linear in source length -- a compile-cost ceiling, not a
 * backtracking guard. Enforced twice: a per-step refine on
 * {@link TransformStep}'s schema, and the dialect gate on
 * {@link LinkageTermsSchema} (`maxPatternLength`). Full reasoning:
 * docs/spec/CHANNEL_SECURITY.md, "Transform-regex linear-time dialect".
 */
export const MAX_TRANSFORM_PATTERN_LENGTH = 1000;

/**
 * Upper bound on the length of a STRING-valued partner-controlled transform
 * param: applies to every string entry of a `transform.params` record,
 * whatever function or param name it sits under. By design the same
 * threshold as {@link MAX_TRANSFORM_PATTERN_LENGTH}. Bounds what the partner
 * may WRITE, not what a row may DERIVE from it -- see
 * {@link MAX_TRANSFORMED_VALUE_LENGTH} (standardization.ts) for that
 * complementary ceiling. Full reasoning: docs/spec/CHANNEL_SECURITY.md,
 * "Unbounded transform-parameter rejection".
 */
export const MAX_TRANSFORM_PARAM_LENGTH = 1000;

/**
 * Generous upper bound on the COUNT of values in a constraint `exclude`
 * denylist. A denylist legitimately holds hundreds of values (a list of
 * invalid SSN patterns, blocked test values, an email blocklist), so this is
 * the most generous of the collection-count bounds -- far above any real
 * denylist yet well below the RangeError threshold documented in the
 * untrusted-input bounds note above. Enforced before per-element validation
 * by {@link boundedArray}.
 */
export const MAX_EXCLUDE_ENTRIES = 4096;

/**
 * Generous upper bound on the COUNT of steps in a linkage-key element's
 * `transform` pipeline. The bundled standardizing pipelines chain a handful of
 * steps (parse_date, trim, uppercase); 256 is far above any real pipeline yet
 * refuses an array padded to overflow Zod's call stack. Enforced before
 * per-element validation by {@link boundedArray}.
 */
export const MAX_TRANSFORM_STEPS = 256;

/**
 * Generous upper bound on the COUNT of elements in a linkage key. A key combines
 * a few field-derived elements (the default template's widest key has four);
 * with at most {@link MAX_LINKAGE_ENTRIES} declared fields to reference, 256 is
 * generous yet refuses an array padded to overflow Zod's call stack. The
 * existing `.min(1)` floor is preserved. Enforced before per-element validation
 * by {@link boundedArray}.
 */
export const MAX_KEY_ELEMENTS = 256;

/**
 * Generous upper bound on the COUNT of columns in a payload `send` or
 * `receive` list. A payload shares a curated set of output columns -- a
 * handful to a few dozen, at most a few hundred for an unusually wide
 * dataset -- far above any real column set yet far below the RangeError
 * threshold documented in the untrusted-input bounds note above. Enforced
 * before per-element validation by {@link boundedArray}.
 */
export const MAX_PAYLOAD_ENTRIES = 4096;

/**
 * One free-text value of a terms document, holding the caller's own length floor
 * to the shared shape rule: no {@link TEXT_CONTROL_CHAR_PATTERN} character. The
 * caller supplies the string schema so a field that requires a value keeps its
 * `.min(1)`, and the control-character check is written once so the four
 * free-text fields cannot drift apart.
 *
 * Unlike the `allowedCharacters` refine below, this one needs no pre-length
 * short-circuit. Zod does not short-circuit chained checks, so the scan runs on a
 * value the `.max()` already rejected -- but it is a linear regex test rather
 * than a super-linear regex COMPILE, so an oversized value costs one pass over
 * bytes the parser has already walked and reports both issues.
 */
const freeTextValue = (schema: z.ZodString) =>
  schema.refine((value) => !TEXT_CONTROL_CHAR_PATTERN.test(value), {
    message: TEXT_CONTROL_CHAR_MESSAGE,
  });

/**
 * What the well-formedness walk refused, and where: a string -- a member value,
 * an array element, or an object KEY -- holding an unpaired UTF-16 surrogate,
 * or a value nested past the depth the walk goes to.
 */
type WellFormednessRefusal = {
  reason: "lone-surrogate" | "too-deep";
  path: PropertyKey[];
};

/**
 * The first thing in `value` that fails the well-formed UTF-16 rule
 * ({@link loneSurrogateIndex}), or undefined when every string in it is
 * well-formed and it nests no deeper than {@link MAX_NESTING_DEPTH}.
 *
 * A walk over the parsed document rather than a per-field check: it reaches
 * every string-typed field the schema declares at once, the keys of a
 * `transform.params` record, and the arbitrary JSON a param VALUE may hold --
 * the last of which no per-field refine can be written for. Its width is
 * bounded by the schema's own count bounds.
 *
 * The depth bound is the walk's own, not the camelize pre-pass's: the camelize
 * bound covers `parseLinkageTerms` and `safeParseLinkageTerms`, while
 * `LinkageTermsSchema` is also consumed bare (config/exchangeSpec.ts, the web
 * app's job-intent schemas), where an arbitrarily deep param value would
 * otherwise overflow this recursion and raise a `RangeError` out of
 * `safeParse`. A value at the bound is refused rather than walked, matching
 * what the camelize pre-pass does at the same depth.
 */
function firstWellFormednessRefusal(
  value: unknown,
  path: PropertyKey[],
  depth: number,
): WellFormednessRefusal | undefined {
  if (typeof value === "string")
    return loneSurrogateIndex(value) >= 0
      ? { reason: "lone-surrogate", path }
      : undefined;
  if (value === null || typeof value !== "object") return undefined;
  if (depth >= MAX_NESTING_DEPTH) return { reason: "too-deep", path };
  if (Array.isArray(value)) {
    for (const [index, element] of value.entries()) {
      const found = firstWellFormednessRefusal(
        element,
        [...path, index],
        depth + 1,
      );
      if (found !== undefined) return found;
    }
    return undefined;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    if (loneSurrogateIndex(key) >= 0)
      return { reason: "lone-surrogate", path: childPath };
    const found = firstWellFormednessRefusal(child, childPath, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * A constraint `exclude` denylist: partner-controlled free-text values, each
 * length-bounded and control-character-refused like every other free-text string
 * ({@link freeTextValue}), with the entry COUNT bounded at
 * {@link MAX_EXCLUDE_ENTRIES} before per-element validation (see
 * {@link boundedArray}). Shared by all four constraint schemas so the bound is
 * defined once.
 */
const ExcludeSchema = boundedArray(
  freeTextValue(z.string().max(MAX_TEXT_LENGTH)),
  MAX_EXCLUDE_ENTRIES,
  `exclude must not exceed ${MAX_EXCLUDE_ENTRIES} entries`,
);

// --- Output ------------------------------------------------------------------

/**
 * Per-party output preferences. Each party independently declares whether they
 * expect to receive the intersection result and whether their partner should
 * too.
 *
 * If exactly one party has `expectsOutput: true`, that party is the receiver
 * and the other is the sender. If both declare `expectsOutput: true`, roles are
 * assigned dynamically by comparing dataset sizes to minimize data transmitted.
 */
export interface Output {
  /**
   * Whether this party expects to receive the intersection result. Requires
   * the partner's linkage terms to also have `shareWithPartner: true`.
   */
  expectsOutput: boolean;
  /**
   * Whether the other party should also receive the result. Requires the
   * partner's linkage terms to also have `expectsOutput: true`.
   */
  shareWithPartner: boolean;
}

const OutputSchema: z.ZodType<Output> = z.object({
  expectsOutput: z.boolean(),
  shareWithPartner: z.boolean(),
});

// --- Linkage fields ----------------------------------------------------------

/** Constraints on name fields. */
interface NameConstraints {
  /**
   * Regex character class; characters outside it are expected to have been
   * removed.
   */
  allowedCharacters?: string;
  /**
   * If false, honorifics (Mr., Dr.) and suffixes (Jr., III) are expected to
   * have been removed.
   */
  affixesAllowed?: boolean;
  exclude?: string[];
}

const NameConstraintsSchema: z.ZodType<NameConstraints> = z.object({
  // Validated to compile as a character class under the linear-time engine
  // (re2js), the SAME engine that executes it (`checkValueConstraints`,
  // valueConstraints.ts): a leading `^` is escaped to a literal first so the
  // class is treated as an allow-list, not a negation. The length check runs
  // before the compile so an oversized value never reaches it -- Zod does
  // not short-circuit chained checks, so the refine still runs after a
  // failed `.max()`; an over-length value passes the refine on that
  // short-circuit and is rejected by `.max()` alone. Full reasoning:
  // docs/spec/CHANNEL_SECURITY.md, "Name-constraint character class".
  allowedCharacters: z
    .string()
    .max(MAX_NAME_LENGTH)
    .refine(
      (val) =>
        val.length > MAX_NAME_LENGTH || patternConformsToDialect(`[${val}]`),
      { message: "allowedCharacters must be a valid regex character class" },
    )
    .optional(),
  affixesAllowed: z.boolean().optional(),
  exclude: ExcludeSchema.optional(),
});

/** Constraints on date-of-birth fields. */
interface DateConstraints {
  /** Dates must be able to be parsed as valid dates. */
  validOnly?: boolean;
  exclude?: string[];
}

const DateConstraintsSchema: z.ZodType<DateConstraints> = z.object({
  validOnly: z.boolean().optional(),
  exclude: ExcludeSchema.optional(),
});

/** Constraints on SSN and SSN-last-4 fields. */
interface SSNConstraints {
  /**
   * Data must conform to SSA rules (area, group, and serial numbers may not be
   * all zeros, etc.).
   */
  validOnly?: boolean;
  /**
   * Values that must not appear in the data (e.g. "123456789", "111111111").
   */
  exclude?: string[];
}

const SSNConstraintsSchema: z.ZodType<SSNConstraints> = z.object({
  validOnly: z.boolean().optional(),
  exclude: ExcludeSchema.optional(),
});

/** Constraints applicable to any semantic type. */
interface AnyConstraints {
  exclude?: string[];
}

const AnyConstraintsSchema: z.ZodType<AnyConstraints> = z.object({
  exclude: ExcludeSchema.optional(),
});

// Shared fields for all linkage field variants.
const linkageFieldBase = <C>(constraints: z.ZodType<C>) => ({
  name: z.string().min(1).max(MAX_NAME_LENGTH),
  constraints: constraints.optional(),
});

interface FirstNameField {
  name: string;
  type: "first_name";
  constraints?: NameConstraints;
}
interface LastNameField {
  name: string;
  type: "last_name";
  constraints?: NameConstraints;
}
interface DateOfBirthField {
  name: string;
  type: "date_of_birth";
  constraints?: DateConstraints;
}
interface SsnField {
  name: string;
  type: "ssn";
  constraints?: SSNConstraints;
}
/**
 * Last four digits of SSN. Distinct from `ssn` because some parties only
 * possess the last four digits; this is not a derived field.
 */
interface Ssn4Field {
  name: string;
  type: "ssn4";
  constraints?: SSNConstraints;
}
interface PhoneNumberField {
  name: string;
  type: "phone_number";
  constraints?: AnyConstraints;
}
interface EmailAddressField {
  name: string;
  type: "email_address";
  constraints?: AnyConstraints;
}
interface ZipCodeField {
  name: string;
  type: "zip_code";
  constraints?: AnyConstraints;
}

/**
 * A standardized PII field that participates in linkage. Linkage key elements
 * reference these fields by name; data cleaning pipelines produce them by name.
 * Constraints are standards both parties commit to meeting -- the application
 * warns if violated but does not enforce them.
 */
export type LinkageField =
  | FirstNameField
  | LastNameField
  | DateOfBirthField
  | SsnField
  | Ssn4Field
  | PhoneNumberField
  | EmailAddressField
  | ZipCodeField;

const LinkageFieldSchema: z.ZodType<LinkageField> = z.discriminatedUnion(
  "type",
  [
    z.object({
      type: z.literal("first_name"),
      ...linkageFieldBase(NameConstraintsSchema),
    }),
    z.object({
      type: z.literal("last_name"),
      ...linkageFieldBase(NameConstraintsSchema),
    }),
    z.object({
      type: z.literal("date_of_birth"),
      ...linkageFieldBase(DateConstraintsSchema),
    }),
    z.object({
      type: z.literal("ssn"),
      ...linkageFieldBase(SSNConstraintsSchema),
    }),
    z.object({
      type: z.literal("ssn4"),
      ...linkageFieldBase(SSNConstraintsSchema),
    }),
    z.object({
      type: z.literal("phone_number"),
      ...linkageFieldBase(AnyConstraintsSchema),
    }),
    z.object({
      type: z.literal("email_address"),
      ...linkageFieldBase(AnyConstraintsSchema),
    }),
    z.object({
      type: z.literal("zip_code"),
      ...linkageFieldBase(AnyConstraintsSchema),
    }),
  ],
);

// --- Linkage key elements ----------------------------------------------------

/**
 * The candidate-set expansion a linkage-key element may declare. Applied by
 * `expandFuzzyComparisons`, which defines what each member emits.
 */
export type GenerateFuzzyComparisons =
  "transpositions" | "edit_distances" | "adjacent_years";

const GenerateFuzzyComparisonsSchema: z.ZodType<GenerateFuzzyComparisons> =
  z.enum(["transpositions", "edit_distances", "adjacent_years"]);

/**
 * A single step in a linkage key element transform. Uses the same function
 * names as the data cleaning pipeline.
 */
export interface TransformStep {
  /** Name of the function to apply. */
  function: string;
  /** Function-specific parameters. */
  params?: Record<string, unknown>;
}

// One value of a transform step's `params` record: any JSON value, with a
// content bound on a string. The bound sits on the VALUE STAGE rather than a
// per-step refine so it holds for every function and param name at once,
// including one this build does not implement. A non-string value passes
// through untouched (`z.unknown()`); the params whose non-string magnitude
// drives per-row work have their own stricter refines on TransformStepSchema
// below. See MAX_TRANSFORM_PARAM_LENGTH.
const TransformParamValueSchema = z
  .unknown()
  .refine(
    (value) =>
      typeof value !== "string" || value.length <= MAX_TRANSFORM_PARAM_LENGTH,
    {
      // A fixed literal, naming no partner value: the offending step and param
      // are located by the issue path (linkageKeys[i].elements[j].transform[k]
      // .params.<name>), which describeDecodeError escapes segment by segment.
      message: `a linkage key element transform param must not exceed ${MAX_TRANSFORM_PARAM_LENGTH} characters`,
    },
  );

// Not annotated as ZodType<TransformStep> because the concrete ZodObject is the
// base the pad_left refine below chains onto (mirrors LinkageTermsBaseSchema).
const TransformStepBaseSchema = z.object({
  function: z.string().min(1).max(MAX_NAME_LENGTH),
  // The record's keys (parameter names) are length-bounded like every other
  // free-text string, and each string value is length-bounded by
  // TransformParamValueSchema above. The entry count is bounded at
  // MAX_PARAMS_ENTRIES by a bare key count (exceedsOwnKeyCount) that runs
  // before the per-key length check -- the same permissive-stage +
  // count-refine + pipe shape as boundedArray, so an over-count record is
  // rejected for the cost of one key enumeration rather than a per-key Zod
  // parse. Full reasoning: docs/spec/CHANNEL_SECURITY.md, "Application-layer
  // parsed-input bounds".
  params: z
    .unknown()
    .refine(
      (rec) =>
        rec === null ||
        typeof rec !== "object" ||
        Array.isArray(rec) ||
        !exceedsOwnKeyCount(rec, MAX_PARAMS_ENTRIES),
      {
        message: `transform params must not exceed ${MAX_PARAMS_ENTRIES} entries`,
        abort: true,
      },
    )
    .pipe(z.record(z.string().max(MAX_NAME_LENGTH), TransformParamValueSchema))
    .optional(),
});

// Per-function content bounds, stricter than the uniform string bound every
// param value already has (TransformParamValueSchema), on values whose
// magnitude drives per-row work in a shape a string length does not
// describe: a number, a per-row regex build, and a compile source read off a
// value of any type. Each is a per-step refine on this wire schema -- not on
// the editor descriptor an attacker-authored token never passes through --
// and each message names no partner value. Full reasoning:
// docs/spec/CHANNEL_SECURITY.md, "Unbounded transform-parameter rejection".
const TransformStepSchema: z.ZodType<TransformStep> = TransformStepBaseSchema
  // `pad_left` runs per row in the key-building pipeline
  // (applyElementTransform, driven by buildKeyStrings), so an unbounded
  // `length` makes every row allocate a `padStart` of that size. Only a
  // positive-integer `length` ever reaches it (padLeftFactory throws on any
  // other value before allocating); a malformed `length` is left to that
  // runtime check. Full reasoning: docs/spec/CHANNEL_SECURITY.md,
  // "Unbounded transform-parameter rejection".
  .refine(
    (step) => {
      if (step.function !== "pad_left") return true;
      const length = step.params?.length;
      return (
        typeof length !== "number" ||
        !Number.isInteger(length) ||
        length <= MAX_PAD_LEFT_LENGTH
      );
    },
    {
      message: `pad_left length must not exceed ${MAX_PAD_LEFT_LENGTH}`,
      path: ["params", "length"],
    },
  )
  // `parse_date` builds a regex from `inputFormat` and assembles its result
  // from `outputFormat`, both recompiled per row -- an unbounded value
  // drives an ever-larger regex or per-row output. Only a string value
  // drives either; a non-string is left to the factory's own
  // empty/absent-format fallback. The catastrophic-backtracking risk in the
  // expanded regex is closed by the linear-time engine (standardization.ts),
  // not by this cap. Full reasoning: docs/spec/CHANNEL_SECURITY.md,
  // "Unbounded transform-parameter rejection".
  .refine(
    (step) => {
      if (step.function !== "parse_date") return true;
      const { inputFormat, outputFormat } = step.params ?? {};
      return (
        (typeof inputFormat !== "string" ||
          inputFormat.length <= MAX_DATE_FORMAT_LENGTH) &&
        (typeof outputFormat !== "string" ||
          outputFormat.length <= MAX_DATE_FORMAT_LENGTH)
      );
    },
    {
      message: `parse_date inputFormat and outputFormat must not exceed ${MAX_DATE_FORMAT_LENGTH} characters`,
      path: ["params"],
    },
  )
  // An EMPTY `outputFormat` renders every date to the empty string -- the
  // one width-shaping param that can settle a derived width of zero, where
  // `substring`/`pad_left` derive theirs from a positive integer length and
  // `phonetic` from a fixed code length (elementValueWidthBound,
  // keyElementWidth.ts). A zero declares a key narrower than the single
  // candidate the row builder emits for it, so an honest row would be
  // refused at the width bound over a step the PARTNER authored. No honest
  // template declares a date that renders to nothing.
  .refine(
    (step) => {
      if (step.function !== "parse_date") return true;
      const { outputFormat } = step.params ?? {};
      return typeof outputFormat !== "string" || outputFormat.length > 0;
    },
    {
      message:
        "parse_date outputFormat must not be empty: it would render every " +
        "date to the empty string",
      path: ["params", "outputFormat"],
    },
  )
  // The four `tier: "regex"` functions compile their raw `pattern` /
  // `delimiter` under the linear-time engine, which bounds backtracking by
  // construction; this length cap is the orthogonal source-length
  // compile-cost bound (applyElementTransform compiles each step once per
  // distinct transform array, memoized). It measures the COERCED source the
  // factory actually compiles (coerceToPatternString), not the raw value, so
  // an array param cannot slip an oversized source past it. Dialect
  // conformance is enforced separately on LinkageTermsSchema. Full
  // reasoning: docs/spec/CHANNEL_SECURITY.md, "Transform-regex linear-time
  // dialect".
  .refine(
    (step) => {
      const paramKey = REGEX_STEP_PATTERN_PARAM[step.function];
      if (paramKey === undefined) return true;
      const value = step.params?.[paramKey];
      if (value === undefined) return true;
      return (
        coerceToPatternString(value).length <= MAX_TRANSFORM_PATTERN_LENGTH
      );
    },
    {
      message: `transform regex pattern must not exceed ${MAX_TRANSFORM_PATTERN_LENGTH} characters`,
      path: ["params"],
    },
  )
  // `substring` slices by numeric `start` / `length`. A non-integer bound
  // never slices as intended (substringFactory drops it to an all-null fn,
  // silently excluding every row), so a present non-integer bound is
  // rejected at parse. An ABSENT bound drops every row the same way and is
  // admitted here by design: it is refused one layer up, by the
  // dead-pipeline grading (`pipelineAlwaysDrops` via
  // `substringWindowDropsEveryValue`), which locates the offender by key
  // rather than costing the whole document its parse.
  .refine(
    (step) => {
      if (step.function !== "substring") return true;
      const { start, length } = step.params ?? {};
      return (
        (start === undefined || Number.isInteger(start)) &&
        (length === undefined || Number.isInteger(length))
      );
    },
    {
      message: "substring start and length must be integers",
      path: ["params"],
    },
  );

/**
 * A single element of a linkage key. References a linkage field by name and
 * optionally applies transformations to its standardized value before
 * concatenation.
 */
export interface LinkageKeyElement {
  /** Name of the linkage field this element is derived from. */
  field: string;
  /**
   * Optional alias for this element within the key; used when the same field
   * appears more than once, or as the target of a `swap`.
   */
  name?: string;
  /**
   * Expands a single value into multiple candidates before hashing.
   * - `transpositions`: all two-digit transpositions.
   * - `edit_distances`: all single-character deletions, matching values
   *   within one edit distance.
   * - `adjacent_years`: +/- 1 year from the date.
   */
  generateFuzzyComparisons?: GenerateFuzzyComparisons;
  /**
   * Transformations applied in order to the canonical field value before it
   * is concatenated into the key.
   */
  transform?: TransformStep[];
}

const LinkageKeyElementSchema: z.ZodType<LinkageKeyElement> = z.object({
  field: z.string().min(1).max(MAX_NAME_LENGTH),
  name: z.string().max(MAX_NAME_LENGTH).optional(),
  generateFuzzyComparisons: GenerateFuzzyComparisonsSchema.optional(),
  // The step COUNT is bounded at MAX_TRANSFORM_STEPS before per-element
  // validation; see boundedArray and the untrusted-input bounds note.
  transform: boundedArray(
    TransformStepSchema,
    MAX_TRANSFORM_STEPS,
    `transform must not exceed ${MAX_TRANSFORM_STEPS} steps`,
  ).optional(),
});

// --- Linkage keys ------------------------------------------------------------

/**
 * A single linkage key: one round of matching with PSI. Keys should be ordered
 * from most to least precise.
 *
 * When `swap` is present it names two elements (by element `name` or `field`
 * name) that the receiver swaps when building this key; the sender uses the
 * un-swapped order. This catches data entry errors where names are reversed.
 * Under `APPLIED_SETTINGS.fuzzyComparisons` the receiver builds BOTH orders, so
 * the key matches its two elements in either arrangement while the sender still
 * builds one (docs/notes/one-sided-fuzzy-expansion.md).
 */
export interface LinkageKey {
  name: string;
  /** Ordered list of field-derived elements combined to form the key. */
  elements: LinkageKeyElement[];
  /**
   * Two element identifiers (element `name` or `field` name) the receiver
   * swaps; sender uses un-swapped order.
   */
  swap?: [string, string];
}

const LinkageKeySchema: z.ZodType<LinkageKey> = z.object({
  name: z.string().min(1).max(MAX_NAME_LENGTH),
  // The element COUNT is bounded at MAX_KEY_ELEMENTS before per-element
  // validation, with the existing .min(1) floor preserved; see boundedArray and
  // the untrusted-input bounds note.
  elements: boundedArray(
    LinkageKeyElementSchema,
    MAX_KEY_ELEMENTS,
    `elements must not exceed ${MAX_KEY_ELEMENTS} entries`,
    1,
  ),
  swap: z
    .tuple([z.string().max(MAX_NAME_LENGTH), z.string().max(MAX_NAME_LENGTH)])
    .optional(),
});

/**
 * The set of linkage-field names referenced by at least one element of
 * `linkageKeys` -- the union of every element's `field`. The exchange
 * standardizes and consumes exactly these fields, so the constraint sweep,
 * the default-terms field derivation, and the advanced-invite field
 * derivation all filter declared linkage fields down to this set.
 *
 * DISCLOSURE-RELEVANT: the default-terms and advanced-invite derivations use
 * the result to choose which `linkageFields` enter the constructed terms,
 * and so the cross-party terms hash. Preserve the exact membership -- in the
 * security-review scope.
 *
 * `swap` does not widen this set: it only permutes `field` among a key's
 * existing elements at receive time, so the union over the authored,
 * un-swapped elements already names every field a swapped order could
 * reference.
 *
 * The UNION, distinct from the per-key satisfiability predicate
 * ({@link LinkageTermsSchema}'s referential-integrity refine). A name here
 * for a terms object built outside that schema may not be a declared field;
 * as a membership filter, such a stray name is harmless.
 */
export function referencedLinkageFieldNames(
  linkageKeys: readonly LinkageKey[],
): Set<string> {
  return new Set(
    linkageKeys.flatMap((key) => key.elements.map((e) => e.field)),
  );
}

// --- Payload -----------------------------------------------------------------

export interface PayloadColumn {
  /** Column name in the output. */
  name: string;
  /**
   * Human-readable description shared with the partner as a data dictionary
   * entry.
   */
  description?: string;
}

const PayloadColumnSchema: z.ZodType<PayloadColumn> = z.object({
  name: z.string().min(1).max(MAX_NAME_LENGTH),
  description: freeTextValue(z.string().max(MAX_TEXT_LENGTH)).optional(),
});

/**
 * Additional data columns transmitted after the intersection is identified,
 * over the established encrypted channel. Each party independently specifies
 * their own send/receive lists; the partner's send list is shared as a data
 * dictionary.
 */
export interface Payload {
  /** Columns this party will transmit for matched records. */
  send?: PayloadColumn[];
  /**
   * Columns this party expects to receive from the partner for matched
   * records. Must be empty when `output.expectsOutput` is false (rejected at
   * parse time): a party that receives no output gets no matched records to
   * attach payload to.
   */
  receive?: PayloadColumn[];
}

const PayloadSchema: z.ZodType<Payload> = z.object({
  // The column COUNT is bounded at MAX_PAYLOAD_ENTRIES before per-element
  // validation; see boundedArray and docs/spec/CHANNEL_SECURITY.md,
  // "Application-layer parsed-input bounds".
  send: boundedArray(
    PayloadColumnSchema,
    MAX_PAYLOAD_ENTRIES,
    `send must not exceed ${MAX_PAYLOAD_ENTRIES} entries`,
  ).optional(),
  receive: boundedArray(
    PayloadColumnSchema,
    MAX_PAYLOAD_ENTRIES,
    `receive must not exceed ${MAX_PAYLOAD_ENTRIES} entries`,
  ).optional(),
});

// --- Legal agreement ---------------------------------------------------------

/**
 * Reference to the legal data-sharing agreement authorizing this exchange.
 * The two parties' `reference`, `purpose`, and `expirationDate` are all
 * cross-checked: any mismatch, or an `expirationDate` that has passed, fails
 * the exchange before any data is transmitted.
 */
interface LegalAgreement {
  /** Identifier of the legal agreement (e.g. "MOU-2025-0042"). */
  reference: string;
  /**
   * Readable statement of the purpose or authority for the disclosure under
   * this agreement (e.g. "Audit and evaluation of the State tutoring
   * program"). A single agreement can authorize multiple purposes; this names
   * the one this exchange happened for. Recorded in cleartext in the
   * exchange record so it stands alone as a HIPAA 164.528 accounting /
   * FERPA 99.32 disclosure-log entry without opening the agreement.
   * Metadata only -- never a protected, linkage-field, or payload value.
   */
  purpose: string;
  /** Date after which the exchange will be refused (ISO 8601, YYYY-MM-DD). */
  expirationDate: string;
}

const LegalAgreementSchema: z.ZodType<LegalAgreement> = z.object({
  reference: z.string().min(1).max(MAX_NAME_LENGTH),
  purpose: freeTextValue(z.string().min(1).max(MAX_TEXT_LENGTH)),
  expirationDate: z.iso.date(),
});

// --- Linkage strategy --------------------------------------------------------

/**
 * How the agreed linkage keys are matched between the two parties' records. Both
 * strategies produce the SAME result; they differ only in how the per-key
 * matching is sequenced over the network.
 *
 * - `cascade` (the default) -- the keys are matched one at a time, each round
 *   building on the results of the one before. More network round-trips.
 * - `single-pass` -- all keys are sent together in a single round-trip; the
 *   receiver then reproduces the same step-by-step result locally. Far fewer
 *   round-trips.
 *
 * See docs/spec/PROTOCOL.md for the wire format and the disclosure each involves.
 */
export type LinkageStrategy = "cascade" | "single-pass";

export const LinkageStrategySchema: z.ZodType<LinkageStrategy> = z.enum([
  "cascade",
  "single-pass",
]);

// --- Linkage rule set --------------------------------------------------------

/**
 * A named, versioned artifact the linkage rules were drawn from: one half of a
 * {@link LinkageRuleSetReference}.
 *
 * The `version` versions the CONTENT of the named artifact and moves
 * independently of `LinkageTerms.version`, which versions the terms document's
 * SCHEMA. The two are unrelated and happen to start at the same value.
 */
export interface LinkageSetIdentity {
  /** Stable identifier of the set (e.g. `baseline-pii`). */
  name: string;
  /** Semver string versioning the set's content (e.g. `1.0.0`). */
  version: string;
}

const LinkageSetIdentitySchema: z.ZodType<LinkageSetIdentity> = z.object({
  name: z.string().min(1).max(MAX_NAME_LENGTH),
  version: z
    .string()
    .max(MAX_NAME_LENGTH)
    .regex(/^\d+\.\d+\.\d+$/, "version must be a valid semver string"),
});

/**
 * Which named rule set the linkage fields and keys of a terms document were
 * drawn from. The fields and keys are separately named and versioned: the
 * fields are a generic substrate (which PII is matched on and how each
 * element is cleaned), the keys are specific (which combinations count as a
 * match, and in what cascade order).
 *
 * A citation, not a specification: the fields and keys a run actually
 * matched on are the terms document's own `linkageFields` and
 * `linkageKeys`, which travel with the exchange and are compared whole. A
 * reference derived from an input file that leaves out a key is an upper
 * bound on what was tried, not an account of what ran.
 *
 * Optional throughout: terms whose rules were authored rather than drawn
 * from a named set have no reference; the absence is the honest statement,
 * not a default.
 */
export interface LinkageRuleSetReference {
  /** The set the `linkageFields` were drawn from. */
  fieldSet: LinkageSetIdentity;
  /** The set the `linkageKeys` were drawn from. */
  keySet: LinkageSetIdentity;
}

const LinkageRuleSetReferenceSchema: z.ZodType<LinkageRuleSetReference> =
  z.object({
    fieldSet: LinkageSetIdentitySchema,
    keySet: LinkageSetIdentitySchema,
  });

// --- Linkage Terms -----------------------------------------------------------

/**
 * The complete set of linkage terms for one party. Each party holds their own
 * copy; after authentication both parties swap copies and verify that all
 * mandatory fields are consistent. A mismatch on a mandatory field cancels the
 * exchange; a mismatch on a soft field (currently only `date`) produces a
 * warning and an updated set of terms being output.
 *
 * Fields and their consistency requirements:
 * - `version` -- mandatory. Two versions are incompatible if no migration path
 *   exists.
 * - `identity` -- none, and optional. Free-text identifying the holding party;
 *   recorded in the exchange record (the disclosure log). A party that supplied
 *   no name omits it, and every surface reads that absence as a party that did
 *   not name itself rather than substituting one.
 * - `date` -- soft. A mismatch warns that one party may have a stale copy.
 * - `algorithm` -- mandatory. `psi` reveals matched identifiers; `psi-c` reveals
 *   only the count.
 * - `linkageStrategy` -- mandatory. `cascade` (the default) or `single-pass`;
 *   both produce the same output.
 * - `output` -- mandatory.
 * - `deduplicate` -- mandatory. Per-party; determines if multiple inputs can be
 *   matched to the same output.
 * - `linkageFields` -- mandatory.
 * - `linkageKeys` -- mandatory.
 * - `linkageRuleSet` -- mandatory if BOTH parties declare one; a party that
 *   declares none is not held to the other's citation.
 * - `legalAgreement` -- mandatory if present. The `reference`, `purpose`, and
 *   `expirationDate` are cross-checked; any mismatch, or an `expirationDate`
 *   that has passed, cancels the exchange.
 * - `payload` -- mandatory if present.
 *
 * Constraints:
 * - `deduplicate: true` requires `output.expectsOutput: true`.
 * - `output.expectsOutput: false` requires `payload.receive` to be empty: a
 *   party that receives no output cannot receive payload for matched records it
 *   never gets.
 * - `linkageFields[].name` must be unique across all linkage fields.
 * - `linkageKeys[].name` must be unique across all linkage keys.
 * - Within each linkage key, the effective element identifier (`element.name`
 *   if present, otherwise `element.field`) must be unique so that `swap`
 *   references are unambiguous.
 * - Every linkage-key element `field` must name a declared linkage field (a
 *   member of `linkageFields[].name`); a dangling reference is rejected.
 * - Every `swap` target must match an element identifier (`element.name` if
 *   present, otherwise `element.field`) present within that same linkage key.
 * - The two elements a `swap` names must declare the same
 *   `generateFuzzyComparisons` and the same `transform`, both staying with the
 *   position while the swap moves the field reference.
 *
 * TODO: versioning compatibility rules (migration paths between semver
 * versions).
 */
export interface LinkageTerms {
  /**
   * Semver string identifying the schema version. Compatibility is checked at
   * exchange time.
   */
  version: string;
  /**
   * Free-text string identifying the party holding these linkage terms (e.g.
   * name organization, contact info). Included verbatim in the exchange
   * record.
   *
   * Absent when the party supplied no name: psilink invents none, so nothing
   * fills the gap and no surface stands a label in it (`partyIdentityDisplay.ts`
   * holds the marker every surface shows instead). The commands that
   * author a durable partnership -- `psilink invite` and `psilink accept` --
   * require one at their own interface, so the field is absent only on a run
   * that authored its terms without a name.
   *
   * Consistency: none -- parties may differ, and either may have none.
   */
  identity?: string;
  /**
   * Date these linkage terms were last modified (ISO 8601, YYYY-MM-DD).
   * Consistency: soft -- a mismatch warns rather than cancels the exchange.
   */
  date: string;
  /** `psi` reveals matched identifiers; `psi-c` reveals only the count. */
  algorithm: Algorithm;
  /**
   * How the agreed linkage keys are exchanged; see {@link LinkageStrategy}.
   * Consistency: mandatory -- a mismatch aborts the exchange. The input may omit
   * it; the schema defaults it to `cascade`.
   */
  linkageStrategy: LinkageStrategy;
  output: Output;
  /**
   * Whether SEVERAL of this party's records may match the SAME partner record --
   * this party is the "many" side of the resolved cardinality, deduplicating its
   * own inputs by using the partner's data to group them (docs/spec/PROTOCOL.md,
   * Deduplicating cardinalities).
   * Consistency: none -- each party declares its own side, and the pair resolves
   * the cardinality.
   */
  deduplicate: boolean;
  /**
   * Standardized form of each PII element that participates in linkage. Linkage
   * key elements and cleaning pipeline outputs reference these fields by name.
   * Consistency: mandatory.
   */
  linkageFields: LinkageField[];
  /**
   * Ordered list of linkage keys applied in sequence, most to least precise.
   * Consistency: mandatory.
   */
  linkageKeys: LinkageKey[];
  /**
   * The named rule set the `linkageFields` and `linkageKeys` above were drawn
   * from; see {@link LinkageRuleSetReference}. Absent when the rules were
   * authored rather than drawn from a named set.
   * Consistency: mandatory between two parties that BOTH declare one -- a
   * disagreement about which rules ran is refused rather than recorded twice
   * over -- and skipped where either declares none, which is what lets a party
   * running hand-authored rules exchange with one running a named set whose
   * fields and keys its own document matches.
   */
  linkageRuleSet?: LinkageRuleSetReference;
  payload?: Payload;
  legalAgreement?: LegalAgreement;
}

// LinkageTermsBaseSchema is not annotated as ZodType<LinkageTerms>
// because the concrete ZodObject type is needed to chain .refine().
const LinkageTermsBaseSchema = z.object({
  version: z
    .string()
    .max(MAX_NAME_LENGTH)
    .regex(/^\d+\.\d+\.\d+$/, "version must be a valid semver string"),
  // Optional, and bounded where it is present: a party that names itself is held
  // to a non-empty, length-capped, control-character-free label, and a party that
  // supplies none omits the field rather than sending an empty string or a
  // placeholder.
  identity: freeTextValue(z.string().min(1).max(MAX_TEXT_LENGTH)).optional(),
  date: z.iso.date(),
  algorithm: AlgorithmSchema,
  linkageStrategy: LinkageStrategySchema.default("cascade"),
  output: OutputSchema,
  deduplicate: z.boolean(),
  // Element COUNT bounded at MAX_LINKAGE_ENTRIES before per-element
  // validation, with the existing .min(1) floor preserved. A plain .max() is
  // insufficient here: these flat top-level arrays sit directly below the
  // root, so a pathological count does not overflow the call stack, but
  // still throws building the error string from one issue per invalid
  // entry. See boundedArray and docs/spec/CHANNEL_SECURITY.md,
  // "Application-layer parsed-input bounds".
  linkageFields: boundedArray(
    LinkageFieldSchema,
    MAX_LINKAGE_ENTRIES,
    `linkageFields must not exceed ${MAX_LINKAGE_ENTRIES} entries`,
    1,
  ),
  linkageKeys: boundedArray(
    LinkageKeySchema,
    MAX_LINKAGE_ENTRIES,
    `linkageKeys must not exceed ${MAX_LINKAGE_ENTRIES} entries`,
    1,
  ),
  linkageRuleSet: LinkageRuleSetReferenceSchema.optional(),
  payload: PayloadSchema.optional(),
  legalAgreement: LegalAgreementSchema.optional(),
});

export const LinkageTermsSchema: z.ZodType<LinkageTerms> =
  LinkageTermsBaseSchema.refine(
    (a) => !a.deduplicate || a.output.expectsOutput,
    {
      message: "expectsOutput must be true when deduplicate is true",
      path: ["output", "expectsOutput"],
    },
  )
    // A party that receives no output cannot receive payload columns: payload is
    // attached to matched records, which a non-receiving party never gets. Reject
    // expectsOutput:false alongside a non-empty payload.receive as an incoherent
    // configuration, so a one-sided exchange cannot produce a record that claims a
    // party received payload it was never entitled to.
    .refine(
      (a) => a.output.expectsOutput || (a.payload?.receive?.length ?? 0) === 0,
      {
        message:
          "payload.receive must be empty when expectsOutput is false: a party " +
          "that receives no output cannot receive payload columns for matched " +
          "records it never gets",
        path: ["payload", "receive"],
      },
    )
    .refine(
      (a) => {
        const names = a.linkageFields.map((f) => f.name);
        return names.length === new Set(names).size;
      },
      {
        message: "linkage field names must be unique",
        path: ["linkageFields"],
      },
    )
    .refine(
      (a) => {
        const names = a.linkageKeys.map((k) => k.name);
        return names.length === new Set(names).size;
      },
      { message: "linkage key names must be unique", path: ["linkageKeys"] },
    )
    .refine(
      (a) =>
        a.linkageKeys.every((key) => {
          const ids = key.elements.map((el) => el.name ?? el.field);
          return ids.length === new Set(ids).size;
        }),
      {
        message:
          "element identifiers (name if present, otherwise field) must be " +
          "unique within each linkage key",
        path: ["linkageKeys"],
      },
    )
    // Referential integrity, element field -> declared linkage field. Every
    // key element's `field` must name a member of linkageFields[].name. A
    // dangling field reference parses cleanly but resolves to no values at
    // exchange time (buildStandardizedDataset builds only declared fields),
    // producing a silent empty/missed-match result indistinguishable from a
    // legitimately empty intersection. The message names no partner value:
    // the offending element is located by its issue `path`, not by echoing
    // its raw field string.
    .refine(
      (a) => {
        const declared = new Set(a.linkageFields.map((f) => f.name));
        return a.linkageKeys.every((key) =>
          key.elements.every((el) => declared.has(el.field)),
        );
      },
      {
        message:
          "each linkage key element must reference a declared linkage field " +
          "(a name in linkageFields)",
        path: ["linkageKeys"],
      },
    )
    // Referential integrity, swap target -> element within the same key. Each
    // `swap` entry must match an element identifier (name if present, otherwise
    // field) present in that same key, matching the within-key resolution the
    // LinkageKey doc comment describes. A dangling swap target silently no-ops
    // at exchange time. Element identity uses `el.name ?? el.field`, the same
    // expression as the element-identifier-uniqueness refine above, so the two
    // checks agree. As above, the message echoes no partner-controlled value.
    .refine(
      (a) =>
        a.linkageKeys.every((key) => {
          if (key.swap === undefined) return true;
          const ids = new Set(key.elements.map((el) => el.name ?? el.field));
          return key.swap.every((target) => ids.has(target));
        }),
      {
        message:
          "each linkage key swap target must match an element identifier " +
          "(name if present, otherwise field) within the same key",
        path: ["linkageKeys"],
      },
    )
    // A swap pair's two positions must declare the SAME fuzzy expansion. The
    // swap moves only the field references and leaves each position's own
    // `generateFuzzyComparisons` where it is, so a mismatched pair would
    // apply one expansion to a column on the party that swaps and a
    // different one on the party that does not. Binding the pair here is
    // what lets the key-read layer resolve the expansion from the position
    // it already holds (`planFuzzyExpansions`, standardization.ts).
    .refine((a) => !a.linkageKeys.some(swapPairFuzzyComparisonsDiffer), {
      message:
        "the two elements a linkage key swap names must declare the same " +
        "generate_fuzzy_comparisons: a swap moves the field references and " +
        "leaves each element's own expansion in place, so a mismatched pair " +
        "would expand a column differently on the two parties",
      path: ["linkageKeys"],
    })
    // The sibling rule to the expansion refine above, on the swap pair's other
    // position-bound attribute; the rationale lives on swapPairTransformsDiffer.
    // As above, the message echoes no partner-controlled value.
    .refine((a) => !a.linkageKeys.some(swapPairTransformsDiffer), {
      message:
        "the two elements a linkage key swap names must declare the same " +
        "transform: a swap moves the field references and leaves each " +
        "element's own transform in place, so a mismatched pair would " +
        "transform a column differently on the two parties",
      path: ["linkageKeys"],
    })
    // Reject a transform regex outside the linear-time dialect before it can
    // run. Element-transform regex patterns are partner-controlled and
    // execute per row over the full dataset under the linear-time engine
    // (utils/linearRegex.ts), so they cannot backtrack catastrophically;
    // this rejects a pattern that engine cannot compile -- fail closed,
    // before any execution and before both parties commit to terms they
    // could not evaluate identically. Covers every parse path
    // (parseLinkageTerms, invitation-token decode, ExchangeSpecSchema). Full
    // reasoning: docs/spec/CHANNEL_SECURITY.md, "Transform-regex
    // linear-time dialect".
    .refine(
      (a) =>
        !linkageTermsHaveNonConformantTransformRegex(a, {
          maxPatternLength: MAX_TRANSFORM_PATTERN_LENGTH,
        }),
      {
        message:
          "a linkage key element transform uses a regular expression outside the " +
          "linear-time dialect (RE2 syntax; backreferences and lookaround are not " +
          "supported); it is rejected before any pattern executes",
        path: ["linkageKeys"],
      },
    )
    // The count-only shape, one refine per rule so a document breaking one
    // is located by its own issue path and answered by its own message. The
    // rules are docs/spec/PROTOCOL.md, PSI-C; placed here so EVERY parse
    // path refuses -- parseLinkageTerms, the invitation-token decode, and
    // ExchangeSpecSchema. The verdict comes from the one shared reading
    // (countOnlyShapeViolation) rather than a second copy of the rule, so
    // schema and asserts cannot diverge.
    .refine((a) => countOnlyShapeViolation(a) !== "linkageKeys", {
      message: COUNT_ONLY_SHAPE_REFUSALS.linkageKeys,
      path: ["linkageKeys"],
    })
    .refine((a) => countOnlyShapeViolation(a) !== "linkageStrategy", {
      message: COUNT_ONLY_SHAPE_REFUSALS.linkageStrategy,
      path: ["linkageStrategy"],
    })
    .refine((a) => countOnlyShapeViolation(a) !== "deduplicate", {
      message: COUNT_ONLY_SHAPE_REFUSALS.deduplicate,
      path: ["deduplicate"],
    })
    .refine((a) => countOnlyShapeViolation(a) !== "payload", {
      message: COUNT_ONLY_SHAPE_REFUSALS.payload,
      path: ["payload"],
    })
    // Refuse an ill-formed UTF-16 string anywhere in the document. The terms
    // are canonically encoded WHOLE -- by validateCompatibility and by
    // computeTermsHash, which runs after the exchange has disclosed -- and
    // RFC 8785 requires an encoder to terminate on a lone surrogate, so a
    // document admitted here ends the run with neither a receipt nor the
    // record of that disclosure. Every parse path inherits it, and a document
    // too deeply nested for the walk to finish is refused under its own
    // message. Full reasoning: docs/spec/CANONICAL_ENCODING.md, "Strings".
    .superRefine((terms, ctx) => {
      const refusal = firstWellFormednessRefusal(terms, [], 0);
      if (refusal !== undefined)
        ctx.addIssue({
          code: "custom",
          message:
            refusal.reason === "lone-surrogate"
              ? LONE_SURROGATE_MESSAGE
              : NESTING_DEPTH_MESSAGE,
          path: refusal.path,
        });
    });

// --- Parse -------------------------------------------------------------------

/**
 * Keys whose object value the camelize pre-pass leaves verbatim once its key
 * count exceeds the bound, rather than rewriting every key (see
 * {@link camelizeKeys}). Only `transform.params` is partner-controlled and
 * key-count-bounded; the bound matches {@link MAX_PARAMS_ENTRIES}, so any
 * record left verbatim here is one the schema also rejects. Full reasoning:
 * docs/spec/CHANNEL_SECURITY.md, "Application-layer parsed-input bounds".
 */
const PARAMS_WIDTH_BOUND: ReadonlyMap<string, number> = new Map([
  ["params", MAX_PARAMS_ENTRIES],
]);

/**
 * Parse and validate a raw value as an {@link LinkageTerms}.
 * Snake_case keys in the input are converted to camelCase before validation,
 * so JSON/YAML from disk can be passed directly.
 *
 * @throws {ZodError} if validation fails.
 */
export function parseLinkageTerms(raw: unknown): LinkageTerms {
  return LinkageTermsSchema.parse(camelizeKeys(raw, PARAMS_WIDTH_BOUND));
}

/**
 * Non-throwing version of {@link parseLinkageTerms}.
 * Returns a Zod `SafeParseReturnType` with `success` and either `data` or
 * `error`. Honors the "safe" contract for the {@link camelizeKeys} bounds too:
 * a depth- or node-count-tripping input yields a `{ success: false }` result
 * rather than throwing (see {@link safeParseCamelized}).
 */
export function safeParseLinkageTerms(raw: unknown) {
  return safeParseCamelized(LinkageTermsSchema, raw, PARAMS_WIDTH_BOUND);
}

// The invitation decode path needs the same camelize-before-validate pre-pass
// over its linkage-terms field, but builds it from the exported LinkageTermsSchema
// and PARAMS_WIDTH_BOUND's width bound (MAX_PARAMS_ENTRIES) at its own module
// rather than here -- a throwing z.preprocess kept off this file's wholesale
// public export, so no external caller can reach a schema whose `.safeParse()`
// would throw the camelize bounds. See the invitationLinkageTermsSchema note in
// config/invitation.ts.
