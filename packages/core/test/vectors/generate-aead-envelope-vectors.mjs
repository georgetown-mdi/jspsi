// Regenerates aead-envelope-vectors.json: the known-answer vectors for the
// EncryptedMessageConnection AEAD encrypt path. Run from the repo root:
//
//   node packages/core/test/vectors/generate-aead-envelope-vectors.mjs
//
// The vectors are produced by an INDEPENDENT oracle -- Node's crypto.hkdfSync +
// createCipheriv, a different code path than the decorator's WebCrypto
// crypto.subtle -- so the cross-check in encryptedMessageConnection.test.ts pins
// the decorator against a separate implementation, not against itself. The wire
// format is the binary envelope `version || IV || ciphertext || 16-byte GCM tag`
// specified in docs/spec/CHANNEL_SECURITY.md (no base64url, no JSON wrapper); the
// 1-byte type tag stays inside the authenticated ciphertext.

import { createCipheriv, hkdfSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Must match AEAD_ENVELOPE_VERSION in
// packages/core/src/connection/encryptedMessageConnection.ts.
const ENVELOPE_VERSION = 1;
const TYPE_JSON = 0;
const TYPE_BINARY = 1;
const IV_SEQ_OFFSET = 4;
const INFO_PREFIX = "psilink-aead-v1:";
const SESSION_KEY = Buffer.alloc(32, 0x42);
const SALT = Buffer.alloc(32, 0x00);

const toHex = (bytes) => Buffer.from(bytes).toString("hex");

function deriveKey(context) {
  return Buffer.from(
    hkdfSync("sha256", SESSION_KEY, SALT, INFO_PREFIX + context, 32),
  );
}

function ivFor(sequence) {
  const iv = Buffer.alloc(12);
  iv.writeBigUInt64BE(BigInt(sequence), IV_SEQ_OFFSET);
  return iv;
}

function plaintextFor(spec) {
  if (spec.payloadType === "binary") {
    const payload = Buffer.from(spec.payloadHex, "hex");
    return Buffer.concat([Buffer.from([TYPE_BINARY]), payload]);
  }
  // JSON.stringify with the object's own key order, exactly as the decorator's
  // send() path does before UTF-8 encoding it.
  const json = Buffer.from(JSON.stringify(spec.payloadJson), "utf-8");
  return Buffer.concat([Buffer.from([TYPE_JSON]), json]);
}

function seal(spec) {
  const key = deriveKey(spec.context);
  const iv = ivFor(spec.sequence);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintextFor(spec)),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const envelope = Buffer.concat([
    Buffer.from([ENVELOPE_VERSION]),
    iv,
    ciphertext,
    tag,
  ]);
  const out = {
    name: spec.name,
    description: spec.description,
    role: spec.role,
    context: spec.context,
    sequence: spec.sequence,
    payloadType: spec.payloadType,
  };
  if (spec.payloadType === "binary") out.payloadHex = spec.payloadHex;
  else out.payloadJson = spec.payloadJson;
  out.typeTag = spec.payloadType === "binary" ? TYPE_BINARY : TYPE_JSON;
  out.ivHex = toHex(iv);
  out.ciphertextHex = toHex(ciphertext);
  out.tagHex = toHex(tag);
  out.envelopeHex = toHex(envelope);
  return out;
}

const specs = [
  {
    name: "json-initiator-seq0",
    description:
      "JSON object payload (type tag 0) sealed by the initiator at sequence 0, the first message of a connection: the 8-byte sequence field -- and therefore the whole 12-byte IV -- is all zeros.",
    role: "initiator",
    context: "initiator-to-responder",
    sequence: 0,
    payloadType: "json",
    payloadJson: { hello: "world", n: 42 },
  },
  {
    name: "binary-initiator-seq4328719365",
    description:
      "Uint8Array payload (type tag 1) sealed by the initiator at sequence 0x0102030405, chosen so the 8-byte big-endian sequence field is visible in ivHex.",
    role: "initiator",
    context: "initiator-to-responder",
    sequence: 4328719365,
    payloadType: "binary",
    payloadHex: "deadbeef",
  },
  {
    name: "json-responder-seq1",
    description:
      "JSON object payload (type tag 0) sealed by the responder at sequence 1, exercising the responder-to-initiator send key end to end -- the other directional key, distinct from the initiator vectors above.",
    role: "responder",
    context: "responder-to-initiator",
    sequence: 1,
    payloadType: "json",
    payloadJson: { ack: true },
  },
];

const doc = {
  description:
    "Known-answer vectors for the EncryptedMessageConnection AEAD encrypt path. Each vector fixes (sessionKey, role, sequence, plaintext) and records the exact binary envelope the decorator emits: version || IV || ciphertext || 16-byte GCM tag, carried as raw bytes (no base64url, no JSON wrapper). An independent implementation reproduces envelopeHex from the inputs below. The 1-byte type tag is inside the authenticated ciphertext, not a cleartext field. The wire format is specified in docs/spec/CHANNEL_SECURITY.md; this file is distinct from the deriveAeadKey KAT in encryptedMessageConnection.test.ts, which pins only the key derivation. Regenerate with generate-aead-envelope-vectors.mjs in this directory.",
  cipher: "AES-256-GCM",
  sessionKeyHex: toHex(SESSION_KEY),
  envelopeVersion: ENVELOPE_VERSION,
  envelopeLayout:
    "version (1 byte) || IV (12 bytes) || ciphertext || GCM tag (16 bytes). envelopeHex is the concatenation of versionHex + ivHex + ciphertextHex + tagHex.",
  versionHex: toHex(Buffer.from([ENVELOPE_VERSION])),
  keyDerivation: {
    function: "HKDF-SHA-256",
    saltHex: toHex(SALT),
    infoPrefix: INFO_PREFIX,
    note: "info = infoPrefix + context; the initiator sends under context 'initiator-to-responder'.",
  },
  ivLayout:
    "12 bytes: 4 leading zero bytes (authenticated, not separately validated) followed by an 8-byte big-endian sequence number.",
  typeTags: { json: TYPE_JSON, binary: TYPE_BINARY },
  vectors: specs.map(seal),
};

const outPath = fileURLToPath(
  new URL("./aead-envelope-vectors.json", import.meta.url),
);
writeFileSync(outPath, JSON.stringify(doc, null, 2) + "\n");
console.log(`wrote ${doc.vectors.length} vectors to ${outPath}`);
