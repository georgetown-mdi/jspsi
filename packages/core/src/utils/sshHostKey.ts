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
  // A zero-length type is malformed -- every real OpenSSH blob names a
  // non-empty key type -- and a length past the blob is truncated. Both yield
  // "(unknown)" rather than letting `subarray` decode an empty ("") or partial
  // range into the operator-facing mismatch message.
  if (typeLen === 0 || typeLen > blob.length - 4) return "(unknown)";
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
 * Return the first fingerprint in `pins` that the raw SSH host-key blob matches,
 * or `undefined` when it matches none. The blob is hashed once and its digest
 * compared against each pin, so a server presenting a host key matching ANY pin
 * is accepted. This is what lets a rotated host key be staged alongside the
 * current one during a rekey window -- pin both and either is accepted, with no
 * failed exchange in between -- then the old entry dropped once the cutover is
 * complete.
 *
 * Returns the MATCHED pin verbatim (canonical, format-validated at config
 * parse), so the caller can record exactly which pinned key the server
 * presented; iteration stops at the first match. A malformed pin (a body `atob`
 * cannot decode) is skipped rather than throwing, so one bad entry fails closed
 * (never matches) without breaking matching against the rest. Nothing secret is
 * compared (a host key and its fingerprint are both public), so the
 * short-circuit on the first match is not a timing concern; the per-pin compare
 * is {@link bytesEqual} for digest-comparison hygiene.
 *
 * @param keyBlob - raw host-key blob from ssh2's `hostVerifier`
 * @param pins - pinned fingerprints in OpenSSH SHA256 format
 */
export async function matchHostKeyFingerprint(
  keyBlob: Uint8Array<ArrayBuffer>,
  pins: readonly string[],
): Promise<string | undefined> {
  const digest = await sha256(keyBlob);
  for (const pin of pins) {
    let pinBytes: Uint8Array;
    try {
      pinBytes = fromBase64Unpadded(pin.slice("SHA256:".length));
    } catch {
      // A pin body atob rejects (a non-standard-base64 char, or a length it
      // refuses) cannot match any key -- skip it rather than let the exception
      // escape this verification primitive, so one bad entry never blocks a
      // match against the rest.
      continue;
    }
    if (
      bytesEqual(
        digest as Uint8Array<ArrayBuffer>,
        pinBytes as Uint8Array<ArrayBuffer>,
      )
    )
      return pin;
  }
  return undefined;
}

/**
 * Extract the SSH key-type string from a raw OpenSSH host-key blob.
 *
 * @internal Exported for use in the mismatch error message; the key type
 * names the algorithm (e.g. "ssh-ed25519") so an operator who needs to
 * re-pin against a different key type can identify it without a separate tool.
 */
export { keyTypeFromBlob };
