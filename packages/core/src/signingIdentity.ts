import { ed25519 } from "@noble/curves/ed25519.js";
import { z } from "zod";

import { camelizeKeys } from "./utils/camelizeKeys.js";
import { canonicalBytes } from "./utils/canonical.js";
import {
  bytesEqual,
  fromBase64Url,
  sha256,
  toBase64Url,
} from "./utils/crypto.js";
import { UsageError } from "./errors.js";

import type { CanonicalValue } from "./utils/canonical.js";

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
// anchor (the same channel the parties already use for the PAKE invitation). The
// certificate format is a small canonical-JSON document signed over its RFC 8785
// canonical bytes, reusing the project's single canonicalization primitive
// rather than introducing an X.509/ASN.1 surface; see docs/SECURITY_DESIGN.md
// for the rationale and the extensibility seam toward an authority-backed mode.

// --- Versions and domains ----------------------------------------------------

/** Single recognized certificate format version for v1; a reader rejects any
 * other value rather than migrating it. Doubles as the format discriminant: a
 * future authority-backed (X.509) representation would be a distinct version. */
export const SIGNING_CERTIFICATE_VERSION = "psilink-signing-cert/v1";

/** Single recognized version for the on-disk signing identity file (private key
 * + certificate). */
export const SIGNING_IDENTITY_VERSION = "psilink-signing-identity/v1";

// Domain-separation labels folded into the bytes that are signed and hashed.
// They keep a certificate self-signature cryptographically distinct from a
// receipt signature (a later phase) and from the fingerprint pre-image, so a
// signature or digest produced in one context can never be replayed as another.
// Keep them distinct -- this is the same domain-separation discipline used for
// the exchange-record commitments and the agreed-terms hash.
const CERTIFICATE_SIGNATURE_DOMAIN = "psilink-signing-cert-signature/v1";
const CERTIFICATE_FINGERPRINT_DOMAIN = "psilink-signing-cert-fingerprint/v1";

// Ed25519 byte lengths. Public key and private seed are 32 bytes; an EdDSA
// signature is 64. Used to reject a malformed or wrong-curve key/signature with
// a precise message rather than a downstream verification failure.
const ED25519_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;

/** The one signature algorithm supported in v1. A field rather than an implicit
 * assumption so an authority-backed mode (which may carry RSA or ECDSA) can add
 * a value without changing the certificate shape. */
export type SigningAlgorithm = "ed25519";

// NOTE(receipt-verification): SigningError extends UsageError, so every signing
// failure currently exits the CLI as 64 (EX_USAGE). That is correct for the only
// failures a command surfaces today -- local-identity problems (a malformed or
// inconsistent identity file), which are genuine usage/config errors. The
// partner-trust failures (a mismatched pinned fingerprint, a partner certificate
// whose self-signature does not verify) are arguably security events that
// warrant a distinct exit code (e.g. a TrustError subclass mapped to EX_NOPERM),
// not one indistinguishable from a missing flag. No CLI command raises those yet
// -- assertPartnerCertificateTrusted/verifyPresentedCertificate have no caller
// until the receipt-verification phase -- so the distinction is deferred to that
// caller, which is where the difference becomes observable.

// --- Errors ------------------------------------------------------------------

/**
 * Thrown for any signing-identity or certificate problem: a malformed or
 * unsupported key/certificate, a failed self-signature, an unpinned or
 * mismatched partner fingerprint, or a receipt identity the certificate does not
 * authorize. Extends {@link UsageError} so the CLI classifies it as a
 * configuration/usage problem (exit 64), consistent with how a malformed key
 * file is handled.
 */
export class SigningError extends UsageError {
  constructor(message: string) {
    super(message);
    this.name = "SigningError";
  }
}

// --- Types -------------------------------------------------------------------

/** Ed25519 public key as a JWK (RFC 8037 OKP). `x` is the 32-byte public key,
 * unpadded base64url. */
export interface Ed25519PublicJwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
}

/** Ed25519 private key as a JWK (RFC 8037 OKP): the public `x` plus the 32-byte
 * private seed `d`, both unpadded base64url. As sensitive as any private key;
 * persisted owner-read-only and never shared. */
export interface Ed25519PrivateJwk extends Ed25519PublicJwk {
  d: string;
}

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
  publicKey: Ed25519PublicJwk;
}

/** A self-signed certificate: the {@link CertificateBody} plus a signature over
 * it made with the body's own public key. */
export interface SigningCertificate extends CertificateBody {
  /** Ed25519 signature (unpadded base64url) over the domain-separated canonical
   * bytes of the body, by the body's public key. */
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
  privateKey: Ed25519PrivateJwk;
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

const Ed25519PublicJwkSchema: z.ZodType<Ed25519PublicJwk> = z.object({
  kty: z.literal("OKP"),
  crv: z.literal("Ed25519"),
  x: base64UrlSchema,
});

const Ed25519PrivateJwkSchema: z.ZodType<Ed25519PrivateJwk> = z.object({
  kty: z.literal("OKP"),
  crv: z.literal("Ed25519"),
  x: base64UrlSchema,
  d: base64UrlSchema,
});

const SigningAlgorithmSchema: z.ZodType<SigningAlgorithm> =
  z.literal("ed25519");

const CertificateBodyShape = {
  version: z.literal(SIGNING_CERTIFICATE_VERSION),
  algorithm: SigningAlgorithmSchema,
  identity: z.string().min(1),
  publicKey: Ed25519PublicJwkSchema,
};

const SigningCertificateSchema: z.ZodType<SigningCertificate> = z.object({
  ...CertificateBodyShape,
  signature: base64UrlSchema,
});

const SigningIdentitySchema: z.ZodType<SigningIdentity> = z.object({
  version: z.literal(SIGNING_IDENTITY_VERSION),
  privateKey: Ed25519PrivateJwkSchema,
  certificate: SigningCertificateSchema,
});

// --- Low-level key handling --------------------------------------------------

/**
 * Decode and validate an Ed25519 public key from its JWK `x`, returning the raw
 * 32 bytes. Rejects a wrong-length key, a non-decodable point, and a small-order
 * (degenerate) point -- so the cert-load path never trusts a stored coordinate
 * that is not a real, full-order public key (security requirement: reject
 * degenerate keys on load).
 */
function decodePublicKey(x: string): Uint8Array<ArrayBuffer> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = fromBase64Url(x);
  } catch {
    throw new SigningError("certificate public key is not valid base64url");
  }
  if (bytes.length !== ED25519_KEY_BYTES)
    throw new SigningError(
      `certificate public key must be ${ED25519_KEY_BYTES} bytes, got ` +
        `${bytes.length}`,
    );
  let point: { isSmallOrder: () => boolean };
  try {
    point = ed25519.Point.fromBytes(bytes);
  } catch (err) {
    throw new SigningError(
      "certificate public key is not a valid Ed25519 point: " +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  if (point.isSmallOrder())
    throw new SigningError(
      "certificate public key is a small-order (degenerate) Ed25519 point",
    );
  return bytes;
}

/** Decode and length-check the private seed `d`. The point-validity of the
 * matching public key is checked separately via {@link decodePublicKey}. */
function decodePrivateSeed(d: string): Uint8Array<ArrayBuffer> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = fromBase64Url(d);
  } catch {
    throw new SigningError("signing private key is not valid base64url");
  }
  if (bytes.length !== ED25519_KEY_BYTES)
    throw new SigningError(
      `signing private key must be ${ED25519_KEY_BYTES} bytes, got ` +
        `${bytes.length}`,
    );
  return bytes;
}

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
 * together -- pinning a fingerprint pins that key-to-identity binding. The same
 * logical certificate yields the same fingerprint on any implementation (RFC
 * 8785); see docs/CANONICAL_ENCODING.md.
 */
export async function computeCertificateFingerprint(
  cert: CertificateBody,
): Promise<string> {
  return toBase64Url(await sha256(fingerprintInput(cert)));
}

// --- Generation --------------------------------------------------------------

/** Options for {@link generateSigningIdentity}. */
export interface GenerateSigningIdentityOptions {
  /** A 32-byte seed for deterministic generation. Production callers omit this
   * (a fresh CSPRNG key is generated); tests and the checked-in cross-
   * implementation vectors inject it to make generation reproducible. */
  seed?: Uint8Array;
}

/**
 * Generate a new long-lived signing identity bound to `identity`: a fresh
 * Ed25519 keypair, a self-signed certificate carrying `identity` and the public
 * key, and the private key. Deterministic given `options.seed`.
 *
 * @throws {SigningError} if `identity` is empty.
 */
export function generateSigningIdentity(
  identity: string,
  options: GenerateSigningIdentityOptions = {},
): SigningIdentity {
  if (identity.length === 0)
    throw new SigningError(
      "cannot generate a signing identity for an empty identity string",
    );

  // noble/curves contract: keygen() returns the 32-byte Ed25519 *seed* as
  // `secretKey` (NOT a 64-byte expanded key), and sign() takes that same seed.
  // We store the seed as the JWK `d`. If a future noble version returned an
  // expanded key here, decodePrivateSeed's 32-byte length check on load would
  // reject it rather than letting an inconsistent `d` produce signatures that
  // fail to verify.
  const { secretKey, publicKey } =
    options.seed !== undefined
      ? ed25519.keygen(options.seed)
      : ed25519.keygen();
  const secret = secretKey as Uint8Array<ArrayBuffer>;
  const pub = publicKey as Uint8Array<ArrayBuffer>;

  const body: CertificateBody = {
    version: SIGNING_CERTIFICATE_VERSION,
    algorithm: "ed25519",
    identity,
    publicKey: { kty: "OKP", crv: "Ed25519", x: toBase64Url(pub) },
  };
  const signature = ed25519.sign(signatureInput(body), secret);

  return {
    version: SIGNING_IDENTITY_VERSION,
    privateKey: {
      kty: "OKP",
      crv: "Ed25519",
      x: toBase64Url(pub),
      d: toBase64Url(secret),
    },
    certificate: { ...body, signature: toBase64Url(signature) },
  };
}

// --- Self-signature verification ---------------------------------------------

/**
 * Assert a certificate's self-signature, throwing a {@link SigningError} that
 * names the specific failure: a malformed or degenerate public key, a malformed
 * signature, or a signature that does not verify. This is the throwing form used
 * on every load and trust path so a degenerate key is reported as such rather
 * than masquerading as a failed signature; it decodes the public key exactly
 * once. Pure check; does not consult any pin or identity.
 *
 * @throws {SigningError}
 */
function assertCertificateSelfSignature(cert: SigningCertificate): void {
  // decodePublicKey throws a precise SigningError for a malformed/degenerate key.
  const pub = decodePublicKey(cert.publicKey.x);
  let sig: Uint8Array<ArrayBuffer>;
  try {
    sig = fromBase64Url(cert.signature);
  } catch {
    throw new SigningError("certificate signature is not valid base64url");
  }
  if (sig.length !== ED25519_SIGNATURE_BYTES)
    throw new SigningError(
      `certificate signature must be ${ED25519_SIGNATURE_BYTES} bytes, got ` +
        `${sig.length}`,
    );
  // Strict RFC 8032 verification (zip215: false): reject the non-canonical R/A
  // point encodings that noble's default (zip215: true) would accept, so any
  // certificate we accept is one a strict cross-implementation verifier also
  // accepts. Signing is deterministic and canonical, so our own certificates
  // verify under either setting; this only tightens what a foreign certificate
  // must satisfy.
  if (!ed25519.verify(sig, signatureInput(cert), pub, { zip215: false }))
    throw new SigningError(
      "certificate self-signature does not verify; the certificate is " +
        "malformed or has been tampered with",
    );
}

/**
 * Whether a certificate's self-signature is valid: that `certificate.signature`
 * is a valid Ed25519 signature over the certificate body under the body's own
 * public key. The boolean counterpart to {@link assertCertificateSelfSignature}
 * for callers that only need a yes/no (the precise reason is available from the
 * asserting form). Returns `false` for a malformed signature, a degenerate
 * public key, or a signature that does not verify.
 */
export function verifyCertificateSelfSignature(
  cert: SigningCertificate,
): boolean {
  try {
    assertCertificateSelfSignature(cert);
    return true;
  } catch {
    return false;
  }
}

// --- Parse / serialize -------------------------------------------------------

/**
 * Parse, validate, and self-verify a certificate from a raw value (e.g. the
 * result of `JSON.parse`). Snake_case keys are camelized first. Beyond schema
 * validation this rejects a degenerate public key and a certificate whose
 * self-signature does not verify, so a parsed certificate is always internally
 * consistent (it does not establish trust -- that is the pin's job).
 *
 * @throws {ZodError} if the shape is invalid.
 * @throws {SigningError} if the key is malformed/degenerate or the
 *   self-signature does not verify.
 */
export function parseCertificate(raw: unknown): SigningCertificate {
  const cert = SigningCertificateSchema.parse(camelizeKeys(raw));
  // Decodes the public key (rejecting a malformed/degenerate one) and verifies
  // the self-signature in one pass, each failure with its own precise message.
  assertCertificateSelfSignature(cert);
  return cert;
}

/**
 * Parse, validate, and self-verify a signing identity (private key +
 * certificate) from a raw value. In addition to {@link parseCertificate}'s
 * checks, this verifies that the private key matches the certificate's public
 * key, so a tampered or mismatched identity file is rejected on load rather than
 * producing receipts that fail to verify.
 *
 * @throws {ZodError} if the shape is invalid.
 * @throws {SigningError} if a key is malformed, the self-signature does not
 *   verify, or the private and certificate public keys disagree.
 */
export function parseSigningIdentity(raw: unknown): SigningIdentity {
  const id = SigningIdentitySchema.parse(camelizeKeys(raw));
  // Validates the certificate (key + self-signature) the same way a standalone
  // certificate would be checked.
  parseCertificate(id.certificate);
  const seed = decodePrivateSeed(id.privateKey.d);
  const derivedPub = ed25519.getPublicKey(seed) as Uint8Array<ArrayBuffer>;
  let storedPub: Uint8Array<ArrayBuffer>;
  let certPub: Uint8Array<ArrayBuffer>;
  try {
    storedPub = fromBase64Url(id.privateKey.x);
    certPub = fromBase64Url(id.certificate.publicKey.x);
  } catch {
    throw new SigningError(
      "signing identity public key is not valid base64url",
    );
  }
  // The private key must match both the public key stored alongside it and the
  // one in the certificate it issued; otherwise the file is inconsistent.
  if (!bytesEqual(derivedPub, storedPub) || !bytesEqual(derivedPub, certPub))
    throw new SigningError(
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
    // TODO(receipt-verification): a malformed pin is currently indistinguishable
    // from a genuine mismatch -- both end as "fingerprint does not match". The
    // CLI guards this today (SigningConfigSchema validates partner_fingerprint
    // against FINGERPRINT_REGEX before it reaches here), so it is unreachable via
    // config. The first caller that accepts a fingerprint from a NON-config
    // source must distinguish "your configured pin is malformed" from "the
    // partner's certificate does not match", or diagnosis will be confusing.
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
  if (pinnedFingerprint === undefined || pinnedFingerprint.length === 0)
    throw new SigningError(
      "no pinned partner fingerprint is configured, so the partner's " +
        "certificate cannot be trusted; obtain the partner's fingerprint " +
        "out-of-band and set signing.partner_fingerprint",
    );
  // Surface the precise reason (degenerate key vs. failed signature) with
  // partner-facing context rather than a single generic message.
  try {
    assertCertificateSelfSignature(certificate);
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
export interface PresentedCertificateCheck {
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
 * Note for that caller: if `pinnedFingerprint` can originate from a non-config
 * source, see the TODO in {@link matchesPinnedFingerprint} -- a malformed pin is
 * currently reported as a generic mismatch and should be distinguished.
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
