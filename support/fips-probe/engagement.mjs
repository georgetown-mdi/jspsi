// The engagement measurement itself, as one module with no output of its own.
//
// Two callers render it: `image-engagement.mjs` beside this file, which is CI's
// gate and prints a full JSON transcript, and the FIPS variant image's
// entrypoint preamble, which runs that gate at every container start and reads
// its exit status. Both run the same legs because they import them from here --
// a measurement kept in two places drifts, and this surface has already been
// bitten by exactly that.
//
// The question: does the environment this runs in serve psilink's own crypto
// calls out of a FIPS provider? It runs in whatever environment it is handed
// and reports what that environment gave it, replacing nothing, so pointing it
// at the FIPS variant image with no arguments and no environment overrides
// measures exactly the arrangement an operator gets. `webcrypto-probe.mjs`
// beside this file answers a harder question -- which configuration channels
// reach Node's bundled OpenSSL at all, and whether engagement survives breaking
// the provider -- by writing its own configurations and spawning children under
// them, which is what makes its verdict attributable and also why it says
// nothing about the configuration an image actually ships: it replaces it.
//
// The legs, and why a shorter check would not do:
//
//   mapped -- fips.so appears in /proc/self/maps. Read AFTER the crypto calls,
//     because provider loading is lazy. `crypto.getFips()` is recorded but
//     decides nothing: it reports the library context's default properties and
//     returns 1 with no module loaded anywhere.
//   the product legs -- an AES-256-GCM round trip, an HKDF-SHA-256 derivation,
//     an HMAC-SHA-256 signature and a SHA-256 digest, each at the parameter
//     shape psilink itself passes. On their own they prove nothing: every one
//     of them succeeds through the default provider too, and looks identical.
//   md5, rsa1024 -- an MD5 digest and an RSA keygen below the FIPS minimum
//     modulus both FAIL in that same process. No FIPS provider serves either,
//     whatever its build, so either one succeeding means the default provider
//     is still reachable and the product legs are unattributable.
//
// ENGAGED requires all of them. The product legs are the ones that decide which
// primitives a "dispatches into the validated module" claim may name, so a leg
// is added here when such a claim is made of a primitive, not the other way
// round.

import { createHash, getFips } from "node:crypto";
import { readFileSync } from "node:fs";

// The parameter shapes psilink's own calls put on the wire:
// packages/core/src/connection/encryptedMessageConnection.ts imports a raw
// 256-bit AES-GCM key and a 12-byte IV, and the four helpers in
// packages/core/src/utils/crypto.ts derive 32 bytes with HKDF-SHA-256 under a
// zero salt, sign with HMAC-SHA-256, and digest with SHA-256.
const AES_KEY_BYTES = 32;
const AES_IV_BYTES = 12;
const AES_PLAINTEXT = "psilink fips image engagement";
const HKDF_IKM_BYTES = 32;
const HKDF_SALT_BYTES = 32;
const HKDF_OUTPUT_BITS = 256;
const HKDF_INFO = "psilink fips image engagement v1";
const HMAC_KEY_BYTES = 32;

const encoder = new TextEncoder();

function describe(error) {
  if (!(error instanceof Error)) return String(error);
  const stack = Array.isArray(error.opensslErrorStack)
    ? ` [openssl: ${error.opensslErrorStack.join(" | ")}]`
    : "";
  return `${error.name}: ${error.message}${stack}`;
}

async function attempt(operation) {
  try {
    await operation();
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: describe(error) };
  }
}

function fipsModuleMapped() {
  try {
    return readFileSync("/proc/self/maps", "utf8").includes("fips.so");
  } catch {
    return false;
  }
}

async function aesGcmRoundTrip() {
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(AES_KEY_BYTES).fill(0x2a),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
  const iv = new Uint8Array(AES_IV_BYTES);
  new DataView(iv.buffer).setBigUint64(4, 1n, false);
  const plaintext = encoder.encode(AES_PLAINTEXT);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintext,
  );
  const decrypted = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext),
  );
  const matched =
    decrypted.length === plaintext.length &&
    decrypted.every((byte, index) => byte === plaintext[index]);
  if (!matched) throw new Error("AES-256-GCM round trip returned other bytes");
}

// The key schedule's own primitive. RFC 5869 builds HKDF out of HMAC, and this
// call names SHA-256, so a provider serving it serves the extract and expand
// steps psilink derives every session key through; the two legs below still run
// separately, because `crypto.subtle` reaches HMAC and SHA-256 through call
// paths of their own that this one does not stand in for.
async function hkdfDeriveBits() {
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(HKDF_IKM_BYTES).fill(0x5c),
    { name: "HKDF" },
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(HKDF_SALT_BYTES),
      info: encoder.encode(HKDF_INFO),
    },
    key,
    HKDF_OUTPUT_BITS,
  );
  if (bits.byteLength !== HKDF_OUTPUT_BITS / 8) {
    throw new Error("HKDF-SHA-256 returned an unexpected output length");
  }
}

async function hmacSha256Sign() {
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(HMAC_KEY_BYTES).fill(0x36),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(AES_PLAINTEXT),
  );
  if (mac.byteLength !== 32) {
    throw new Error("HMAC-SHA-256 returned an unexpected tag length");
  }
}

async function sha256Digest() {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(AES_PLAINTEXT),
  );
  if (digest.byteLength !== 32) {
    throw new Error("SHA-256 returned an unexpected digest length");
  }
}

async function rsaKeygenBelowFipsMinimum() {
  await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 1024,
      publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
      hash: "SHA-256",
    },
    false,
    ["sign", "verify"],
  );
}

async function x25519DeriveBits() {
  const ours = await crypto.subtle.generateKey({ name: "X25519" }, false, [
    "deriveBits",
  ]);
  const theirs = await crypto.subtle.generateKey({ name: "X25519" }, false, [
    "deriveBits",
  ]);
  await crypto.subtle.deriveBits(
    { name: "X25519", public: theirs.publicKey },
    ours.privateKey,
    256,
  );
}

/**
 * Run every leg in this process and return the summary both callers render.
 * Never throws for a leg that fails: a failed leg is the measurement.
 */
export async function measureEngagement() {
  // Each product leg is named as the claim it licenses, because the failure
  // text is what an operator reads off a container that warned at startup.
  const productLegs = [
    ["aes256gcm_round_trip", "the AES-256-GCM round trip", aesGcmRoundTrip],
    ["hkdf_derive_bits", "the HKDF-SHA-256 derivation", hkdfDeriveBits],
    ["hmac_sha256_sign", "the HMAC-SHA-256 signature", hmacSha256Sign],
    ["sha256_digest", "the SHA-256 digest", sha256Digest],
  ];
  const operations = {};
  for (const [key, , operation] of productLegs) {
    operations[key] = await attempt(operation);
  }

  const mapped = fipsModuleMapped();
  operations.md5_digest = await attempt(async () =>
    createHash("md5").update("x").digest(),
  );
  operations.rsa1024_keygen = await attempt(rsaKeygenBelowFipsMinimum);
  // Build-dependent, so it gates nothing: the certified Amazon Linux 2023
  // module carries no X25519, while other FIPS builds do. Recorded because its
  // outcome is what decides whether the SSH key exchange has anything to
  // negotiate.
  operations.x25519_derive_bits = await attempt(x25519DeriveBits);

  const failures = [];
  for (const [key, description] of productLegs) {
    if (operations[key].ok) continue;
    failures.push(
      `${description} failed (${operations[key].error}), so this configuration does not serve psilink's own call`,
    );
  }
  if (!mapped) {
    failures.push(
      "fips.so was not mapped into the process after the crypto calls, so no FIPS provider was loaded",
    );
  }
  for (const [key, description] of [
    ["md5_digest", "an MD5 digest"],
    ["rsa1024_keygen", "an RSA-1024 keygen"],
  ]) {
    if (!operations[key].ok) continue;
    failures.push(
      `${description} succeeded, which no FIPS provider serves: the default provider is still reachable and the successful product calls are not attributable to the FIPS provider`,
    );
  }

  return {
    node_version: process.version,
    node_openssl_version: process.versions.openssl,
    openssl_conf: process.env.OPENSSL_CONF ?? null,
    openssl_modules: process.env.OPENSSL_MODULES ?? null,
    fips_module_version: process.env.FIPS_MODULE_VERSION ?? null,
    fips_module_mapped: mapped,
    get_fips: getFips(),
    operations,
    verdict: failures.length === 0 ? "ENGAGED" : "NOT ENGAGED",
    failures,
  };
}
