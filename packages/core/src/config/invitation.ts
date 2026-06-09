import { z } from "zod";
import { LinkageTermsSchema } from "./linkageTerms.js";
import type { LinkageTerms } from "./linkageTerms.js";

// --- Connection endpoint -----------------------------------------------------

/**
 * A WebRTC signaling locator: where the acceptor reaches the PeerJS
 * peer-coordination server. Carries no PeerJS API key or other secret.
 */
export interface WebRTCEndpoint {
  channel: "webrtc";
  /** Non-empty hostname. The schema enforces the constraint the type cannot. */
  host: string;
  /** Reachable port, 1-65535 (integer). Enforced by the schema, not the type. */
  port?: number;
  /** URL path for WebRTC signaling; non-empty when present. */
  path?: string;
}

/** An SFTP locator: the host (and optional port and remote path) to reach. */
export interface SFTPEndpoint {
  channel: "sftp";
  /** Non-empty hostname. The schema enforces the constraint the type cannot. */
  host: string;
  /** Reachable port, 1-65535 (integer). Enforced by the schema, not the type. */
  port?: number;
  /** Remote working directory; non-empty when present. */
  path?: string;
}

/** A file-drop locator: the shared directory both parties rendezvous in. */
export interface FileDropEndpoint {
  channel: "filedrop";
  /**
   * Path to the shared directory; the inviter's own path, which the acceptor
   * may need to remap to its local mount.
   */
  path: string;
}

/**
 * A credential-free connection locator an invitation MAY carry so the acceptor
 * can reach the rendezvous point without separate out-of-band setup.
 * Discriminated by `channel`, mirroring `ConnectionConfig` in `connection.ts`.
 *
 * INVARIANT: an endpoint carries only a public locator (signaling URL, SFTP
 * host/port, file-drop path) and MUST NEVER carry credentials -- no password,
 * private key, key file, or PeerJS API key. The per-channel shapes have no
 * field for any of these, and {@link ConnectionEndpointSchema} rejects any
 * field outside the locator allowlist, so a credential cannot ride along. A
 * public locator is not a secret, so including it does not weaken the
 * invitation; see docs/SECURITY_DESIGN.md.
 */
export type ConnectionEndpoint =
  | WebRTCEndpoint
  | SFTPEndpoint
  | FileDropEndpoint;

// Custom error for the strict-object guard below: any field outside a channel's
// locator allowlist is rejected rather than silently stripped. The message
// leads with the allowlist (so a benign extra field like `username` is not
// mischaracterized as an attempted credential) and names the kind of field the
// rule excludes as the reason it is strict, rather than emitting Zod's generic
// "Unrecognized key". The named fields are illustrative, not exhaustive: the
// binding rule is the allowlist (anything that is not channel/host/port/path is
// rejected), so the examples here and in the docs are representative and need
// not enumerate every connection field a future schema might add.
const endpointKeyError: z.core.$ZodErrorMap = (issue) => {
  if (issue.code === "unrecognized_keys") {
    return (
      "a connection endpoint may carry only a credential-free locator " +
      "(channel plus host/port/path); every other field is rejected so that no " +
      "credential or server-identity material (such as a password, private " +
      "key, or host-key fingerprint) can ride along. Remove unexpected " +
      "field(s): " +
      issue.keys.join(", ")
    );
  }
  // Returning undefined delegates to Zod's default error map (the documented
  // signal), so structural failures -- a missing required field, a type
  // mismatch, an unknown channel -- keep their default messages; only the
  // unrecognized-key case is customized here.
  return undefined;
};

// Intentionally no z.ZodType<T> annotation on these members: z.discriminatedUnion
// requires a concrete ZodObject, and the annotation would widen them to
// ZodType<T> and break the union (same rationale as connection.ts). Strict
// objects enforce the locator allowlist, so any credential field is rejected;
// type safety is enforced at the ConnectionEndpointSchema level instead.
const WebRTCEndpointSchema = z.strictObject(
  {
    channel: z.literal("webrtc"),
    host: z.string().min(1),
    // A reachable rendezvous port is 1-65535. Port 0 means "let the OS assign
    // an ephemeral port" and can never be an address an acceptor connects to,
    // so the endpoint is deliberately stricter here than connection.ts (which
    // allows 0): an invitation locator must name a port a peer can reach.
    port: z.int().min(1).max(65535).optional(),
    // Non-empty when present: an empty path is a meaningless locator (a blank
    // signaling path), so omit the field rather than send "".
    path: z.string().min(1).optional(),
  },
  { error: endpointKeyError },
);

const SFTPEndpointSchema = z.strictObject(
  {
    channel: z.literal("sftp"),
    host: z.string().min(1),
    // >= 1: a locator must name a reachable port; see the WebRTCEndpointSchema
    // port note (0 is an OS-assigned ephemeral port, never a connect target).
    port: z.int().min(1).max(65535).optional(),
    // Non-empty when present: an empty remote working directory is meaningless;
    // omit the field instead of sending "".
    path: z.string().min(1).optional(),
    // No `username` (or other identity/auth field) by design: those are not
    // part of a public locator. Like credentials, the acceptor configures the
    // SSH identity in the credential portion of its own connection block, so an
    // identity field is intentionally outside the locator allowlist and the
    // strict object rejects it.
  },
  { error: endpointKeyError },
);

// `path` is validated only as non-empty here, NOT as absolute the way
// FileDropConnectionConfigSchema in connection.ts is. Deliberate: a file-drop
// endpoint carries the inviter's own mount path, which the acceptor remaps to
// its local mount before use, so the inviter's path being absolute is not
// meaningful to the acceptor. The acceptor's final connection config is
// re-validated by connection.ts (which does enforce absolute), so a bad path is
// caught where it matters; coupling this schema to that path validator would
// only duplicate the rule. The endpoint's security invariant is "no
// credentials", not "absolute path".
const FileDropEndpointSchema = z.strictObject(
  {
    channel: z.literal("filedrop"),
    path: z.string().min(1),
  },
  { error: endpointKeyError },
);

const ConnectionEndpointSchema: z.ZodType<ConnectionEndpoint> =
  z.discriminatedUnion("channel", [
    WebRTCEndpointSchema,
    SFTPEndpointSchema,
    FileDropEndpointSchema,
  ]);

// --- Token -------------------------------------------------------------------

/**
 * The invitation token passed from inviter to acceptor out-of-band.
 * Carries linkage terms and a short-lived PAKE credential, and MAY carry a
 * credential-free connection endpoint (see {@link ConnectionEndpoint}) so the
 * acceptor can reach the rendezvous point without separate out-of-band setup.
 *
 * The endpoint is a public locator only: the token MUST NEVER carry connection
 * credentials (password, private key, key file, PeerJS API key). Each party
 * still configures the credential portion of its own `connection` block
 * independently. Because the token carries the established PAKE secret -- and,
 * for the web flow, the rendezvous derived from it -- the encoded invitation is
 * confidential and must be forwarded only over a trusted out-of-band channel;
 * see docs/SECURITY_DESIGN.md.
 */
export interface InvitationToken {
  /**
   * Token format version. Increment only on an *incompatible* format change --
   * one an existing decoder could not read correctly. Adding an optional field
   * at THIS top level is backward compatible (an older decoder validates with a
   * non-strict `z.object` and simply ignores the field), so it does not bump the
   * version; `connectionEndpoint` was added this way and the version stayed "1".
   * This does NOT extend to the per-channel endpoint sub-schemas: those use
   * `z.strictObject`, so an older decoder would REJECT (not ignore) any field
   * added to one of them. Adding a field to an endpoint shape is therefore an
   * incompatible change that must bump the version (or otherwise stage compat).
   */
  version: "1";
  linkageTerms: LinkageTerms;
  /**
   * Short-lived PAKE setup credential, rotated to a persistent token on first
   * successful exchange.
   */
  sharedSecret: string;
  /** ISO 8601 datetime after which this token is rejected at accept time. */
  expires?: string;
  /**
   * Optional credential-free connection locator (see
   * {@link ConnectionEndpoint}). Never carries credentials.
   */
  connectionEndpoint?: ConnectionEndpoint;
}

const InvitationTokenSchema: z.ZodType<InvitationToken> = z.object({
  version: z.literal("1"),
  linkageTerms: LinkageTermsSchema,
  sharedSecret: z.string().min(1),
  expires: z.iso.datetime().optional(),
  connectionEndpoint: ConnectionEndpointSchema.optional(),
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
  // Serialize the PARSE RESULT, not the original token. The top-level schema is
  // non-strict (decode must stay forward-compatible: an older decoder ignores a
  // newer token's added field, per the `version` policy), which means a caller
  // who bypasses the types -- e.g. `x as unknown as InvitationToken` -- could
  // otherwise carry an extra top-level field into the invitation verbatim. Zod
  // strips unknown keys on parse, so serializing `validated` makes "only the
  // schema's fields are encoded" a structural guarantee rather than one that
  // rests on TypeScript. (Endpoint sub-schemas are strict, so a credential on
  // the endpoint is already rejected, not merely stripped.)
  const validated = InvitationTokenSchema.parse(token);
  if (
    validated.expires !== undefined &&
    new Date(validated.expires) <= new Date()
  ) {
    throw new Error("invitation expires must be in the future");
  }
  const bytes = new TextEncoder().encode(JSON.stringify(validated));
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
