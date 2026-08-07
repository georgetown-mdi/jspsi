/// <reference types="@vitest/browser-playwright/context" />
/// <reference types="vite/client" />

import { describe, expect, test } from "vitest";

import { createMessagePipe, runKex } from "@psilink/core";
import { computeKexKeys } from "@psilink/core/testing";

import vectorsRaw from "../../../../packages/core/test/vectors/kex-vectors.json?raw";

// The companion to packages/core/test/kex.test.ts's vector suite: it runs the
// SAME checked-in key-exchange vectors through the browser build of
// @psilink/core in real Chromium. The Node suite proves Node reproduces the
// vectors and this suite proves the browser reproduces the same chaining key,
// handshake hash, session key, and both confirmation tags -- so a CLI peer
// (Node) and a web peer (browser) derive an identical session from an identical
// transcript.
//
// Key establishment runs entirely on crypto.subtle, which is a different
// implementation on each platform (Node's OpenSSL, Chromium's BoringSSL). The
// cases below therefore also re-measure, in Chromium, the peer-share validation
// the Node suite measures: which encodings importKey admits is what decides
// whether kex.ts's canonical-encoding check is load-bearing, and it is a
// property of each platform separately.

const ECDH_P256 = { name: "ECDH", namedCurve: "P-256" } as const;

interface KexCase {
  name: string;
  initiatorRequestsEncryption: boolean;
  responderRequestsEncryption: boolean;
  handshakeHashHex: string;
  sessionKeyHex: string;
  initiatorConfirmHex: string;
  responderConfirmHex: string;
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
  cases: Array<KexCase>;
  externalAnchors: {
    p256ScalarMultiplicationAndEcdh: {
      generatorXHex: string;
      generatorYHex: string;
      privateKeyHex: string;
      publicKeyXHex: string;
      publicKeyYHex: string;
      sharedSecretHex: string;
    };
  };
}

const vectors = JSON.parse(vectorsRaw) as KexVectors;

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/** Import a fixed private key from the vectors by its recorded public point. */
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

async function ecdh(
  privateKey: CryptoKey,
  peerPoint: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const peer = await crypto.subtle.importKey(
    "raw",
    peerPoint,
    ECDH_P256,
    false,
    [],
  );
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: peer },
      privateKey,
      256,
    ),
  );
}

async function importAccepts(bytes: Uint8Array<ArrayBuffer>): Promise<boolean> {
  try {
    await crypto.subtle.importKey("raw", bytes, ECDH_P256, false, []);
    return true;
  } catch {
    return false;
  }
}

async function generateEphemeralPoint(): Promise<Uint8Array<ArrayBuffer>> {
  const pair = await crypto.subtle.generateKey(ECDH_P256, false, [
    "deriveBits",
  ]);
  return new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
}

describe("key exchange in the browser", () => {
  test("the browser's ECDH reproduces the vector's shared secret from the recorded private keys", async () => {
    const eInitPub = fromHex(vectors.derived.initiatorEphemeralPublicHex);
    const eRespPub = fromHex(vectors.derived.responderEphemeralPublicHex);
    const eInitPriv = await importVectorPrivateKey(
      vectors.inputs.initiatorEphemeralPrivateHex,
      vectors.derived.initiatorEphemeralPublicHex,
    );
    const eRespPriv = await importVectorPrivateKey(
      vectors.inputs.responderEphemeralPrivateHex,
      vectors.derived.responderEphemeralPublicHex,
    );
    expect(toHex(await ecdh(eInitPriv, eRespPub))).toBe(
      vectors.derived.dhSharedSecretHex,
    );
    expect(toHex(await ecdh(eRespPriv, eInitPub))).toBe(
      vectors.derived.dhSharedSecretHex,
    );
  });

  test.each(vectors.cases)(
    "$name: the browser build reproduces the checked-in key schedule",
    async (kexCase: KexCase) => {
      const keys = await computeKexKeys(
        fromHex(vectors.inputs.pskHex),
        fromHex(vectors.derived.initiatorEphemeralPublicHex),
        fromHex(vectors.derived.responderEphemeralPublicHex),
        fromHex(vectors.derived.dhSharedSecretHex),
        kexCase.initiatorRequestsEncryption,
        kexCase.responderRequestsEncryption,
      );
      expect(toHex(keys.chainingKey)).toBe(vectors.derived.chainingKeyHex);
      expect(toHex(keys.confirmKey)).toBe(vectors.derived.confirmKeyHex);
      expect(toHex(keys.handshakeHash)).toBe(kexCase.handshakeHashHex);
      expect(toHex(keys.sessionKey)).toBe(kexCase.sessionKeyHex);
      expect(toHex(keys.initiatorConfirm)).toBe(kexCase.initiatorConfirmHex);
      expect(toHex(keys.responderConfirm)).toBe(kexCase.responderConfirmHex);
    },
  );

  test("the browser reproduces the published P-256 anchor", async () => {
    const a = vectors.externalAnchors.p256ScalarMultiplicationAndEcdh;
    const generator = fromHex("04" + a.generatorXHex + a.generatorYHex);
    const publicPoint = fromHex("04" + a.publicKeyXHex + a.publicKeyYHex);
    const d = await importVectorPrivateKey(a.privateKeyHex, toHex(publicPoint));
    expect(toHex(await ecdh(d, generator))).toBe(a.sharedSecretHex);
    const one = await importVectorPrivateKey(
      "01".padStart(64, "0"),
      toHex(generator),
    );
    expect(toHex(await ecdh(one, publicPoint))).toBe(a.sharedSecretHex);
  });

  test("the browser's importKey rejects an invalid point, and admits the compressed encoding of a valid one", async () => {
    // The same measurement the Node suite makes, on the other platform. Point
    // validity comes from importKey on both; the canonical encoding does not,
    // and the two platforms do not even agree on which alternative encodings
    // decode -- Chromium rejects the hybrid form that Node accepts. That
    // disagreement is why the encoding is pinned in kex.ts above importKey
    // instead of being left to it: otherwise a share's acceptance would depend
    // on which peer received it.
    const point = await generateEphemeralPoint();

    const offCurve = Uint8Array.from(point);
    offCurve[64] = offCurve[64] ^ 0x01;
    expect(await importAccepts(offCurve)).toBe(false);

    const identity = new Uint8Array(65);
    identity[0] = 0x04;
    expect(await importAccepts(identity)).toBe(false);
    expect(await importAccepts(Uint8Array.of(0x00))).toBe(false);
    expect(await importAccepts(new Uint8Array(32))).toBe(false);

    const outOfRangeX = new Uint8Array(65);
    outOfRangeX[0] = 0x04;
    outOfRangeX.set(
      fromHex(
        "ffffffff00000001000000000000000000000000ffffffffffffffffffffffff",
      ),
      1,
    );
    outOfRangeX.set(point.slice(33, 65), 33);
    expect(await importAccepts(outOfRangeX)).toBe(false);

    const yIsOdd = point[64] & 1;
    const compressed = new Uint8Array(33);
    compressed[0] = yIsOdd ? 0x03 : 0x02;
    compressed.set(point.slice(1, 33), 1);
    expect(await importAccepts(compressed)).toBe(true);

    // Measured, not assumed: Chromium refuses both hybrid prefixes, where Node
    // decodes the parity-correct one.
    for (const prefix of [0x06, 0x07]) {
      const hybrid = Uint8Array.from(point);
      hybrid[0] = prefix;
      expect(await importAccepts(hybrid)).toBe(false);
    }

    expect(await importAccepts(point)).toBe(true);
  });

  test("a full handshake runs in the browser and both sides agree", async () => {
    const [connA, connB] = createMessagePipe();
    const [initiator, responder] = await Promise.all([
      runKex(connA, "initiator", fromHex(vectors.inputs.pskHex), true),
      runKex(connB, "responder", fromHex(vectors.inputs.pskHex), false),
    ]);
    expect(initiator.sessionKey.length).toBe(32);
    expect(toHex(initiator.sessionKey)).toBe(toHex(responder.sessionKey));
    expect(initiator.applyEncryption).toBe(true);
    expect(responder.applyEncryption).toBe(true);
  });

  test("a peer share in a non-canonical encoding is rejected by the browser build", async () => {
    const [connA, connB] = createMessagePipe();
    const initiator = runKex(
      connA,
      "initiator",
      fromHex(vectors.inputs.pskHex),
      false,
    );
    initiator.catch(() => {});
    expect(((await connB.receive()) as { kexMsg: string }).kexMsg).toBe("1");
    const point = await generateEphemeralPoint();
    const compressed = new Uint8Array(33);
    compressed[0] = point[64] & 1 ? 0x03 : 0x02;
    compressed.set(point.slice(1, 33), 1);
    await connB.send({
      kexMsg: "2",
      e: toBase64Url(compressed),
      confirm: toBase64Url(new Uint8Array(32)),
      reqEnc: false,
    });
    await expect(initiator).rejects.toThrow(
      "key exchange authentication failed",
    );
  });
});
