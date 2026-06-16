import { createHash, generateKeyPairSync } from "node:crypto";

import { expect, test } from "vitest";

import {
  computeHostKeyFingerprint,
  keyTypeFromBlob,
  verifyHostKeyFingerprint,
} from "../src/utils/sshHostKey";

// Build a 51-byte OpenSSH wire-format blob for a fresh ed25519 key pair.
//
// Wire layout: [uint32 typeLen][type bytes][uint32 keyLen][key bytes]
// Ed25519 SPKI DER is always 44 bytes; the raw 32-byte public key lives at
// bytes 12-43. This matches what ssh2's hostVerifier passes to the callback.
function buildEd25519Blob(): Uint8Array<ArrayBuffer> {
  const { publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const rawKey = spki.slice(12, 44); // 32 bytes
  const blob = new Uint8Array(4 + 11 + 4 + 32); // 51 bytes total
  const view = new DataView(blob.buffer);
  view.setUint32(0, 11, false); // length of "ssh-ed25519"
  blob.set(new TextEncoder().encode("ssh-ed25519"), 4);
  view.setUint32(15, 32, false); // length of raw key
  blob.set(rawKey, 19);
  return blob;
}

// Reference fingerprint using Node's native SHA-256 (not WebCrypto) so the
// test does not circularly depend on the implementation under test.
function referenceFingerprint(blob: Uint8Array): string {
  const digest = createHash("sha256").update(blob).digest();
  return "SHA256:" + digest.toString("base64").replace(/=+$/, "");
}

// --- computeHostKeyFingerprint -----------------------------------------------

test("computeHostKeyFingerprint matches Node sha256 on ed25519 blob (known-answer vector)", async () => {
  const blob = buildEd25519Blob();
  expect(await computeHostKeyFingerprint(blob)).toBe(
    referenceFingerprint(blob),
  );
});

test("computeHostKeyFingerprint output satisfies OpenSSH SHA256 fingerprint format", async () => {
  const blob = buildEd25519Blob();
  const fp = await computeHostKeyFingerprint(blob);
  expect(fp).toMatch(/^SHA256:[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]$/);
});

// --- verifyHostKeyFingerprint ------------------------------------------------

test("verifyHostKeyFingerprint accepts a blob that matches the pinned fingerprint", async () => {
  const blob = buildEd25519Blob();
  const pin = referenceFingerprint(blob);
  expect(await verifyHostKeyFingerprint(blob, pin)).toBe(true);
});

test("verifyHostKeyFingerprint rejects a one-bit-flipped blob", async () => {
  const blob = buildEd25519Blob();
  const pin = referenceFingerprint(blob);
  const flipped = new Uint8Array(blob);
  flipped[19] ^= 0x01; // flip one bit in the raw key payload
  expect(await verifyHostKeyFingerprint(flipped, pin)).toBe(false);
});

test("verifyHostKeyFingerprint rejects a blob from a different key pair", async () => {
  const blobA = buildEd25519Blob();
  const blobB = buildEd25519Blob();
  const pinA = referenceFingerprint(blobA);
  expect(await verifyHostKeyFingerprint(blobB, pinA)).toBe(false);
});

// --- keyTypeFromBlob ---------------------------------------------------------

test("keyTypeFromBlob extracts ssh-ed25519 from a well-formed blob", () => {
  const blob = buildEd25519Blob();
  expect(keyTypeFromBlob(blob)).toBe("ssh-ed25519");
});

test("keyTypeFromBlob returns (unknown) for an empty blob", () => {
  expect(keyTypeFromBlob(new Uint8Array(0))).toBe("(unknown)");
});

test("keyTypeFromBlob returns (unknown) when claimed type length exceeds the blob", () => {
  // Claims typeLen = 100, but only 5 bytes of data follow the header.
  const blob = new Uint8Array([0, 0, 0, 100, 1, 2, 3, 4, 5]);
  expect(keyTypeFromBlob(blob)).toBe("(unknown)");
});

test("keyTypeFromBlob returns (unknown) for a zero-length type prefix", () => {
  // All-zero length prefix: subarray(4, 4) would decode to "" and leave a blank
  // type in the mismatch message ("the server presented a  key ..."); a
  // well-formed blob always names a non-empty type, so this is "(unknown)".
  const blob = new Uint8Array([0, 0, 0, 0, 1, 2, 3, 4]);
  expect(keyTypeFromBlob(blob)).toBe("(unknown)");
});

test("keyTypeFromBlob returns (unknown) when the length prefix has the high bit set", () => {
  // A first byte >= 0x80 sets the sign bit of the bitwise-OR length. Without
  // the unsigned `>>> 0` coercion this is a huge negative number that slips past
  // the bound check and decodes an empty range as "" instead of "(unknown)".
  const blob = new Uint8Array([0x80, 0, 0, 11, 1, 2, 3, 4, 5]);
  expect(keyTypeFromBlob(blob)).toBe("(unknown)");
});
