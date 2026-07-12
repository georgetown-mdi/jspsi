import {
  decodeInvitation,
  deriveAcceptedLinkageTerms,
  isInvitationExpired,
} from "@psilink/core";

import type { DeploymentProfile } from "@utils/clientConfig";

import type {
  ExchangeDataSpec,
  FileDropEndpoint,
  InvitationToken,
  LinkageTerms,
  Metadata,
  Standardization,
  WebRTCEndpoint,
} from "@psilink/core";

/** The per-party data preparation the acceptor authored in its confirm-columns
 * step: the edited column metadata (semantic type + disclosure role) and
 * the standardization pipeline. Both are local to this party, derived from its own
 * CSV, and never cross-checked with the partner -- see
 * {@link acceptorExchangeDataSpec}. */
export interface AcceptorDataEdits {
  metadata: Metadata;
  standardization: Standardization;
}

/** A decoded invitation that has passed every locally-checkable precondition for
 * acceptance: valid format/checksum (via `decodeInvitation`), not expired, and
 * carrying an endpoint this build can drive. */
export interface AcceptableInvitation {
  token: InvitationToken;
  /** The connection endpoint, narrowed from the token's `connectionEndpoint` to
   * the subset this build can drive: a WebRTC signaling endpoint the acceptor
   * dials in this browser, or a file-drop endpoint the console appliance runs
   * through the job API. Never an SFTP endpoint, which is not browser- or
   * appliance-drivable. */
  endpoint: WebRTCEndpoint | FileDropEndpoint;
}

/**
 * Decode and validate an encoded invitation for acceptance, failing closed
 * before any rendezvous or connection is attempted.
 *
 * `decodeInvitation` validates format and checksum but deliberately does not
 * check expiry, so this calls {@link isInvitationExpired} (which fails closed at
 * the boundary and on an unparseable `expires`) and rejects an expired token
 * here. It also requires a `connectionEndpoint` this build can drive: a WebRTC
 * endpoint always (the acceptor reaches the inviter through the PeerJS signaling
 * endpoint the invitation carries), or a file-drop endpoint on a console build
 * (the appliance runs the exchange through its job API). Every other channel --
 * SFTP, or file-drop off a console build -- is rejected, and so is a token with
 * no endpoint. The admitted channels are exactly what {@link selectExchangeDriver}
 * drives (webrtc -> browser, filedrop on console -> server-job); the allowlist is
 * of what THIS build can drive, never a loosening to arbitrary endpoints. Because
 * every failure throws, a caller that only proceeds on success cannot dial or
 * launch on an expired, malformed, or undrivable invitation.
 *
 * @param encoded  The encoded invitation string (bare code or deep-link
 *                 fragment).
 * @param options.now      The instant to compare `expires` against; injectable
 *                         for tests. Defaults to now.
 * @param options.profile  This build's deployment profile, deciding whether a
 *                         file-drop endpoint is drivable (console only). Injected
 *                         rather than read from the global so the guard stays pure
 *                         and testable, mirroring {@link selectExchangeDriver}.
 * @throws {Error}    on an expired token, or one whose endpoint this build cannot
 *   drive.
 * @throws {Error}    on invalid base64url or a checksum mismatch (`decodeInvitation`).
 * @throws {ZodError} on schema validation failure (`decodeInvitation`).
 * @throws {NestingDepthExceededError|NodeCountExceededError} on a token whose
 *   `transform.params` is too deeply nested or too wide for the bounded camelCase
 *   normalization `decodeInvitation` applies; the accept route renders all of
 *   these through `describeDecodeError`.
 */
export async function prepareAcceptedInvitation(
  encoded: string,
  options: { now?: Date; profile: DeploymentProfile },
): Promise<AcceptableInvitation> {
  const { now = new Date(), profile } = options;
  const token = await decodeInvitation(encoded);

  if (isInvitationExpired(token.expires, now)) {
    throw new Error(
      "This invitation has expired. Ask your partner to send a new one.",
    );
  }

  const endpoint = token.connectionEndpoint;
  if (
    endpoint === undefined ||
    !(
      endpoint.channel === "webrtc" ||
      (endpoint.channel === "filedrop" && profile === "console")
    )
  ) {
    throw new Error(
      "This invitation does not carry a connection endpoint this build can " +
        "accept, so it cannot be run here.",
    );
  }

  return { token, endpoint };
}

/**
 * Build the data-preparation spec a web acceptor runs against its own CSV. It
 * adopts the inviter's `linkageTerms` (decoded from the invitation and shown on
 * the consent screen), so the PSI run is governed by the terms the acceptor
 * reviewed and consented to rather than a default inferred from the acceptor's
 * own columns. The agreed fields/keys are adopted verbatim, but the acceptor's
 * own perspective is derived via {@link deriveAcceptedLinkageTerms}: its identity
 * replaces the inviter's (so the inviter's `identity` does not leak into the
 * acceptor's prepared terms), and its `output` and `payload` are MIRRORED, not
 * copied (output's `expectsOutput`/`shareWithPartner` swapped, payload's
 * `send`/`receive` swapped). A verbatim copy only happens to satisfy
 * `validateCompatibility`'s mirrors in the symmetric case and would abort any
 * asymmetric exchange. The payload mirror is what makes the acceptor's `receive`
 * the inviter's `send` (so it validates exactly what it gets) while leaving its
 * `send` open when the inviter left `receive` unauthored. The same helper backs
 * the CLI acceptor (`apps/cli/src/commands/accept.ts`).
 *
 * When the acceptor has prepared its data in the editor, its edited `metadata`
 * and `standardization` are supplied alongside the adopted terms; otherwise
 * {@link prepareForExchange} infers both from the acceptor's CSV. Either way the
 * metadata and standardization are PER-PARTY and LOCAL: they are not embedded in
 * the token and never cross-checked, and `validateCompatibility` compares only
 * `linkageFields` / `linkageKeys` / payload names -- so editing them changes only
 * this party's own match rate and disclosure, never the cross-party agreement or
 * its receipt. Supplying an explicit `standardization` does run
 * `validateStandardizationAgainstTerms` (output names must be declared linkage
 * fields, function names must be known); the editor produces a spec that satisfies
 * it (its outputs are the adopted fields' names, via `getDefaultStandardization`).
 *
 * @param linkageTerms  The inviter's linkage terms from the decoded token.
 * @param acceptorName  The accepting party's name, recorded as the prepared
 *                      terms' identity.
 * @param edits         The acceptor's edited metadata and standardization, when it
 *                      prepared its data; omitted to fall back to CSV inference.
 */
export function acceptorExchangeDataSpec(
  linkageTerms: LinkageTerms,
  acceptorName: string,
  edits?: AcceptorDataEdits,
): ExchangeDataSpec {
  return {
    linkageTerms: deriveAcceptedLinkageTerms(linkageTerms, acceptorName),
    ...(edits && {
      metadata: edits.metadata,
      standardization: edits.standardization,
    }),
  };
}
