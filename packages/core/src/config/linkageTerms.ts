import { z } from "zod";
import { AlgorithmSchema } from "../types.js";
import type { Algorithm } from "../types.js";
import { camelizeKeys } from "../utils/camelizeKeys.js";
import { safeParseCamelized } from "./safeParseCamelized.js";
import { canonicalString, CanonicalEncodingError } from "../utils/canonical.js";
import { sanitizeForDisplay } from "../utils/sanitizeForDisplay.js";
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

// --- Untrusted-input bounds --------------------------------------------------

// These terms travel inside an invitation token, which the decoder accepts from
// a counterparty whose token passed only a transcription checksum -- a check
// anyone can recompute over a crafted payload, not an authenticity guarantee
// (see invitation.ts) -- and they are parsed a second time off the exchange wire
// (protocolSetup), where the binding size cap is the far larger
// MAX_FRAME_SIZE_BYTES (~512 MiB, connection/frameSize.ts), not the 64 KiB
// MAX_ENCODED_INVITATION_LENGTH of the token path. The rule below: every
// partner-controlled free-text string carries a generous length `.max()`, and
// every partner-controlled collection carries a count bound, applied BEFORE
// per-element validation. The arrays take the boundedArray count gate -- the
// top-level `linkageFields` and `linkageKeys`, each constraint's `exclude` list,
// a `transform` step list, and a key's `elements`; the `transform.params` record
// takes an inline permissive-stage + count-refine + pipe of the same shape (its
// count refine is a cheap early-exit key count, see MAX_PARAMS_ENTRIES and
// exceedsOwnKeyCount), since boundedArray itself is array-only. They all share a
// RangeError exposure a bare `.max()` cannot close: Zod v4 validates every
// element BEFORE the length check, so a partner array of millions of invalid
// elements (a few MB of JSON, trivially under the wire-path frame cap)
// accumulates one issue per element first. Zod then either spreads that issue
// array up through an enclosing array/record/tuple frame and overflows its call
// stack (`Maximum call stack size exceeded`, ~130k elements, for a collection
// nested >=2 frames deep -- an intervening object frame does not prevent it), or,
// for a flat top-level array with no such frame (`linkageFields`/`linkageKeys`),
// throws `Invalid string length` building the error string from the issues
// (~3.5M elements). Both reproduced on Zod 4.4.3. The permissive first stage lets
// the count refine fire before either RangeError. For the `transform.params`
// record the count refine also closes a distinct LINEAR cost: not a RangeError
// but a multi-second event-loop burn that, before this gate, ran in full twice
// over a millions-key record -- once in the snake->camel camelize pre-pass and
// once in the permissive record stage -- before the count was even checked. Each
// of those is an EXPENSIVE per-key pass (a snake->camel rewrite, a per-key Zod
// validation); the count gate replaces both with the cheapest per-key pass, a
// bare key count (exceedsOwnKeyCount; still O(n) in keys -- a materialized object
// has no sub-linear count -- but far cheaper than either). The camelize pre-pass
// leaves an over-count params value verbatim (parseLinkageTerms passes its bound
// to camelizeKeys) instead of rewriting it, and the schema's refine rejects it
// before the per-key record stage, so the over-count record is counted but never
// rewritten or per-key-validated (item 202722105). Legitimate sizes vary -- a
// denylist holds hundreds of values, hence the most generous bound
// (MAX_EXCLUDE_ENTRIES) -- but each bound is far above any real config and far
// below the RangeError thresholds. The `params` VALUE content is otherwise
// unbounded (typed `z.unknown()`, with no clean general content bound); the
// exceptions are the partner-controlled values whose magnitude drives unbounded
// per-row work, each capped by a per-step refine on TransformStep's schema below:
// `pad_left`'s numeric `length` (an unbounded `padStart` allocation,
// MAX_PAD_LEFT_LENGTH), `parse_date`'s `inputFormat` / `outputFormat` strings (an
// unbounded per-row regex build and output allocation, MAX_DATE_FORMAT_LENGTH),
// and the four `tier: "regex"` functions' raw `pattern` / `delimiter` (an
// unbounded per-row regex compile under the linear-time engine,
// MAX_TRANSFORM_PATTERN_LENGTH).
//
// The `payload` send/receive arrays carry no enclosing array/record/tuple frame
// (only the root object), so a pathological count there cannot drive the ~130k
// STACK overflow the nested collections hit -- but they are not RangeError-free:
// a far larger count (~millions of invalid columns, still within the frame cap)
// makes Zod throw building the error string (`RangeError: Invalid string length`,
// ~3.5M on Zod 4.4.3). protocolSetup's parse-error catch already rendered that
// harmlessly, but the count gate (MAX_PAYLOAD_ENTRIES, applied before per-element
// validation) forestalls it at the source so the over-count payload fails with a
// single clean issue. A count `.max()` suits these because a real payload shares
// at most a few hundred columns -- unlike the two post-handshake exchange-wire
// flat arrays, which share this Invalid-string-length class but are legitimately
// in the millions: `payloadExchange.ts` `columns`/`rowIndices` and
// `participant.ts` `numberArrayMessage` (and `link.ts`
// `associationAndIterationArray`) are bounded with a single-issue element
// validator (utils/singleIssueArray.ts) rather than a count cap no real result
// could pass, as are the overflow-exposed `payloadExchange.ts` `rows` and
// `participant.ts` `associationTableMessage`. The Connection, Standardization,
// and Metadata schemas are out of the partner threat model entirely -- reached
// only from the operator's own local config, never from a partner-supplied
// payload -- so their count fields are left as trusted input. Every reachable
// RangeError was caught harmlessly in protocolSetup's parse-error catch already
// (a RangeError has no `.issues`, so it renders via the message fallback and the
// exchange aborts cleanly); the bounds turn that ungraceful internal exception
// into a clean, bounded rejection. They are defense-in-depth, not semantic
// limits.

/**
 * Generous upper bound on a short partner-controlled string -- the identifier-
 * and spec-like fields: a linkage key, field, or element `name`, an element
 * `field` reference, an element-`swap` reference, a transform `function` name and
 * its `params` keys, a payload column `name`, a legal-agreement `reference`, the
 * `version` string, and a name-constraint `allowedCharacters` class. A real value
 * is a short label (tens of characters); 256 is far above any legitimate one yet
 * refuses a megabyte-scale string. The metadata `ColumnMetadata.name`
 * (config/metadata.ts) reuses this same bound for parity, though that field is
 * operator-local config, not partner-controlled.
 */
export const MAX_NAME_LENGTH = 256;

/**
 * Generous upper bound on a prose-like or data-value free-text field: a party
 * `identity`, a legal-agreement `purpose`, a payload column `description`, or a
 * constraint `exclude` value (which can be a full email address, ~254
 * characters). Larger than {@link MAX_NAME_LENGTH} because these legitimately
 * hold a sentence, a name-plus-contact line, or a long data value rather than a
 * single label; 1 KiB is still comfortably above any real value.
 */
export const MAX_TEXT_LENGTH = 1024;

/**
 * Generous upper bound on the COUNT of entries in the `linkageFields` and
 * `linkageKeys` arrays. The default template ships ~14 keys / 5 fields and a
 * hand-authored set is of the same order; 256 is more than any real
 * configuration needs yet refuses a token padded with tens of thousands of
 * entries to exhaust the recipient on decode/render. The `.min(1)` floor and the
 * most-to-least-precise ordering of `linkageKeys` are unaffected.
 */
export const MAX_LINKAGE_ENTRIES = 256;

/**
 * Generous upper bound on the COUNT of entries in a transform step's `params`
 * record. A standardizing function takes a handful of parameters (the bundled
 * functions use one to three); 256 is far above any real parameter list yet
 * refuses a record padded with tens of thousands of keys. The bound is enforced
 * by a bare key count (see {@link TransformStep}'s schema and
 * {@link exceedsOwnKeyCount}) that fires BEFORE the per-key length validation, so
 * an over-count record is rejected with a single issue rather than one issue per
 * key -- which on the wide wire-path frame would otherwise overflow Zod's call
 * stack. The same bound also short-circuits the camelize pre-pass for an
 * over-count record (see {@link parseLinkageTerms}), so the record is counted
 * (O(n) in keys, but no sub-linear count exists for a materialized object) yet
 * neither rewritten key by key by the camelize pass nor per-key-validated by the
 * record stage -- the two expensive passes the count replaces. See the
 * untrusted-input bounds note above.
 */
export const MAX_PARAMS_ENTRIES = 256;

/**
 * Generous upper bound on the `length` param of a `pad_left` transform step --
 * one of the two partner-controlled transform-param VALUES that carry a content
 * bound (with {@link MAX_DATE_FORMAT_LENGTH}; every other param value stays
 * `z.unknown()`; the rest of the bounds in this file cap COLLECTION counts, see
 * the untrusted-input bounds note above).
 * `pad_left` runs per row inside the key-building pipeline
 * ({@link applyElementTransform}, driven by `buildKeyStrings`), and an unbounded
 * `length` makes every row allocate a `String.prototype.padStart(length, char)`
 * of that size -- a crafted `1e9` exhausts memory and hangs the acceptor (a
 * browser-tab freeze on the web path, a hung process on the CLI), the
 * memory-allocation sibling of the regex compile-cost vector
 * ({@link MAX_TRANSFORM_PATTERN_LENGTH}). A real left-pad target is tens
 * of characters (a zero-padded SSN is 9, a phone 10); 256 is far above any
 * legitimate pad yet far below an allocation that matters. Enforced by a per-step
 * refine on {@link TransformStep}'s schema before any per-row allocation; the
 * factory's positive-integer check (standardization.ts) remains the runtime
 * backstop for the operator-local standardization path, which never reaches this
 * schema. This is a DoS ceiling on the partner wire path, not a semantic limit.
 */
export const MAX_PAD_LEFT_LENGTH = 256;

/**
 * Generous upper bound on the `inputFormat` and `outputFormat` params of a
 * `parse_date` transform step -- the other partner-controlled transform-param
 * VALUES that carry a content bound (with {@link MAX_PAD_LEFT_LENGTH}; every other
 * param value stays `z.unknown()`, see the untrusted-input bounds note above).
 * `parse_date` runs per row inside the key-building pipeline
 * ({@link applyElementTransform}, which recompiles each step per row): its factory
 * builds a regex from `inputFormat` and assembles the result from `outputFormat`.
 * This length cap bounds the per-row WORK SIZE -- an unbounded `inputFormat` would
 * compile an ever-larger regex per row, and an unbounded `outputFormat` would
 * allocate an ever-larger output per matched row -- with 256 far above any real
 * date layout ("MM/DD/YYYY", "YYYY-MM-DD") yet small enough that the per-row build
 * and output stay cheap. The format's MM/DD tokens expand into adjacent
 * `(\d{1,2})` groups that catastrophically backtrack on the JavaScript engine, but
 * `parse_date` compiles its regex under the linear-time engine
 * (standardization.ts), which bounds that by construction -- so this cap is a
 * work-SIZE ceiling, no longer the backstop against a backtracking blow-up it once
 * shared with a separate screen. Enforced by a per-step refine on
 * {@link TransformStep}'s schema before any row runs. A DoS ceiling on the partner
 * wire path, not a semantic limit.
 */
export const MAX_DATE_FORMAT_LENGTH = 256;

/**
 * Upper bound on the length of a raw partner-controlled regex pattern -- the
 * `pattern` of `replace_regex` / `extract_regex` / `filter_regex` and the
 * `delimiter` of `split_on` (the four `tier: "regex"` functions). These run per
 * row inside the key-building pipeline ({@link applyElementTransform}, which
 * recompiles each step per row), so an unbounded pattern would compile an
 * ever-larger linear-time-engine program on every row. The engine matches in
 * linear time regardless (no catastrophic backtracking), and its compile is
 * internally bounded (repeat counts capped, program size limited), so this is a
 * per-row COMPILE-COST ceiling, not a safety control -- it preserves the
 * parse-cost bound the removed `redos-detector` screen provided
 * (MAX_ANALYZED_PATTERN_LENGTH, also 1000). A real transform pattern is short
 * (tens of characters); 1000 is far above any legitimate one. Enforced in two
 * places before any row runs: a per-step refine on {@link TransformStep}'s schema
 * reports the precise over-length message, and the dialect gate on
 * {@link LinkageTermsSchema} is handed this same bound (as `maxPatternLength`) so
 * it rejects an oversized source WITHOUT compiling -- otherwise the gate's own
 * `RE2JS.compile`, whose cost is super-linear in source length, would stall
 * validation for seconds on a single oversized in-dialect pattern before the
 * refine reported it. A DoS ceiling on the partner wire path, not a semantic
 * limit.
 */
export const MAX_TRANSFORM_PATTERN_LENGTH = 1000;

/**
 * Generous upper bound on the COUNT of values in a constraint `exclude`
 * denylist. A denylist legitimately holds hundreds of values (a list of invalid
 * SSN patterns, blocked test values, an email blocklist), so this is the most
 * generous of the collection-count bounds; 4096 is far above any real denylist
 * yet well below the ~130k count at which Zod's issue accumulation overflows the
 * call stack (see the untrusted-input bounds note above). Enforced before
 * per-element validation by {@link boundedArray}.
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
 * Generous upper bound on the COUNT of columns in a payload `send` or `receive`
 * list. A payload shares a curated set of output columns -- a handful to a few
 * dozen, at most a few hundred for an unusually wide dataset; 4096 is far above
 * any real column set yet far below the ~3.5M count at which Zod's error-string
 * construction throws `RangeError: Invalid string length` (see the untrusted-
 * input bounds note above). Enforced before per-element validation by
 * {@link boundedArray}.
 */
export const MAX_PAYLOAD_ENTRIES = 4096;

/**
 * A constraint `exclude` denylist: partner-controlled free-text values, each
 * length-bounded like every other free-text string, with the entry COUNT bounded
 * at {@link MAX_EXCLUDE_ENTRIES} before per-element validation (see
 * {@link boundedArray}). Shared by all four constraint schemas so the bound is
 * defined once.
 */
const ExcludeSchema = boundedArray(
  z.string().max(MAX_TEXT_LENGTH),
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
   * */
  shareWithPartner: boolean;
}

const OutputSchema: z.ZodType<Output> = z.object({
  expectsOutput: z.boolean(),
  shareWithPartner: z.boolean(),
});

// --- Linkage fields ----------------------------------------------------------
/**
 * TODO:
 * * Semantic type enumeration is incomplete.
 * * Add a generic type.
 */

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
  /** Values that must not appear in the data. */
  exclude?: string[];
}

const NameConstraintsSchema: z.ZodType<NameConstraints> = z.object({
  // Validated to compile as a character class under the linear-time engine
  // (re2js) -- the SAME engine that executes it: the core value-level constraint
  // check (`checkValueConstraints` in standardization.ts, shared by the web
  // workbench and the CLI) compiles `^[allowedCharacters]$` under that engine, one
  // code point at a time, to flag values outside the class -- escaping a leading
  // `^` (and a `-` immediately after it) to a literal first so the class is read as
  // an allow-list, not a negation. Validating with the engine that runs it
  // guarantees a class accepted here compiles at check time (if escaping a leading
  // caret yields a form re2js cannot compile, the check over-flags rather than
  // failing open -- see withinAllowedCharacters -- so a refine-accepted class is
  // never silently un-checked),
  // so the advisory cannot silently fail open on a class the native engine accepts
  // but re2js rejects (a backreference, a POSIX/Unicode class, or the degenerate
  // empty class). Note the brackets that get added. The `.max()` precedes the
  // refine so an oversized value is rejected on length before a large
  // partner-controlled string is compiled; a real class is short.
  allowedCharacters: z
    .string()
    .max(MAX_NAME_LENGTH)
    .refine((val) => patternConformsToDialect(`[${val}]`), {
      message: "allowedCharacters must be a valid regex character class",
    })
    .optional(),
  affixesAllowed: z.boolean().optional(),
  exclude: ExcludeSchema.optional(),
});

/** Constraints on date-of-birth fields. */
interface DateConstraints {
  /** Dates must be able to be parsed as valid dates. */
  validOnly?: boolean;
  /** Values that must not appear in the data. */
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
  /** Values that must not appear in the data. */
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

/**
 * A standardized PII field that participates in linkage. Linkage key elements
 * reference these fields by name; data cleaning pipelines produce them by name.
 * Constraints are standards both parties commit to meeting — the application
 * warns if violated but does not enforce them.
 */
export type LinkageField =
  | FirstNameField
  | LastNameField
  | DateOfBirthField
  | SsnField
  | Ssn4Field
  | PhoneNumberField
  | EmailAddressField;

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
  ],
);

// --- Linkage key elements ----------------------------------------------------

type GenerateFuzzyComparisons =
  | "transpositions"
  | "edit_distances"
  | "adjacent_years";

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

// Not annotated as ZodType<TransformStep> because the concrete ZodObject is the
// base the pad_left refine below chains onto (mirrors LinkageTermsBaseSchema).
const TransformStepBaseSchema = z.object({
  function: z.string().min(1).max(MAX_NAME_LENGTH),
  // The record's KEYS are partner-controlled strings (parameter names), so they
  // are length-bounded like every other free-text string; the VALUE content is
  // `z.unknown()` with no clean per-field bound. The entry COUNT is bounded at
  // MAX_PARAMS_ENTRIES, and -- critically -- that gate is a bare key count (see
  // exceedsOwnKeyCount) that runs BEFORE the per-key length check. The
  // `z.unknown()` first stage accepts the value untouched, doing no per-key VALIDATION
  // of its own -- unlike a permissive `z.record(z.string(), z.unknown())` first
  // stage, which would parse every key (a ZodType per key) before the refine
  // could fire. The count itself still enumerates the keys (O(n); a materialized
  // object has no sub-linear count), but a plain count is far cheaper than that
  // per-key parse, so the refine rejects an over-count record for roughly the
  // cost of one key enumeration; `.pipe` re-validates the now count-capped record
  // against the per-key length bound. The refine passes a non-record value
  // (null/array/primitive) straight through so the pipe surfaces the same
  // record-type error as before. A length-bounded `z.record` first stage would
  // not help either -- Zod walks and validates every key during that record's own
  // parse, before any refine runs, both burning O(n) on a millions-key record and
  // (on the wide wire-path frame, MAX_FRAME_SIZE_BYTES, far above the 64 KiB
  // invitation cap) overflowing its call stack at ~130k bad keys as it spreads
  // that issue array up through the nesting. The camelize pre-pass
  // (parseLinkageTerms) is short-circuited for the same over-count record by the
  // same bound, so the record is rewritten by neither pass before this rejection.
  // The pipe keeps the post-cap `invalid_key` path -- and its parse-error
  // sanitization (item 202554679) -- intact for an in-range over-long key.
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
    .pipe(z.record(z.string().max(MAX_NAME_LENGTH), z.unknown()))
    .optional(),
});

// Content bounds on the two partner-controlled transform-param VALUES whose
// magnitude drives unbounded per-row work; every other param value stays
// `z.unknown()` (see the untrusted-input bounds note above). Each is a per-step
// refine on this wire schema -- not on the editor descriptor an attacker-authored
// token never passes through -- and each message names no partner value,
// consistent with the unsanitized parse-error path the referential-integrity and
// dialect refines rely on.
const TransformStepSchema: z.ZodType<TransformStep> = TransformStepBaseSchema
  // `pad_left` runs per row in the key-building pipeline (standardization.ts
  // applyElementTransform, driven by buildKeyStrings), so an unbounded `length`
  // makes every row allocate a `padStart(length, char)` of that size -- a crafted
  // 1e9 exhausts memory and hangs the acceptor, the memory-allocation sibling of
  // the regex compile-cost cap below (MAX_TRANSFORM_PATTERN_LENGTH). Only a
  // positive-integer `length` ever reaches padStart (padLeftFactory throws on a
  // non-number, non-integer, or non-positive value before it allocates), so
  // rejecting positive integers above MAX_PAD_LEFT_LENGTH closes the whole
  // allocation vector; a malformed `length` is left to that runtime check, whose
  // clean-abort path is unchanged.
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
  // `parse_date` builds a regex from `inputFormat` and assembles its result from
  // `outputFormat`, both recompiled per row by applyElementTransform. This length
  // cap bounds the per-row WORK SIZE: an unbounded `inputFormat` compiles an
  // ever-larger regex per row, an unbounded `outputFormat` allocates an ever-larger
  // per-row output. Only a string value drives either (the factory treats a
  // non-string as an empty/absent format), so the bound is on the string length.
  // The catastrophic-backtracking risk in the expanded regex (adjacent `(\d{1,2})`
  // from MM/DD tokens) is closed by running parse_date on the linear-time engine
  // (standardization.ts), not by this cap or a separate screen.
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
  // The four `tier: "regex"` functions compile their raw `pattern` / `delimiter`
  // under the linear-time engine. applyElementTransform compiles each step once per
  // distinct transform array (memoized), so this caps that one-time compile and
  // source-parse cost, preserving the parse-cost ceiling the removed redos-detector
  // screen provided (see MAX_TRANSFORM_PATTERN_LENGTH). The engine bounds
  // backtracking by construction (a pattern that compiles cannot blow up
  // exponentially); this length cap is the orthogonal source-length sanity bound.
  // It measures the COERCED source the factory actually compiles
  // (coerceToPatternString), not the raw value: a non-string param renders via
  // String(...) to the literal that compiles, and an array (`["a", "a", ...]`)
  // renders to an arbitrarily long source -- so capping only string-typed values
  // would let an array slip an oversized source past this bound. Dialect
  // conformance is enforced separately on LinkageTermsSchema.
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
   * - `edit_distances`: all single-character deletions up to the constraint
   *   `maxLength`.
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
 */
export interface LinkageKey {
  /** Human-readable name for this linkage key. */
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
 * `linkageKeys` -- the union of every element's `field`. The exchange standardizes
 * and consumes exactly these fields, so a caller filters its declared linkage
 * fields down to this set (a declared field no key references is read by nothing in
 * the exchange): the constraint sweep, the default-terms field derivation, and the
 * advanced-invite field derivation all apply the same
 * `field => referenced.has(field.name)` filter, and share this one definition of
 * "referenced" rather than re-deriving it.
 *
 * DISCLOSURE-RELEVANT: two of those callers -- the default-terms and
 * advanced-invite field derivations -- use the result to choose which
 * `linkageFields` enter the constructed terms, and so the cross-party terms hash
 * (the canonical encoding both parties agree on); only the constraint sweep is
 * warn-only and off the wire. A change to which names this set includes or excludes
 * therefore silently moves that hash and breaks interop, so it is in the
 * security-review scope: preserve the exact membership. A change here that altered a
 * constructed-terms field set would fail the field-set regression tests for the
 * default and advanced-invite paths (which derive one side without this function),
 * rather than silently moving the hash.
 *
 * `swap` does not widen the result: it only permutes `field` among a key's existing
 * elements at receive time, so the union over the authored (un-swapped) elements
 * already names every field any swapped order could reference. Callers pass keys as
 * authored, without resolving swap.
 *
 * This is the UNION, distinct from the per-key satisfiability predicate
 * (`key.elements.every(...)`) the satisfiability checker and {@link LinkageTermsSchema}'s
 * referential-integrity refine compute. The returned set may include a name that is
 * not a declared linkage field for a terms object not built through that schema
 * (whose refine forbids a dangling element `field`); used as a membership filter,
 * such a stray name matches no declared field and is harmless.
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
  description: z.string().max(MAX_TEXT_LENGTH).optional(),
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
  // validation; see boundedArray and the untrusted-input bounds note. The count
  // gate forestalls the `Invalid string length` RangeError a pathological-count
  // partner payload would otherwise raise (Zod accumulates one issue per invalid
  // column, then throws building the error string from millions of them).
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
export interface LegalAgreement {
  /** Identifier of the legal agreement (e.g. "MOU-2025-0042"). */
  reference: string;
  /**
   * Readable statement of the purpose or authority for the disclosure under
   * this agreement (e.g. "Audit and evaluation of the State tutoring
   * program"). A single agreement can authorize multiple purposes; this names
   * the one this exchange happened for. Carried in cleartext in the exchange
   * record so it stands alone as a HIPAA 164.528 accounting / FERPA 99.32
   * disclosure-log entry without opening the agreement. Metadata only -- never
   * a protected, linkage-field, or payload value.
   */
  purpose: string;
  /** Date after which the exchange will be refused (ISO 8601, YYYY-MM-DD). */
  expirationDate: string;
}

const LegalAgreementSchema: z.ZodType<LegalAgreement> = z.object({
  reference: z.string().min(1).max(MAX_NAME_LENGTH),
  purpose: z.string().min(1).max(MAX_TEXT_LENGTH),
  expirationDate: z.iso.date(),
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
 * - `version` — mandatory. Two versions are incompatible if no migration path
 *   exists.
 * - `identity` — none. Free-text identifying the holding party; recorded in
 *   the exchange record (the disclosure log).
 * - `date` — soft. A mismatch warns that one party may have a stale copy.
 * - `algorithm` — mandatory. `psi` reveals matched identifiers; `psi-c` reveals
 *   only the count.
 * - `output` — mandatory.
 * - `deduplicate` — mandatory. Per-party; determines if multiple inputs can be
 *   matched to the same output.
 * - `linkageFields` — mandatory.
 * - `linkageKeys` — mandatory.
 * - `legalAgreement` — mandatory if present. The `reference`, `purpose`, and
 *   `expirationDate` are cross-checked; any mismatch, or an `expirationDate`
 *   that has passed, cancels the exchange.
 * - `payload` — mandatory if present.
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
 *
 * TODO: versioning compatibility rules (migration paths between semver
 * versions).
 *
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
   * Consistency: none — parties may differ.
   */
  identity: string;
  /**
   * Date these linkage terms were last modified (ISO 8601, YYYY-MM-DD).
   * Consistency: soft — a mismatch warns rather than cancels the exchange.
   */
  date: string;
  /** `psi` reveals matched identifiers; `psi-c` reveals only the count. */
  algorithm: Algorithm;
  output: Output;
  /**
   * Whether this party's records may match more than one of the partners'.
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
  identity: z.string().min(1).max(MAX_TEXT_LENGTH),
  date: z.iso.date(),
  algorithm: AlgorithmSchema,
  output: OutputSchema,
  deduplicate: z.boolean(),
  // Element COUNT bounded at MAX_LINKAGE_ENTRIES before per-element validation,
  // with the existing .min(1) floor preserved; see boundedArray and the
  // untrusted-input bounds note. A plain .max() is insufficient: these flat
  // top-level arrays sit directly below the root, so a pathological count does
  // not overflow the call stack, but a partner array of millions of invalid
  // entries still makes Zod throw `Invalid string length` building its error from
  // one issue per entry, because .max() is checked only AFTER per-element
  // validation.
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
    // exchange time (buildStandardizedDataset builds only declared fields, so
    // getField returns undefined and the key collapses to null), producing a
    // silent empty/missed-match result byte-indistinguishable from a
    // legitimately empty intersection. Enforce it once here so no consumer ever
    // sees a dangling reference. The message names no partner-controlled value:
    // the parse-error path is left unsanitized (see protocolSetup and the test
    // pinning it), so the offending element is located by its issue `path`, not
    // by echoing its raw field string.
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
    // Reject a transform regex outside the linear-time dialect before it can run.
    // Element-transform regex patterns are partner-controlled and execute per row
    // over the full dataset, under the linear-time engine (utils/linearRegex.ts),
    // so they cannot backtrack catastrophically; this rejects a pattern that
    // engine cannot compile (a backreference, lookaround, or unsupported escape)
    // -- fail closed, before any execution and before both parties commit to terms
    // they could not evaluate identically. The check belongs here so every parse
    // path (initiator/joiner parseLinkageTerms, the invitation-token decode, and
    // ExchangeSpecSchema) inherits it. See transformRegexDialect.ts for the model
    // and docs/spec/PROTOCOL.md for the normative dialect. The message names no
    // partner-controlled value -- the offending pattern is located by inspection,
    // not echoed -- consistent with the unsanitized parse-error path the
    // referential-integrity refines above rely on.
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
    );

// --- Parse -------------------------------------------------------------------

/**
 * Keys whose object value the camelize pre-pass leaves verbatim once its key
 * count exceeds the bound, rather than rewriting every key (see
 * {@link camelizeKeys}). Only `transform.params` is partner-controlled and
 * key-count-bounded, so an over-count params record is handed to the schema --
 * whose own key-count refine rejects it -- without the multi-second snake->camel
 * rewrite a pathological-count payload would otherwise incur (item 202722105):
 * the pre-pass counts its keys but does not rewrite them. The bound matches
 * {@link MAX_PARAMS_ENTRIES}, so any record the pre-pass leaves verbatim here is
 * one the schema also rejects.
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
 * decoded from an invitation. The acceptor adopts the inviter's shared, agreed
 * fields verbatim -- `version`, `algorithm`, `linkageFields`, `linkageKeys`,
 * `legalAgreement`, and so on are cross-checked for equality at exchange time,
 * so both sides must carry an identical set -- but two facets are the acceptor's
 * own perspective and are derived, not copied:
 *
 * - `identity` is replaced with the acceptor's own name, so the inviter's
 *   identity does not leak into the acceptor's prepared terms (and from there
 *   into its exchange record).
 * - `output` is MIRRORED, not copied. {@link validateCompatibility}, run by both
 *   parties, compares output as a mirror: it requires
 *   `local.output.shareWithPartner === partner.output.expectsOutput` and
 *   `local.output.expectsOutput === partner.output.shareWithPartner`. So the
 *   acceptor's `expectsOutput` is the inviter's `shareWithPartner`, and the
 *   acceptor's `shareWithPartner` is the inviter's `expectsOutput`. A verbatim
 *   copy is only ACCIDENTALLY correct for the symmetric "both receive" case
 *   (`expectsOutput` and `shareWithPartner` both true, where each value equals
 *   its mirror); for any one-sided configuration a copy makes both sides claim to
 *   receive, fails the mirror, and aborts the exchange before any data moves.
 *
 * - `payload` is MIRRORED, for the same reason as `output`:
 *   {@link validateCompatibility} compares payload as a `send` <-> `receive` mirror,
 *   so the acceptor's `send` is the inviter's `receive` and its `receive` is the
 *   inviter's `send`. A verbatim copy is only accidentally correct for symmetric
 *   payload; the common invite/accept shape (the inviter authors a `send` and no
 *   `receive`) fails the mirror under a copy. With the inviter's `receive` absent,
 *   the acceptor's `send` comes out absent -- which is correct: the acceptor's own
 *   transmission is governed by its metadata, and the inviter is lazy about what it
 *   receives (an unauthored `receive` is not cross-checked; see
 *   {@link validateCompatibility}). The acceptor's `receive` becomes the inviter's
 *   `send`, so the acceptor validates exactly what it will get.
 *
 * `deduplicate` is left as adopted from the inviter's terms. It is per-party in
 * principle, but the web Advanced-options editor and the CLI default acceptance
 * never author it one-sided (`deduplicate` stays false), so for the configurations
 * those front ends produce a verbatim adoption is correct and the mirror is always
 * coherent. Metadata and standardization stay per-party and local (they are never
 * embedded in the token); this function shapes only the agreed linkage terms.
 *
 * It fails closed. A config that is valid for the INVITER can mirror to one that is
 * incoherent for the acceptor: an inviter that is the sole receiver (it shares no
 * result with the partner) may carry `deduplicate: true` or a non-empty
 * `payload.send`, both of which require the PARTNER to receive output --
 * `deduplicate` is adopted onto the acceptor, and the inviter's `send` mirrors to
 * the acceptor's `receive` -- but the acceptor mirrors to `expectsOutput: false`,
 * which the schema's cross-field rules forbid. (The inviter's own `payload.receive`
 * mirrors to the acceptor's `send`, which needs no output, so it is never the
 * trigger.)
 * The front ends above never produce such an inviter config, but a hand-authored
 * CLI config or a crafted invitation token could, and the derived terms are not
 * otherwise re-validated before the run. So the derived terms are re-checked
 * against {@link LinkageTermsSchema} here and an incoherent result throws, aborting
 * acceptance cleanly rather than running an invalid configuration. The thrown
 * message names no partner-controlled value (the only reachable failures are the
 * fixed-message output-coherence refines, since the inviter's terms were already
 * validated at decode and only `identity`/`output` are changed here).
 *
 * @throws {Error} when the inviter's terms cannot be coherently accepted for the
 *   mirrored output direction.
 */
export function deriveAcceptedLinkageTerms(
  inviterTerms: LinkageTerms,
  acceptorIdentity: string,
): LinkageTerms {
  const derived: LinkageTerms = {
    ...inviterTerms,
    identity: acceptorIdentity,
    output: {
      expectsOutput: inviterTerms.output.shareWithPartner,
      shareWithPartner: inviterTerms.output.expectsOutput,
    },
  };
  // Mirror the payload `send`/`receive` (see the doc comment). Built explicitly so
  // an absent inviter `receive` yields an absent acceptor `send` (rather than an
  // empty list), keeping the acceptor lazy on a direction the inviter left open.
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
        "yet its terms also have the accepting party deduplicate or receive " +
        "payload columns the inviter sends -- neither is possible for a party " +
        "that receives no result. Ask the inviter to share the result, or to " +
        "drop those settings.",
    );
  }
  return derived;
}

// --- Compatibility -----------------------------------------------------------

export interface CompatibilityResult {
  errors: string[];
  warnings: string[];
}

/**
 * Cross-party consistency check for a pair of {@link LinkageTerms}.
 *
 * Returns errors for mandatory mismatches that must cancel the exchange, and
 * warnings for soft mismatches (currently only `date`) that produce a notice
 * but allow the exchange to continue.
 */
export function validateCompatibility(
  local: LinkageTerms,
  partner: LinkageTerms,
): CompatibilityResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Every value interpolated into an operator-facing message below -- both the
  // local and the partner side of a mismatch -- is routed through
  // sanitizeForDisplay. The threat is the partner side: a mutually-distrusting
  // party controls reference/purpose/identity/column names, and raw ANSI/control
  // characters or deceptive Unicode there could spoof or mislead in the local
  // operator's logs or UI. The local values are the operator's own validated
  // config, so sanitizing them is a no-op today; they take the same path anyway,
  // for uniformity (no future edit reintroduces a raw interpolation beside a
  // sanitized one) and defense in depth (a loosened schema bound stays covered).
  // The equality CHECKS always compare the RAW values -- sanitizing is
  // display-only and lossy (it truncates), so comparing sanitized forms could
  // mask a genuine mismatch.
  if (local.version !== partner.version) {
    // TODO: implement migration when new versions exist
    errors.push(
      `version mismatch: local is ${sanitizeForDisplay(local.version)}, ` +
        `partner is ${sanitizeForDisplay(partner.version)}`,
    );
  }

  if (local.algorithm !== partner.algorithm) {
    errors.push(
      `algorithm mismatch: local is ${sanitizeForDisplay(local.algorithm)}, ` +
        `partner is ${sanitizeForDisplay(partner.algorithm)}`,
    );
  }

  if (local.output.shareWithPartner !== partner.output.expectsOutput) {
    errors.push(
      "output mismatch: local " +
        (local.output.shareWithPartner ? "will" : "will not") +
        " share with partner, but partner " +
        (partner.output.expectsOutput ? "expects" : "does not expect") +
        "output",
    );
  }
  if (local.output.expectsOutput !== partner.output.shareWithPartner) {
    errors.push(
      "output mismatch: local " +
        (local.output.expectsOutput ? "expects" : "does not expect") +
        " output, but partner " +
        (partner.output.shareWithPartner ? "will" : "will not") +
        " share",
    );
  }
  if (!local.output.expectsOutput && !partner.output.expectsOutput) {
    errors.push("neither party expects output");
  }

  if (local.date !== partner.date) {
    warnings.push(
      `date mismatch: local is ${sanitizeForDisplay(local.date)}, partner ` +
        `is ${sanitizeForDisplay(partner.date)}; one party may have a stale ` +
        "copy of the linkage terms",
    );
  }

  // Compare by canonical form (RFC 8785): two field/key sets are equal iff their
  // canonical encodings match -- the same encoding that is hashed into the
  // exchange-agreement receipt, so equality here means hash-equality there. The
  // canonical encoder sorts keys, so property-insertion order (which differs
  // between plain and Zod-parsed objects) does not affect the result; fields are
  // pre-sorted by name because their array order is not significant, whereas
  // linkage keys are ordered most-to-least precise and compared in place.
  //
  // No casing fold is applied here: `transform.params` keys (the only
  // partner-controlled keys whose form could vary) are normalized to camelCase at
  // every parse chokepoint that produces a LinkageTerms -- config load and the
  // post-handshake wire path via parseLinkageTerms, and the invitation decode path
  // via its own camelize pre-pass (config/invitation.ts) -- so both sides reach
  // this comparison in the one camelCase form. The encoder sorts keys but does not fold casing, which
  // is why the normalization is a parse-layer invariant rather than something this
  // comparison re-does (and why the agreed-terms hash, which also does not fold,
  // stays cross-party reproducible: it hashes the same camelCase form).
  //
  // canonicalString throws CanonicalEncodingError on a value outside the
  // reproducible domain. A partner can reach this: transform `params` is
  // `z.unknown()`, so a JSON integer beyond 2^53 survives schema parsing and
  // then fails to canonicalize. validateCompatibility's contract is to report
  // problems via `errors` (its callers abort the exchange on a non-empty list),
  // not to throw, so surface such a value as an error instead of crashing.
  //
  // When canonicalOrError returns null the value could not be encoded, so the
  // mismatch comparisons below are skipped for that side: an un-encodable value
  // cannot be compared, and emitting "do not match" on top of the encoding
  // error would be misleading. The encoding error already aborts the exchange.
  // The cost is diagnostic only -- if one side is both un-encodable AND differs,
  // the operator sees the encoding error first and the divergence on a re-run.
  const canonicalOrError = (value: unknown, label: string): string | null => {
    try {
      return canonicalString(value);
    } catch (err) {
      if (err instanceof CanonicalEncodingError) {
        errors.push(`${label} cannot be canonically encoded: ${err.message}`);
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
    "local linkage fields",
  );
  const partnerFieldsCanonical = canonicalOrError(
    partnerFields,
    "partner linkage fields",
  );
  if (
    localFieldsCanonical !== null &&
    partnerFieldsCanonical !== null &&
    localFieldsCanonical !== partnerFieldsCanonical
  ) {
    errors.push("linkage fields do not match");
  }

  const localKeysCanonical = canonicalOrError(
    local.linkageKeys,
    "local linkage keys",
  );
  const partnerKeysCanonical = canonicalOrError(
    partner.linkageKeys,
    "partner linkage keys",
  );
  if (
    localKeysCanonical !== null &&
    partnerKeysCanonical !== null &&
    localKeysCanonical !== partnerKeysCanonical
  ) {
    errors.push("linkage keys do not match");
  }

  if (
    local.legalAgreement !== undefined ||
    partner.legalAgreement !== undefined
  ) {
    if (local.legalAgreement === undefined) {
      errors.push("partner has a legal agreement but local does not");
    } else if (partner.legalAgreement === undefined) {
      errors.push("local has a legal agreement but partner does not");
    } else {
      if (local.legalAgreement.reference !== partner.legalAgreement.reference) {
        errors.push(
          "legal agreement reference mismatch: local is " +
            `"${sanitizeForDisplay(local.legalAgreement.reference)}", ` +
            `partner is "${sanitizeForDisplay(partner.legalAgreement.reference)}"`,
        );
      }
      if (local.legalAgreement.purpose !== partner.legalAgreement.purpose) {
        errors.push(
          "legal agreement purpose mismatch: local is " +
            `"${sanitizeForDisplay(local.legalAgreement.purpose)}", ` +
            `partner is "${sanitizeForDisplay(partner.legalAgreement.purpose)}"`,
        );
      }
      if (
        local.legalAgreement.expirationDate !==
        partner.legalAgreement.expirationDate
      ) {
        errors.push(
          "legal agreement expiration date mismatch: local is " +
            `${sanitizeForDisplay(local.legalAgreement.expirationDate)}, ` +
            `partner is ${sanitizeForDisplay(partner.legalAgreement.expirationDate)}`,
        );
      }
      const today = new Date().toISOString().slice(0, 10);
      if (local.legalAgreement.expirationDate < today) {
        errors.push(
          "legal agreement expired on " +
            `${sanitizeForDisplay(local.legalAgreement.expirationDate)}`,
        );
      }
    }
  }

  // Payload mirror, LAZY on the receive side. Each of the two directions is gated
  // on whether the RECEIVING party declared a `payload.receive` expectation:
  //
  // - `receive` DECLARED (the field is present, even if empty) asserts "I expect
  //   exactly these columns": the partner's `send` must match it byte-for-byte or
  //   the exchange aborts -- the strict mirror, unchanged. This is the recurring /
  //   loaded-config case, where both parties carry an agreed payload.
  // - `receive` ABSENT means "take whatever I'm given": that direction is skipped.
  //   This is what lets the invite/accept flow reconcile without the inviter
  //   knowing the acceptor's schema. The inviter authors only its `send` and leaves
  //   `receive` unset (lazy); the acceptor mirrors the inviter's `send` into its own
  //   `receive` and so validates exactly what it will get; and the inviter accepts
  //   whatever the acceptor discloses. A zero-setup exchange, which authors no
  //   payload, is lazy on both sides.
  //
  // Laziness relaxes only this cross-party DECLARATION check; it never widens what a
  // party sends. Transmission is governed by each party's own metadata
  // (`isDisclosedToPartner`) and the forward-only `assertPayloadSendDisclosed`, both
  // unchanged -- so a lazy receiver accepts only what the sender's own consented
  // metadata discloses, and receiving is not disclosing. The gate is symmetric: each
  // direction keys on the same receiver's declared `receive`, so the two parties
  // (which call this with swapped arguments) compute identical verdicts. Names are
  // displayed sanitized (partner-controlled free text) while the equality is
  // byte-exact and element-wise -- compared per sorted column, NOT by a
  // delimiter-joined string, so a partner-controlled name containing the separator
  // cannot make two distinct sets join equal (`["a,b"]` vs `["a","b"]`) and slip a
  // genuine mismatch past the check. Matching the messages elsewhere.
  const sameColumnSet = (a: Array<string>, b: Array<string>): boolean =>
    a.length === b.length && a.every((name, i) => name === b[i]);

  if (partner.payload?.receive !== undefined) {
    const partnerReceiveNames = partner.payload.receive
      .map((c) => c.name)
      .sort();
    const localSendNames = (local.payload?.send ?? [])
      .map((c) => c.name)
      .sort();
    if (!sameColumnSet(localSendNames, partnerReceiveNames)) {
      const localShown = localSendNames
        .map((n) => sanitizeForDisplay(n))
        .join(",");
      const partnerShown = partnerReceiveNames
        .map((n) => sanitizeForDisplay(n))
        .join(",");
      errors.push(
        `payload mismatch: local send columns [${localShown}] do not match ` +
          `partner receive columns [${partnerShown}]`,
      );
    }
  }

  if (local.payload?.receive !== undefined) {
    const localReceiveNames = local.payload.receive.map((c) => c.name).sort();
    const partnerSendNames = (partner.payload?.send ?? [])
      .map((c) => c.name)
      .sort();
    if (!sameColumnSet(localReceiveNames, partnerSendNames)) {
      const localShown = localReceiveNames
        .map((n) => sanitizeForDisplay(n))
        .join(",");
      const partnerShown = partnerSendNames
        .map((n) => sanitizeForDisplay(n))
        .join(",");
      errors.push(
        `payload mismatch: local receive columns [${localShown}] do not ` +
          `match partner send columns [${partnerShown}]`,
      );
    }
  }

  return { errors, warnings };
}
