import { z } from "zod";
import { AlgorithmSchema } from "./types.js";
import type { Algorithm } from "./types.js";
import { camelizeKeys } from "./utils/camelizeKeys.js";

// ─── Output ──────────────────────────────────────────────────────────────────

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
   * the partner's agreement to also have `shareWithPartner: true`.
   */
  expectsOutput: boolean;
  /**
   * Whether the other party should also receive the result. Requires the
   * partner's agreement to also have `expectsOutput: true`.
   * */
  shareWithPartner: boolean;
}

const OutputSchema: z.ZodType<Output> = z.object({
  expectsOutput: z.boolean(),
  shareWithPartner: z.boolean(),
});

// ─── Linkage fields ──────────────────────────────────────────────────────────
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
  // risk. Note the brackets that get added.
  allowedCharacters: z
    .string()
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
  exclude: z.array(z.string()).optional(),
});

/** Constraints on date-of-birth fields. */
interface DateConstraints {
  /** Dates must be able to be parsed as valid dates. */
  onlyValid?: boolean;
  /** Values that must not appear in the data. */
  exclude?: string[];
}

const DateConstraintsSchema: z.ZodType<DateConstraints> = z.object({
  onlyValid: z.boolean().optional(),
  exclude: z.array(z.string()).optional(),
});

/** Constraints on SSN and SSN-last-4 fields. */
interface SSNConstraints {
  /**
   * Data must conform to SSA rules (area, group, and serial numbers may not be
   * all zeros, etc.).
   */
  onlyValid?: boolean;
  /**
   * Values that must not appear in the data (e.g. "123456789", "111111111").
   */
  exclude?: string[];
}

const SSNConstraintsSchema: z.ZodType<SSNConstraints> = z.object({
  onlyValid: z.boolean().optional(),
  exclude: z.array(z.string()).optional(),
});

/** Constraints applicable to any semantic type. */
interface AnyConstraints {
  /** Values that must not appear in the data. */
  exclude?: string[];
}

const AnyConstraintsSchema: z.ZodType<AnyConstraints> = z.object({
  exclude: z.array(z.string()).optional(),
});

// Shared fields for all linkage field variants.
const linkageFieldBase = <C>(constraints: z.ZodType<C>) => ({
  name: z.string().min(1),
  constraints: constraints.optional(),
});

interface FirstNameField {
  name: string;
  semanticType: "firstName";
  constraints?: NameConstraints;
}
interface LastNameField {
  name: string;
  semanticType: "lastName";
  constraints?: NameConstraints;
}
interface DateOfBirthField {
  name: string;
  semanticType: "dateOfBirth";
  constraints?: DateConstraints;
}
interface SsnField {
  name: string;
  semanticType: "ssn";
  constraints?: SSNConstraints;
}
/**
 * Last four digits of SSN. Distinct from `ssn` because some parties only
 * possess the last four digits; this is not a derived field.
 */
interface SsnLast4Field {
  name: string;
  semanticType: "ssnLast4";
  constraints?: SSNConstraints;
}
interface PhoneNumberField {
  name: string;
  semanticType: "phoneNumber";
  constraints?: AnyConstraints;
}
interface EmailAddressField {
  name: string;
  semanticType: "emailAddress";
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
  | SsnLast4Field
  | PhoneNumberField
  | EmailAddressField;

const LinkageFieldSchema: z.ZodType<LinkageField> = z.discriminatedUnion(
  "semanticType",
  [
    z.object({
      semanticType: z.literal("firstName"),
      ...linkageFieldBase(NameConstraintsSchema),
    }),
    z.object({
      semanticType: z.literal("lastName"),
      ...linkageFieldBase(NameConstraintsSchema),
    }),
    z.object({
      semanticType: z.literal("dateOfBirth"),
      ...linkageFieldBase(DateConstraintsSchema),
    }),
    z.object({
      semanticType: z.literal("ssn"),
      ...linkageFieldBase(SSNConstraintsSchema),
    }),
    z.object({
      semanticType: z.literal("ssnLast4"),
      ...linkageFieldBase(SSNConstraintsSchema),
    }),
    z.object({
      semanticType: z.literal("phoneNumber"),
      ...linkageFieldBase(AnyConstraintsSchema),
    }),
    z.object({
      semanticType: z.literal("emailAddress"),
      ...linkageFieldBase(AnyConstraintsSchema),
    }),
  ],
);

// ─── Linkage key elements ────────────────────────────────────────────────────

type GenerateFuzzyComparisons =
  | "transpositions"
  | "editDistances"
  | "adjacentYears";

const GenerateFuzzyComparisonsSchema: z.ZodType<GenerateFuzzyComparisons> =
  z.enum(["transpositions", "editDistances", "adjacentYears"]);

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
  function: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
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
   * - `editDistances`: all single-character deletions up to the constraint
   *   `maxLength`.
   * - `adjacentYears`: +/- 1 year from the date.
   */
  generateFuzzyComparisons?: GenerateFuzzyComparisons;
  /**
   * Transformations applied in order to the canonical field value before it
   * is concatenated into the key.
   */
  transform?: TransformStep[];
}

const LinkageKeyElementSchema: z.ZodType<LinkageKeyElement> = z.object({
  field: z.string().min(1),
  name: z.string().optional(),
  generateCombinations: GenerateFuzzyComparisonsSchema.optional(),
  transform: z.array(TransformStepSchema).optional(),
});

// ─── Linkage keys ────────────────────────────────────────────────────────────

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
  name: z.string().min(1),
  elements: z.array(LinkageKeyElementSchema).min(1),
  swap: z.tuple([z.string(), z.string()]).optional(),
});

// ─── Payload ─────────────────────────────────────────────────────────────────

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
  name: z.string().min(1),
  description: z.string().optional(),
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
   * records.
   */
  receive?: PayloadColumn[];
}

const PayloadSchema: z.ZodType<Payload> = z.object({
  send: z.array(PayloadColumnSchema).optional(),
  receive: z.array(PayloadColumnSchema).optional(),
});

// ─── Legal agreement ─────────────────────────────────────────────────────────

/**
 * Reference to the legal data-sharing agreement authorizing this exchange.
 * If `expirationDate` has passed, the exchange fails before any data is
 * transmitted.
 */
export interface LegalAgreement {
  /** Identifier of the legal agreement (e.g. "MOU-2025-0042"). */
  reference: string;
  /** Date after which the exchange will be refused (ISO 8601, YYYY-MM-DD). */
  expirationDate: string;
}

const LegalAgreementSchema: z.ZodType<LegalAgreement> = z.object({
  reference: z.string().min(1),
  expirationDate: z.iso.date(),
});

// ─── Exchange Agreement ──────────────────────────────────────────────────────

/**
 * The complete exchange agreement for one party. Each party holds their own
 * copy; after authentication both parties swap copies and verify that all
 * mandatory fields match. A mismatch on a mandatory field cancels the exchange;
 * a mismatch on a soft field (currently only `date`) produces a warning and an
 * updated agreement output.
 *
 * Fields and their consistency requirements:
 * - `version` — mandatory. Two versions are incompatible if no migration path
 *   exists.
 * - `identity` — none. Free-text identifying the holding party; recorded in
 *   the non-repudiation receipt.
 * - `date` — soft. A mismatch warns that one party may have a stale copy.
 * - `algorithm` — mandatory. `psi` reveals matched identifiers; `psi-c` reveals
 *   only the count.
 * - `output` — mandatory.
 * - `deduplicate` — mandatory. Per-party; determines if multiple inputs can be
 *   matched to the same output.
 * - `linkageFields` — mandatory.
 * - `linkageKeys` — mandatory.
 * - `legalAgreement` — mandatory if present. Exchange fails if `expirationDate`
 *   has passed.
 * - `payload` — mandatory if present.
 *
 * Constraints:
 * - `deduplicate: true` requires `output.expectsOutput: true`.
 * - `linkageFields[].name` must be unique across all linkage fields.
 * - `linkageKeys[].name` must be unique across all linkage keys.
 * - Within each linkage key, the effective element identifier (`element.name`
 *   if present, otherwise `element.field`) must be unique so that `swap`
 *   references are unambiguous.
 *
 * TODO: versioning compatibility rules (migration paths between semver
 * versions).
 *
 */
export interface ExchangeAgreement {
  /**
   * Semver string identifying the schema version. Compatibility is checked at
   * exchange time.
   */
  version: string;
  /**
   * Free-text string identifying the party holding this agreement (e.g. name,
   * organization, contact info). Included verbatim in the non-repudiation
   * receipt.
   * Consistency: none — parties may differ.
   */
  identity: string;
  /**
   * Date this agreement was last modified (ISO 8601, YYYY-MM-DD).
   * Consistency: soft — a mismatch warns rather than cancels the exchange.
   */
  date: string;
  /** `psi` reveals matched identifiers; `psi-c` reveals only the count. */
  algorithm: Algorithm;
  output: Output;
  /**
   * Whether this party's records may match more than once. `one` means each
   * record matches at most once; `many` means a record may appear in multiple
   * pairs. The combined exchange multiplicity is inferred when both agreements
   * are compared. Consistency: mandatory.
   */
  deduplicate: boolean;
  /**
   * Canonical, normalized form of each PII element that participates in
   * linkage. Linkage key elements and cleaning pipeline outputs reference
   * these fields by name. Consistency: mandatory.
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

// ExchangeAgreementBaseSchema is not annotated as ZodType<ExchangeAgreement>
// because the concrete ZodObject type is needed to chain .refine().
const ExchangeAgreementBaseSchema = z.object({
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/, "version must be a valid semver string"),
  identity: z.string().min(1),
  date: z.iso.date(),
  algorithm: AlgorithmSchema,
  output: OutputSchema,
  deduplicate: z.boolean(),
  linkageFields: z.array(LinkageFieldSchema).min(1),
  linkageKeys: z.array(LinkageKeySchema).min(1),
  payload: PayloadSchema.optional(),
  legalAgreement: LegalAgreementSchema.optional(),
});

export const ExchangeAgreementSchema: z.ZodType<ExchangeAgreement> =
  ExchangeAgreementBaseSchema.refine(
    (a) => !a.deduplicate || a.output.expectsOutput,
    {
      message: "expectsOutput must be true when deduplicate is true",
      path: ["output", "expectsOutput"],
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
          "element identifiers (name if present, otherwise field) must be unique within each linkage key",
        path: ["linkageKeys"],
      },
    );

// ─── Parse ──────────────────────────────────────────────────────────────────-

/**
 * Parse and validate a raw value as an {@link ExchangeAgreement}.
 * Snake_case keys in the input are converted to camelCase before validation,
 * so JSON/YAML from disk can be passed directly.
 *
 * @throws {ZodError} if validation fails.
 */
export function parseExchangeAgreement(raw: unknown): ExchangeAgreement {
  return ExchangeAgreementSchema.parse(camelizeKeys(raw));
}

/**
 * Non-throwing version of {@link parseExchangeAgreement}.
 * Returns a Zod `SafeParseReturnType` with `success` and either `data` or
 * `error`.
 */
export function safeParseExchangeAgreement(raw: unknown) {
  return ExchangeAgreementSchema.safeParse(camelizeKeys(raw));
}
