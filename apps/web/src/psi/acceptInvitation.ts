import { decodeInvitation } from "@psilink/core";

import type { InvitationToken, WebRTCEndpoint } from "@psilink/core";

/** A decoded invitation that has passed every locally-checkable precondition for
 * acceptance: valid format/checksum (via `decodeInvitation`), not expired, and
 * carrying a WebRTC endpoint to dial. */
export interface AcceptableInvitation {
  token: InvitationToken;
  /** The WebRTC signaling endpoint, narrowed from the token's
   * `connectionEndpoint`, that the acceptor dials. */
  endpoint: WebRTCEndpoint;
}

/**
 * Decode and validate an encoded invitation for acceptance, failing closed
 * before any rendezvous or connection is attempted.
 *
 * `decodeInvitation` validates format and checksum but deliberately does not
 * check expiry, so this compares `token.expires` against `now` and rejects an
 * expired token here. It also requires a WebRTC `connectionEndpoint`: the web
 * acceptor reaches the inviter only through the PeerJS signaling endpoint the
 * invitation carries, so a token without one (or carrying a different channel)
 * cannot be accepted in the browser. Because every failure throws, a caller that
 * only proceeds to connect on success cannot dial on an expired or malformed
 * invitation.
 *
 * @param encoded  The encoded invitation string (bare code or deep-link
 *                 fragment).
 * @param now      The instant to compare `expires` against; injectable for tests.
 * @throws {Error}    on an expired token, or one without a WebRTC endpoint.
 * @throws {Error}    on invalid base64url or a checksum mismatch (`decodeInvitation`).
 * @throws {ZodError} on schema validation failure (`decodeInvitation`).
 */
export async function prepareAcceptedInvitation(
  encoded: string,
  now: Date = new Date(),
): Promise<AcceptableInvitation> {
  const token = await decodeInvitation(encoded);

  if (token.expires !== undefined && new Date(token.expires) <= now) {
    throw new Error(
      "This invitation has expired. Ask your partner to send a new one.",
    );
  }

  const endpoint = token.connectionEndpoint;
  if (endpoint === undefined || endpoint.channel !== "webrtc") {
    throw new Error(
      "This invitation does not carry a WebRTC connection endpoint, so it " +
        "cannot be accepted in the browser.",
    );
  }

  return { token, endpoint };
}
