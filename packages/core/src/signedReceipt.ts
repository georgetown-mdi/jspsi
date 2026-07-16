import { ed25519 } from "@noble/curves/ed25519.js";
import { z } from "zod";

import { canonicalBytes } from "./utils/canonical.js";
import {
  fromBase64Url,
  hkdfDerive,
  sha256,
  toBase64Url,
} from "./utils/crypto.js";
import {
  ConnectionError,
  receiveParsed,
} from "./connection/messageConnection.js";
import {
  SigningCertificateSchema,
  verifyPresentedCertificate,
} from "./signingIdentity.js";

import type { HandshakeRole } from "./types.js";
import type { MessageConnection } from "./connection/messageConnection.js";
import type { CanonicalValue } from "./utils/canonical.js";
import type { CommittedPayload } from "./exchangeRecord.js";
import type { SigningCertificate, SigningIdentity } from "./signingIdentity.js";

// Certificate-backed signed exchange receipts (the sign/exchange step). At the
// conclusion of a successful exchange both parties sign the SAME canonical bytes
// and swap signatures over the live channel, producing one dual-signed record
// carrying both parties' signatures and certificates. Each side verifies the
// partner's certificate fingerprint against the pinned value BEFORE verifying the
// signature, and a mismatch or a bad signature terminates the exchange fail-closed
// with a `security` ConnectionError.
//
// The signed bytes cover only MUTUALLY-VERIFIABLE facts -- values BOTH parties
// derive byte-identically after a successful exchange:
//   - the agreed-terms hash (computeTermsHash; both compute the same value),
//   - a salt-free digest of the data that flowed in each direction (both parties
//     hold both directions -- each sends one payload and receives the other, and a
//     sender's committed payload is byte-identical to the receiver's, per
//     exchangeRecord.ts -- so a deterministic digest of each direction is the same
//     on both sides), keyed by the fixed initiator/responder direction, and
//   - the per-exchange session-derived binder.
// One-party-only facts stay OUT of the signed bytes: a party's own recordsExposed
// and retention pointer (local record only), and the SALTED record commitments
// (each party's carry fresh per-party salts, so they are NOT byte-identical across
// parties -- the receipt therefore uses salt-free digests of the flowing data, not
// the record's hiding commitments). The association-table pairing is likewise not
// signed: it is not reliably held by both parties (a one-sided exchange leaves the
// helper without it), so it is not a mutually-verifiable fact -- the receipt
// attests WHAT data flowed, bound to the agreed terms and this exchange, which is
// the mutually-verifiable core.
//
// Trust anchor and byte layout: docs/spec/PROTOCOL.md (the signed-receipt step)
// and docs/spec/EXCHANGE_RECORD.md (the receipt-content canonical bytes and the
// dual-signed record format). This module reuses the certificate/pinning
// primitives (signingIdentity.ts), the canonical encoding (utils/canonical.ts),
// and the committed-payload shape (exchangeRecord.ts) rather than introducing a
// second signing or serialization surface.

// --- Versions and domains ----------------------------------------------------

/** Single recognized format version for a v1 dual-signed record; a reader
 * rejects any other value rather than migrating it. */
export const SIGNED_RECEIPT_VERSION = "psilink-signed-receipt/v1";

// Domain-separation label folded into the signed receipt-content bytes, kept
// distinct from every other label derived from the canonical encoder (the
// agreed-terms hash, the record commitments, and the certificate
// signature/fingerprint domains in signingIdentity.ts). A signature over the
// receipt content can therefore never be replayed as a certificate self-signature
// or vice versa.
const RECEIPT_CONTENT_DOMAIN = "psilink-signed-receipt-content/v1";

// Domain-separation label for the salt-free directional payload digest, folded
// into the hashed message so a payload digest can never be confused with any other
// hash (the terms hash, a record commitment, or the content signature). The
// digest is deliberately salt-free -- both parties must reproduce it identically
// from the same flowing data -- so it provides NO hiding; the receipt is a
// mutually-verifiable attestation of what flowed, and the salted record
// commitments remain the hiding artifact. A committed payload holds only column
// names and row values, so the digest reveals nothing a party did not already send
// or receive.
const RECEIPT_PAYLOAD_DIGEST_DOMAIN = "psilink-signed-receipt-payload/v1";

// HKDF info label for the per-exchange replay binder, distinct from and prefix-
// free against every other session-key label (`psilink-aead-v1:{...}`,
// `psilink-abort-token-v1:{...}`, `psilink-shared-secret-rotation-v1`). The
// role suffix separates the initiator's and responder's binder inputs -- see
// deriveReceiptBinder.
const RECEIPT_BINDER_LABEL = "psilink-signed-receipt-binder-v1";

// Ed25519 signature byte length; a signature that decodes to any other length is
// rejected with a precise message rather than a downstream verification failure.
const ED25519_SIGNATURE_BYTES = 64;

// Length of the per-exchange binder, matching the 32-byte session-derived tokens
// (deriveAbortToken, deriveAeadKey) HKDF produces from the same session key.
const RECEIPT_BINDER_BYTES = 32;

// --- Per-exchange replay binder ----------------------------------------------

/**
 * Derive the per-exchange replay binder: a 32-byte tag derived one-way from the
 * session key via HKDF, with initiator/responder role separation, so both parties
 * compute the SAME binder with no extra messages and neither party unilaterally
 * controls it. It is base64url-encoded and folded into the signed receipt content,
 * so a receipt from one exchange cannot be presented as evidence of another: a
 * different exchange has a different session key, hence a different binder, and
 * the signature no longer verifies against this exchange's content.
 *
 * The two roles derive the SAME binder (both call with the same `role` argument
 * meaning "the role of the party whose binder this is") -- the role suffix exists
 * for HKDF domain separation against the other session-key labels, not to give the
 * two parties different binders. Both parties pass the initiator's role to build
 * the one shared binder for the receipt content, exactly as the abort-token
 * derivation binds a token to its writer's role. Passing an unrecognized role
 * throws rather than silently deriving a binder the two parties may not agree on,
 * mirroring {@link deriveAbortToken}.
 */
export async function deriveReceiptBinder(
  sessionKey: Uint8Array<ArrayBuffer>,
  role: HandshakeRole,
): Promise<string> {
  if (role !== "initiator" && role !== "responder")
    throw new Error(
      `deriveReceiptBinder: unknown role ${JSON.stringify(role)}; expected ` +
        `"initiator" or "responder"`,
    );
  const bytes = await hkdfDerive(
    sessionKey,
    `${RECEIPT_BINDER_LABEL}:${role}`,
    RECEIPT_BINDER_BYTES,
  );
  return toBase64Url(bytes);
}

// --- Receipt content ---------------------------------------------------------

/**
 * The mutually-verifiable facts both parties sign. Every field is one both parties
 * derive byte-identically after a successful exchange, so a single signature over
 * them is evidence a third party can check against either party's view:
 * - `termsHash`: the agreed-terms hash (computeTermsHash; both compute the same).
 * - `initiatorToResponderPayload` / `responderToInitiatorPayload`: a salt-free
 *   SHA-256 digest of the committed payload that flowed in each direction, keyed by
 *   the fixed handshake roles. Both parties hold both directions (each sends one
 *   and receives the other, byte-identical per exchangeRecord.ts), so both compute
 *   the same two digests. The empty (no-data) direction digests a canonical empty
 *   payload, so it too matches on both sides.
 * - `binder`: the per-exchange session-derived replay binder; identical for both.
 *
 * One-party-only facts (recordsExposed, the retention pointer) and the SALTED
 * record commitments (per-party fresh salts, not byte-identical across parties)
 * are deliberately absent -- they are not mutually verifiable. The association-
 * table pairing is also absent: a one-sided exchange leaves the helper without it,
 * so it is not a fact both parties hold.
 */
export interface ReceiptContent {
  termsHash: string;
  /** Salt-free digest of the data the initiator sent to the responder (base64url). */
  initiatorToResponderPayload: string;
  /** Salt-free digest of the data the responder sent to the initiator (base64url). */
  responderToInitiatorPayload: string;
  /** The per-exchange replay binder (base64url); identical for both parties. */
  binder: string;
}

/**
 * Compute the salt-free directional payload digest: an unpadded base64url SHA-256
 * over the domain-separated canonical encoding (RFC 8785) of the committed payload.
 * Salt-free ON PURPOSE -- both parties must reproduce it identically from the same
 * flowing data, so it provides no hiding (the salted record commitments do). The
 * committed payload is the record format's own shape (column names + row values,
 * the transport `hasData` discriminant dropped and the no-data case an empty
 * value), so a sender's digest of what it sent equals the receiver's digest of what
 * it received. Reproduces across implementations under the fixed canonical rules.
 */
export async function digestCommittedPayload(
  payload: CommittedPayload,
): Promise<string> {
  const bytes = canonicalBytes({
    domain: RECEIPT_PAYLOAD_DIGEST_DOMAIN,
    payload: payload as CanonicalValue,
  });
  return toBase64Url(await sha256(bytes));
}

/**
 * Assemble the receipt content both parties sign, from the facts each holds after
 * the exchange. `handshakeRole` fixes which of this party's payloads is the
 * initiator-to-responder direction and which is the responder-to-initiator one, so
 * both parties key the two directions identically regardless of which is "local".
 *
 * @param handshakeRole  This party's handshake role.
 * @param termsHash      The agreed-terms hash (both parties compute the same value).
 * @param localPayloadSent      The committed payload THIS party sent the partner.
 * @param partnerPayloadReceived The committed payload THIS party received.
 * @param binder         The per-exchange replay binder (see deriveReceiptBinder).
 */
export async function buildReceiptContent(
  handshakeRole: HandshakeRole,
  termsHash: string,
  localPayloadSent: CommittedPayload,
  partnerPayloadReceived: CommittedPayload,
  binder: string,
): Promise<ReceiptContent> {
  // The initiator's outbound payload is its localPayloadSent; the responder's
  // outbound payload is likewise its localPayloadSent. Keying by role -- not by
  // local/partner -- makes both parties place the same digest under the same
  // direction key, so their content objects are byte-identical.
  const [initiatorToResponder, responderToInitiator] =
    handshakeRole === "initiator"
      ? [localPayloadSent, partnerPayloadReceived]
      : [partnerPayloadReceived, localPayloadSent];
  const [initiatorToResponderPayload, responderToInitiatorPayload] =
    await Promise.all([
      digestCommittedPayload(initiatorToResponder),
      digestCommittedPayload(responderToInitiator),
    ]);
  return {
    termsHash,
    initiatorToResponderPayload,
    responderToInitiatorPayload,
    binder,
  };
}

/**
 * Build the canonical bytes signed for a receipt: the domain-separated canonical
 * encoding (RFC 8785) of `{domain, content}`, so both parties and any independent
 * implementation derive byte-identical input and the signature verifies across
 * implementations. Field order is irrelevant -- the canonical encoder sorts keys.
 */
function receiptContentBytes(content: ReceiptContent): Uint8Array<ArrayBuffer> {
  // Reconstruct the content in a fixed shape so the signed bytes never depend on
  // extra properties or key order a caller's object might carry, mirroring
  // signingIdentity's certificateBody.
  const canonical: Record<string, CanonicalValue> = {
    termsHash: content.termsHash,
    initiatorToResponderPayload: content.initiatorToResponderPayload,
    responderToInitiatorPayload: content.responderToInitiatorPayload,
    binder: content.binder,
  };
  return canonicalBytes({ domain: RECEIPT_CONTENT_DOMAIN, content: canonical });
}

// --- Sign / verify -----------------------------------------------------------

/**
 * Sign the receipt content with `identity`'s Ed25519 private key, returning the
 * unpadded base64url signature over the domain-separated canonical bytes. The
 * signature is deterministic (Ed25519), so both an implementation and its
 * cross-implementation twin produce the same signature for the same content and
 * key.
 */
export async function signReceiptContent(
  identity: SigningIdentity,
  content: ReceiptContent,
): Promise<string> {
  const seed = fromBase64Url(identity.privateKey.d);
  const signature = ed25519.sign(receiptContentBytes(content), seed);
  return toBase64Url(signature);
}

/**
 * Whether `signature` is a valid Ed25519 signature over `content` under
 * `certificate`'s public key. A boolean verdict, never a throw: a malformed
 * signature or public key is a `false`, so a caller feeding a partner-supplied
 * signature always gets a verdict. Strict RFC 8032 verification (zip215: false),
 * matching the certificate self-signature check, so a signature this accepts a
 * strict cross-implementation verifier also accepts.
 *
 * This checks only the signature; the certificate's trust (pin + self-signature)
 * and identity binding are gated separately by {@link verifyPresentedCertificate}
 * BEFORE this is consulted (see {@link verifyPartnerReceipt}).
 */
export function verifyReceiptSignature(
  certificate: SigningCertificate,
  content: ReceiptContent,
  signature: string,
): boolean {
  let sig: Uint8Array<ArrayBuffer>;
  let pub: Uint8Array<ArrayBuffer>;
  try {
    sig = fromBase64Url(signature);
    pub = fromBase64Url(certificate.publicKey.x);
  } catch {
    return false;
  }
  if (sig.length !== ED25519_SIGNATURE_BYTES) return false;
  try {
    return ed25519.verify(sig, receiptContentBytes(content), pub, {
      zip215: false,
    });
  } catch {
    return false;
  }
}

// --- Dual-signed record ------------------------------------------------------

/**
 * One party's contribution to a dual-signed record: its self-signed certificate
 * (carrying its identity and public key) and its signature over the receipt
 * content. A verifier trusts the certificate by fingerprint pin, then checks the
 * signature and the certificate's identity binding.
 */
export interface SignedReceiptParty {
  certificate: SigningCertificate;
  /** Ed25519 signature (unpadded base64url) over the receipt content. */
  signature: string;
}

/**
 * A dual-signed exchange record: the mutually-verifiable receipt content plus both
 * parties' certificates and signatures. Serialized via the canonical encoding so
 * the verification item can parse it back. Roles are fixed by the handshake
 * (initiator / responder), NOT by "local"/"partner", so both parties write a
 * byte-identical artifact for the same exchange.
 */
export interface DualSignedRecord {
  version: typeof SIGNED_RECEIPT_VERSION;
  content: ReceiptContent;
  initiator: SignedReceiptParty;
  responder: SignedReceiptParty;
}

// --- Schema (for the verification item to parse back) ------------------------

// Unpadded base64url, alphabet only; exact byte lengths are checked after
// decoding, mirroring signingIdentity/exchangeRecord (a verifier re-checks the
// signature over the decoded bytes, so the exact length is not schema-pinned).
const base64UrlSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/, "must be an unpadded base64url string");

const ReceiptContentSchema: z.ZodType<ReceiptContent> = z.object({
  termsHash: base64UrlSchema,
  initiatorToResponderPayload: base64UrlSchema,
  responderToInitiatorPayload: base64UrlSchema,
  binder: base64UrlSchema,
});

const SignedReceiptPartySchema: z.ZodType<SignedReceiptParty> = z.object({
  certificate: SigningCertificateSchema,
  signature: base64UrlSchema,
});

const DualSignedRecordSchema: z.ZodType<DualSignedRecord> = z.object({
  version: z.literal(SIGNED_RECEIPT_VERSION),
  content: ReceiptContentSchema,
  initiator: SignedReceiptPartySchema,
  responder: SignedReceiptPartySchema,
});

/** Serialize a {@link DualSignedRecord} to its on-disk/download string form:
 * pretty JSON with a trailing newline, matching the exchange-record on-disk form.
 * This is the human-readable persisted form, NOT the canonical encoding (which is
 * only the bytes that are signed). */
export function serializeDualSignedRecord(record: DualSignedRecord): string {
  return JSON.stringify(record, null, 2) + "\n";
}

/**
 * Parse and validate a {@link DualSignedRecord} from a raw value (e.g. the result
 * of `JSON.parse`). Rejects an unrecognized `version` rather than migrating it.
 * Shape validation only -- signature and pin verification are the verification
 * item's concern.
 *
 * @throws {z.ZodError} if validation fails.
 */
export function parseDualSignedRecord(raw: unknown): DualSignedRecord {
  return DualSignedRecordSchema.parse(raw);
}

// --- Wire exchange -----------------------------------------------------------

// The frame one party sends the other: its certificate and its signature over the
// shared receipt content. The content itself is NOT on the wire -- both parties
// compute it locally from state they already hold (the record commitments, the
// terms hash, and the session-derived binder), so the receiver rebuilds the same
// content and verifies the signature against it. A partner that signed a DIFFERENT
// content therefore fails verification here, not by a content comparison.
const receiptWireSchema = z.object({
  certificate: SigningCertificateSchema,
  signature: base64UrlSchema,
});

type ReceiptWireMessage = z.infer<typeof receiptWireSchema>;

/**
 * A dedicated error kind for the receipt step so the CLI can surface a failed
 * partner-signature or fingerprint-pin check as a security event distinct from a
 * plain transport drop. It is a {@link ConnectionError} of kind `"security"` so
 * the CLI's `instanceof UsageError ? 64 : 69` mapping yields 69 (the exchange
 * failed against the peer, not a local misconfiguration) while the `security`
 * kind marks it as a trust-boundary failure a consumer must not silently retry.
 */
export class ReceiptVerificationError extends ConnectionError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "security", options);
    this.name = "ReceiptVerificationError";
  }
}

/**
 * Verify a partner's presented receipt: the certificate is trusted by pin
 * (self-signature + pinned fingerprint) and authorizes the partner's asserted
 * identity, and THEN the signature verifies over the shared content. The
 * fingerprint-pin check runs strictly before the signature check, fail-closed: a
 * certificate presented with no pin configured, a self-signature that does not
 * verify, or a fingerprint mismatch each throws BEFORE the signature is examined,
 * so a partner whose certificate is not the pinned identity is rejected without
 * the receipt's signature ever being trusted.
 *
 * @throws {ReceiptVerificationError} on an untrusted/unpinned/mismatched
 *   certificate or a signature that does not verify.
 */
async function verifyPartnerReceipt(
  wire: ReceiptWireMessage,
  content: ReceiptContent,
  pinnedFingerprint: string | undefined,
): Promise<SignedReceiptParty> {
  // Fingerprint-pin (and self-signature and identity-binding) check FIRST,
  // fail-closed: verifyPresentedCertificate throws SigningError for an unpinned,
  // untrusted, mismatched, or wrong-identity certificate before we ever consult
  // the signature. Re-tag it as a ReceiptVerificationError so the receipt step's
  // failures share one security-kind error the CLI surfaces meaningfully.
  try {
    await verifyPresentedCertificate({
      certificate: wire.certificate,
      pinnedFingerprint,
      assertedIdentity: wire.certificate.identity,
    });
  } catch (err) {
    throw new ReceiptVerificationError(
      "partner certificate is not trusted: " +
        (err instanceof Error ? err.message : String(err)),
      { cause: err },
    );
  }
  // Only after the certificate is trusted by pin do we check the signature over
  // the shared receipt content. A partner that signed a different content (or a
  // different exchange, via a different binder) fails here.
  if (!verifyReceiptSignature(wire.certificate, content, wire.signature))
    throw new ReceiptVerificationError(
      "partner receipt signature does not verify against this exchange's " +
        "content; the signature is invalid, or the partner signed a different " +
        "exchange (a receipt from another session cannot be presented as " +
        "evidence of this one)",
    );
  return { certificate: wire.certificate, signature: wire.signature };
}

/** Inputs to {@link exchangeSignedReceipt}: this party's signing identity and the
 * pinned partner fingerprint, plus the locally-built receipt content and the
 * session key needed to bind it. */
export interface SignedReceiptExchangeInputs {
  identity: SigningIdentity;
  /** The pinned partner certificate fingerprint (from signing.partner_fingerprint).
   * Absent means no partner certificate can be trusted; verification fails closed. */
  pinnedFingerprint: string | undefined;
  content: ReceiptContent;
}

/**
 * Run the signature exchange over an open {@link MessageConnection} at the
 * conclusion of a successful exchange, producing one {@link DualSignedRecord}
 * carrying both parties' signatures and certificates.
 *
 * Both parties compute the SAME receipt content locally (the caller passes it in),
 * sign it, and swap `{certificate, signature}` frames. Deterministic sender
 * ordering (initiator sends first) follows the existing control-frame convention
 * (see exchangePayloads): the initiator sends then receives; the responder
 * receives then sends (send-before-parse of its own terminal frame). Each party
 * verifies the partner's certificate fingerprint against the pin BEFORE the
 * signature, and a failure throws a {@link ReceiptVerificationError} that
 * terminates the exchange -- the partner signature is not persisted as a valid
 * artifact.
 *
 * The known limitation (accepted, not mitigated): this is post-result evidence,
 * not a fair exchange -- a party may capture the partner's signature and decline
 * to send its own; any failure terminates the run. See docs/spec/PROTOCOL.md.
 */
export async function exchangeSignedReceipt(
  conn: MessageConnection,
  handshakeRole: HandshakeRole,
  inputs: SignedReceiptExchangeInputs,
): Promise<DualSignedRecord> {
  const { identity, pinnedFingerprint, content } = inputs;
  const signature = await signReceiptContent(identity, content);
  const localFrame: ReceiptWireMessage = {
    certificate: identity.certificate,
    signature,
  };
  const localParty: SignedReceiptParty = {
    certificate: identity.certificate,
    signature,
  };

  let partnerParty: SignedReceiptParty;
  if (handshakeRole === "initiator") {
    await conn.send(localFrame);
    const partnerWire = await receiveParsed(conn, receiptWireSchema);
    partnerParty = await verifyPartnerReceipt(
      partnerWire,
      content,
      pinnedFingerprint,
    );
  } else {
    // Responder: receive and verify the partner's frame first, then send its own
    // terminal frame. verifyPartnerReceipt runs before this side's send, so a
    // fingerprint/signature failure terminates before the responder discloses its
    // own signature -- fail-closed, and the partner is left with no valid artifact.
    const partnerWire = await receiveParsed(conn, receiptWireSchema);
    partnerParty = await verifyPartnerReceipt(
      partnerWire,
      content,
      pinnedFingerprint,
    );
    // The receipt exchange's terminal frame. Like exchangePayloads' responder
    // send, it relies on the transport's exactly-once-or-terminal delivery of the
    // final frame (a durable send drained by the clean close, or a flushed
    // buffer); no application-level dedup. See exchangePayloads for the contract.
    await conn.send(localFrame);
  }

  const [initiatorParty, responderParty] =
    handshakeRole === "initiator"
      ? [localParty, partnerParty]
      : [partnerParty, localParty];

  return {
    version: SIGNED_RECEIPT_VERSION,
    content,
    initiator: initiatorParty,
    responder: responderParty,
  };
}
