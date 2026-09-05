// Independent generator for test/vectors/kex-vectors.json.
//
// Reimplements the psilink-kex-v2 key schedule from scratch using Node's
// OpenSSL-backed `crypto` (createHash/createHmac/hkdfSync/createECDH) -- a
// different code path from the module under test, which uses WebCrypto
// (crypto.subtle). kex.test.ts asserts computeKexKeys reproduces these
// vectors. The Noise chaining HKDF is written here as the literal HMAC chain
// from the Noise definition; the module issues a single HKDF deriveBits
// call, and the two must agree byte for byte.
//
// It also re-checks the external anchors the "handshake core" corresponds to:
// the P-256 scalar multiplication and ECDH (RFC 6979 section A.2.5's key pair
// over the SP 800-186 section 3.2.1.3 base point) and RFC 5869 test case 3 (the
// Noise-style chaining HKDF).
//
// The handshake includes a per-party request-encryption flag, bound into the
// transcript as a single byte MixHash'd as each message's handshake payload. The
// vectors below cover all four (initiator, responder) flag combinations so both
// flag values are pinned at each position; the chaining key and confirmation key
// are flag-independent (the flag enters h only, via MixHash) and are recorded
// once.
//
// Run:  node packages/core/test/vectors/generate-kex-vectors.mjs
// It prints the JSON to stdout; redirect into kex-vectors.json to refresh,
// then run `npm run format`.

import { createECDH, createHash, createHmac, hkdfSync } from "node:crypto";

const PROTOCOL_NAME = "psilink-kex-v2:NNpsk0_P256_SHA256";
const SESSION_LABEL = "psilink-kex-v1:session";
const CONFIRM_KEY_LABEL = "psilink-kex-v1:confirm";
const INITIATOR_CONFIRM_LABEL = "psilink-kex-v1:initiator-confirm";
const RESPONDER_CONFIRM_LABEL = "psilink-kex-v1:responder-confirm";

// The pinned wire encoding: SEC1 uncompressed, 0x04 || X || Y.
const CURVE = "prime256v1";
const POINT_LEN = 65;
const UNCOMPRESSED_PREFIX = 0x04;

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

function ecdhFor(privateKeyHex) {
  const e = createECDH(CURVE);
  e.setPrivateKey(fromHex(privateKeyHex));
  return e;
}

// Noise chaining HKDF (rev 34 section 4.3): salt = ck, empty info, counter
// expand. Written as the literal HMAC chain the Noise definition specifies, so
// the module's single deriveBits call is checked against the definition rather
// than against itself.
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

// P-256 scalar multiplication and ECDH, anchored entirely on published values.
// The base point G is the one published for P-256 in SP 800-186 section
// 3.2.1.3 (FIPS 186-5 publishes no curve parameters of its own; it refers the
// recommended curves there); the private key d and its public point U are RFC
// 6979 section A.2.5's P-256 key pair. The ECDH shared secret over this curve
// is the X coordinate of the shared point, so both agreements below land on the
// published Ux:
//
//   ECDH(d, G) = X(d*G) = Ux    the scalar multiplication that turns a private
//                               key into a public one
//   ECDH(1, U) = X(1*U) = Ux    the peer-share half, with G as the private key
//
// A wrong curve, a wrong base point, or a wrong shared-secret convention breaks
// both.
const P256_ANCHOR = {
  generatorXHex:
    "6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296",
  generatorYHex:
    "4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5",
  privateKeyHex:
    "c9afa9d845ba75166b5c215767b1d6934e50c3db36e89b127b8a622b120f6721",
  publicKeyXHex:
    "60fed4ba255a9d31c961eb74c6356d68c049b8923b61fa6ce669622e60f29fb6",
  publicKeyYHex:
    "7903fe1008b8bc99a41ae9e95628bc64f2f1b20c2d7e9f5177a3c294d4462299",
};
const generatorPoint = fromHex(
  "04" + P256_ANCHOR.generatorXHex + P256_ANCHOR.generatorYHex,
);
const anchorPublicPoint = fromHex(
  "04" + P256_ANCHOR.publicKeyXHex + P256_ANCHOR.publicKeyYHex,
);
const anchorKey = ecdhFor(P256_ANCHOR.privateKeyHex);
if (hex(anchorKey.getPublicKey()) !== hex(anchorPublicPoint))
  throw new Error("RFC 6979 A.2.5 public-key self-check failed");
if (
  hex(anchorKey.computeSecret(generatorPoint)) !== P256_ANCHOR.publicKeyXHex ||
  hex(ecdhFor("1".padStart(64, "0")).computeSecret(anchorPublicPoint)) !==
    P256_ANCHOR.publicKeyXHex
)
  throw new Error("P-256 ECDH anchor self-check failed");

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
const eInit = ecdhFor(hex(eInitPriv));
const eResp = ecdhFor(hex(eRespPriv));
const eInitPub = eInit.getPublicKey();
const eRespPub = eResp.getPublicKey();
if (eInitPub.length !== POINT_LEN || eRespPub.length !== POINT_LEN)
  throw new Error("ephemeral public key is not a 65-byte point");
if (eInitPub[0] !== UNCOMPRESSED_PREFIX || eRespPub[0] !== UNCOMPRESSED_PREFIX)
  throw new Error("ephemeral public key is not uncompressed-prefixed");
const dh = eInit.computeSecret(eRespPub);
const dhCheck = eResp.computeSecret(eInitPub);
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
    "Known-answer vectors for the psilink-kex-v2 P-256 authenticated key " +
    "exchange (Noise NNpsk0 over P-256 ECDH + explicit role-asymmetric key " +
    "confirmation + a per-party request-encryption flag bound into the " +
    "transcript). Fixes the pre-shared secret and both ephemeral P-256 private " +
    "keys, and records, for all four (initiator, responder) flag combinations, " +
    "the handshake hash, session key, and both confirmation tags. computeKexKeys " +
    "in packages/core/src/kex.ts reproduces them from these inputs; kex.test.ts " +
    "checks that on Node and apps/web's browser suite checks the same file " +
    "against the browser build in real Chromium. The chaining key and " +
    "confirmation key are flag-independent (the flag is MixHash'd into h only) " +
    "and recorded once under derived. The key-schedule mix chain is faithful " +
    "Noise NNpsk0 (PSK mode: each e token is MixHash + MixKey; each message's " +
    "flag is the MixHash'd handshake payload), but the overall handshake is " +
    "pinned by this file and is NOT wire-compatible with generic Noise: the " +
    "protocol name differs (so the initial h differs) and, instead of Noise " +
    "Split(), the session key uses a custom KDF over ck||h with an added " +
    "explicit confirmation round. So no end-to-end Noise vector corresponds. " +
    "What does correspond is checked separately: the P-256 scalar " +
    "multiplication and ECDH against published values, and the Noise-style " +
    "chaining HKDF against RFC 5869 test case 3 (see externalAnchors and " +
    "kex.test.ts).",
  construction: {
    pattern: "Noise NNpsk0 over P-256",
    protocolName: PROTOCOL_NAME,
    hash: "SHA-256",
    dh:
      "P-256 ECDH: the shared-secret computation of SP 800-56A Rev 3 section " +
      "5.7.1.2, over the curve parameters of SP 800-186 section 3.2.1.3. " +
      "ephemeralUnified is the label CMVP certificate 5021's KAS-ECC-SSC row " +
      "carries for the section 6.1.2.2 scheme built on that computation, not " +
      "that publication's name for the computation itself.",
    pointEncoding:
      "SEC1 uncompressed, 0x04 || X || Y, 65 bytes. Pinned: a share in any " +
      "other encoding of the same point (compressed 0x02/0x03 || X, hybrid " +
      "0x06/0x07 || X || Y) is rejected rather than decoded.",
    sharedSecret:
      "The 32-byte X coordinate of the shared point (SP 800-56A Rev 3 Z), " +
      "which is what crypto.subtle deriveBits returns for ECDH over P-256.",
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
    p256ScalarMultiplicationAndEcdh: {
      curve: "P-256",
      ...P256_ANCHOR,
      sharedSecretHex: P256_ANCHOR.publicKeyXHex,
      note:
        "generatorXHex/generatorYHex are the P-256 base point published in " +
        "SP 800-186 section 3.2.1.3; privateKeyHex with publicKeyXHex/" +
        "publicKeyYHex is RFC 6979 section A.2.5's P-256 key pair. " +
        "ECDH(privateKey, generator) and ECDH(1, publicKey) both equal " +
        "sharedSecretHex, which is publicKeyXHex, because the ECDH shared " +
        "secret over this curve is the X coordinate of the shared point.",
    },
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
