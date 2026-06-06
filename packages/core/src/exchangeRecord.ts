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

import type { CanonicalValue } from "./utils/canonical.js";
import type { LinkageTerms } from "./config/linkageTerms.js";
import type { AssociationTable } from "./types.js";

// The self-attested exchange record (Phase 1 of exchange receipts). At the end
// of a successful exchange each party writes a LOCAL audit artifact recording
// that the exchange happened: the agreed terms (as a hash), both self-asserted
// identities, the timestamp, the result size when both parties learn it, and
// privacy-preserving commitments to the data exchanged.
//
// It is explicitly NOT a signed or non-repudiable receipt and NOT evidence
// against the partner. No private key is involved and no extra protocol round
// is added. A bare hash of a low-entropy result (e.g. an association table over
// identifiers) would be brute-forceable by anyone holding the record, leaking
// the intersection; commitments with fresh per-commitment randomness bind to the
// data without revealing it. See docs/PROTOCOL.md ("Self-attested record") and
// docs/CANONICAL_ENCODING.md. The certificate-backed signing phase reuses this
// module's commitment scheme and on-disk format.

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
 * "local". Comparison is by UTF-16 code unit (the same ordering the canonical
 * encoder applies to object keys), which is platform- and locale-independent.
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

/**
 * A self-attested local audit record of one successful exchange. Holds the
 * commitments and non-secret summary only; it does not contain the matched data
 * or the salts, so it does not reveal (or allow brute-force recovery of) the
 * intersection. It does record, in cleartext, that an exchange with the named
 * partner occurred and its size, so retention and access control are the
 * holder's responsibility. This is a local audit artifact, not a signed or
 * non-repudiable receipt.
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

const ExchangeRecordCommitmentsSchema: z.ZodType<ExchangeRecordCommitments> =
  z.object({
    localPayloadSent: base64UrlSchema,
    partnerPayloadReceived: base64UrlSchema,
    associationTable: base64UrlSchema.optional(),
  });

const ExchangeRecordSchema: z.ZodType<ExchangeRecord> = z.object({
  version: z.literal(EXCHANGE_RECORD_VERSION),
  createdAt: z.iso.datetime(),
  termsHash: base64UrlSchema,
  localIdentity: z.string().min(1),
  partnerIdentity: z.string().min(1),
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
 * successful exchange. `localTerms`/`partnerTerms` supply both the agreed-terms
 * hash and the two identities. `resultSize` is set only when both parties learn
 * it; `associationTable` only when this party holds it. The two payload data
 * sets are always committed (a no-data payload is committed as such).
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
 * Build the self-attested {@link ExchangeRecord} and its {@link OpeningData}
 * from the end-of-exchange inputs. Generates a fresh binding nonce and a fresh
 * salt per commitment (unless `randomness` injects them), commits to each data
 * set, and hashes the agreed terms. No private key and no network round-trip.
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
    createdAt: inputs.createdAt,
    termsHash,
    localIdentity: inputs.localTerms.identity,
    partnerIdentity: inputs.partnerTerms.identity,
    // Omit the key entirely when absent rather than setting it to undefined: an
    // absent field and a null/undefined field are distinct in the canonical
    // encoding the signing phase will hash over this record. Validate on build
    // with the same schema the parser uses, so the builder and parser agree on
    // what a record may contain: a negative or non-safe-integer size throws here
    // (caught by the non-fatal build guard in runExchange) rather than producing
    // a record the parser would later reject or that cannot canonically encode.
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
