import { describe, expect, test } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@psilink/core";

import {
  MANAGED_EXCHANGE_SCHEMA_VERSION,
  composeManagedExchangeFile,
} from "@psi/managedExchangeRecord";
import {
  ManagedExchangeExpiredError,
  benignRerunOutcome,
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
