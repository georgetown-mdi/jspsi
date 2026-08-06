#!/usr/bin/env node
// Does an image's OWN shipped configuration engage a FIPS provider?
//
// `webcrypto-probe.mjs` beside this file answers a harder question -- which of
// the configuration channels reaches Node's bundled OpenSSL at all, and whether
// engagement survives breaking the provider -- by writing its own
// configurations and spawning children under them. That is what makes its
// verdict attributable, and it is also why it says nothing about the
// configuration an image actually ships: it replaces it.
//
// This script replaces nothing. It runs in whatever environment it is handed
// and reports what that environment gave it, so pointing it at the FIPS variant
// image with no arguments and no environment overrides measures exactly the
// arrangement an operator gets.
//
// The four legs, and why a shorter check would not do:
//
//   mapped -- fips.so appears in /proc/self/maps. Read AFTER the crypto call,
//     because provider loading is lazy. `crypto.getFips()` is recorded but
//     decides nothing: it reports the library context's default properties and
//     returns 1 with no module loaded anywhere.
//   aes -- an AES-256-GCM round trip through crypto.subtle at the product's own
//     call shape succeeds. On its own this proves nothing: it succeeds through
//     the default provider too, and looks identical.
//   md5, rsa1024 -- an MD5 digest and an RSA keygen below the FIPS minimum
//     modulus both FAIL in that same process. No FIPS provider serves either,
//     whatever its build, so either one succeeding means the default provider
//     is still reachable and the AES success is unattributable.
//
// ENGAGED requires all four. Anything else exits non-zero with the reason, and
// a non-zero exit is a finding here rather than a harness fault -- unlike
// webcrypto-probe.mjs, this script is a gate.

import { createHash, getFips } from "node:crypto";
import { readFileSync } from "node:fs";

// The parameter shape packages/core/src/connection/encryptedMessageConnection.ts
// puts on the wire: a raw-imported 256-bit AES-GCM key and a 12-byte IV.
const AES_KEY_BYTES = 32;
const AES_IV_BYTES = 12;
const AES_PLAINTEXT = "psilink fips image engagement";

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
  const plaintext = new TextEncoder().encode(AES_PLAINTEXT);
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

const aes = await attempt(aesGcmRoundTrip);
const mapped = fipsModuleMapped();
const md5 = await attempt(async () => createHash("md5").update("x").digest());
const rsa1024 = await attempt(rsaKeygenBelowFipsMinimum);
// Build-dependent, so it gates nothing: the certified Amazon Linux 2023 module
// carries no X25519, while other FIPS builds do. Recorded because its outcome
// is what decides whether the SSH key exchange has anything to negotiate.
const x25519 = await attempt(x25519DeriveBits);

const failures = [];
if (!aes.ok) {
  failures.push(
    `the AES-256-GCM round trip failed (${aes.error}), so this configuration does not serve the product's own AEAD call`,
  );
}
if (!mapped) {
  failures.push(
    "fips.so was not mapped into the process after the crypto call, so no FIPS provider was loaded",
  );
}
for (const [name, control] of [
  ["an MD5 digest", md5],
  ["an RSA-1024 keygen", rsa1024],
]) {
  if (control.ok) {
    failures.push(
      `${name} succeeded, which no FIPS provider serves: the default provider is still reachable and the AES-256-GCM success is not attributable to the FIPS provider`,
    );
  }
}

const summary = {
  node_version: process.version,
  node_openssl_version: process.versions.openssl,
  openssl_conf: process.env.OPENSSL_CONF ?? null,
  openssl_modules: process.env.OPENSSL_MODULES ?? null,
  fips_module_mapped: mapped,
  get_fips: getFips(),
  operations: {
    aes256gcm_round_trip: aes,
    md5_digest: md5,
    rsa1024_keygen: rsa1024,
    x25519_derive_bits: x25519,
  },
  verdict: failures.length === 0 ? "ENGAGED" : "NOT ENGAGED",
  failures,
};

console.log(`IMAGE_ENGAGEMENT_JSON: ${JSON.stringify(summary)}`);
for (const failure of failures) console.log(`- ${failure}`);
console.log(`IMAGE ENGAGEMENT VERDICT: ${summary.verdict}`);
process.exit(failures.length === 0 ? 0 : 1);
