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
// rewritten or per-key-validated. Legitimate sizes vary -- a
// denylist holds hundreds of values, hence the most generous bound
// (MAX_EXCLUDE_ENTRIES) -- but each bound is far above any real config and far
// below the RangeError thresholds. The `params` VALUE content carries a uniform
// content bound of its own: every STRING value of the record is capped at
// MAX_TRANSFORM_PARAM_LENGTH by the record's value stage, whatever the function
// and param name, because a string param sizes what the rest of the element
// pipeline receives on every row. A non-string value stays `z.unknown()`. Above
// that uniform floor sit the stricter per-function caps, each a per-step refine
// on TransformStep's schema below, for the params whose magnitude drives
// unbounded per-row work in a shape a string length does not describe:
// `pad_left`'s numeric `length` (an unbounded `padStart` allocation,
// MAX_PAD_LEFT_LENGTH), `parse_date`'s `inputFormat` / `outputFormat` strings (an
// unbounded per-row regex build and output allocation, MAX_DATE_FORMAT_LENGTH),
// and the four `tier: "regex"` functions' raw `pattern` / `delimiter` (an
// unbounded per-row regex compile under the linear-time engine, measured on the
// COERCED source so a non-string param renders no larger a compile source,
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
 *
 * Those four fields are exactly the document's free-text set, and they carry the
 * shape rule beside this one as a set too: see
 * {@link TEXT_CONTROL_CHAR_PATTERN}, which is applied to each of them without
 * exception.
 */
export const MAX_TEXT_LENGTH = 1024;

/**
 * The control characters no free-text field of a terms document may carry: the
 * C0 range (NUL among them), DEL, and C1. The rule reaches every
 * {@link MAX_TEXT_LENGTH}-bounded field the document holds -- the party
 * `identity`, the legal-agreement `purpose`, a payload column `description`, and
 * each constraint `exclude` entry -- with no field spared and no exception for
 * tab, line feed, or carriage return. Each of the four is a single-line value: a
 * party label, a one-sentence statement of the disclosure's purpose, a data-
 * dictionary line, and a data value a cell is compared against. None of them is
 * the multi-line note a whitespace-control exception exists for, so no control
 * byte in any of them is text a party meant to write.
 *
 * The reason the refusal sits at the schema rather than at each display sink is
 * that the sinks are not the whole reach of these values. A terms document is
 * swapped with the partner at exchange time and folded into the canonical
 * encoding both parties hash, and three of the four fields are written verbatim
 * into each party's exchange record, which is kept and read back long after the
 * run: the two parties' identities, the agreement `purpose`, and a payload
 * column's `description` (exchangeRecord.ts). A constraint `exclude` value
 * reaches no exchange record -- the record's account of the matching basis
 * carries a field's name and semantic type, never a constraint -- but it does
 * persist past the live document: `psilink accept` provisions a configuration
 * from the adopted terms, and `saveConfig` serializes the whole of them,
 * constraints included, into the acceptor's YAML config, which is itself
 * parsed back through this schema, so a control character still cannot ride
 * it that way either. The seams that
 * neutralize a control character (sanitizeErrorForDisplay.ts,
 * compatibilityMessage.ts) act where psilink itself renders one, not where a
 * later reader of the record opens it. Every seat that parses a LIVE terms
 * document shares this schema -- the operator's own config load and the
 * post-handshake wire re-parse (parseLinkageTerms), the invitation-token decode,
 * and the exchange-file and job-intent schemas that embed
 * {@link LinkageTermsSchema} -- so one refusal at parse covers all of them,
 * rather than each of those consumers carrying a guard of its own.
 *
 * The live document is the whole of the rule's reach, and two readers of values
 * already recorded sit outside it by design: the exchange-record reader
 * (exchangeRecord.ts) and the wire-certificate schema (signedReceipt.ts)
 * length-bound their free-text fields and apply no control-character rule. The
 * record reader is a frozen-log reader whose invariant is to accept what a
 * possibly-different-version writer recorded, and what either of them carries is
 * left to the display-escaping seams wherever psilink renders it.
 *
 * Letters outside ASCII are untouched: the ranges stop below U+00A0, so a party
 * that writes its name, its purpose, or its denylist in its own script is
 * admissible.
 *
 * The web console draws these same ranges over an operator's `--identity` label
 * (`IDENTITY_CONTROL_CHAR_PATTERN`, apps/web/src/psi/identityLabel.ts), a label
 * that becomes the `identity` of a terms document this schema then reads; the two
 * are held equal by the web suite's parity check
 * (apps/web/test/unit/identityLabelParity.test.ts) rather than by this note. The
 * console contract is strictly stricter -- the boundaries that apply it also
 * refuse a leading `-`.
 */
export const TEXT_CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * The one reason all four free-text fields report, so the document says the same
 * thing about the same class of value wherever it is refused.
 *
 * A fixed literal naming no submitted value: the offending field is located by
 * the issue `path`, which `describeDecodeError` escapes segment by segment. That
 * is the discipline the referential-integrity, dialect, and length refusals in
 * this file already follow, and the unsanitized parse-error path (protocolSetup)
 * depends on it -- a message echoing the value would put the partner's bytes
 * back in front of the operator, which is the very thing this rule removes.
 */
export const TEXT_CONTROL_CHAR_MESSAGE =
  "a linkage terms free-text value must not contain control characters";

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
 * a NUMERIC param value, so the uniform string bound
 * ({@link MAX_TRANSFORM_PARAM_LENGTH}) does not describe it and this per-function
 * cap is the only thing that does (the rest of the bounds in this file cap
 * COLLECTION counts, see the untrusted-input bounds note above).
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
 * `parse_date` transform step -- stricter than the uniform string bound every
 * param value carries ({@link MAX_TRANSFORM_PARAM_LENGTH}), because these two
 * drive a per-row regex build rather than a one-time allocation (see the
 * untrusted-input bounds note above).
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
 * (standardization.ts), which bounds that -- a former-ReDoS format is driven in
 * linkageTerms.test.ts and linearRegex.test.ts -- so this cap is a
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
 * Upper bound on the length of a STRING-valued partner-controlled transform
 * param -- the uniform content bound under the per-function caps above, applied
 * to every entry of a `transform.params` record whose value is a string,
 * whatever function or param name it sits under.
 *
 * A string param sizes what the rest of the element pipeline receives on every
 * row, so its length is per-row work regardless of which function reads it: a
 * `replace_regex` `replacement` rewrites the operator's own cell into a value of
 * the replacement's size, which every later step of that element carries, and
 * which the fuzzy expansion replicates across a row's candidates
 * ({@link MAX_FUZZY_EXPANSION_INPUT_LENGTH} bounds only the value the fuzzy
 * element itself expands, never a sibling element's transformed cell). Without a
 * content bound that size is held only by the ~512 MiB frame ceiling
 * (connection/frameSize.ts). The bound is uniform across params rather than
 * per-amplifier so content cannot be routed through a param no measurement
 * covered, and it is deliberately the same threshold as the raw pattern beside it
 * ({@link MAX_TRANSFORM_PATTERN_LENGTH}), so no string param in a record is more
 * generous than the pattern it accompanies. A real param value is a few
 * characters to a few hundred -- a replacement literal, a `coalesce` default, a
 * `null_if` value -- so 1000 is far above any legitimate authoring and three
 * orders of magnitude below an amplification that matters.
 *
 * Enforced on the `params` record's VALUE stage (see {@link TransformStep}'s
 * schema) before any row runs, so every path that parses partner terms inherits
 * it, and the offending param is located by the issue `path` rather than echoed
 * -- consistent with the unsanitized parse-error path the referential-integrity
 * and dialect refines rely on.
 *
 * It reaches a string VALUE of the record, not a string nested inside an array-
 * or object-valued param: no factory derives a per-row value from a nested string
 * (`null_if` compares its `values` entries against the cell and emits the cell or
 * null; every other factory that reads a string param falls back to its default
 * for a non-string, pinned in standardization.test.ts), and an array param a
 * regex factory would render into a compile source is separately bounded on the
 * COERCED source by {@link MAX_TRANSFORM_PATTERN_LENGTH}.
 *
 * What it removes is the partner's ability to supply an unbounded-LENGTH param,
 * not the ability to amplify the value a row derives from one: this cap does not
 * bound the transformed value, because a `replace_regex` replacement is a
 * substitution TEMPLATE whose match-context sequences re-insert the operator's
 * own cell at every match position, and transform steps compose. The produced
 * value carries its own ceiling where the row runs, on what a key element reads
 * and on what each of its steps produces (`MAX_TRANSFORMED_VALUE_LENGTH` in
 * standardization.ts), so the two bounds are complementary: this one is what the
 * partner may WRITE, that one what a row may DERIVE. The substitution sequences
 * keep their wire meaning under it.
 *
 * A DoS ceiling on the partner wire path, not a semantic limit: an in-range value
 * is preserved verbatim, never clamped, since both parties must derive
 * byte-identical keys.
 */
export const MAX_TRANSFORM_PARAM_LENGTH = 1000;

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
  // empty class).
  //
  // The length short-circuit in the refine is a real pre-compile gate, not an
  // ordering assumption: a failed `.max()` does NOT stop the refine from running
  // (Zod does not short-circuit chained checks), so without the guard an oversized
  // partner-controlled value would be interpolated into `[${val}]` and compiled
  // under re2js -- super-linear in length, a multi-second synchronous stall. An
  // over-length value passes the refine so `.max()` rejects it on length alone;
  // only an in-length class reaches patternConformsToDialect.
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
// content bound on a string. The bound is on the VALUE STAGE rather than a
// per-step refine so it holds for every function and every param name at once --
// including a function this build does not implement -- which is what makes it
// undodgeable by routing content through a param no per-function refine covers.
// A non-string value passes through untouched (`z.unknown()`), leaving each
// factory's own runtime coercion contract unchanged; the params whose non-string
// magnitude drives per-row work carry their own stricter refines on
// TransformStepSchema below. See MAX_TRANSFORM_PARAM_LENGTH for the model and the
// bound's stated reach.
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
  // The record's KEYS are partner-controlled strings (parameter names), so they
  // are length-bounded like every other free-text string, and each string VALUE
  // is length-bounded by TransformParamValueSchema above. The entry COUNT is
  // bounded at MAX_PARAMS_ENTRIES, and -- critically -- that gate is a bare key
  // count (see exceedsOwnKeyCount) that runs BEFORE the per-key length check. The
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
  // sanitization -- intact for an in-range over-long key, and carries the
  // per-value content bound for an in-range one.
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

// Per-function content bounds, stricter than the uniform string bound every param
// value already carries (TransformParamValueSchema), on the partner-controlled
// VALUES whose magnitude drives per-row work in a shape a string length does not
// describe: a number, a per-row regex build, and a compile source read off a value
// of any type. Each is a per-step refine on this wire schema -- not on the editor
// descriptor an attacker-authored token never passes through -- and each message
// names no partner value, consistent with the unsanitized parse-error path the
// referential-integrity and dialect refines rely on.
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
  // source-parse cost (see MAX_TRANSFORM_PATTERN_LENGTH). The engine bounds
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
  )
  // `substring` slices by numeric `start` / `length`. A non-integer bound never
  // slices as intended -- substringFactory drops it to an all-null fn, so the
  // step silently excludes every row rather than erroring. Reject a present
  // non-integer bound at parse instead, mirroring the descriptor schema's own
  // `int` requirement. An ABSENT bound drops every row just the same, and is
  // deliberately admitted here rather than rejected: it is refused one layer up,
  // by the dead-pipeline grading (`pipelineAlwaysDrops` via
  // `substringWindowDropsEveryValue`), which reaches every degenerate window
  // this shape-level refine cannot express -- a `start` of 0, a `length` of 0 --
  // and locates the offender by key rather than costing the whole document its
  // parse.
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
 * drawn from. The fields and the keys are separately named and separately
 * versioned: the fields are a generic substrate (which PII is matched on and how
 * each element is cleaned) where the keys are specific (which combinations count
 * as a match, and in what cascade order), and an edit to one leaves the other's
 * citation untouched.
 *
 * A citation, not a specification: the fields and keys a run actually matched on
 * are the terms document's own `linkageFields` and `linkageKeys`, which travel
 * with the exchange and are compared between the parties whole. Terms derived
 * from an input file leave out any key that input cannot supply, so a reference
 * is an upper bound on what was tried rather than the account of what ran.
 *
 * Optional throughout: terms whose rules were authored rather than drawn from a
 * named set carry no reference, and the absence is the honest statement rather
 * than a default.
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
 * The set names are free text a partner chooses, so each is rendered as one
 * delimited run through the compatibility-message seam
 * ({@link quoteTermsValue}): a name carrying a space, the clause's own " over ",
 * or a delimiter of its own reads as content of one value rather than as
 * structure this clause asserted. The versions are schema-constrained semver, so
 * they take the seam's checked bare form ({@link bareTermsValue}) and read as
 * prose -- falling back to the delimited form for a value that does not meet the
 * shape, which is what keeps the reading of "schema-constrained" executable here
 * rather than assumed of a caller.
 */
function describeRuleSet(
  reference: LinkageRuleSetReference,
): CompatibilityMessageFragment {
  return compatibilityMessage`${quoteTermsValue(reference.keySet.name)} ${bareTermsValue(reference.keySet.version)} over ${quoteTermsValue(reference.fieldSet.name)} ${bareTermsValue(reference.fieldSet.version)}`;
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
   *
   * Absent when the party supplied no name: psilink invents none, so nothing
   * fills the gap and no surface stands a label in it (`partyIdentityDisplay.ts`
   * carries the marker every surface shows instead). The commands that
   * author a durable partnership -- `psilink invite` and `psilink accept` --
   * require one at their own interface, so the field is absent only on a run
   * that authored its terms without a name.
   *
   * Consistency: none -- parties may differ, and either may carry none.
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
  linkageRuleSet: LinkageRuleSetReferenceSchema.optional(),
  payload: PayloadSchema.optional(),
  legalAgreement: LegalAgreementSchema.optional(),
});

// --- Count-only (psi-c) shape ------------------------------------------------

/**
 * Which of the count-only shape rules a `psi-c` terms document breaks. The
 * terms-carried rules only: the fifth refusal the specification lists reads this
 * party's own INPUT METADATA, which no linkage-terms document carries, and lives
 * beside the disclosure predicate it asks
 * ({@link countOnlyTransmitsColumn}, `config/metadata.ts`).
 */
export type CountOnlyShapeViolation =
  "linkageKeys" | "linkageStrategy" | "deduplicate" | "payload";

/**
 * The refusal message for each count-only shape rule, keyed by the rule broken.
 * One message per rule, read by every enforcement point -- the
 * {@link LinkageTermsSchema} refines below (so every parse path refuses),
 * {@link assertCountOnlyTermsShape} (the authoring, mint, and accept
 * boundaries), and the surfaces' own gates -- so an operator meets the same
 * account of what is wrong wherever the document is stopped.
 *
 * Each message names the rule broken and the two ways out: bring the document
 * into the count-only shape, or ask for the identifier-revealing algorithm that
 * admits it. Fixed literals only, never a value read off the document: a
 * `psi-c` document can arrive on a partner's invitation, and the parse-error
 * path is left unsanitized (see protocolSetup), which is the same reason the
 * referential-integrity refines locate an offender by issue `path` rather than
 * by echoing it.
 *
 * The rules and the reasoning behind each are docs/spec/PROTOCOL.md, PSI-C.
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
    "intersection and nothing else, so it carries no data column whichever " +
    "party the terms entitle to the count. Remove the payload send and " +
    'receive columns, or set the algorithm to "psi".',
  transmittedColumns:
    'a count-only ("psi-c") exchange transmits no data columns, but this ' +
    "input's metadata marks one or more columns to send to the partner. The " +
    "algorithm carries no payload in either direction, so the exchange is " +
    "refused rather than run over a disclosure it cannot make. Clear the " +
    'payload marking on those columns, or set the algorithm to "psi".',
};

/**
 * Which count-only shape rule a terms document breaks, or `undefined` when it
 * breaks none -- including for every `psi` document, which these rules leave
 * untouched.
 *
 * The single reading of the specified shape (docs/spec/PROTOCOL.md, PSI-C: one
 * key, one round, cascade only, no deduplication, no payload), so the schema,
 * the asserts, and the two front ends' own gates cannot come to different
 * verdicts about the same document. Order is the specification's listing order;
 * a document breaking several rules reports the first, and fixing it surfaces
 * the next.
 *
 * A document already in the specified shape is NOT a violation here: whether the
 * algorithm has a run path at all is the algorithm gate's question
 * (`assertAlgorithmImplemented`), a statement about what this build implements
 * rather than about the document.
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
 * Refuse a `psi-c` terms document outside the shape the specification admits,
 * fail-closed: an over-broad count-only document is never narrowed to one key,
 * never promoted off `cascade`, never partially derived, and never downgraded to
 * a `psi` run -- narrowing would deliver a disclosure the operator did not agree
 * to, and downgrading would reveal the matched identifiers under terms that
 * asked for a count.
 *
 * Applied where a document is authored or minted into an invitation, and again
 * where a received one is accepted ({@link deriveAcceptedLinkageTerms}); every
 * PARSE path inherits the same rules from {@link LinkageTermsSchema}'s refines,
 * so a document that reached a caller through a schema already met them and this
 * is the boundary for one built or mutated without a parse.
 *
 * This rule is the count-only algorithm's own constraint, distinct from the
 * combinations `assertDeduplicateImplemented` and `resolveLinkageCardinality`
 * refuse for want of a matching path: a count-only run reports a size and hands
 * neither party a record-by-record result, so there is no multiplicity for it to
 * honor whatever the cascade implements. It reaches the parse and accept
 * boundaries those two do not.
 *
 * Plain {@link UsageError}, deliberately NOT an `OperatorConfigError`, for the
 * same reason as `assertAlgorithmImplemented`: on the accept side these values
 * are adopted verbatim from the partner's invitation, so the fault is not
 * unconditionally this operator's own content. The messages carry only fixed
 * literals.
 */
export function assertCountOnlyTermsShape(terms: LinkageTerms): void {
  const violation = countOnlyShapeViolation(terms);
  if (violation === undefined) return;
  throw new UsageError(COUNT_ONLY_SHAPE_REFUSALS[violation]);
}

/**
 * Which linkage strategies realize a deduplicating match, one entry per
 * strategy. Both do: the cascade re-expands a match on a kept value across the
 * group in each round (`linkViaPSI`), and `single-pass` applies the same per-side
 * rules in the receiver's local replay over the index table it already ships
 * (`linkViaSinglePassPSI`).
 *
 * A total table over {@link LinkageStrategy} rather than a comparison against one
 * named strategy: a strategy added to the union states its own verdict here or
 * the build fails, so neither the refusal below nor the consent copy that reads
 * the same verdict can be left behind by an addition. That is what the table is
 * for while no shipped strategy answers `false`: the entry is where a new strategy
 * declares it cannot match a group, and the refusal below is what then stops the
 * run. Typed `boolean` rather than the literal values so each reader's gate gives
 * a genuine runtime branch.
 *
 * @internal exported for the tests that drive its readers over every strategy,
 * here and in the web editor's own Generate gate.
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
 * {@link assertDeduplicateImplemented} refuses the pair it returns `false` for,
 * and the consent summary's `deduplicateApplied` withholds the grouping
 * disclosure copy on the same answer (`invitationSummary.ts`). Stating it twice
 * would let the copy stay withheld for a strategy the refusal had stopped
 * refusing -- a silent divergence, since each side's own tests keep passing.
 */
export function deduplicateIsImplementedForStrategy(
  strategy: LinkageStrategy,
): boolean {
  return DEDUPLICATE_IMPLEMENTED_BY_STRATEGY[strategy];
}

/**
 * Refuse a linkage-terms `deduplicate: true` the run cannot honor, before any
 * matching begins: the term under a linkage strategy that does not match a
 * deduplicating cardinality ({@link deduplicateIsImplementedForStrategy}).
 *
 * Both shipped strategies match one (`linkViaPSI` and `linkViaSinglePassPSI`), and
 * the surfaces downstream of the association table -- the payload frame, the output
 * table, and the exchange record with its re-supply path -- carry a table with
 * several links per record, so this refuses nothing an operator can configure
 * today. It stays as the boundary a strategy answering `false` in
 * {@link DEDUPLICATE_IMPLEMENTED_BY_STRATEGY} is stopped at: refusing the pair here
 * puts the answer where the operator is still configuring, rather than mid-round
 * against terms that asked for a group, and keeps the strategy's own guard as the
 * second, fail-closed half rather than the first. The combination that IS refused
 * today is the agreed `(true, true)` pair under a strategy that pairs no
 * both-sided cardinality, which this guard cannot express: it reads one party's
 * document, where that pair is a property of BOTH. Its own boundary is
 * {@link assertBothSidedDeduplicateImplemented}.
 *
 * Applied where a document is authored or minted, at the local prepare step
 * (`prepareForExchange`), where a received invitation is accepted
 * ({@link deriveAcceptedLinkageTerms}), and for both parties' agreed terms by
 * `resolveLinkageCardinality` after the terms exchange, before the PSI rounds
 * begin. The accept boundary is what keeps a crafted pair off the consent
 * surfaces: an acceptance refused here reaches neither a consent display nor a
 * connection, so no surface states what a deduplicating run discloses for a run
 * that cannot happen.
 *
 * It sits beside {@link assertCountOnlyTermsShape} rather than in `exchange.ts`
 * for the reason that guard does: the accept path is here, and importing the run
 * module from it would close an import cycle.
 *
 * Reads the whole terms document rather than the two values, so a caller cannot
 * pass one party's `deduplicate` against the other's strategy. `linkageStrategy`
 * is a mandatory-consistency term, so the agreed pair carries one value and both
 * parties reach the same verdict from their own copy; the resolver asserts over
 * both documents regardless, which makes the refusal symmetric in the pair even
 * where the consistency check has not run.
 *
 * Plain {@link UsageError}, deliberately NOT an `OperatorConfigError`, for the
 * same reason as `assertAlgorithmImplemented`: the refusing party is not
 * necessarily the one whose value refuses, since `resolveLinkageCardinality`
 * asserts over the PARTNER's terms document as well as its own, and the accept
 * boundary reads the partner's invitation, so the fault is not unconditionally
 * this operator's own content. The message carries only fixed literals.
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
 * Which linkage strategies pair the BOTH-sided deduplicating cardinality, one
 * entry per strategy. The cascade does, applying the "many" rule to each party so
 * a matched value contributes the two groups' product; `single-pass` does not --
 * its seam holds the resolved table to a length taken from the half that keeps its
 * distinctness, and a both-sided multiplicity leaves neither half holding it
 * (docs/spec/PROTOCOL.md, Deduplicating cardinalities: many-to-X matching).
 *
 * Separate from {@link DEDUPLICATE_IMPLEMENTED_BY_STRATEGY} because the two answer
 * different questions: that table asks whether a strategy honors one party's
 * `deduplicate: true` at all, and this asks whether it pairs the cardinality the
 * agreed PAIR resolves to when both parties declare it. Single-pass answers `true`
 * to the first and `false` to the second, which is exactly why the both-sided
 * refusal cannot be expressed through the per-party guard.
 *
 * A total table over {@link LinkageStrategy} for the same reason as its sibling: a
 * strategy added to the union states its own verdict here or the build fails.
 * Typed `boolean` rather than the literal values so each reader's gate gives a
 * genuine runtime branch.
 *
 * @internal exported for the tests that drive its readers over every strategy.
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
 * {@link assertBothSidedDeduplicateImplemented} refuses the agreed pair it returns
 * `false` for, and the strategy's own fail-closed half reads it at the seam that
 * would otherwise pair it (`singlePassResolves`, `link.ts`). Stating it twice
 * would let the strategy start pairing a cardinality the run boundary still
 * refused, or the reverse -- a silent divergence, since each side's own tests keep
 * passing.
 */
export function manyToManyIsImplementedForStrategy(
  strategy: LinkageStrategy,
): boolean {
  return MANY_TO_MANY_IMPLEMENTED_BY_STRATEGY[strategy];
}

/**
 * Refuse the agreed `(true, true)` pair on a linkage strategy that does not pair
 * the both-sided cardinality it resolves to, before any matching begins.
 *
 * The both-sided sibling of {@link assertDeduplicateImplemented}, and the seam
 * that guard cannot be: `deduplicate` is per-party, so a per-party reading
 * answers `true` for a single-pass party whose own `deduplicate: true` is
 * perfectly runnable -- it is one-sided until the partner's document arrives.
 * Only the agreed pair settles which cardinality the run resolves, so only a
 * check over BOTH documents can refuse the combination the strategy will not
 * pair, and a one-sided deduplicating run under the same strategy is left alone.
 *
 * Called from `resolveLinkageCardinality` (`exchange.ts`) after the terms
 * exchange and before the first round. Symmetric in the pair -- it reads both
 * documents' strategies and refuses if EITHER fails to carry the cardinality --
 * so a refused pair aborts both parties at the same point rather than starting a
 * round one side would refuse. `linkageStrategy` is a mandatory-consistency term,
 * so an honest pair carries one value and the two readings coincide; reading both
 * keeps the symmetry where the consistency check has not run.
 *
 * It sits beside {@link assertDeduplicateImplemented} rather than in `exchange.ts`
 * for the reason that guard does: importing the run module from here would close
 * an import cycle.
 *
 * The message names the STRATEGY rather than the pair, because the pair is what
 * runs: the cascade pairs it and resolves into the entity clusters specified in
 * docs/spec/PROTOCOL.md, and what stands between this operator and that run is
 * the strategy the two parties agreed. The strategies to move to are read off
 * {@link MANY_TO_MANY_IMPLEMENTED_BY_STRATEGY} rather than written out, so a
 * strategy that later pairs the cardinality is named the moment its entry says
 * so, and a build where none does still states the remedy that remains.
 *
 * Plain {@link UsageError}, deliberately NOT an `OperatorConfigError`, for the
 * same reason as its sibling: this check reads the PARTNER's document as well as
 * this party's, so the fault is not unconditionally this operator's own content.
 * The message carries only fixed literals and the strategy names of a schema enum.
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
// absent `transform` and an empty one are both the identity pipeline, so both
// normalize to the empty list; standardization.test.ts pins that equivalence at
// the layer that runs them. Equality is by canonical encoding rather than a
// structural walk: a
// `params` record's key order is not significant to the agreed terms -- which are
// hashed in this same canonical form -- so two spellings of one pipeline must
// compare equal.
//
// `transform.params` values are `z.unknown()`, so a partner value outside the
// reproducible canonical domain (a JSON integer beyond 2^53) survives schema
// parsing and then fails to encode. Such a pair is reported as DIFFERING rather
// than propagating the throw out of a `safeParse`: a pipeline that cannot be
// encoded cannot be shown to match its partner position, and the swap semantics
// this predicate establishes are the thing being refused on.
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
 * Whether the two elements this key's `swap` names declare DIFFERENT transforms,
 * the shape {@link LinkageTermsSchema} refuses.
 *
 * A swap moves the field references and leaves each element's own transform on
 * its position, so only a pair whose transforms agree compares like-normalized
 * values on both sides of the swapped key -- and only such a pair reaches the
 * same verdict whichever party role resolution designates as receiver, a role
 * settled per run from the parties' record counts rather than carried by the
 * terms. An omitted transform and an empty one are the same identity pipeline,
 * and two `params` records differing only in key order are one pipeline.
 *
 * False for a key declaring no swap, and for one whose swap target resolves to no
 * element -- the dangling case the schema answers by its own rule.
 *
 * Exported for an authoring surface that wants to name this fault before the
 * schema refuses the document, so the rule is read in one place rather than
 * restated per surface.
 */
export function swapPairTransformsDiffer(key: LinkageKey): boolean {
  const paired = swapPairedElements(key);
  return (
    paired !== undefined && !swapPairDeclaresOneTransform(paired[0], paired[1])
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
    // A swap pair's two positions must declare the SAME fuzzy expansion. The swap
    // moves only the field references and leaves each position's own
    // `generateFuzzyComparisons` where it is, so a mismatched pair applies one
    // expansion to a column on the party that swaps and a different one on the
    // party that does not -- two readings of the same agreed terms, and neither
    // party can see that from its own copy. Binding the pair here is what lets
    // the key-read layer resolve the expansion from the position it already holds
    // (`planFuzzyExpansions`, standardization.ts). A pair whose targets do not
    // resolve is left to the referential-integrity refine above, which owns that
    // fault. As above, the message echoes no partner-controlled value.
    .refine(
      (a) =>
        a.linkageKeys.every((key) => {
          const paired = swapPairedElements(key);
          return (
            paired === undefined ||
            paired[0].generateFuzzyComparisons ===
              paired[1].generateFuzzyComparisons
          );
        }),
      {
        message:
          "the two elements a linkage key swap names must declare the same " +
          "generate_fuzzy_comparisons: a swap moves the field references and " +
          "leaves each element's own expansion in place, so a mismatched pair " +
          "would expand a column differently on the two parties",
        path: ["linkageKeys"],
      },
    )
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
    )
    // The count-only shape, one refine per rule so a document breaking one is
    // located by its own issue path and answered by its own message. The rules
    // are docs/spec/PROTOCOL.md, PSI-C; placed here so EVERY parse path refuses
    // -- parseLinkageTerms, the invitation-token decode (a partner's document),
    // and ExchangeSpecSchema -- which puts the refusal on a received document as
    // it is read, ahead of the prepare step the specification names. `psi` terms
    // are untouched: each rule reads the algorithm first. The verdict comes from
    // the one shared reading (countOnlyShapeViolation) rather than a second copy
    // of the rule, so schema and asserts cannot diverge.
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
 * key-count-bounded, so an over-count params record is handed to the schema --
 * whose own key-count refine rejects it -- without the multi-second snake->camel
 * rewrite a pathological-count payload would otherwise incur:
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
 * `linkageRuleSet`, `legalAgreement`, and so on are cross-checked for equality at
 * exchange time, so both sides must carry an identical set -- but the facets
 * below are the acceptor's own perspective and are derived, not copied:
 *
 * - `identity` is replaced with the acceptor's own name, so the inviter's
 *   identity does not leak into the acceptor's prepared terms (and from there
 *   into its exchange record). It is the one value this function introduces, and
 *   it is free text the accepting operator supplies -- a CLI flag or prompt, a
 *   browser field -- so it is held at entry to every rule the schema holds a
 *   party `identity` to: the document's control-character rule
 *   ({@link TEXT_CONTROL_CHAR_PATTERN}), the non-empty floor, and the
 *   {@link MAX_TEXT_LENGTH} ceiling, each under a refusal that names the local
 *   input. Left to the re-check at the end they would fail the mirrored document
 *   instead, reporting an invitation psilink cannot accept and sending the
 *   operator to its partner over a name it typed itself.
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
 *   `send`, so the acceptor validates exactly what it will get. An explicit empty
 *   inviter `receive: []` (strict "send me nothing"; see {@link validateCompatibility})
 *   mirrors to an explicit empty acceptor `send: []` -- present, not absent -- which
 *   is coherent: the acceptor declares it sends nothing, the inviter strictly expects
 *   nothing, and `sameColumnSet([], [])` passes both directions. This is the strict
 *   empty case kept distinct from the absent case above, which yields an absent send.
 *
 * - `deduplicate` is DEFAULTED to false, neither copied nor mirrored. The term is
 *   per-party -- it declares that several of the DECLARING party's own records may
 *   match one of its partner's -- and nothing binds the value an invitation carried
 *   to what the inviter presents at the terms exchange. Copying it would let a
 *   hostile inviter carry `deduplicate: true`, have the acceptor take the "many"
 *   side and disclose its record grouping, then present `deduplicate: false` at the
 *   exchange so the run proceeds as many-to-one at the acceptor's expense. Deriving
 *   it as false makes that unrepresentable rather than refused: the acceptor's own
 *   side of the cardinality is never the inviter's to set, so this party's records
 *   are never grouped. An accepted deduplicating invitation resolves to the
 *   one-sided pair the cascade runs -- the inviter the "many" side, this party the
 *   "one" -- which is the direction the consent surfaces state ahead of the accept.
 *   An acceptor that wants its OWN records grouped authors that in its own
 *   configuration, which does not call this function.
 *
 *   What the derived value does not carry, and what an accept path must retain
 *   separately, is the value the invitation declared for the INVITER's side. It
 *   is what the consent surfaces stated, and nothing in the agreed terms compares
 *   the two sides afterwards -- so a caller holding the token records it as the
 *   run's `expectedPartnerDeduplicate` (`PreparedExchange`, exchange.ts), which
 *   binds what the partner presents at the terms exchange to what it declared.
 *
 *   What the derived `false` does NOT hold constant is how many of this party's
 *   records match. A value the inviter holds on several rows is ambiguous under
 *   `one-to-one` and drops out of the round, so this party's record holding it goes
 *   unmatched; under the deduplicating run the inviter contributes that value once
 *   and the record matches, disclosing its membership and any payload columns this
 *   party sends. The inviter's declaration therefore widens this party's own
 *   outbound disclosure, which the consent surfaces state (see
 *   `DEDUPLICATE_ACCEPTOR_SIDE_NOTE`). It is a widening rather than a new
 *   capability: an inviter that collapsed its own duplicate rows before the
 *   exchange would match exactly the same records one-to-one.
 *
 * Metadata and standardization stay per-party and local (they are never embedded in
 * the token); this function shapes only the agreed linkage terms.
 *
 * It fails closed. A config that is valid for the INVITER can mirror to one that is
 * incoherent for the acceptor: an inviter that is the sole receiver (it shares no
 * result with the partner) may carry a non-empty `payload.send`, which requires the
 * PARTNER to receive output -- the inviter's `send` mirrors to the acceptor's
 * `receive` -- but the acceptor mirrors to `expectsOutput: false`, which the
 * schema's cross-field rules forbid. (The inviter's own `payload.receive` mirrors to
 * the acceptor's `send`, which needs no output, so it is never the trigger; the
 * schema's other rule for a non-receiving party, that it must not deduplicate, is
 * met by the derived `false` whatever the invitation carried.)
 * The front ends above never produce such an inviter config, but a hand-authored
 * CLI config or a crafted invitation token could, and the derived terms are not
 * otherwise re-validated before the run. So the derived terms are re-checked
 * against {@link LinkageTermsSchema} here and an incoherent result throws, aborting
 * acceptance cleanly rather than running an invalid configuration. Its message
 * names no partner-controlled value and accounts for the failure as the
 * invitation's, which is the account the re-check is left to give: the inviter's
 * terms were already validated at decode, `deduplicate`, `output`, and `payload`
 * are derived rather than authored by either party, and `identity` -- the one
 * free text substituted here, and the accepting operator's own -- carries the
 * whole of the field's own rule at entry above (control characters, the non-empty
 * floor, the {@link MAX_TEXT_LENGTH} ceiling), so no value the accepting operator
 * supplied itself reaches this message: each is refused above under an account
 * naming the local input.
 *
 * It also refuses a `psi-c` document outside the count-only shape, before the
 * mirror is built rather than after ({@link assertCountOnlyTermsShape}): the
 * message then names the rule the received document breaks, where the generic
 * re-check below would report the mirror. Reading the INVITER's terms rather
 * than the derived ones is what makes the account the partner's document: the
 * mirror moves payload between the two directions, and the rule refuses both.
 *
 * It refuses a deduplicating invitation under a strategy that cannot match one
 * on the same reading and for the same reason ({@link assertDeduplicateImplemented}):
 * the pair the exchange boundary refuses is readable from the invitation alone --
 * `linkageStrategy` is a mandatory-consistency term, so the invitation's value is
 * the agreed one -- and the derived `deduplicate: false` would otherwise hide it
 * from every check between here and the run. Refusing at the accept boundary
 * keeps such an invitation off the consent surfaces and off the wire.
 *
 * @throws {UsageError} when `acceptorIdentity` carries a control character, is
 *   empty, or exceeds {@link MAX_TEXT_LENGTH}, or when the inviter's terms are
 *   `psi-c` outside the count-only shape or declare `deduplicate` under a
 *   strategy that matches no deduplicating cardinality.
 * @throws {Error} when the inviter's terms cannot be coherently accepted for the
 *   mirrored output direction.
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
        `${TEXT_CONTROL_CHAR_MESSAGE}. Supply one that carries none.`,
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
    // This party's own side of the cardinality, which the invitation does not carry
    // to it: whether SEVERAL of this party's records may match one of the partner's
    // is a disclosure about this party's own data, so it starts closed and is
    // authored in this party's own configuration (see the doc comment).
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
 *
 * Every diagnostic it composes names its terms values through the delimiting
 * seam in `config/compatibilityMessage.ts`, so no value a partner chooses can
 * close a delimiter or spell a second clause of psilink's own prose. The
 * enumeration is enforced by type rather than kept as a list here: the two
 * accumulators hold `CompatibilityMessageFragment`, so a message composed any
 * other way does not compile. `test/compatibilityMessage.test.ts` drives the
 * adversarial value shapes through each message and asserts the clause structure
 * is the one this function wrote.
 */
export function validateCompatibility(
  local: LinkageTerms,
  partner: LinkageTerms,
): CompatibilityResult {
  // Both accumulators hold CompatibilityMessageFragment rather than string, which
  // is the whole of the sweep below: a diagnostic reaches either list only
  // through the compatibilityMessage tagged template, whose interpolations are
  // fragments and whose fixed spans the compiler supplies. So a terms value put
  // into a message without passing the delimiting seam -- an edit to a message
  // here, or a mismatch check added later -- does not compile. Both lists are
  // returned as the `string[]` of CompatibilityResult, which the brand is
  // transparent to.
  const errors: CompatibilityMessageFragment[] = [];
  const warnings: CompatibilityMessageFragment[] = [];

  // The threat both arrays below carry is the partner side: a
  // mutually-distrusting party controls reference/purpose/set/column names, and
  // it controls them on the side these messages call "local" as well, since
  // deriveAcceptedLinkageTerms adopts the inviter's legalAgreement and
  // linkageRuleSet verbatim. Two distinct controls answer it.
  //
  // DELIMITING is applied here, at composition, to every value either list names
  // (config/compatibilityMessage.ts): a value is rendered as one delimited run,
  // or bare only where it is checked to carry nothing a clause boundary is made
  // of. It answers the reading attack the escape cannot -- a value of printable
  // ASCII that spells this diagnostic's own clause structure -- and it emits only
  // printable ASCII, so it neither duplicates the escape nor is rewritten by it.
  //
  // ESCAPING stays assigned to one altitude per route, which differs between the
  // two lists. `errors` becomes an Error message here and an abort frame the
  // partner renders at its own display boundary; an error is escaped once by
  // sanitizeErrorForDisplay where it is shown, so the values inside the delimiters
  // are the RAW ones. `warnings` is handed to the caller as display text
  // (runExchange's onWarning slot) with no error to carry it, so it is escaped
  // here, and redacted here too: a warning ends at a log line and at the warning
  // event, both of which redact the whole composed string, and every fragment
  // below precedes the first-party sentence that explains the mismatch. The CLI
  // escapes each warning again as it reaches a log line and the event stream, so
  // a warning makes two passes on that route; every value interpolated below is
  // schema-constrained to a shape the escape does not rewrite, which is what
  // keeps the second pass unobservable. CHANNEL_SECURITY.md records why neither
  // pass is removed. On that route the escape runs BEFORE the delimiting, so the
  // truncation inside it can never take the closing delimiter off a run.
  //
  // The equality CHECKS always compare the RAW values either way -- both
  // transforms are display-only and the escape is lossy (it truncates), so
  // comparing transformed forms could mask a genuine mismatch.
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
  //
  // `label` is first-party copy the caller composes through the same tagged
  // template, and the encoder's own message is delimited: it names the offending
  // JSON path, built from the encoded object's keys, which on a partner document
  // are the partner's.
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

  // The rule-set citation, checked only where BOTH parties declare one. It names
  // rules the two documents already had to agree on field by field and key by
  // key, so a disagreement here is a disagreement about the NAME of matching
  // content -- which still cancels, because each party records its own citation
  // in its own exchange record and two records naming different rules for one run
  // is the thing the naming exists to prevent. Skipped where either party
  // declares none: a hand-authored document carries no citation, and holding it
  // to the partner's would refuse an exchange whose rules match exactly. Compared
  // by canonical form, like the fields and keys above, so the comparison is
  // byte-exact and property order does not enter it. The set names are delimited
  // by describeRuleSet, and the values inside those delimiters stay raw for the
  // same reason the legal-agreement mismatches below are: an error is escaped
  // once where it is shown.
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

  // Payload mirror, LAZY on the receive side. Each of the two directions is gated
  // on whether the RECEIVING party declared a `payload.receive` expectation:
  //
  // - `receive` DECLARED (the field is present, even if empty) asserts "I expect
  //   exactly these columns": the partner's `send` must match it byte-for-byte or
  //   the exchange aborts -- the strict mirror, unchanged. This is the recurring /
  //   loaded-config case, where both parties carry an agreed payload. An explicit
  //   empty `receive: []` is strict BY INTENT: it asserts "the
  //   partner sends nothing," distinct from an absent `receive`, so a partner that
  //   discloses any column fails this check. Empty-is-strict is chosen here to agree
  //   with the received-payload runtime lock-in -- an empty committed set
  //   (`expectedPayloadColumns` / reconcileReceivedPayload) is likewise strict
  //   ("receive nothing") and only `undefined` is lazy -- and with the web consent
  //   display, which renders a declared-empty receive as a "(none)" lock-in, not
  //   lazy. Reading `[]` as lazy here would admit an exchange the runtime lock-in
  //   then aborts. Only a hand-authored config or crafted token can produce `[]`.
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
  // (`isDisclosedToPartner`) and `assertPayloadSendDisclosed`, both
  // unchanged -- so a lazy receiver accepts only what the sender's own consented
  // metadata discloses, and receiving is not disclosing. The gate is symmetric: each
  // direction keys on the same receiver's declared `receive`, so the two parties
  // (which call this with swapped arguments) compute identical verdicts. The
  // equality is byte-exact and element-wise -- compared per sorted column, NOT by
  // a delimiter-joined string, so a partner-controlled name containing the
  // separator cannot make two distinct sets join equal (`["a,b"]` vs
  // `["a","b"]`) and slip a genuine mismatch past the check. The rendering keeps
  // that partition visible, delimiting each name in its own run
  // (quoteTermsValueList), so the operator reading the diagnostic counts the same
  // columns the comparison did. Matching the messages elsewhere.
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
