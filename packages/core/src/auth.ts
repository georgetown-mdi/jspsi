import { hkdfDerive, toBase64Url } from "./utils/crypto.js";
import { runSpake2 } from "./pake.js";

import type { Connection, HandshakeRole } from "./types.js";
import type { Authentication } from "./config/connection.js";

// --- Public API --------------------------------------------------------------

/**
 * Result returned by {@link authenticateConnection} after a successful SPAKE2
 * handshake.
 */
export interface AuthResult {
  /**
   * 32-byte SPAKE2 session key (`Ke`).  Both parties hold the same value after
   * a successful handshake.  Callers that need application-layer encryption
   * (e.g. `sftp` and `filedrop` channels) should pass this to
   * {@link deriveAeadKey} to obtain a full-strength AES-GCM key; callers
   * that rely on transport-layer security (e.g. WebRTC with DTLS) may ignore
   * it.
   */
  sessionKey: Uint8Array<ArrayBuffer>;
  /**
   * Rotated PAKE token derived deterministically from `sessionKey`.  Both
   * parties compute the same value; no extra round-trip is required.  The
   * caller is responsible for persisting this to `.psilink.key` so that future
   * exchanges use the rotated credential.
   *
   * The value is a base64url-encoded 32-byte HKDF output.  It has no
   * expiration and is suitable for use as a persistent shared secret.
   */
  newToken: string;
}

/**
 * Derive a 32-byte AES-256-GCM key from the SPAKE2 session key using HKDF.
 *
 * Use this when the connection channel requires application-layer encryption.
 * Call it after {@link authenticateConnection} and pass the result to the
 * channel's encryption layer.
 *
 * @param sessionKey  The `sessionKey` field from {@link AuthResult}.
 * @param context     An application-specific context string that binds the
 *                    derived key to its intended use (e.g. `"sftp-aead"`).
 */
export async function deriveAeadKey(
  sessionKey: Uint8Array<ArrayBuffer>,
  context: string,
): Promise<Uint8Array<ArrayBuffer>> {
  return hkdfDerive(sessionKey, `psilink-aead-v1:${context}`, 32);
}

/**
 * Run a SPAKE2 mutual-authentication handshake over an already-open
 * connection.
 *
 * Call this immediately after the connection is established and before
 * {@link runExchange}.  Both parties must call it with the same `pakeToken`;
 * if they do not, the MAC confirmation step will fail and this function throws.
 *
 * Expiry is checked before the handshake begins.  If
 * `authentication.expires` is set and is in the past, this function throws
 * without sending any messages.
 *
 * @param conn            An open, ready-to-use connection.
 * @param authentication  The authentication block from the connection config.
 *                        `pakeToken` must be present.
 * @param handshakeRole   This party's role (`"initiator"` or `"responder"`),
 *                        matching the role passed to subsequent protocol calls.
 *
 * @throws {Error} if `authentication.pakeToken` is absent or not a
 *                 base64url-encoded 32-byte value.
 * @throws {Error} if `authentication.expires` is in the past.
 * @throws {Error} if the SPAKE2 handshake fails (wrong token or tampered
 *                 messages).
 */
export async function authenticateConnection(
  conn: Connection,
  authentication: Authentication,
  handshakeRole: HandshakeRole,
): Promise<AuthResult> {
  const { pakeToken, expires } = authentication;

  if (!pakeToken || !/^[A-Za-z0-9_-]{43}$/.test(pakeToken)) {
    throw new Error(
      "authentication.pakeToken must be a base64url-encoded 32-byte value",
    );
  }

  if (expires !== undefined && new Date(expires) <= new Date()) {
    throw new Error(
      `PAKE token expired at ${expires}; obtain a new invitation`,
    );
  }

  const { sessionKey } = await runSpake2(conn, handshakeRole, pakeToken);

  const newTokenBytes = await hkdfDerive(
    sessionKey,
    "psilink-token-rotation-v1",
    32,
  );
  const newToken = toBase64Url(newTokenBytes);

  return { sessionKey, newToken };
}
