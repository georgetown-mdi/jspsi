import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import { runKex, computeKexKeys, noiseHkdf } from "../src/kex";
import {
  toBase64Url,
  fromBase64Url,
  hkdfDerive,
  hmacSha256,
  sha256,
} from "../src/utils/crypto";
import { isPeerWaitTimeout } from "../src/errors";
import {
  ConnectionError,
  createMessagePipe,
  fromEventConnection,
} from "../src/connection/messageConnection";

import { PassthroughConnection } from "./utils/passthroughConnection";

// Generic, non-oracular failure message every authentication failure raises.
const GENERIC_FAILURE = "key exchange authentication failed";

// Two distinct 32-byte pre-shared secrets for the matching / mismatching cases.
const PSK_A = new Uint8Array(32).fill(0x42);
const PSK_B = new Uint8Array(32).fill(0x43);

const ECDH_P256 = { name: "ECDH", namedCurve: "P-256" } as const;

// --- byte helpers ------------------------------------------------------------

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

// --- P-256 helpers -----------------------------------------------------------

/** A fresh ephemeral pair, mirroring what runKex generates internally. */
async function generateEphemeral(): Promise<{
  privateKey: CryptoKey;
  publicKey: Uint8Array<ArrayBuffer>;
}> {
  const pair = await crypto.subtle.generateKey(ECDH_P256, false, [
    "deriveBits",
  ]);
  return {
    privateKey: pair.privateKey,
    publicKey: new Uint8Array(
      await crypto.subtle.exportKey("raw", pair.publicKey),
    ),
  };
}

/**
 * Import a fixed private key from the vectors. The public coordinates come from
 * the same vector file, and WebCrypto rejects a JWK whose coordinates are not
 * the scalar's actual public point -- a property the negative control below
 * pins -- so a successful import is itself the check that the recorded public
 * key belongs to the recorded private key.
 */
function importVectorPrivateKey(
  privateHex: string,
  publicPointHex: string,
): Promise<CryptoKey> {
  const point = fromHex(publicPointHex);
  return crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      d: toBase64Url(fromHex(privateHex)),
      x: toBase64Url(point.slice(1, 33)),
      y: toBase64Url(point.slice(33, 65)),
    },
    ECDH_P256,
    false,
    ["deriveBits"],
  );
}

function importPeerPoint(point: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", point, ECDH_P256, false, []);
}

async function ecdh(
  privateKey: CryptoKey,
  peerPoint: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: await importPeerPoint(peerPoint) },
      privateKey,
      256,
    ),
  );
}

/** The SEC1 compressed encoding (0x02/0x03 || X) of an uncompressed point. */
function compressPoint(
  point: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
  const yIsOdd = (point[64] as number) & 1;
  return concatBytes(Uint8Array.of(yIsOdd ? 0x03 : 0x02), point.slice(1, 33));
}

/**
 * The IEEE Std 1363-2000 hybrid encoding (0x06/0x07 || X || Y) of an
 * uncompressed point. SEC1 does not define this form; platforms decode it. The
 * prefix's low bit restates Y's parity, so the form admits a self-contradicting
 * string as well: `"matching"` takes the prefix the standard pairs with this
 * point's Y, `"contradicting"` the other one, over identical coordinates.
 */
function hybridPoint(
  point: Uint8Array<ArrayBuffer>,
  prefixParity: "matching" | "contradicting",
): Uint8Array<ArrayBuffer> {
  const yIsOdd = ((point[64] as number) & 1) === 1;
  const prefixIsOdd = prefixParity === "matching" ? yIsOdd : !yIsOdd;
  const out = Uint8Array.from(point);
  out[0] = prefixIsOdd ? 0x07 : 0x06;
  return out;
}

/**
 * A fresh ephemeral public key whose Y coordinate has the requested parity, so
 * a case can drive each hybrid prefix in both roles -- as the prefix Y is
 * paired with and as the one contradicting it -- rather than whichever role a
 * random key happens to assign them.
 */
async function generateEphemeralWithYParity(
  parity: "even" | "odd",
): Promise<Uint8Array<ArrayBuffer>> {
  for (let attempt = 0; attempt < 64; attempt++) {
    const { publicKey } = await generateEphemeral();
    const yIsOdd = ((publicKey[64] as number) & 1) === 1;
    if (yIsOdd === (parity === "odd")) return publicKey;
  }
  throw new Error(`no P-256 key with ${parity} Y in 64 attempts`);
}

/** The bare 64-byte X || Y, with the SEC1 encoding prefix octet stripped. */
function prefixlessPoint(
  point: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
  return point.slice(1);
}

/** A 65-byte uncompressed encoding whose (X, Y) is not a point on P-256. */
function offCurvePoint(
  point: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
  const out = Uint8Array.from(point);
  out[64] = (out[64] as number) ^ 0x01;
  return out;
}

/**
 * The all-zero uncompressed string a peer might send for the identity, 0x04 ||
 * 0 || 0, which SEC1 treats as the off-curve point (0, 0) rather than as the
 * point at infinity.
 */
function identityPoint(): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(65);
  out[0] = 0x04;
  return out;
}

async function importAccepts(bytes: Uint8Array<ArrayBuffer>): Promise<boolean> {
  try {
    await importPeerPoint(bytes);
    return true;
  } catch {
    return false;
  }
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
  construction: { protocolName: string };
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
    p256ScalarMultiplicationAndEcdh: {
      generatorXHex: string;
      generatorYHex: string;
      privateKeyHex: string;
      publicKeyXHex: string;
      publicKeyYHex: string;
      sharedSecretHex: string;
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
  const eInitPub = fromHex(vectors.derived.initiatorEphemeralPublicHex);
  const eRespPub = fromHex(vectors.derived.responderEphemeralPublicHex);
  // Importing each recorded private key against its recorded public point is
  // what ties the two together (see importVectorPrivateKey).
  const eInitPriv = await importVectorPrivateKey(
    vectors.inputs.initiatorEphemeralPrivateHex,
    vectors.derived.initiatorEphemeralPublicHex,
  );
  const eRespPriv = await importVectorPrivateKey(
    vectors.inputs.responderEphemeralPrivateHex,
    vectors.derived.responderEphemeralPublicHex,
  );
  const dh = await ecdh(eInitPriv, eRespPub);
  expect(toHex(dh)).toBe(vectors.derived.dhSharedSecretHex);
  expect(toHex(await ecdh(eRespPriv, eInitPub))).toBe(
    vectors.derived.dhSharedSecretHex,
  );

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

test("known-answer vector: the recorded ephemeral public keys are pinned 65-byte uncompressed points", () => {
  for (const pointHex of [
    vectors.derived.initiatorEphemeralPublicHex,
    vectors.derived.responderEphemeralPublicHex,
  ]) {
    const point = fromHex(pointHex);
    expect(point.length).toBe(65);
    expect(point[0]).toBe(0x04);
  }
  expect(fromHex(vectors.derived.dhSharedSecretHex).length).toBe(32);
});

test("known-answer vector: a private key does not import against a public point that is not its own", async () => {
  // The negative control for importVectorPrivateKey: the known-answer test's
  // private-to-public pairing is only meaningful while WebCrypto enforces that
  // the JWK's coordinates are the scalar's actual public point.
  await expect(
    importVectorPrivateKey(
      vectors.inputs.initiatorEphemeralPrivateHex,
      vectors.derived.responderEphemeralPublicHex,
    ),
  ).rejects.toThrow();
});

test("known-answer vector: distinct flag values produce distinct transcripts", () => {
  // Guards the vector file itself: each flag combination yields a distinct
  // handshake hash, so the transcript binding is critical rather than inert.
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
// corresponds. What does correspond is the underlying machinery: the P-256
// scalar multiplication / ECDH and the Noise-style chaining HKDF, anchored here
// against published values.

test("P-256 scalar multiplication and ECDH reproduce the published anchor", async () => {
  const a = vectors.externalAnchors.p256ScalarMultiplicationAndEcdh;
  const generator = fromHex("04" + a.generatorXHex + a.generatorYHex);
  const publicPoint = fromHex("04" + a.publicKeyXHex + a.publicKeyYHex);

  // ECDH(d, G) = X(d*G): the scalar multiplication that turns RFC 6979 section
  // A.2.5's private key into its published public key.
  const d = await importVectorPrivateKey(a.privateKeyHex, toHex(publicPoint));
  expect(toHex(await ecdh(d, generator))).toBe(a.sharedSecretHex);

  // ECDH(1, U) = X(U): the peer-share half, with the published base point as
  // the private key.
  const one = await importVectorPrivateKey(
    "01".padStart(64, "0"),
    toHex(generator),
  );
  expect(toHex(await ecdh(one, publicPoint))).toBe(a.sharedSecretHex);

  // The shared secret is the X coordinate of the shared point, so both legs
  // land on the published public key's X.
  expect(a.sharedSecretHex).toBe(a.publicKeyXHex);
});

test("RFC 5869 test case 3: the Noise chaining HKDF matches standard HKDF", async () => {
  // RFC 5869 TC3 uses an empty salt; HKDF-Extract then substitutes HashLen zero
  // bytes, exactly noiseHkdf's chained salt with a 32-byte zero chaining key.
  const tc = vectors.externalAnchors.rfc5869TestCase3;
  const blocks = await noiseHkdf(new Uint8Array(32), fromHex(tc.ikmHex), 2);
  const okm = concatBytes(...blocks).subarray(0, tc.length);
  expect(toHex(okm)).toBe(tc.okmHex);
});

// --- What crypto.subtle validates on a peer share ----------------------------
//
// The peer-share validation is split between an application check (the pinned
// canonical encoding) and the platform (point validity). Which half does what is
// a measured property of crypto.subtle, not an assumed one, so these cases drive
// importKey directly. If the platform's answer ever changes, these fail before
// the handshake tests do, naming the layer that moved.

describe("crypto.subtle.importKey peer-share validation", () => {
  test("rejects a point that is not on the curve", async () => {
    const { publicKey } = await generateEphemeral();
    expect(await importAccepts(offCurvePoint(publicKey))).toBe(false);
  });

  test("rejects both byte strings a peer might send for the identity", async () => {
    expect(await importAccepts(identityPoint())).toBe(false);
    // The single 0x00 octet is SEC1's only encoding of the point at infinity;
    // the all-zero uncompressed string above is the off-curve point (0, 0).
    expect(await importAccepts(Uint8Array.of(0x00))).toBe(false);
    // The all-zero 32-byte share an X25519 peer would send.
    expect(await importAccepts(new Uint8Array(32))).toBe(false);
  });

  test("rejects either coordinate at or above the field prime", async () => {
    const { publicKey } = await generateEphemeral();
    const fieldPrime = fromHex(
      "ffffffff00000001000000000000000000000000ffffffffffffffffffffffff",
    );
    const outOfRangeX = concatBytes(
      Uint8Array.of(0x04),
      fieldPrime,
      publicKey.slice(33, 65),
    );
    expect(await importAccepts(outOfRangeX)).toBe(false);
    // The Y half of the same range check: a platform that reduced or ignored
    // the second coordinate would still pass the X case above.
    const outOfRangeY = concatBytes(
      Uint8Array.of(0x04),
      publicKey.slice(1, 33),
      fieldPrime,
    );
    expect(await importAccepts(outOfRangeY)).toBe(false);
  });

  test("ACCEPTS the compressed and parity-matching hybrid encodings of a valid point, which is why the encoding is pinned above importKey", async () => {
    // The critical measurement behind the canonical-encoding check in kex.ts:
    // on this platform importKey admits several encodings of one point and
    // re-exports each as the same uncompressed point, so a share re-encoded in
    // transit would decode to the same key while feeding different bytes into
    // the transcript. The browser suite gets a different answer for the hybrid
    // form in Chromium -- the second reason the pin cannot be delegated.
    const { publicKey } = await generateEphemeral();
    const compressed = compressPoint(publicKey);
    const hybrid = hybridPoint(publicKey, "matching");
    expect(compressed.length).toBe(33);
    expect(hybrid.length).toBe(65);
    expect(await importAccepts(compressed)).toBe(true);
    expect(await importAccepts(hybrid)).toBe(true);
    for (const alternative of [compressed, hybrid]) {
      const reExported = new Uint8Array(
        await crypto.subtle.exportKey(
          "raw",
          await crypto.subtle.importKey(
            "raw",
            alternative,
            ECDH_P256,
            true,
            [],
          ),
        ),
      );
      expect(toHex(reExported)).toBe(toHex(publicKey));
    }
  });

  test("admits a hybrid encoding only while its prefix agrees with Y's parity", async () => {
    // The qualifier on the acceptance above, measured not predicted: both
    // prefixes are driven over both Y parities, so each of 0x06 and 0x07 is
    // offered once matching the point and once contradicting it, over otherwise
    // identical bytes. An admitted one and a refused one isolate the parity
    // check -- neither prefix passes or fails alone. The spec's
    // "parity-correct" qualifier and the kex.ts comment both rest on this case.
    for (const parity of ["even", "odd"] as const) {
      const publicKey = await generateEphemeralWithYParity(parity);
      const matching = hybridPoint(publicKey, "matching");
      const contradicting = hybridPoint(publicKey, "contradicting");
      expect(matching[0]).toBe(parity === "odd" ? 0x07 : 0x06);
      expect(contradicting[0]).toBe(parity === "odd" ? 0x06 : 0x07);
      expect(toHex(matching.slice(1))).toBe(toHex(contradicting.slice(1)));
      expect(await importAccepts(matching)).toBe(true);
      expect(await importAccepts(contradicting)).toBe(false);
    }
  });

  test("accepts the pinned uncompressed encoding", async () => {
    const { publicKey } = await generateEphemeral();
    expect(publicKey.length).toBe(65);
    expect(publicKey[0]).toBe(0x04);
    expect(await importAccepts(publicKey)).toBe(true);
  });
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

test("the ephemeral public key on the wire is the pinned 65-byte uncompressed point", async () => {
  const [connA, connB] = createMessagePipe();
  const initiator = runKex(connA, "initiator", PSK_A, false);
  initiator.catch(() => {});
  const msg1 = (await connB.receive()) as { kexMsg: string; e: string };
  expect(msg1.kexMsg).toBe("1");
  const e = fromBase64Url(msg1.e);
  expect(e.length).toBe(65);
  expect(e[0]).toBe(0x04);
});

test("a mismatched secret fails closed on both sides with the generic error", async () => {
  const [a, b] = await runPair(PSK_A, PSK_B);
  expect(a.status).toBe("rejected");
  expect(b.status).toBe("rejected");
  for (const r of [a, b]) {
    const reason = (r as PromiseRejectedResult).reason as unknown;
    // The trust-boundary classification consumers key on: a security-kind
    // ConnectionError, with the message byte-identical to the generic string
    // (the type holds the classification, never the message).
    expect(reason).toBeInstanceOf(ConnectionError);
    expect((reason as ConnectionError).kind).toBe("security");
    expect((reason as ConnectionError).message).toBe(GENERIC_FAILURE);
  }
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
  const err = await runKex(conn, "responder", PSK_A, false).catch(
    (e: unknown) => e,
  );
  expect((err as Error).message).toBe("key exchange handshake timed out");
  // The timeout is a transport fault (the peer is gone), not an authentication
  // verdict, so by design it does NOT hold the security classification the
  // generic authentication failure does.
  expect(err).not.toBeInstanceOf(ConnectionError);
  // Tagged as a peer-wait timeout so a consumer that also knows the run swept
  // the shared folder at entry can offer that as the likely cause.
  expect(isPeerWaitTimeout(err)).toBe(true);
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
  const err = await responder.catch((e: unknown) => e);
  // A malformed-frame rejection holds the same security classification as a
  // confirmation mismatch: every authentication-failure site throws the one
  // generic security-kind error.
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("security");
  expect((err as ConnectionError).message).toBe(GENERIC_FAILURE);
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
// DH output, and the keys both parties would derive correctly -- binding the
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
  const eph = await generateEphemeral();
  const dh = await ecdh(eph.privateKey, eInitPub);
  const keys = await computeKexKeys(
    psk,
    eInitPub,
    eph.publicKey,
    dh,
    msg1.reqEnc,
    responderReqEnc,
  );
  return { eInitPub, eRespPub: eph.publicKey, keys, responderReqEnc };
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

test("substituting the responder's public key on the wire breaks confirmation (initiator side)", async () => {
  const [connA, connB] = createMessagePipe();
  const initiator = runKex(connA, "initiator", PSK_A, false);
  initiator.catch(() => {});
  const { keys, responderReqEnc } = await fakeResponderUpToMsg2(connB, PSK_A);
  // A different valid public key, with the confirmation computed over the real
  // one: the initiator's transcript hash differs, so the responder tag
  // mismatches. (A bit-flipped point would be rejected as off-curve before any
  // transcript is computed; that path is covered separately. This one reaches
  // the confirmation round.)
  const other = await generateEphemeral();
  await connB.send({
    kexMsg: "2",
    e: toBase64Url(other.publicKey),
    confirm: toBase64Url(keys.responderConfirm),
    reqEnc: responderReqEnc,
  });
  await expect(initiator).rejects.toThrow(GENERIC_FAILURE);
});

test("substituting the initiator's public key breaks confirmation (responder side)", async () => {
  const [connA, connB] = createMessagePipe();
  const responder = runKex(connB, "responder", PSK_A, false);
  responder.catch(() => {});
  // Hand-rolled initiator declaring reqEnc: false on the wire.
  const eph = await generateEphemeral();
  await connA.send({
    kexMsg: "1",
    e: toBase64Url(eph.publicKey),
    reqEnc: false,
  });
  const msg2 = (await connA.receive()) as {
    kexMsg: string;
    e: string;
    reqEnc: boolean;
  };
  expect(msg2.kexMsg).toBe("2");
  const eRespPub = fromBase64Url(msg2.e);
  const dh = await ecdh(eph.privateKey, eRespPub);
  // Confirm over a different e_i (same DH, e_r, and flags): only the initiator
  // public key bound into the transcript differs, so the responder rejects.
  const substitute = await generateEphemeral();
  const keys = await computeKexKeys(
    PSK_A,
    substitute.publicKey,
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

test("the responder folds an explicit abort delivered as msg3 into a generic failure", async () => {
  // The responder's final receive parses msg3 as a union of the msg3 and abort
  // schemas. An explicit { kexMsg: "abort" } -- the initiator's signal that it
  // rejected the responder's tag (e.g. on a psk mismatch) -- parses successfully
  // but is folded into the same generic authentication failure as a
  // malformed msg3. This exercises that abort arm of the union directly; its only
  // other coverage is indirect, through malformed-msg3 cases.
  const [connA, connB] = createMessagePipe();
  const responder = runKex(connB, "responder", PSK_A, false);
  responder.catch(() => {});
  // A well-formed msg1 so the responder advances to send msg2 and then waits on
  // msg3.
  const eph = await generateEphemeral();
  await connA.send({
    kexMsg: "1",
    e: toBase64Url(eph.publicKey),
    reqEnc: false,
  });
  expect(((await connA.receive()) as { kexMsg: string }).kexMsg).toBe("2");
  // The initiator aborts instead of confirming.
  await connA.send({ kexMsg: "abort" });
  await expect(responder).rejects.toThrow(GENERIC_FAILURE);
});

// --- Peer-share rejection over the wire --------------------------------------
//
// Each case is the wire-level counterpart of one importKey measurement above:
// the share reaches runKex, is rejected before any transcript is computed, and
// the peer gets the generic failure plus an abort.

describe("a peer share that is not a canonically-encoded valid point is rejected", () => {
  async function initiatorRejectsMsg2Share(
    share: Uint8Array<ArrayBuffer>,
  ): Promise<void> {
    const [connA, connB] = createMessagePipe();
    const initiator = runKex(connA, "initiator", PSK_A, false);
    initiator.catch(() => {});
    expect(((await connB.receive()) as { kexMsg: string }).kexMsg).toBe("1");
    await connB.send({
      kexMsg: "2",
      e: toBase64Url(share),
      confirm: toBase64Url(new Uint8Array(32)),
      reqEnc: false,
    });
    await expect(initiator).rejects.toThrow(GENERIC_FAILURE);
    expect(await connB.receive()).toEqual({ kexMsg: "abort" });
  }

  test("a point not on the curve", async () => {
    const { publicKey } = await generateEphemeral();
    await initiatorRejectsMsg2Share(offCurvePoint(publicKey));
  });

  test("the all-zero uncompressed string sent for the identity", async () => {
    await initiatorRejectsMsg2Share(identityPoint());
  });

  test("the compressed encoding of an otherwise valid point", async () => {
    // importKey accepts this encoding (measured above); the handshake does not.
    const { publicKey } = await generateEphemeral();
    await initiatorRejectsMsg2Share(compressPoint(publicKey));
  });

  test("either hybrid encoding of an otherwise valid point", async () => {
    // The pinned length with a different prefix: this one is rejected on the
    // prefix check rather than the length check. Both prefixes are driven
    // because only one of them survives importKey (measured above), and the
    // wire verdict must not inherit that split -- the prefix check refuses each
    // without either reaching the platform.
    const { publicKey } = await generateEphemeral();
    await initiatorRejectsMsg2Share(hybridPoint(publicKey, "matching"));
    await initiatorRejectsMsg2Share(hybridPoint(publicKey, "contradicting"));
  });

  test("a 32-byte share, the shape a superseded X25519 peer sends", async () => {
    await initiatorRejectsMsg2Share(new Uint8Array(32).fill(0x01));
  });

  test("the 64-byte X || Y of a valid point with no encoding prefix", async () => {
    // The bare coordinate pair a peer whose ECDH interface hands out raw X || Y
    // would send: every byte belongs to a genuine point, and only the pinned
    // 65-byte length separates it from an accepted share.
    const { publicKey } = await generateEphemeral();
    await initiatorRejectsMsg2Share(prefixlessPoint(publicKey));
  });

  test("the responder rejects the same shares on msg1", async () => {
    const { publicKey } = await generateEphemeral();
    for (const share of [
      offCurvePoint(publicKey),
      identityPoint(),
      compressPoint(publicKey),
      hybridPoint(publicKey, "matching"),
      hybridPoint(publicKey, "contradicting"),
      prefixlessPoint(publicKey),
      new Uint8Array(32).fill(0x01),
    ]) {
      const [connA, connB] = createMessagePipe();
      const responder = runKex(connB, "responder", PSK_A, false);
      responder.catch(() => {});
      await connA.send({
        kexMsg: "1",
        e: toBase64Url(share),
        reqEnc: false,
      });
      await expect(responder).rejects.toThrow(GENERIC_FAILURE);
      expect(await connA.receive()).toEqual({ kexMsg: "abort" });
    }
  });
});

// --- Protocol-version tag ----------------------------------------------------

// The key schedule with the protocol-version tag as a parameter, so a peer on a
// different tag can be driven end to end. It mirrors computeKexKeys, and the
// first test below pins it as a mirror: under the shipped tag it must reproduce
// computeKexKeys exactly, so the divergence the last test observes is the tag
// and nothing else.
async function computeKexKeysUnderTag(
  protocolName: string,
  psk: Uint8Array<ArrayBuffer>,
  eInitPub: Uint8Array<ArrayBuffer>,
  eRespPub: Uint8Array<ArrayBuffer>,
  dh: Uint8Array<ArrayBuffer>,
  iReq: boolean,
  rReq: boolean,
) {
  const encoder = new TextEncoder();
  const flagByte = (requested: boolean) => Uint8Array.of(requested ? 1 : 0);
  const chain = async (
    ck: Uint8Array<ArrayBuffer>,
    ikm: Uint8Array<ArrayBuffer>,
  ) => (await noiseHkdf(ck, ikm, 2))[0]!;

  let h = await sha256(encoder.encode(protocolName));
  let ck = Uint8Array.from(h);
  h = await sha256(concatBytes(h, new Uint8Array(0)));
  const [ckAfterPsk, tempH] = await noiseHkdf(ck, psk, 3);
  ck = ckAfterPsk!;
  h = await sha256(concatBytes(h, tempH!));
  h = await sha256(concatBytes(h, eInitPub));
  ck = await chain(ck, eInitPub);
  h = await sha256(concatBytes(h, flagByte(iReq)));
  h = await sha256(concatBytes(h, eRespPub));
  ck = await chain(ck, eRespPub);
  h = await sha256(concatBytes(h, flagByte(rReq)));
  ck = await chain(ck, dh);

  const confirmKey = await hkdfDerive(ck, "psilink-kex-v1:confirm", 32);
  return {
    sessionKey: await hkdfDerive(
      concatBytes(ck, h),
      "psilink-kex-v1:session",
      32,
    ),
    initiatorConfirm: await hmacSha256(
      confirmKey,
      concatBytes(encoder.encode("psilink-kex-v1:initiator-confirm"), h),
    ),
    responderConfirm: await hmacSha256(
      confirmKey,
      concatBytes(encoder.encode("psilink-kex-v1:responder-confirm"), h),
    ),
  };
}

const SHIPPED_PROTOCOL_NAME = vectors.construction.protocolName;
const SUPERSEDED_PROTOCOL_NAME = "psilink-kex-v1:NNpsk0_25519_SHA256";

test("the shipped protocol-version tag names the P-256 suite and differs from the superseded tag", () => {
  expect(SHIPPED_PROTOCOL_NAME).toBe("psilink-kex-v2:NNpsk0_P256_SHA256");
  expect(SHIPPED_PROTOCOL_NAME).not.toBe(SUPERSEDED_PROTOCOL_NAME);
});

test("the tag-parameterized schedule reproduces computeKexKeys under the shipped tag", async () => {
  const psk = fromHex(vectors.inputs.pskHex);
  const eInitPub = fromHex(vectors.derived.initiatorEphemeralPublicHex);
  const eRespPub = fromHex(vectors.derived.responderEphemeralPublicHex);
  const dh = fromHex(vectors.derived.dhSharedSecretHex);
  const mirrored = await computeKexKeysUnderTag(
    SHIPPED_PROTOCOL_NAME,
    psk,
    eInitPub,
    eRespPub,
    dh,
    true,
    false,
  );
  const actual = await computeKexKeys(psk, eInitPub, eRespPub, dh, true, false);
  expect(toHex(mirrored.sessionKey)).toBe(toHex(actual.sessionKey));
  expect(toHex(mirrored.initiatorConfirm)).toBe(toHex(actual.initiatorConfirm));
  expect(toHex(mirrored.responderConfirm)).toBe(toHex(actual.responderConfirm));
});

test("a peer on the superseded protocol-version tag fails the handshake closed", async () => {
  // The version tag seeds both h and ck, so a peer on the other tag derives a
  // different transcript from the first step. It reaches the confirmation round
  // with a tag the shipped side rejects, and the two session keys never agree --
  // the mismatch cannot be hidden behind a usable session.
  const [connA, connB] = createMessagePipe();
  const initiator = runKex(connA, "initiator", PSK_A, false);
  initiator.catch(() => {});

  const msg1 = (await connB.receive()) as {
    kexMsg: string;
    e: string;
    reqEnc: boolean;
  };
  expect(msg1.kexMsg).toBe("1");
  const eInitPub = fromBase64Url(msg1.e);
  const eph = await generateEphemeral();
  const dh = await ecdh(eph.privateKey, eInitPub);

  const stale = await computeKexKeysUnderTag(
    SUPERSEDED_PROTOCOL_NAME,
    PSK_A,
    eInitPub,
    eph.publicKey,
    dh,
    msg1.reqEnc,
    false,
  );
  const shipped = await computeKexKeysUnderTag(
    SHIPPED_PROTOCOL_NAME,
    PSK_A,
    eInitPub,
    eph.publicKey,
    dh,
    msg1.reqEnc,
    false,
  );
  // Same psk, same ephemerals, same DH: only the tag differs, and every derived
  // value does with it.
  expect(toHex(stale.sessionKey)).not.toBe(toHex(shipped.sessionKey));
  expect(toHex(stale.responderConfirm)).not.toBe(
    toHex(shipped.responderConfirm),
  );

  await connB.send({
    kexMsg: "2",
    e: toBase64Url(eph.publicKey),
    confirm: toBase64Url(stale.responderConfirm),
    reqEnc: false,
  });

  const err = await initiator.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("security");
  expect((err as ConnectionError).message).toBe(GENERIC_FAILURE);
  // The shipped side aborts rather than sending its own confirmation, so the
  // stale peer never receives a tag it could complete against either.
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

test("flipping the initiator's request-encryption flag on the wire fails the handshake closed (responder side)", async () => {
  // A session both parties want encrypted (initiator and responder each request
  // true): an attacker flips the initiator's reqEnc from true to false in
  // transit. The responder binds the downgraded false flag into its transcript;
  // the honest initiator binds its true flag. Their handshake hashes diverge, so
  // the initiator's confirmation tag (msg3) does not verify and the responder
  // fails closed -- a downgrade cannot proceed with a split decision.
  const [connA, connB] = createMessagePipe();
  const responder = runKex(connB, "responder", PSK_A, true);
  responder.catch(() => {});
  const eph = await generateEphemeral();
  // Tampered-down flag on the wire: the responder receives reqEnc: false.
  await connA.send({
    kexMsg: "1",
    e: toBase64Url(eph.publicKey),
    reqEnc: false,
  });
  const msg2 = (await connA.receive()) as {
    kexMsg: string;
    e: string;
    reqEnc: boolean;
  };
  expect(msg2.kexMsg).toBe("2");
  const eRespPub = fromBase64Url(msg2.e);
  const dh = await ecdh(eph.privateKey, eRespPub);
  // The honest initiator's transcript binds its true flag; only the wire copy
  // the responder saw was flipped to false, so the two transcripts diverge.
  const keys = await computeKexKeys(
    PSK_A,
    eph.publicKey,
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
  // Symmetric to the msg1 case above: an attacker flips the responder's reqEnc
  // from true to false in transit. The honest responder computes its
  // confirmation tag over a transcript binding true, but the wire copy the
  // initiator sees is flipped to false, so the initiator binds the downgraded
  // flag instead. The responder's confirmation tag (msg2) fails to verify, and
  // the initiator fails closed rather than proceed on a split decision.
  const [connA, connB] = createMessagePipe();
  const initiator = runKex(connA, "initiator", PSK_A, true);
  initiator.catch(() => {});
  // The hand-rolled responder actually requests encryption (responderReqEnc:
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

// The cross-version fail-closed mechanism for an additive payload that, by
// design, does not bump the protocol-version tag: a flag-unaware peer omits
// reqEnc entirely, and the flag-aware peer's strict (.strict()) schema rejects
// the message before any transcript is computed.

test("a msg1 missing the request-encryption flag is rejected by the strict schema (responder side)", async () => {
  const [connA, connB] = createMessagePipe();
  const responder = runKex(connB, "responder", PSK_A, false);
  responder.catch(() => {});
  const eph = await generateEphemeral();
  // A flag-unaware initiator sends msg1 with no reqEnc field.
  await connA.send({ kexMsg: "1", e: toBase64Url(eph.publicKey) });
  await expect(responder).rejects.toThrow(GENERIC_FAILURE);
  expect(await connA.receive()).toEqual({ kexMsg: "abort" });
});

test("a msg2 missing the request-encryption flag is rejected by the strict schema (initiator side)", async () => {
  const [connA, connB] = createMessagePipe();
  const initiator = runKex(connA, "initiator", PSK_A, false);
  initiator.catch(() => {});
  const msg1 = (await connB.receive()) as { kexMsg: string };
  expect(msg1.kexMsg).toBe("1");
  const eph = await generateEphemeral();
  // A flag-unaware responder replies with no reqEnc field.
  await connB.send({
    kexMsg: "2",
    e: toBase64Url(eph.publicKey),
    confirm: toBase64Url(new Uint8Array(32)),
  });
  await expect(initiator).rejects.toThrow(GENERIC_FAILURE);
  expect(await connB.receive()).toEqual({ kexMsg: "abort" });
});
