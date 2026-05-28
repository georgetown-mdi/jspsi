import { z } from "zod";
import { AlgorithmSchema } from "../types.js";
import type { Algorithm } from "../types.js";
import { camelizeKeys } from "../utils/camelizeKeys.js";

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
  validOnly?: boolean;
  /** Values that must not appear in the data. */
  exclude?: string[];
}

const DateConstraintsSchema: z.ZodType<DateConstraints> = z.object({
  validOnly: z.boolean().optional(),
  exclude: z.array(z.string()).optional(),
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
  type: "firstName";
  constraints?: NameConstraints;
}
interface LastNameField {
  name: string;
  type: "lastName";
  constraints?: NameConstraints;
}
interface DateOfBirthField {
  name: string;
  type: "dateOfBirth";
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
  type: "phoneNumber";
  constraints?: AnyConstraints;
}
interface EmailAddressField {
  name: string;
  type: "emailAddress";
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
      type: z.literal("firstName"),
      ...linkageFieldBase(NameConstraintsSchema),
    }),
    z.object({
      type: z.literal("lastName"),
      ...linkageFieldBase(NameConstraintsSchema),
    }),
    z.object({
      type: z.literal("dateOfBirth"),
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
      type: z.literal("phoneNumber"),
      ...linkageFieldBase(AnyConstraintsSchema),
    }),
    z.object({
      type: z.literal("emailAddress"),
      ...linkageFieldBase(AnyConstraintsSchema),
    }),
  ],
);

// --- Linkage key elements ----------------------------------------------------

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
  name: z.string().min(1),
  elements: z.array(LinkageKeyElementSchema).min(1),
  swap: z.tuple([z.string(), z.string()]).optional(),
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

// --- Legal agreement ---------------------------------------------------------

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
export interface LinkageTerms {
  /**
   * Semver string identifying the schema version. Compatibility is checked at
   * exchange time.
   */
  version: string;
  /**
   * Free-text string identifying the party holding these linkage terms (e.g.
   * name organization, contact info). Included verbatim in the non-repudiation
   * receipt.
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

export const LinkageTermsSchema: z.ZodType<LinkageTerms> =
  LinkageTermsBaseSchema.refine(
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
          "element identifiers (name if present, otherwise field) must be " +
          "unique within each linkage key",
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

// Serialize with sorted object keys so that property-insertion order (which
// differs between plain objects and Zod-parsed ones) does not affect equality.
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted = Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
    return "{" + sorted.join(",") + "}";
  }
  return JSON.stringify(value);
}

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

  if (local.version !== partner.version) {
    // TODO: implement migration when new versions exist
    errors.push(
      `version mismatch: local is ${local.version}, partner is ` +
        `${partner.version}`,
    );
  }

  if (local.algorithm !== partner.algorithm) {
    errors.push(
      `algorithm mismatch: local is ${local.algorithm}, partner is ` +
        `${partner.algorithm}`,
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
      `date mismatch: local is ${local.date}, partner is ${partner.date}; ` +
        "one party may have a stale copy of the linkage terms",
    );
  }

  const localFields = [...local.linkageFields].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const partnerFields = [...partner.linkageFields].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  if (stableStringify(localFields) !== stableStringify(partnerFields)) {
    errors.push("linkage fields do not match");
  }

  if (
    stableStringify(local.linkageKeys) !== stableStringify(partner.linkageKeys)
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
            `"${local.legalAgreement.reference}", partner is ` +
            `"${partner.legalAgreement.reference}"`,
        );
      }
      if (
        local.legalAgreement.expirationDate !==
        partner.legalAgreement.expirationDate
      ) {
        errors.push(
          "legal agreement expiration date mismatch: local is " +
            `${local.legalAgreement.expirationDate}, partner is ` +
            `${partner.legalAgreement.expirationDate}`,
        );
      }
      const today = new Date().toISOString().slice(0, 10);
      if (local.legalAgreement.expirationDate < today) {
        errors.push(
          `legal agreement expired on ${local.legalAgreement.expirationDate}`,
        );
      }
    }
  }

  const localSendNames = (local.payload?.send ?? [])
    .map((c) => c.name)
    .sort()
    .join(",");
  const partnerReceiveNames = (partner.payload?.receive ?? [])
    .map((c) => c.name)
    .sort()
    .join(",");
  if (localSendNames !== partnerReceiveNames) {
    errors.push(
      `payload mismatch: local send columns [${localSendNames}] do not match ` +
        `partner receive columns [${partnerReceiveNames}]`,
    );
  }

  const localReceiveNames = (local.payload?.receive ?? [])
    .map((c) => c.name)
    .sort()
    .join(",");
  const partnerSendNames = (partner.payload?.send ?? [])
    .map((c) => c.name)
    .sort()
    .join(",");
  if (localReceiveNames !== partnerSendNames) {
    errors.push(
      `payload mismatch: local receive columns [${localReceiveNames}] do not ` +
        `match partner send columns [${partnerSendNames}]`,
    );
  }

  return { errors, warnings };
}
