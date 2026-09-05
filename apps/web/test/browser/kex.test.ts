/// <reference types="@vitest/browser-playwright/context" />
/// <reference types="vite/client" />

import { describe, expect, test } from "vitest";

import { createMessagePipe, runKex } from "@psilink/core";
import { computeKexKeys } from "@psilink/core/testing";

import vectorsRaw from "../../../../packages/core/test/vectors/kex-vectors.json?raw";

// The companion to packages/core/test/kex.test.ts: runs the same checked-in
// key-exchange vectors through the browser build of @psilink/core in real
// Chromium, so a CLI peer (Node) and a web peer (browser) derive an identical
// session from an identical transcript.
//
// crypto.subtle differs per platform (Node's OpenSSL, Chromium's BoringSSL), so
// the cases below also re-measure which encodings importKey admits here --
// what decides whether kex.ts's canonical-encoding check is critical.

const ECDH_P256 = { name: "ECDH", namedCurve: "P-256" } as const;

// The one generic message every authentication failure shows.
const GENERIC_FAILURE = "key exchange authentication failed";

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

/** The SEC1 compressed encoding (0x02/0x03 || X) of an uncompressed point. */
function compressPoint(
  point: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
  const compressed = new Uint8Array(33);
  compressed[0] = point[64] & 1 ? 0x03 : 0x02;
  compressed.set(point.slice(1, 33), 1);
  return compressed;
}

/**
 * The IEEE Std 1363-2000 hybrid encoding (0x06/0x07 || X || Y) of an
 * uncompressed point. SEC1 does not define this form; platforms decode it.
 */
function hybridPoint(point: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const hybrid = Uint8Array.from(point);
  hybrid[0] = point[64] & 1 ? 0x07 : 0x06;
  return hybrid;
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
    // The same measurement the Node suite makes, on the other platform: importKey
    // agrees on point validity but not on which encodings decode -- Chromium
    // rejects the hybrid form that Node accepts. kex.ts pins the encoding above
    // importKey so a share's acceptance does not depend on which peer received it.
    const point = await generateEphemeralPoint();

    const offCurve = Uint8Array.from(point);
    offCurve[64] = offCurve[64] ^ 0x01;
    expect(await importAccepts(offCurve)).toBe(false);

    const identity = new Uint8Array(65);
    identity[0] = 0x04;
    expect(await importAccepts(identity)).toBe(false);
    expect(await importAccepts(Uint8Array.of(0x00))).toBe(false);
    expect(await importAccepts(new Uint8Array(32))).toBe(false);

    // Both coordinates are pinned: a platform that reduced or ignored the
    // second one would still pass the X case.
    const fieldPrime = fromHex(
      "ffffffff00000001000000000000000000000000ffffffffffffffffffffffff",
    );
    const outOfRangeX = new Uint8Array(65);
    outOfRangeX[0] = 0x04;
    outOfRangeX.set(fieldPrime, 1);
    outOfRangeX.set(point.slice(33, 65), 33);
    expect(await importAccepts(outOfRangeX)).toBe(false);

    const outOfRangeY = new Uint8Array(65);
    outOfRangeY[0] = 0x04;
    outOfRangeY.set(point.slice(1, 33), 1);
    outOfRangeY.set(fieldPrime, 33);
    expect(await importAccepts(outOfRangeY)).toBe(false);

    expect(await importAccepts(compressPoint(point))).toBe(true);

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

  // The wire counterpart of the measurement above, in both roles: Chromium admits
  // the compressed encoding and refuses the hybrid one, Node admits both, so an
  // unpinned encoding's acceptance would depend on which peer received the share.
  // Both are rejected in both roles here and in the Node suite. The responder
  // half matters because an accepted share would leave the responder waiting on
  // msg3 instead of raising the abort or the generic failure.

  async function initiatorRejectsMsg2Share(
    share: Uint8Array<ArrayBuffer>,
  ): Promise<void> {
    const [connA, connB] = createMessagePipe();
    const initiator = runKex(
      connA,
      "initiator",
      fromHex(vectors.inputs.pskHex),
      false,
    );
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

  async function responderRejectsMsg1Share(
    share: Uint8Array<ArrayBuffer>,
  ): Promise<void> {
    const [connA, connB] = createMessagePipe();
    const responder = runKex(
      connB,
      "responder",
      fromHex(vectors.inputs.pskHex),
      false,
    );
    responder.catch(() => {});
    await connA.send({ kexMsg: "1", e: toBase64Url(share), reqEnc: false });
    await expect(responder).rejects.toThrow(GENERIC_FAILURE);
    expect(await connA.receive()).toEqual({ kexMsg: "abort" });
  }

  test("the browser build rejects a compressed peer share in either role", async () => {
    const point = await generateEphemeralPoint();
    await initiatorRejectsMsg2Share(compressPoint(point));
    await responderRejectsMsg1Share(compressPoint(point));
  });

  test("the browser build rejects a hybrid peer share in either role", async () => {
    const point = await generateEphemeralPoint();
    await initiatorRejectsMsg2Share(hybridPoint(point));
    await responderRejectsMsg1Share(hybridPoint(point));
  });
});
