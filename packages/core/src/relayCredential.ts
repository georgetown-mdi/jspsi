import {
  enc,
  fromBase64Url,
  hkdfDerive,
  hmacSha1,
  toHex,
} from "./utils/crypto.js";
import { SHARED_SECRET_REGEX } from "./config/connection.js";
import type { WebRTCConnectionConfig } from "./config/connection.js";
import { InternalConsistencyError } from "./errors.js";

/**
 * HKDF info label for the per-exchange relay key. A single fixed label in the
 * domain-separation label space (docs/spec/PROTOCOL.md, "The domain-separation
 * label space").
 */
const RELAY_KEY_INFO = "alcove-relay-key-v2";

const RELAY_KEY_BYTES = 32;

/**
 * The longest lifetime, in seconds, {@link mintRelayCredential} gives a relay
 * credential: one hour, the default of the relay's own `mint-credential.sh`.
 */
export const RELAY_CREDENTIAL_MAX_TTL_SECONDS = 3600;

/** A time-limited TURN credential, in the relay server's REST-API format. */
export interface RelayCredential {
  /** `<unix-expiry-seconds>:<label>`. */
  username: string;
  /** Base64 HMAC-SHA-1 of `username` under the relay key. */
  credential: string;
  /** When the relay stops accepting the credential. */
  expiresAt: Date;
}

/**
 * Derive the per-exchange relay key from the exchange's current shared secret.
 * Both parties compute the same key; it is the secret the relay checks
 * credentials against and the key {@link mintRelayCredential} signs with. The
 * construction: docs/spec/PROTOCOL.md, "Relay credential derivation".
 *
 * @param sharedSecret  The exchange's current base64url-encoded 32-byte shared
 *                      secret, matching {@link SHARED_SECRET_REGEX}.
 * @returns The 32-byte key as lowercase hex, the string the relay stores.
 * @throws {Error} if `sharedSecret` is not a base64url-encoded 32-byte value.
 */
export async function deriveRelayKey(sharedSecret: string): Promise<string> {
  if (!SHARED_SECRET_REGEX.test(sharedSecret)) {
    throw new InternalConsistencyError(
      "deriveRelayKey: sharedSecret must be a base64url-encoded 32-byte value " +
        "matching SHARED_SECRET_REGEX",
    );
  }
  const bytes = await hkdfDerive(
    fromBase64Url(sharedSecret),
    RELAY_KEY_INFO,
    RELAY_KEY_BYTES,
  );
  return toHex(bytes);
}

/** Arguments to {@link mintRelayCredential}. */
export interface MintRelayCredentialOptions {
  /** The relay key, used as the HMAC key by its UTF-8 bytes. */
  key: string;
  /** The name after the expiry in the username; must not contain `:`. */
  label: string;
  /** Lifetime in whole seconds, from 1 to {@link RELAY_CREDENTIAL_MAX_TTL_SECONDS}. */
  ttlSeconds: number;
  /** The time the lifetime counts from. */
  now: Date;
}

/**
 * Mint a time-limited TURN credential under `key` without contacting the relay:
 * the relay recomputes the same HMAC when the credential is presented. The
 * format: docs/spec/PROTOCOL.md, "Relay credential derivation".
 *
 * @throws {Error} if `key` or `label` is empty, `label` contains `:`,
 *                 `ttlSeconds` is not a whole number of seconds from 1 to
 *                 {@link RELAY_CREDENTIAL_MAX_TTL_SECONDS}, or `now` is not a
 *                 valid date.
 */
export async function mintRelayCredential({
  key,
  label,
  ttlSeconds,
  now,
}: MintRelayCredentialOptions): Promise<RelayCredential> {
  if (key.length === 0) {
    throw new InternalConsistencyError("mintRelayCredential: key is empty");
  }
  if (label.length === 0 || label.includes(":")) {
    throw new InternalConsistencyError(
      `mintRelayCredential: label ${JSON.stringify(label)} must be non-empty ` +
        "and must not contain ':', which separates it from the expiry",
    );
  }
  if (
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds < 1 ||
    ttlSeconds > RELAY_CREDENTIAL_MAX_TTL_SECONDS
  ) {
    throw new InternalConsistencyError(
      `mintRelayCredential: ttlSeconds must be whole seconds from 1 to ` +
        `${RELAY_CREDENTIAL_MAX_TTL_SECONDS}; got ${ttlSeconds}`,
    );
  }
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) {
    throw new InternalConsistencyError(
      "mintRelayCredential: now is not a valid date",
    );
  }
  const expirySeconds = Math.floor(nowMs / 1000) + ttlSeconds;
  const username = `${expirySeconds}:${label}`;
  const mac = await hmacSha1(enc.encode(key), enc.encode(username));
  return {
    username,
    credential: btoa(String.fromCharCode(...mac)),
    expiresAt: new Date(expirySeconds * 1000),
  };
}

/**
 * The label {@link mintRunRelayCredential} puts in a relay credential's
 * username. The relay operator reads it in its logs, so it names the software
 * and nothing about the exchange or the party.
 */
export const RUN_RELAY_CREDENTIAL_LABEL = "alcove";

/**
 * The relay servers a webrtc run gathers candidates from, chosen per kind: the
 * invitation's TURN urls when its relay names any, else the connection's own
 * `turn` entries, and the invitation's STUN urls when its relay names any, else
 * the connection's own `stun` list. An invitation's TURN url has no credential;
 * the run mints one ({@link mintRunRelayCredential}).
 */
export interface RunRelaySelection {
  /** The STUN urls and their source; absent when neither side names a list. */
  stun?: { source: "invitation" | "own"; urls: string[] };
  /** The TURN servers and their source; absent when neither side names any. */
  turn?:
    | { source: "invitation"; urls: string[] }
    | {
        source: "own";
        servers: NonNullable<WebRTCConnectionConfig["turn"]>;
      };
}

/**
 * Choose the relay servers a webrtc run uses (see {@link RunRelaySelection}).
 * A connection with no `invitationRelay` selects exactly its own `stun` and
 * `turn`, so a run from an invitation that named no relay is unchanged.
 */
export function selectRunRelay(
  connection: Pick<WebRTCConnectionConfig, "stun" | "turn" | "invitationRelay">,
): RunRelaySelection {
  const invitation = connection.invitationRelay;
  const selection: RunRelaySelection = {};
  if (invitation?.stun !== undefined && invitation.stun.length > 0)
    selection.stun = { source: "invitation", urls: [...invitation.stun] };
  else if (connection.stun !== undefined)
    selection.stun = { source: "own", urls: [...connection.stun] };
  if (invitation?.turn !== undefined && invitation.turn.length > 0)
    selection.turn = { source: "invitation", urls: [...invitation.turn] };
  else if (connection.turn !== undefined)
    selection.turn = { source: "own", servers: [...connection.turn] };
  return selection;
}

/**
 * Mint the credential a run presents to the TURN urls an invitation named:
 * signed under the relay key derived from the run's current shared secret, for
 * {@link RELAY_CREDENTIAL_MAX_TTL_SECONDS}, labelled
 * {@link RUN_RELAY_CREDENTIAL_LABEL}. Nothing is stored; the next run mints
 * again from the secret it then holds.
 *
 * @throws {Error} if `sharedSecret` is not a base64url-encoded 32-byte value
 *   or `now` is not a valid date.
 */
export async function mintRunRelayCredential(
  sharedSecret: string,
  now: Date,
): Promise<RelayCredential> {
  return mintRelayCredential({
    key: await deriveRelayKey(sharedSecret),
    label: RUN_RELAY_CREDENTIAL_LABEL,
    ttlSeconds: RELAY_CREDENTIAL_MAX_TTL_SECONDS,
    now,
  });
}
