// Independent generator for test/vectors/kex-vectors.json.
//
// This reimplements the psilink-kex-v1 key schedule from scratch using Node's
// OpenSSL-backed `crypto` (createHash/createHmac/hkdfSync) -- a different code
// path from the module under test, which uses WebCrypto (crypto.subtle). The
// module's kex.test.ts asserts computeKexKeys reproduces the vectors this
// produces, so agreement is a genuine cross-implementation check of the
// composition, not a self-test. It also re-checks the external anchors the
// "handshake core" corresponds to: RFC 7748 section 6.1 (X25519) and RFC 5869
// test case 3 (the Noise-style chaining HKDF).
//
// The handshake carries a per-party request-encryption flag, bound into the
// transcript as a single byte MixHash'd as each message's handshake payload. The
// vectors below cover all four (initiator, responder) flag combinations so both
// flag values are pinned at each position; the chaining key and confirmation key
// are flag-independent (the flag enters h only, via MixHash) and are recorded
// once.
//
// Run:  node packages/core/test/vectors/generate-kex-vectors.mjs
// It prints the JSON to stdout; redirect into kex-vectors.json to refresh.

import { createHash, createHmac, hkdfSync } from "node:crypto";
import { x25519 } from "@noble/curves/ed25519.js";

const PROTOCOL_NAME = "psilink-kex-v1:NNpsk0_25519_SHA256";
const SESSION_LABEL = "psilink-kex-v1:session";
const CONFIRM_KEY_LABEL = "psilink-kex-v1:confirm";
const INITIATOR_CONFIRM_LABEL = "psilink-kex-v1:initiator-confirm";
const RESPONDER_CONFIRM_LABEL = "psilink-kex-v1:responder-confirm";

const hex = (b) => Buffer.from(b).toString("hex");
const fromHex = (s) => Buffer.from(s, "hex");
const b64url = (b) => Buffer.from(b).toString("base64url");
const sha256 = (d) => createHash("sha256").update(d).digest();
const hmac = (k, d) => createHmac("sha256", k).update(d).digest();
// Canonical single-byte encoding of a request-encryption flag for the transcript.
const flagByte = (requested) => Buffer.from([requested ? 1 : 0]);
// Mirrors utils/crypto.ts hkdfDerive: HKDF-SHA-256, 32-byte zero salt, named info.
const hkdfApp = (ikm, info, len) =>
  Buffer.from(
    hkdfSync("sha256", ikm, Buffer.alloc(32), Buffer.from(info, "utf8"), len),
  );

// Noise chaining HKDF (rev 34 section 4.3): salt = ck, empty info, counter expand.
function noiseHkdf(ck, ikm, n) {
  const tempKey = hmac(ck, ikm);
  const o1 = hmac(tempKey, Buffer.from([1]));
  const o2 = hmac(tempKey, Buffer.concat([o1, Buffer.from([2])]));
  if (n === 2) return [o1, o2];
  const o3 = hmac(tempKey, Buffer.concat([o2, Buffer.from([3])]));
  return [o1, o2, o3];
}

function computeKexKeys(psk, eInitPub, eRespPub, dh, iReq, rReq) {
  let h = sha256(Buffer.from(PROTOCOL_NAME, "utf8"));
  let ck = h;
  h = sha256(Buffer.concat([h, Buffer.alloc(0)])); // mixHash(empty prologue)
  {
    const [o1, o2] = noiseHkdf(ck, psk, 3); // mixKeyAndHash(psk)
    ck = o1;
    h = sha256(Buffer.concat([h, o2]));
  }
  // PSK mode: each `e` token is MixHash + MixKey (Noise rev 34 section 9.2). Each
  // party's request-encryption flag is MixHash'd as that message's payload, right
  // after its `e` token (MixHash only -- the flag need not be confidential, and
  // entering h alone leaves ck and the confirm key flag-independent).
  h = sha256(Buffer.concat([h, eInitPub])); // mixHash(initiator e)
  ck = noiseHkdf(ck, eInitPub, 2)[0]; // mixKey(initiator e)
  h = sha256(Buffer.concat([h, flagByte(iReq)])); // mixHash(initiator flag): msg1 payload
  h = sha256(Buffer.concat([h, eRespPub])); // mixHash(responder e)
  ck = noiseHkdf(ck, eRespPub, 2)[0]; // mixKey(responder e)
  h = sha256(Buffer.concat([h, flagByte(rReq)])); // mixHash(responder flag): msg2 payload
  {
    const [o1] = noiseHkdf(ck, dh, 2); // mixKey(ee)
    ck = o1;
  }
  const master = Buffer.concat([ck, h]);
  const sessionKey = hkdfApp(master, SESSION_LABEL, 32);
  const confirmKey = hkdfApp(ck, CONFIRM_KEY_LABEL, 32);
  const initiatorConfirm = hmac(
    confirmKey,
    Buffer.concat([Buffer.from(INITIATOR_CONFIRM_LABEL, "utf8"), h]),
  );
  const responderConfirm = hmac(
    confirmKey,
    Buffer.concat([Buffer.from(RESPONDER_CONFIRM_LABEL, "utf8"), h]),
  );
  return { ck, h, sessionKey, confirmKey, initiatorConfirm, responderConfirm };
}

// --- External anchors --------------------------------------------------------

// RFC 7748 section 6.1 (X25519 Diffie-Hellman test vector).
const RFC7748 = {
  aPriv: "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a",
  aPub: "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a",
  bPriv: "5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb",
  bPub: "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f",
  shared: "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742",
};
const okPub =
  hex(x25519.getPublicKey(fromHex(RFC7748.aPriv))) === RFC7748.aPub &&
  hex(x25519.getPublicKey(fromHex(RFC7748.bPriv))) === RFC7748.bPub;
const okShared =
  hex(x25519.getSharedSecret(fromHex(RFC7748.aPriv), fromHex(RFC7748.bPub))) ===
    RFC7748.shared &&
  hex(x25519.getSharedSecret(fromHex(RFC7748.bPriv), fromHex(RFC7748.aPub))) ===
    RFC7748.shared;
if (!okPub || !okShared) throw new Error("RFC 7748 self-check failed");

// RFC 5869 test case 3 (HKDF-SHA-256, empty salt and info). With empty salt,
// HKDF-Extract uses HashLen zero bytes, exactly noiseHkdf's salt=ck with a
// 32-byte zero ck. So noiseHkdf(zeros, ikm, 2) sliced to 42 bytes == TC3 OKM.
const TC3 = {
  ikm: "0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b",
  okm: "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8",
};
const tc3Out = Buffer.concat(
  noiseHkdf(Buffer.alloc(32), fromHex(TC3.ikm), 2),
).subarray(0, 42);
if (hex(tc3Out) !== TC3.okm) throw new Error("RFC 5869 TC3 self-check failed");

// --- Known-answer vectors ----------------------------------------------------

const psk = Buffer.alloc(32, 0x42);
const eInitPriv = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1));
const eRespPriv = Buffer.from(Array.from({ length: 32 }, (_, i) => 0xff - i));
const eInitPub = x25519.getPublicKey(eInitPriv);
const eRespPub = x25519.getPublicKey(eRespPriv);
const dh = x25519.getSharedSecret(eInitPriv, eRespPub);
const dhCheck = x25519.getSharedSecret(eRespPriv, eInitPub);
if (hex(dh) !== hex(dhCheck)) throw new Error("DH disagreement");

// All four (initiator, responder) request-encryption combinations, so both flag
// values are pinned at each position. applyEncryption is the OR both parties agree on.
const FLAG_CASES = [
  { name: "neither-requests", initiator: false, responder: false },
  { name: "initiator-only", initiator: true, responder: false },
  { name: "responder-only", initiator: false, responder: true },
  { name: "both-request", initiator: true, responder: true },
];

const computed = FLAG_CASES.map((c) => ({
  c,
  k: computeKexKeys(psk, eInitPub, eRespPub, dh, c.initiator, c.responder),
}));

// The flag enters h only (MixHash), so the chaining key and the confirmation key
// derived from it are flag-independent. Assert that here and record them once.
const chainingKeyHex = hex(computed[0].k.ck);
const confirmKeyHex = hex(computed[0].k.confirmKey);
for (const { k } of computed) {
  if (hex(k.ck) !== chainingKeyHex || hex(k.confirmKey) !== confirmKeyHex)
    throw new Error(
      "request-encryption flag perturbed ck or confirmKey; it must MixHash into h only",
    );
}

const cases = computed.map(({ c, k }) => ({
  name: c.name,
  initiatorRequestsEncryption: c.initiator,
  responderRequestsEncryption: c.responder,
  applyEncryption: c.initiator || c.responder,
  handshakeHashHex: hex(k.h),
  sessionKeyHex: hex(k.sessionKey),
  initiatorConfirmHex: hex(k.initiatorConfirm),
  responderConfirmHex: hex(k.responderConfirm),
  wire: {
    msg1: { kexMsg: "1", e: b64url(eInitPub), reqEnc: c.initiator },
    msg2: {
      kexMsg: "2",
      e: b64url(eRespPub),
      confirm: b64url(k.responderConfirm),
      reqEnc: c.responder,
    },
    msg3: { kexMsg: "3", confirm: b64url(k.initiatorConfirm) },
  },
}));

const vector = {
  description:
    "Known-answer vectors for the psilink-kex-v1 X25519 authenticated key " +
    "exchange (Noise NNpsk0 over X25519 + explicit role-asymmetric key " +
    "confirmation + a per-party request-encryption flag bound into the " +
    "transcript). Fixes the pre-shared secret and both ephemeral X25519 private " +
    "keys, and records, for all four (initiator, responder) flag combinations, " +
    "the handshake hash, session key, and both confirmation tags. computeKexKeys " +
    "in packages/core/src/kex.ts reproduces them from these inputs; kex.test.ts " +
    "checks it. The chaining key and confirmation key are flag-independent (the " +
    "flag is MixHash'd into h only) and recorded once under derived. The " +
    "key-schedule mix chain is faithful Noise NNpsk0 (PSK mode: each e token is " +
    "MixHash + MixKey; each message's flag is the MixHash'd handshake payload), " +
    "but the overall handshake is pinned by this file and is NOT wire-compatible " +
    "with generic Noise: the protocol name differs (so the initial h differs) " +
    "and, instead of Noise Split(), the session key uses a custom KDF over ck||h " +
    "with an added explicit confirmation round. So no end-to-end Noise vector " +
    "corresponds. What does correspond is checked separately: the X25519 DH " +
    "against RFC 7748 section 6.1 and the Noise-style chaining HKDF against RFC " +
    "5869 test case 3 (see external_anchors and kex.test.ts).",
  construction: {
    pattern: "Noise NNpsk0 over X25519",
    protocolName: PROTOCOL_NAME,
    hash: "SHA-256",
    dh: "X25519 (RFC 7748)",
    kdf: "HKDF-SHA-256",
    sessionLabel: SESSION_LABEL,
    confirmKeyLabel: CONFIRM_KEY_LABEL,
    initiatorConfirmLabel: INITIATOR_CONFIRM_LABEL,
    responderConfirmLabel: RESPONDER_CONFIRM_LABEL,
    requestEncryptionFlag:
      "Single byte (0x01 if the party requests the additional " +
      "application-encryption layer, else 0x00), MixHash'd as that message's " +
      "handshake payload right after the party's e token. MixHash only.",
    note:
      "h0 = SHA-256(protocolName); ck0 = h0. Tokens (PSK mode -- each e is " +
      "MixHash then MixKey; each flag is MixHash'd as the message payload): " +
      "MixHash(''), MixKeyAndHash(psk), MixHash(eInitiatorPub), " +
      "MixKey(eInitiatorPub), MixHash(initiatorFlagByte), MixHash(eResponderPub), " +
      "MixKey(eResponderPub), MixHash(responderFlagByte), MixKey(dh). sessionKey " +
      "= HKDF(ck||h, sessionLabel, 32); confirmKey = HKDF(ck, confirmKeyLabel, " +
      "32); confirm tags = HMAC(confirmKey, label||h).",
  },
  inputs: {
    pskHex: hex(psk),
    initiatorEphemeralPrivateHex: hex(eInitPriv),
    responderEphemeralPrivateHex: hex(eRespPriv),
  },
  derived: {
    initiatorEphemeralPublicHex: hex(eInitPub),
    responderEphemeralPublicHex: hex(eRespPub),
    dhSharedSecretHex: hex(dh),
    chainingKeyHex,
    confirmKeyHex,
  },
  cases,
  externalAnchors: {
    note:
      "The externally-published references the handshake core corresponds to. " +
      "Verified in this generator and re-verified in kex.test.ts.",
    rfc7748Section61: RFC7748,
    rfc5869TestCase3: {
      hash: "SHA-256",
      ikmHex: TC3.ikm,
      saltHex: "",
      infoHex: "",
      length: 42,
      okmHex: TC3.okm,
      note:
        "noiseHkdf(ck = 32 zero bytes, ikm, 2) truncated to 42 bytes equals " +
        "this OKM, anchoring the Noise chaining HKDF to standard HKDF.",
    },
  },
};

process.stdout.write(JSON.stringify(vector, null, 2) + "\n");
