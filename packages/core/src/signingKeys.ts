import { fromBase64Url, toBase64Url } from "./utils/crypto.js";
import { UsageError } from "./errors.js";

// The single path from a stored JWK to a usable ECDSA P-256 key, shared by the
// certificate self-signature (signingIdentity.ts) and the receipt signature
// (signedReceipt.ts) so neither re-implements coordinate decoding, point
// validation, or the signature-length pin. Every signing and verification
// operation in the project runs through crypto.subtle from here, so a validated
// module configured beneath the platform performs all of them.
//
// Why the format is pinned above crypto.subtle rather than delegated to it: the
// certificate body holds the public key as its literal JWK strings, and the
// pinned fingerprint is a hash of those strings. Two different encodings of one
// point would therefore be two different fingerprints for one key. importKey
// admits more than the canonical form -- driven against Node, a coordinate
// holding a 33rd leading zero byte and a base64 (padded) coordinate are both
// accepted and re-decode to the same point -- so the canonical encoding is
// checked here, before import, and importKey is left only the question it
// answers authoritatively: whether the point is on the curve.
//
// Rationale and the FIPS boundary: docs/notes/receipt-signing-fips-boundary.md.
// Normative constructions: docs/spec/PROTOCOL.md.

/** P-256 field element width: the fixed byte length of a JWK `x`, `y`, or `d`
 * (RFC 7518 section 6.2, left-padded to the field size). */
const P256_COORDINATE_BYTES = 32;

/** Byte length of an ECDSA P-256 signature in the fixed-length raw `r || s`
 * encoding (IEEE P1363) that `crypto.subtle` emits and accepts. It is never a
 * DER structure through this call surface, so the length is exact rather than a
 * ceiling, and a field of any other length is rejected rather than decoded. */
export const ECDSA_P256_SIGNATURE_BYTES = 64;

/** Key-import parameters for ECDSA over P-256. */
const ECDSA_P256 = { name: "ECDSA", namedCurve: "P-256" } as const;

/** Sign/verify parameters: ECDSA over P-256 with SHA-256. */
const ECDSA_P256_SHA256 = { name: "ECDSA", hash: "SHA-256" } as const;

/**
 * Thrown for any signing-identity or certificate problem: a malformed or
 * unsupported key/certificate, a failed self-signature, an unpinned or
 * mismatched partner fingerprint, or a receipt identity the certificate does not
 * authorize. Extends {@link UsageError} so the CLI classifies it as a
 * configuration/usage problem (exit 64), consistent with how a malformed key
 * file is handled.
 */
// Exit-code mapping and the deferred trust-error split: docs/spec/PROTOCOL.md,
// Signing identity and certificate pinning.
export class SigningError extends UsageError {
  constructor(message: string) {
    super(message);
    this.name = "SigningError";
  }
}

/** P-256 public key as a JWK (RFC 7518 section 6.2). `x` and `y` are the two
 * 32-byte affine coordinates, unpadded base64url. */
export interface P256PublicJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}

/** P-256 private key as a JWK: the public coordinates plus the 32-byte private
 * scalar `d`, unpadded base64url. As sensitive as any private key; persisted
 * owner-read-only and never shared. */
export interface P256PrivateJwk extends P256PublicJwk {
  d: string;
}

/**
 * Decode one JWK field to its 32 bytes, rejecting anything that is not the
 * canonical unpadded base64url encoding of exactly {@link P256_COORDINATE_BYTES}
 * bytes. `label` names the field in the error so a malformed key is diagnosed
 * precisely rather than as a downstream verification failure.
 *
 * @throws {SigningError}
 */
function decodeCoordinate(
  value: string,
  label: string,
): Uint8Array<ArrayBuffer> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = fromBase64Url(value);
  } catch {
    throw new SigningError(`${label} is not valid base64url`);
  }
  if (bytes.length !== P256_COORDINATE_BYTES)
    throw new SigningError(
      `${label} must be ${P256_COORDINATE_BYTES} bytes, got ${bytes.length}`,
    );
  // fromBase64Url accepts trailing padding and the decoder above accepts a
  // 33-byte value's leading zero, both of which importKey would also admit as
  // the same point under a different string. Requiring the round trip leaves
  // exactly one string per key, which is what the fingerprint pin binds.
  if (toBase64Url(bytes) !== value)
    throw new SigningError(
      `${label} is not the canonical unpadded base64url encoding of ` +
        `${P256_COORDINATE_BYTES} bytes`,
    );
  return bytes;
}

/**
 * Decode and validate an ECDSA P-256 signature field, returning the raw
 * {@link ECDSA_P256_SIGNATURE_BYTES}-byte `r || s`. `label` names the field in
 * the error, and a wrong length is reported with the length seen.
 *
 * @throws {SigningError}
 */
export function decodeEcdsaSignature(
  value: string,
  label: string,
): Uint8Array<ArrayBuffer> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = fromBase64Url(value);
  } catch {
    throw new SigningError(`${label} is not valid base64url`);
  }
  if (bytes.length !== ECDSA_P256_SIGNATURE_BYTES)
    throw new SigningError(
      `${label} must be ${ECDSA_P256_SIGNATURE_BYTES} bytes, got ` +
        `${bytes.length}`,
    );
  return bytes;
}

/**
 * Import a stored P-256 public key for verification. The coordinates are pinned
 * to their canonical form here; point validity -- rejecting a point that is not
 * on the curve, a coordinate at or above the field prime, and the identity,
 * which over a cofactor-1 curve is the whole of the degenerate case -- is
 * `crypto.subtle.importKey`'s. signingIdentity.test.ts drives importKey directly
 * for each of those, so the delegation is measured rather than assumed on the
 * Node platform; the browser suite asserts the same rejections through this
 * function, which measures the outcome on that platform without claiming which
 * layer produced it.
 *
 * @throws {SigningError}
 */
export async function importPublicSigningKey(
  jwk: P256PublicJwk,
  label = "certificate public key",
): Promise<CryptoKey> {
  const x = decodeCoordinate(jwk.x, `${label} coordinate x`);
  const y = decodeCoordinate(jwk.y, `${label} coordinate y`);
  try {
    return await crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x: toBase64Url(x), y: toBase64Url(y) },
      ECDSA_P256,
      false,
      ["verify"],
    );
  } catch (err) {
    throw new SigningError(
      `${label} is not a valid P-256 point: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

/**
 * Import a stored P-256 private key for signing. The key is imported
 * non-extractable, so the imported handle cannot re-export the scalar.
 *
 * A platform may additionally refuse a private scalar that does not belong with
 * the public coordinates stored beside it -- Node does, measured in
 * signingIdentity.test.ts -- but that is not relied on:
 * {@link assertPrivateKeyMatchesPublic} establishes the same property without
 * asking the platform.
 *
 * @throws {SigningError}
 */
export async function importPrivateSigningKey(
  jwk: P256PrivateJwk,
  label = "signing private key",
): Promise<CryptoKey> {
  const x = decodeCoordinate(jwk.x, `${label} coordinate x`);
  const y = decodeCoordinate(jwk.y, `${label} coordinate y`);
  const d = decodeCoordinate(jwk.d, `${label} scalar d`);
  try {
    return await crypto.subtle.importKey(
      "jwk",
      {
        kty: "EC",
        crv: "P-256",
        x: toBase64Url(x),
        y: toBase64Url(y),
        d: toBase64Url(d),
      },
      ECDSA_P256,
      false,
      ["sign"],
    );
  } catch (err) {
    throw new SigningError(
      `${label} is not a valid P-256 private key: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

/**
 * Generate a fresh P-256 signing key and return it as a JWK. The key is
 * generated extractable because a signing identity is persisted to disk and
 * reused for its whole life -- unlike the key exchange's ephemerals, which stay
 * platform handles. The caller writes the result owner-read-only.
 */
export async function generateP256PrivateJwk(): Promise<P256PrivateJwk> {
  const pair = await crypto.subtle.generateKey(ECDSA_P256, true, [
    "sign",
    "verify",
  ]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  if (jwk.x === undefined || jwk.y === undefined || jwk.d === undefined)
    throw new SigningError(
      "the platform generated a P-256 key without full JWK coordinates",
    );
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d };
}

// A fixed, domain-separated probe message for the keypair-agreement check
// below. It is never persisted or sent, and its domain is disjoint from every
// label a certificate or receipt signature covers, so a probe signature could
// not be replayed as either even if one escaped.
const KEYPAIR_PROBE = new TextEncoder().encode(
  "psilink-signing-keypair-probe/v1",
);

/**
 * Assert that a private key and a public key are two halves of one keypair: the
 * coordinates match, and a signature the private key produces verifies under the
 * public key.
 *
 * The signature probe is what makes this platform-independent. Whether
 * `importKey` refuses a JWK whose scalar disagrees with its own coordinates is a
 * per-platform behavior, so an identity file's private-to-certificate binding is
 * established here by using the key rather than by trusting the import to have
 * checked it.
 *
 * @throws {SigningError}
 */
export async function assertPrivateKeyMatchesPublic(
  privateKey: CryptoKey,
  privateJwk: P256PrivateJwk,
  publicJwk: P256PublicJwk,
  message: string,
): Promise<void> {
  if (privateJwk.x !== publicJwk.x || privateJwk.y !== publicJwk.y)
    throw new SigningError(message);
  const verificationKey = await importPublicSigningKey(publicJwk);
  const probe = new Uint8Array(
    await crypto.subtle.sign(ECDSA_P256_SHA256, privateKey, KEYPAIR_PROBE),
  );
  if (
    !(await crypto.subtle.verify(
      ECDSA_P256_SHA256,
      verificationKey,
      probe,
      KEYPAIR_PROBE,
    ))
  )
    throw new SigningError(message);
}

/** Sign `message` with an imported P-256 private key, returning the unpadded
 * base64url raw `r || s` signature. */
export async function signWithP256(
  key: CryptoKey,
  message: Uint8Array<ArrayBuffer>,
): Promise<string> {
  return toBase64Url(
    new Uint8Array(await crypto.subtle.sign(ECDSA_P256_SHA256, key, message)),
  );
}

/** Whether `signature` (raw `r || s` bytes) verifies over `message` under an
 * imported P-256 public key. */
export async function verifyWithP256(
  key: CryptoKey,
  signature: Uint8Array<ArrayBuffer>,
  message: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  return crypto.subtle.verify(ECDSA_P256_SHA256, key, signature, message);
}
