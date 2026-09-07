/**
 * The fixed token a `POST /api/jobs` refusal states in its body, so the browser
 * can show copy the operator can act on.
 *
 * Every other create rejection stays empty-bodied: the browser holds the intent
 * it sent and can say what is wrong with it. This one is about the CONSOLE's
 * mounts, which the browser never learns -- so the server names the refusal, and
 * only the refusal. The token is an enumerated word, never a path, a mount name,
 * or a message: the copy it selects lives in the console's own copy layer
 * (`failureFor` in `@exchange/useInviterExchange`).
 */
export const SIGNING_IDENTITY_IN_RENDEZVOUS_REFUSAL =
  "signing-identity-in-rendezvous";

/** The refusal tokens a create rejection can name. */
export type JobCreateRefusalReason =
  typeof SIGNING_IDENTITY_IN_RENDEZVOUS_REFUSAL;

/** Whether a value read off a create rejection's body is a refusal token this
 * bundle knows. An unknown token is treated as no token at all, so an older
 * browser against a newer console falls back to the generic copy. */
export function isJobCreateRefusalReason(
  value: unknown,
): value is JobCreateRefusalReason {
  return value === SIGNING_IDENTITY_IN_RENDEZVOUS_REFUSAL;
}
