import { z } from "zod";
import { AlgorithmSchema } from "../types.js";
import { UsageError } from "../errors.js";
import type { Algorithm } from "../types.js";
import { camelizeKeys } from "../utils/camelizeKeys.js";
import { safeParseCamelized } from "./safeParseCamelized.js";
import { canonicalString, CanonicalEncodingError } from "../utils/canonical.js";
import { redactAndSanitizeForDisplay } from "../utils/sanitizeErrorForDisplay.js";
import { boundedArray } from "../utils/boundedArray.js";
import {
  bareTermsValue,
  compatibilityMessage,
  quoteTermsValue,
  quoteTermsValueList,
  ruleSetCitation,
} from "./compatibilityMessage.js";
import type { CompatibilityMessageFragment } from "./compatibilityMessage.js";
import {
  coerceToPatternString,
  patternConformsToDialect,
} from "../utils/linearRegex.js";
import {
  linkageTermsHaveNonConformantTransformRegex,
  REGEX_STEP_PATTERN_PARAM,
} from "./transformRegexDialect.js";
import { exceedsOwnKeyCount } from "../utils/objectKeyCount.js";

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
 * label (`IDENTITY_CONTROL_CHAR_PATTERN`, apps/web/src/psi/identityLabel.ts,
 * held equal by apps/web/test/unit/identityLabelParity.test.ts) and is
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

interface PayloadColumn {
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

/**
 * A rule-set reference as one readable clause, keys first: the keys are the
 * specific artifact and the fields the substrate they are built from, so a
 * reader meets the narrower claim before the broader one.
 *
 * Each half renders through {@link ruleSetCitation}, which supplies the
 * shared grammar for the pair, so a name holding a space, this clause's own
 * " over ", or a delimiter of its own is treated as content of one value
 * rather than as structure the clause asserted.
 */
function describeRuleSet(
  reference: LinkageRuleSetReference,
): CompatibilityMessageFragment {
  return compatibilityMessage`${ruleSetCitation(reference.keySet.name, reference.keySet.version)} over ${ruleSetCitation(reference.fieldSet.name, reference.fieldSet.version)}`;
}

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

// --- Count-only (psi-c) shape ------------------------------------------------

/**
 * Which of the count-only shape rules a `psi-c` terms document breaks. The
 * rules this document holds only: the fifth refusal the specification lists
 * reads this party's own INPUT METADATA, which no linkage-terms document
 * holds, and lives beside the disclosure predicate it asks
 * ({@link countOnlyTransmitsColumn}, `config/metadata.ts`).
 */
export type CountOnlyShapeViolation =
  "linkageKeys" | "linkageStrategy" | "deduplicate" | "payload";

/**
 * The refusal message for each count-only shape rule, keyed by the rule
 * broken. Read by every enforcement point -- the {@link LinkageTermsSchema}
 * refines below, {@link assertCountOnlyTermsShape}, and the surfaces' own
 * gates -- so an operator meets the same account wherever the document is
 * stopped.
 *
 * Each message names the rule broken and the two ways out: bring the
 * document into the count-only shape, or ask for the identifier-revealing
 * algorithm that admits it. Fixed literals only, never a value read off the
 * document -- a `psi-c` document can arrive on a partner's invitation, and
 * the parse-error path is left unsanitized (see protocolSetup).
 *
 * The rules and the reasoning behind each: docs/spec/PROTOCOL.md, PSI-C.
 */
export const COUNT_ONLY_SHAPE_REFUSALS: Readonly<
  Record<CountOnlyShapeViolation | "transmittedColumns", string>
> = {
  linkageKeys:
    'count-only ("psi-c") linkage terms must declare exactly one linkage ' +
    "key: a count-only exchange is one PSI round over one key, and a " +
    "multi-key count is not specified, so these terms are refused rather " +
    "than narrowed to the first key. Declare a single linkage key, or set " +
    'the algorithm to "psi" to match on several.',
  linkageStrategy:
    'count-only ("psi-c") linkage terms must set the linkage strategy to ' +
    '"cascade": no count-only single-pass round is specified, so these ' +
    "terms are refused rather than run under a strategy neither party " +
    'agreed to. Set the linkage strategy to "cascade", or set the algorithm ' +
    'to "psi".',
  deduplicate:
    'count-only ("psi-c") linkage terms must set deduplicate to false: a ' +
    "count-only exchange reports the size of the intersection and hands " +
    "neither party a record-by-record pairing, so there is no matching " +
    "multiplicity for it to honor. Set deduplicate to false, or set the " +
    'algorithm to "psi".',
  payload:
    'count-only ("psi-c") linkage terms must declare no payload columns in ' +
    "either direction: a count-only exchange reveals the size of the " +
    "intersection and nothing else, so it sends no data column whichever " +
    "party the terms entitle to the count. Remove the payload send and " +
    'receive columns, or set the algorithm to "psi".',
  transmittedColumns:
    'a count-only ("psi-c") exchange transmits no data columns, but this ' +
    "input's metadata marks one or more columns to send to the partner. The " +
    "algorithm sends no payload in either direction, so the exchange is " +
    "refused rather than run over a disclosure it cannot make. Clear the " +
    'payload marking on those columns, or set the algorithm to "psi".',
};

/**
 * Which count-only shape rule a terms document breaks, or `undefined` when
 * it breaks none -- including for every `psi` document, which these rules
 * leave untouched.
 *
 * The single reading of the specified shape (docs/spec/PROTOCOL.md, PSI-C:
 * one key, one round, cascade only, no deduplication, no payload), so the
 * schema, the asserts, and the two front ends' own gates cannot come to
 * different verdicts. Order is the specification's listing order; a
 * document breaking several rules reports the first, and fixing it surfaces
 * the next.
 *
 * A document already in the specified shape is NOT a violation here: whether
 * the algorithm has a run path at all is `assertAlgorithmImplemented`'s
 * question, not this function's.
 */
export function countOnlyShapeViolation(
  terms: LinkageTerms,
): CountOnlyShapeViolation | undefined {
  if (terms.algorithm !== "psi-c") return undefined;
  if (terms.linkageKeys.length > 1) return "linkageKeys";
  if (terms.linkageStrategy !== "cascade") return "linkageStrategy";
  if (terms.deduplicate) return "deduplicate";
  if (
    (terms.payload?.send?.length ?? 0) > 0 ||
    (terms.payload?.receive?.length ?? 0) > 0
  )
    return "payload";
  return undefined;
}

/**
 * Refuse a `psi-c` terms document outside the shape the specification
 * admits, fail-closed: an over-broad count-only document is never narrowed
 * to one key, never promoted off `cascade`, and never downgraded to a `psi`
 * run -- narrowing or downgrading would deliver a disclosure the operator
 * did not agree to.
 *
 * Applied where a document is authored or minted, and again where a
 * received one is accepted ({@link deriveAcceptedLinkageTerms}); every PARSE
 * path inherits the same rules from {@link LinkageTermsSchema}'s refines, so
 * this is the boundary for a document built or mutated without a parse.
 *
 * Distinct from what `assertDeduplicateImplemented` and
 * `resolveLinkageCardinality` refuse: a count-only run reports a size and
 * hands neither party a record-by-record result, so there is no
 * multiplicity for those to reach.
 *
 * Plain {@link UsageError}, not an `OperatorConfigError`: on the accept side
 * these values are adopted verbatim from the partner's invitation, so the
 * fault is not unconditionally this operator's own. The messages hold only
 * fixed literals.
 */
export function assertCountOnlyTermsShape(terms: LinkageTerms): void {
  const violation = countOnlyShapeViolation(terms);
  if (violation === undefined) return;
  throw new UsageError(COUNT_ONLY_SHAPE_REFUSALS[violation]);
}

/**
 * Which linkage strategies realize a deduplicating match, one entry per
 * strategy. Both do: the cascade re-expands a match on a kept value across
 * the group in each round (`linkViaPSI`), and `single-pass` applies the same
 * per-side rules in the receiver's local replay over the index table it
 * already ships (`linkViaSinglePassPSI`).
 *
 * A total table over {@link LinkageStrategy} rather than a comparison
 * against one named strategy, so a strategy added to the union states its
 * own verdict here or the build fails -- neither the refusal below nor the
 * consent copy reading the same verdict can be left behind by an addition.
 * Typed `boolean` rather than the literal values so each reader's gate gives
 * a genuine runtime branch.
 *
 * @internal exported for the tests that drive its readers over every
 * strategy, here and in the web editor's own Generate gate.
 */
export const DEDUPLICATE_IMPLEMENTED_BY_STRATEGY: Record<
  LinkageStrategy,
  boolean
> = {
  cascade: true,
  "single-pass": true,
};

/**
 * Whether an exchange on `strategy` honors a `deduplicate: true` term.
 *
 * The one predicate behind both readers of that verdict:
 * {@link assertDeduplicateImplemented} refuses the pair it returns `false`
 * for, and the consent summary's `deduplicateApplied` withholds the
 * grouping disclosure copy on the same answer (`invitationSummary.ts`), so
 * the two cannot silently diverge.
 */
export function deduplicateIsImplementedForStrategy(
  strategy: LinkageStrategy,
): boolean {
  return DEDUPLICATE_IMPLEMENTED_BY_STRATEGY[strategy];
}

/**
 * Refuse a linkage-terms `deduplicate: true` the run cannot honor, before
 * any matching begins: the term under a linkage strategy that does not
 * match a deduplicating cardinality
 * ({@link deduplicateIsImplementedForStrategy}).
 *
 * Both shipped strategies match one today, so this refuses nothing an
 * operator can configure currently; it stays as the boundary a strategy
 * answering `false` in {@link DEDUPLICATE_IMPLEMENTED_BY_STRATEGY} is
 * stopped at. The combination that IS refused today is the agreed
 * `(true, true)` pair under a strategy that pairs no both-sided
 * cardinality, which this guard cannot express since it reads one party's
 * document alone -- its own boundary is
 * {@link assertBothSidedDeduplicateImplemented}.
 *
 * Applied where a document is authored or minted, where a received
 * invitation is accepted ({@link deriveAcceptedLinkageTerms}), and for both
 * parties' agreed terms by `resolveLinkageCardinality` after the terms
 * exchange, before the PSI rounds begin. The accept boundary is what keeps
 * a crafted pair off the consent surfaces.
 *
 * Reads the whole terms document rather than the two values, so a caller
 * cannot pass one party's `deduplicate` against the other's strategy.
 *
 * Plain {@link UsageError}, not an `OperatorConfigError`: the refusing party
 * is not necessarily the one whose value refuses, since
 * `resolveLinkageCardinality` asserts over the PARTNER's terms document too,
 * so the fault is not unconditionally this operator's own. The message
 * holds only fixed literals.
 */
export function assertDeduplicateImplemented(terms: LinkageTerms): void {
  if (!terms.deduplicate) return;
  if (deduplicateIsImplementedForStrategy(terms.linkageStrategy)) return;
  throw new UsageError(
    "deduplicated matching is not implemented for the linkage strategy these " +
      'terms name: a "deduplicate: true" term would be matched one-to-one ' +
      "rather than honored, so the exchange is refused before matching " +
      "begins. Set linkage_strategy to cascade or single-pass to run a " +
      "deduplicating match, or set deduplicate to false.",
  );
}

/**
 * Which linkage strategies pair the BOTH-sided deduplicating cardinality,
 * one entry per strategy. The cascade does, applying the "many" rule to
 * each party so a matched value contributes the two groups' product;
 * `single-pass` does not (docs/spec/PROTOCOL.md, Deduplicating
 * cardinalities: many-to-X matching).
 *
 * Separate from {@link DEDUPLICATE_IMPLEMENTED_BY_STRATEGY}: that table asks
 * whether a strategy honors one party's `deduplicate: true` at all, this
 * asks whether it pairs the cardinality the agreed PAIR resolves to when
 * both parties declare it. Single-pass answers `true` to the first and
 * `false` to the second.
 *
 * A total table over {@link LinkageStrategy}, typed `boolean`, for the same
 * reason as its sibling.
 *
 * @internal exported for the tests that drive its readers over every
 * strategy.
 */
export const MANY_TO_MANY_IMPLEMENTED_BY_STRATEGY: Record<
  LinkageStrategy,
  boolean
> = {
  cascade: true,
  "single-pass": false,
};

/**
 * Whether an exchange on `strategy` pairs the both-sided deduplicating
 * cardinality.
 *
 * The one predicate behind both readers of that verdict:
 * {@link assertBothSidedDeduplicateImplemented} refuses the agreed pair it
 * returns `false` for, and the strategy's own fail-closed half reads it at
 * the boundary that would otherwise pair it (`singlePassResolves`,
 * `link.ts`), so the two cannot silently diverge.
 */
export function manyToManyIsImplementedForStrategy(
  strategy: LinkageStrategy,
): boolean {
  return MANY_TO_MANY_IMPLEMENTED_BY_STRATEGY[strategy];
}

/**
 * Refuse the agreed `(true, true)` pair on a linkage strategy that does not
 * pair the both-sided cardinality it resolves to, before any matching
 * begins.
 *
 * The both-sided sibling of {@link assertDeduplicateImplemented}: a
 * per-party reading answers `true` for a single-pass party whose own
 * `deduplicate: true` is perfectly runnable one-sided, so only a check over
 * BOTH documents can refuse the combination the strategy will not pair.
 *
 * Called from `resolveLinkageCardinality` (`exchange.ts`) after the terms
 * exchange and before the first round. Symmetric in the pair -- it reads
 * both documents' strategies and refuses if EITHER fails to hold the
 * cardinality, so a refused pair aborts both parties at the same point.
 *
 * The message names the STRATEGY rather than the pair, read off
 * {@link MANY_TO_MANY_IMPLEMENTED_BY_STRATEGY} so a strategy that later
 * pairs the cardinality is named the moment its entry says so.
 *
 * Plain {@link UsageError}, not an `OperatorConfigError`, for the same
 * reason as its sibling: this check reads the PARTNER's document as well as
 * this party's, so the fault is not unconditionally this operator's own.
 */
export function assertBothSidedDeduplicateImplemented(
  localTerms: LinkageTerms,
  partnerTerms: LinkageTerms,
): void {
  if (!(localTerms.deduplicate && partnerTerms.deduplicate)) return;
  if (
    manyToManyIsImplementedForStrategy(localTerms.linkageStrategy) &&
    manyToManyIsImplementedForStrategy(partnerTerms.linkageStrategy)
  )
    return;
  const pairing = (
    Object.keys(MANY_TO_MANY_IMPLEMENTED_BY_STRATEGY) as Array<LinkageStrategy>
  )
    .filter(manyToManyIsImplementedForStrategy)
    .sort();
  const oneSidedRemedy =
    "deduplicate to false on one of the two parties to run a many-to-one " +
    "match.";
  throw new UsageError(
    "the linkage strategy these terms name does not match a many-to-many " +
      "cardinality, which is what both parties setting deduplicate to true " +
      "resolves to: each party's records may then group the other's, and the " +
      "strategy this exchange runs pairs one side's grouping only. The " +
      "exchange is refused before matching begins rather than matched to less " +
      "than the terms declare. " +
      (pairing.length > 0
        ? `Set linkage_strategy to ${pairing.join(" or ")} to run the pair, ` +
          `or set ${oneSidedRemedy}`
        : `Set ${oneSidedRemedy}`),
  );
}

// The two elements a key's `swap` names, or undefined when the key declares no
// swap or when a target resolves to no element of that key -- the dangling case
// the referential-integrity refine owns, which every rule about a PAIR passes
// over so the document is answered by the one message about its actual fault.
// Element identity is `el.name ?? el.field`, the same expression the
// element-identifier-uniqueness refine uses, so the rules cannot disagree about
// which two elements a swap names.
function swapPairedElements(
  key: LinkageKey,
): [LinkageKeyElement, LinkageKeyElement] | undefined {
  if (key.swap === undefined) return undefined;
  const [first, second] = key.swap.map((target) =>
    key.elements.find((el) => (el.name ?? el.field) === target),
  );
  if (first === undefined || second === undefined) return undefined;
  return [first, second];
}

// Whether two swap-paired positions declare the same transform pipeline. An
// absent `transform` and an empty one are both the identity pipeline, so
// both normalize to the empty list. Equality is by canonical encoding
// rather than a structural walk, since a `params` record's key order is not
// significant to the agreed terms, which are hashed in this same canonical
// form.
//
// `transform.params` values are `z.unknown()`, so a partner value outside
// the reproducible canonical domain (a JSON integer beyond 2^53) survives
// schema parsing and then fails to encode. Such a pair is reported as
// DIFFERING rather than propagating the throw: a pipeline that cannot be
// encoded cannot be shown to match its partner position.
function swapPairDeclaresOneTransform(
  first: LinkageKeyElement,
  second: LinkageKeyElement,
): boolean {
  try {
    return (
      canonicalString(first.transform ?? []) ===
      canonicalString(second.transform ?? [])
    );
  } catch (err) {
    if (err instanceof CanonicalEncodingError) return false;
    throw err;
  }
}

/**
 * Whether the two elements this key's `swap` names declare DIFFERENT
 * transforms, the shape {@link LinkageTermsSchema} refuses.
 *
 * A swap moves the field references and leaves each element's own transform
 * on its position, so only a pair whose transforms agree compares
 * like-normalized values on both sides of the swapped key. An omitted
 * transform and an empty one are the same identity pipeline, and two
 * `params` records differing only in key order are one pipeline.
 *
 * False for a key declaring no swap, and for one whose swap target resolves
 * to no element -- the dangling case the schema answers by its own rule.
 *
 * Exported so an authoring surface can name this fault before the schema
 * refuses the document.
 */
export function swapPairTransformsDiffer(key: LinkageKey): boolean {
  const paired = swapPairedElements(key);
  return (
    paired !== undefined && !swapPairDeclaresOneTransform(paired[0], paired[1])
  );
}

/**
 * Whether the two elements this key's `swap` names declare DIFFERENT
 * `generateFuzzyComparisons`, the sibling shape {@link LinkageTermsSchema}
 * refuses beside {@link swapPairTransformsDiffer}.
 *
 * A swap moves only the field references and leaves each position's own
 * expansion where it is, so a mismatched pair would expand a column one way
 * on the party that swaps and another on the party that does not.
 *
 * False for a key declaring no swap, and for one whose swap target resolves
 * to no element -- the dangling case the schema answers by its own rule.
 *
 * Exported for the key-read layer, which reads the pair's two positions as
 * interchangeable when it assembles the swapped order (`planKeyRead`,
 * standardization.ts).
 */
export function swapPairFuzzyComparisonsDiffer(key: LinkageKey): boolean {
  const paired = swapPairedElements(key);
  return (
    paired !== undefined &&
    paired[0].generateFuzzyComparisons !== paired[1].generateFuzzyComparisons
  );
}

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

// --- Acceptance --------------------------------------------------------------

/**
 * Derive the {@link LinkageTerms} an ACCEPTOR runs from the inviter's terms
 * decoded from an invitation. The acceptor adopts the inviter's shared,
 * agreed fields verbatim -- `version`, `algorithm`, `linkageFields`,
 * `linkageKeys`, `linkageRuleSet`, `legalAgreement`, and so on are
 * cross-checked for equality at exchange time -- but four facets are the
 * acceptor's own perspective and are derived, not copied:
 *
 * - `identity` is replaced with the acceptor's own name (a CLI flag or
 *   prompt, a browser field), so the inviter's identity does not leak into
 *   the acceptor's terms. Held here to the same rules the schema holds a
 *   party `identity` to (control characters, non-empty,
 *   {@link MAX_TEXT_LENGTH}), under a refusal naming the local input,
 *   rather than at the generic re-check below.
 * - `output` is MIRRORED, not copied: {@link validateCompatibility} compares
 *   it as a mirror (`local.expectsOutput` against `partner.shareWithPartner`
 *   and vice versa), so a verbatim copy is only accidentally correct for the
 *   symmetric "both receive" case.
 * - `payload` is MIRRORED for the same reason: the acceptor's `send` becomes
 *   the inviter's `receive` and vice versa. An absent inviter `receive`
 *   yields an absent acceptor `send` (lazy); an explicit empty inviter
 *   `receive: []` yields an explicit empty acceptor `send: []` (strict),
 *   matching {@link validateCompatibility}'s lazy/strict reading.
 * - `deduplicate` is DEFAULTED to false, neither copied nor mirrored: it is
 *   per-party and declares that several of the DECLARING party's own
 *   records may match the partner's, so it is never the inviter's to set
 *   for the acceptor -- copying it would let a hostile inviter claim
 *   `deduplicate: true` to put the acceptor on the "many" side, then
 *   present `false` at the terms exchange. The invitation's declared value
 *   for the inviter's own side is retained separately by a caller holding
 *   the token, as `expectedPartnerDeduplicate` (`PreparedExchange`,
 *   exchange.ts); its widened-disclosure consequence for the acceptor is
 *   stated on the consent surfaces (`DEDUPLICATE_ACCEPTOR_SIDE_NOTE`).
 *
 * Metadata and standardization stay per-party and local; this function
 * shapes only the agreed linkage terms.
 *
 * It fails closed: a config valid for the INVITER can mirror to one
 * incoherent for the acceptor (an inviter that is the sole receiver may
 * have a `payload.send` that needs the acceptor to receive output, but the
 * acceptor mirrors to `expectsOutput: false`). The derived terms are
 * re-checked against {@link LinkageTermsSchema} and an incoherent result
 * throws, aborting acceptance cleanly. The re-check's message names no
 * partner-controlled value: `identity` -- the one substituted value, and the
 * accepting operator's own -- is refused above under an account naming the
 * local input if it fails its own rules, so nothing the operator supplied
 * reaches this message.
 *
 * It also refuses a `psi-c` document outside the count-only shape
 * ({@link assertCountOnlyTermsShape}) and a deduplicating invitation under a
 * strategy that cannot match one ({@link assertDeduplicateImplemented}),
 * both read from the INVITER's terms before the mirror is built, so the
 * refusal names the rule the received document breaks and keeps such an
 * invitation off the consent surfaces and off the wire.
 *
 * @throws {UsageError} when `acceptorIdentity` contains a control character,
 *   is empty, or exceeds {@link MAX_TEXT_LENGTH}, or when the inviter's
 *   terms are `psi-c` outside the count-only shape or declare `deduplicate`
 *   under a strategy that matches no deduplicating cardinality.
 * @throws {Error} when the inviter's terms cannot be coherently accepted
 *   for the mirrored output direction.
 */
export function deriveAcceptedLinkageTerms(
  inviterTerms: LinkageTerms,
  acceptorIdentity: string,
): LinkageTerms {
  // This party's own name takes the rules the schema holds a party `identity` to
  // here, before it is substituted (see the doc comment): left to the re-check at
  // the end, the same value is refused as an invitation that cannot be accepted --
  // an account of an input the operator supplied itself.
  if (TEXT_CONTROL_CHAR_PATTERN.test(acceptorIdentity))
    throw new UsageError(
      "the identity supplied for this party cannot be used: " +
        `${TEXT_CONTROL_CHAR_MESSAGE}. Supply one that has none.`,
    );
  if (acceptorIdentity.length === 0)
    throw new UsageError(
      "the identity supplied for this party cannot be used: it is empty. " +
        "Supply a name for this party.",
    );
  if (acceptorIdentity.length > MAX_TEXT_LENGTH)
    throw new UsageError(
      "the identity supplied for this party cannot be used: it is longer than " +
        `${MAX_TEXT_LENGTH} characters. Supply a shorter one.`,
    );
  assertCountOnlyTermsShape(inviterTerms);
  assertDeduplicateImplemented(inviterTerms);
  const derived: LinkageTerms = {
    ...inviterTerms,
    identity: acceptorIdentity,
    // This party's own side of the cardinality, which the invitation does
    // not pass to it: whether SEVERAL of this party's records may match one
    // of the partner's is a disclosure about this party's own data, so it
    // starts closed and is authored in this party's own configuration (see
    // the doc comment).
    deduplicate: false,
    output: {
      expectsOutput: inviterTerms.output.shareWithPartner,
      shareWithPartner: inviterTerms.output.expectsOutput,
    },
  };
  // Mirror the payload `send`/`receive` (see the doc comment). Built explicitly so
  // an absent inviter `receive` yields an absent acceptor `send` (rather than an
  // empty list), keeping the acceptor lazy on a direction the inviter left open; an
  // explicit empty inviter `receive: []` mirrors to an explicit empty acceptor
  // `send: []` (present, not absent), preserving the strict reading on that direction.
  if (inviterTerms.payload !== undefined) {
    const mirrored: Payload = {};
    if (inviterTerms.payload.receive !== undefined)
      mirrored.send = inviterTerms.payload.receive;
    if (inviterTerms.payload.send !== undefined)
      mirrored.receive = inviterTerms.payload.send;
    derived.payload = mirrored;
  }
  // Fail closed on an inviter config that mirrors to an incoherent acceptor config
  // (see the doc comment). safeParse is a validity gate only; return the object we
  // built, not parsed.data, so the canonical/agreed-terms bytes are unchanged.
  if (!LinkageTermsSchema.safeParse(derived).success) {
    throw new Error(
      "the invitation's linkage terms cannot be accepted unchanged: mirroring " +
        "the output direction for the accepting party produced an incompatible " +
        "configuration. The inviter is the sole receiver of the matched result, " +
        "yet its terms also have the accepting party receive payload columns " +
        "the inviter sends -- which no party that receives no result can do. " +
        "Ask the inviter to share the result, or to drop those columns.",
    );
  }
  return derived;
}

// --- Compatibility -----------------------------------------------------------

interface CompatibilityResult {
  errors: string[];
  warnings: string[];
}

/**
 * Cross-party consistency check for a pair of {@link LinkageTerms}.
 *
 * Returns errors for mandatory mismatches that must cancel the exchange,
 * and warnings for soft mismatches (currently only `date`) that produce a
 * notice but allow the exchange to continue.
 *
 * Every diagnostic it composes names its terms values through the
 * delimiting boundary in `config/compatibilityMessage.ts`, so no value a
 * partner chooses can close a delimiter or spell a second clause of
 * psilink's own prose. Enforced by type: the two accumulators hold
 * `CompatibilityMessageFragment`, so a message composed any other way does
 * not compile. `test/compatibilityMessage.test.ts` drives adversarial value
 * shapes through each message and asserts the clause structure holds.
 */
export function validateCompatibility(
  local: LinkageTerms,
  partner: LinkageTerms,
): CompatibilityResult {
  // Both accumulators hold CompatibilityMessageFragment rather than string, which
  // is the whole of the sweep below: a diagnostic reaches either list only
  // through the compatibilityMessage tagged template, whose interpolations are
  // fragments and whose fixed spans the compiler supplies. So a terms value put
  // into a message without passing the delimiting boundary -- an edit to a
  // message here, or a mismatch check added later -- does not compile. Both
  // lists are returned as the `string[]` of CompatibilityResult, which the
  // brand is transparent to.
  const errors: CompatibilityMessageFragment[] = [];
  const warnings: CompatibilityMessageFragment[] = [];

  // Both arrays below answer the same threat: a mutually-distrusting
  // partner controls reference/purpose/set/column names, and controls them
  // on the side these messages call "local" too, since
  // deriveAcceptedLinkageTerms adopts the inviter's legalAgreement and
  // linkageRuleSet verbatim.
  //
  // DELIMITING is applied here, at composition, to every value either list
  // names (config/compatibilityMessage.ts). ESCAPING stays assigned to one
  // altitude per route: `errors` becomes an Error message, escaped once by
  // sanitizeErrorForDisplay where it is shown, so the values inside the
  // delimiters are the RAW ones; `warnings` is handed to the caller as
  // display text with no error to hold it, so it is escaped and redacted
  // here. The CLI escapes each warning again downstream, which stays
  // unobservable because every value interpolated below is
  // schema-constrained to a shape the escape does not rewrite. Full
  // reasoning: docs/spec/CHANNEL_SECURITY.md, "Display sanitization escape
  // format".
  //
  // The equality CHECKS always compare the RAW values either way -- both
  // transforms are display-only and the escape is lossy, so comparing
  // transformed forms could mask a genuine mismatch.
  if (local.version !== partner.version) {
    // TODO: implement migration when new versions exist
    errors.push(
      compatibilityMessage`version mismatch: local is ${bareTermsValue(local.version)}, partner is ${bareTermsValue(partner.version)}`,
    );
  }

  if (local.algorithm !== partner.algorithm) {
    errors.push(
      compatibilityMessage`algorithm mismatch: local is ${bareTermsValue(local.algorithm)}, partner is ${bareTermsValue(partner.algorithm)}`,
    );
  }

  // Strictly consistent, like algorithm: both parties must use the same strategy
  // or they would compute different matches. The schema fills in "cascade" when
  // omitted, so the value is always present and compared directly.
  if (local.linkageStrategy !== partner.linkageStrategy) {
    errors.push(
      compatibilityMessage`linkage strategy mismatch: local is ${bareTermsValue(local.linkageStrategy)}, partner is ${bareTermsValue(partner.linkageStrategy)}`,
    );
  }

  // Each branch spells its whole sentence rather than interpolating a phrase
  // chosen by a ternary: the four readings are fixed first-party copy, and
  // writing them out is what lets the tagged template above hold for every
  // message in this function without a `string` step for a first-party fragment
  // to slip through.
  if (local.output.shareWithPartner !== partner.output.expectsOutput) {
    errors.push(
      local.output.shareWithPartner
        ? compatibilityMessage`output mismatch: local will share with partner, but partner does not expect output`
        : compatibilityMessage`output mismatch: local will not share with partner, but partner expects output`,
    );
  }
  if (local.output.expectsOutput !== partner.output.shareWithPartner) {
    errors.push(
      local.output.expectsOutput
        ? compatibilityMessage`output mismatch: local expects output, but partner will not share`
        : compatibilityMessage`output mismatch: local does not expect output, but partner will share`,
    );
  }
  if (!local.output.expectsOutput && !partner.output.expectsOutput) {
    errors.push(compatibilityMessage`neither party expects output`);
  }

  if (local.date !== partner.date) {
    warnings.push(
      compatibilityMessage`date mismatch: local is ${bareTermsValue(redactAndSanitizeForDisplay(local.date))}, partner is ${bareTermsValue(redactAndSanitizeForDisplay(partner.date))}; one party may have a stale copy of the linkage terms`,
    );
  }

  // Compare by canonical form (RFC 8785): two field/key sets are equal iff
  // their canonical encodings match -- the same encoding hashed into the
  // exchange-agreement receipt, so equality here means hash-equality there.
  // The canonical encoder sorts keys, so property-insertion order does not
  // affect the result; fields are pre-sorted by name (their array order is
  // not significant), while linkage keys are ordered most-to-least precise
  // and compared in place.
  //
  // No casing fold is applied here: `transform.params` keys are normalized
  // to camelCase at every parse chokepoint that produces a LinkageTerms, so
  // both sides reach this comparison in the one camelCase form already.
  //
  // canonicalString throws CanonicalEncodingError on a value outside the
  // reproducible domain -- a partner can reach this via a `transform.params`
  // JSON integer beyond 2^53. validateCompatibility's contract is to report
  // problems via `errors`, not to throw, so such a value becomes an error
  // instead of a crash.
  //
  // When canonicalOrError returns null the value could not be encoded, so
  // the mismatch comparisons below are skipped for that side: an
  // un-encodable value cannot be compared, and the encoding error already
  // aborts the exchange.
  //
  // `label` is first-party copy composed through the same tagged template;
  // the encoder's own message is delimited, naming the offending JSON path.
  const canonicalOrError = (
    value: unknown,
    label: CompatibilityMessageFragment,
  ): string | null => {
    try {
      return canonicalString(value);
    } catch (err) {
      if (err instanceof CanonicalEncodingError) {
        errors.push(
          compatibilityMessage`${label} cannot be canonically encoded: ${quoteTermsValue(err.message)}`,
        );
        return null;
      }
      throw err;
    }
  };

  // Sort by UTF-16 code unit, not localeCompare: this comparator decides the
  // element order and therefore the canonical bytes (canonical encoding
  // preserves array order), and localeCompare is locale-dependent for non-ASCII
  // names -- two parties under different locales could otherwise derive
  // different bytes, and different receipt hashes, for the same terms. This is
  // the same code-unit ordering the canonical encoder applies to object keys.
  const byName = (a: LinkageField, b: LinkageField): number =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  const localFields = [...local.linkageFields].sort(byName);
  const partnerFields = [...partner.linkageFields].sort(byName);
  const localFieldsCanonical = canonicalOrError(
    localFields,
    compatibilityMessage`local linkage fields`,
  );
  const partnerFieldsCanonical = canonicalOrError(
    partnerFields,
    compatibilityMessage`partner linkage fields`,
  );
  if (
    localFieldsCanonical !== null &&
    partnerFieldsCanonical !== null &&
    localFieldsCanonical !== partnerFieldsCanonical
  ) {
    errors.push(compatibilityMessage`linkage fields do not match`);
  }

  const localKeysCanonical = canonicalOrError(
    local.linkageKeys,
    compatibilityMessage`local linkage keys`,
  );
  const partnerKeysCanonical = canonicalOrError(
    partner.linkageKeys,
    compatibilityMessage`partner linkage keys`,
  );
  if (
    localKeysCanonical !== null &&
    partnerKeysCanonical !== null &&
    localKeysCanonical !== partnerKeysCanonical
  ) {
    errors.push(compatibilityMessage`linkage keys do not match`);
  }

  // The rule-set citation, checked only where BOTH parties declare one. It
  // names rules the two documents already had to agree on field by field
  // and key by key, so a disagreement here is a disagreement about the NAME
  // of matching content -- which still cancels, since each party records
  // its own citation in its own exchange record. Skipped where either party
  // declares none: a hand-authored document has no citation, and holding it
  // to the partner's would refuse an exchange whose rules match exactly.
  // Compared by canonical form, like the fields and keys above. The set
  // names are delimited by describeRuleSet, and the values inside those
  // delimiters stay raw for the same reason the legal-agreement mismatches
  // below are: an error is escaped once where it is shown.
  if (
    local.linkageRuleSet !== undefined &&
    partner.linkageRuleSet !== undefined
  ) {
    const localRuleSet = canonicalOrError(
      local.linkageRuleSet,
      compatibilityMessage`local linkage rule set`,
    );
    const partnerRuleSet = canonicalOrError(
      partner.linkageRuleSet,
      compatibilityMessage`partner linkage rule set`,
    );
    if (
      localRuleSet !== null &&
      partnerRuleSet !== null &&
      localRuleSet !== partnerRuleSet
    ) {
      errors.push(
        compatibilityMessage`linkage rule set mismatch: local names ${describeRuleSet(local.linkageRuleSet)}, partner names ${describeRuleSet(partner.linkageRuleSet)}`,
      );
    }
  }

  if (
    local.legalAgreement !== undefined ||
    partner.legalAgreement !== undefined
  ) {
    if (local.legalAgreement === undefined) {
      errors.push(
        compatibilityMessage`partner has a legal agreement but local does not`,
      );
    } else if (partner.legalAgreement === undefined) {
      errors.push(
        compatibilityMessage`local has a legal agreement but partner does not`,
      );
    } else {
      if (local.legalAgreement.reference !== partner.legalAgreement.reference) {
        errors.push(
          compatibilityMessage`legal agreement reference mismatch: local is ${quoteTermsValue(local.legalAgreement.reference)}, partner is ${quoteTermsValue(partner.legalAgreement.reference)}`,
        );
      }
      if (local.legalAgreement.purpose !== partner.legalAgreement.purpose) {
        errors.push(
          compatibilityMessage`legal agreement purpose mismatch: local is ${quoteTermsValue(local.legalAgreement.purpose)}, partner is ${quoteTermsValue(partner.legalAgreement.purpose)}`,
        );
      }
      if (
        local.legalAgreement.expirationDate !==
        partner.legalAgreement.expirationDate
      ) {
        errors.push(
          compatibilityMessage`legal agreement expiration date mismatch: local is ${bareTermsValue(local.legalAgreement.expirationDate)}, partner is ${bareTermsValue(partner.legalAgreement.expirationDate)}`,
        );
      }
      const today = new Date().toISOString().slice(0, 10);
      if (local.legalAgreement.expirationDate < today) {
        errors.push(
          compatibilityMessage`legal agreement expired on ${bareTermsValue(local.legalAgreement.expirationDate)}`,
        );
      }
    }
  }

  // Payload mirror, LAZY on the receive side. Each of the two directions is
  // gated on whether the RECEIVING party declared a `payload.receive`
  // expectation:
  //
  // - `receive` DECLARED (present, even if empty) asserts "I expect exactly
  //   these columns": the partner's `send` must match it byte-for-byte or
  //   the exchange aborts. An explicit empty `receive: []` is strict BY
  //   INTENT -- "the partner sends nothing" -- distinct from an absent
  //   `receive`, matching the received-payload runtime enforcement (an
  //   empty committed set is likewise strict; only `undefined` is lazy) and
  //   the web consent display, which renders a declared-empty receive as a
  //   "(none)" commitment, not lazy.
  // - `receive` ABSENT means "take whatever I'm given": that direction is
  //   skipped. This is what lets the invite/accept flow reconcile without
  //   the inviter knowing the acceptor's schema -- the inviter authors only
  //   `send` and leaves `receive` unset; the acceptor mirrors the inviter's
  //   `send` into its own `receive`; a zero-setup exchange is lazy on both
  //   sides.
  //
  // Laziness relaxes only this cross-party DECLARATION check; it never
  // widens what a party sends -- transmission is governed by each party's
  // own metadata (`isDisclosedToPartner`) and `assertPayloadSendDisclosed`,
  // unchanged. The gate is symmetric: each direction keys on the same
  // receiver's declared `receive`, so the two parties (which call this with
  // swapped arguments) compute identical verdicts. The equality is
  // byte-exact and element-wise -- compared per sorted column, NOT by a
  // delimiter-joined string, so a partner-controlled name containing the
  // separator cannot make two distinct sets join equal (`["a,b"]` vs
  // `["a","b"]`) and slip a genuine mismatch past the check.
  const sameColumnSet = (a: Array<string>, b: Array<string>): boolean =>
    a.length === b.length && a.every((name, i) => name === b[i]);

  // One direction of the payload mirror: the receiver's declared `receive` must
  // match the sender's `send`, byte-exact and element-wise. Both directions share
  // the sort/compare/delimit-join logic; only the two messages vary, so they are
  // supplied by the caller (emptyReceiveMessage for the strict empty `receive: []`
  // case, mismatchMessage otherwise).
  const checkPayloadDirection = (
    receiverReceive: ReadonlyArray<PayloadColumn>,
    senderSend: ReadonlyArray<PayloadColumn>,
    messages: {
      emptyReceiveMessage: (
        senderShown: CompatibilityMessageFragment,
      ) => CompatibilityMessageFragment;
      mismatchMessage: (
        receiverShown: CompatibilityMessageFragment,
        senderShown: CompatibilityMessageFragment,
      ) => CompatibilityMessageFragment;
    },
  ): void => {
    const receiverNames = receiverReceive.map((c) => c.name).sort();
    const senderNames = senderSend.map((c) => c.name).sort();
    if (sameColumnSet(senderNames, receiverNames)) return;
    const receiverShown = quoteTermsValueList(receiverNames);
    const senderShown = quoteTermsValueList(senderNames);
    errors.push(
      receiverNames.length === 0
        ? messages.emptyReceiveMessage(senderShown)
        : messages.mismatchMessage(receiverShown, senderShown),
    );
  };

  if (partner.payload?.receive !== undefined) {
    checkPayloadDirection(partner.payload.receive, local.payload?.send ?? [], {
      // An empty partner receive is the strict "partner expects no payload"
      // declaration (see the gate comment above); spell that out rather than
      // printing an empty bracket pair that reads like a rendering glitch.
      emptyReceiveMessage: (localShown) =>
        compatibilityMessage`payload mismatch: partner declared an empty payload.receive (asserting local sends no payload columns), but local sends [${localShown}]`,
      mismatchMessage: (partnerShown, localShown) =>
        compatibilityMessage`payload mismatch: local send columns [${localShown}] do not match partner receive columns [${partnerShown}]`,
    });
  }

  if (local.payload?.receive !== undefined) {
    checkPayloadDirection(local.payload.receive, partner.payload?.send ?? [], {
      // An empty local receive is the strict "I expect no payload" declaration;
      // name it and point the operator at the lazy alternative (omit the field),
      // since a hand-authored `receive: []` is the most likely way to land here.
      emptyReceiveMessage: (partnerShown) =>
        compatibilityMessage`payload mismatch: local declared an empty payload.receive (asserting partner sends no payload columns), but partner sends [${partnerShown}]. Omit payload.receive to accept whatever the partner sends.`,
      mismatchMessage: (localShown, partnerShown) =>
        compatibilityMessage`payload mismatch: local receive columns [${localShown}] do not match partner send columns [${partnerShown}]`,
    });
  }

  return { errors, warnings };
}
