/**
 * Fast re-invite from a stored managed record: the recovery for a lapsed, desynced,
 * restored, or persist-failed exchange (see docs/MANAGED_EXCHANGE.md, "Recovery: fast
 * re-invite"). "Fast" means the record retains everything a re-invite needs that is
 * NOT the secret -- this party's exchange-file document, with its terms and rendezvous
 * locator -- so a re-invite reuses the standing definition and only re-mints and
 * re-exchanges the setup secret, rather than re-authoring the exchange. The operator
 * re-authors nothing.
 *
 * Re-invite is an INVITER-role act. The invitation carries the linkage terms in the
 * inviter's own namespace, which the partner's accept mirrors into its perspective
 * (core's `deriveAcceptedLinkageTerms`) and locks its receive set against. Only the
 * `side: "inviter"` party holds those terms verbatim; the acceptor's stored document
 * is its own MIRRORED perspective (identity replaced, payload mirrored) and cannot be
 * reversed to the original inviter terms, so the acceptor does not re-mint -- its
 * recovery is "your partner sends a fresh invitation; accept it here" (see
 * {@link canReinviteFromRecord}). This mirrors the CLI, where a re-invite is generated
 * from the existing configuration by the inviting party.
 *
 * What the freshly minted invitation must carry so the partner's accept still locks in
 * correctly, sourced from the stored inviter document:
 *
 * - `linkageTerms` -- the document's terms verbatim (the inviter's own perspective),
 *   so the partner adopts the same set it did originally.
 * - `disclosedPayloadColumns` -- the document's own committed send set (empty is a
 *   strict "sends nothing" commitment and is preserved; absent stays absent), so the
 *   partner's receive lock-in re-crystallizes to the same set it consented to -- never
 *   a re-derivation that could drift.
 * - `connectionEndpoint` -- built FRESH from this app's current signaling location,
 *   not the document's stored `server` locator: the inviter derives its rendezvous
 *   from `window.location` on the re-run path, so the stored locator is inert (see
 *   docs/spec/MANAGED_EXCHANGE_RECORD.md, "Role: a local `side` field").
 * - `sharedSecret` -- a fresh setup secret, superseding the desynced one.
 * - `expires` -- a fresh bounded setup lifetime on the TOKEN (the invitation-in-
 *   transit bound). The RECORD's own `expires` is re-derived from the max-age policy,
 *   never the setup lifetime -- the record's `expires` provenance is single-source
 *   (see {@link buildReinviteRotation}).
 *
 * The ongoing cost this recovery carries, which the copy must not hide: every
 * re-invite puts a fresh live setup secret on the out-of-band channel, so the
 * invitation-confidentiality requirement is ongoing, not one-time (see
 * docs/MANAGED_EXCHANGE.md, "Recovery: fast re-invite").
 *
 * Pure and platform-free: this module composes the token and computes the record's
 * rotation write-back; the store write, the download, and `window.location` live in
 * the host. Secret generation and token encoding are core's, injected so the
 * composition stays testable without real crypto.
 */

import {
  INVITATION_LIFETIME_SECONDS,
  MAX_INVITATION_LIFETIME_SECONDS,
} from "@psilink/core";

import { deepLinkFor, webrtcEndpointFromLocation } from "./invitation";
import { rotationWriteBack } from "./managedRunRotate";

import type { InvitationLocation } from "./invitation";
import type { InvitationToken } from "@psilink/core";
import type { ManagedExchangeRecord } from "./managedExchangeRecord";
import type { RotationWriteBack } from "./managedRunRotate";

/**
 * Whether a record can re-invite from its own stored document. Only the inviter side
 * can: it holds the linkage terms in the inviter's namespace verbatim. The acceptor's
 * stored terms are its mirrored perspective and cannot be reversed to the original
 * inviter terms, so its recovery is to accept a fresh invitation from the partner, not
 * to re-mint one.
 */
export function canReinviteFromRecord(record: ManagedExchangeRecord): boolean {
  return record.side === "inviter";
}

/** The freshly minted re-invite artifacts plus the record write the recovery
 * persists. The operator forwards {@link encoded}/{@link deepLink} out-of-band; the
 * host writes {@link rotation} to the record so this party's own re-run listens on the
 * rendezvous the fresh secret derives, superseding the desynced secret. */
export interface ManagedReinvite {
  /** The encoded invitation string -- the bare-string copy artifact. */
  encoded: string;
  /** The deep-link URL carrying the token in its fragment -- the URL copy artifact. */
  deepLink: string;
  /** The fresh setup secret the token carries and the record adopts. */
  sharedSecret: string;
  /** The token's bounded setup expiry (the invitation-in-transit bound), ISO 8601. */
  tokenExpires: string;
  /** The record rotation to persist: the fresh secret and the record's own `expires`
   * re-derived from the max-age policy (never the setup lifetime). */
  rotation: RotationWriteBack;
}

/**
 * Compute the record write a re-invite persists: the fresh setup secret and the
 * record's `expires` re-derived from the max-age policy, exactly as a rotation would
 * restamp it -- through {@link rotationWriteBack}, so the date math and its guards are
 * reused, not duplicated. The setup lifetime never flows into the record's `expires`
 * (its provenance is single-source, the max-age stamp), so a record with no policy
 * clears any standing bound and a record with a policy stamps `now + tokenMaxAgeDays`.
 *
 * @throws {RangeError} (from {@link rotationWriteBack}) if the policy is not a
 *   positive integer or stamps an expiry outside the representable range.
 */
export function buildReinviteRotation(
  freshSecret: string,
  tokenMaxAgeDays: number | undefined,
  now: number,
): RotationWriteBack {
  return rotationWriteBack(freshSecret, tokenMaxAgeDays, now);
}

/**
 * Build the fresh invitation token a re-invite mints from the stored inviter
 * document: the document's linkage terms and committed send set verbatim, a fresh
 * webrtc endpoint from the current location, the fresh setup secret, and the bounded
 * setup expiry. The token carries no credential -- the endpoint is credential-free by
 * construction and `encodeInvitation` re-validates it through the strict endpoint
 * schema (see {@link ./invitation.ts}).
 *
 * The document's `disclosedPayloadColumns` is carried through verbatim, including the
 * strict empty set; only an absent field is omitted, so the token cannot mint a
 * commitment the document did not carry.
 */
export function buildReinviteToken(
  record: ManagedExchangeRecord,
  location: InvitationLocation,
  freshSecret: string,
  tokenExpires: string,
): InvitationToken {
  return {
    version: "1",
    linkageTerms: record.exchangeFile.linkageTerms,
    sharedSecret: freshSecret,
    expires: tokenExpires,
    connectionEndpoint: webrtcEndpointFromLocation(location),
    ...(record.exchangeFile.disclosedPayloadColumns !== undefined
      ? { disclosedPayloadColumns: record.exchangeFile.disclosedPayloadColumns }
      : {}),
  };
}

/** The seams a re-invite injects: fresh-secret generation and token encoding are
 * core's, and the setup lifetime is bounded here exactly as {@link generateInvitation}
 * bounds it, so this seam cannot mint an unbounded or effectively-permanent token. */
export interface ManagedReinviteSeams {
  /** Mint a fresh setup secret (core's `generateSharedSecret`). */
  generateSecret: () => string;
  /** Encode the token to the shareable string (core's `encodeInvitation`). */
  encode: (token: InvitationToken) => Promise<string>;
  /** The instant the setup lifetime and the record's max-age stamp count from. */
  now: () => number;
  /** The setup lifetime in seconds; defaults to the one-hour
   * {@link INVITATION_LIFETIME_SECONDS} and is bounded by
   * {@link MAX_INVITATION_LIFETIME_SECONDS}. */
  lifetimeSeconds?: number;
}

/**
 * Compose a fast re-invite from a stored inviter record: mint a fresh setup secret,
 * build and encode the invitation token from the record's own document, and compute
 * the record rotation the host persists. The operator re-authors nothing -- the terms,
 * the committed send set, and the record's `id`/handle are all retained.
 *
 * @throws {Error} if the record is not the inviter side (only the inviter re-mints; an
 *   acceptor's recovery is to accept the partner's fresh invitation), or if the setup
 *   lifetime is not a finite positive number of seconds within the one-year ceiling.
 * @throws {RangeError} if the max-age policy stamps an expiry outside the range.
 * @throws {ZodError} if the assembled token fails the strict endpoint/schema
 *   validation at encode.
 */
export async function composeManagedReinvite(
  record: ManagedExchangeRecord,
  location: InvitationLocation,
  seams: ManagedReinviteSeams,
): Promise<ManagedReinvite> {
  if (!canReinviteFromRecord(record))
    throw new Error(
      "only the inviter side can re-invite from its stored document; the acceptor " +
        "accepts a fresh invitation from the partner",
    );
  const lifetimeSeconds = seams.lifetimeSeconds ?? INVITATION_LIFETIME_SECONDS;
  if (!Number.isFinite(lifetimeSeconds) || lifetimeSeconds <= 0)
    throw new Error(
      "re-invite lifetimeSeconds must be a finite, positive number of seconds",
    );
  if (lifetimeSeconds > MAX_INVITATION_LIFETIME_SECONDS)
    throw new Error(
      "re-invite lifetimeSeconds must not exceed " +
        `${MAX_INVITATION_LIFETIME_SECONDS} seconds (one year)`,
    );

  const now = seams.now();
  const freshSecret = seams.generateSecret();
  const tokenExpires = new Date(now + lifetimeSeconds * 1000).toISOString();
  const token = buildReinviteToken(record, location, freshSecret, tokenExpires);
  const encoded = await seams.encode(token);
  return {
    encoded,
    deepLink: deepLinkFor(location.origin, encoded),
    sharedSecret: freshSecret,
    tokenExpires,
    rotation: buildReinviteRotation(freshSecret, record.tokenMaxAgeDays, now),
  };
}
