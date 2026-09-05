// Regenerates signing-cert-vectors.json: the cross-implementation vectors for
// the signing certificate and identity file. Run from the repo root AFTER
// building core, with `openssl` on PATH:
//
//   npm run build -w packages/core
//   node packages/core/test/vectors/generate-signing-cert-vectors.mjs
//   npm run format
//
// ECDSA signing is randomized, so a signature is not a known answer and this
// file does not pin one produced by the module under test. What it pins instead:
//
//   - The deterministic anchors -- the public coordinates derived from the fixed
//     private scalar, and the certificate fingerprint, which covers the body and
//     never the signature. Any implementation given the same key and identity
//     reproduces both exactly.
//   - A verify-only self-signature produced by OPENSSL, over signed bytes this
//     script assembles from the spec rather than from the module under test. Two
//     independent things therefore have to agree for the checked-in certificate
//     to parse: the canonical signed-byte layout, and the fixed-length raw r||s
//     signature encoding. Both the Node suite and the browser suite (real
//     Chromium, a different crypto implementation) load these certificates, so
//     the vector is what provides interop with an implementation outside this
//     codebase.
//
// The `domain` labels and body shape below restate docs/spec/PROTOCOL.md by
// design, not import it from signingIdentity.ts: a divergence between the two
// shows up as a checked-in certificate that no longer parses.

import { execFileSync } from "node:child_process";
import { createPrivateKey } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalBytes,
  computeCertificateFingerprint,
  generateSigningIdentity,
} from "../../dist/core.esm.js";

const CERTIFICATE_VERSION = "psilink-signing-cert/v2";
const IDENTITY_VERSION = "psilink-signing-identity/v2";
const ALGORITHM = "ecdsa-p256-sha256";
const SIGNATURE_DOMAIN = "psilink-signing-cert-signature/v1";

const toBase64Url = (bytes) => Buffer.from(bytes).toString("base64url");

/** The certificate body exactly as docs/spec/PROTOCOL.md specifies it. */
function certificateBody(identity, publicKey) {
  return {
    version: CERTIFICATE_VERSION,
    algorithm: ALGORITHM,
    identity,
    publicKey: {
      kty: publicKey.kty,
      crv: publicKey.crv,
      x: publicKey.x,
      y: publicKey.y,
    },
  };
}

function signatureInput(body) {
  return canonicalBytes({ domain: SIGNATURE_DOMAIN, certificate: body });
}

/**
 * Sign `message` with `jwk` by shelling out to the openssl CLI, returning the
 * unpadded base64url raw r||s. openssl emits a DER SEQUENCE of two INTEGERs;
 * `openssl asn1parse` prints them, so the two field elements are read from
 * openssl's own parse rather than from a DER decoder written here.
 */
function signWithOpenssl(jwk, message) {
  const dir = mkdtempSync(join(tmpdir(), "psilink-vectors-"));
  const keyPath = join(dir, "key.pem");
  const msgPath = join(dir, "message.bin");
  const sigPath = join(dir, "signature.der");
  writeFileSync(
    keyPath,
    createPrivateKey({ key: jwk, format: "jwk" }).export({
      type: "pkcs8",
      format: "pem",
    }),
  );
  writeFileSync(msgPath, Buffer.from(message));
  execFileSync("openssl", [
    "dgst",
    "-sha256",
    "-sign",
    keyPath,
    "-out",
    sigPath,
    msgPath,
  ]);
  const parsed = execFileSync("openssl", [
    "asn1parse",
    "-inform",
    "DER",
    "-in",
    sigPath,
  ]).toString();
  const fields = [...parsed.matchAll(/INTEGER\s+:([0-9A-F]+)/g)].map(
    (m) => m[1],
  );
  if (fields.length !== 2)
    throw new Error(
      `expected openssl to emit two INTEGER fields, got ${fields.length}`,
    );
  return toBase64Url(
    Buffer.concat(
      fields.map((hex) => Buffer.from(hex.padStart(64, "0"), "hex")),
    ),
  );
}

const path = fileURLToPath(
  new URL("./signing-cert-vectors.json", import.meta.url),
);
const data = JSON.parse(readFileSync(path, "utf8"));

for (const vector of data.vectors) {
  const identity = await generateSigningIdentity(vector.identity, {
    privateKey: vector.privateKey,
  });
  const publicKey = identity.certificate.publicKey;
  const body = certificateBody(vector.identity, publicKey);
  const signature = signWithOpenssl(vector.privateKey, signatureInput(body));
  const certificate = { ...body, signature };
  vector.expected = {
    publicKeyX: publicKey.x,
    publicKeyY: publicKey.y,
    fingerprint: await computeCertificateFingerprint(body),
  };
  vector.certificate = certificate;
  vector.identityFile = {
    version: IDENTITY_VERSION,
    privateKey: vector.privateKey,
    certificate,
  };
}

data.externalAnchors = {
  signatureProducer: execFileSync("openssl", ["version"]).toString().trim(),
  note:
    "Every checked-in self-signature was produced by the openssl CLI named " +
    "above (openssl dgst -sha256 -sign, DER read back through openssl " +
    "asn1parse and re-encoded as the fixed-length raw r||s), over signed bytes " +
    "this generator assembles from docs/spec/PROTOCOL.md. A suite that parses " +
    "these certificates is therefore accepting a signature produced outside " +
    "this codebase.",
};

writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
console.log(`regenerated ${data.vectors.length} signing-cert vectors`);
