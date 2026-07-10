import {
  ConnectionError,
  authenticateConnection,
  errorMessage,
} from "@psilink/core";

import type {
  AuthResult,
  ConnectionErrorKind,
  HandshakeRole,
  MessageConnection,
} from "@psilink/core";

// ConnectionError kinds that are NOT a peer-trust problem, so a handshake
// failure carrying one is passed through to the caller's generic retry path
// rather than re-tagged as a trust failure: a `transport` link drop (retryable),
// a `closed` deliberate local close (abort-driven teardown), and a `usage` local
// API misuse (a programming fault, not the peer's doing). Every other failure --
// a plain kex auth Error (wrong secret, tamper, malformed/expired credential) or
// a `protocol` ConnectionError (the peer sent out of turn / flooded the inbound
// buffer during the handshake, which is never benign) -- is a trust failure.
const NON_TRUST_KINDS: ReadonlySet<ConnectionErrorKind> = new Set([
  "transport",
  "closed",
  "usage",
]);

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
 * exchange failure turns on the failure's kind. A trust failure -- a wrong
 * secret, a tampered or malformed frame, an expired or malformed credential
 * (which the kex reports as a plain Error), or a `protocol` {@link
 * ConnectionError} from the peer flooding or misordering frames during the
 * handshake -- is re-tagged as a `security`-kind `ConnectionError`. A non-trust
 * connection fault ({@link NON_TRUST_KINDS}: a transport drop, the kex timeout,
 * a deliberate close, or a local usage fault) is re-thrown unchanged, keeping
 * its own kind. The caller's error classifier routes a `security` kind to a
 * distinct authentication-failure alert and everything else to the generic
 * "exchange failed" one.
 *
 * @param mc            The open message connection (a `PeerMessageConnection`).
 * @param exchangeRole  This party's handshake role, the same role passed to
 *                      `runExchange`.
 * @param sharedSecret  The invitation's shared secret, base64url-encoded; both
 *                      peers must hold the same value or the handshake fails
 *                      closed.
 * @param expires       The invitation's `expires` (ISO 8601), if it carries one.
 *                      Threaded into the auth parameters so core's pre- and
 *                      post-handshake expiry guards evaluate it: an invitation
 *                      already past `expires` fails closed before any frame is
 *                      sent, and one that expires during the round-trip fails
 *                      closed after the handshake completes -- both surfacing as
 *                      the `security` trust failure, before any PSI frame. Omit
 *                      (or pass `undefined`) for an unbounded credential, leaving
 *                      both guards no-op (the `expires !== undefined` gate).
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
    // A handshake failure carrying a non-trust ConnectionError (a transport drop
    // -- including the kex timeout, which wraps one as its cause -- a deliberate
    // close, or a local `usage` fault) is passed through unchanged so it keeps
    // its own kind: a transport drop stays retryable, and a local fault is never
    // mislabeled as a trust failure ("Could not verify your partner"). Every
    // other failure is a trust problem -- a plain kex auth Error, or a `protocol`
    // ConnectionError from the peer flooding/misordering frames during the
    // handshake -- and is re-tagged as `security` so the caller routes it to the
    // non-retryable authentication-failure alert. Unrecognized failures default
    // to the trust verdict; this is a trust boundary, so it fails closed.
    if (hasNonTrustConnectionError(error)) throw error;
    const wrapped = new ConnectionError(errorMessage(error), "security", {
      cause: error,
    });
    // Preserve authenticateConnection's psilinkRecoveryHintEmitted tag across the
    // re-wrap: a tagged credential error already carries specific recovery
    // guidance, and the tag tells a higher-level handler not to add a second,
    // generic advisory. The web path now threads the invitation's `expires`, so
    // the expiry-tagged pre- and post-handshake errors (alongside the
    // malformed-secret one) are reachable here; preserving the tag keeps the
    // re-wrap faithful to that contract.
    if (hasRecoveryHint(error))
      (
        wrapped as { psilinkRecoveryHintEmitted?: boolean }
      ).psilinkRecoveryHintEmitted = true;
    throw wrapped;
  }

  // We requested no encryption and expect the peer to do the same, so the
  // transcript-bound decision must be false. If a peer ever requests the
  // application AEAD (a future CLI WebRTC peer, or the deferred web-encryption
  // work, board item 195802633), running runExchange in cleartext while the peer
  // wraps would silently diverge; fail loudly here until that wrap is wired. Only
  // a peer that completed the handshake (so it holds the secret) can set this, so
  // this never fires for an unauthenticated peer. `usage` kind -> the caller's
  // generic alert, not the partner-authentication one (this is a capability
  // mismatch, not a failed handshake).
  if (result.applyEncryption)
    throw new ConnectionError(
      "the peer requested application-layer encryption, which the web " +
        "exchange does not yet apply",
      "usage",
    );
  return result;
}

/**
 * Whether a handshake failure carries a non-trust {@link ConnectionError}
 * ({@link NON_TRUST_KINDS}: a transport drop, a deliberate close, or a local
 * usage fault) anywhere in its `cause` chain. The kex timeout wraps a
 * `transport` ConnectionError as its cause, hence the walk rather than a direct
 * check. A `true` here means the caller passes the failure through unchanged; a
 * trust failure (a plain kex auth Error with no such cause, or a `protocol`
 * ConnectionError) returns `false` and is re-tagged as a security failure. A
 * seen-set guards against a pathological `cause` cycle.
 */
function hasNonTrustConnectionError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let cursor: unknown = error;
  while (typeof cursor === "object" && cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    if (cursor instanceof ConnectionError && NON_TRUST_KINDS.has(cursor.kind))
      return true;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}

/** Whether `error` carries authenticateConnection's `psilinkRecoveryHintEmitted`
 * tag, set on its credential-validation and expiry errors. Per core's contract a
 * tagged message is composed only from local values and already includes its
 * recovery instructions, so a display layer may surface it (sanitized) instead
 * of fixed copy, and must not add a second, generic advisory. */
export function hasRecoveryHint(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { psilinkRecoveryHintEmitted?: unknown })
      .psilinkRecoveryHintEmitted === true
  );
}
