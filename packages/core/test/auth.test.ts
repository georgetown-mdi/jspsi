import { afterEach, expect, test, vi } from "vitest";

import { assertSharedSecretReadyForHandshake } from "../src/auth";
import type { Authentication } from "../src/config/connection";

// A well-formed shared secret (43 base64url characters, final character in
// [AEIMQUYcgkosw048]), so each case below turns on expiry alone.
const SHARED_SECRET = "oaGhoaGhoaGhoaGhoaGhoaGhoaGhoaGhoaGhoaGhoaE";

const NOW_MS = Date.UTC(2026, 0, 15, 12, 0, 0);

function authenticationExpiringAt(offsetMs: number): Authentication {
  return {
    sharedSecret: SHARED_SECRET,
    expires: new Date(NOW_MS + offsetMs).toISOString(),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

test("a shared secret expiring exactly now is expired (the boundary is inclusive)", () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
  expect(() =>
    assertSharedSecretReadyForHandshake(authenticationExpiringAt(0)),
  ).toThrow(/shared secret expired/);
});

test("a shared secret expiring one millisecond from now is still usable", () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
  expect(() =>
    assertSharedSecretReadyForHandshake(authenticationExpiringAt(1)),
  ).not.toThrow();
});
