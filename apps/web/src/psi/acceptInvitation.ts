import { decodeInvitation, isInvitationExpired } from "@psilink/core";

import type {
  ExchangeDataSpec,
  InvitationToken,
  LinkageTerms,
  WebRTCEndpoint,
} from "@psilink/core";

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
 * check expiry, so this calls {@link isInvitationExpired} (which fails closed at
 * the boundary and on an unparseable `expires`) and rejects an expired token
 * here. It also requires a WebRTC `connectionEndpoint`: the web
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
 * @throws {NestingDepthExceededError|NodeCountExceededError} on a token whose
 *   `transform.params` is too deeply nested or too wide for the bounded camelCase
 *   normalization `decodeInvitation` applies; the accept route renders all of
 *   these through `describeDecodeError`.
 */
export async function prepareAcceptedInvitation(
  encoded: string,
  now: Date = new Date(),
): Promise<AcceptableInvitation> {
  const token = await decodeInvitation(encoded);

  if (isInvitationExpired(token.expires, now)) {
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

/**
 * Build the data-preparation spec a web acceptor runs against its own CSV. It
 * adopts the inviter's `linkageTerms` (decoded from the invitation and shown on
 * the consent screen) verbatim, so the PSI run is governed by the terms the
 * acceptor reviewed and consented to rather than a default inferred from the
 * acceptor's own columns -- but it substitutes the acceptor's identity for the
 * inviter's, so the inviter's `identity` does not leak into the acceptor's
 * prepared terms. Mirrors the CLI acceptor's
 * `{ ...token.linkageTerms, identity: myIdentity }` (`apps/cli/src/commands/accept.ts`).
 *
 * Only `linkageTerms` is supplied: {@link prepareForExchange} resolves metadata,
 * standardization, and payloads independently and still infers them from the
 * acceptor's CSV, so the acceptor's column shape keeps driving those while the
 * inviter's keys govern linkage. A `standardization` spec is deliberately not
 * supplied -- that path runs `validateStandardizationAgainstTerms`; leaving
 * standardization to CSV inference (which derives from these same adopted terms)
 * does not trip it.
 *
 * @param linkageTerms  The inviter's linkage terms from the decoded token.
 * @param acceptorName  The accepting party's name, recorded as the prepared
 *                      terms' identity.
 */
export function acceptorExchangeDataSpec(
  linkageTerms: LinkageTerms,
  acceptorName: string,
): ExchangeDataSpec {
  return { linkageTerms: { ...linkageTerms, identity: acceptorName } };
}
