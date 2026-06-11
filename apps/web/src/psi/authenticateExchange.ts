import {
  ConnectionError,
  authenticateConnection,
  errorMessage,
} from "@psilink/core";

import type {
  AuthResult,
  HandshakeRole,
  MessageConnection,
} from "@psilink/core";

/**
 * Run the X25519 (NNpsk0) authenticated key exchange over the web exchange's
 * `MessageConnection`, immediately after the data channel opens and before the
 * PSI exchange begins. It reuses core's {@link authenticateConnection} unchanged
 * -- the same handshake, role labels, and token encoding the CLI uses -- so a
 * future CLI WebRTC peer and a web peer compute the same transcript; the crypto
 * is never re-implemented here (re-implementing it fails silently and
 * exploitably).
 *
 * The web handshake role is the exchange role the web already assigns
 * (`"responder"` for the inviter, `"initiator"` for the acceptor): a
 * {@link PeerMessageConnection} has no separate negotiation step, so the same
 * role drives both the handshake and the subsequent PSI exchange.
 *
 * `requestEncryption` is `false`: a WebRTC data channel is end-to-end
 * confidential under DTLS against the peer-coordination server and any TURN
 * relay, so the web path declines the additional application-layer AEAD in the
 * ordinary case (see docs/SECURITY_DESIGN.md, "Channel security"; only a
 * DTLS-terminating WebSocket relay -- not yet a supported transport -- would
 * flip this to `true`). The 32-byte session key is still derived: it is the
 * fruit of authenticating the peer, and the deferred web-encryption work (board
 * item 195802633) consumes it to key {@link EncryptedMessageConnection} once a
 * relay can force the wrap on. This call discards the rotated secret -- web has
 * no key-file persistence, so web exchanges are single-use (also per
 * docs/SECURITY_DESIGN.md).
 *
 * Failure handling fails closed. A handshake failure aborts the exchange before
 * any PSI frame is sent (the caller runs this strictly before `runExchange`).
 * Whether it is presented as a non-retryable trust failure or some other
 * exchange failure hinges on the cause: a trust failure -- a wrong secret, a
 * tampered or malformed peer frame, an expired or malformed credential -- which
 * the kex reports as a plain Error with no {@link ConnectionError} in its cause
 * chain, is re-tagged as a `security`-kind `ConnectionError`; any
 * connection-level fault (a transport drop, a deliberate close, the kex timeout,
 * a local usage fault) carries a `ConnectionError` in its chain and is re-thrown
 * unchanged so it keeps its own kind. The caller's error classifier routes a
 * `security` kind to a distinct authentication-failure alert and everything else
 * to the generic "exchange failed" one.
 *
 * @param mc            The open message connection (a `PeerMessageConnection`).
 * @param exchangeRole  This party's handshake role, the same role passed to
 *                      `runExchange`.
 * @param sharedSecret  The invitation's shared secret, base64url-encoded; both
 *                      peers must hold the same value or the handshake fails
 *                      closed.
 * @returns The {@link AuthResult}; both peers derive the same `sessionKey`.
 * @throws {ConnectionError} of kind `"security"` on a trust failure; otherwise
 *         the original connection-level failure, unchanged.
 */
export async function authenticateExchange(
  mc: MessageConnection,
  exchangeRole: HandshakeRole,
  sharedSecret: string,
): Promise<AuthResult> {
  try {
    return await authenticateConnection(
      mc,
      { sharedSecret },
      exchangeRole,
      false,
    );
  } catch (error) {
    // The kex signals a trust failure (a wrong secret, a tampered or malformed
    // frame, an expired or malformed credential) as a plain Error with no
    // ConnectionError in its cause chain; every connection-level fault carries a
    // ConnectionError somewhere in that chain -- a transport drop or deliberate
    // close directly, the kex timeout as a transport-kind cause, a `usage` fault
    // (e.g. a send after the connection closed) as itself. Pass the latter
    // through unchanged so it keeps its own kind: a transport drop stays
    // retryable, and a local `usage` fault is never mislabeled as a trust
    // failure ("Could not verify your partner"). Re-tag only the former.
    if (hasConnectionError(error)) throw error;
    const wrapped = new ConnectionError(errorMessage(error), "security", {
      cause: error,
    });
    // Preserve authenticateConnection's psilinkRecoveryHintEmitted tag across the
    // re-wrap: a tagged credential error already carries specific recovery
    // guidance, and the tag tells a higher-level handler not to add a second,
    // generic advisory. Web never passes `expires` (so the tagged paths are
    // unreachable today), but keeping the wrapper faithful to the contract guards
    // a future consumer that does.
    if (hasRecoveryHint(error))
      (
        wrapped as { psilinkRecoveryHintEmitted?: boolean }
      ).psilinkRecoveryHintEmitted = true;
    throw wrapped;
  }
}

/**
 * Whether a handshake failure carries a {@link ConnectionError} anywhere in its
 * `cause` chain -- i.e. it is a connection-level fault (transport drop,
 * deliberate close, the kex timeout that wraps a transport error, a local usage
 * fault) rather than a trust problem. The kex reports a trust failure as a plain
 * Error with no such cause, so a `false` here means the caller re-tags it as a
 * security failure. A seen-set guards against a pathological `cause` cycle.
 */
function hasConnectionError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let cursor: unknown = error;
  while (typeof cursor === "object" && cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    if (cursor instanceof ConnectionError) return true;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}

/** Whether `error` carries authenticateConnection's `psilinkRecoveryHintEmitted`
 * tag (set on its credential-validation and expiry errors, whose messages
 * already include recovery instructions). */
function hasRecoveryHint(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { psilinkRecoveryHintEmitted?: unknown })
      .psilinkRecoveryHintEmitted === true
  );
}
