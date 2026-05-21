import { z } from "zod";
import { LinkageTermsSchema } from "./linkageTerms.js";
import type { LinkageTerms } from "./linkageTerms.js";

// --- Token -------------------------------------------------------------------

/**
 * The invitation token passed from inviter to acceptor out-of-band.
 * Carries linkage terms and a short-lived PAKE credential. Connection
 * information is excluded; each party configures their own `connection`
 * block independently.
 */
export interface InvitationToken {
  /** Token format version. Increment when the encoded format changes. */
  version: "1";
  linkageTerms: LinkageTerms;
  /**
   * Short-lived PAKE setup credential, rotated to a persistent token on first
   * successful exchange.
   */
  pakeToken: string;
  /** ISO 8601 datetime after which this token is rejected at accept time. */
  expires?: string;
}

const InvitationTokenSchema: z.ZodType<InvitationToken> = z.object({
  version: z.literal("1"),
  linkageTerms: LinkageTermsSchema,
  pakeToken: z.string().min(1),
  expires: z.iso.datetime().optional(),
});

// --- Base64url helpers -------------------------------------------------------

function toBase64Url(bytes: Uint8Array): string {
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function fromBase64Url(str: string): Uint8Array<ArrayBuffer> {
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    throw new Error("invitation string is not valid base64url");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// --- Encode / Decode ---------------------------------------------------------

// 4 bytes always encodes to exactly 6 unpadded base64url characters (3 bytes ->
// 4 chars, 1 byte -> 2 chars)
const CHECKSUM_CHARS = 6;

/**
 * Serializes an {@link InvitationToken} as a base64url string with a
 * 4-byte truncated-SHA-256 checksum appended for transcription-error
 * detection. The checksum provides no security guarantee; PAKE handles
 * authentication.
 *
 * Uses `btoa`/`atob` and `globalThis.crypto.subtle.digest`
 * (Node.js 19+ / all modern browsers).
 *
 * @throws {Error} if `expires` is set to a time that is not in the future.
 * @throws {ZodError} if the token fails schema validation.
 */
export async function encodeInvitation(
  token: InvitationToken,
): Promise<string> {
  InvitationTokenSchema.parse(token);
  if (token.expires !== undefined && new Date(token.expires) <= new Date()) {
    throw new Error("invitation expires must be in the future");
  }
  const bytes = new TextEncoder().encode(JSON.stringify(token));
  const body = toBase64Url(bytes);
  const hashBuf = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const checksum = toBase64Url(new Uint8Array(hashBuf).slice(0, 4));
  return body + checksum;
}

/**
 * Decodes an invitation string produced by {@link encodeInvitation}, verifying
 * the checksum and validating the payload against the {@link InvitationToken}
 * schema.
 *
 * Uses `btoa`/`atob` and `globalThis.crypto.subtle.digest`
 * (Node.js 19+ / all modern browsers).
 *
 * Does not check whether the token has expired; callers are responsible
 * for comparing `token.expires` against the current time.
 *
 * @throws {Error} on checksum mismatch or invalid base64url.
 * @throws {ZodError} on schema validation failure.
 */
export async function decodeInvitation(
  encoded: string,
): Promise<InvitationToken> {
  if (encoded.length <= CHECKSUM_CHARS) {
    throw new Error("invitation string is too short");
  }
  const body = encoded.slice(0, -CHECKSUM_CHARS);
  const receivedChecksum = encoded.slice(-CHECKSUM_CHARS);

  const bytes = fromBase64Url(body);
  const hashBuf = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const expectedChecksum = toBase64Url(new Uint8Array(hashBuf).slice(0, 4));

  if (receivedChecksum !== expectedChecksum) {
    throw new Error("invitation checksum mismatch");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("invitation payload is not valid JSON");
  }
  return InvitationTokenSchema.parse(raw);
}
