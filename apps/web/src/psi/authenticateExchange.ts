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
 * Whether it is presented as a retryable transport drop or a non-retryable trust
 * failure hinges on the cause: a transport drop or a deliberate local close
 * (peer unreachable, timeout, abort-driven teardown) is re-thrown unchanged for
 * the caller's generic retry path, while every other handshake failure -- a
 * wrong secret, a tampered or malformed peer frame, an expired or malformed
 * credential -- is re-tagged as a `security`-kind {@link ConnectionError}. This
 * is the web path's first real trust boundary, so an unrecognized failure
 * defaults to the trust verdict rather than the retryable one. The caller's
 * error classifier routes a `security` kind to a distinct authentication-failure
 * alert instead of the generic "exchange failed" one.
 *
 * @param mc            The open message connection (a `PeerMessageConnection`).
 * @param exchangeRole  This party's handshake role, the same role passed to
 *                      `runExchange`.
 * @param sharedSecret  The invitation's shared secret, base64url-encoded; both
 *                      peers must hold the same value or the handshake fails
 *                      closed.
 * @returns The {@link AuthResult}; both peers derive the same `sessionKey`.
 * @throws {ConnectionError} of kind `"security"` on a trust failure; otherwise
 *         the original transport/closed failure, unchanged.
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
    if (isTransportOrClosed(error)) throw error;
    throw new ConnectionError(errorMessage(error), "security", {
      cause: error,
    });
  }
}

/**
 * Whether a handshake failure is a transport drop or a deliberate local close
 * rather than a trust problem. Walks the `cause` chain (the kex timeout wraps a
 * `transport` {@link ConnectionError} as its cause, and an abort-driven teardown
 * surfaces a `closed` one) and matches either kind; a seen-set guards against a
 * pathological `cause` cycle. Everything else -- including a bare auth-failure
 * Error with no connection cause -- is treated as a trust failure by the caller.
 */
function isTransportOrClosed(error: unknown): boolean {
  const seen = new Set<unknown>();
  let cursor: unknown = error;
  while (typeof cursor === "object" && cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    if (
      cursor instanceof ConnectionError &&
      (cursor.kind === "transport" || cursor.kind === "closed")
    )
      return true;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}
