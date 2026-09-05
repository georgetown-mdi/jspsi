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
//     implementation) must accept it, so the vector provides interop with an
//     implementation outside this codebase AND pins the signed-byte layout: a
//     divergence in either shows up as a signature that stops verifying.
//   - A whole dual-signed record assembled from the two vectors, every signature
//     in it (both certificate self-signatures and both receipt signatures) made
//     by openssl, for the verification consumer to check end to end.
//
// This regenerator preserves each vector's hand-authored name, description,
// identity, private key, session key, role, and content, and recomputes the
// binder (which the content holds) and the `expected` block, so a by-design
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

const RECORD_VERSION = "psilink-signed-receipt/v2";
const CONTENT_DOMAIN = "psilink-signed-receipt-content/v2";
const CERTIFICATE_VERSION = "psilink-signing-cert/v2";
const CERTIFICATE_SIGNATURE_DOMAIN = "psilink-signing-cert-signature/v1";
const ALGORITHM = "ecdsa-p256-sha256";

const fromBase64Url = (s) => new Uint8Array(Buffer.from(s, "base64url"));
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

function certificateSignatureBytes(body) {
  return canonicalBytes({
    domain: CERTIFICATE_SIGNATURE_DOMAIN,
    certificate: body,
  });
}

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
  // Keep the vector a realistic receipt: the content's binder is the derived
  // binder both parties fold in, so the signed content matches what the step
  // produces. A real exchange always derives the initiator-role binder; this
  // vector derives it for whichever role it names, so the responder-role
  // vector's binder is not one a live exchange produces. The signature binds
  // the signer's fingerprint and role, made for the vector's own role.
  vector.content.binder = binder;
  const signature = signWithOpenssl(
    vector.privateKey,
    receiptSignatureBytes(vector.content, fingerprint, vector.role),
  );
  vector.expected = { binder, fingerprint, signature };
}

// The whole dual-signed record, assembled from the two vectors above: both
// parties sign ONE shared content (holding the initiator-role binder, as a live
// exchange does), and every signature in it -- each certificate's self-signature
// and each party's receipt signature -- comes from openssl. The verification
// consumer therefore has a bundle no part of which this codebase signed.
const [initiatorVector, responderVector] = data.vectors;
if (
  initiatorVector.role !== "initiator" ||
  responderVector.role !== "responder"
)
  throw new Error(
    "the bundle is assembled from an initiator vector followed by a responder " +
      "vector; reorder data.vectors or update this script",
  );
if (initiatorVector.sessionKey !== responderVector.sessionKey)
  throw new Error(
    "the bundle's two parties must share one session key, as the two parties " +
      "of one exchange do",
  );

const bundleContent = {
  termsHash: initiatorVector.content.termsHash,
  initiatorToResponderPayload:
    initiatorVector.content.initiatorToResponderPayload,
  responderToInitiatorPayload:
    initiatorVector.content.responderToInitiatorPayload,
  // Both parties fold in the INITIATOR-role binder, whatever their own role.
  binder: await deriveReceiptBinder(
    fromBase64Url(initiatorVector.sessionKey),
    "initiator",
  ),
};

async function bundleParty(vector, role) {
  const generated = await generateSigningIdentity(vector.identity, {
    privateKey: vector.privateKey,
  });
  const body = certificateBody(
    vector.identity,
    generated.certificate.publicKey,
  );
  const certificate = {
    ...body,
    signature: signWithOpenssl(
      vector.privateKey,
      certificateSignatureBytes(body),
    ),
  };
  const fingerprint = await computeCertificateFingerprint(body);
  return {
    fingerprint,
    party: {
      certificate,
      signature: signWithOpenssl(
        vector.privateKey,
        receiptSignatureBytes(bundleContent, fingerprint, role),
      ),
    },
  };
}

const initiatorParty = await bundleParty(initiatorVector, "initiator");
const responderParty = await bundleParty(responderVector, "responder");
data.bundle = {
  description: data.bundle.description,
  expected: {
    initiatorFingerprint: initiatorParty.fingerprint,
    responderFingerprint: responderParty.fingerprint,
    initiatorIdentity: initiatorVector.identity,
    responderIdentity: responderVector.identity,
  },
  record: {
    version: RECORD_VERSION,
    content: bundleContent,
    initiator: initiatorParty.party,
    responder: responderParty.party,
  },
};

data.externalAnchors = {
  signatureProducer: execFileSync("openssl", ["version"]).toString().trim(),
  note:
    "Every checked-in signature was produced by the openssl CLI named above " +
    "(openssl dgst -sha256 -sign, DER read back through openssl asn1parse and " +
    "re-encoded as the fixed-length raw r||s), over signed bytes this " +
    "generator assembles from docs/spec/EXCHANGE_RECORD.md. A suite that " +
    "verifies them is therefore accepting a signature produced outside this " +
    "codebase, over a byte layout stated independently of signedReceipt.ts. " +
    "The same holds for every signature in the assembled bundle.",
};

writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
console.log(
  `regenerated ${data.vectors.length} signed-receipt vectors and the bundle`,
);
