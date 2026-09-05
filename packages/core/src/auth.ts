import { hkdfDerive, toBase64Url, fromBase64Url } from "./utils/crypto.js";
import { runKex } from "./kex.js";

import type { HandshakeRole } from "./types.js";
import type { MessageConnection } from "./connection/messageConnection.js";
import { SHARED_SECRET_REGEX } from "./config/connection.js";
import type { Authentication } from "./config/connection.js";

// --- Public API --------------------------------------------------------------

/**
 * Result returned by {@link authenticateConnection} after a successful P-256
 * key exchange.
 */
export interface AuthResult {
  /**
   * 32-byte session key from the P-256 key exchange. Both parties hold the
   * same value after a successful handshake, with forward secrecy and mutual
   * authentication from the shared secret. A caller that needs
   * application-layer encryption (the `sftp` and `filedrop` channels) passes
   * this to {@link deriveAeadKey} to derive the AES-256-GCM keys, one key per
   * direction rather than per channel. A caller that relies on
   * transport-layer security (e.g. WebRTC with DTLS) may ignore it.
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
  rotatedSecret: string;
  /**
   * The negotiated decision to wrap the connection in an additional
   * application-encryption layer, forwarded from the key exchange
   * ({@link KexResult.applyEncryption}): the OR of this party's
   * `requestEncryption` argument and the peer's request, transcript-bound so
   * both parties agree on it. The caller applies {@link deriveAeadKey} and an
   * `EncryptedMessageConnection` wrap when this is `true`. File-sync callers
   * request encryption unconditionally, so it is always `true` for them.
   */
  applyEncryption: boolean;
}

/**
 * The fixed set of AEAD direction-context labels {@link deriveAeadKey}
 * accepts. The application-layer AEAD channel derives one AES-256-GCM key
 * per direction; both endpoints must pass the same label for a direction to
 * derive the same key.
 *
 * One key per direction, not per channel, because both directions number
 * their messages from zero and build the AEAD nonce from that sequence: a
 * shared key would reuse a key-nonce pair, which is catastrophic for
 * AES-GCM.
 *
 * Add a label only as a reviewed change, appended here -- an unlisted label
 * could be variable, non-ASCII, or non-NFC, so the two parties would derive
 * different keys and AEAD would fail with an opaque auth-tag/decrypt error.
 *
 * Frozen so a plain-JS caller cannot widen the set by pushing a label onto
 * the readonly compile-time type; the runtime guard below checks this set.
 */
export const AEAD_CONTEXTS = Object.freeze([
  "initiator-to-responder",
  "responder-to-initiator",
] as const);

/**
 * An AEAD direction-context label. One of the fixed {@link AEAD_CONTEXTS};
 * the open `string` type is not accepted, so a variable label cannot reach
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
 * The two abort-token roles, frozen for the same reason as {@link AEAD_CONTEXTS}:
 * the readonly compile-time type also holds at runtime, so a plain-JS caller
 * cannot widen the set the runtime guard below checks. One token is derived per
 * role; the writer's own role names the token it writes, the peer's role names
 * the token it verifies. Structurally identical to {@link HandshakeRole}.
 */
export const ABORT_TOKEN_ROLES = Object.freeze([
  "initiator",
  "responder",
] as const);

/** An abort-token role. One of the fixed {@link ABORT_TOKEN_ROLES}. */
type AbortTokenRole = (typeof ABORT_TOKEN_ROLES)[number];

/**
 * Derive a 32-byte per-direction abort token from the session key using HKDF.
 *
 * The token authenticates the cross-party abort marker
 * (`<writerId>-abort.json`): only a party holding the fresh ephemeral session
 * key can produce it, so the untrusted directory admin cannot forge an
 * accepted marker, and a captured marker never validates in another session.
 * The per-direction `role` binds the token to its writer's role, so a marker
 * captured and renamed to the other party's name does not validate.
 *
 * Domain separation: HKDF `info` is not length-prefixed, so each label
 * derived from the session key must be exact-string-distinct and prefix-free
 * against every other one. The only other session-key labels are
 * `psilink-aead-v1:{...}` and `psilink-shared-secret-rotation-v1`;
 * `psilink-abort-token-v1:{initiator,responder}` diverges from both at
 * `abort` vs `aead`/`shared`, and the frozen role set plus the `:` separator
 * guarantee a non-empty role suffix, so no label is a prefix of another.
 *
 * Mirrors {@link deriveAeadKey}: a frozen role tuple plus a runtime allowlist
 * check catches an untyped (plain-JS or `as`-cast) caller.
 *
 * @throws {Error} if `role` is not one of {@link ABORT_TOKEN_ROLES}.
 */
export async function deriveAbortToken(
  sessionKey: Uint8Array<ArrayBuffer>,
  role: AbortTokenRole,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!(ABORT_TOKEN_ROLES as readonly string[]).includes(role)) {
    throw new Error(
      `deriveAbortToken: unknown abort-token role ${JSON.stringify(role)}; ` +
        `expected one of ${ABORT_TOKEN_ROLES.map((r) => JSON.stringify(r)).join(", ")}`,
    );
  }
  return hkdfDerive(sessionKey, `psilink-abort-token-v1:${role}`, 32);
}

/**
 * Whether an ISO 8601 `expires` is at or before `now`. An unparseable value is
 * treated as expired (fail closed): `new Date(bad) <= now` is `false`, so a
 * malformed timestamp from a caller that bypassed key-file validation would
 * otherwise slip past the expiry guards below as if it were still valid.
 */
function isExpired(expires: string, now: number): boolean {
  const expiresMs = new Date(expires).getTime();
  return Number.isNaN(expiresMs) || expiresMs <= now;
}

/**
 * Assert the locally-knowable pre-handshake preconditions on a shared secret:
 * present and well-formed (a base64url 32-byte value matching
 * {@link SHARED_SECRET_REGEX}), and not already expired if `expires` is set.
 * Both conditions are determinable from local state alone, so a caller can
 * run this before opening any connection.
 *
 * {@link runProtocol} (the CLI) does exactly that, so an expired or malformed
 * secret fails before any rendezvous I/O; {@link authenticateConnection} also
 * runs it, as the authoritative boundary for a library consumer that bypasses
 * that orchestration.
 *
 * Both throws are tagged `psilinkRecoveryHintEmitted: true`, since their
 * messages already include specific recovery instructions; a higher-level
 * catch checks the tag and suppresses its own generic advisory.
 *
 * Does NOT cover a secret that expires during the key-exchange round-trip:
 * that is only knowable after the handshake completes, and is enforced by a
 * separate post-handshake check inside {@link authenticateConnection}.
 *
 * Narrows `authentication.sharedSecret` to a non-optional `string` on
 * success.
 *
 * @throws {Error} (tagged with `psilinkRecoveryHintEmitted`) if `sharedSecret`
 *                 is absent or not a base64url-encoded 32-byte value, or if
 *                 `expires` is set and in the past.
 */
export function assertSharedSecretReadyForHandshake(
  authentication: Authentication,
): asserts authentication is Authentication & { sharedSecret: string } {
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

  if (expires !== undefined && isExpired(expires, Date.now())) {
    throw Object.assign(
      new Error(`shared secret expired at ${expires}; obtain a new invitation`),
      { psilinkRecoveryHintEmitted: true },
    );
  }
}

/**
 * Run a P-256 (NNpsk0) authenticated key exchange over an already-open
 * connection.
 *
 * Call this immediately after the connection is established and before
 * `runExchange` (exported from `./exchange.ts`). Both parties must call it
 * with the same `sharedSecret`, or the key-confirmation step fails and this
 * function throws.
 *
 * Runtime contract: {@link Authentication}'s `sharedSecret` is typed
 * optional only for parse-time intermediate states (e.g. a config file
 * loaded before the key file is injected). By the time this function runs
 * it must be a string matching {@link SHARED_SECRET_REGEX}, or this function
 * throws synchronously, before any network activity, with a tagged recovery
 * error. A library consumer that bypasses the CLI's config loader is
 * responsible for ensuring the secret is present.
 *
 * Expiry is checked before the handshake begins and again after it
 * completes; if `authentication.expires` is in the past at either point,
 * this function throws. The post-handshake check covers a secret that
 * expires during the round-trip, bounded by the 30 s per-message handshake
 * timeout: about 30 s worst case for the initiator's one receive, about 60 s
 * for the responder's two.
 *
 * This function's own validation errors (secret format, pre- and
 * post-handshake expiry) are tagged `psilinkRecoveryHintEmitted: true`,
 * since their messages already include recovery instructions; higher-level
 * code should check the tag and suppress its own generic advisory when it
 * is set. A key-exchange failure from `runKex` is not tagged: its message
 * is intentionally generic.
 *
 * @param conn            An open, ready-to-use connection.
 * @param authentication  The authentication block from the connection
 *                        config. `sharedSecret` must be present.
 * @param handshakeRole   This party's role (`"initiator"` or `"responder"`),
 *                        matching the role passed to subsequent protocol
 *                        calls.
 * @param requestEncryption  Whether this party requests an additional
 *                        application-encryption layer over the connection.
 *                        It is bound into the handshake transcript and OR'd
 *                        with the peer's request; the result is returned as
 *                        {@link AuthResult.applyEncryption}. File-sync
 *                        transports pass `true` (the server admin can snoop);
 *                        a transport already end-to-end confidential against
 *                        any in-path party passes `false`.
 *
 * @throws {Error} if `authentication.sharedSecret` is absent or not a
 *                 base64url-encoded 32-byte value.
 * @throws {Error} if `authentication.expires` is in the past before the
 *                 handshake, or if it expires during the key-exchange
 *                 round-trip (post-handshake check).
 * @throws {ConnectionError} of kind `"security"` (message `"key exchange
 *                 authentication failed"`, propagated unwrapped from
 *                 `runKex`) if the key exchange fails: a wrong shared secret
 *                 or tampered messages. The kind is the trust-boundary
 *                 marker consumers classify on; the message stays generic.
 */
export async function authenticateConnection(
  conn: MessageConnection,
  authentication: Authentication,
  handshakeRole: HandshakeRole,
  requestEncryption: boolean,
): Promise<AuthResult> {
  // Narrows `authentication.sharedSecret` to a non-optional string for the
  // rest of this function.
  assertSharedSecretReadyForHandshake(authentication);
  const { sharedSecret, expires } = authentication;

  // runKex takes the raw 32-byte pre-shared secret; the assertion above
  // (SHARED_SECRET_REGEX) guarantees `sharedSecret` decodes to exactly 32 bytes.
  const { sessionKey, applyEncryption } = await runKex(
    conn,
    handshakeRole,
    fromBase64Url(sharedSecret),
    requestEncryption,
  );

  // Post-handshake expiry check: catches a secret that expires during the
  // key-exchange round-trip (see the JSDoc above for the timing budget).
  if (expires !== undefined && isExpired(expires, Date.now())) {
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

  const rotatedSecretBytes = await hkdfDerive(
    sessionKey,
    "psilink-shared-secret-rotation-v1",
    32,
  );
  const rotatedSecret = toBase64Url(rotatedSecretBytes);

  return { sessionKey, rotatedSecret, applyEncryption };
}
