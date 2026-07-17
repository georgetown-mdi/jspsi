import { sanitizeForDisplay } from "./utils/sanitizeForDisplay.js";
import type { PresentedHostKey } from "./connection/fileSyncConnection.js";

/**
 * Compare the two parties' observed SFTP host keys and, on a divergence, return
 * an operator-facing warning naming both observed values; return `undefined`
 * when there is nothing to flag.
 *
 * Each party pins/observes the rendezvous server's host key independently -- at
 * different times, on different machines -- so nothing otherwise compares the
 * two views. A one-sided interception, where one party trusts an attacker's key
 * while the other trusts the real key, is invisible to both until their observed
 * fingerprints are reconciled. This reconciliation rides the authenticated
 * post-handshake terms exchange (see {@link exchangeTerms}), so the advertised
 * value cannot be forged by an unauthenticated party.
 *
 * Returns `undefined` (no divergence to report) when:
 * - Either side observed no host key. A file-drop mount, the browser/proxy SFTP
 *   path, or an unauthenticated exchange advertises nothing, and there is
 *   nothing to reconcile against -- so a one-sided absence is NOT a divergence.
 * - Both fingerprints are equal: the same key reached both parties.
 *
 * Returns a warning string when both parties observed a host key and the
 * fingerprints differ. The message names both observed values and explains the
 * two honest causes (a server rekey between the parties' setups, or a one-sided
 * interception). When the two key TYPES also differ, the message additionally
 * notes the benign multiple-host-key case: a server that presents more than one
 * host key may show each party a different one, so a type difference alone is
 * not evidence of an attack. The check never aborts the exchange -- the threat
 * model is honest-but-curious and the operator disambiguates out-of-band -- it
 * only surfaces the divergence.
 *
 * The fingerprint comparison is a plain string equality, not a constant-time
 * compare: a host key and its fingerprint are both public, and the result drives
 * only a warning, not a trust decision. Both key types and both fingerprints are
 * routed through {@link sanitizeForDisplay} before they enter the message,
 * because the partner's advertised values arrive over the wire and a server's
 * key type is server-controlled (see {@link PresentedHostKey.keyType}).
 *
 * @param local   This party's observed host key, or `undefined` if none.
 * @param partner The partner's advertised observed host key, or `undefined`.
 */
export function reconcileHostKeyFingerprints(
  local: PresentedHostKey | undefined,
  partner: PresentedHostKey | undefined,
): string | undefined {
  if (local === undefined || partner === undefined) return undefined;
  if (local.fingerprint === partner.fingerprint) return undefined;

  const localFp = sanitizeForDisplay(local.fingerprint);
  const partnerFp = sanitizeForDisplay(partner.fingerprint);
  const localType = sanitizeForDisplay(local.keyType);
  const partnerType = sanitizeForDisplay(partner.keyType);

  const sameType = local.keyType === partner.keyType;
  const observed = sameType
    ? `Both observed key type '${localType}', but this party observed ` +
      `fingerprint ${localFp} while the partner observed ${partnerFp}.`
    : `This party observed a '${localType}' key with fingerprint ${localFp}, ` +
      `while the partner observed a '${partnerType}' key with fingerprint ` +
      `${partnerFp}.`;

  // A same-type difference cannot be the benign multiple-host-key case (that
  // shows different types), so it is narrowed to rekey-or-interception; a
  // different-type difference adds the benign possibility up front.
  const causes = sameType
    ? `Because the key types match, this is either a server host-key rotation ` +
      `between the two parties' setups or a one-sided interception, in which ` +
      `one party's connection is intercepted while the other reaches the real ` +
      `server.`
    : `Different key types can be benign -- a server that presents multiple ` +
      `host keys may show each party a different one -- but the difference can ` +
      `also be a server host-key rotation between the two parties' setups or a ` +
      `one-sided interception, in which one party's connection is intercepted ` +
      `while the other reaches the real server.`;

  return (
    `WARNING: the two parties observed different SFTP host keys. ${observed} ` +
    `${causes} Confirm the server's current host key out-of-band with both ` +
    `parties before trusting this result; if the key was legitimately rotated, ` +
    `re-pin it on both sides.`
  );
}
