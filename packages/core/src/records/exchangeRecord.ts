import { z } from "zod";

import {
  canonicalBytes,
  canonicalString,
  safeIntegerSchema,
} from "../utils/canonical.js";
import {
  bytesEqual,
  fromBase64Url,
  hmacSha256,
  randomBytes,
  sha256,
  toBase64Url,
} from "../utils/crypto.js";
import { AlgorithmSchema } from "../types.js";
import {
  MAX_LINKAGE_ENTRIES,
  MAX_NAME_LENGTH,
  MAX_PAYLOAD_ENTRIES,
  MAX_TEXT_LENGTH,
} from "../config/linkageTermsSchema.js";
import { checkLinkageRuleSetCitation } from "../defaults/builtInLinkageTerms.js";
import { boundedArray } from "../utils/boundedArray.js";

import type { CanonicalValue } from "../utils/canonical.js";
import type { LinkageTerms } from "../config/linkageTermsSchema.js";
import type { Algorithm, AssociationTable } from "../types.js";

// The exchange record: a self-attested, unsigned disclosure-log entry each
// party writes once the exchange has disclosed. Its fields, when one is owed,
// and the commitment scheme below are specified in
// docs/spec/EXCHANGE_RECORD.md, and every commitment and hash here is taken
// over the encoding docs/spec/CANONICAL_ENCODING.md fixes.
//
// The one constraint the format itself enforces: the record holds governance
// metadata only, never a payload, linkage-field, or matched-identifier value.
// The exchanged data is bound by commitments rather than embedded.

// --- Versions ----------------------------------------------------------------

/**
 * The one recognized format version for an {@link ExchangeRecord}. A reader
 * rejects an unrecognized version rather than migrating it. It moves with the
 * field set, so adding or removing an omittable field bumps it: what a
 * reader would otherwise misread an old record's silence as, and which
 * fields have moved it, are in docs/spec/EXCHANGE_RECORD.md ("Record
 * fields").
 */
export const EXCHANGE_RECORD_VERSION = "psilink-exchange-record/v6";

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
  "associationTable" | "localPayloadSent" | "partnerPayloadReceived";

// The per-kind domain labels folded into the committed message, not the salt,
// so the three kinds stay distinct under an identical (salt, data) pair.
// Collapsing any two -- the sent and received payload labels above all --
// would let a commitment of one kind verify as another; the consequences that
// separation has for cross-party verification are in
// docs/spec/EXCHANGE_RECORD.md ("Commitment scheme").
const COMMITMENT_DOMAINS: Record<CommitmentName, string> = {
  associationTable: "psilink-commit-association-table/v1",
  localPayloadSent: "psilink-commit-payload-sent/v1",
  partnerPayloadReceived: "psilink-commit-payload-received/v1",
};

// Domain-separation label for the agreed-terms hash, kept distinct from the
// commitment domains above.
const AGREED_TERMS_DOMAIN = "psilink-agreed-terms/v1";

// computeCommitment, verifyCommitmentOpening, and computeTermsHash are part of
// the public API (re-exported via main.ts), not internal helpers: an
// independent implementation reproducing or verifying a psilink record (see
// test/vectors/exchange-record-vectors.json) recomputes commitments and the
// agreed-terms hash directly, alongside the higher-level buildExchangeRecord /
// verifyRecordCommitments. Keep them exported.

/**
 * Compute the commitment to `data` of the given kind under `salt`, in the
 * construction docs/spec/EXCHANGE_RECORD.md ("Commitment scheme") specifies.
 *
 * `data` must be in the canonical value domain; binary data must already be
 * base64url-encoded to a string.
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
 * `data` is re-supplied by the caller (from its own retained input and result),
 * not read from a stored snapshot -- the verification keys hold only salts.
 * The caller must reproduce the exact canonical bytes the commitment was
 * computed over (the record format's `CommittedPayload` / association-table
 * shape; see docs/spec/CANONICAL_ENCODING.md), or verification fails even for a
 * genuine opening.
 *
 * Fail-safe: the contract is a boolean verdict, never an exception. A malformed
 * base64url salt/commitment, or `data` outside the canonical encoding domain,
 * is a mismatch (`false`), not a throw -- so the untrusted-record verifier can
 * feed hostile input here and always get a verdict. It returns `true` only on a
 * genuine constant-time HMAC match.
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
 * encodings, ordering by UTF-16 code unit -- not `localeCompare`, so the order
 * is deterministic and locale-independent. RFC 8785 emits non-ASCII as raw
 * UTF-8 rather than `\u` escapes, but both parties still compare
 * byte-identical strings under the same ordering.
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
interface ExchangeRecordCommitments {
  localPayloadSent: string;
  partnerPayloadReceived: string;
  associationTable?: string;
}

/** One payload column as a disclosure category: its name and any data-dictionary
 * description. Names and descriptions only, never values. Structurally this
 * mirrors a linkage-terms payload column but is owned by the record format (like
 * {@link CommittedPayload}), so a change to the config type cannot silently move
 * this version-frozen on-disk format. */
interface RecordPayloadColumn {
  name: string;
  /** Optional data-dictionary description. Unlike the name, a description is NOT
   * cross-party validated at exchange time, so the two parties' records may
   * legitimately hold different description text for the same column. */
  description?: string;
}

/** Reference to the governing data-sharing agreement, copied from the agreed
 * terms. A single shared reference: the two parties' agreement reference,
 * purpose, and expiration are required to match at exchange time, so the record
 * stores one authority for the disclosure rather than two. */
interface RecordLegalAgreement {
  /** Human-readable agreement identifier (e.g. "MOU-2025-0042"). */
  reference: string;
  /** Readable statement of the purpose/authority for this disclosure under the
   * agreement -- the HIPAA 164.528 / FERPA 99.32 purpose, included so the record
   * states why the disclosure happened without opening the agreement. Metadata
   * only -- never a protected, linkage-field, or payload value. */
  purpose: string;
  /** Date after which the agreement no longer authorizes an exchange (ISO 8601,
   * YYYY-MM-DD). */
  expirationDate: string;
}

/** One linkage field in the matching basis: the standardized field name the
 * match keyed on and its semantic type. Names and types only, never values.
 * The standardized `name` (not the raw source column) is the identifier the
 * linkage keys, the standardization config, and the cross-party agreement
 * all reference; `type` is the human-readable PII category. Both are
 * validated identical across parties at exchange time. */
interface RecordLinkageField {
  /** Standardized linkage-field name (not the raw source column). */
  name: string;
  /** Semantic PII type (e.g. "last_name", "date_of_birth", "ssn4"). */
  type: string;
}

/** The named rule set the agreed terms cited their linkage fields and keys to,
 * copied from those terms: the name and content version of each half. It lets
 * the record answer "which rules did this linkage match on" with a citation an
 * agreement or governance review can hold, alongside the per-field
 * {@link RecordLinkageField} basis.
 *
 * A citation, not an account: the set is an upper bound on the keys that could
 * have run, since terms derived from an input file leave out any key that input
 * cannot supply. Owned by the record format, like {@link RecordPayloadColumn},
 * so a change to the config type cannot silently move this version-frozen
 * on-disk format.
 *
 * The CITATION's cross-party consistency is the terms' own: two parties that
 * both cite a set must cite the same one before any data moves. Where the
 * partner cited none, this is this party's own citation and the partner's
 * record holds none -- an asymmetry the exchange permits so hand-authored
 * rules can meet a named set. The
 * {@link ExchangeRecordGovernance.linkageRuleSetVerdict} beside it holds no
 * such guarantee: it is this party's own check, not an agreed term. */
export interface RecordLinkageRuleSet {
  /** Name and content version of the set the linkage fields were cited to. */
  fieldSet: { name: string; version: string };
  /** Name and content version of the set the linkage keys were cited to. */
  keySet: { name: string; version: string };
}

/**
 * The writing party's own verdict on the citation beside it, one half at a time:
 * whether the linkage fields and keys the agreed terms declare are drawn from
 * the sets those terms cite them to.
 *
 * The record keeps the citation verbatim whatever the verdict says -- rewriting
 * or dropping a refuted citation would launder the declaring party's claim out
 * of the artifact an auditor reads. Both parties write it over their own agreed
 * terms: the inviter over its own citation, the acceptor over the inviter's
 * citation as adopted.
 *
 * It is THIS PARTY'S verdict, not a fact about the terms: the check runs
 * against the rule sets the writing build ships, so two parties on different
 * builds may write different verdicts for one run, and nothing in the exchange
 * compares the two. A `consistent` or `contradicted` half is reached only where
 * the cited name and version resolve to a set this build ships (that half's own
 * name and version are what it was checked against); an `unchecked` half
 * resolved to nothing. It changes nothing about the run: which fields and keys
 * a run matches on is settled by the declared rules the two parties
 * byte-compare, independent of any verdict.
 *
 * Structurally the record format's own, like {@link RecordLinkageRuleSet}: the
 * three values are spelled out here rather than imported from the checker, so a
 * verdict added to the core union fails to compile here rather than silently
 * entering this version-frozen on-disk format. */
interface RecordLinkageRuleSetVerdict {
  /** Verdict on the set the linkage fields were cited to. */
  fieldSet: "consistent" | "contradicted" | "unchecked";
  /** Verdict on the set the linkage keys were cited to. */
  keySet: "consistent" | "contradicted" | "unchecked";
}

/**
 * Readable, non-sensitive governance metadata that lets the record stand on its
 * own as a disclosure-log entry: the authority for the disclosure and the
 * categories of data involved, without consulting the original config. Every
 * field is a name, category, description, or reference -- never a payload,
 * linkage-field, or matched-identifier value. The algorithm, legal agreement,
 * and matching basis are drawn from terms both parties validated at exchange
 * time; the payload column sets are drawn from the committed payloads instead.
 * Both parties' records still hold consistent metadata for the same exchange
 * -- the committed payloads are byte-identical, so one party's
 * {@link payloadSent} equals the other's {@link payloadReceived} -- except a
 * column's free-text {@link RecordPayloadColumn.description}, which is not
 * cross-party validated.
 */
interface ExchangeRecordGovernance {
  /** The matching algorithm: `psi` revealed matched identifiers, `psi-c`
   * revealed only a count. */
  algorithm: Algorithm;
  /** The governing data-sharing agreement, when the terms named one; omitted when
   * no legal agreement was configured (its absence is explicit, not ambiguous). */
  legalAgreement?: RecordLegalAgreement;
  /** The linkage fields the match keyed on -- the standardized name and
   * semantic type of each field the linkage keys reference. Scoped to the
   * fields the keys ACTUALLY reference, not every declared linkage field: a
   * declared-but-unused field was not matched on, so recording it would
   * overstate the basis. Names and types only -- never values. Sorted by
   * `name` (UTF-16 code unit) so both parties and both implementations derive
   * the same order. */
  matchingBasis: RecordLinkageField[];
  /** The named rule set the agreed terms cited, when they cited one; omitted
   * when the terms named no set (their rules were authored rather than drawn
   * from one), so its absence is a statement rather than a gap. Recorded
   * verbatim, whatever {@link linkageRuleSetVerdict} says about it. */
  linkageRuleSet?: RecordLinkageRuleSet;
  /** This party's own verdict on that citation, per half. Present exactly when
   * {@link linkageRuleSet} is, so a citation is never recorded without the
   * writer's verdict beside it and a verdict never appears with nothing to be
   * about. */
  linkageRuleSetVerdict?: RecordLinkageRuleSetVerdict;
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
 * How far the run a record attests got. A record is owed from the moment the
 * payload exchange completes, so a run either got through the steps after that
 * point or it did not -- the whole set these two values divide.
 *
 * - `completed`: the run finished. A run that signed exchanged its receipt; a
 *   run with no signing identity had none to exchange and has no
 *   {@link ExchangeRecord.receiptBinder}.
 * - `receipt-swap-terminated`: the disclosure occurred and the run then
 *   terminated without this party holding a receipt for it. The signed-receipt
 *   swap is the step it most often terminates in, but the value covers the
 *   whole post-disclosure region -- e.g. a received payload refused against
 *   what this party consented to receive terminates the run before the swap
 *   and records the same value. The record still attests the disclosure. It
 *   does not state WHY the run terminated (docs/spec/EXCHANGE_RECORD.md, When
 *   a record is owed).
 *
 * Stated on every record rather than left to an absent-marks-terminated
 * reading, so a compliance reader never infers a completed run from silence --
 * the same reason a no-payload direction is committed explicitly (see
 * docs/spec/EXCHANGE_RECORD.md, Count-only records).
 */
export type ExchangeRecordOutcome = "completed" | "receipt-swap-terminated";

/** Every {@link ExchangeRecordOutcome}, as the schema's accepted value set. */
export const EXCHANGE_RECORD_OUTCOMES = [
  "completed",
  "receipt-swap-terminated",
] as const satisfies readonly ExchangeRecordOutcome[];

/**
 * A self-attested local disclosure-log entry for one exchange that disclosed.
 * It records, in cleartext, that an exchange with the named partner occurred,
 * under which agreement, over what categories of data, and its size -- enough
 * to stand on its own as an audit artifact. It holds readable governance
 * metadata and the data commitments only, never the matched data or the
 * salts, so it cannot reveal (or allow brute-force recovery of) the
 * intersection. Because it names both parties and the disclosure in
 * cleartext, retention and access control are the holder's responsibility. A
 * local audit artifact, not a signed or non-repudiable receipt.
 *
 * Rendering note: this record stores partner-supplied free text --
 * `partnerIdentity`, `governance.legalAgreement.reference`/`purpose`, and the
 * payload column names/descriptions -- byte-for-byte, as required for the
 * byte-exact cross-party validation and the canonical encoding a record is
 * hashed over. A party can place terminal control/ANSI sequences or deceptive
 * Unicode (bidi-override, zero-width, homoglyph) in these fields. Every sink
 * that renders a record to a person MUST escape each such field where it is
 * shown (`sanitizeForDisplay`), never mutating the stored value, which stays
 * byte-exact. Each sink holds this obligation on its own -- a new viewer,
 * exporter, or log line does not inherit another's escaping. The web app's
 * accounting-of-disclosures view and its CSV export hold it through the
 * `Displayable` brand `sanitizeForDisplay` returns, so a raw field does not
 * typecheck into what they render.
 */
export interface ExchangeRecord {
  /** Single recognized format version for v1; readers reject anything else. */
  version: typeof EXCHANGE_RECORD_VERSION;
  /** Local wall-clock time the record was produced (ISO 8601). */
  createdAt: string;
  /** How far the run this record attests got. Always present, so a reader never
   * infers a completed run from a field's silence; see
   * {@link ExchangeRecordOutcome}. */
  outcome: ExchangeRecordOutcome;
  /** Base64url SHA-256 over the canonical encoding of both parties' terms. */
  termsHash: string;
  /** This party's self-asserted identity (from its linkage terms). Absent when
   * this party supplied none, which is the record stating that rather than
   * naming a party nobody named. */
  localIdentity?: string;
  /** The partner's self-asserted identity (from the terms it sent). Absent when
   * the partner sent none. */
  partnerIdentity?: string;
  /** Readable governance metadata (the authority for, and the categories of, the
   * disclosure) that makes this record a standalone disclosure-log entry. */
  governance: ExchangeRecordGovernance;
  /** The number of records this party contributed to the exchange -- the size
   * of its own input, recorded for every party as a per-direction statement
   * of what it put in. Counts every contributed record, not only the rows
   * that resolve to a usable linkage key, so it is an upper bound on what
   * this party exposed rather than a derived match figure. Distinct from
   * {@link resultSize}: this is the size of THIS party's input, not the
   * intersection, so it stays meaningful even under a future algorithm that
   * discloses neither the result size nor the partner's set size. Always
   * present; holds no protected value -- an aggregate count of the holder's
   * own records. */
  recordsExposed: number;
  /** Intersection size, present only in the both-output case: stored only when
   * both parties' agreed terms have them both receive output -- entitlement,
   * not what a party happens to observe. A single-output helper can observe its
   * match count during the clean cascade, but the record does not surface it:
   * privacy here is enforced by what the tool writes down, not by what is
   * theoretically discoverable. Each party's own outbound exposure is held
   * by {@link recordsExposed} instead. */
  resultSize?: number;
  /** Optional self-facing retention/disposition pointer: a free-text operator
   * note recording where this party filed its copy of the result (the
   * association table / received payload) and under what retention schedule.
   * Unlike the {@link governance} block, it is NOT drawn from the agreed terms:
   * it is sourced from this party's local exchange config, never exchanged with
   * the partner, and not folded into {@link ExchangeRecord.termsHash} -- so the
   * two parties' records may legitimately hold different pointers (or none).
   * Metadata only, no protected, linkage-field, or payload value. Omitted
   * entirely when absent -- its absence is explicit, never an empty string. */
  retentionDisposition?: string;
  /** Per-exchange CSPRNG binder (base64url, >= 128 bits) so two runs with
   * identical terms still produce distinct records. Generated locally, so the two
   * parties' records for one run hold DIFFERENT nonces -- it distinguishes runs
   * within one holder's own log and pairs nothing across artifacts. Distinct from
   * the per-commitment salts; not a hiding secret. */
  bindingNonce: string;
  /** The signed receipt's per-exchange binder (base64url), repeated here so a
   * verifier handed this record and a receipt separately can tell whether they
   * are the same run: both parties derive the identical value from the
   * exchange's session key, and a different run derives a different one.
   * Present exactly when the run DERIVED one, so its absence states that no
   * receipt can belong to this record -- an unpaired receipt beside it is
   * therefore a mismatch, not merely unchecked. A {@link outcome} of
   * `receipt-swap-terminated` still has the binder while this party holds
   * no receipt, since the partner may hold a completed receipt bearing it and
   * dropping it would make that receipt unpairable. Holds no secret: it is a
   * one-way HKDF output the signed receipt already publishes (see
   * `deriveReceiptBinder`). */
  receiptBinder?: string;
  commitments: ExchangeRecordCommitments;
}

/** Per-commitment salts, keyed by {@link CommitmentName}, mirroring the record's
 * commitments. Each salt is the secret HMAC key for its commitment; the local
 * payload sent and partner payload received are always present, the association
 * table only when this party committed it. */
interface CommitmentSalts {
  /** Base64url per-commitment salt (>= 128 bits). */
  localPayloadSent: string;
  partnerPayloadReceived: string;
  associationTable?: string;
}

/**
 * The private verification keys for an {@link ExchangeRecord}: the per-commitment
 * salts and NOTHING ELSE. A salt is a secret HMAC key, not committed data, so
 * these keys are NOT a second at-rest copy of the matched data -- no payload
 * values, no matched-record pairing. The matched data lives only in the result
 * the operator chose to write, never in this file.
 *
 * Still private, not shareable: a salt together with the record's commitment
 * can brute-force a low-entropy committed value (the intersection), so
 * anyone holding both the keys and the record could open the commitments.
 * Verification therefore re-supplies the committed data (from the holder's own
 * retained input and result) and recomputes the canonical bytes; see
 * {@link verifyRecordCommitments}. The keys and the record are separate
 * artifacts on both surfaces (the CLI writes two files; the web offers two
 * downloads), so the record stays safe to hand an auditor without the keys.
 */
export interface VerificationKeys {
  version: typeof EXCHANGE_KEYS_VERSION;
  salts: CommitmentSalts;
}

// --- Schemas -----------------------------------------------------------------

// Untrusted-input bounds. parseExchangeRecord's production caller is the
// verification reader, ingesting a record file from another party, so every
// partner-controlled string and array below has a generous length /
// element-count cap -- the same caps the linkage-terms producers imply
// (MAX_NAME_LENGTH, MAX_TEXT_LENGTH, MAX_LINKAGE_ENTRIES, MAX_PAYLOAD_ENTRIES),
// so a record this module produces always parses back, while an oversized
// hostile record is rejected at parse rather than forcing proportional
// allocation. Array counts use boundedArray (a count refine BEFORE per-element
// validation) for the same Zod issue-accumulation reason the linkage-terms
// bounds document. The bounds reject; they do not reshape a valid record --
// defense-in-depth ceilings, not semantic limits. The name shape the
// linkage-terms schema applies (NAME_SHAPE_PATTERN) is not applied here, for
// the reason `type` and a citation `version` are open strings below: the record
// is a frozen log, and its reader accepts what a possibly different-version
// writer recorded. Display escaping at the render site neutralizes such a value.

// Length cap for the fixed-size base64url crypto values a record and its keys
// hold (termsHash, bindingNonce, receiptBinder, each commitment, each salt):
// every one is a 32-byte value -- 43 unpadded base64url characters -- so 256 is
// far above any legitimate value yet refuses a megabyte-scale hostile string.
// Bounds the field for the untrusted reader without pinning the exact byte
// count; a reader still verifies by recomputing the commitment.
const MAX_BASE64URL_LENGTH = 256;

// Base64url without padding (the binary encoding used throughout receipts; see
// docs/spec/CANONICAL_ENCODING.md). Length-CAPPED (not length-locked): the `.max`
// bounds how much an oversized hostile value can retain, while the exact byte
// length stays unpinned. Zod runs both the length and the regex check (the cap
// does not short-circuit the pattern scan), but the alphabet regex is
// linear-time, so a capped value stays cheap to scan regardless.
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

// Shared by the parser and the builder so both agree on what `createdAt` may
// be: an ISO 8601 datetime in UTC (ending in `Z`). `z.iso.datetime()` rejects
// timezone offsets by default, holding the timestamp to a single canonical
// form -- the signing phase signs over createdAt's canonical bytes, so one UTC
// form avoids two records for the same instant differing only by offset (see
// EXCHANGE_RECORD.md). Reused at build time (buildExchangeRecord) so a
// malformed timestamp throws there rather than producing a record the parser
// would later reject.
const createdAtSchema = z.iso.datetime();

// Shared by the parser and the builder so both agree the identities are
// non-empty strings; validated at build time alongside createdAt and resultSize.
const identitySchema = z.string().min(1).max(MAX_TEXT_LENGTH);

// The record's commitments and its verification salts share one base64url-triple
// shape (both keyed by CommitmentName), so validate both against one schema to
// keep the field lists from drifting apart.
const base64UrlCommitmentTripleSchema = z.object({
  localPayloadSent: base64UrlSchema,
  partnerPayloadReceived: base64UrlSchema,
  associationTable: base64UrlSchema.optional(),
});

const ExchangeRecordCommitmentsSchema: z.ZodType<ExchangeRecordCommitments> =
  base64UrlCommitmentTripleSchema;

const RecordPayloadColumnSchema: z.ZodType<RecordPayloadColumn> = z.object({
  // Bound the name length: a payloadReceived column name originates from the
  // partner's payload wire message, so this is the on-disk safety check for the
  // wire bound in payloadExchange.ts -- an over-long name cannot reach the
  // record by any path. MAX_NAME_LENGTH matches both the wire predicate and the
  // operator's own `terms.payload.send`/`receive` names.
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
  // recorded rather than rejecting an unrecognized type. It has the same
  // length cap as a name -- a semantic category is a short label, not prose.
  type: z.string().min(1).max(MAX_NAME_LENGTH),
});

// Both halves take the same shape, so the identity is declared once. `version`
// is an open, length-capped string rather than a semver pattern, for the reason
// RecordLinkageField.type is an open string: the record is a frozen log, and a
// reader accepts the citation a (possibly newer) writer recorded rather than
// re-deciding its form. The linkage-terms schema is where a version's form is
// enforced, on the document that travels.
const RecordLinkageSetIdentitySchema = z.object({
  name: z.string().min(1).max(MAX_NAME_LENGTH),
  version: z.string().min(1).max(MAX_NAME_LENGTH),
});

const RecordLinkageRuleSetSchema: z.ZodType<RecordLinkageRuleSet> = z.object({
  fieldSet: RecordLinkageSetIdentitySchema,
  keySet: RecordLinkageSetIdentitySchema,
});

// Pinned to the closed set of verdicts, the same asymmetry `algorithm` has
// against its open sibling `RecordLinkageField.type`: a set name or a content
// version is descriptive text a frozen-log reader passes through, while a
// verdict is meaning-bearing -- it states what the writer checked and what it
// found, and an unrecognized one would be a provenance claim a reader cannot
// interpret. The version literal already refuses a future format, so an
// unknown verdict is refused here too, not read.
const RecordLinkageRuleSetVerdictValueSchema = z.enum([
  "consistent",
  "contradicted",
  "unchecked",
]);

const RecordLinkageRuleSetVerdictSchema: z.ZodType<RecordLinkageRuleSetVerdict> =
  z.object({
    fieldSet: RecordLinkageRuleSetVerdictValueSchema,
    keySet: RecordLinkageRuleSetVerdictValueSchema,
  });

const ExchangeRecordGovernanceSchema: z.ZodType<ExchangeRecordGovernance> = z
  .object({
    // algorithm stays pinned to the closed enum even though the sibling
    // RecordLinkageField.type is an open string -- an asymmetry by design, not
    // an oversight. type is open descriptive taxonomy: a newer PII category
    // does not change what the record means, so a frozen-log reader passes it
    // through. algorithm is meaning-bearing protocol structure that gates the
    // disclosure semantics (psi revealed identifiers, psi-c only a count); a
    // record that has an algorithm this version does not define is not a v1
    // record, so reject an unknown one here rather than admit semantics a v1
    // reader cannot interpret.
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
    linkageRuleSet: RecordLinkageRuleSetSchema.optional(),
    linkageRuleSetVerdict: RecordLinkageRuleSetVerdictSchema.optional(),
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
  })
  // The citation and the verdict travel together or not at all. A citation with
  // no verdict beside it is the shape a reader would otherwise have to guess
  // about -- silence where a v4 writer always states one -- and a verdict with no
  // citation is a judgment about nothing. Enforced rather than documented,
  // because both the builder and the untrusted-record reader parse through here.
  .refine(
    (governance) =>
      (governance.linkageRuleSet === undefined) ===
      (governance.linkageRuleSetVerdict === undefined),
    {
      message:
        "linkageRuleSetVerdict must be present exactly when linkageRuleSet is",
      path: ["linkageRuleSetVerdict"],
    },
  );

const outcomeSchema = z.enum(EXCHANGE_RECORD_OUTCOMES);

const ExchangeRecordSchema: z.ZodType<ExchangeRecord> = z.object({
  version: z.literal(EXCHANGE_RECORD_VERSION),
  createdAt: createdAtSchema,
  outcome: outcomeSchema,
  termsHash: base64UrlSchema,
  localIdentity: identitySchema.optional(),
  partnerIdentity: identitySchema.optional(),
  governance: ExchangeRecordGovernanceSchema,
  recordsExposed: recordsExposedSchema,
  resultSize: resultSizeSchema.optional(),
  retentionDisposition: retentionDispositionSchema.optional(),
  bindingNonce: base64UrlSchema,
  receiptBinder: base64UrlSchema.optional(),
  commitments: ExchangeRecordCommitmentsSchema,
});

const CommitmentSaltsSchema: z.ZodType<CommitmentSalts> =
  base64UrlCommitmentTripleSchema;

const VerificationKeysSchema: z.ZodType<VerificationKeys> = z.object({
  version: z.literal(EXCHANGE_KEYS_VERSION),
  salts: CommitmentSaltsSchema,
});

// --- Build -------------------------------------------------------------------

/**
 * The canonical representation a payload is committed in: the disclosed column
 * names and the row VALUES, in matched-row order. Owned by the record format,
 * not the PSI wire message and not the consumed `PartnerPayload`, so a change
 * to either of those (for transport or output reasons) cannot silently move
 * this on-disk, version-frozen format.
 *
 * It binds the column names and the values, NOT any party's internal row
 * indices, and the payload a party sent and the payload it received are both
 * mapped into this one shape before committing (`toCommittedPayload` in
 * payloadExchange), so the two parties commit over byte-identical data for
 * one logical payload. Why the row indices are excluded, and what binds which
 * records matched instead: docs/spec/EXCHANGE_RECORD.md ("Commitment
 * scheme").
 *
 * Declared as a `type` (not an `interface`) so it has an implicit index
 * signature and is assignable to {@link CanonicalValue} without a cast.
 */
export type CommittedPayload = {
  columns: string[];
  rows: Array<Array<string | null>>;
};

/**
 * The inputs needed to build an {@link ExchangeRecord}, gathered once the
 * exchange has disclosed. `localTerms`/`partnerTerms` supply the agreed-terms
 * hash, the two identities, and most of the readable governance metadata
 * (algorithm, legal agreement, and matching basis -- read from `localTerms`);
 * the payload categories are instead read from the committed
 * `localPayloadSent`/`partnerPayloadReceived` below (with descriptions looked
 * up in `localTerms`'s payload dictionary), so they reflect what was
 * committed. `recordsExposed` is this party's own input row count (always
 * supplied); `resultSize` is set only in the both-output case;
 * `associationTable` only when this party holds it; `retentionDisposition` is
 * an optional self-facing pointer from this party's local config, independent
 * of `localTerms`/`partnerTerms` and never put on the wire. The two payload
 * data sets are always committed (a no-data payload is committed as such).
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
  /** How far the run got. Required rather than defaulted to `completed`: a
   * default is a claim of completion a caller could make by forgetting, and a
   * false completion claim in a disclosure record is the one error this field
   * exists to prevent. */
  outcome: ExchangeRecordOutcome;
  /** The signed receipt's per-exchange binder for this run, when the run
   * derived one. Supply it whenever the derivation succeeded -- the caller
   * derives it once and passes the same value here and into the receipt
   * content, so the two artifacts hold one shared per-run value, including
   * for a run whose swap then terminated, whose partner may hold a receipt
   * bearing it. Omit it on every path that derived none (no session key, or no
   * signing identity): the record's absent field then accurately states that
   * no receipt can belong to it. */
  receiptBinder?: string;
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
 * `algorithm`, `legalAgreement`, the rule-set citation, and the matching basis
 * come from this party's agreed terms: the first two are cross-party validated
 * (so they equal the partner's), the citation is validated between two parties
 * that both hold one, and the matching basis is the linkage fields the keys
 * reference. The citation's VERDICT is not drawn from the terms: it is computed
 * here, against the rule sets this build ships, so it is this party's own
 * statement rather than an agreed one.
 *
 * The payload column SETS are instead read from the COMMITTED payloads
 * (`localPayloadSent` / `partnerPayloadReceived`), not the optional
 * `terms.payload.send`/`receive` data dictionary, which is operator-authored,
 * may be empty (the web term builders never populate it), and can under-declare
 * what the metadata disclosure gate actually transmits. The committed columns
 * ARE what flowed -- the output of the same `isDisclosedToPartner` gate that
 * drives `preparePayload` -- so sourcing the readable list from them keeps
 * `payloadSent`/`payloadReceived` from drifting from the committed bytes, and
 * (since a sender's `localPayloadSent` and the receiver's
 * `partnerPayloadReceived` commit over byte-identical data) keeps the two
 * parties' records mutually consistent. The dictionary is still consulted, by
 * column name, for the optional data-dictionary DESCRIPTION on each committed
 * column; an undescribed column has a bare name. Reads names, types,
 * descriptions, and the agreement reference and purpose only -- never a value.
 */
function governanceFromTerms(
  terms: LinkageTerms,
  localPayloadSent: CommittedPayload,
  partnerPayloadReceived: CommittedPayload,
): ExchangeRecordGovernance {
  // Map the columns ACTUALLY committed for a direction into record columns,
  // attaching each column's data-dictionary description from the
  // operator-authored declared list (looked up by name) when present. The
  // committed columns are authoritative for the set; the dictionary only
  // annotates them. Omit `description` entirely when absent rather than
  // emitting `undefined`: an absent key and a null/undefined key are distinct
  // in the canonical encoding the deferred signing work will hash over.
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
  // recording it would overstate the basis. Walk the keys, resolve each
  // element's field reference to its declared field (for the semantic type),
  // dedupe by name (a field used in several keys appears once), and sort by
  // name -- the same code-unit ordering validateCompatibility and the
  // canonical encoder use, so the order is deterministic across parties and
  // platforms.
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

  // The citation and this party's verdict on it, both in the record format's
  // own shape. The citation is copied verbatim and the verdict written BESIDE
  // it, never in place of it: dropping or rewriting a disproved citation would
  // launder the declaring party's claim out of the artifact an auditor reads,
  // where annotating it records both the claim and what this party found.
  // Computed from the same terms the citation is copied from: the inviter over
  // its own citation, the acceptor over the inviter's as adopted.
  const citation = terms.linkageRuleSet;
  const citedRuleSet: Pick<
    ExchangeRecordGovernance,
    "linkageRuleSet" | "linkageRuleSetVerdict"
  > =
    citation === undefined
      ? {}
      : {
          // Copied field by field rather than by reference, so the record holds
          // its own value: a later edit to the config type cannot reach this
          // version-frozen on-disk format through a shared object.
          linkageRuleSet: {
            fieldSet: {
              name: citation.fieldSet.name,
              version: citation.fieldSet.version,
            },
            keySet: {
              name: citation.keySet.name,
              version: citation.keySet.version,
            },
          },
          linkageRuleSetVerdict: checkLinkageRuleSetCitation(citation, terms),
        };

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
    ...citedRuleSet,
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
 * from the post-disclosure inputs. Generates a fresh binding nonce and a fresh
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
    // Validated on build with the parser's own schema, as createdAt above: a
    // caller reaching past the type with an unrecognized outcome throws here
    // rather than writing a record the parser would later reject.
    outcome: outcomeSchema.parse(inputs.outcome),
    termsHash,
    // Each identity is written only when its party supplied one: an absent field
    // says the party named itself none, and there is nothing else it could say.
    ...(inputs.localTerms.identity !== undefined && {
      localIdentity: identitySchema.parse(inputs.localTerms.identity),
    }),
    ...(inputs.partnerTerms.identity !== undefined && {
      partnerIdentity: identitySchema.parse(inputs.partnerTerms.identity),
    }),
    // Readable governance metadata. The agreement, algorithm, and matching
    // basis come from this party's agreed terms (already schema-validated);
    // the payload column sets come from the committed payloads, so the
    // readable disclosure cannot diverge from the committed bytes. Holds no
    // values -- only names, categories, descriptions, and the agreement
    // reference. Validated on build with the parser's own schema:
    // payloadReceived's column names come from the partner's payload wire
    // message, validated only as strings (payloadExchange.ts) and looser than
    // this record's RecordPayloadColumn (name must be non-empty), so a
    // malformed partner column name throws here (caught by the non-fatal
    // build guard in runExchange) rather than reaching the parser later.
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
    // Omit the key entirely when absent rather than setting it to undefined:
    // an absent field and a null/undefined field are distinct in the
    // canonical encoding the signing phase will hash over. Validated on build
    // with the parser's own schema (as createdAt above): a negative or
    // non-safe-integer size throws here rather than producing a record the
    // parser would later reject.
    ...(inputs.resultSize !== undefined
      ? { resultSize: resultSizeSchema.parse(inputs.resultSize) }
      : {}),
    // Self-facing retention/disposition pointer, copied verbatim from this
    // party's local config. Omit the key entirely when absent (an absent
    // field and a null/undefined field are distinct in the canonical encoding
    // the signing phase will hash over). Validated with the parser's own
    // schema, so an empty string throws here rather than producing a record
    // the parser would later reject.
    ...(inputs.retentionDisposition !== undefined
      ? {
          retentionDisposition: retentionDispositionSchema.parse(
            inputs.retentionDisposition,
          ),
        }
      : {}),
    bindingNonce: toBase64Url(bindingNonce),
    // The receipt's shared per-run binder, passed in by the caller that also
    // signs it into the receipt content. Omit the key entirely when absent
    // (an absent field and a null/undefined field are distinct in the
    // canonical encoding), validated with the parser's own schema so a
    // non-base64url value throws here rather than producing a record the
    // parser would later reject.
    ...(inputs.receiptBinder !== undefined
      ? { receiptBinder: base64UrlSchema.parse(inputs.receiptBinder) }
      : {}),
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
type RecordCommitmentVerdicts = Partial<Record<CommitmentName, boolean>>;

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
  // function accepts any typed ExchangeRecord/VerificationKeys, so a value
  // built without going through parseExchangeRecord could omit a mandatory
  // commitment. Treat a missing mandatory commitment as invalid rather than
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
