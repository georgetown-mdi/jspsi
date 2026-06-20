import { z } from "zod";
import { AlgorithmSchema } from "../types.js";
import type { Algorithm } from "../types.js";
import { camelizeKeys } from "../utils/camelizeKeys.js";
import { canonicalString, CanonicalEncodingError } from "../utils/canonical.js";
import { sanitizeForDisplay } from "../utils/sanitizeForDisplay.js";

// --- Untrusted-input bounds --------------------------------------------------

// These terms travel inside an invitation token, which the decoder accepts from
// a counterparty whose token passed only a transcription checksum -- a check
// anyone can recompute over a crafted payload, not an authenticity guarantee
// (see invitation.ts) -- and they are parsed a second time off the exchange wire
// (protocolSetup), where the binding size cap is the far larger
// MAX_FRAME_SIZE_BYTES (~512 MiB, connection/frameSize.ts), not the 64 KiB
// MAX_ENCODED_INVITATION_LENGTH of the token path. The rule below: every
// partner-controlled free-text string carries a generous length `.max()`; the two
// top-level arrays (`linkageFields` and `linkageKeys`) and the `transform.params`
// record carry a count `.max()`. What is still left to those boundary caps rather
// than a per-field bound is the deeper collection COUNTS -- per-element
// `transform` steps, each constraint's `exclude` list, the `payload` send/receive
// arrays, and a key's `elements` -- and the `params` VALUE content (typed
// `z.unknown()`, with no clean content bound). Their legitimate sizes vary (a
// denylist can hold hundreds of values), so an invented count risks rejecting a
// real config. The `transform.params` ENTRY count is the exception now bounded
// (MAX_PARAMS_ENTRIES): under the wire-path frame cap a payload of ~130k invalid
// keys fits, and Zod overflows its own call stack accumulating and spreading one
// issue per key before it can return a structured failure -- a schema count bound
// forestalls that. The deferred counts nested beneath an OUTER array -- `exclude`
// (under `linkageFields`), and `transform` steps and `elements` (under
// `linkageKeys`) -- share that exposure: the inner issue array is spread through
// two array frames, so a partner can still drive the same Zod-internal RangeError
// there. The outermost `payload` send/receive arrays sit one array frame below the
// root object, so they do not overflow at counts the frame cap admits (they stay
// unbounded only for uniformity, not because they share the exposure). Every
// reachable case is caught harmlessly in protocolSetup's parse-error catch (a
// RangeError has no `.issues`, so it renders via the message fallback and the
// exchange aborts cleanly). Bounding the deferred counts is a surveyed follow-on,
// not done here. The bounds are defense-in-depth, not semantic limits.

/**
 * Generous upper bound on a short partner-controlled string -- the identifier-
 * and spec-like fields: a linkage key, field, or element `name`, an element
 * `field` reference, an element-`swap` reference, a transform `function` name and
 * its `params` keys, a payload column `name`, a legal-agreement `reference`, the
 * `version` string, and a name-constraint `allowedCharacters` class. A real value
 * is a short label (tens of characters); 256 is far above any legitimate one yet
 * refuses a megabyte-scale string.
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
 * BEFORE the per-key length validation (see {@link TransformStep}'s schema): an
 * over-count record is rejected with a single issue rather than one issue per
 * key, so a pathological-count payload on the wide wire-path frame cannot make
 * Zod overflow its call stack accumulating an issue per key. See the
 * untrusted-input bounds note above.
 */
export const MAX_PARAMS_ENTRIES = 256;

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
  // Validated as a regex character class so consuming code can safely
  // interpolate it into new RegExp(`[${allowedCharacters}]`) without injection
  // risk. Note the brackets that get added. The `.max()` precedes the refine so
  // an oversized value is rejected on length before a large partner-controlled
  // string is compiled into a RegExp here; a real character class is short.
  allowedCharacters: z
    .string()
    .max(MAX_NAME_LENGTH)
    .refine(
      (val) => {
        try {
          new RegExp(`[${val}]`);
          return true;
        } catch {
          return false;
        }
      },
      { message: "allowedCharacters must be a valid regex character class" },
    )
    .optional(),
  affixesAllowed: z.boolean().optional(),
  exclude: z.array(z.string().max(MAX_TEXT_LENGTH)).optional(),
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
  exclude: z.array(z.string().max(MAX_TEXT_LENGTH)).optional(),
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
  exclude: z.array(z.string().max(MAX_TEXT_LENGTH)).optional(),
});

/** Constraints applicable to any semantic type. */
interface AnyConstraints {
  /** Values that must not appear in the data. */
  exclude?: string[];
}

const AnyConstraintsSchema: z.ZodType<AnyConstraints> = z.object({
  exclude: z.array(z.string().max(MAX_TEXT_LENGTH)).optional(),
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

const TransformStepSchema: z.ZodType<TransformStep> = z.object({
  function: z.string().min(1).max(MAX_NAME_LENGTH),
  // The record's KEYS are partner-controlled strings (parameter names), so they
  // are length-bounded like every other free-text string; the VALUE content is
  // `z.unknown()` with no clean per-field bound. The entry COUNT is bounded at
  // MAX_PARAMS_ENTRIES, and -- critically -- that gate runs BEFORE the per-key
  // length check: a first permissive `z.record` accepts the keys unvalidated, so
  // the count refine sees the whole set and rejects an over-count payload with a
  // single issue; `.pipe` then re-validates the now count-capped keys against the
  // length bound. Bounding the count on the length-bounded record directly would
  // not help -- Zod accumulates one length issue per bad key during that record's
  // own parse, before any refine runs, and on the wide wire-path frame
  // (MAX_FRAME_SIZE_BYTES, far above the 64 KiB invitation cap) ~130k such keys
  // overflow Zod's call stack as it spreads that issue array up through the
  // nesting. The pipe keeps the post-cap `invalid_key` path -- and its parse-error
  // sanitization (item 202554679) -- intact for an in-range over-long key.
  params: z
    .record(z.string(), z.unknown())
    .refine((rec) => Object.keys(rec).length <= MAX_PARAMS_ENTRIES, {
      message: `transform params must not exceed ${MAX_PARAMS_ENTRIES} entries`,
    })
    .pipe(z.record(z.string().max(MAX_NAME_LENGTH), z.unknown()))
    .optional(),
});

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
  transform: z.array(TransformStepSchema).optional(),
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
  elements: z.array(LinkageKeyElementSchema).min(1),
  swap: z
    .tuple([z.string().max(MAX_NAME_LENGTH), z.string().max(MAX_NAME_LENGTH)])
    .optional(),
});

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
  send: z.array(PayloadColumnSchema).optional(),
  receive: z.array(PayloadColumnSchema).optional(),
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
  linkageFields: z.array(LinkageFieldSchema).min(1).max(MAX_LINKAGE_ENTRIES),
  linkageKeys: z.array(LinkageKeySchema).min(1).max(MAX_LINKAGE_ENTRIES),
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
    );

// --- Parse -------------------------------------------------------------------

/**
 * Parse and validate a raw value as an {@link LinkageTerms}.
 * Snake_case keys in the input are converted to camelCase before validation,
 * so JSON/YAML from disk can be passed directly.
 *
 * @throws {ZodError} if validation fails.
 */
export function parseLinkageTerms(raw: unknown): LinkageTerms {
  return LinkageTermsSchema.parse(camelizeKeys(raw));
}

/**
 * Non-throwing version of {@link parseLinkageTerms}.
 * Returns a Zod `SafeParseReturnType` with `success` and either `data` or
 * `error`.
 */
export function safeParseLinkageTerms(raw: unknown) {
  return LinkageTermsSchema.safeParse(camelizeKeys(raw));
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

  // Compare the raw, comma-joined names; display each name sanitized. A column
  // name is partner-controlled free text, so the displayed list is escaped
  // per-name while the equality check stays byte-exact.
  const localSendNames = (local.payload?.send ?? []).map((c) => c.name).sort();
  const partnerReceiveNames = (partner.payload?.receive ?? [])
    .map((c) => c.name)
    .sort();
  if (localSendNames.join(",") !== partnerReceiveNames.join(",")) {
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

  const localReceiveNames = (local.payload?.receive ?? [])
    .map((c) => c.name)
    .sort();
  const partnerSendNames = (partner.payload?.send ?? [])
    .map((c) => c.name)
    .sort();
  if (localReceiveNames.join(",") !== partnerSendNames.join(",")) {
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

  return { errors, warnings };
}
