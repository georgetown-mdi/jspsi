// Regenerates signed-receipt-vectors.json: the cross-implementation vectors for
// the signed-receipt step. Run from the repo root AFTER building core, with
// `openssl` on PATH:
//
//   npm run build -w packages/core
//   node packages/core/test/vectors/generate-signed-receipt-vectors.mjs
//   npm run format
//
// ECDSA signing is randomized, so the signature is not the deterministic output
// of the module under test and this file does not pin one. What it pins:
//
//   - The deterministic anchors -- the certificate fingerprint and the
//     per-exchange binder -- which any implementation given the same key,
//     identity, session key, and role reproduces exactly.
//   - A verify-only signature produced by OPENSSL over signed bytes this script
//     assembles from the spec rather than from signedReceipt.ts. Both the Node
//     suite and the browser suite (real Chromium, a different crypto
//     implementation) must accept it, so the vector carries interop with an
//     implementation outside this codebase AND pins the signed-byte layout: a
//     divergence in either shows up as a signature that stops verifying.
//
// This regenerator preserves each vector's hand-authored name, description,
// identity, private key, session key, role, and content, and recomputes the
// binder (which the content carries) and the `expected` block, so a deliberate
// format change is re-pinned by re-running it and reviewing the diff.

import { execFileSync } from "node:child_process";
import { createPrivateKey } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalBytes,
  computeCertificateFingerprint,
  deriveReceiptBinder,
  generateSigningIdentity,
} from "../../dist/core.esm.js";

const CONTENT_DOMAIN = "psilink-signed-receipt-content/v2";

const fromBase64Url = (s) => new Uint8Array(Buffer.from(s, "base64url"));
const toBase64Url = (bytes) => Buffer.from(bytes).toString("base64url");

/** The signer-bound receipt bytes exactly as docs/spec/EXCHANGE_RECORD.md
 * specifies them. */
function receiptSignatureBytes(content, fingerprint, role) {
  return canonicalBytes({
    domain: CONTENT_DOMAIN,
    content: {
      termsHash: content.termsHash,
      initiatorToResponderPayload: content.initiatorToResponderPayload,
      responderToInitiatorPayload: content.responderToInitiatorPayload,
      binder: content.binder,
    },
    signer: { fingerprint, role },
  });
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
  new URL("./signed-receipt-vectors.json", import.meta.url),
);
const data = JSON.parse(readFileSync(path, "utf8"));

for (const vector of data.vectors) {
  const identity = await generateSigningIdentity(vector.identity, {
    privateKey: vector.privateKey,
  });
  const fingerprint = await computeCertificateFingerprint(identity.certificate);
  const binder = await deriveReceiptBinder(
    fromBase64Url(vector.sessionKey),
    vector.role,
  );
  // Keep the vector a realistic receipt: the content's binder IS the derived
  // binder both parties fold in, so the signed content is exactly what the step
  // produces. (The role here is the vector's own role; a real exchange always
  // derives the initiator-role binder, but the vector pins the derivation for
  // whichever role it names. The responder-role binder vector pins a derivation
  // not produced in a live exchange, since both parties fold in the
  // initiator-role binder.) The signature binds the signer's fingerprint and
  // role, so it is made for the vector's own role.
  vector.content.binder = binder;
  const signature = signWithOpenssl(
    vector.privateKey,
    receiptSignatureBytes(vector.content, fingerprint, vector.role),
  );
  vector.expected = { binder, fingerprint, signature };
}

data.externalAnchors = {
  signatureProducer: execFileSync("openssl", ["version"]).toString().trim(),
  note:
    "Every checked-in signature was produced by the openssl CLI named above " +
    "(openssl dgst -sha256 -sign, DER read back through openssl asn1parse and " +
    "re-encoded as the fixed-length raw r||s), over signed bytes this " +
    "generator assembles from docs/spec/EXCHANGE_RECORD.md. A suite that " +
    "verifies them is therefore accepting a signature produced outside this " +
    "codebase, over a byte layout stated independently of signedReceipt.ts.",
};

writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
console.log(`regenerated ${data.vectors.length} signed-receipt vectors`);
