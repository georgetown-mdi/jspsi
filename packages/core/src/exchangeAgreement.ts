import { z } from 'zod';
import { AlgorithmSchema, MultiplicitySchema, PsiRoleSchema } from './exchangeAgreementTypes.js';
import { camelizeKeys } from './utils/camelizeKeys.js';

// Property names use camelCase throughout. The parse functions apply
// camelizeKeys() to convert snake_case JSON/YAML input before validation.

// ─── Party identity ──────────────────────────────────────────────────────────
// Identity is informational: it appears in the non-repudiation receipt and
// helps parties recognise each other, but is not used for validation.
// Cryptographic tokens handle proof of identity.

const PartiesSchema = z.object({
  initiator: z.string().min(1),
  responder: z.string().min(1),
});

export type Parties = z.infer<typeof PartiesSchema>;

// ─── Roles ───────────────────────────────────────────────────────────────────

const RolesSchema = z.object({
  initiator: PsiRoleSchema,
  responder: PsiRoleSchema,
}).refine(
  ({ initiator, responder }) => initiator !== responder,
  { message: 'initiator and responder must hold different PSI roles' }
);

export type Roles = z.infer<typeof RolesSchema>;

// ─── Output ──────────────────────────────────────────────────────────────────

const OutputSchema = z.object({
  bothParties: z.boolean(),
});

export type Output = z.infer<typeof OutputSchema>;

// ─── Linkage key elements ────────────────────────────────────────────────────
// TBD: EXCHANGE_SPEC.md marks the semantic type enumeration as incomplete.
// The following covers the listed types; extend as new types are specified.

const NameConstraintsSchema = z.object({
  maxLength: z.number().int().positive().optional(),
  // Regex character class; characters outside it are stripped before linkage.
  allowedCharacters: z.string().optional(),
  stripTitles: z.boolean().optional(),
});

const DateConstraintsSchema = z.object({
  // TBD: valid format strings are not yet enumerated (e.g. "YYYY-MM-DD").
  format: z.string().optional(),
});

const SsnConstraintsSchema = z.object({
  validateChecksum: z.boolean().optional(),
  // Generates all two-digit transpositions for fuzzy matching.
  transpositions: z.boolean().optional(),
});

// Each union member pairs a semantic type with only its applicable constraints.
const LinkageKeyElementSchema = z.discriminatedUnion('semanticType', [
  z.object({ semanticType: z.literal('firstName'),   constraints: NameConstraintsSchema.optional() }),
  z.object({ semanticType: z.literal('lastName'),    constraints: NameConstraintsSchema.optional() }),
  z.object({ semanticType: z.literal('dateOfBirth'), constraints: DateConstraintsSchema.optional() }),
  z.object({ semanticType: z.literal('ssn'),         constraints: SsnConstraintsSchema.optional() }),
  z.object({ semanticType: z.literal('ssnLast4'),    constraints: SsnConstraintsSchema.optional() }),
  z.object({ semanticType: z.literal('phoneNumber') }),
]);

export type LinkageKeyElement = z.infer<typeof LinkageKeyElementSchema>;

// ─── Linkage keys ────────────────────────────────────────────────────────────

const LinkageKeySchema = z.object({
  name: z.string().min(1),
  elements: z.array(LinkageKeyElementSchema).min(1),
  // TBD: `transposed: true` means the client uses a swapped version of the
  // elements. EXCHANGE_SPEC.md does not specify which elements are swapped;
  // DESIGN.md implies the entire element list is reversed (e.g. first name
  // swapped with last name).
  transposed: z.boolean().optional(),
});

export type LinkageKey = z.infer<typeof LinkageKeySchema>;

// ─── Payload ─────────────────────────────────────────────────────────────────
// TBD: EXCHANGE_SPEC.md states "each party independently specifies" send and
// receive columns, but the agreement is shared and verified by both parties.
// It is unclear whether a single shared document encodes both parties' views
// (with the expectation that A's send matches B's receive) or whether each
// party holds their own copy with different payload fields. The schema below
// follows the EXCHANGE_SPEC.md example literally.

const PayloadColumnSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});

const PayloadSchema = z.object({
  send: z.array(PayloadColumnSchema).optional(),
  receive: z.array(PayloadColumnSchema).optional(),
});

export type Payload = z.infer<typeof PayloadSchema>;

// ─── Legal agreement ─────────────────────────────────────────────────────────

const LegalAgreementSchema = z.object({
  reference: z.string().min(1),
  expirationDate: z.iso.date(),
});

export type LegalAgreement = z.infer<typeof LegalAgreementSchema>;

// ─── Exchange Agreement ───────────────────────────────────────────────────────
// TBD: Versioning scheme (e.g. semver) and version compatibility rules are
// unspecified.
//
// This schema validates the `agreement` key of an exchange specification
// document, not the full document. The full document additionally contains
// `connection`, `metadata`, and `cleaning` components (see EXCHANGE_SPEC.md).

const ExchangeAgreementBaseSchema = z.object({
  // Validates semver format; compatibility is checked separately at exchange time.
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'version must be a valid semver string'),
  parties: PartiesSchema,
  date: z.iso.date(),
  algorithm: AlgorithmSchema,
  output: OutputSchema,
  roles: RolesSchema.optional(),
  multiplicity: MultiplicitySchema,
  // Required when multiplicity is one-to-many; forbidden otherwise.
  constrainedParty: z.enum(['initiator', 'responder']).optional(),
  linkageKeys: z.array(LinkageKeySchema).min(1),
  payload: PayloadSchema.optional(),
  legalAgreement: LegalAgreementSchema.optional(),
});

export const ExchangeAgreementSchema = ExchangeAgreementBaseSchema
  .refine(
    (a) => a.multiplicity !== 'one-to-many' || a.constrainedParty !== undefined,
    { message: 'constrainedParty is required when multiplicity is one-to-many', path: ['constrainedParty'] }
  )
  .refine(
    (a) => a.multiplicity === 'one-to-many' || a.constrainedParty === undefined,
    { message: 'constrainedParty is only valid when multiplicity is one-to-many', path: ['constrainedParty'] }
  );

export type ExchangeAgreement = z.infer<typeof ExchangeAgreementSchema>;

// ─── Parse ───────────────────────────────────────────────────────────────────

export function parseExchangeAgreement(raw: unknown): ExchangeAgreement {
  return ExchangeAgreementSchema.parse(camelizeKeys(raw));
}

export function safeParseExchangeAgreement(raw: unknown) {
  return ExchangeAgreementSchema.safeParse(camelizeKeys(raw));
}