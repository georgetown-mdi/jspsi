import {
  assertDeduplicateImplemented,
  decodeInvitation,
  deriveAcceptedLinkageTerms,
  isInvitationExpired,
} from "@psilink/core";

import type { DeploymentProfile } from "@utils/clientConfig";

import type {
  ConnectionEndpoint,
  ExchangeDataSpec,
  FileDropEndpoint,
  InvitationToken,
  LinkageTerms,
  Metadata,
  SFTPEndpoint,
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
 * holding an endpoint this build can drive. */
export interface AcceptableInvitation {
  token: InvitationToken;
  /** The connection endpoint, narrowed from the token's `connectionEndpoint` to
   * the subset this build can drive: a WebRTC signaling endpoint the acceptor
   * dials in this browser, or -- on a console build -- a file-drop or SFTP
   * endpoint the console runs through the job API. A hosted build never admits
   * file-drop or SFTP (neither is browser-drivable). An SFTP endpoint holds
   * only its credential-free locator (host/port/path); the operator supplies
   * the username, credential, and host-key fingerprint when authoring the
   * connection the console runs. */
  endpoint: WebRTCEndpoint | FileDropEndpoint | SFTPEndpoint;
}

/**
 * Decode and validate an encoded invitation for acceptance, failing closed
 * before any rendezvous or connection is attempted.
 *
 * `decodeInvitation` does not check expiry, so this also calls
 * {@link isInvitationExpired} (fails closed on an unparseable `expires`) and
 * rejects an expired token. It requires a `connectionEndpoint` this build can
 * drive -- webrtc always, filedrop/sftp only on a console build -- matching
 * {@link selectExchangeDriver}'s own allowlist; a non-drivable or missing
 * endpoint is rejected. It also rejects a token whose linkage terms declare a
 * `deduplicate` strategy the run cannot honor (`assertDeduplicateImplemented`),
 * before the consent screen or any connection. Every failure throws.
 *
 * @param encoded  The encoded invitation string (bare code or deep-link
 *                 fragment).
 * @param options.now      The instant to compare `expires` against; injectable
 *                         for tests. Defaults to now.
 * @param options.profile  This build's deployment profile, deciding whether a
 *                         file-drop endpoint is drivable (console only).
 *                         Injected rather than read from the global.
 * @throws {Error}    on an expired token, or one whose endpoint this build cannot
 *   drive.
 * @throws {UsageError} on a token whose linkage terms declare `deduplicate`
 *   under a strategy that matches no deduplicating cardinality
 *   (`assertDeduplicateImplemented`).
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
  if (endpoint === undefined || !endpointDrivableHere(endpoint, profile)) {
    throw new Error(
      "This invitation does not include a connection endpoint this build can " +
        "accept, so it cannot be run here.",
    );
  }

  // The terms half of the fail-closed check: a deduplicating term under a
  // strategy that matches no deduplicating cardinality is refused before the
  // consent screen or any rendezvous, matching the refusal
  // `deriveAcceptedLinkageTerms` applies on the launch path.
  assertDeduplicateImplemented(token.linkageTerms);

  return { token, endpoint };
}

/**
 * Whether THIS build can drive an accepted invitation's connection endpoint: a
 * WebRTC endpoint always (the acceptor reaches the inviter through the PeerJS
 * signaling endpoint), or a file-drop or SFTP endpoint on a console build (the
 * console runs the exchange through its job API). The switch is exhaustive over
 * the channel union with no default, so a newly added channel fails to compile
 * here until classified -- the allowlist discipline, never a blocklist that
 * admits an unvetted channel.
 */
function endpointDrivableHere(
  endpoint: ConnectionEndpoint,
  profile: DeploymentProfile,
): boolean {
  switch (endpoint.channel) {
    case "webrtc":
      return true;
    case "filedrop":
    case "sftp":
      return profile === "console";
  }
}

/**
 * Build the data-preparation spec a web acceptor runs against its own CSV,
 * adopting the inviter's `linkageTerms` (from the invitation) rather than a
 * default inferred from the acceptor's own columns. Fields/keys are adopted
 * verbatim; the acceptor's own perspective comes from
 * {@link deriveAcceptedLinkageTerms}: identity is replaced (the inviter's does
 * not leak into the acceptor's terms), and `output`/`payload` are MIRRORED, not
 * copied (`expectsOutput`/`shareWithPartner` and `send`/`receive` swapped) --
 * a verbatim copy would abort any asymmetric exchange, satisfying
 * `validateCompatibility`'s mirrors only in the symmetric case. Also backs the
 * CLI acceptor (`apps/cli/src/commands/accept.ts`).
 *
 * When the acceptor has prepared its data in the editor, its edited `metadata`
 * and `standardization` are supplied alongside the adopted terms; otherwise
 * {@link prepareForExchange} infers both from the acceptor's CSV. Both are
 * PER-PARTY and LOCAL: not embedded in the token, and `validateCompatibility`
 * compares only `linkageFields`/`linkageKeys`/payload names, so editing them
 * changes only this party's own match rate and disclosure. An explicit
 * `standardization` still runs `validateStandardizationAgainstTerms` (output
 * names must be declared linkage fields); the editor's own output satisfies it
 * (`getDefaultStandardization`).
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
