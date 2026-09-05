import { sha256, bytesEqual } from "./crypto.js";

/**
 * The longest host-key type returned verbatim, in bytes. It matches the bound
 * the PARTNER's advertised key type is parsed under (`protocolSetup.ts`), so a
 * type this party accepts is always one the partner can read back for the
 * cross-party reconciliation. Real-world types sit well inside it: the longest
 * names are the certificate forms, around 40 bytes
 * (`ecdsa-sha2-nistp521-cert-v01@openssh.com`).
 */
const MAX_KEY_TYPE_BYTES = 64;

/**
 * How many bytes of a non-conforming type the placeholder encodes. The
 * `(unknown:` and `)` framing costs 10 characters, so {@link MAX_KEY_TYPE_BYTES}
 * admits 27 source bytes at most; 24 encodes to 48 hex digits for a placeholder
 * of 58, keeping headroom under the bound rather than sitting against it.
 */
const PLACEHOLDER_SOURCE_BYTES = 24;

/** What a blob holding no readable type at all yields. */
const UNREADABLE_KEY_TYPE = "(unknown)";

/**
 * Whether a byte may appear in a host-key type returned verbatim: the charset
 * `[A-Za-z0-9._@-]`, which covers the SSH algorithm names (`ssh-ed25519`,
 * `ecdsa-sha2-nistp256`, `rsa-sha2-512`) plus the `@` and `.` a certificate
 * type has (`ssh-ed25519-cert-v01@openssh.com`). Every accepted byte is
 * below 0x80, so an accepted sequence is its own UTF-8 encoding.
 */
function isAcceptedKeyTypeByte(byte: number): boolean {
  return (
    (byte >= 0x41 && byte <= 0x5a) || // A-Z
    (byte >= 0x61 && byte <= 0x7a) || // a-z
    (byte >= 0x30 && byte <= 0x39) || // 0-9
    byte === 0x2e || // .
    byte === 0x5f || // _
    byte === 0x40 || // @
    byte === 0x2d // -
  );
}

/**
 * The type as a string when every byte is accepted and the length is within
 * bound, `undefined` otherwise. Each accepted byte is ASCII, so its code unit is
 * its character and no decoder is involved.
 */
function acceptedKeyType(typeBytes: Uint8Array): string | undefined {
  if (typeBytes.length > MAX_KEY_TYPE_BYTES) return undefined;
  let type = "";
  for (const byte of typeBytes) {
    if (!isAcceptedKeyTypeByte(byte)) return undefined;
    type += String.fromCharCode(byte);
  }
  return type;
}

/**
 * The stand-in for a type the charset or length bound rejects: `(unknown:`
 * plus the lowercase hex of the type's first {@link PLACEHOLDER_SOURCE_BYTES}
 * bytes, plus `)`. Encoding the offending bytes rather than discarding them
 * keeps two rejected types that differ within those bytes distinguishable,
 * which is what the cross-party reconciliation compares. Two types sharing a
 * {@link PLACEHOLDER_SOURCE_BYTES}-byte prefix collapse to one placeholder;
 * that is a documented limit, not a defect (docs/spec/CHANNEL_SECURITY.md,
 * SFTP host-key verification). The parentheses lie outside the accepted
 * charset, so a server cannot name its key type a string that passes for
 * one of these.
 */
function placeholderKeyType(typeBytes: Uint8Array): string {
  let hex = "";
  for (const byte of typeBytes.subarray(0, PLACEHOLDER_SOURCE_BYTES))
    hex += byte.toString(16).padStart(2, "0");
  return `(unknown:${hex})`;
}

/**
 * Parse the SSH key-type string from a raw OpenSSH host-key blob, bounded so an
 * operator-facing identifier taken off the wire has neither arbitrary bytes
 * nor arbitrary length.
 *
 * The blob wire format is a sequence of length-prefixed strings; the first
 * string is the key type (e.g. "ssh-ed25519", "ecdsa-sha2-nistp256",
 * "ssh-rsa"). The value is server-chosen, so what is returned depends on what
 * the type field holds:
 *
 * - At most {@link MAX_KEY_TYPE_BYTES} bytes, every one of them in
 *   `[A-Za-z0-9._@-]`: the type verbatim. Every real-world key type qualifies.
 * - Any other non-empty type: `(unknown:<hex>)`, encoding the type's leading
 *   bytes (see {@link placeholderKeyType}). At most 58 characters, so it fits
 *   the bound a partner parses an advertised key type under.
 * - A blob holding no type at all -- too short to hold a length prefix, or a
 *   zero, oversized, or past-the-end one: `"(unknown)"` rather than a throw, so
 *   a partial packet does not break the verifier's error message.
 */
function keyTypeFromBlob(blob: Uint8Array): string {
  if (blob.length < 4) return UNREADABLE_KEY_TYPE;
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
  // "(unknown)" rather than letting `subarray` read an empty ("") or partial
  // range into the operator-facing mismatch message.
  if (typeLen === 0 || typeLen > blob.length - 4) return UNREADABLE_KEY_TYPE;
  const typeBytes = blob.subarray(4, 4 + typeLen);
  return acceptedKeyType(typeBytes) ?? placeholderKeyType(typeBytes);
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
 *   callback (`hostHash` must not be set -- `hostHash` causes ssh2 to
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
 * Return the first fingerprint in `pins` that the raw SSH host-key blob
 * matches, or `undefined` when it matches none. The blob is hashed once
 * and compared against each pin, so a key matching ANY pin is accepted --
 * this is what lets a rotated host key be staged alongside the current one
 * during a rekey window (pin both, then drop the old entry once cutover
 * completes) with no failed exchange in between.
 *
 * Returns the MATCHED pin verbatim (canonical, format-validated at config
 * parse) so the caller can record which pinned key the server presented;
 * iteration stops at the first match. A malformed pin (one `atob` cannot
 * decode) is skipped rather than thrown, so one bad entry fails closed
 * without blocking a match against the rest. Nothing secret is compared --
 * a host key and its fingerprint are both public -- so the first-match
 * short-circuit is not a timing concern; the per-pin compare is {@link
 * bytesEqual} for digest-comparison hygiene.
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
 * Extract the bounded SSH key-type string from a raw OpenSSH host-key blob.
 *
 * @internal Exported for use in the mismatch error message; the key type
 * names the algorithm (e.g. "ssh-ed25519") so an operator who needs to
 * re-pin against a different key type can identify it without a separate tool.
 * The charset and length bound on what it returns is part of that contract --
 * every consumer displays the value to an operator.
 */
export { keyTypeFromBlob };
