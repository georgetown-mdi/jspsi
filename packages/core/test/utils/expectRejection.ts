import { expect } from "vitest";

import { ConnectionError } from "../../src/connection/messageConnection";

// Assert that `p` rejects with a ConnectionError of `kind`, and return the
// error so a caller can layer further assertions (its message, or sticky-state
// identity checks across later calls).
export async function expectRejectionKind(
  p: Promise<unknown>,
  kind: ConnectionError["kind"],
): Promise<ConnectionError> {
  const err = await p.then(
    () => {
      throw new Error("expected a rejection but the promise resolved");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe(kind);
  return err as ConnectionError;
}
