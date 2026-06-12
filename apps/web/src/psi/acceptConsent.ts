/**
 * The single gate the accept screen consults before it commits an acceptance and
 * mounts the exchange UI. It returns the name to record only when the user has
 * BOTH explicitly consented to the displayed linkage terms and supplied a
 * non-empty name; otherwise it returns `undefined` and nothing starts.
 *
 * Centralizing the decision here -- rather than relying on a button's `disabled`
 * state alone -- means the security-relevant invariant ("no rendezvous, key
 * exchange, or PSI frame before explicit consent") is enforced in one place that
 * is unit-tested, independent of the UI wiring.
 *
 * @returns the trimmed name to record, or `undefined` if acceptance is not yet
 *          permitted.
 */
export function commitAcceptance(input: {
  consented: boolean;
  name: string;
}): string | undefined {
  const trimmed = input.name.trim();
  if (!input.consented || trimmed === "") return undefined;
  return trimmed;
}
