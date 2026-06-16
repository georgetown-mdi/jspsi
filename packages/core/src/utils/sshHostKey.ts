import { sha256, bytesEqual } from "./crypto.js";

/**
 * Parse the SSH key-type string from a raw OpenSSH host-key blob.
 *
 * The blob wire format is a sequence of length-prefixed strings; the first
 * string is the key type (e.g. "ssh-ed25519", "ecdsa-sha2-nistp256",
 * "ssh-rsa"). Returns "(unknown)" when the blob is too short or malformed
 * rather than throwing, so a partial packet does not break the verifier's
 * error message.
 */
function keyTypeFromBlob(blob: Uint8Array): string {
  if (blob.length < 4) return "(unknown)";
  // The length prefix is a wire-format uint32. Coerce the bitwise-OR result to
  // unsigned with `>>> 0`: without it a first byte >= 0x80 sets the sign bit and
  // yields a negative `typeLen`, which slips past the `> blob.length - 4` bound
  // check and makes `subarray(4, 4 + typeLen)` decode an empty range as "" rather
  // than falling through to "(unknown)".
  const typeLen =
    (((blob[0] as number) << 24) |
      ((blob[1] as number) << 16) |
      ((blob[2] as number) << 8) |
      (blob[3] as number)) >>>
    0;
  if (typeLen > blob.length - 4) return "(unknown)";
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      blob.subarray(4, 4 + typeLen),
    );
  } catch {
    return "(unknown)";
  }
}

/**
 * Encode bytes as unpadded standard base64 (alphabet `[A-Za-z0-9+/]`, no `=`
 * padding). OpenSSH fingerprints use this encoding, not base64url.
 */
function toBase64Unpadded(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK)
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary).replace(/=+$/, "");
}

/**
 * Decode an unpadded standard base64 string to bytes.
 * Used for constant-time comparison against the stored pin bytes.
 */
function fromBase64Unpadded(b64: string): Uint8Array {
  const binStr = atob(b64);
  const bytes = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++)
    bytes[i] = binStr.charCodeAt(i) as number;
  return bytes;
}

/**
 * Compute the OpenSSH SHA256 fingerprint of a raw SSH host-key blob.
 *
 * The fingerprint is `SHA256:` followed by the unpadded standard base64
 * (not base64url) encoding of the SHA-256 digest of the blob. This matches
 * what OpenSSH displays and what operators paste into configs.
 *
 * @param keyBlob - raw host-key blob as received from ssh2's `hostVerifier`
 *   callback (no `hostHash` must be set -- `hostHash` causes ssh2 to
 *   pre-hash the key before passing it here, destroying the raw bytes needed
 *   for this computation).
 */
export async function computeHostKeyFingerprint(
  keyBlob: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const digest = await sha256(keyBlob);
  return "SHA256:" + toBase64Unpadded(digest);
}

/**
 * Verify that a raw SSH host-key blob matches a pinned fingerprint string.
 *
 * The comparison is constant-time (via {@link bytesEqual} over the decoded
 * digest bytes) so a timing side-channel cannot distinguish a wrong prefix
 * from a wrong suffix. Returns `true` only when the digest of `keyBlob`
 * exactly equals the digest encoded in `pin`.
 *
 * @param keyBlob - raw host-key blob from ssh2's `hostVerifier`
 * @param pin - pinned fingerprint in OpenSSH SHA256 format, e.g.
 *   `SHA256:abc...xyz` (50 characters total: the 7-character `SHA256:` prefix
 *   plus 43 unpadded base64 characters for the 32-byte digest; validated at
 *   config-parse time by {@link HOST_KEY_FINGERPRINT_REGEX})
 */
export async function verifyHostKeyFingerprint(
  keyBlob: Uint8Array<ArrayBuffer>,
  pin: string,
): Promise<boolean> {
  const digest = await sha256(keyBlob);
  const pinBytes = fromBase64Unpadded(pin.slice("SHA256:".length));
  return bytesEqual(
    digest as Uint8Array<ArrayBuffer>,
    pinBytes as Uint8Array<ArrayBuffer>,
  );
}

/**
 * Extract the SSH key-type string from a raw OpenSSH host-key blob.
 *
 * @internal Exported for use in the mismatch error message; the key type
 * names the algorithm (e.g. "ssh-ed25519") so an operator who needs to
 * re-pin against a different key type can identify it without a separate tool.
 */
export { keyTypeFromBlob };
