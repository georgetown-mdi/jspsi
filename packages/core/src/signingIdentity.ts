import { z } from "zod";

import { camelizeKeys } from "./utils/camelizeKeys.js";
import { partnerPinIsPresent } from "./config/signing.js";
import { canonicalBytes } from "./utils/canonical.js";
import {
  bytesEqual,
  fromBase64Url,
  sha256,
  toBase64Url,
} from "./utils/crypto.js";
import {
  SigningError,
  assertPrivateKeyMatchesPublic,
  decodeEcdsaSignature,
  generateP256PrivateJwk,
  importPrivateSigningKey,
  importPublicSigningKey,
  signWithP256,
  verifyWithP256,
} from "./signingKeys.js";

import type { CanonicalValue } from "./utils/canonical.js";
import type { P256PrivateJwk, P256PublicJwk } from "./signingKeys.js";

// The long-lived signing identity that backs certificate-mode exchange receipts
// (Phase 2). Each party generates one keypair and one self-signed certificate
// carrying its `identity`, persists it owner-read-only, and reuses it across
// every exchange and every partner. The partner pins this certificate's
// fingerprint out-of-band at setup; every later receipt verifies against the
// same key, so the identity must be stable for its whole life. Regenerating it
// is a deliberate act that invalidates any fingerprint a partner has pinned.
//
// Trust model: pinned self-signed. There is no CA chain and no revocation -- the
// fingerprint pin, exchanged over a trusted out-of-band channel, IS the trust
// anchor (the same channel the parties already use for the invitation). The
// certificate format is a small canonical-JSON document signed over its RFC 8785
// canonical bytes, reusing the project's single canonicalization primitive
// rather than introducing an X.509/ASN.1 surface; see docs/SECURITY_DESIGN.md
// for the rationale and the extensibility seam toward an authority-backed mode.
//
// Key handling, the signature encoding, and the algorithm parameters live in
// signingKeys.ts, the one chokepoint this module and signedReceipt.ts share.

export { SigningError } from "./signingKeys.js";
export type { P256PrivateJwk } from "./signingKeys.js";

// --- Versions and domains ----------------------------------------------------

/** Single recognized certificate format version; a reader rejects any other
 * value rather than migrating it. Doubles as the format discriminant over the
 * signature scheme and the public-key representation together, so a document
 * written under a different version is refused rather than reinterpreted under
 * this one; a future authority-backed (X.509) representation would likewise be a
 * distinct version. */
export const SIGNING_CERTIFICATE_VERSION = "psilink-signing-cert/v2";

/** Single recognized version for the on-disk signing identity file (private key
 * + certificate). */
export const SIGNING_IDENTITY_VERSION = "psilink-signing-identity/v2";

// Domain-separation labels folded into the bytes that are signed and hashed.
// They keep a certificate self-signature cryptographically distinct from a
// receipt signature and from the fingerprint pre-image, so a signature or digest
// produced in one context can never be replayed as another. Keep them distinct
// -- this is the same domain-separation discipline used for the exchange-record
// commitments and the agreed-terms hash. They are not versioned alongside the
// certificate format: the body's own `version` field is inside the bytes both
// labels cover, so a v1 and a v2 body already separate.
const CERTIFICATE_SIGNATURE_DOMAIN = "psilink-signing-cert-signature/v1";
const CERTIFICATE_FINGERPRINT_DOMAIN = "psilink-signing-cert-fingerprint/v1";

/** The one signature algorithm supported by this certificate version: ECDSA
 * over P-256 with SHA-256, the signature encoded as the fixed-length raw
 * `r || s` (IEEE P1363). A field rather than an implicit assumption so an
 * authority-backed mode (which may carry another scheme) can add a value without
 * changing the certificate shape. */
type SigningAlgorithm = "ecdsa-p256-sha256";

const SIGNING_ALGORITHM: SigningAlgorithm = "ecdsa-p256-sha256";

// --- Types -------------------------------------------------------------------

/**
 * The signed content of a certificate -- the "to-be-signed" body. The
 * self-signature is computed over this (domain-separated), and the fingerprint
 * is a hash of this (domain-separated), so both the signature and the pinned
 * fingerprint bind the public key to the asserted identity together. Field
 * order is irrelevant: the canonical encoding sorts keys.
 */
export interface CertificateBody {
  version: typeof SIGNING_CERTIFICATE_VERSION;
  algorithm: SigningAlgorithm;
  /** The party's self-asserted identity (its `linkage_terms.identity`). A
   * receipt is authorized only if its asserted identity matches this exactly. */
  identity: string;
  publicKey: P256PublicJwk;
}

/** A self-signed certificate: the {@link CertificateBody} plus a signature over
 * it made with the body's own public key. */
export interface SigningCertificate extends CertificateBody {
  /** ECDSA P-256 signature (unpadded base64url raw `r || s`) over the
   * domain-separated canonical bytes of the body, by the body's public key. */
  signature: string;
}

/**
 * The on-disk signing identity: the private key and the self-signed certificate
 * it issued. Holding this allows signing as the identity, so it is persisted
 * owner-read-only and never shared. The certificate alone (its public half) is
 * shareable; its fingerprint is what a partner pins.
 */
export interface SigningIdentity {
  version: typeof SIGNING_IDENTITY_VERSION;
  privateKey: P256PrivateJwk;
  certificate: SigningCertificate;
}

// --- Schemas -----------------------------------------------------------------

// Unpadded base64url. Exact byte lengths are checked after decoding (with a
// precise message) rather than length-locked here, mirroring exchangeRecord's
// approach: a reader verifies by decoding and using the bytes, so the schema
// only needs to confirm the alphabet.
const base64UrlSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/, "must be an unpadded base64url string");

const P256PublicJwkSchema: z.ZodType<P256PublicJwk> = z.object({
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  x: base64UrlSchema,
  y: base64UrlSchema,
});

const P256PrivateJwkSchema: z.ZodType<P256PrivateJwk> = z.object({
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  x: base64UrlSchema,
  y: base64UrlSchema,
  d: base64UrlSchema,
});

const SigningAlgorithmSchema: z.ZodType<SigningAlgorithm> =
  z.literal(SIGNING_ALGORITHM);

const CertificateBodyShape = {
  version: z.literal(SIGNING_CERTIFICATE_VERSION),
  algorithm: SigningAlgorithmSchema,
  identity: z.string().min(1),
  publicKey: P256PublicJwkSchema,
};

/**
 * Field-shape schema for a {@link SigningCertificate}: the signed body plus the
 * base64url self-signature. Exported so a wire frame or record that embeds a
 * certificate (the signed-receipt module) can nest it in its own schema. Shape
 * only -- it does NOT self-verify; a caller that trusts the certificate runs
 * {@link assertPartnerCertificateTrusted} / {@link verifyPresentedCertificate},
 * which check the self-signature and the fingerprint pin.
 */
const SigningCertificateSchema: z.ZodType<SigningCertificate> = z.object({
  ...CertificateBodyShape,
  signature: base64UrlSchema,
});

const SigningIdentitySchema: z.ZodType<SigningIdentity> = z.object({
  version: z.literal(SIGNING_IDENTITY_VERSION),
  privateKey: P256PrivateJwkSchema,
  certificate: SigningCertificateSchema,
});

// --- Canonical inputs --------------------------------------------------------

/** Extract just the signed/fingerprinted body from a certificate, in a fixed
 * shape, so the signature- and fingerprint-input bytes never depend on extra
 * fields or property order a caller's object might carry. */
function certificateBody(cert: CertificateBody): CanonicalValue {
  return {
    version: cert.version,
    algorithm: cert.algorithm,
    identity: cert.identity,
    publicKey: {
      kty: cert.publicKey.kty,
      crv: cert.publicKey.crv,
      x: cert.publicKey.x,
      y: cert.publicKey.y,
    },
  };
}

function signatureInput(cert: CertificateBody): Uint8Array<ArrayBuffer> {
  return canonicalBytes({
    domain: CERTIFICATE_SIGNATURE_DOMAIN,
    certificate: certificateBody(cert),
  });
}

function fingerprintInput(cert: CertificateBody): Uint8Array<ArrayBuffer> {
  return canonicalBytes({
    domain: CERTIFICATE_FINGERPRINT_DOMAIN,
    certificate: certificateBody(cert),
  });
}

// --- Fingerprint -------------------------------------------------------------

/**
 * Compute a certificate's fingerprint: the unpadded base64url SHA-256 over the
 * domain-separated canonical encoding of the certificate body. The body carries
 * both the public key and the asserted identity, so the fingerprint binds them
 * together -- pinning a fingerprint pins that key-to-identity binding. It covers
 * the body and never the signature, so it stays a known answer for a given key
 * and identity even though ECDSA signing is randomized. The same logical
 * certificate yields the same fingerprint on any implementation (RFC 8785); see
 * docs/spec/CANONICAL_ENCODING.md.
 */
export async function computeCertificateFingerprint(
  cert: CertificateBody,
): Promise<string> {
  return toBase64Url(await sha256(fingerprintInput(cert)));
}

// --- Generation --------------------------------------------------------------

/** Options for {@link generateSigningIdentity}. */
interface GenerateSigningIdentityOptions {
  /** A fixed P-256 private key to bind instead of generating a fresh one.
   * Production callers omit this -- `crypto.subtle.generateKey` takes no seed,
   * so a fixed key is the only way to make generation reproducible; tests and
   * the checked-in cross-implementation vectors supply one. */
  privateKey?: P256PrivateJwk;
}

/**
 * Generate a new long-lived signing identity bound to `identity`: a P-256
 * keypair, a self-signed certificate carrying `identity` and the public key, and
 * the private key. The certificate's fingerprint is fully determined by the key
 * and the identity; the self-signature is not, because ECDSA signing is
 * randomized.
 *
 * @throws {SigningError} if `identity` is empty or `options.privateKey` is not a
 *   valid P-256 private key.
 */
export async function generateSigningIdentity(
  identity: string,
  options: GenerateSigningIdentityOptions = {},
): Promise<SigningIdentity> {
  if (identity.length === 0)
    throw new SigningError(
      "cannot generate a signing identity for an empty identity string",
    );

  const jwk = options.privateKey ?? (await generateP256PrivateJwk());
  // Import even a freshly generated key rather than trusting the exported JWK:
  // the call that makes the key usable for signing is also the one that pins its
  // coordinates to the canonical encoding the fingerprint binds.
  const signingKey = await importPrivateSigningKey(jwk);

  const body: CertificateBody = {
    version: SIGNING_CERTIFICATE_VERSION,
    algorithm: SIGNING_ALGORITHM,
    identity,
    publicKey: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y },
  };
  const signature = await signWithP256(signingKey, signatureInput(body));

  return {
    version: SIGNING_IDENTITY_VERSION,
    privateKey: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d },
    certificate: { ...body, signature },
  };
}

// --- Self-signature verification ---------------------------------------------

/**
 * Assert a certificate's self-signature, throwing a {@link SigningError} that
 * names the specific failure: a malformed or off-curve public key, a malformed
 * or wrong-length signature, or a signature that does not verify. This is the
 * throwing form used on every load and trust path so a bad key is reported as
 * such rather than masquerading as a failed signature. Pure check; does not
 * consult any pin or identity.
 *
 * @throws {SigningError}
 */
async function assertCertificateSelfSignature(
  cert: SigningCertificate,
): Promise<void> {
  // Each of these throws a precise SigningError naming what is wrong.
  const key = await importPublicSigningKey(cert.publicKey);
  const signature = decodeEcdsaSignature(
    cert.signature,
    "certificate signature",
  );
  if (!(await verifyWithP256(key, signature, signatureInput(cert))))
    throw new SigningError(
      "certificate self-signature does not verify; the certificate is " +
        "malformed or has been tampered with",
    );
}

/**
 * Whether a certificate's self-signature is valid: that `certificate.signature`
 * is a valid ECDSA P-256 signature over the certificate body under the body's
 * own public key. The boolean counterpart to
 * {@link assertCertificateSelfSignature} for callers that only need a yes/no
 * (the precise reason is available from the asserting form). Resolves `false`
 * for a malformed signature, an invalid public key, or a signature that does not
 * verify.
 */
export async function verifyCertificateSelfSignature(
  cert: SigningCertificate,
): Promise<boolean> {
  try {
    await assertCertificateSelfSignature(cert);
    return true;
  } catch {
    return false;
  }
}

// --- Parse / serialize -------------------------------------------------------

/**
 * Parse, validate, and self-verify a certificate from a raw value (e.g. the
 * result of `JSON.parse`). Snake_case keys are camelized first. Beyond schema
 * validation this rejects a public key that is not a canonically encoded point
 * on P-256 and a certificate whose self-signature does not verify, so a parsed
 * certificate is always internally consistent (it does not establish trust --
 * that is the pin's job). A certificate carrying any other `version` is rejected
 * by the schema rather than reinterpreted under this scheme.
 *
 * @throws {ZodError} if the shape is invalid.
 * @throws {SigningError} if the key is malformed or the self-signature does not
 *   verify.
 */
export async function parseCertificate(
  raw: unknown,
): Promise<SigningCertificate> {
  const cert = SigningCertificateSchema.parse(camelizeKeys(raw));
  await assertCertificateSelfSignature(cert);
  return cert;
}

/**
 * Parse, validate, and self-verify a signing identity (private key +
 * certificate) from a raw value. In addition to {@link parseCertificate}'s
 * checks, this verifies that the private key is a valid P-256 key belonging with
 * the public coordinates stored beside it and that those coordinates are the
 * certificate's, so a tampered or mismatched identity file is rejected on load
 * rather than producing receipts that fail to verify.
 *
 * @throws {ZodError} if the shape is invalid.
 * @throws {SigningError} if a key is malformed, the self-signature does not
 *   verify, or the private and certificate public keys disagree.
 */
export async function parseSigningIdentity(
  raw: unknown,
): Promise<SigningIdentity> {
  const id = SigningIdentitySchema.parse(camelizeKeys(raw));
  // Validates the certificate (key + self-signature) the same way a standalone
  // certificate would be checked.
  await parseCertificate(id.certificate);
  const privateKey = await importPrivateSigningKey(id.privateKey);
  await assertPrivateKeyMatchesPublic(
    privateKey,
    id.privateKey,
    id.certificate.publicKey,
    "signing identity is inconsistent: the private key does not match its " +
      "certificate's public key",
  );
  return id;
}

// Pretty JSON with a trailing newline, matching the exchange-record on-disk
// form. This is the human-readable persisted form, NOT the canonical encoding
// (which is only the bytes that are signed or hashed).
function serialize(value: SigningIdentity | SigningCertificate): string {
  return JSON.stringify(value, null, 2) + "\n";
}

/** Serialize a signing identity (including the private key) to its on-disk
 * string form. The caller is responsible for writing it owner-read-only. */
export function serializeSigningIdentity(id: SigningIdentity): string {
  return serialize(id);
}

/** Serialize a certificate (public; no private key) to its shareable/export
 * string form. */
export function serializeCertificate(cert: SigningCertificate): string {
  return serialize(cert);
}

// --- Identity binding --------------------------------------------------------

/**
 * Whether `certificate` authorizes `assertedIdentity`: an exact match of the
 * full identity, compared over the same canonical bytes the record commits to
 * and a receipt signs (RFC 8785). Because `identity` is a string, this is exact
 * string equality; expressing it over the canonical encoding keeps the check on
 * the identity bytes the rest of the receipt system agrees on.
 */
export function certificateAuthorizesIdentity(
  certificate: CertificateBody,
  assertedIdentity: string,
): boolean {
  return canonicalBytesEqual(certificate.identity, assertedIdentity);
}

function canonicalBytesEqual(a: string, b: string): boolean {
  // Both are plain strings, so their canonical encodings are equal iff the
  // strings are equal; routing through canonicalBytes documents that the binding
  // operates on the canonical identity bytes and stays correct if `identity`
  // ever becomes structured.
  return bytesEqual(canonicalBytes(a), canonicalBytes(b));
}

/**
 * Assert that `certificate` authorizes `assertedIdentity`, throwing a
 * {@link SigningError} otherwise. Used to gate accepting a receipt: a receipt
 * whose asserted identity is not the one its presenting certificate carries is
 * rejected.
 */
export function assertCertificateAuthorizesIdentity(
  certificate: CertificateBody,
  assertedIdentity: string,
): void {
  if (!certificateAuthorizesIdentity(certificate, assertedIdentity))
    throw new SigningError(
      "receipt identity is not authorized by the presenting certificate: the " +
        `certificate is bound to a different identity`,
    );
}

// --- Partner certificate trust (fingerprint pinning) -------------------------

/** Whether `certificate`'s fingerprint matches `pinnedFingerprint`, compared in
 * constant time over the decoded digest bytes. */
export async function matchesPinnedFingerprint(
  certificate: CertificateBody,
  pinnedFingerprint: string,
): Promise<boolean> {
  const actual = await computeCertificateFingerprint(certificate);
  let actualBytes: Uint8Array<ArrayBuffer>;
  let pinnedBytes: Uint8Array<ArrayBuffer>;
  try {
    actualBytes = fromBase64Url(actual);
    pinnedBytes = fromBase64Url(pinnedFingerprint);
  } catch {
    // A malformed pinned value cannot match anything.
    //
    // A malformed pin is indistinguishable here from a genuine mismatch -- both
    // end as "fingerprint does not match" -- so a caller validates the pin
    // against FINGERPRINT_REGEX before it reaches this comparison and reports a
    // malformed one as its own error. The exchange path gets that from
    // SigningConfigSchema; `verify-receipt` validates both its
    // --partner-fingerprint flag and the config value it reads directly. A caller
    // that skips it turns "your pin is malformed" into "the partner's
    // certificate does not match", which is a confusing diagnosis rather than an
    // unsafe one: this returns false either way.
    return false;
  }
  return bytesEqual(actualBytes, pinnedBytes);
}

/**
 * Assert that a presented partner certificate is trusted: it self-verifies and
 * its fingerprint matches the pinned value. Rejects, with a clear error, a
 * certificate presented when no fingerprint is pinned (`pinnedFingerprint`
 * absent), one whose self-signature does not verify, and one whose fingerprint
 * does not match the pin -- in every case before any receipt it carries is
 * accepted.
 *
 * @throws {SigningError}
 */
export async function assertPartnerCertificateTrusted(
  certificate: SigningCertificate,
  pinnedFingerprint: string | undefined,
): Promise<void> {
  if (!partnerPinIsPresent(pinnedFingerprint))
    throw new SigningError(
      "no pinned partner fingerprint is configured, so the partner's " +
        "certificate cannot be trusted; obtain the partner's fingerprint " +
        "out-of-band and set signing.partner_fingerprint",
    );
  // Surface the precise reason (invalid key vs. failed signature) with
  // partner-facing context rather than a single generic message.
  try {
    await assertCertificateSelfSignature(certificate);
  } catch (err) {
    throw new SigningError(
      "partner certificate is not valid: " +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  if (!(await matchesPinnedFingerprint(certificate, pinnedFingerprint)))
    throw new SigningError(
      "partner certificate fingerprint does not match the pinned value; the " +
        "certificate is not the partner's pinned identity (or the partner has " +
        "regenerated its identity and must re-share its fingerprint)",
    );
}

/** Inputs to {@link verifyPresentedCertificate}. */
interface PresentedCertificateCheck {
  /** The certificate presented by the partner (e.g. carried in a receipt). */
  certificate: SigningCertificate;
  /** The locally pinned partner fingerprint, if any. */
  pinnedFingerprint: string | undefined;
  /** The identity the receipt asserts for the presenting party. */
  assertedIdentity: string;
}

/**
 * Full acceptance gate for a partner certificate presented with a receipt:
 * trust it by pin (self-signature + pinned fingerprint) and then require that it
 * authorizes the receipt's asserted identity. Throws on the first failure with a
 * clear, user-facing message. This is the single entry point a receipt-
 * verification phase calls.
 *
 * Note for that caller: validate `pinnedFingerprint` against `FINGERPRINT_REGEX`
 * first, whatever its source -- see the note in
 * {@link matchesPinnedFingerprint}, where a malformed pin is indistinguishable
 * from a genuine mismatch.
 *
 * @throws {SigningError}
 */
export async function verifyPresentedCertificate(
  check: PresentedCertificateCheck,
): Promise<void> {
  await assertPartnerCertificateTrusted(
    check.certificate,
    check.pinnedFingerprint,
  );
  assertCertificateAuthorizesIdentity(
    check.certificate,
    check.assertedIdentity,
  );
}
