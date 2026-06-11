import { hkdfDerive, fromBase64Url, toHex } from "./utils/crypto.js";
import { SHARED_SECRET_REGEX } from "./config/connection.js";

/**
 * The two roles in a WebRTC rendezvous. Each party derives a deterministic
 * PeerJS peer id from the shared secret and one of these role labels, so both
 * sides compute the same pair of ids without exchanging them: the inviter
 * listens on its `"inviter"` id, and the acceptor dials that id while
 * registering under its own `"acceptor"` id.
 *
 * Frozen so the readonly compile-time type also holds at runtime (mirroring
 * {@link AEAD_CONTEXTS} in auth.ts): a plain-JS caller cannot widen the set the
 * runtime guard in {@link deriveRendezvousPeerId} checks.
 */
export const RENDEZVOUS_ROLES = Object.freeze(["inviter", "acceptor"] as const);

/** A rendezvous role; one of the fixed {@link RENDEZVOUS_ROLES}. */
export type RendezvousRole = (typeof RENDEZVOUS_ROLES)[number];

/**
 * Length, in bytes, of the derived peer id before hex encoding. 16 bytes -> 32
 * hex characters: UUID-scale entropy (the PeerJS default id is a random UUID),
 * collision-resistant across secrets and far beyond guessing for any party that
 * does not hold the secret.
 */
const PEER_ID_BYTES = 16;

/**
 * HKDF info prefix for the rendezvous-id derivation. Versioned and role-separated
 * exactly like {@link deriveAeadKey}'s `psilink-aead-v1:<context>`: the version
 * guards against an incompatible construction change, and the role label is the
 * domain separation that makes the inviter and acceptor ids distinct from the one
 * secret.
 *
 * CROSS-IMPLEMENTATION CONTRACT: the full construction -- HKDF-SHA-256 over the
 * decoded 32-byte secret, zero salt, info `psilink-webrtc-peerid-v1:<role>`,
 * first {@link PEER_ID_BYTES} bytes, lowercase hex -- is the shared rendezvous
 * contract between the web app and the CLI WebRTC transport. Both sides must
 * compute it identically or CLI<->web rendezvous breaks; do not change it without
 * changing every implementation in lockstep (and bumping the `v1` version).
 */
const PEER_ID_INFO_PREFIX = "psilink-webrtc-peerid-v1:";

/**
 * Derive the deterministic PeerJS peer id for one rendezvous `role` from the
 * invitation's shared secret.
 *
 * Both parties hold the secret, so both compute both ids: the inviter derives and
 * listens on its `"inviter"` id; the acceptor derives the same `"inviter"` id to
 * dial and registers under its own `"acceptor"` id. The two roles use distinct
 * HKDF info, so the ids differ.
 *
 * The id is lowercase hex, never base64url: the PeerJS client validates ids
 * against `/^[A-Za-z0-9]+(?:[ _-][A-Za-z0-9]+)*$/`, which a base64url string can
 * fail (a leading, trailing, or doubled `-`/`_`), whereas hex always passes.
 *
 * @param sharedSecret  The invitation's base64url-encoded 32-byte shared secret,
 *                      matching {@link SHARED_SECRET_REGEX}.
 * @param role          The rendezvous role; one of {@link RENDEZVOUS_ROLES}.
 * @throws {Error} if `sharedSecret` is not a base64url-encoded 32-byte value, or
 *                 if `role` is not a known rendezvous role.
 */
export async function deriveRendezvousPeerId(
  sharedSecret: string,
  role: RendezvousRole,
): Promise<string> {
  if (!SHARED_SECRET_REGEX.test(sharedSecret)) {
    throw new Error(
      "deriveRendezvousPeerId: sharedSecret must be a base64url-encoded " +
        "32-byte value matching SHARED_SECRET_REGEX",
    );
  }
  // Runtime guard for an untyped (plain-JS or `as`-cast) caller, mirroring
  // deriveAeadKey: an unknown role would otherwise silently derive an id the two
  // parties never agree on, surfacing only as a rendezvous that never connects.
  if (!(RENDEZVOUS_ROLES as readonly string[]).includes(role)) {
    throw new Error(
      `deriveRendezvousPeerId: unknown role ${JSON.stringify(role)}; ` +
        `expected one of ${RENDEZVOUS_ROLES.map((r) => JSON.stringify(r)).join(", ")}`,
    );
  }
  const ikm = fromBase64Url(sharedSecret);
  const bytes = await hkdfDerive(
    ikm,
    `${PEER_ID_INFO_PREFIX}${role}`,
    PEER_ID_BYTES,
  );
  return toHex(bytes);
}
