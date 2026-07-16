// Regenerates signed-receipt-vectors.json: the cross-implementation known-answer
// vectors for the signed-receipt step. Run from the repo root AFTER building core:
//
//   npm run build -w packages/core
//   node packages/core/test/vectors/generate-signed-receipt-vectors.mjs
//   npm run format
//
// Like generate-exchange-record-vectors.mjs, these vectors ARE the deterministic
// output of the module under test (deriveReceiptBinder, signReceiptContent,
// computeCertificateFingerprint): the cross-implementation guarantee is that any
// implementation, seeded and given the same content and session key, reproduces
// the same binder and signature -- proven by the browser suite reproducing these
// against the web build. This regenerator preserves each vector's hand-authored
// name/seed/identity/sessionKey/role/content and recomputes only the derived
// `expected` block, so a deliberate format change is re-pinned by re-running it and
// reviewing the diff.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  computeCertificateFingerprint,
  deriveReceiptBinder,
  generateSigningIdentity,
  signReceiptContent,
} from "../../dist/core.esm.js";

const fromBase64Url = (s) => new Uint8Array(Buffer.from(s, "base64url"));

const path = fileURLToPath(
  new URL("./signed-receipt-vectors.json", import.meta.url),
);
const data = JSON.parse(readFileSync(path, "utf8"));

for (const vector of data.vectors) {
  const identity = generateSigningIdentity(vector.identity, {
    seed: fromBase64Url(vector.seed),
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
  // whichever role it names. The responder-role binder vector pins a derivation not
  // produced in a live exchange, since both parties fold in the initiator-role
  // binder.) The signature binds the signer's fingerprint and role, so it is made
  // for the vector's own role.
  vector.content.binder = binder;
  const signature = await signReceiptContent(
    identity,
    vector.content,
    vector.role,
  );
  vector.expected = { binder, signature, fingerprint };
}

writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
console.log(`regenerated ${data.vectors.length} signed-receipt vectors`);
