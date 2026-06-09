import { readFileSync } from "node:fs";

import { expect, test } from "vitest";
import { x25519 } from "@noble/curves/ed25519.js";

import { runKex, computeKexKeys, noiseHkdf } from "../src/kex";
import { toBase64Url, fromBase64Url } from "../src/utils/crypto";
import {
  createMessagePipe,
  fromEventConnection,
} from "../src/connection/messageConnection";

import { PassthroughConnection } from "./utils/passthroughConnection";

// Generic, non-oracular failure message every authentication failure surfaces.
const GENERIC_FAILURE = "key exchange authentication failed";

// Two distinct 32-byte pre-shared secrets for the matching / mismatching cases.
const PSK_A = new Uint8Array(32).fill(0x42);
const PSK_B = new Uint8Array(32).fill(0x43);

// --- byte helpers ------------------------------------------------------------

function toBytes(u: Uint8Array): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(u);
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));
}

function toHex(u: Uint8Array): string {
  return Array.from(u, (b) => b.toString(16).padStart(2, "0")).join("");
}

function concatBytes(
  ...arrays: Array<Uint8Array<ArrayBuffer>>
): Uint8Array<ArrayBuffer> {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

// One (initiator, responder) flag combination: chaining key and confirm key are
// flag-independent (recorded once under `derived`); the handshake hash, session
// key, and both tags vary per case.
interface KexCase {
  name: string;
  initiatorRequestsEncryption: boolean;
  responderRequestsEncryption: boolean;
  applyEncryption: boolean;
  handshakeHashHex: string;
  sessionKeyHex: string;
  initiatorConfirmHex: string;
  responderConfirmHex: string;
  wire: {
    msg1: { kexMsg: "1"; e: string; reqEnc: boolean };
    msg2: { kexMsg: "2"; e: string; confirm: string; reqEnc: boolean };
    msg3: { kexMsg: "3"; confirm: string };
  };
}

interface KexVectors {
  inputs: {
    pskHex: string;
    initiatorEphemeralPrivateHex: string;
    responderEphemeralPrivateHex: string;
  };
  derived: {
    initiatorEphemeralPublicHex: string;
    responderEphemeralPublicHex: string;
    dhSharedSecretHex: string;
    chainingKeyHex: string;
    confirmKeyHex: string;
  };
  cases: KexCase[];
  externalAnchors: {
    rfc7748Section61: {
      aPriv: string;
      aPub: string;
      bPriv: string;
      bPub: string;
      shared: string;
    };
    rfc5869TestCase3: { ikmHex: string; length: number; okmHex: string };
  };
}

const vectors: KexVectors = JSON.parse(
  readFileSync(new URL("./vectors/kex-vectors.json", import.meta.url), {
    encoding: "utf-8",
  }),
);

// --- Known-answer vector -----------------------------------------------------

test("known-answer vector: computeKexKeys reproduces the session key, confirmation key, and both tags across both flag values", async () => {
  const psk = fromHex(vectors.inputs.pskHex);
  const eInitPriv = fromHex(vectors.inputs.initiatorEphemeralPrivateHex);
  const eRespPriv = fromHex(vectors.inputs.responderEphemeralPrivateHex);
  const eInitPub = toBytes(x25519.getPublicKey(eInitPriv));
  const eRespPub = toBytes(x25519.getPublicKey(eRespPriv));
  expect(toHex(eInitPub)).toBe(vectors.derived.initiatorEphemeralPublicHex);
  expect(toHex(eRespPub)).toBe(vectors.derived.responderEphemeralPublicHex);
  const dh = toBytes(x25519.getSharedSecret(eInitPriv, eRespPub));
  expect(toHex(dh)).toBe(vectors.derived.dhSharedSecretHex);

  // All four (initiator, responder) flag combinations are pinned. The chaining
  // key and confirmation key are flag-independent (the flag MixHashes into h
  // only); the handshake hash, session key, and both tags vary with the flags.
  expect(vectors.cases).toHaveLength(4);
  for (const c of vectors.cases) {
    const k = await computeKexKeys(
      psk,
      eInitPub,
      eRespPub,
      dh,
      c.initiatorRequestsEncryption,
      c.responderRequestsEncryption,
    );
    expect(toHex(k.chainingKey)).toBe(vectors.derived.chainingKeyHex);
    expect(toHex(k.confirmKey)).toBe(vectors.derived.confirmKeyHex);
    expect(toHex(k.handshakeHash)).toBe(c.handshakeHashHex);
    expect(toHex(k.sessionKey)).toBe(c.sessionKeyHex);
    expect(toHex(k.initiatorConfirm)).toBe(c.initiatorConfirmHex);
    expect(toHex(k.responderConfirm)).toBe(c.responderConfirmHex);
  }
});

test("known-answer vector: distinct flag values produce distinct transcripts", () => {
  // Guards the vector file itself: each flag combination yields a distinct
  // handshake hash, so the transcript binding is load-bearing rather than inert.
  const hashes = new Set(vectors.cases.map((c) => c.handshakeHashHex));
  expect(hashes.size).toBe(vectors.cases.length);
});

test("known-answer vector: the wire base64url encodings match", () => {
  for (const c of vectors.cases) {
    expect(
      toBase64Url(fromHex(vectors.derived.initiatorEphemeralPublicHex)),
    ).toBe(c.wire.msg1.e);
    expect(c.wire.msg1.reqEnc).toBe(c.initiatorRequestsEncryption);
    expect(
      toBase64Url(fromHex(vectors.derived.responderEphemeralPublicHex)),
    ).toBe(c.wire.msg2.e);
    expect(toBase64Url(fromHex(c.responderConfirmHex))).toBe(
      c.wire.msg2.confirm,
    );
    expect(c.wire.msg2.reqEnc).toBe(c.responderRequestsEncryption);
    expect(toBase64Url(fromHex(c.initiatorConfirmHex))).toBe(
      c.wire.msg3.confirm,
    );
  }
});

// --- External anchors (the "handshake core" cross-check) ---------------------
//
// The construction is modeled on Noise NNpsk0 and pinned by kex-vectors.json,
// not wire-compatible with generic Noise, so no end-to-end Noise vector
// corresponds. What does correspond is the underlying machinery: the X25519 DH
// and the Noise-style chaining HKDF, anchored here against their published RFC
// vectors.

test("RFC 7748 section 6.1: the X25519 DH reproduces the published vector", () => {
  const a = vectors.externalAnchors.rfc7748Section61;
  expect(toHex(toBytes(x25519.getPublicKey(fromHex(a.aPriv))))).toBe(a.aPub);
  expect(toHex(toBytes(x25519.getPublicKey(fromHex(a.bPriv))))).toBe(a.bPub);
  expect(
    toHex(toBytes(x25519.getSharedSecret(fromHex(a.aPriv), fromHex(a.bPub)))),
  ).toBe(a.shared);
  expect(
    toHex(toBytes(x25519.getSharedSecret(fromHex(a.bPriv), fromHex(a.aPub)))),
  ).toBe(a.shared);
});

test("RFC 5869 test case 3: the Noise chaining HKDF matches standard HKDF", async () => {
  // RFC 5869 TC3 uses an empty salt; HKDF-Extract then substitutes HashLen zero
  // bytes, exactly noiseHkdf's chained salt with a 32-byte zero chaining key.
  const tc = vectors.externalAnchors.rfc5869TestCase3;
  const blocks = await noiseHkdf(new Uint8Array(32), fromHex(tc.ikmHex), 2);
  const okm = concatBytes(...blocks).subarray(0, tc.length);
  expect(toHex(okm)).toBe(tc.okmHex);
});

// --- Handshake over a MessageConnection --------------------------------------

async function runPair(
  pskA: Uint8Array<ArrayBuffer>,
  pskB: Uint8Array<ArrayBuffer>,
  reqEncA = false,
  reqEncB = false,
) {
  const [connA, connB] = createMessagePipe();
  return Promise.allSettled([
    runKex(connA, "initiator", pskA, reqEncA),
    runKex(connB, "responder", pskB, reqEncB),
  ]);
}

test("both sides succeed and derive the same 32-byte session key with a matching secret", async () => {
  const [a, b] = await runPair(PSK_A, PSK_A);
  if (a.status !== "fulfilled" || b.status !== "fulfilled") throw new Error();
  expect(a.value.sessionKey).toBeInstanceOf(Uint8Array);
  expect(a.value.sessionKey.length).toBe(32);
  expect(a.value.sessionKey).toEqual(b.value.sessionKey);
});

test("a mismatched secret fails closed on both sides with the generic error", async () => {
  const [a, b] = await runPair(PSK_A, PSK_B);
  expect(a.status).toBe("rejected");
  expect(b.status).toBe("rejected");
  const msgs = [a, b].map(
    (r) => (r as PromiseRejectedResult).reason.message as string,
  );
  expect(msgs.every((m) => m === GENERIC_FAILURE)).toBe(true);
});

test("forward-secrecy guard: the same secret with different ephemerals yields different session keys", async () => {
  const [a1] = await runPair(PSK_A, PSK_A);
  const [a2] = await runPair(PSK_A, PSK_A);
  if (a1.status !== "fulfilled" || a2.status !== "fulfilled") throw new Error();
  // If the session key were derived from the pre-shared secret alone (no DH
  // mixing) these two runs would collide, silently destroying forward secrecy.
  expect(a1.value.sessionKey).not.toEqual(a2.value.sessionKey);
});

test("the handshake times out if the peer never responds", async () => {
  const eventConn = new PassthroughConnection();
  const conn = fromEventConnection(eventConn, { inactivityTimeoutMs: 20 });
  await expect(runKex(conn, "responder", PSK_A, false)).rejects.toThrow(
    "key exchange handshake timed out",
  );
});

test("runKex rejects when the psk is not 32 bytes", async () => {
  const [connA] = createMessagePipe();
  await expect(
    runKex(connA, "initiator", new Uint8Array(31), false),
  ).rejects.toThrow("psk must be 32 bytes");
});

// --- Abort propagation on malformed peer messages ----------------------------

test("responder sends abort when the initiator's msg1 is malformed", async () => {
  const [connA, connB] = createMessagePipe();
  const responder = runKex(connB, "responder", PSK_A, false);
  responder.catch(() => {});
  // reqEnc is present (a valid boolean) so the schema parses; the failure is the
  // undecodable `e`, exercising the public-key-decode abort path.
  await connA.send({ kexMsg: "1", e: "not-base64url!!", reqEnc: false });
  await expect(responder).rejects.toThrow(GENERIC_FAILURE);
  expect(await connA.receive()).toEqual({ kexMsg: "abort" });
});

test("initiator sends abort when the responder's msg2 is malformed", async () => {
  const [connA, connB] = createMessagePipe();
  const initiator = runKex(connA, "initiator", PSK_A, false);
  initiator.catch(() => {});
  const msg1 = (await connB.receive()) as { kexMsg: string };
  expect(msg1.kexMsg).toBe("1");
  await connB.send({
    kexMsg: "2",
    e: "not-base64url!!",
    confirm: "AA",
    reqEnc: false,
  });
  await expect(initiator).rejects.toThrow(GENERIC_FAILURE);
  expect(await connB.receive()).toEqual({ kexMsg: "abort" });
});

// --- Key-confirmation properties ---------------------------------------------

// Drive a hand-rolled responder that has received msg1, so a test can inject a
// crafted msg2. Returns the parsed msg1, the responder's fresh ephemeral, the
// DH output, and the keys both parties would derive honestly -- binding the
// initiator's flag from msg1 and the chosen responder flag, so the keys match a
// real exchange with those flags.
async function fakeResponderUpToMsg2(
  conn: ReturnType<typeof createMessagePipe>[1],
  psk: Uint8Array<ArrayBuffer>,
  responderReqEnc = false,
) {
  const msg1 = (await conn.receive()) as {
    kexMsg: string;
    e: string;
    reqEnc: boolean;
  };
  expect(msg1.kexMsg).toBe("1");
  const eInitPub = fromBase64Url(msg1.e);
  const eph = x25519.keygen();
  const eRespPub = toBytes(eph.publicKey);
  const dh = toBytes(x25519.getSharedSecret(eph.secretKey, eInitPub));
  const keys = await computeKexKeys(
    psk,
    eInitPub,
    eRespPub,
    dh,
    msg1.reqEnc,
    responderReqEnc,
  );
  return { eInitPub, eRespPub, keys, responderReqEnc };
}

test("a reflected confirmation (the initiator's own role label) does not verify", async () => {
  const [connA, connB] = createMessagePipe();
  const initiator = runKex(connA, "initiator", PSK_A, false);
  initiator.catch(() => {});
  const { eRespPub, keys, responderReqEnc } = await fakeResponderUpToMsg2(
    connB,
    PSK_A,
  );
  // Send the INITIATOR's tag where the responder's tag is expected. Because the
  // two confirm labels are role-asymmetric, this must not verify.
  await connB.send({
    kexMsg: "2",
    e: toBase64Url(eRespPub),
    confirm: toBase64Url(keys.initiatorConfirm),
    reqEnc: responderReqEnc,
  });
  await expect(initiator).rejects.toThrow(GENERIC_FAILURE);
});

test("tampering the responder's public key on the wire breaks confirmation (initiator side)", async () => {
  const [connA, connB] = createMessagePipe();
  const initiator = runKex(connA, "initiator", PSK_A, false);
  initiator.catch(() => {});
  const { eRespPub, keys, responderReqEnc } = await fakeResponderUpToMsg2(
    connB,
    PSK_A,
  );
  // Send a flipped public key but the confirmation computed over the real one:
  // the initiator's transcript hash now differs, so the responder tag mismatches.
  const tampered = Uint8Array.from(eRespPub);
  tampered[0] ^= 0x01;
  await connB.send({
    kexMsg: "2",
    e: toBase64Url(tampered),
    confirm: toBase64Url(keys.responderConfirm),
    reqEnc: responderReqEnc,
  });
  await expect(initiator).rejects.toThrow(GENERIC_FAILURE);
});

test("tampering the initiator's public key breaks confirmation (responder side)", async () => {
  const [connA, connB] = createMessagePipe();
  const responder = runKex(connB, "responder", PSK_A, false);
  responder.catch(() => {});
  // Hand-rolled initiator declaring reqEnc: false on the wire.
  const eph = x25519.keygen();
  const eInitPub = toBytes(eph.publicKey);
  await connA.send({ kexMsg: "1", e: toBase64Url(eInitPub), reqEnc: false });
  const msg2 = (await connA.receive()) as {
    kexMsg: string;
    e: string;
    reqEnc: boolean;
  };
  expect(msg2.kexMsg).toBe("2");
  const eRespPub = fromBase64Url(msg2.e);
  const dh = toBytes(x25519.getSharedSecret(eph.secretKey, eRespPub));
  // Confirm over a flipped e_i (same DH, e_r, and flags): only the initiator
  // public key bound into the transcript differs, so the responder rejects.
  const flipped = Uint8Array.from(eInitPub);
  flipped[0] ^= 0x01;
  const keys = await computeKexKeys(
    PSK_A,
    flipped,
    eRespPub,
    dh,
    false,
    msg2.reqEnc,
  );
  await connA.send({
    kexMsg: "3",
    confirm: toBase64Url(keys.initiatorConfirm),
  });
  await expect(responder).rejects.toThrow(GENERIC_FAILURE);
});

test("a low-order (all-zero) peer share is rejected by the contributory check", async () => {
  const [connA, connB] = createMessagePipe();
  const initiator = runKex(connA, "initiator", PSK_A, false);
  initiator.catch(() => {});
  expect(((await connB.receive()) as { kexMsg: string }).kexMsg).toBe("1");
  await connB.send({
    kexMsg: "2",
    e: toBase64Url(new Uint8Array(32)),
    confirm: toBase64Url(new Uint8Array(32)),
    reqEnc: false,
  });
  await expect(initiator).rejects.toThrow(GENERIC_FAILURE);
  expect(await connB.receive()).toEqual({ kexMsg: "abort" });
});

// --- Request-encryption flag negotiation -------------------------------------

test("both parties derive applyEncryption = own OR peer across all flag combinations", async () => {
  const combos: Array<[boolean, boolean, boolean]> = [
    [false, false, false],
    [true, false, true],
    [false, true, true],
    [true, true, true],
  ];
  for (const [reqA, reqB, expected] of combos) {
    const [a, b] = await runPair(PSK_A, PSK_A, reqA, reqB);
    if (a.status !== "fulfilled" || b.status !== "fulfilled")
      throw new Error(`handshake failed for reqA=${reqA} reqB=${reqB}`);
    // With neither requesting, the decision is unset (no wrap); with either or
    // both requesting, it is set, and both ends agree.
    expect(a.value.applyEncryption).toBe(expected);
    expect(b.value.applyEncryption).toBe(expected);
    // The session key still agrees regardless of the flag values.
    expect(a.value.sessionKey).toEqual(b.value.sessionKey);
  }
});

test("flipping a party's request-encryption flag on the wire fails the handshake closed", async () => {
  // The honest initiator requests encryption (true), but the responder sees a
  // flag flipped to false on the wire. The responder binds the false flag into
  // its transcript; the initiator binds its true flag. Their handshake hashes
  // diverge, so the initiator's confirmation tag (msg3) does not verify and the
  // responder fails closed -- a downgrade cannot proceed with a split decision.
  const [connA, connB] = createMessagePipe();
  const responder = runKex(connB, "responder", PSK_A, false);
  responder.catch(() => {});
  const eph = x25519.keygen();
  const eInitPub = toBytes(eph.publicKey);
  // Tampered-down flag on the wire: the responder receives reqEnc: false.
  await connA.send({ kexMsg: "1", e: toBase64Url(eInitPub), reqEnc: false });
  const msg2 = (await connA.receive()) as {
    kexMsg: string;
    e: string;
    reqEnc: boolean;
  };
  expect(msg2.kexMsg).toBe("2");
  const eRespPub = fromBase64Url(msg2.e);
  const dh = toBytes(x25519.getSharedSecret(eph.secretKey, eRespPub));
  // The honest initiator's transcript binds its true flag; only the wire copy
  // the responder saw was flipped to false, so the two transcripts diverge.
  const keys = await computeKexKeys(
    PSK_A,
    eInitPub,
    eRespPub,
    dh,
    true,
    msg2.reqEnc,
  );
  await connA.send({
    kexMsg: "3",
    confirm: toBase64Url(keys.initiatorConfirm),
  });
  await expect(responder).rejects.toThrow(GENERIC_FAILURE);
});

test("flipping the responder's request-encryption flag on the wire fails the handshake closed (initiator side)", async () => {
  // Symmetric to the msg1 case above, on the msg2 downgrade path. The honest
  // responder requests encryption (true) and computes its confirmation tag over
  // a transcript binding that true flag, but the wire copy the initiator sees is
  // flipped to false. The initiator binds the false flag into its transcript, so
  // the responder's confirmation tag (msg2) does not verify and the initiator
  // fails closed -- a msg2 downgrade cannot proceed with a split decision.
  const [connA, connB] = createMessagePipe();
  const initiator = runKex(connA, "initiator", PSK_A, false);
  initiator.catch(() => {});
  // The hand-rolled responder honestly requests encryption (responderReqEnc:
  // true), so keys.responderConfirm binds reqEnc: true into the transcript.
  const { eRespPub, keys } = await fakeResponderUpToMsg2(connB, PSK_A, true);
  // Only the wire copy is flipped to false: the initiator's transcript binds the
  // false flag, diverging from the responder's, so the tag mismatches.
  await connB.send({
    kexMsg: "2",
    e: toBase64Url(eRespPub),
    confirm: toBase64Url(keys.responderConfirm),
    reqEnc: false,
  });
  await expect(initiator).rejects.toThrow(GENERIC_FAILURE);
});

// The cross-version fail-closed mechanism that stands in for a protocol-version
// bump: a flag-unaware peer omits reqEnc entirely, and the flag-aware peer's
// strict (.strict()) schema rejects the message before any transcript is
// computed -- so a flag-aware and a flag-unaware build cannot silently disagree.

test("a msg1 missing the request-encryption flag is rejected by the strict schema (responder side)", async () => {
  const [connA, connB] = createMessagePipe();
  const responder = runKex(connB, "responder", PSK_A, false);
  responder.catch(() => {});
  const eph = x25519.keygen();
  // A flag-unaware initiator sends msg1 with no reqEnc field.
  await connA.send({ kexMsg: "1", e: toBase64Url(toBytes(eph.publicKey)) });
  await expect(responder).rejects.toThrow(GENERIC_FAILURE);
  expect(await connA.receive()).toEqual({ kexMsg: "abort" });
});

test("a msg2 missing the request-encryption flag is rejected by the strict schema (initiator side)", async () => {
  const [connA, connB] = createMessagePipe();
  const initiator = runKex(connA, "initiator", PSK_A, false);
  initiator.catch(() => {});
  const msg1 = (await connB.receive()) as { kexMsg: string };
  expect(msg1.kexMsg).toBe("1");
  const eph = x25519.keygen();
  // A flag-unaware responder replies with no reqEnc field.
  await connB.send({
    kexMsg: "2",
    e: toBase64Url(toBytes(eph.publicKey)),
    confirm: toBase64Url(new Uint8Array(32)),
  });
  await expect(initiator).rejects.toThrow(GENERIC_FAILURE);
  expect(await connB.receive()).toEqual({ kexMsg: "abort" });
});
