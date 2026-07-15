/**
 * The platform wiring for fast re-invite from a stored record: it plugs core's secret
 * generation and token encoding, this page's location, and the record store into the
 * pure {@link composeManagedReinvite}, then persists the fresh secret onto the record.
 * Split from the pure composer so the .tsx stays thin and the composition/token shape
 * is testable in Node without real crypto or a database.
 *
 * The record write reuses {@link persistManagedExchangeReinvite}: replacing the
 * desynced secret with the fresh setup secret is the field-scoped rotation write (the
 * secret and the record's own `expires`), it drops the stale `lastRun` the re-invite
 * has just consumed, and it clears the backup and import markers in the same
 * cross-store transaction -- correct here, since the fresh secret stales any prior
 * export and resets the desync/import evidence. The write is awaited before the
 * operator forwards the invitation, so this party's own re-run listens on the
 * rendezvous the fresh secret derives, and the persisted record is returned so the
 * caller drops its stale in-memory copy for the rotated one.
 */

import { encodeInvitation, generateSharedSecret } from "@psilink/core";

import { composeManagedReinvite } from "./managedReinvite";
import { invitationLocation } from "./invitationLocation";
import { persistManagedExchangeReinvite } from "./managedExchangeStore";

import type { ManagedExchangeRecord } from "./managedExchangeRecord";
import type { ManagedReinvite } from "./managedReinvite";

/** The seams the re-invite driver injects, defaulted to the real platform wiring but
 * overridable in a test. */
export interface ManagedReinviteDriverDeps {
  /** Read this page's location for the fresh webrtc endpoint. */
  location: () => ReturnType<typeof invitationLocation>;
  /** Mint a fresh setup secret. */
  generateSecret: () => string;
  /** Encode the composed token to the shareable string. */
  encode: typeof encodeInvitation;
  /** Persist the fresh secret onto the record (the re-invite rotation write). */
  persistRotation: typeof persistManagedExchangeReinvite;
  /** The moment the setup lifetime and the record's max-age stamp count from. */
  now: () => number;
}

const defaultDeps: ManagedReinviteDriverDeps = {
  location: invitationLocation,
  generateSecret: generateSharedSecret,
  encode: encodeInvitation,
  persistRotation: persistManagedExchangeReinvite,
  now: () => Date.now(),
};

/** A completed re-invite: the shareable artifacts the operator forwards out-of-band,
 * plus the record as it now stands in the store -- rotated to the fresh secret with the
 * consumed failure cleared. The caller adopts {@link record} so every subsequent action
 * derives from the fresh secret, never the stale in-memory copy. */
export interface ManagedReinviteResult {
  /** The shareable invitation artifacts (link, code, setup expiry). */
  reinvite: ManagedReinvite;
  /** The persisted record after the re-invite rotation. */
  record: ManagedExchangeRecord;
}

/**
 * Re-invite from a stored inviter record: compose a fresh invitation from the record's
 * own document, persist the fresh secret onto the record, and return the shareable
 * artifacts for the operator to forward out-of-band plus the rotated record. The
 * operator re-authors nothing.
 *
 * The rotation is persisted BEFORE the result is returned, so a persist failure aborts
 * the re-invite (the operator is not handed an invitation the record cannot back). The
 * persisted record -- rotated to the fresh secret, its consumed `lastRun` and its
 * backup/import markers cleared -- is returned so the caller replaces its in-memory
 * copy: a subsequent run must derive the rendezvous from the fresh secret, not the
 * desynced one. Only the inviter side reaches this; the composer throws for an
 * acceptor.
 *
 * @throws {Error} if the record is not the inviter side.
 * @throws {ZodError} if the assembled token fails validation at encode, or the
 *   rotation is invalid.
 */
export async function reinviteManagedExchange(
  record: ManagedExchangeRecord,
  deps: ManagedReinviteDriverDeps = defaultDeps,
): Promise<ManagedReinviteResult> {
  const reinvite = await composeManagedReinvite(record, deps.location(), {
    generateSecret: deps.generateSecret,
    encode: deps.encode,
    now: deps.now,
  });
  const persisted = await deps.persistRotation(record.id, reinvite.rotation);
  return { reinvite, record: persisted };
}
