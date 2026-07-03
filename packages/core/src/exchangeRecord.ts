import { z } from "zod";

import {
  canonicalBytes,
  canonicalString,
  safeIntegerSchema,
} from "./utils/canonical.js";
import {
  bytesEqual,
  fromBase64Url,
  hmacSha256,
  randomBytes,
  sha256,
  toBase64Url,
} from "./utils/crypto.js";
import { AlgorithmSchema } from "./types.js";
import {
  MAX_LINKAGE_ENTRIES,
  MAX_NAME_LENGTH,
  MAX_PAYLOAD_ENTRIES,
  MAX_TEXT_LENGTH,
} from "./config/linkageTerms.js";
import { boundedArray } from "./utils/boundedArray.js";

import type { CanonicalValue } from "./utils/canonical.js";
import type { LinkageTerms } from "./config/linkageTerms.js";
import type { Algorithm, AssociationTable } from "./types.js";

// The exchange record: a self-attested, unsigned disclosure-log entry each party
// writes at the end of a successful exchange. It stands on its own as a record of
// what was disclosed -- the governing data-sharing agreement, the algorithm, the
// categories of data exchanged (payload column names/descriptions and the linkage
// fields the match keyed on), both self-asserted identities, the timestamp, the
// count of records this party exposed to the exchange, the result size when both
// parties are entitled to it, and an optional self-facing pointer to where this
// party filed its copy of the result and under what retention schedule -- so an
// operator can populate a HIPAA accounting of disclosures or a FERPA disclosure
// record without re-matching the original linkage-terms config. It carries
// readable governance metadata but NO
// protected data: no payload values, no linkage-field values, no matched
// identifiers. The data exchanged is bound by privacy-preserving commitments, not
// embedded.
//
// It is explicitly NOT a signed or non-repudiable receipt and NOT evidence
// against the partner. No private key is involved and no extra protocol round is
// added; signing this record is the separate, deferred Signed Exchange Receipts
// work. A bare hash of a low-entropy result (e.g. an association table over
// identifiers) would be brute-forceable by anyone holding the record, leaking the
// intersection; commitments with fresh per-commitment randomness bind to the data
// without revealing it. See docs/spec/EXCHANGE_RECORD.md and
// docs/spec/CANONICAL_ENCODING.md. The deferred signing work reuses this module's
// commitment scheme and on-disk format.

// --- Versions ----------------------------------------------------------------

/**
 * The one recognized format version for a v1 {@link ExchangeRecord}. A reader
 * (the verification item) rejects an unrecognized version rather than migrating
 * it; this literal is the schema's only accepted value.
 */
export const EXCHANGE_RECORD_VERSION = "psilink-exchange-record/v1";

/** The one recognized format version for v1 {@link VerificationKeys}. */
export const EXCHANGE_KEYS_VERSION = "psilink-exchange-keys/v1";

// --- Commitment scheme -------------------------------------------------------

/**
 * Byte length of every per-commitment salt and of the per-exchange binding
 * nonce. 32 bytes (256 bits) comfortably exceeds the >= 128-bit floor the
 * commitment's hiding property and the record's replay binding require.
 */
export const SALT_BYTES = 32;

/** The data sets a record commits to. The literal is the domain-separation
 * label folded into the commitment so a commitment of one kind can never verify
 * as another, and the key under which the commitment and its salt are stored
 * in the record and verification-keys files. */
export type CommitmentName =
  | "associationTable"
  | "localPayloadSent"
  | "partnerPayloadReceived";

// Domain-separation labels, one per commitment kind. Folded into the committed
// message (not the salt) so the three kinds are cryptographically distinct even
// under an identical (salt, data) pair. Keep them distinct -- in particular do
// not collapse the sent/received payload labels: domain separation is what stops
// a commitment of one kind from verifying as another. A consequence is that two
// parties' commitments to the same logical payload (a sender's localPayloadSent
// and the receiver's partnerPayloadReceived) are never equal as strings: the
// label differs and each uses a fresh per-commitment salt. So a future
// cross-verification re-supplies each party's committed data and recomputes the
// canonical bytes (byte-identical when both re-canonicalize the same logical data
// under the fixed RFC 8785 rules; see CommittedPayload) rather than comparing
// commitment strings. Recomputing the OTHER party's commitment also needs that
// party's salt -- the label and the salt both differ -- so it is not derivable
// from one's own record alone. The verification keys carry only the salts, never
// a data snapshot, so the data is re-supplied at verify time; see
// VerificationKeys.
const COMMITMENT_DOMAINS: Record<CommitmentName, string> = {
  associationTable: "psilink-commit-association-table/v1",
  localPayloadSent: "psilink-commit-payload-sent/v1",
  partnerPayloadReceived: "psilink-commit-payload-received/v1",
};

// Domain-separation label for the agreed-terms hash, kept distinct from the
// commitment domains above.
const AGREED_TERMS_DOMAIN = "psilink-agreed-terms/v1";

// computeCommitment, verifyCommitmentOpening, and computeTermsHash are
// intentionally part of the public API (re-exported via main.ts), not merely
// internal helpers or test-only exports: reproducing or verifying a psilink
// record in an independent implementation -- the cross-implementation
// reproducibility this module is built around (see
// test/vectors/exchange-record-vectors.json) -- means recomputing commitments
// and the agreed-terms hash directly. They are supported alongside the
// higher-level buildExchangeRecord / verifyRecordCommitments, so keep them
// exported rather than narrowing the surface.

/**
 * Compute the commitment to `data` of the given kind under `salt`.
 *
 * Construction: `HMAC-SHA-256(key = salt, message = canonical({domain, data}))`.
 * HMAC keyed by a secret >= 128-bit salt gives computational hiding (its output
 * reveals nothing about `data` without the salt, so a low-entropy `data` cannot
 * be brute-forced from the commitment alone); binding follows from the collision
 * resistance SHA-256 lends HMAC. The message is the canonical encoding (RFC
 * 8785) of `{domain, data}`, so the input bytes are reproducible across
 * implementations and the salt/data boundary is unambiguous (HMAC also fixes the
 * key/message boundary structurally). `data` must be in the canonical value
 * domain; binary data must already be base64url-encoded to a string.
 */
export async function computeCommitment(
  name: CommitmentName,
  salt: Uint8Array<ArrayBuffer>,
  data: CanonicalValue,
): Promise<Uint8Array<ArrayBuffer>> {
  const message = canonicalBytes({ domain: COMMITMENT_DOMAINS[name], data });
  return hmacSha256(salt, message);
}

/**
 * Verify that `salt` and the re-supplied `data` open `expectedValue` for a
 * commitment of the given kind: recompute the commitment from the salt and data
 * and compare (constant-time) against the stored base64url value. Returns
 * `false` for a tampered data set, a wrong salt, or any other mismatch.
 *
 * The `data` is re-supplied by the caller (from the holder's own retained input
 * and result), not read from a stored snapshot -- the verification keys carry
 * only salts. The caller must reproduce the exact canonical bytes the commitment
 * was computed over (the record format's `CommittedPayload` / association-table
 * shape; see docs/spec/CANONICAL_ENCODING.md), or verification fails even for a
 * genuine opening.
 *
 * Fail-safe: the contract is a boolean verdict, never an exception. A malformed
 * base64url salt/commitment, or re-supplied `data` outside the canonical encoding
 * domain, is treated as a mismatch (`false`) rather than throwing -- so the
 * eventual untrusted-record verifier can feed hostile input here and always get a
 * verdict. It only ever returns `true` on a genuine constant-time HMAC match.
 */
export async function verifyCommitmentOpening(
  name: CommitmentName,
  salt: string,
  data: CanonicalValue,
  expectedValue: string,
): Promise<boolean> {
  try {
    const expected = fromBase64Url(expectedValue);
    const saltBytes = fromBase64Url(salt);
    const actual = await computeCommitment(name, saltBytes, data);
    return bytesEqual(actual, expected);
  } catch {
    // A malformed base64url commitment/salt, or re-supplied data outside the
    // canonical encoding domain, cannot open any commitment: a mismatch, not a
    // throw. bytesEqual itself does not throw, so a `true` return still means a
    // genuine match.
    return false;
  }
}

// --- Agreed-terms hash -------------------------------------------------------

/**
 * Order the two parties' terms deterministically by their canonical encoding so
 * both parties derive the same agreed-terms object regardless of which one is
 * "local". Comparison is JavaScript's `<=` over the two RFC 8785 canonical
 * encodings, which orders by UTF-16 code unit -- deterministic and
 * locale-independent (it is not `localeCompare`). RFC 8785 emits non-ASCII as
 * raw UTF-8 rather than `\u` escapes, so the encodings are not ASCII-only; but
 * both parties compare byte-identical strings under the same code-unit ordering,
 * so the derived order is stable and platform- and locale-independent.
 */
function agreedTermsValue(a: LinkageTerms, b: LinkageTerms): CanonicalValue {
  // LinkageTerms is within the canonical value domain (plain objects, arrays,
  // strings, booleans); canonicalString enforces this at runtime and throws
  // CanonicalEncodingError otherwise. The cast bridges the structural type to
  // CanonicalValue, which canonicalString cannot infer statically.
  const ca = canonicalString(a as unknown as CanonicalValue);
  const cb = canonicalString(b as unknown as CanonicalValue);
  const ordered = ca <= cb ? [a, b] : [b, a];
  return {
    domain: AGREED_TERMS_DOMAIN,
    terms: ordered as unknown as CanonicalValue,
  };
}

/**
 * Compute the agreed-terms hash: the base64url SHA-256 over the canonical
 * encoding of both parties' linkage terms in a fixed (canonical-sorted) order.
 * Both parties compute the same value for the same agreed terms, and a different
 * value when either side's terms differ.
 */
export async function computeTermsHash(
  localTerms: LinkageTerms,
  partnerTerms: LinkageTerms,
): Promise<string> {
  const digest = await sha256(
    canonicalBytes(agreedTermsValue(localTerms, partnerTerms)),
  );
  return toBase64Url(digest);
}

// --- Record and verification-keys types --------------------------------------

/** Base64url commitment values keyed by {@link CommitmentName}. The local
 * payload sent and the partner payload received are always present (committing
 * to a no-data payload is a valid attestation); the association table is present
 * only when this party holds it (it received output). */
export interface ExchangeRecordCommitments {
  localPayloadSent: string;
  partnerPayloadReceived: string;
  associationTable?: string;
}

/** One payload column as a disclosure category: its name and any data-dictionary
 * description. Names and descriptions only, never values. Structurally this
 * mirrors a linkage-terms payload column but is owned by the record format (like
 * {@link CommittedPayload}), so a change to the config type cannot silently move
 * this version-frozen on-disk format. */
export interface RecordPayloadColumn {
  /** Column name. */
  name: string;
  /** Optional data-dictionary description. Unlike the name, a description is NOT
   * cross-party validated at exchange time, so the two parties' records may
   * legitimately carry different description text for the same column. */
  description?: string;
}

/** Reference to the governing data-sharing agreement, copied from the agreed
 * terms. A single shared reference: the two parties' agreement reference,
 * purpose, and expiration are required to match at exchange time, so the record
 * stores one authority for the disclosure rather than two. */
export interface RecordLegalAgreement {
  /** Human-readable agreement identifier (e.g. "MOU-2025-0042"). */
  reference: string;
  /** Readable statement of the purpose/authority for this disclosure under the
   * agreement -- the HIPAA 164.528 / FERPA 99.32 purpose, carried so the record
   * states why the disclosure happened without opening the agreement. Metadata
   * only -- never a protected, linkage-field, or payload value. */
  purpose: string;
  /** Date after which the agreement no longer authorizes an exchange (ISO 8601,
   * YYYY-MM-DD). */
  expirationDate: string;
}

/** One linkage field in the matching basis: the standardized field name the match
 * keyed on and its semantic type. Names and types only, never values. The
 * standardized `name` (not the raw source column) is the identifier the linkage
 * keys, the standardization config, and the cross-party agreement all reference,
 * so it is the stable anchor for tracing the basis back through standardization to
 * the data; the `type` is the human-legible PII category. Both are mutually
 * validated identical across parties at exchange time. */
export interface RecordLinkageField {
  /** Standardized linkage-field name (not the raw source column). */
  name: string;
  /** Semantic PII type (e.g. "last_name", "date_of_birth", "ssn4"). */
  type: string;
}

/**
 * Readable, non-sensitive governance metadata that lets the record stand on its
 * own as a disclosure-log entry: the authority for the disclosure and the
 * categories of data involved, identifying what was disclosed without consulting
 * the original config. Every field is a name, category, description, or reference
 * -- never a payload value, linkage-field value, or matched identifier. The
 * algorithm, legal agreement, and matching basis are drawn from terms both
 * parties validated at exchange time; the payload column sets are drawn from the
 * committed payloads instead. Both parties'
 * records still carry consistent governance metadata for the same exchange -- the
 * committed payloads are byte-identical across parties, so one party's
 * {@link payloadSent} equals the other's {@link payloadReceived} -- with the lone
 * exception of a column's free-text {@link RecordPayloadColumn.description}, which
 * is not cross-party validated.
 */
export interface ExchangeRecordGovernance {
  /** The matching algorithm: `psi` revealed matched identifiers, `psi-c` revealed
   * only a count -- i.e. whether identifiers or only a count were disclosed. */
  algorithm: Algorithm;
  /** The governing data-sharing agreement, when the terms named one; omitted when
   * no legal agreement was configured (its absence is explicit, not ambiguous). */
  legalAgreement?: RecordLegalAgreement;
  /** The linkage fields the match keyed on -- the standardized name and semantic
   * type of each field the linkage keys reference, documenting the basis on which
   * shared membership was determined. Scoped to the fields the keys ACTUALLY
   * reference, not every declared linkage field: a declared-but-unused field was
   * not matched on, so recording it would overstate the basis. Names and types
   * only -- never values. Sorted by `name` (UTF-16 code unit) so both parties and
   * both implementations derive the same order. */
  matchingBasis: RecordLinkageField[];
  /** The payload columns this party committed as sent for matched records (names
   * and any data-dictionary descriptions) -- the columns the disclosure gate
   * actually transmitted, not a declared dictionary that may under-state them.
   * Empty when this party committed no payload for matched records -- no columns
   * were disclosed, or no records matched -- represented explicitly, not by
   * omission. */
  payloadSent: RecordPayloadColumn[];
  /** The payload columns this party committed as received for matched records.
   * Empty when this party received no payload. */
  payloadReceived: RecordPayloadColumn[];
}

/**
 * A self-attested local disclosure-log entry for one successful exchange. It
 * records, in cleartext, that an exchange with the named partner occurred, under
 * which agreement, over what categories of data, and its size -- enough to stand
 * on its own as an audit artifact. It holds readable governance metadata and the
 * data commitments only; it does not contain the matched data or the salts, so it
 * does not reveal (or allow brute-force recovery of) the intersection. Because it
 * names both parties and the disclosure in cleartext, retention and access
 * control are the holder's responsibility. This is a local audit artifact, not a
 * signed or non-repudiable receipt.
 *
 * Rendering note (forward-looking): this record stores partner-supplied free text
 * -- `partnerIdentity`, `governance.legalAgreement.reference`/`purpose`, and the
 * payload column names/descriptions -- byte-for-byte, as required for the
 * byte-exact cross-party validation and the canonical encoding a record is hashed
 * over. A party can place terminal control/ANSI sequences or deceptive Unicode
 * (bidi-override, zero-width, homoglyph) in these fields. No viewer or exporter
 * renders a record to a person today; when one is built, it MUST route each such
 * field through `sanitizeForDisplay` (the helper `validateCompatibility` uses) at
 * the display boundary -- never mutate the stored value, which must stay
 * byte-exact.
 */
export interface ExchangeRecord {
  /** Single recognized format version for v1; readers reject anything else. */
  version: typeof EXCHANGE_RECORD_VERSION;
  /** Local wall-clock time the record was produced (ISO 8601). */
  createdAt: string;
  /** Base64url SHA-256 over the canonical encoding of both parties' terms. */
  termsHash: string;
  /** This party's self-asserted identity (from its linkage terms). */
  localIdentity: string;
  /** The partner's self-asserted identity (from the terms it sent). */
  partnerIdentity: string;
  /** Readable governance metadata (the authority for, and the categories of, the
   * disclosure) that makes this record a standalone disclosure-log entry. */
  governance: ExchangeRecordGovernance;
  /** The number of records this party contributed to the exchange -- the size of
   * its own input, recorded for every party as a per-direction statement of what
   * it put in. This is the input row count: it counts every contributed record,
   * not only the rows that resolve to a usable linkage key, so it is an honest
   * upper bound on what this party exposed rather than a derived match figure.
   * Distinct from {@link resultSize}: it is the size of THIS party's input, not the
   * intersection, so it is known from the party's own data alone and stays
   * meaningful even under a future algorithm that discloses neither the result size
   * nor the partner's set size. Always present (a party always knows its own input
   * size); carries no protected value -- an aggregate count of the holder's own
   * records. */
  recordsExposed: number;
  /** Intersection size, present only in the both-output case -- recorded only when
   * both parties' agreed terms have them both receive output, so it is stored only
   * when both sides are entitled to the result. Omitted when only one party
   * receives output: the gate is the terms agreement (entitlement), NOT what a
   * party happens to observe during the protocol. A single-output helper can
   * observe its match count during the clean cascade, but the record deliberately
   * does not surface it -- privacy here is enforced by what the tool writes down,
   * not by what is theoretically discoverable. Each party's own outbound exposure
   * is carried by {@link recordsExposed} instead. */
  resultSize?: number;
  /** Optional self-facing retention/disposition pointer: a free-text operator
   * note recording where this party filed its copy of the result (the
   * association table / received payload) and under what retention schedule it is
   * held or disposed of, so the record stands alone for this party's own audit.
   * Unlike the {@link governance} block, it is NOT drawn from the agreed terms: it
   * is sourced from this party's local exchange config, never exchanged with the
   * partner, and not folded into {@link ExchangeRecord.termsHash} -- so the two
   * parties' records legitimately carry different pointers (or none). Metadata
   * only: it carries no protected, linkage-field, or payload value. Omitted
   * entirely when absent -- its absence is explicit, never an empty string. */
  retentionDisposition?: string;
  /** Per-exchange CSPRNG binder (base64url, >= 128 bits) so two runs with
   * identical terms still produce distinct records. Distinct from the
   * per-commitment salts; not a hiding secret. */
  bindingNonce: string;
  commitments: ExchangeRecordCommitments;
}

/** Per-commitment salts, keyed by {@link CommitmentName}, mirroring the record's
 * commitments. Each salt is the secret HMAC key for its commitment; the local
 * payload sent and partner payload received are always present, the association
 * table only when this party committed it. */
export interface CommitmentSalts {
  /** Base64url per-commitment salt (>= 128 bits). */
  localPayloadSent: string;
  partnerPayloadReceived: string;
  associationTable?: string;
}

/**
 * The private verification keys for an {@link ExchangeRecord}: the per-commitment
 * salts and NOTHING ELSE. A salt is a secret HMAC key, not committed data, so --
 * unlike an earlier self-contained design that also snapshotted the data -- these
 * keys are NOT a second at-rest copy of the matched data: they carry no payload
 * values and no matched-record pairing. The matched data lives only in the result
 * the operator chose to write, never in this file.
 *
 * They are still private, not shareable: a salt together with the record's
 * commitment can brute-force a low-entropy committed value (notably the
 * intersection), so anyone holding both the keys and the record could open the
 * commitments. Verification therefore re-supplies the committed data (from the
 * holder's own retained input and result) and recomputes the canonical bytes;
 * see {@link verifyRecordCommitments}. The keys and the record are separate
 * artifacts on both surfaces (the CLI writes two files; the web offers two
 * downloads), so the record stays safe to hand an auditor without the keys.
 */
export interface VerificationKeys {
  version: typeof EXCHANGE_KEYS_VERSION;
  salts: CommitmentSalts;
}

// --- Schemas -----------------------------------------------------------------

// Untrusted-input bounds. parseExchangeRecord's first production caller is the
// verification reader, which ingests a record file supplied by another party --
// the first untrusted caller of this parser (records were previously only written
// to disk / offered as downloads, never parsed back from an untrusted source). So
// every partner-controlled string and array below carries a generous length /
// element-count cap -- the same caps the linkage-terms producers imply
// (MAX_NAME_LENGTH, MAX_TEXT_LENGTH, MAX_LINKAGE_ENTRIES, MAX_PAYLOAD_ENTRIES) so a
// record this module produces always parses back -- applied so an oversized
// hostile record is rejected at parse rather than forcing proportional
// allocation. Array counts use boundedArray (a count refine BEFORE per-element
// validation) for the same Zod issue-accumulation reason the linkage-terms bounds
// document. The bounds reject; they do not reshape a valid record. These are
// defense-in-depth ceilings, not semantic limits.

// Length cap for the fixed-size base64url crypto values a record and its keys
// carry (termsHash, bindingNonce, each commitment, each salt): every one is a
// 32-byte value -- 43 unpadded base64url characters -- so 256 is far above any
// legitimate value yet refuses a megabyte-scale hostile string. Bounds the field
// for the untrusted reader without length-locking the exact byte count (a reader
// still verifies by recomputing the commitment, so the exact length is not
// pinned).
const MAX_BASE64URL_LENGTH = 256;

// Base64url without padding (the binary encoding used throughout receipts; see
// docs/spec/CANONICAL_ENCODING.md). Length-CAPPED (not length-locked): the `.max`
// precedes the regex so an oversized hostile value is rejected before the pattern
// scan, while the exact byte length stays unpinned.
const base64UrlSchema = z
  .string()
  .max(MAX_BASE64URL_LENGTH)
  .regex(/^[A-Za-z0-9_-]+$/, "must be an unpadded base64url string");

// Both the intersection size and the records-exposed count are non-negative safe
// integers; share one constraint so the two count fields validate identically.
const nonNegativeCountSchema = (label: string) =>
  safeIntegerSchema.refine((n) => n >= 0, {
    message: `${label} must be non-negative`,
  });
const resultSizeSchema = nonNegativeCountSchema("result size");
const recordsExposedSchema = nonNegativeCountSchema("records exposed");

// The retention/disposition pointer is a non-empty free-text note. An absent
// pointer is the omitted key, never an empty string, so reject "" here: the
// builder validates with this same schema, keeping the absence explicit.
const retentionDispositionSchema = z.string().min(1).max(MAX_TEXT_LENGTH);

// Shared by the parser and the builder so both agree on what `createdAt` may be:
// an ISO 8601 datetime in UTC (ending in `Z`). `z.iso.datetime()` rejects
// timezone offsets by default, which holds the timestamp to a single canonical
// form -- the signing phase signs over createdAt's canonical bytes, so one UTC
// form avoids two records for the same instant differing only by offset. The
// UTC-only requirement is documented in EXCHANGE_RECORD.md. Reused at build time (see
// buildExchangeRecord) so a malformed timestamp throws there rather than
// producing a record the parser would later reject.
const createdAtSchema = z.iso.datetime();

// Shared by the parser and the builder so both agree the identities are
// non-empty strings; validated at build time alongside createdAt and resultSize.
const identitySchema = z.string().min(1).max(MAX_TEXT_LENGTH);

const ExchangeRecordCommitmentsSchema: z.ZodType<ExchangeRecordCommitments> =
  z.object({
    localPayloadSent: base64UrlSchema,
    partnerPayloadReceived: base64UrlSchema,
    associationTable: base64UrlSchema.optional(),
  });

const RecordPayloadColumnSchema: z.ZodType<RecordPayloadColumn> = z.object({
  // Bound the name length: a payloadReceived column name originates from the
  // partner's payload wire message, so this is the on-disk backstop for the wire
  // bound in payloadExchange.ts -- an over-long name cannot reach the record by
  // any path. MAX_NAME_LENGTH matches both the wire predicate and the operator's
  // own `terms.payload.send`/`receive` names.
  name: z.string().min(1).max(MAX_NAME_LENGTH),
  description: z.string().max(MAX_TEXT_LENGTH).optional(),
});

const RecordLegalAgreementSchema: z.ZodType<RecordLegalAgreement> = z.object({
  reference: z.string().min(1).max(MAX_NAME_LENGTH),
  purpose: z.string().min(1).max(MAX_TEXT_LENGTH),
  expirationDate: z.iso.date(),
});

const RecordLinkageFieldSchema: z.ZodType<RecordLinkageField> = z.object({
  name: z.string().min(1).max(MAX_NAME_LENGTH),
  // `type` is not pinned to the current LinkageField type enum: the record is a
  // frozen log, so a reader accepts whatever category a (possibly newer) writer
  // recorded rather than rejecting an unrecognized type. It carries the same
  // length cap as a name -- a semantic category is a short label, not prose.
  type: z.string().min(1).max(MAX_NAME_LENGTH),
});

const ExchangeRecordGovernanceSchema: z.ZodType<ExchangeRecordGovernance> =
  z.object({
    // algorithm stays pinned to the closed enum even though the sibling
    // RecordLinkageField.type is an open string -- a deliberate asymmetry, not an
    // oversight. type is open descriptive taxonomy: a newer PII category does not
    // change what the record means, so a frozen-log reader passes it through.
    // algorithm is meaning-bearing protocol structure that gates the disclosure
    // semantics (psi revealed identifiers, psi-c only a count); a record carrying
    // an algorithm this version does not define is not a v1 record. The version
    // literal already rejects a future format, so reject an unknown algorithm here
    // rather than admit semantics a v1 reader cannot interpret.
    algorithm: AlgorithmSchema,
    legalAgreement: RecordLegalAgreementSchema.optional(),
    // Count-bounded (boundedArray: a count refine before per-element validation)
    // so a hostile record padded with millions of fields/columns is rejected with
    // one clean issue rather than accumulating one Zod issue per element. The
    // matching basis is a set of linkage fields (MAX_LINKAGE_ENTRIES); the payload
    // column sets share the same cap the payload producers imply
    // (MAX_PAYLOAD_ENTRIES).
    matchingBasis: boundedArray(
      RecordLinkageFieldSchema,
      MAX_LINKAGE_ENTRIES,
      `matchingBasis must not exceed ${MAX_LINKAGE_ENTRIES} entries`,
    ),
    payloadSent: boundedArray(
      RecordPayloadColumnSchema,
      MAX_PAYLOAD_ENTRIES,
      `payloadSent must not exceed ${MAX_PAYLOAD_ENTRIES} entries`,
    ),
    payloadReceived: boundedArray(
      RecordPayloadColumnSchema,
      MAX_PAYLOAD_ENTRIES,
      `payloadReceived must not exceed ${MAX_PAYLOAD_ENTRIES} entries`,
    ),
  });

const ExchangeRecordSchema: z.ZodType<ExchangeRecord> = z.object({
  version: z.literal(EXCHANGE_RECORD_VERSION),
  createdAt: createdAtSchema,
  termsHash: base64UrlSchema,
  localIdentity: identitySchema,
  partnerIdentity: identitySchema,
  governance: ExchangeRecordGovernanceSchema,
  recordsExposed: recordsExposedSchema,
  resultSize: resultSizeSchema.optional(),
  retentionDisposition: retentionDispositionSchema.optional(),
  bindingNonce: base64UrlSchema,
  commitments: ExchangeRecordCommitmentsSchema,
});

const CommitmentSaltsSchema: z.ZodType<CommitmentSalts> = z.object({
  localPayloadSent: base64UrlSchema,
  partnerPayloadReceived: base64UrlSchema,
  associationTable: base64UrlSchema.optional(),
});

const VerificationKeysSchema: z.ZodType<VerificationKeys> = z.object({
  version: z.literal(EXCHANGE_KEYS_VERSION),
  salts: CommitmentSaltsSchema,
});

// --- Build -------------------------------------------------------------------

/**
 * The canonical representation a payload is committed in: the disclosed column
 * names and the row VALUES, in matched-row order. Owned by the record format on
 * purpose -- deliberately NOT the PSI wire message and NOT the consumed
 * `PartnerPayload`, so a change to either of those (for transport or output
 * reasons) cannot silently move this on-disk, version-frozen format.
 *
 * It binds the column names and the values, NOT any party's internal row
 * indices. The received payload's rows carry the PARTNER's row indices on the
 * wire (see `PartnerPayload`), which the holder does not retain in a reproducible
 * form -- the human result file records the received values, not the partner's
 * row numbers -- so committing them would leave a holder unable to reopen its own
 * commitment from its retained input and result. The payload commitment therefore
 * binds only what the holder keeps (the columns and the values); WHICH records
 * matched is bound separately by the association-table commitment (an index pair),
 * which the result file does retain. See docs/spec/EXCHANGE_RECORD.md, "No data
 * snapshot in the keys".
 *
 * Both the payload a party sent and the payload it received are mapped into this
 * one shape before committing (see `toCommittedPayload` in payloadExchange), so
 * for the same logical payload a sender and receiver commit over byte-identical
 * data. The transport-only `hasData` discriminant is not part of it; a no-data
 * payload is the empty-arrays value `{ columns: [], rows: [] }`.
 *
 * Declared as a `type` (not an `interface`) so it carries an implicit index
 * signature and is assignable to {@link CanonicalValue} without a cast.
 */
export type CommittedPayload = {
  columns: string[];
  rows: Array<Array<string | null>>;
};

/**
 * The inputs needed to build an {@link ExchangeRecord}, gathered at the end of a
 * successful exchange. `localTerms`/`partnerTerms` supply the agreed-terms hash,
 * the two identities, and most of the readable governance metadata (algorithm,
 * legal agreement, and matching basis -- read from `localTerms`); the payload
 * categories are instead read from the committed `localPayloadSent`/
 * `partnerPayloadReceived` below (with descriptions looked up in `localTerms`'s
 * payload dictionary), so they reflect what was committed. `recordsExposed` is
 * this party's own input row count
 * (always supplied); `resultSize` is set only when both parties are entitled to it
 * (the both-output case); `associationTable` only when this party holds it;
 * `retentionDisposition` is an optional self-facing pointer from this party's local
 * config, independent of `localTerms`/`partnerTerms` and never put on the wire. The
 * two payload data sets are always committed (a no-data payload is committed as such).
 */
export interface ExchangeRecordInputs {
  localTerms: LinkageTerms;
  partnerTerms: LinkageTerms;
  /** This party's own input row count (the number of records it contributed to
   * the exchange). Always supplied -- a party always knows its own input size. */
  recordsExposed: number;
  /** Intersection size; supply only in the both-output case. */
  resultSize?: number;
  /** Optional self-facing retention/disposition pointer, sourced from this
   * party's local exchange config (NOT the agreed terms): where this party filed
   * its copy of the result and its retention schedule. Per-party, never exchanged
   * with the partner, never hashed. Omit when absent. */
  retentionDisposition?: string;
  /** The association table; supply only when this party received output. */
  associationTable?: AssociationTable;
  /** The payload this party sent, in the record's canonical committed form. */
  localPayloadSent: CommittedPayload;
  /** The payload this party received, in the same canonical committed form, so
   * both parties commit over byte-identical data for the same logical payload. */
  partnerPayloadReceived: CommittedPayload;
  /** Local wall-clock timestamp (ISO 8601); supplied by the caller so the build
   * is otherwise deterministic and testable. */
  createdAt: string;
}

/**
 * Random material for {@link buildExchangeRecord}. Optional in production (a
 * fresh CSPRNG value is generated for the binding nonce and each present
 * commitment's salt); injected by tests to make the build deterministic and to
 * assert cross-implementation reproducibility.
 */
export interface ExchangeRecordRandomness {
  bindingNonce: Uint8Array<ArrayBuffer>;
  salts: Partial<Record<CommitmentName, Uint8Array<ArrayBuffer>>>;
}

/** The two artifacts {@link buildExchangeRecord} produces: the shareable record
 * and its private verification keys. */
export interface BuiltExchangeRecord {
  record: ExchangeRecord;
  keys: VerificationKeys;
}

/**
 * Derive the record's readable governance metadata.
 *
 * `algorithm`, `legalAgreement`, and the matching basis come from this party's
 * agreed terms: the first two are cross-party validated (so they equal the
 * partner's), and the matching basis is the linkage fields the keys reference.
 *
 * The payload column SETS, however, are read from the COMMITTED payloads
 * (`localPayloadSent` / `partnerPayloadReceived`), not from the optional
 * `terms.payload.send`/`receive` data dictionary. The dictionary is operator-
 * authored and may be empty (the web term builders never populate it) or
 * under-declare what the metadata disclosure gate actually transmits, while the
 * committed columns ARE what flowed -- the output of the same
 * `isDisclosedToPartner` gate that drives `preparePayload`. Sourcing the readable
 * list from the committed columns keeps `payloadSent`/`payloadReceived` from
 * drifting from the committed bytes (reading "sent nothing" while real columns
 * were committed), and -- because a sender's `localPayloadSent` and the receiver's
 * `partnerPayloadReceived` commit over byte-identical data -- keeps the two
 * parties' records mutually consistent for the same exchange. The dictionary is
 * still consulted, by column name, for the optional data-dictionary DESCRIPTION
 * attached to each committed column; a committed column the dictionary does not
 * describe carries a bare name. Reads names, types, descriptions, and the
 * agreement reference and purpose only -- never a value.
 */
function governanceFromTerms(
  terms: LinkageTerms,
  localPayloadSent: CommittedPayload,
  partnerPayloadReceived: CommittedPayload,
): ExchangeRecordGovernance {
  // Map the columns ACTUALLY committed for a direction into record columns,
  // attaching each column's data-dictionary description from the operator-authored
  // declared list (looked up by name) when one is present. The committed columns
  // are authoritative for the set; the dictionary only annotates them. Omit
  // `description` entirely when absent rather than emitting `undefined`: an absent
  // key and a null/undefined key are distinct in the canonical encoding the
  // deferred signing work will hash over this record.
  const describeCommitted = (
    committedColumns: readonly string[],
    declared: ReadonlyArray<{ name: string; description?: string }> | undefined,
  ): RecordPayloadColumn[] => {
    const descriptionByName = new Map(
      (declared ?? []).map((c) => [c.name, c.description] as const),
    );
    return committedColumns.map((name) => {
      const description = descriptionByName.get(name);
      return description !== undefined ? { name, description } : { name };
    });
  };

  // The matching basis is the linkage fields the keys ACTUALLY reference, not
  // every declared field: a declared-but-unused field was not matched on, so
  // recording it would overstate the basis. Walk the keys, resolve each element's
  // field reference to its declared field (for the semantic type), dedupe by name
  // (a field used in several keys appears once), and sort by name -- the same
  // code-unit ordering validateCompatibility and the canonical encoder use, so the
  // order is deterministic and identical across parties and platforms.
  const fieldByName = new Map(terms.linkageFields.map((f) => [f.name, f]));
  const seen = new Set<string>();
  const matchingBasis: RecordLinkageField[] = [];
  for (const key of terms.linkageKeys) {
    for (const element of key.elements) {
      if (seen.has(element.field)) continue;
      // Mark the reference processed before resolving it, so a repeated dangling
      // reference is deduplicated on lookup like any other. Output is unchanged --
      // an unresolved reference emits nothing either way.
      seen.add(element.field);
      const field = fieldByName.get(element.field);
      // A key element should always reference a declared field; skip an
      // unresolved reference rather than emitting a field with no semantic type.
      if (field === undefined) continue;
      matchingBasis.push({ name: field.name, type: field.type });
    }
  }
  matchingBasis.sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );

  return {
    algorithm: terms.algorithm,
    ...(terms.legalAgreement !== undefined
      ? {
          legalAgreement: {
            reference: terms.legalAgreement.reference,
            purpose: terms.legalAgreement.purpose,
            expirationDate: terms.legalAgreement.expirationDate,
          },
        }
      : {}),
    matchingBasis,
    payloadSent: describeCommitted(
      localPayloadSent.columns,
      terms.payload?.send,
    ),
    payloadReceived: describeCommitted(
      partnerPayloadReceived.columns,
      terms.payload?.receive,
    ),
  };
}

/**
 * Build the self-attested {@link ExchangeRecord} and its {@link VerificationKeys}
 * from the end-of-exchange inputs. Generates a fresh binding nonce and a fresh
 * salt per commitment (unless `randomness` injects them), commits to each data
 * set, and hashes the agreed terms. No private key and no network round-trip.
 *
 * The returned keys hold only the salts, never the committed `data`, so the
 * inputs are not retained past this call and neither artifact is a second copy
 * of the matched data. The commitment bytes are computed here from the inputs;
 * verification later re-supplies the same data (see {@link verifyRecordCommitments}).
 */
export async function buildExchangeRecord(
  inputs: ExchangeRecordInputs,
  randomness?: ExchangeRecordRandomness,
): Promise<BuiltExchangeRecord> {
  // localPayloadSent and partnerPayloadReceived are always committed; the
  // association table is committed only when this party holds it.
  const datasets: Array<{ name: CommitmentName; data: CanonicalValue }> = [
    { name: "localPayloadSent", data: inputs.localPayloadSent },
    { name: "partnerPayloadReceived", data: inputs.partnerPayloadReceived },
  ];
  if (inputs.associationTable !== undefined)
    datasets.push({
      name: "associationTable",
      data: inputs.associationTable,
    });

  const recordCommitments: Partial<Record<CommitmentName, string>> = {};
  const commitmentSalts: Partial<Record<CommitmentName, string>> = {};
  for (const { name, data } of datasets) {
    const salt = randomness?.salts[name] ?? randomBytes(SALT_BYTES);
    const value = await computeCommitment(name, salt, data);
    recordCommitments[name] = toBase64Url(value);
    commitmentSalts[name] = toBase64Url(salt);
  }

  const bindingNonce = randomness?.bindingNonce ?? randomBytes(SALT_BYTES);
  const termsHash = await computeTermsHash(
    inputs.localTerms,
    inputs.partnerTerms,
  );

  const record: ExchangeRecord = {
    version: EXCHANGE_RECORD_VERSION,
    // Validate on build with the same schema the parser uses, so the builder and
    // parser agree on what a record may contain: a non-ISO/non-UTC timestamp or
    // an empty identity throws here (caught by the non-fatal build guard in
    // runExchange) rather than producing a record the parser would later reject
    // at round-trip.
    createdAt: createdAtSchema.parse(inputs.createdAt),
    termsHash,
    localIdentity: identitySchema.parse(inputs.localTerms.identity),
    partnerIdentity: identitySchema.parse(inputs.partnerTerms.identity),
    // Readable governance metadata. The agreement, algorithm, and matching basis
    // come from this party's agreed terms (already schema-validated, so well-formed
    // by construction); the payload column sets come from the committed payloads, so
    // the readable disclosure cannot diverge from the committed bytes. Carries no
    // values -- only names, categories, descriptions, and the agreement reference.
    // Validate on build with the same schema the parser uses, as createdAt and the
    // identities above: payloadReceived's column names are taken from the partner's
    // payload wire message, which is validated only as strings (payloadExchange.ts),
    // looser than this record's RecordPayloadColumn (a name must be non-empty). A
    // malformed partner column name therefore throws here (caught by the non-fatal
    // build guard in runExchange, so the exchange and its result are unaffected)
    // rather than silently writing an audit record the parser would later reject.
    governance: ExchangeRecordGovernanceSchema.parse(
      governanceFromTerms(
        inputs.localTerms,
        inputs.localPayloadSent,
        inputs.partnerPayloadReceived,
      ),
    ),
    // This party's own input row count, validated on build with the
    // same schema the parser uses (as createdAt/resultSize below): a negative or
    // non-safe-integer count throws here rather than producing a record the parser
    // would later reject.
    recordsExposed: recordsExposedSchema.parse(inputs.recordsExposed),
    // Omit the key entirely when absent rather than setting it to undefined: an
    // absent field and a null/undefined field are distinct in the canonical
    // encoding the signing phase will hash over this record. Validate on build
    // with the same schema the parser uses (as createdAt above): a negative or
    // non-safe-integer size throws here rather than producing a record the parser
    // would later reject or that cannot canonically encode.
    ...(inputs.resultSize !== undefined
      ? { resultSize: resultSizeSchema.parse(inputs.resultSize) }
      : {}),
    // Self-facing retention/disposition pointer, copied verbatim from this
    // party's local config. Omit the key entirely when absent (an absent field
    // and a null/undefined field are distinct in the canonical encoding the
    // signing phase will hash over this record). Validate with the same schema the
    // parser uses, so an empty string throws here rather than producing a record
    // the parser would later reject.
    ...(inputs.retentionDisposition !== undefined
      ? {
          retentionDisposition: retentionDispositionSchema.parse(
            inputs.retentionDisposition,
          ),
        }
      : {}),
    bindingNonce: toBase64Url(bindingNonce),
    commitments: recordCommitments as ExchangeRecordCommitments,
  };
  const keys: VerificationKeys = {
    version: EXCHANGE_KEYS_VERSION,
    salts: commitmentSalts as CommitmentSalts,
  };
  return { record, keys };
}

// --- Serialize / parse -------------------------------------------------------

// Pretty JSON with a trailing newline. This is the on-disk/download form: an
// ordinary, human-readable JSON file, NOT the canonical encoding (which is only
// for the bytes that are hashed, committed, or -- in a later phase -- signed).
// Shared by the CLI and the web app so both write byte-identical files.
function serialize(value: ExchangeRecord | VerificationKeys): string {
  return JSON.stringify(value, null, 2) + "\n";
}

/** Serialize an {@link ExchangeRecord} to its on-disk/download string form. */
export function serializeExchangeRecord(record: ExchangeRecord): string {
  return serialize(record);
}

/** Serialize {@link VerificationKeys} to its on-disk/download string form. */
export function serializeVerificationKeys(keys: VerificationKeys): string {
  return serialize(keys);
}

/**
 * Parse and validate an {@link ExchangeRecord} from a raw value (e.g. the result
 * of `JSON.parse`). Rejects an unrecognized `version` rather than migrating it.
 *
 * @throws {z.ZodError} if validation fails.
 */
export function parseExchangeRecord(raw: unknown): ExchangeRecord {
  return ExchangeRecordSchema.parse(raw);
}

/**
 * Parse and validate {@link VerificationKeys} from a raw value.
 *
 * @throws {z.ZodError} if validation fails.
 */
export function parseVerificationKeys(raw: unknown): VerificationKeys {
  return VerificationKeysSchema.parse(raw);
}

// --- Verify ------------------------------------------------------------------

/** Per-commitment verdicts from {@link verifyRecordCommitments}, keyed by
 * {@link CommitmentName}. A commitment is valid when its salt and the re-supplied
 * data recompute to the stored value. */
export type RecordCommitmentVerdicts = Partial<Record<CommitmentName, boolean>>;

/**
 * Verify that every commitment present in `record` opens against the salt in
 * `keys` and the re-supplied committed `data`. Returns the per-commitment
 * verdicts and an `allValid` flag. A commitment with no salt, with no re-supplied
 * data, or a salt with no commitment, is a mismatch.
 *
 * `data` re-supplies the exact committed data sets, keyed by {@link CommitmentName}:
 * the verification keys hold only salts, not a snapshot, so the caller provides
 * the data (from its own retained input and result) and must reproduce the exact
 * canonical bytes the commitment was computed over. An omitted entry leaves that
 * commitment unverifiable (reported as a mismatch).
 *
 * This does not verify the agreed-terms hash, which requires re-supplying the
 * terms; full record verification is the verification item's concern. Provided
 * here so the build's correctness, binding, and tamper-resistance are testable
 * and so callers can self-check before relying on a record.
 */
export async function verifyRecordCommitments(
  record: ExchangeRecord,
  keys: VerificationKeys,
  data: Partial<Record<CommitmentName, CanonicalValue>>,
): Promise<{ verdicts: RecordCommitmentVerdicts; allValid: boolean }> {
  const names: CommitmentName[] = [
    "localPayloadSent",
    "partnerPayloadReceived",
    "associationTable",
  ];
  // localPayloadSent and partnerPayloadReceived are mandatory in a well-formed
  // record (the schema requires them); the association table is optional. This
  // function accepts any typed ExchangeRecord/VerificationKeys, so a value built
  // without going through parseExchangeRecord could omit a mandatory commitment.
  // Treat a missing mandatory commitment as invalid rather than vacuously
  // skipping it -- otherwise a record with no commitments at all would report
  // allValid=true with an empty verdicts object.
  const mandatory: ReadonlySet<CommitmentName> = new Set([
    "localPayloadSent",
    "partnerPayloadReceived",
  ]);
  const verdicts: RecordCommitmentVerdicts = {};
  let allValid = true;
  for (const name of names) {
    const value = record.commitments[name];
    const salt = keys.salts[name];
    const supplied = data[name];
    if (value === undefined && salt === undefined) {
      if (mandatory.has(name)) {
        verdicts[name] = false;
        allValid = false;
      }
      continue;
    }
    // A commitment without its salt, a salt without its commitment, or a
    // commitment whose data was not re-supplied cannot be verified: mismatch.
    if (value === undefined || salt === undefined || supplied === undefined) {
      verdicts[name] = false;
      allValid = false;
      continue;
    }
    const ok = await verifyCommitmentOpening(name, salt, supplied, value);
    verdicts[name] = ok;
    if (!ok) allValid = false;
  }
  return { verdicts, allValid };
}
