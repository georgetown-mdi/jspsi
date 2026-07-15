import { describe, expect, test } from "vitest";

import {
  ManagedExchangeExpiredError,
  managedExchangeLapsed,
} from "@psi/managedExpiry";

// The pure lapsed-`expires` check, tested in Node: it is applied before any
// connection, so a lapsed bound is its own benign state, never the desync/attack
// framing. The clock is injected.

const NOW = Date.parse("2026-07-14T12:00:00.000Z");

describe("managedExchangeLapsed", () => {
  test("a record with no expires never lapses", () => {
    expect(managedExchangeLapsed({}, NOW)).toBe(false);
  });

  test("a bound in the future has not lapsed", () => {
    expect(
      managedExchangeLapsed({ expires: "2026-08-01T00:00:00.000Z" }, NOW),
    ).toBe(false);
  });

  test("a bound in the past has lapsed", () => {
    expect(
      managedExchangeLapsed({ expires: "2026-07-01T00:00:00.000Z" }, NOW),
    ).toBe(true);
  });

  test("the boundary instant itself is already lapsed (at-or-before)", () => {
    expect(
      managedExchangeLapsed({ expires: new Date(NOW).toISOString() }, NOW),
    ).toBe(true);
  });

  test("an unparseable bound is treated as not lapsed (never wrongly blocks)", () => {
    expect(managedExchangeLapsed({ expires: "not-a-date" }, NOW)).toBe(false);
  });
});

describe("ManagedExchangeExpiredError", () => {
  test("carries the lapsed instant for the surface to name", () => {
    const error = new ManagedExchangeExpiredError("2026-07-01T00:00:00.000Z");
    expect(error.expires).toBe("2026-07-01T00:00:00.000Z");
    expect(error.name).toBe("ManagedExchangeExpiredError");
  });
});
