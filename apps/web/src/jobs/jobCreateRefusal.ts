/*
 * The fixed tokens a `POST /api/jobs` refusal states in its body, so the browser
 * can show copy the operator can act on.
 *
 * Every other create rejection stays empty-bodied: the browser holds the intent
 * it sent and can say what is wrong with it. These are about CONSOLE state the
 * intent does not state -- its mounts, its saved connection -- so the server
 * names the refusal, and only the refusal. A token is an enumerated word, never
 * a path, a mount name, or a message: the copy it selects lives in the console's
 * own copy layer (`failureFor` in `@exchange/useInviterExchange`).
 */

/** The token for a filedrop run refused because a rendezvous directory holds
 * this party's signing identity. */
export const SIGNING_IDENTITY_IN_RENDEZVOUS_REFUSAL =
  "signing-identity-in-rendezvous";

/** The token for a direct (zero-setup) sftp run refused because the saved
 * connection pins more than one host-key fingerprint, which the run cannot
 * pass on. */
export const SFTP_FINGERPRINT_LIST_REFUSAL = "sftp-fingerprint-list";

/** The refusal tokens a create rejection can name. */
export type JobCreateRefusalReason =
  | typeof SIGNING_IDENTITY_IN_RENDEZVOUS_REFUSAL
  | typeof SFTP_FINGERPRINT_LIST_REFUSAL;

/** Whether a value read off a create rejection's body is a refusal token this
 * bundle knows. An unknown token is treated as no token at all, so an older
 * browser against a newer console falls back to the generic copy. */
export function isJobCreateRefusalReason(
  value: unknown,
): value is JobCreateRefusalReason {
  return (
    value === SIGNING_IDENTITY_IN_RENDEZVOUS_REFUSAL ||
    value === SFTP_FINGERPRINT_LIST_REFUSAL
  );
}
