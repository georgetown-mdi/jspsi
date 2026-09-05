import { z } from "zod";

import { canonicalBytes } from "../utils/canonical.js";
import { hkdfDerive, hmacSha256, toBase64Url } from "../utils/crypto.js";
import {
  ConnectionError,
  receiveParsed,
} from "../connection/messageConnection.js";
import { MAX_TEXT_LENGTH } from "../config/linkageTermsSchema.js";
import {
  SIGNING_CERTIFICATE_VERSION,
  computeCertificateFingerprint,
  verifyPresentedCertificate,
} from "./signingIdentity.js";
import {
  decodeEcdsaSignature,
  importPrivateSigningKey,
  importPublicSigningKey,
  signWithP256,
  verifyWithP256,
} from "./signingKeys.js";

import type { HandshakeRole } from "../types.js";
import type { MessageConnection } from "../connection/messageConnection.js";
import type { CanonicalValue } from "../utils/canonical.js";
import type { CommittedPayload } from "./exchangeRecord.js";
import type { SigningCertificate, SigningIdentity } from "./signingIdentity.js";

// Certificate-backed signed exchange receipts (the sign/exchange step): both
// parties sign one shared receipt content over signer-bound bytes and swap
// signatures over the live channel, producing one dual-signed record. The
// step, its trust model, and what the content admits are in
// docs/spec/PROTOCOL.md ("The signed-receipt step"); the byte layout every
// derivation here must reproduce is docs/spec/EXCHANGE_RECORD.md ("Signed
// receipt").
//
// This module reuses the certificate/pinning primitives
// (signingIdentity.ts), the canonical encoding (utils/canonical.ts), and the
// committed-payload shape (exchangeRecord.ts) rather than introducing a
// second signing or serialization surface.

// --- Versions and domains ----------------------------------------------------

/** Single recognized format version for a dual-signed record; a reader rejects
 * any other value rather than migrating it. It moves with the certificate
 * format the record embeds (docs/spec/EXCHANGE_RECORD.md, "Dual-signed record
 * file"). */
export const SIGNED_RECEIPT_VERSION = "psilink-signed-receipt/v2";

// The domain label folded into the signed receipt-content bytes. Its version
// tracks the shape of those bytes, not the signature algorithm; the embedded
// certificate's own version separates a v1 certificate from a v2 one inside
// them. See docs/spec/EXCHANGE_RECORD.md ("Receipt signature").
const RECEIPT_CONTENT_DOMAIN = "psilink-signed-receipt-content/v2";

// The two HKDF info labels the session-derived receipt values are taken
// under -- this one and RECEIPT_BINDER_LABEL below -- sit in the disjoint
// space docs/spec/PROTOCOL.md ("The domain-separation label space")
// enumerates. Each takes a suffix from a fixed, non-empty set, which is what
// keeps it prefix-free; neither is given a variable or optional one.
const RECEIPT_PAYLOAD_MAC_LABEL = "psilink-signed-receipt-payload-v1";

// The two directions the payload MAC keys are derived for. Fixed by the handshake
// roles (not by local/partner), so both parties key the two directions identically.
const RECEIPT_PAYLOAD_MAC_DIRECTIONS = {
  initiatorToResponder: "initiator-to-responder",
  responderToInitiator: "responder-to-initiator",
} as const;

const RECEIPT_BINDER_LABEL = "psilink-signed-receipt-binder-v1";

const RECEIPT_PAYLOAD_MAC_BYTES = 32;

const RECEIPT_BINDER_BYTES = 32;

// --- Per-exchange replay binder ----------------------------------------------

/**
 * Derive the per-exchange replay binder folded into the signed receipt
 * content; its derivation and what it pairs are in docs/spec/PROTOCOL.md
 * ("Replay binder").
 *
 * Both parties must call this with the SAME `role` argument, the initiator's:
 * the role suffix is HKDF domain separation, not a per-party value, so
 * passing the local role instead would give the two parties different binders
 * and fail the swap. Passing an unrecognized role throws rather than silently
 * deriving one the two parties may not agree on, mirroring
 * {@link deriveAbortToken}.
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
 * The mutually-verifiable facts both parties sign. Every field is one both
 * parties derive byte-identically after a successful exchange, so a
 * signature over them is evidence a third party (given the pinned
 * fingerprints) can check against either party's view:
 * - `termsHash`: the agreed-terms hash (computeTermsHash; both compute the
 *   same).
 * - `initiatorToResponderPayload` / `responderToInitiatorPayload`: a
 *   session-keyed MAC of the committed payload that flowed in each
 *   direction, keyed by the fixed handshake roles. The empty (no-data)
 *   direction MACs a canonical empty payload, so it too matches on both
 *   sides.
 * - `binder`: the per-exchange session-derived replay binder; identical for
 *   both.
 *
 * One-party-only facts (recordsExposed, the retention pointer, the salted
 * record commitments, the association-table pairing) are absent -- they are
 * not mutually verifiable. Full rationale: docs/spec/EXCHANGE_RECORD.md
 * ("Signed receipt").
 */
export interface ReceiptContent {
  termsHash: string;
  /** Session-keyed MAC of the data the initiator sent to the responder (base64url). */
  initiatorToResponderPayload: string;
  /** Session-keyed MAC of the data the responder sent to the initiator (base64url). */
  responderToInitiatorPayload: string;
  /** The per-exchange replay binder (base64url); identical for both parties. */
  binder: string;
}

/**
 * Derive the per-direction payload MAC key from the session key: HKDF-SHA-256 with
 * a prefix-free label whose direction suffix separates the two directions. Both
 * parties hold the session key, so both derive the same key for each direction.
 * Derived at sign/verify time only -- NEVER stored in the receipt, which holds
 * only the resulting MAC value.
 */
async function deriveDirectionalPayloadMacKey(
  sessionKey: Uint8Array<ArrayBuffer>,
  direction: (typeof RECEIPT_PAYLOAD_MAC_DIRECTIONS)[keyof typeof RECEIPT_PAYLOAD_MAC_DIRECTIONS],
): Promise<Uint8Array<ArrayBuffer>> {
  return hkdfDerive(
    sessionKey,
    `${RECEIPT_PAYLOAD_MAC_LABEL}:${direction}`,
    RECEIPT_PAYLOAD_MAC_BYTES,
  );
}

/**
 * Compute the directional payload MAC over the committed payload's canonical
 * encoding, under a session-derived per-direction key. Its construction and
 * what keying it off the session key buys: docs/spec/EXCHANGE_RECORD.md
 * ("Receipt content"). The payload passed in must already be the record
 * format's committed-payload shape, not the transport's, or the two parties
 * MAC different bytes for the same logical data.
 */
async function macCommittedPayload(
  macKey: Uint8Array<ArrayBuffer>,
  payload: CommittedPayload,
): Promise<string> {
  const bytes = canonicalBytes(payload as CanonicalValue);
  return toBase64Url(await hmacSha256(macKey, bytes));
}

/**
 * Assemble the receipt content both parties sign, from the facts each holds after
 * the exchange. `handshakeRole` fixes which of this party's payloads is the
 * initiator-to-responder direction and which is the responder-to-initiator one, so
 * both parties key the two directions identically regardless of which is "local".
 * The directional payload MAC keys are derived here from `sessionKey`, used, and
 * discarded -- they are not part of the returned content and never persisted.
 *
 * @param handshakeRole  This party's handshake role.
 * @param termsHash      The agreed-terms hash (both parties compute the same value).
 * @param localPayloadSent      The committed payload THIS party sent the partner.
 * @param partnerPayloadReceived The committed payload THIS party received.
 * @param binder         The per-exchange replay binder (see deriveReceiptBinder).
 * @param sessionKey     The exchange's session key, used to derive the per-direction
 *                       payload MAC keys (both parties hold it).
 */
export async function buildReceiptContent(
  handshakeRole: HandshakeRole,
  termsHash: string,
  localPayloadSent: CommittedPayload,
  partnerPayloadReceived: CommittedPayload,
  binder: string,
  sessionKey: Uint8Array<ArrayBuffer>,
): Promise<ReceiptContent> {
  // The initiator's outbound payload is its localPayloadSent; the responder's
  // outbound payload is likewise its localPayloadSent. Keying by role -- not by
  // local/partner -- makes both parties place the same MAC under the same direction
  // key, so their content objects are byte-identical.
  const [initiatorToResponder, responderToInitiator] =
    handshakeRole === "initiator"
      ? [localPayloadSent, partnerPayloadReceived]
      : [partnerPayloadReceived, localPayloadSent];
  const [i2rKey, r2iKey] = await Promise.all([
    deriveDirectionalPayloadMacKey(
      sessionKey,
      RECEIPT_PAYLOAD_MAC_DIRECTIONS.initiatorToResponder,
    ),
    deriveDirectionalPayloadMacKey(
      sessionKey,
      RECEIPT_PAYLOAD_MAC_DIRECTIONS.responderToInitiator,
    ),
  ]);
  const [initiatorToResponderPayload, responderToInitiatorPayload] =
    await Promise.all([
      macCommittedPayload(i2rKey, initiatorToResponder),
      macCommittedPayload(r2iKey, responderToInitiator),
    ]);
  return {
    termsHash,
    initiatorToResponderPayload,
    responderToInitiatorPayload,
    binder,
  };
}

/**
 * Build the canonical bytes one party signs for a receipt, laid out in
 * docs/spec/EXCHANGE_RECORD.md ("Receipt signature"). The `signer` member
 * binds the SIGNER's own fingerprint and role, which is what makes the two
 * signature blocks in a dual-signed record non-interchangeable. Field order
 * is irrelevant here -- the canonical encoder sorts keys.
 */
function receiptSignatureBytes(
  content: ReceiptContent,
  signerFingerprint: string,
  signerRole: HandshakeRole,
): Uint8Array<ArrayBuffer> {
  // Reconstruct the content in a fixed shape so the signed bytes never depend
  // on extra properties or key order a caller's object might hold, mirroring
  // signingIdentity's certificateBody.
  const canonical: Record<string, CanonicalValue> = {
    termsHash: content.termsHash,
    initiatorToResponderPayload: content.initiatorToResponderPayload,
    responderToInitiatorPayload: content.responderToInitiatorPayload,
    binder: content.binder,
  };
  return canonicalBytes({
    domain: RECEIPT_CONTENT_DOMAIN,
    content: canonical,
    signer: { fingerprint: signerFingerprint, role: signerRole },
  });
}

// --- Sign / verify -----------------------------------------------------------

/**
 * Sign the receipt content with `identity`'s P-256 private key, returning
 * the unpadded base64url ECDSA signature over the signer-bound canonical
 * bytes (the shared content plus this signer's own certificate fingerprint
 * and handshake role, see {@link receiptSignatureBytes}). ECDSA signing is
 * randomized, so two calls over identical input produce different
 * signatures; what reproduces across implementations is the signed bytes,
 * and therefore which signatures verify.
 *
 * @param identity  This party's signing identity.
 * @param content   The shared receipt content both parties sign.
 * @param signerRole  This signer's handshake role, bound into the signed
 *   bytes.
 */
export async function signReceiptContent(
  identity: SigningIdentity,
  content: ReceiptContent,
  signerRole: HandshakeRole,
): Promise<string> {
  const fingerprint = await computeCertificateFingerprint(identity.certificate);
  const key = await importPrivateSigningKey(identity.privateKey);
  return signWithP256(
    key,
    receiptSignatureBytes(content, fingerprint, signerRole),
  );
}

/**
 * Whether `signature` is a valid ECDSA P-256 signature over `content` bound
 * to the signer identified by `certificate` and `signerRole`, under
 * `certificate`'s public key. The signed bytes are reconstructed from the
 * shared content plus the signer's OWN certificate fingerprint and role, so
 * a signature made by one party does not verify when checked as the
 * other's. A boolean verdict, never a throw: a malformed signature or
 * public key is a `false`, so a caller feeding a partner-supplied signature
 * always gets a verdict. The signature must be the fixed-length raw
 * `r || s` encoding; any other length is a `false` rather than a decode
 * attempt.
 *
 * This checks only the signature; the certificate's trust (pin +
 * self-signature) and identity binding MUST already have been gated by
 * {@link verifyPresentedCertificate} BEFORE this is consulted (see
 * {@link verifyPartnerReceipt}) -- verifying against an untrusted
 * certificate proves only that the certificate signed itself, not that it
 * is the pinned partner.
 */
export async function verifyReceiptSignature(
  certificate: SigningCertificate,
  content: ReceiptContent,
  signature: string,
  signerRole: HandshakeRole,
): Promise<boolean> {
  let sig: Uint8Array<ArrayBuffer>;
  let key: CryptoKey;
  try {
    sig = decodeEcdsaSignature(signature, "receipt signature");
    key = await importPublicSigningKey(certificate.publicKey);
  } catch {
    return false;
  }
  const fingerprint = await computeCertificateFingerprint(certificate);
  try {
    return await verifyWithP256(
      key,
      sig,
      receiptSignatureBytes(content, fingerprint, signerRole),
    );
  } catch {
    return false;
  }
}

// --- Dual-signed record ------------------------------------------------------

/**
 * One party's contribution to a dual-signed record: its self-signed
 * certificate (holding its identity and public key) and its signature over
 * the receipt content bound to this party's own fingerprint and role. A
 * verifier trusts the certificate by fingerprint pin, then checks the
 * signature (against bytes bound to this party) and the certificate's
 * identity binding.
 */
export interface SignedReceiptParty {
  certificate: SigningCertificate;
  /** ECDSA P-256 signature (unpadded base64url raw `r || s`) over the receipt
   * content bound to this party's fingerprint and role. */
  signature: string;
}

/**
 * A dual-signed exchange record: the mutually-verifiable receipt content
 * plus both parties' certificates and signatures, serialized via the
 * canonical encoding so the verification item can parse it back. Roles are
 * fixed by the handshake (initiator / responder), not by "local"/"partner",
 * so both parties write the same record. The two files are byte-identical
 * because each party copies the signature the other sent rather than
 * re-deriving it; a third party holding a record can re-encode either
 * signature (ECDSA is malleable in `s`) and produce a differing copy that
 * still verifies, so the artifacts are compared by verifying them, not by
 * hashing the file. Full detail: docs/spec/EXCHANGE_RECORD.md
 * ("Dual-signed record file").
 */
export interface DualSignedRecord {
  version: typeof SIGNED_RECEIPT_VERSION;
  content: ReceiptContent;
  initiator: SignedReceiptParty;
  responder: SignedReceiptParty;
}

// --- Schema (for the verification item to parse back) ------------------------

// Length cap for the fixed-size base64url crypto values a receipt holds
// (each MAC/hash is a 32-byte value = 43 unpadded base64url characters, a
// signature 64 bytes = 86), matching the record format's
// MAX_BASE64URL_LENGTH: 256 is far above any legitimate value yet refuses a
// megabyte-scale hostile string. The certificate and signature travel on an
// untrusted partner wire frame, so a ~512MB frame would otherwise pass the
// shape schema before any fingerprint/signature work; the cap rejects it at
// parse. Length-capped, not length-locked -- the exact byte length is
// re-checked after decoding, so it is not pinned here.
const MAX_BASE64URL_LENGTH = 256;

// Unpadded base64url, alphabet only, length-capped; exact byte lengths are checked
// after decoding, mirroring signingIdentity/exchangeRecord (a verifier re-checks the
// signature over the decoded bytes, so the exact length is not schema-pinned).
const base64UrlSchema = z
  .string()
  .max(MAX_BASE64URL_LENGTH)
  .regex(/^[A-Za-z0-9_-]+$/, "must be an unpadded base64url string");

// A certificate parsed from an untrusted partner wire frame, with every
// partner-controlled field length-capped so an oversized frame is rejected
// at parse -- before the fingerprint/signature work -- rather than forcing
// proportional allocation. The bounds mirror the on-disk record format's
// caps (identity -> MAX_TEXT_LENGTH, every base64url field ->
// MAX_BASE64URL_LENGTH); this is the wire safety check the shared
// SigningCertificateSchema (used for operator-trusted on-disk identities)
// leaves unbounded. Shape only -- it does NOT self-verify;
// verifyPresentedCertificate checks the self-signature and pin.
const boundedWireCertificateSchema: z.ZodType<SigningCertificate> = z.object({
  version: z.literal(SIGNING_CERTIFICATE_VERSION),
  algorithm: z.literal("ecdsa-p256-sha256"),
  identity: z.string().min(1).max(MAX_TEXT_LENGTH),
  publicKey: z.object({
    kty: z.literal("EC"),
    crv: z.literal("P-256"),
    x: base64UrlSchema,
    y: base64UrlSchema,
  }),
  signature: base64UrlSchema,
});

const ReceiptContentSchema: z.ZodType<ReceiptContent> = z.object({
  termsHash: base64UrlSchema,
  initiatorToResponderPayload: base64UrlSchema,
  responderToInitiatorPayload: base64UrlSchema,
  binder: base64UrlSchema,
});

const SignedReceiptPartySchema: z.ZodType<SignedReceiptParty> = z.object({
  certificate: boundedWireCertificateSchema,
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
 * Shape validation only -- signature, certificate, and pin verification belong to
 * `verifyDualSignedRecord` (signedReceiptVerification.ts), which a caller runs on
 * the parsed record.
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
  certificate: boundedWireCertificateSchema,
  signature: base64UrlSchema,
});

type ReceiptWireMessage = z.infer<typeof receiptWireSchema>;

/**
 * A dedicated error kind for the receipt step so the CLI can report a
 * failed partner-signature or fingerprint-pin check as a security event
 * distinct from a plain transport drop. It is a {@link ConnectionError} of
 * kind `"security"` so the CLI's exit-code mapping yields 69 (the exchange
 * failed against the peer, not a local misconfiguration; `usage` is the one
 * kind that mapping treats as 64), marking it as a trust-boundary failure a
 * consumer must not silently retry.
 */
export class ReceiptVerificationError extends ConnectionError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "security", options);
    this.name = "ReceiptVerificationError";
  }
}

/**
 * Verify a partner's presented receipt: the certificate is trusted by pin
 * (self-signature + pinned fingerprint) and authorizes the partner's
 * AGREED-TERMS identity, and only then does the signature verify over the
 * shared content bound to the partner's role. The fingerprint-pin check
 * runs strictly before the signature check, fail-closed: an untrusted,
 * unpinned, mismatched, or wrong-identity certificate throws before the
 * signature is examined, so a partner whose certificate is not the pinned
 * identity is rejected without the receipt's signature ever being trusted.
 *
 * @param partnerRole  The partner's handshake role (the opposite of the
 *   local party's), bound into the signed bytes the partner's signature is
 *   checked against.
 * @param partnerAssertedIdentity  The identity the partner used in the
 *   AGREED TERMS (`partnerTerms.identity`), which the pinned certificate
 *   must authorize -- NOT the certificate's own identity, whose use would
 *   make the authorization a tautology.
 *
 * @throws {ReceiptVerificationError} on an untrusted/unpinned/mismatched
 *   certificate, a certificate that does not authorize the agreed-terms
 *   identity, or a signature that does not verify.
 */
async function verifyPartnerReceipt(
  wire: ReceiptWireMessage,
  content: ReceiptContent,
  pinnedFingerprint: string | undefined,
  partnerRole: HandshakeRole,
  partnerAssertedIdentity: string,
): Promise<SignedReceiptParty> {
  // Fingerprint-pin (and self-signature and identity-binding) check first,
  // fail-closed: verifyPresentedCertificate throws SigningError for an
  // unpinned, untrusted, mismatched, or wrong-identity certificate before we
  // ever consult the signature. The asserted identity is the partner's
  // agreed-terms identity, so the pinned certificate must authorize the
  // identity the partner used in the agreed terms -- not merely match its
  // own identity. Re-tag as a ReceiptVerificationError so the receipt
  // step's failures share one security-kind error the CLI reports clearly.
  try {
    await verifyPresentedCertificate({
      certificate: wire.certificate,
      pinnedFingerprint,
      assertedIdentity: partnerAssertedIdentity,
    });
  } catch (err) {
    throw new ReceiptVerificationError(
      "partner certificate is not trusted: " +
        (err instanceof Error ? err.message : String(err)),
      { cause: err },
    );
  }
  // Only after the certificate is trusted by pin do we check the signature over
  // the shared receipt content bound to the partner's role. A partner that signed a
  // different content (or a different exchange, via a different binder), or whose
  // signature block was swapped with the local party's (a different bound role),
  // fails here.
  if (
    !(await verifyReceiptSignature(
      wire.certificate,
      content,
      wire.signature,
      partnerRole,
    ))
  )
    throw new ReceiptVerificationError(
      "partner receipt signature does not verify against this exchange's " +
        "content; the signature is invalid, or the partner signed a different " +
        "exchange (a receipt from another session cannot be presented as " +
        "evidence of this one)",
    );
  return { certificate: wire.certificate, signature: wire.signature };
}

/** Inputs to {@link exchangeSignedReceipt}: this party's signing identity and the
 * pinned partner fingerprint, the partner's agreed-terms identity, plus the
 * locally-built receipt content. */
export interface SignedReceiptExchangeInputs {
  identity: SigningIdentity;
  /** The pinned partner certificate fingerprint (from signing.partner_fingerprint).
   * Absent means no partner certificate can be trusted; verification fails closed. */
  pinnedFingerprint: string | undefined;
  /** The identity the partner used in the AGREED TERMS (`partnerTerms.identity`).
   * The pinned certificate must authorize this exact identity, so the authorization
   * binds the partner's agreed-terms identity rather than restating the certificate's
   * own. */
  partnerIdentity: string;
  content: ReceiptContent;
}

/**
 * Run the signature exchange over an open {@link MessageConnection} at the
 * conclusion of a successful exchange, producing one
 * {@link DualSignedRecord} holding both parties' signatures and
 * certificates.
 *
 * Both parties compute the SAME receipt content locally (the caller passes
 * it in), sign it, and swap `{certificate, signature}` frames. Deterministic
 * sender ordering (initiator sends first) follows the existing
 * control-frame convention (see exchangePayloads): the initiator sends then
 * receives; the responder receives then sends. Each party verifies the
 * partner's certificate fingerprint against the pin BEFORE the signature,
 * and a failure throws a {@link ReceiptVerificationError} that terminates
 * the exchange -- the partner signature is not persisted as a valid
 * artifact.
 *
 * Known limitation, accepted not mitigated: this is post-result evidence,
 * not a fair exchange -- a party may capture the partner's signature and
 * decline to send its own; any failure terminates the run. See
 * docs/spec/PROTOCOL.md.
 */
export async function exchangeSignedReceipt(
  conn: MessageConnection,
  handshakeRole: HandshakeRole,
  inputs: SignedReceiptExchangeInputs,
): Promise<DualSignedRecord> {
  const { identity, pinnedFingerprint, partnerIdentity, content } = inputs;
  // This party signs bytes bound to its OWN role; the partner's role is the
  // opposite, and its signature is verified against bytes bound to that role.
  const partnerRole: HandshakeRole =
    handshakeRole === "initiator" ? "responder" : "initiator";
  const signature = await signReceiptContent(identity, content, handshakeRole);
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
      partnerRole,
      partnerIdentity,
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
      partnerRole,
      partnerIdentity,
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
