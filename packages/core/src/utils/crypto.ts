/** Shared `TextEncoder` instance for encoding strings to UTF-8 bytes. */
export const enc = new TextEncoder();

/**
 * Shared fatal `TextDecoder` for decoding UTF-8 bytes to strings. `fatal: true`
 * makes `decode` THROW a `TypeError` on malformed UTF-8 rather than silently
 * substituting U+FFFD - a caller decoding authenticated-but-possibly-malformed
 * bytes (e.g. the AEAD layer) needs the rejection, not silent corruption. Use
 * only for one-shot, non-streaming decodes: never call `decFatal.decode(chunk,
 * { stream: true })` on this shared instance, since streaming mode carries
 * decoder state across calls and would corrupt unrelated decodes elsewhere in
 * the process. A caller that needs streaming must construct its own decoder.
 */
export const decFatal = new TextDecoder("utf-8", { fatal: true });

/**
 * Encode a byte array as a base64url string (no padding).
 */
export function toBase64Url(bytes: Uint8Array<ArrayBuffer>): string {
  // Chunked call avoids the N-element intermediate array that `Array.from`
  // would allocate; 0x8000 is below V8's spread-argument limit on all platforms.
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK)
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/**
 * Encode a byte array as a lowercase hexadecimal string (two characters per
 * byte). Used where an encoding must stay within `[0-9a-f]` -- e.g. a derived
 * PeerJS peer id, whose client-side validator rejects the `-`/`_` that base64url
 * can produce.
 */
export function toHex(bytes: Uint8Array<ArrayBuffer>): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++)
    hex += (bytes[i] as number).toString(16).padStart(2, "0");
  return hex;
}

/**
 * Decode a base64url string (with or without padding) to a byte array.
 *
 * @throws {Error} if `str` is empty, contains non-base64url characters
 *   (including `=` in any position other than trailing padding), or has an
 *   invalid base64 length (`length % 4 === 1`).
 */
export function fromBase64Url(str: string): Uint8Array<ArrayBuffer> {
  if (str.length === 0 || str.length % 4 === 1)
    throw new Error(
      `Invalid base64url string: length ${str.length} is not a valid base64 ` +
        "length",
    );
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(str))
    throw new Error(
      "Invalid base64url string: contains non-base64url characters",
    );
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Constant-time byte comparison.  Returns `true` iff `a` and `b` have equal
 * length and identical contents.
 *
 * The comparison is unconditionally constant-time with respect to content: the
 * loop always runs over `Math.max(a.length, b.length)` iterations regardless
 * of content or length.  Loop count does reveal `max(len_a, len_b)` from
 * timing, but this is unavoidable for variable-length inputs and is not a
 * concern when comparing fixed-length values (e.g. MACs or session keys).
 * The accumulator is seeded with a length-mismatch flag so that unequal-length
 * inputs always return `false` — without the seed, an input that is a
 * zero-padded prefix of the other would XOR `(undefined??0)` against `0` for
 * the extra iterations, contributing nothing to the accumulator and returning
 * `true` incorrectly.
 */
export function bytesEqual(
  a: Uint8Array<ArrayBuffer>,
  b: Uint8Array<ArrayBuffer>,
): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < len; i++)
    // Uint8Array index is typed as `number` but returns undefined out-of-
    // bounds; cast makes the ?? 0 fallback explicit.
    diff |=
      ((a[i] as number | undefined) ?? 0) ^ ((b[i] as number | undefined) ?? 0);
  return diff === 0;
}

/**
 * Derive `lengthBytes` bytes from `ikm` using HKDF-SHA-256 with a zero salt
 * and the given `info` string.
 *
 * A zero salt is used deliberately: `info` carries all domain separation, so
 * the salt adds no security.  RFC 5869 §3.1 explicitly permits this when the
 * IKM is high-entropy key material, which is always true here (callers pass
 * either a session key or a decoded 32-byte base64url token).
 */
export async function hkdfDerive(
  ikm: Uint8Array<ArrayBuffer>,
  info: string,
  lengthBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey(
    "raw",
    ikm,
    { name: "HKDF" },
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(32),
      info: enc.encode(info),
    },
    key,
    lengthBytes * 8,
  );
  return new Uint8Array(bits);
}

/**
 * Compute HMAC-SHA-256 of `data` under `key`.
 *
 * Shared by the key-exchange confirmation MACs (`kex.ts`) and the exchange-record
 * commitment scheme (`exchangeRecord.ts`), which keys it with a per-commitment
 * salt. Uses `crypto.subtle`, so it is identical on Node and in the browser.
 */
export async function hmacSha256(
  key: Uint8Array<ArrayBuffer>,
  data: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, data));
}

/**
 * Compute the SHA-256 digest of `data`. Uses `crypto.subtle`, so it is identical
 * on Node and in the browser; the same bytes hash to the same digest on both.
 */
export async function sha256(
  data: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

/**
 * Return `length` cryptographically random bytes from the platform CSPRNG
 * (`crypto.getRandomValues`). Used for key-exchange ephemeral keys and for the exchange
 * record's binding nonce and per-commitment salts.
 */
export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
}
