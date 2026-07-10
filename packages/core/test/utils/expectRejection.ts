import { expect } from "vitest";

import { ConnectionError } from "../../src/connection/messageConnection";

// Assert that `p` rejects with a ConnectionError of `kind`, and return the error
// so a caller can layer further assertions (its message, or sticky-state
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

// As expectRejectionKind, but also asserts the error message matches
// `messagePattern`.
export async function expectRejection(
  p: Promise<unknown>,
  kind: ConnectionError["kind"],
  messagePattern: RegExp,
): Promise<ConnectionError> {
  const err = await expectRejectionKind(p, kind);
  expect(err.message).toMatch(messagePattern);
  return err;
}

// Convenience wrapper for the common "security"-kind case.
export async function expectSecurity(
  p: Promise<unknown>,
  messagePattern: RegExp,
): Promise<ConnectionError> {
  return expectRejection(p, "security", messagePattern);
}
