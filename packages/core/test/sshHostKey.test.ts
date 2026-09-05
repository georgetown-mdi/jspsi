import { createHash, generateKeyPairSync } from "node:crypto";

import { expect, test } from "vitest";

import {
  computeHostKeyFingerprint,
  keyTypeFromBlob,
  matchHostKeyFingerprint,
} from "../src/utils/sshHostKey";

// Single-pin boolean form: wrap the pin in a one-element list for
// matchHostKeyFingerprint, which returns the matched pin or undefined.
async function verifyHostKeyFingerprint(
  keyBlob: Uint8Array<ArrayBuffer>,
  pin: string,
): Promise<boolean> {
  return (await matchHostKeyFingerprint(keyBlob, [pin])) !== undefined;
}

// Build a 51-byte OpenSSH wire-format blob for a fresh ed25519 key pair.
//
// Wire layout: [uint32 typeLen][type bytes][uint32 keyLen][key bytes]
// Ed25519 SPKI DER is always 44 bytes; the raw 32-byte public key lives at
// bytes 12-43. This matches what ssh2's hostVerifier passes to the callback.
function buildEd25519Blob(): Uint8Array<ArrayBuffer> {
  const { publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const rawKey = spki.slice(12, 44);
  const blob = new Uint8Array(4 + 11 + 4 + 32);
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

// A deterministic ed25519 wire blob whose 32-byte raw key is the bytes 0x00..
// 0x1F. Fixed (not freshly generated) so its fingerprint is a stable, checked-in
// known-answer vector rather than a value re-derived from the same code path.
function buildFixedEd25519Blob(): Uint8Array<ArrayBuffer> {
  const rawKey = new Uint8Array(32);
  for (let i = 0; i < 32; i++) rawKey[i] = i;
  const blob = new Uint8Array(4 + 11 + 4 + 32);
  const view = new DataView(blob.buffer);
  view.setUint32(0, 11, false);
  blob.set(new TextEncoder().encode("ssh-ed25519"), 4);
  view.setUint32(15, 32, false);
  blob.set(rawKey, 19);
  return blob;
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

test("computeHostKeyFingerprint produces the checked-in fixed-blob fingerprint", async () => {
  // Fixed input -> fixed output, so an encoding regression is caught even when a
  // random key happens not to exercise it. This vector contains a `/`, pinning
  // the standard-base64 alphabet (a base64url regression would drop it).
  const fp = await computeHostKeyFingerprint(buildFixedEd25519Blob());
  expect(fp).toBe("SHA256:ZkAslGjFiUHdGf/WUL8rQvkib4PTvQatUV0OUQSncCA");
  expect(fp).toContain("/");
});

// --- verifyHostKeyFingerprint ------------------------------------------------

test("verifyHostKeyFingerprint rejects a one-bit-flipped blob", async () => {
  const blob = buildEd25519Blob();
  const pin = referenceFingerprint(blob);
  const flipped = new Uint8Array(blob);
  flipped[19] ^= 0x01; // flip one bit in the raw key payload
  expect(await verifyHostKeyFingerprint(flipped, pin)).toBe(false);
});

test("verifyHostKeyFingerprint fails closed (returns false, does not throw) on a malformed pin", async () => {
  const blob = buildEd25519Blob();
  // A non-standard-base64 char and a length atob rejects both make atob throw;
  // the verifier must swallow that and return false rather than reject. The
  // empty body decodes cleanly to zero bytes and is a length mismatch -> false.
  expect(await verifyHostKeyFingerprint(blob, "SHA256:AAA-")).toBe(false);
  expect(await verifyHostKeyFingerprint(blob, "SHA256:AAAAA")).toBe(false);
  expect(await verifyHostKeyFingerprint(blob, "SHA256:")).toBe(false);
});

test("verifyHostKeyFingerprint rejects a decodable but wrong-length pin", async () => {
  const blob = buildEd25519Blob();
  // 42 standard-base64 chars decode cleanly to 31 bytes; bytesEqual's length
  // seed makes a short digest a non-match, never a zero-padded false-accept.
  expect(await verifyHostKeyFingerprint(blob, "SHA256:" + "A".repeat(42))).toBe(
    false,
  );
});

// --- matchHostKeyFingerprint -------------------------------------------------

test("matchHostKeyFingerprint returns the matching pin when it is the only one", async () => {
  const blob = buildEd25519Blob();
  const pin = referenceFingerprint(blob);
  expect(await matchHostKeyFingerprint(blob, [pin])).toBe(pin);
});

test("matchHostKeyFingerprint accepts a key matching the FIRST of several pins", async () => {
  const blob = buildEd25519Blob();
  const pin = referenceFingerprint(blob);
  const other = referenceFingerprint(buildEd25519Blob());
  expect(await matchHostKeyFingerprint(blob, [pin, other])).toBe(pin);
});

test("matchHostKeyFingerprint accepts a key matching a LATER pin (rotation staging)", async () => {
  // The incoming key is staged as the second pin during a rekey window; the
  // matched pin is returned verbatim regardless of its position in the list.
  const blob = buildEd25519Blob();
  const pin = referenceFingerprint(blob);
  const other = referenceFingerprint(buildEd25519Blob());
  expect(await matchHostKeyFingerprint(blob, [other, pin])).toBe(pin);
});

test("matchHostKeyFingerprint returns undefined when the key matches NO pin", async () => {
  const blob = buildEd25519Blob();
  const a = referenceFingerprint(buildEd25519Blob());
  const b = referenceFingerprint(buildEd25519Blob());
  expect(await matchHostKeyFingerprint(blob, [a, b])).toBeUndefined();
});

test("matchHostKeyFingerprint returns undefined for an empty pin list", async () => {
  // No pins can never match a key -- the caller treats this as the no-pin
  // fail-closed posture rather than accepting any key.
  const blob = buildEd25519Blob();
  expect(await matchHostKeyFingerprint(blob, [])).toBeUndefined();
});

test("matchHostKeyFingerprint skips a malformed pin and still matches a valid later one", async () => {
  // A malformed pin (atob rejects the body) must be skipped, not throw, so one
  // bad entry never blocks matching against the rest of the set.
  const blob = buildEd25519Blob();
  const pin = referenceFingerprint(blob);
  expect(await matchHostKeyFingerprint(blob, ["SHA256:AAA-", pin])).toBe(pin);
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
  // type in the mismatch message ("...host key of type '' ..."); a well-formed
  // blob always names a non-empty type, so this is "(unknown)".
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

test("keyTypeFromBlob replaces an invalid-UTF-8 type field", () => {
  // typeLen = 3 with lone continuation bytes (invalid UTF-8, and outside the
  // accepted charset either way). The blob names a type, so this is the
  // placeholder over those bytes rather than the malformed-blob "(unknown)".
  const blob = new Uint8Array([0, 0, 0, 3, 0x80, 0x80, 0x80]);
  expect(keyTypeFromBlob(blob)).toBe("(unknown:808080)");
});

// --- keyTypeFromBlob: the charset and length bound ---------------------------

// A blob naming exactly `keyType`, so the bound is driven with the bytes a
// server would put on the wire rather than a decoded string.
function blobNamingType(keyType: string | Uint8Array): Uint8Array {
  const type =
    typeof keyType === "string" ? new TextEncoder().encode(keyType) : keyType;
  const blob = new Uint8Array(4 + type.length + 32);
  new DataView(blob.buffer).setUint32(0, type.length);
  blob.set(type, 4);
  return blob;
}

// The host-key type names in real-world use: the plain algorithms, the
// security-key forms, and the certificate forms, which hold the `@` and `.`
// the charset exists for. None of them changes on the way through the bound.
const REAL_WORLD_KEY_TYPES = [
  "ssh-ed25519",
  "ssh-rsa",
  "ssh-dss",
  "rsa-sha2-256",
  "rsa-sha2-512",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "sk-ssh-ed25519@openssh.com",
  "sk-ecdsa-sha2-nistp256@openssh.com",
  "ssh-ed25519-cert-v01@openssh.com",
  "ecdsa-sha2-nistp521-cert-v01@openssh.com",
];

test("keyTypeFromBlob returns every real-world key type verbatim", () => {
  for (const keyType of REAL_WORLD_KEY_TYPES)
    expect(keyTypeFromBlob(blobNamingType(keyType))).toBe(keyType);
});

test("keyTypeFromBlob accepts a 64-byte type and replaces a 65-byte one", () => {
  // The length bound, at its edge: 64 bytes is the longest type kept
  // verbatim, matching the bound a partner parses an advertised type under.
  expect(keyTypeFromBlob(blobNamingType("a".repeat(64)))).toBe("a".repeat(64));
  expect(keyTypeFromBlob(blobNamingType("a".repeat(65)))).toBe(
    `(unknown:${"61".repeat(24)})`,
  );
});

test("keyTypeFromBlob replaces a type containing a byte outside the charset", () => {
  // One ESC in an otherwise ordinary type is enough: the whole type is replaced
  // by the hex of its leading bytes, so no byte of it reaches an operator.
  expect(keyTypeFromBlob(blobNamingType("ssh-\x1b[31med25519"))).toBe(
    "(unknown:7373682d1b5b33316d65643235353139)",
  );
  // A space is outside the charset too -- it is what keeps a PEM BEGIN marker
  // out of the accepted range.
  expect(keyTypeFromBlob(blobNamingType("ssh ed25519"))).toBe(
    "(unknown:7373682065643235353139)",
  );
});

test("keyTypeFromBlob separates rejected types that differ within the placeholder's 24 source bytes", () => {
  // The cross-party reconciliation compares the two parties' key types verbatim
  // and narrows its wording when they are EQUAL, so two rejected types that
  // differ inside the bytes the placeholder encodes stay different values.
  const first = keyTypeFromBlob(blobNamingType("\x00first"));
  const second = keyTypeFromBlob(blobNamingType("\x00second"));
  expect(first).not.toBe(second);
  expect(first).not.toBe("(unknown)");
  expect(second).not.toBe("(unknown)");
});

test("keyTypeFromBlob collapses rejected types that differ only past those 24 bytes", () => {
  // The far side of the same boundary: the placeholder encodes 24 source bytes,
  // so types agreeing over all of them are one value however far they diverge
  // after it -- the bound under which the separation above holds.
  const sharedPrefix = "\x00" + "a".repeat(23);
  const collapsed = keyTypeFromBlob(blobNamingType(sharedPrefix + "first"));
  expect(collapsed).toBe(`(unknown:00${"61".repeat(23)})`);
  expect(keyTypeFromBlob(blobNamingType(sharedPrefix + "second"))).toBe(
    collapsed,
  );
});

test("keyTypeFromBlob's placeholder fits the bound a partner parses under", () => {
  // The partner reads an advertised key type under z.string().max(64); a
  // longer placeholder would make this party's advertisement be treated as
  // malformed and drop the reconciliation entirely.
  for (const type of [
    new Uint8Array(1),
    new Uint8Array(24).fill(0xff),
    new Uint8Array(4096).fill(0xff),
  ])
    expect(keyTypeFromBlob(blobNamingType(type)).length).toBeLessThanOrEqual(
      64,
    );
});

test("keyTypeFromBlob's placeholder framing is not forgeable by a server", () => {
  // The parentheses lie outside the accepted charset, so a server naming its key
  // type after a placeholder gets a placeholder OVER those bytes rather than the
  // string it chose -- there is no type a server can send to impersonate one.
  const forged = "(unknown:00)";
  expect(keyTypeFromBlob(blobNamingType(forged))).not.toBe(forged);
  expect(keyTypeFromBlob(blobNamingType(forged))).toMatch(
    /^\(unknown:[0-9a-f]+\)$/,
  );
  expect(keyTypeFromBlob(blobNamingType("(unknown)"))).not.toBe("(unknown)");
});
