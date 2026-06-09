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

import type { CanonicalValue } from "./utils/canonical.js";
import type { LinkageTerms } from "./config/linkageTerms.js";
import type { Algorithm, AssociationTable } from "./types.js";

// The exchange record: a self-attested, unsigned disclosure-log entry each party
// writes at the end of a successful exchange. It stands on its own as a record of
// what was disclosed -- the governing data-sharing agreement, the algorithm, the
// categories of data exchanged (payload column names/descriptions and the linkage
// fields the match keyed on), both self-asserted identities, the timestamp, and the
// result size when both parties learn it -- so an operator can populate a HIPAA
// accounting of disclosures or a FERPA disclosure record without re-matching the
// original linkage-terms config. It carries readable governance metadata but NO
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
// without revealing it. See docs/PROTOCOL.md ("Self-attested record") and
// docs/CANONICAL_ENCODING.md. The deferred signing work reuses this module's
// commitment scheme and on-disk format.

// --- Versions ----------------------------------------------------------------

/**
 * The one recognized format version for a v1 {@link ExchangeRecord}. A reader
 * (the verification item) rejects an unrecognized version rather than migrating
 * it; this literal is the schema's only accepted value.
 */
export const EXCHANGE_RECORD_VERSION = "psilink-exchange-record/v1";

/** The one recognized format version for v1 {@link OpeningData}. */
export const EXCHANGE_OPENING_VERSION = "psilink-exchange-opening/v1";

// --- Commitment scheme -------------------------------------------------------

/**
 * Byte length of every per-commitment salt and of the per-exchange binding
 * nonce. 32 bytes (256 bits) comfortably exceeds the >= 128-bit floor the
 * commitment's hiding property and the record's replay binding require.
 */
export const SALT_BYTES = 32;

/** The data sets a record commits to. The literal is the domain-separation
 * label folded into the commitment so a commitment of one kind can never verify
 * as another, and the key under which the commitment and its opening are stored
 * in the record and opening files. */
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
// cross-verification compares the opened data snapshots -- byte-identical by
// construction, see CommittedPayload -- not the commitment strings.
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
 * Verify that `opening` opens `expectedValue` for a commitment of the given
 * kind: recompute the commitment from the opening's salt and data and compare
 * (constant-time) against the stored base64url value. Returns `false` for a
 * tampered data set, a wrong salt, or any other mismatch.
 */
export async function verifyCommitmentOpening(
  name: CommitmentName,
  opening: CommitmentOpening,
  expectedValue: string,
): Promise<boolean> {
  let expected: Uint8Array<ArrayBuffer>;
  let salt: Uint8Array<ArrayBuffer>;
  try {
    expected = fromBase64Url(expectedValue);
    salt = fromBase64Url(opening.salt);
  } catch {
    // A malformed base64url commitment or salt cannot match anything.
    return false;
  }
  const actual = await computeCommitment(name, salt, opening.data);
  return bytesEqual(actual, expected);
}

// --- Agreed-terms hash -------------------------------------------------------

/**
 * Order the two parties' terms deterministically by their canonical encoding so
 * both parties derive the same agreed-terms object regardless of which one is
 * "local". Comparison is JavaScript string order over the two RFC 8785 canonical
 * encodings; because RFC 8785 escapes every non-ASCII character as \uXXXX, those
 * strings are ASCII-only, so the comparison is stable and deterministic
 * (platform- and locale-independent) with no UTF-16-vs-code-point ambiguity.
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

// --- Record and opening types ------------------------------------------------

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
  /** Semantic PII type (e.g. "lastName", "dateOfBirth", "ssn4"). */
  type: string;
}

/**
 * Readable, non-sensitive governance metadata that lets the record stand on its
 * own as a disclosure-log entry: the authority for the disclosure and the
 * categories of data involved, identifying what was disclosed without consulting
 * the original config. Every field is a name, category, description, or reference
 * -- never a payload value, linkage-field value, or matched identifier. The
 * fields are drawn from terms both parties validated at exchange time, so both
 * parties' records carry consistent governance metadata for the same exchange;
 * the lone exception is a column's free-text {@link RecordPayloadColumn.description},
 * which is not cross-party validated.
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
  /** The payload columns this party sent for matched records (names and any
   * descriptions). Empty when this party sent no payload (count-only `psi-c`, or
   * no payload configured) -- represented explicitly, not by omission. */
  payloadSent: RecordPayloadColumn[];
  /** The payload columns this party received for matched records. Empty when this
   * party received no payload. */
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
  /** Intersection size, present only when both parties learn it (both-output
   * case); omitted otherwise. */
  resultSize?: number;
  /** Per-exchange CSPRNG binder (base64url, >= 128 bits) so two runs with
   * identical terms still produce distinct records. Distinct from the
   * per-commitment salts; not a hiding secret. */
  bindingNonce: string;
  commitments: ExchangeRecordCommitments;
}

/** The opening of a single commitment: the secret salt plus the exact data the
 * commitment was computed over, which together reveal (and prove) the
 * commitment later. */
export interface CommitmentOpening {
  /** Base64url per-commitment salt (>= 128 bits). */
  salt: string;
  /** The canonical data set the commitment was computed over. */
  data: CanonicalValue;
}

/** Openings keyed by {@link CommitmentName}, mirroring the record's
 * commitments. */
export interface OpeningDataCommitments {
  localPayloadSent: CommitmentOpening;
  partnerPayloadReceived: CommitmentOpening;
  associationTable?: CommitmentOpening;
}

/**
 * The private opening material for an {@link ExchangeRecord}: the per-commitment
 * salts and a snapshot of the committed data. Anyone holding this can recompute
 * the commitments, so it is as sensitive as the matched data itself and must be
 * kept private; the record is the part that is safe to share.
 */
export interface OpeningData {
  version: typeof EXCHANGE_OPENING_VERSION;
  commitments: OpeningDataCommitments;
}

// --- Schemas -----------------------------------------------------------------

// Base64url without padding (the binary encoding used throughout receipts; see
// docs/CANONICAL_ENCODING.md). Not length-locked: a reader verifies by
// recomputing the commitment, so the exact byte length need not be pinned here.
const base64UrlSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/, "must be an unpadded base64url string");

// Any value inside the canonical encoding domain. Validated by attempting the
// canonical encoding (which rejects out-of-domain values) rather than by
// structural shape, so the commitment scheme stays agnostic to the committed
// data's shape.
const canonicalValueSchema: z.ZodType<CanonicalValue> =
  z.custom<CanonicalValue>(
    (value) => {
      try {
        canonicalBytes(value);
        return true;
      } catch {
        return false;
      }
    },
    { message: "must be a value within the canonical encoding domain" },
  );

const resultSizeSchema = safeIntegerSchema.refine((n) => n >= 0, {
  message: "result size must be non-negative",
});

// Shared by the parser and the builder so both agree on what `createdAt` may be:
// an ISO 8601 datetime in UTC (ending in `Z`). `z.iso.datetime()` rejects
// timezone offsets by default, which holds the timestamp to a single canonical
// form -- the signing phase signs over createdAt's canonical bytes, so one UTC
// form avoids two records for the same instant differing only by offset. The
// UTC-only requirement is documented in PROTOCOL.md. Reused at build time (see
// buildExchangeRecord) so a malformed timestamp throws there rather than
// producing a record the parser would later reject.
const createdAtSchema = z.iso.datetime();

// Shared by the parser and the builder so both agree the identities are
// non-empty strings; validated at build time alongside createdAt and resultSize.
const identitySchema = z.string().min(1);

const ExchangeRecordCommitmentsSchema: z.ZodType<ExchangeRecordCommitments> =
  z.object({
    localPayloadSent: base64UrlSchema,
    partnerPayloadReceived: base64UrlSchema,
    associationTable: base64UrlSchema.optional(),
  });

const RecordPayloadColumnSchema: z.ZodType<RecordPayloadColumn> = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});

const RecordLegalAgreementSchema: z.ZodType<RecordLegalAgreement> = z.object({
  reference: z.string().min(1),
  purpose: z.string().min(1),
  expirationDate: z.iso.date(),
});

const RecordLinkageFieldSchema: z.ZodType<RecordLinkageField> = z.object({
  name: z.string().min(1),
  // `type` is not pinned to the current LinkageField type enum: the record is a
  // frozen log, so a reader accepts whatever category a (possibly newer) writer
  // recorded rather than rejecting an unrecognized type.
  type: z.string().min(1),
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
    matchingBasis: z.array(RecordLinkageFieldSchema),
    payloadSent: z.array(RecordPayloadColumnSchema),
    payloadReceived: z.array(RecordPayloadColumnSchema),
  });

const ExchangeRecordSchema: z.ZodType<ExchangeRecord> = z.object({
  version: z.literal(EXCHANGE_RECORD_VERSION),
  createdAt: createdAtSchema,
  termsHash: base64UrlSchema,
  localIdentity: identitySchema,
  partnerIdentity: identitySchema,
  governance: ExchangeRecordGovernanceSchema,
  resultSize: resultSizeSchema.optional(),
  bindingNonce: base64UrlSchema,
  commitments: ExchangeRecordCommitmentsSchema,
});

const CommitmentOpeningSchema: z.ZodType<CommitmentOpening> = z.object({
  salt: base64UrlSchema,
  data: canonicalValueSchema,
});

const OpeningDataCommitmentsSchema: z.ZodType<OpeningDataCommitments> =
  z.object({
    localPayloadSent: CommitmentOpeningSchema,
    partnerPayloadReceived: CommitmentOpeningSchema,
    associationTable: CommitmentOpeningSchema.optional(),
  });

const OpeningDataSchema: z.ZodType<OpeningData> = z.object({
  version: z.literal(EXCHANGE_OPENING_VERSION),
  commitments: OpeningDataCommitmentsSchema,
});

// --- Build -------------------------------------------------------------------

/**
 * The canonical representation a payload is committed in. Owned by the record
 * format on purpose -- deliberately NOT the PSI wire message and NOT the
 * consumed `PartnerPayload`, so a change to either of those (for transport or
 * output reasons) cannot silently move this on-disk, version-frozen format.
 *
 * Both the payload a party sent and the payload it received are mapped into this
 * one shape before committing (see `toCommittedPayload` in payloadExchange), so
 * for the same logical payload a sender and receiver commit over byte-identical
 * data. The transport-only `hasData` discriminant is not part of it; a no-data
 * payload is the empty-arrays value `{ columns: [], rowIndices: [], rows: [] }`.
 *
 * Declared as a `type` (not an `interface`) so it carries an implicit index
 * signature and is assignable to {@link CanonicalValue} without a cast.
 */
export type CommittedPayload = {
  columns: string[];
  rowIndices: number[];
  rows: Array<Array<string | null>>;
};

/**
 * The inputs needed to build an {@link ExchangeRecord}, gathered at the end of a
 * successful exchange. `localTerms`/`partnerTerms` supply the agreed-terms hash,
 * the two identities, and the readable governance metadata (algorithm, legal
 * agreement, matching basis, and payload categories -- all read from
 * `localTerms`). `resultSize` is set only when both parties learn it;
 * `associationTable` only when this party holds it. The two payload data sets are
 * always committed (a no-data payload is committed as such).
 */
export interface ExchangeRecordInputs {
  localTerms: LinkageTerms;
  partnerTerms: LinkageTerms;
  /** Intersection size; supply only in the both-output case. */
  resultSize?: number;
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
 * and its private opening data. */
export interface BuiltExchangeRecord {
  record: ExchangeRecord;
  opening: OpeningData;
}

/**
 * Derive the record's readable governance metadata from this party's agreed
 * terms. The source is the local terms throughout: `algorithm`, `legalAgreement`,
 * and the linkage fields/keys are cross-party validated (so they equal the
 * partner's), while `payload.send`/`payload.receive` are this party's own view of
 * what it sent and received. Reads names, types, descriptions, and the agreement
 * reference and purpose only -- never a value.
 */
function governanceFromTerms(terms: LinkageTerms): ExchangeRecordGovernance {
  const toColumn = (c: {
    name: string;
    description?: string;
  }): RecordPayloadColumn =>
    // Omit `description` entirely when absent rather than emitting `undefined`:
    // an absent key and a null/undefined key are distinct in the canonical
    // encoding the deferred signing work will hash over this record.
    c.description !== undefined
      ? { name: c.name, description: c.description }
      : { name: c.name };

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
    payloadSent: (terms.payload?.send ?? []).map(toColumn),
    payloadReceived: (terms.payload?.receive ?? []).map(toColumn),
  };
}

/**
 * Build the self-attested {@link ExchangeRecord} and its {@link OpeningData}
 * from the end-of-exchange inputs. Generates a fresh binding nonce and a fresh
 * salt per commitment (unless `randomness` injects them), commits to each data
 * set, and hashes the agreed terms. No private key and no network round-trip.
 *
 * The returned opening references each input `data` set directly rather than
 * deep-copying it, so callers must not mutate the inputs after this resolves.
 * The commitment bytes are computed before the opening is assembled, so a later
 * mutation cannot change them: a divergent snapshot would fail commitment
 * verification rather than corrupt the record silently. All current callers pass
 * freshly built, non-mutated payloads.
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
  const openingCommitments: Partial<Record<CommitmentName, CommitmentOpening>> =
    {};
  for (const { name, data } of datasets) {
    const salt = randomness?.salts[name] ?? randomBytes(SALT_BYTES);
    const value = await computeCommitment(name, salt, data);
    recordCommitments[name] = toBase64Url(value);
    openingCommitments[name] = { salt: toBase64Url(salt), data };
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
    // Readable governance metadata, derived from this party's agreed terms (which
    // are already schema-validated, so the governance fields are well-formed by
    // construction). Carries no values -- only names, categories, descriptions,
    // and the agreement reference.
    governance: governanceFromTerms(inputs.localTerms),
    // Omit the key entirely when absent rather than setting it to undefined: an
    // absent field and a null/undefined field are distinct in the canonical
    // encoding the signing phase will hash over this record. Validate on build
    // with the same schema the parser uses (as createdAt above): a negative or
    // non-safe-integer size throws here rather than producing a record the parser
    // would later reject or that cannot canonically encode.
    ...(inputs.resultSize !== undefined
      ? { resultSize: resultSizeSchema.parse(inputs.resultSize) }
      : {}),
    bindingNonce: toBase64Url(bindingNonce),
    commitments: recordCommitments as ExchangeRecordCommitments,
  };
  const opening: OpeningData = {
    version: EXCHANGE_OPENING_VERSION,
    commitments: openingCommitments as OpeningDataCommitments,
  };
  return { record, opening };
}

// --- Serialize / parse -------------------------------------------------------

// Pretty JSON with a trailing newline. This is the on-disk/download form: an
// ordinary, human-readable JSON file, NOT the canonical encoding (which is only
// for the bytes that are hashed, committed, or -- in a later phase -- signed).
// Shared by the CLI and the web app so both write byte-identical files.
function serialize(value: ExchangeRecord | OpeningData): string {
  return JSON.stringify(value, null, 2) + "\n";
}

/** Serialize an {@link ExchangeRecord} to its on-disk/download string form. */
export function serializeExchangeRecord(record: ExchangeRecord): string {
  return serialize(record);
}

/** Serialize {@link OpeningData} to its on-disk/download string form. */
export function serializeOpeningData(opening: OpeningData): string {
  return serialize(opening);
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
 * Parse and validate {@link OpeningData} from a raw value.
 *
 * @throws {z.ZodError} if validation fails.
 */
export function parseOpeningData(raw: unknown): OpeningData {
  return OpeningDataSchema.parse(raw);
}

// --- Verify ------------------------------------------------------------------

/** Per-commitment verdicts from {@link verifyRecordCommitments}, keyed by
 * {@link CommitmentName}. A commitment is valid when the opening recomputes to
 * the stored value. */
export type RecordCommitmentVerdicts = Partial<Record<CommitmentName, boolean>>;

/**
 * Verify that every commitment present in `record` has a matching opening in
 * `opening` that recomputes to the stored value. Returns the per-commitment
 * verdicts and an `allValid` flag. A commitment with no opening (or an opening
 * with no commitment) is a mismatch.
 *
 * This does not verify the agreed-terms hash, which requires re-supplying the
 * terms; full record verification is the verification item's concern. Provided
 * here so the build's correctness, binding, and tamper-resistance are testable
 * and so callers can self-check before relying on a record.
 */
export async function verifyRecordCommitments(
  record: ExchangeRecord,
  opening: OpeningData,
): Promise<{ verdicts: RecordCommitmentVerdicts; allValid: boolean }> {
  const names: CommitmentName[] = [
    "localPayloadSent",
    "partnerPayloadReceived",
    "associationTable",
  ];
  // localPayloadSent and partnerPayloadReceived are mandatory in a well-formed
  // record (the schema requires them); the association table is optional. This
  // function accepts any typed ExchangeRecord/OpeningData, so a value built
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
    const open = opening.commitments[name];
    if (value === undefined && open === undefined) {
      if (mandatory.has(name)) {
        verdicts[name] = false;
        allValid = false;
      }
      continue;
    }
    if (value === undefined || open === undefined) {
      verdicts[name] = false;
      allValid = false;
      continue;
    }
    const ok = await verifyCommitmentOpening(name, open, value);
    verdicts[name] = ok;
    if (!ok) allValid = false;
  }
  return { verdicts, allValid };
}
