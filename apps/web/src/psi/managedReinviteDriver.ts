/**
 * The platform wiring for fast re-invite from a stored record: it plugs core's secret
 * generation and token encoding, this page's location, and the record store into the
 * pure {@link composeManagedReinvite}, then persists the fresh secret onto the record.
 * Split from the pure composer so the .tsx stays thin and the composition/token shape
 * is testable in Node without real crypto or a database.
 *
 * The record write reuses {@link persistManagedExchangeRotation}: replacing the
 * desynced secret with the fresh setup secret is exactly the field-scoped rotation
 * write (the secret and the record's own `expires`, nothing else), and it clears the
 * backup and import markers in the same cross-store transaction -- correct here, since
 * the fresh secret stales any prior export and resets the desync/import evidence. The
 * write is awaited before the operator forwards the invitation, so this party's own
 * re-run listens on the rendezvous the fresh secret derives.
 */

import { encodeInvitation, generateSharedSecret } from "@psilink/core";

import { composeManagedReinvite } from "./managedReinvite";
import { invitationLocation } from "./invitationLocation";
import { persistManagedExchangeRotation } from "./managedExchangeStore";

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
  /** Persist the fresh secret onto the record (the rotation write). */
  persistRotation: typeof persistManagedExchangeRotation;
  /** The moment the setup lifetime and the record's max-age stamp count from. */
  now: () => number;
}

const defaultDeps: ManagedReinviteDriverDeps = {
  location: invitationLocation,
  generateSecret: generateSharedSecret,
  encode: encodeInvitation,
  persistRotation: persistManagedExchangeRotation,
  now: () => Date.now(),
};

/**
 * Re-invite from a stored inviter record: compose a fresh invitation from the record's
 * own document, persist the fresh secret onto the record, and return the shareable
 * artifacts for the operator to forward out-of-band. The operator re-authors nothing.
 *
 * The rotation is persisted BEFORE the artifacts are returned, so a persist failure
 * aborts the re-invite (the operator is not handed an invitation the record cannot
 * back). Only the inviter side reaches this; the composer throws for an acceptor.
 *
 * @throws {Error} if the record is not the inviter side.
 * @throws {ZodError} if the assembled token fails validation at encode, or the
 *   rotation is invalid.
 */
export async function reinviteManagedExchange(
  record: ManagedExchangeRecord,
  deps: ManagedReinviteDriverDeps = defaultDeps,
): Promise<ManagedReinvite> {
  const reinvite = await composeManagedReinvite(record, deps.location(), {
    generateSecret: deps.generateSecret,
    encode: deps.encode,
    now: deps.now,
  });
  await deps.persistRotation(record.id, reinvite.rotation);
  return reinvite;
}
