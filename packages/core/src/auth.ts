import { hkdfDerive, toBase64Url, fromBase64Url } from "./utils/crypto.js";
import { runKex } from "./kex.js";

import type { HandshakeRole } from "./types.js";
import type { MessageConnection } from "./connection/messageConnection.js";
import { SHARED_SECRET_REGEX } from "./config/connection.js";
import type { Authentication } from "./config/connection.js";

// --- Public API --------------------------------------------------------------

/**
 * Result returned by {@link authenticateConnection} after a successful X25519
 * key exchange.
 */
export interface AuthResult {
  /**
   * 32-byte session key from the X25519 key exchange.  Both parties hold the
   * same value after a successful handshake; it has forward secrecy (the
   * exchange mixes a fresh ephemeral X25519 DH) and is mutually authenticated
   * by the shared secret.  Callers that need application-layer encryption
   * (the `sftp` and `filedrop` channels) pass this to {@link deriveAeadKey} to
   * derive the AES-256-GCM keys; those keys are per direction, not per channel,
   * so the channels share one AEAD mechanism rather than each having its own
   * key.  Callers that rely on transport-layer security (e.g. WebRTC with DTLS)
   * may ignore it.
   */
  sessionKey: Uint8Array<ArrayBuffer>;
  /**
   * Rotated shared secret derived deterministically from `sessionKey`.  Both
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
 * The fixed set of AEAD direction-context labels accepted by
 * {@link deriveAeadKey}.  The application-layer AEAD channel derives one
 * AES-256-GCM key per direction, so each label is an ASCII-only
 * domain-separation string for one direction of the encrypted stream; both
 * endpoints must pass the same label for a direction to derive the same key.
 *
 * The set is per-direction, not per-channel: the encrypted-connection decorator
 * wraps any channel (`sftp`, `filedrop`, or `webrtc`) and keys only by
 * direction, so there is no per-channel label.  The per-direction split is
 * load-bearing: both directions number their messages from zero and build the
 * AEAD nonce from that sequence, so a single shared key would reuse a key-nonce
 * pair - catastrophic for AES-GCM - whereas one key per sender keeps every pair
 * unique.
 *
 * Adding a label is a deliberate, reviewed change: append it here so a new
 * caller cannot introduce a variable, non-ASCII, or non-NFC context that would
 * make the two parties derive different keys and fail AEAD with an opaque
 * auth-tag/decrypt error.
 *
 * Frozen so the readonly compile-time type also holds at runtime: a plain-JS
 * caller cannot `push` a label and widen the set the runtime guard checks.
 */
export const AEAD_CONTEXTS = Object.freeze([
  "initiator-to-responder",
  "responder-to-initiator",
] as const);

/**
 * An AEAD direction-context label.  One of the fixed {@link AEAD_CONTEXTS}; the
 * open `string` is deliberately not accepted so a variable label cannot reach
 * {@link deriveAeadKey} without a reviewed change to that tuple.
 */
export type AeadContext = (typeof AEAD_CONTEXTS)[number];

/**
 * Derive a 32-byte AES-256-GCM key from the session key using HKDF.
 *
 * Use this when the connection channel requires application-layer encryption.
 * Call it after {@link authenticateConnection} and pass the result to the
 * channel's encryption layer.
 *
 * @param sessionKey  The `sessionKey` field from {@link AuthResult}.
 * @param context     A fixed AEAD direction-context label from
 *                    {@link AEAD_CONTEXTS} (e.g. `"initiator-to-responder"`)
 *                    that binds the derived key to one direction of the
 *                    encrypted stream.  The {@link AeadContext} type rejects a
 *                    free-form label at compile time; the runtime check below
 *                    catches an untyped (plain-JS or `as`-cast) caller, failing
 *                    fast rather than silently deriving a key the two parties
 *                    may not agree on.
 * @throws {Error} if `context` is not one of {@link AEAD_CONTEXTS}.
 */
export async function deriveAeadKey(
  sessionKey: Uint8Array<ArrayBuffer>,
  context: AeadContext,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!(AEAD_CONTEXTS as readonly string[]).includes(context)) {
    throw new Error(
      `deriveAeadKey: unknown AEAD context ${JSON.stringify(context)}; ` +
        `expected one of ${AEAD_CONTEXTS.map((l) => JSON.stringify(l)).join(", ")}`,
    );
  }
  return hkdfDerive(sessionKey, `psilink-aead-v1:${context}`, 32);
}

/**
 * Run an X25519 (NNpsk0) authenticated key exchange over an already-open
 * connection.
 *
 * Call this immediately after the connection is established and before
 * `runExchange` (exported from `./exchange.ts`). Both parties must call it
 * with the same `sharedSecret`;
 * if they do not, the key-confirmation step will fail and this function throws.
 *
 * IMPORTANT — runtime contract: {@link Authentication}'s `sharedSecret` is typed
 * as optional only to accommodate parse-time intermediate states (e.g. a
 * configuration file loaded before the key file is injected). By the time
 * this function is invoked, `authentication.sharedSecret` MUST be populated
 * with a string matching {@link SHARED_SECRET_REGEX}. If it is absent or
 * malformed, this function throws synchronously (before any network activity)
 * with a tagged recovery error. Library consumers that bypass the CLI's
 * config loader are responsible for ensuring the secret is present.
 *
 * Expiry is checked before the handshake begins and again after it completes.
 * If `authentication.expires` is set and is in the past at either point, this
 * function throws.  The post-handshake check catches secrets that expire during
 * the key-exchange round-trip window, bounded by the per-message 30 s handshake
 * timeout: at most one window (~30 s) for the initiator and at most two
 * windows (~60 s) for the responder, which performs two consecutive receives.
 *
 * Errors thrown by this function's own validation checks (secret format,
 * pre-handshake expiry, post-handshake expiry) carry a `psilinkRecoveryHintEmitted:
 * true` property because their messages already include specific recovery
 * instructions. Higher-level code (e.g. the CLI) that adds its own generic
 * recovery advisory should check this property and suppress the generic hint
 * when it is set, to avoid contradictory user-facing messages. Key-exchange
 * protocol failures from `runKex` (generic "key exchange authentication failed"
 * or "key exchange handshake timed out") do not carry the tag because their
 * messages are intentionally generic and benefit from the caller's added
 * advisory.
 *
 * @param conn            An open, ready-to-use connection.
 * @param authentication  The authentication block from the connection config.
 *                        `sharedSecret` must be present.
 * @param handshakeRole   This party's role (`"initiator"` or `"responder"`),
 *                        matching the role passed to subsequent protocol calls.
 *
 * @throws {Error} if `authentication.sharedSecret` is absent or not a
 *                 base64url-encoded 32-byte value.
 * @throws {Error} if `authentication.expires` is in the past before the
 *                 handshake, or if it expires during the key-exchange round-trip
 *                 (post-handshake check).
 * @throws {Error} if the key exchange fails (wrong shared secret or tampered
 *                 messages).
 */
export async function authenticateConnection(
  conn: MessageConnection,
  authentication: Authentication,
  handshakeRole: HandshakeRole,
): Promise<AuthResult> {
  const { sharedSecret, expires } = authentication;

  if (!sharedSecret || !SHARED_SECRET_REGEX.test(sharedSecret)) {
    throw Object.assign(
      new Error(
        "authentication.sharedSecret must be a base64url-encoded 32-byte value " +
          "(43 base64url characters; the final character must be in " +
          "[AEIMQUYcgkosw048]); shared secrets are generated by " +
          "'psilink invite' - to obtain a new one, both parties must re-invite",
      ),
      { psilinkRecoveryHintEmitted: true },
    );
  }

  if (expires !== undefined && new Date(expires) <= new Date()) {
    throw Object.assign(
      new Error(`shared secret expired at ${expires}; obtain a new invitation`),
      { psilinkRecoveryHintEmitted: true },
    );
  }

  // runKex takes the raw 32-byte pre-shared secret; SHARED_SECRET_REGEX above
  // guarantees `sharedSecret` decodes to exactly 32 bytes.
  const { sessionKey } = await runKex(
    conn,
    handshakeRole,
    fromBase64Url(sharedSecret),
  );

  // Post-handshake expiry check: catches secrets that expire during the
  // key-exchange round-trip. Each receive() is bounded by the 30 s handshake
  // timeout; the initiator does one receive (~30 s worst case), the responder
  // does two (~60 s worst case).
  if (expires !== undefined && new Date(expires) <= new Date()) {
    throw Object.assign(
      new Error(
        `shared secret expired at ${expires} during the key-exchange ` +
          `round-trip. The handshake completed but the secret expired before ` +
          `the rotated secret could be derived and returned; both parties ` +
          `must re-invite.`,
      ),
      { psilinkRecoveryHintEmitted: true },
    );
  }

  const newTokenBytes = await hkdfDerive(
    sessionKey,
    "psilink-shared-secret-rotation-v1",
    32,
  );
  const newToken = toBase64Url(newTokenBytes);

  return { sessionKey, newToken };
}
