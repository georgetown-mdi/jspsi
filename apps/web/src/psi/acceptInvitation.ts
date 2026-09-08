import {
  UsageError,
  assertDeduplicateImplemented,
  countOnlyShapeViolation,
  decodeInvitation,
  deriveAcceptedLinkageTerms,
  isInvitationExpired,
  resolveLinkageCardinality,
  sanitizeErrorForDisplay,
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
 * `deduplicate` is this party's OWN side, taken from the accept seat's control
 * rather than from the invitation, which declares only the inviting party's
 * ({@link acceptorDeduplicateRefusal} answers a pair the run would refuse).
 * Omitted, it defaults to the closed `false` an acceptance derives with no
 * control at all.
 *
 * @param linkageTerms  The inviter's linkage terms from the decoded token.
 * @param acceptorName  The accepting party's name, recorded as the prepared
 *                      terms' identity.
 * @param edits         The acceptor's edited metadata and standardization, when it
 *                      prepared its data; omitted to fall back to CSV inference.
 * @param deduplicate   Whether several of THIS party's records may match one of
 *                      the partner's, as the accepting operator set it.
 */
export function acceptorExchangeDataSpec(
  linkageTerms: LinkageTerms,
  acceptorName: string,
  edits?: AcceptorDataEdits,
  deduplicate: boolean = false,
): ExchangeDataSpec {
  return {
    linkageTerms: deriveAcceptedLinkageTerms(
      linkageTerms,
      acceptorName,
      deduplicate,
    ),
    ...(edits && {
      metadata: edits.metadata,
      standardization: edits.standardization,
    }),
  };
}

/**
 * The identity the accept seat's pre-run deduplicate check stands the operator's
 * own name in for. The check reads the two parties' `deduplicate` values and
 * `linkage_strategy` and nothing else, and it runs while the terms are being
 * reviewed -- before the name field on the consent step. The stand-in is never
 * displayed and never run: the launched terms hold the committed name
 * ({@link acceptorExchangeDataSpec}).
 */
const DEDUPLICATE_CHECK_IDENTITY = "you";

/**
 * Whether the ACCEPTING party may declare a `deduplicate` of its own against
 * this invitation.
 *
 * The schema takes `deduplicate: true` only from a party that receives the
 * result, and the accepting party's `expectsOutput` is the inviting party's
 * `shareWithPartner` mirrored (`deriveAcceptedLinkageTerms`). So a
 * sole-receiver invitation leaves this party no value to set: acceptance
 * applies the closed default, and a document declaring anything else is
 * refused by that derivation.
 *
 * The count-only shape refuses `deduplicate` on the same document for a
 * reason of its own -- a `psi-c` run reports a size and pairs no records --
 * so the shape rule is asked as well, over the document this party would
 * present. Both are core's own rules rather than restatements of them, so a
 * seat offers the control exactly where the accept would take the value, and
 * the operator meets no control whose value it would refuse.
 */
export function acceptorMaySetDeduplicate(linkageTerms: LinkageTerms): boolean {
  return (
    linkageTerms.output.shareWithPartner &&
    countOnlyShapeViolation({ ...linkageTerms, deduplicate: true }) ===
      undefined
  );
}

/**
 * A refusal the accept seat reads before the run, and which side of the accept
 * it belongs to.
 *
 * `pair` is the two parties' `deduplicate` values against this invitation's
 * strategy: the accepting operator resolves it by clearing its own side, so it
 * renders beside that control and holds the step's Continue.
 *
 * `terms` is the invitation mirroring to a document no acceptance can run,
 * whatever this party sets -- nothing at the seat resolves it, so it blocks the
 * accept the way an endpoint this build cannot drive does.
 */
export interface AcceptorDeduplicateRefusal {
  scope: "pair" | "terms";
  message: string;
}

/**
 * The refusal the accepting party's own `deduplicate` value meets against this
 * invitation, or `undefined` when the pair runs -- read at the seat, before the
 * run and before any key or payload moves.
 *
 * It derives the accepting party's terms exactly as a launch does and hands the
 * pair to `resolveLinkageCardinality`, the same boundary the run resolves the
 * joint cardinality at, so the seat refuses exactly the pairs the run refuses
 * and no others. Today that is the agreed `(true, true)` pair under a strategy
 * pairing no `many-to-many` (`assertBothSidedDeduplicateImplemented`); the
 * derivation itself answers a `psi-c` invitation, whose count-only shape holds
 * neither party's `deduplicate` open. A `pair` refusal is the combination's,
 * not the setting's: its message names the strategy to change and the one-sided
 * pair to fall back to, and clearing either party's value runs.
 *
 * The two scopes are told apart by what clearing this party's side does, not by
 * the error's type alone: a refusal the closed default meets as well stands
 * whatever this party sets -- the invitation's own `deduplicate` against its own
 * strategy, or a mirror the schema refuses -- so it is `terms`, and the seat
 * blocks the accept rather than pointing at a control that cannot clear it.
 *
 * It returns for every invitation this build decoded rather than throwing for
 * some of them: the accept screen reads it in its render body, where a throw
 * takes the whole route to its error boundary instead of the refusal the
 * operator can act on. Either scope's message is escaped for display at this
 * boundary, the one that holds it.
 */
export function acceptorDeduplicateRefusal(
  linkageTerms: LinkageTerms,
  deduplicate: boolean,
): AcceptorDeduplicateRefusal | undefined {
  try {
    resolvePresentedCardinality(linkageTerms, deduplicate);
    return undefined;
  } catch (error) {
    const clearingRuns = deduplicate && acceptorClosedDefaultRuns(linkageTerms);
    return {
      scope: error instanceof UsageError && clearingRuns ? "pair" : "terms",
      message: sanitizeErrorForDisplay(error),
    };
  }
}

/**
 * Resolve the joint cardinality of the pair this party's `deduplicate` makes
 * with the invitation, at the boundary the run resolves it at, throwing what
 * the run would throw.
 */
function resolvePresentedCardinality(
  linkageTerms: LinkageTerms,
  deduplicate: boolean,
): void {
  resolveLinkageCardinality(
    deriveAcceptedLinkageTerms(
      linkageTerms,
      DEDUPLICATE_CHECK_IDENTITY,
      deduplicate,
    ),
    linkageTerms,
  );
}

/**
 * Whether this invitation runs with the accepting party's side closed -- the
 * value an acceptance derives with no control at all -- which is what makes a
 * refusal one this party's own control can clear.
 */
function acceptorClosedDefaultRuns(linkageTerms: LinkageTerms): boolean {
  try {
    resolvePresentedCardinality(linkageTerms, false);
    return true;
  } catch {
    return false;
  }
}
