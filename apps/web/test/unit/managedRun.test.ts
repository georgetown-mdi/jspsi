import {
  ConnectionError,
  generateSharedSecret,
  getDefaultLinkageTerms,
} from "@psilink/core";
import { describe, expect, test } from "vitest";

import {
  MANAGED_EXCHANGE_SCHEMA_VERSION,
  composeManagedExchangeFile,
} from "@psi/managedExchangeRecord";
import {
  ManagedExchangeExpiredError,
  benignRerunOutcome,
  remapLapsedRunFailure,
  rerunFailureLastRun,
  runManagedRerun,
} from "@psi/managedRun";
import { ManagedExchangeLockUnavailableError } from "@psi/managedExchangeRun";
import { ManagedInputError } from "@psi/managedInputGuard";
import { RotationPersistError } from "@psi/managedRunRotate";

import type { ManagedExchangeRecord } from "@psi/managedExchangeRecord";

// The pure orchestration of a re-run, tested in Node for the parts that do NOT
// touch the platform (the pre-connection expiry short-circuit, which never reaches
// the lock, and the benign-outcome classification). The full launch-from-record
// path through the single-writer lock and the strict-durability store is exercised
// against real Chromium in test/browser/managedRun.test.ts.

function record(
  overrides: Partial<ManagedExchangeRecord> = {},
): ManagedExchangeRecord {
  return {
    schemaVersion: MANAGED_EXCHANGE_SCHEMA_VERSION,
    id: "record-under-test",
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: { channel: "webrtc", host: "signaling.example.org" },
      linkageTerms: getDefaultLinkageTerms("County Health Dept"),
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
    ...overrides,
  };
}

/** Seams that fail loudly if reached: the expiry short-circuit must never touch
 * them (no connection is attempted, no lock is taken). */
const unreachableSeams = {
  acquireInput: () => {
    throw new Error("acquireInput must not run for a lapsed record");
  },
  handshake: () => {
    throw new Error("handshake must not run for a lapsed record");
  },
  dataExchange: () => {
    throw new Error("dataExchange must not run for a lapsed record");
  },
};

describe("runManagedRerun: pre-connection expiry", () => {
  test("a lapsed record rejects with the expiry error before any seam runs", async () => {
    const now = Date.parse("2026-07-14T12:00:00.000Z");
    const lapsed = record({ expires: "2026-07-01T00:00:00.000Z" });

    await expect(
      runManagedRerun(lapsed, unreachableSeams, { now: () => now }),
    ).rejects.toBeInstanceOf(ManagedExchangeExpiredError);
  });

  test("the expiry error carries the record's lapsed instant", async () => {
    const now = Date.parse("2026-07-14T12:00:00.000Z");
    const lapsed = record({ expires: "2026-07-01T00:00:00.000Z" });
    const error = await runManagedRerun(lapsed, unreachableSeams, {
      now: () => now,
    }).then(
      () => {
        throw new Error("the run should have rejected as expired");
      },
      (reason: unknown) => reason,
    );
    expect((error as ManagedExchangeExpiredError).expires).toBe(
      "2026-07-01T00:00:00.000Z",
    );
  });

  test("a record with no bound is not short-circuited by the expiry check", async () => {
    // With no `expires`, the expiry check is a no-op and the orchestration proceeds
    // to runManagedExchange (whose platform lock/store is exercised in the browser
    // suite). Here we only assert the expiry gate did not fire: the rejection is NOT
    // the expiry error.
    const live = record();
    const error = await runManagedRerun(live, unreachableSeams).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).not.toBeInstanceOf(ManagedExchangeExpiredError);
  });
});

describe("benignRerunOutcome", () => {
  test("classifies the three benign pre-connection states", () => {
    expect(
      benignRerunOutcome(
        new ManagedExchangeExpiredError("2026-07-01T00:00:00Z"),
      ),
    ).toBe("expired");
    expect(
      benignRerunOutcome(
        new ManagedInputError({ reason: "acquire", cause: new Error("x") }),
      ),
    ).toBe("input");
    expect(
      benignRerunOutcome(new ManagedExchangeLockUnavailableError("id")),
    ).toBe("already-running");
  });

  test("a handshake/storage/transport failure is not a benign pre-connection state", () => {
    expect(benignRerunOutcome(new Error("connection dropped"))).toBeUndefined();
    expect(
      benignRerunOutcome(new RotationPersistError(0, new Error("db"))),
    ).toBeUndefined();
  });
});

describe("rerunFailureLastRun: the runner's failure bookkeeping", () => {
  const AT = Date.parse("2026-07-14T12:00:00.000Z");

  test("a security-kind handshake failure records an auth-kind failed run", () => {
    const lastRun = rerunFailureLastRun(
      new ConnectionError("key exchange authentication failed", "security"),
      AT,
      false,
    );
    expect(lastRun).toEqual({
      at: new Date(AT).toISOString(),
      outcome: "failed",
      failureKind: "auth",
    });
  });

  test("any other run failure records a transport-kind failed run", () => {
    expect(
      rerunFailureLastRun(new Error("channel dropped"), AT, false),
    ).toEqual({
      at: new Date(AT).toISOString(),
      outcome: "failed",
      failureKind: "transport",
    });
  });

  test("a cancelled run records cancelled, even when the error looks like a trust failure", () => {
    // Teardown on an operator abort can provoke a security-shaped error; the
    // abort probe wins so the bookkeeping reads cancelled, not auth.
    const lastRun = rerunFailureLastRun(
      new ConnectionError("closed mid-handshake", "security"),
      AT,
      true,
    );
    expect(lastRun?.failureKind).toBe("cancelled");
  });

  test("failures whose bookkeeping is owned elsewhere or deliberately absent record nothing", () => {
    // Input and storage: recorded best-effort inside the critical section.
    expect(
      rerunFailureLastRun(
        new ManagedInputError({ reason: "acquire", cause: new Error("x") }),
        AT,
        false,
      ),
    ).toBeUndefined();
    expect(
      rerunFailureLastRun(
        new RotationPersistError(AT, new Error("db")),
        AT,
        false,
      ),
    ).toBeUndefined();
    // Expiry and lock-unavailable: no run began; a lapse is carried by `expires`.
    expect(
      rerunFailureLastRun(
        new ManagedExchangeExpiredError("2026-07-01T00:00:00.000Z"),
        AT,
        false,
      ),
    ).toBeUndefined();
    expect(
      rerunFailureLastRun(
        new ManagedExchangeLockUnavailableError("id"),
        AT,
        false,
      ),
    ).toBeUndefined();
  });
});

describe("remapLapsedRunFailure: a bound that lapses mid-run", () => {
  const NOW = Date.parse("2026-07-14T12:00:00.000Z");

  /** Core's expiry errors carry the recovery-hint tag (preserved across the
   * security re-wrap). */
  function taggedExpiryError(): Error {
    return Object.assign(
      new Error("shared secret expired during the key-exchange round-trip"),
      { psilinkRecoveryHintEmitted: true },
    );
  }

  test("a tagged handshake failure on a now-lapsed record re-maps to the benign expiry error", () => {
    const remapped = remapLapsedRunFailure(
      taggedExpiryError(),
      { expires: "2026-07-14T11:59:00.000Z" },
      NOW,
    );
    expect(remapped).toBeInstanceOf(ManagedExchangeExpiredError);
    expect(remapped?.expires).toBe("2026-07-14T11:59:00.000Z");
  });

  test("a tagged failure with a still-live bound does not re-map", () => {
    expect(
      remapLapsedRunFailure(
        taggedExpiryError(),
        { expires: "2026-08-01T00:00:00.000Z" },
        NOW,
      ),
    ).toBeUndefined();
  });

  test("an untagged trust failure never re-maps, even on a lapsed record", () => {
    expect(
      remapLapsedRunFailure(
        new ConnectionError("key exchange authentication failed", "security"),
        { expires: "2026-07-14T11:59:00.000Z" },
        NOW,
      ),
    ).toBeUndefined();
  });

  test("a record with no bound never re-maps", () => {
    expect(remapLapsedRunFailure(taggedExpiryError(), {}, NOW)).toBeUndefined();
  });
});
