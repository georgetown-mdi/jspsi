import {
  ConnectionError,
  authenticateConnection,
  causeChainSome,
  errorMessage,
} from "@psilink/core";

import type {
  AuthResult,
  ConnectionErrorKind,
  HandshakeRole,
  MessageConnection,
} from "@psilink/core";

// ConnectionError kinds that are NOT a peer-trust problem: a handshake
// failure holding one passes through unchanged rather than being re-tagged
// as a trust failure. `transport` is a retryable link drop, `closed` a local
// abort-driven teardown, `usage` a local API misuse. Everything else -- a
// plain kex auth Error, or a `protocol` error from the peer flooding or
// misordering frames -- is a trust failure.
const NON_TRUST_KINDS: ReadonlySet<ConnectionErrorKind> = new Set([
  "transport",
  "closed",
  "usage",
]);

/**
 * Run the P-256 (NNpsk0) authenticated key exchange over the web exchange's
 * `MessageConnection`, right after the data channel opens and before the PSI
 * exchange begins. Reuses core's {@link authenticateConnection} unchanged --
 * same handshake, role labels, and token encoding as the CLI -- so a future
 * CLI WebRTC peer and a web peer compute the same transcript. Never
 * reimplement the crypto here: a reimplementation can fail silently and
 * exploitably.
 *
 * The web handshake role is the exchange role the web already assigns
 * (`"responder"` for the inviter, `"initiator"` for the acceptor): the channel
 * {@link openPeerMessageConnection} opens has no separate negotiation step, so
 * the same role drives both the handshake and the subsequent PSI exchange.
 *
 * `requestEncryption` is `false`: a WebRTC data channel is already
 * end-to-end confidential under DTLS against the peer-coordination server
 * and any TURN relay, so the web path declines the extra application-layer
 * AEAD (see docs/SECURITY_DESIGN.md, "Channel security"; only a
 * not-yet-supported DTLS-terminating WebSocket relay would flip this to
 * `true`). The 32-byte session key is still derived, for the deferred
 * web-encryption work to consume once a relay can force the wrap on. The
 * returned {@link AuthResult} holds the rotated secret unchanged: the
 * one-shot flow discards it, a managed exchange feeds it to the run+rotate
 * write-back ({@link ./managedExchangeRun.ts}). This function neither
 * persists nor rotates; it authenticates and returns.
 *
 * Failure handling fails closed. A handshake failure aborts the exchange
 * before any PSI frame is sent. A trust failure -- a wrong secret, a
 * tampered/malformed/expired credential (a plain Error from the kex), or a
 * `protocol` {@link ConnectionError} from the peer flooding or misordering
 * frames -- is re-tagged as a `security`-kind `ConnectionError`. A non-trust
 * fault ({@link NON_TRUST_KINDS}: a transport drop, the kex timeout, a
 * deliberate close, or a local usage fault) is re-thrown unchanged. The
 * caller routes `security` to the authentication-failure alert and
 * everything else to the generic "exchange failed" one.
 *
 * @param mc            The open message connection (a `PeerMessageConnection`).
 * @param exchangeRole  This party's handshake role, the same role passed to
 *                      `runExchange`.
 * @param sharedSecret  The invitation's shared secret, base64url-encoded; both
 *                      peers must hold the same value or the handshake fails
 *                      closed.
 * @param expires       The invitation's `expires` (ISO 8601), if it has one.
 *                      Threaded into the auth parameters so core's pre- and
 *                      post-handshake expiry guards evaluate it, each failing
 *                      closed as the `security` trust failure -- before any
 *                      frame for an already-expired invitation, after the
 *                      handshake for one that expires mid-round-trip. Omit
 *                      (or pass `undefined`) for an unbounded credential.
 * @returns The {@link AuthResult}; both peers derive the same `sessionKey`.
 * @throws {ConnectionError} of kind `"security"` on a trust failure; of kind
 *         `"usage"` if the peer negotiates encryption the web path does not yet
 *         apply; otherwise the original non-trust connection failure, unchanged.
 */
export async function authenticateExchange(
  mc: MessageConnection,
  exchangeRole: HandshakeRole,
  sharedSecret: string,
  expires?: string,
): Promise<AuthResult> {
  let result: AuthResult;
  try {
    result = await authenticateConnection(
      mc,
      { sharedSecret, expires },
      exchangeRole,
      false,
    );
  } catch (error) {
    // Non-trust failures (`hasNonTrustConnectionError`) pass through
    // unchanged, keeping their own kind. Everything else -- including an
    // unrecognized failure -- defaults to the trust verdict and is re-tagged
    // `security`: this is a trust boundary, so it fails closed.
    if (hasNonTrustConnectionError(error)) throw error;
    const wrapped = new ConnectionError(errorMessage(error), "security", {
      cause: error,
    });
    // Preserve authenticateConnection's psilinkRecoveryHintEmitted tag across
    // the re-wrap: a tagged credential error already holds specific recovery
    // guidance, and the tag tells a higher-level handler not to add a second,
    // generic advisory. The web path threads the invitation's `expires`, so the
    // expiry-tagged pre- and post-handshake errors (alongside the
    // malformed-secret one) reach here and need the same preservation.
    if (hasRecoveryHint(error))
      (
        wrapped as { psilinkRecoveryHintEmitted?: boolean }
      ).psilinkRecoveryHintEmitted = true;
    throw wrapped;
  }

  // We requested no encryption and expect the peer to match, so this decision
  // must be false. If a peer ever requests the application AEAD (a future CLI
  // WebRTC peer, or the deferred web-encryption work), running runExchange in
  // cleartext while the peer wraps would silently diverge; fail loudly here
  // until that wrap is wired. Only a peer that completed the handshake (so it
  // holds the secret) can set this, so this never fires for an unauthenticated
  // peer. `usage` kind routes to the caller's generic alert, not the
  // partner-authentication one: a capability mismatch, not a failed handshake.
  if (result.applyEncryption)
    throw new ConnectionError(
      "the peer requested application-layer encryption, which the web " +
        "exchange does not yet apply",
      "usage",
    );
  return result;
}

/**
 * Whether a handshake failure holds a non-trust {@link ConnectionError}
 * ({@link NON_TRUST_KINDS}) anywhere in its `cause` chain -- walked rather
 * than checked directly because the kex timeout wraps a `transport`
 * ConnectionError as its cause. `true` means the caller passes the failure
 * through unchanged; `false` (a plain kex auth Error, or a `protocol`
 * ConnectionError) is re-tagged as a security failure.
 */
function hasNonTrustConnectionError(error: unknown): boolean {
  return causeChainSome(
    error,
    (link) => link instanceof ConnectionError && NON_TRUST_KINDS.has(link.kind),
  );
}

/** Whether `error` holds authenticateConnection's `psilinkRecoveryHintEmitted`
 * tag, set on its credential-validation and expiry errors. Per core's contract
 * a tagged message is composed only from local values and already includes
 * its recovery instructions, so a display layer may show it (sanitized)
 * instead of fixed copy, and must not add a second, generic advisory. */
export function hasRecoveryHint(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { psilinkRecoveryHintEmitted?: unknown })
      .psilinkRecoveryHintEmitted === true
  );
}
