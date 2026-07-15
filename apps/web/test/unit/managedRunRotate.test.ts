import { describe, expect, test } from "vitest";
import { generateSharedSecret } from "@psilink/core";

import {
  RotationPersistError,
  failedRun,
  rotationWriteBack,
  runRotationCriticalSection,
  storageFailureRun,
  succeededRun,
} from "@psi/managedRunRotate";

import type { ManagedRotationCriticalSection } from "@psi/managedRunRotate";

// The pure ordering and decision half of the run+rotate critical section, tested
// in Node without a database or a real Web Lock: the persist-before-data-exchange
// sequence (with the persist and lock seams faked), the `expires` restamp from the
// max-age policy, and the `lastRun` bookkeeping. The strict-durability transaction,
// the single-writer lock, and the no-steal property are the platform half, tested
// against real Chromium in test/browser/managedExchangeRun.test.ts.

// A fixed rotation instant and a day in ms, so the expected restamp is a plain
// arithmetic check rather than a re-derivation of the function under test.
const ROTATION_AT = Date.parse("2026-07-14T12:00:00.000Z");
const MS_PER_DAY = 86_400_000;

describe("rotationWriteBack: the expires restamp", () => {
  test("with no policy, clears any standing bound (expires: null)", () => {
    const secret = generateSharedSecret();
    const writeBack = rotationWriteBack(secret, undefined, ROTATION_AT);
    expect(writeBack).toEqual({ sharedSecret: secret, expires: null });
  });

  test("with a policy, restamps expires to now + tokenMaxAgeDays days", () => {
    const secret = generateSharedSecret();
    const writeBack = rotationWriteBack(secret, 90, ROTATION_AT);
    expect(writeBack.sharedSecret).toBe(secret);
    expect(writeBack.expires).toBe(
      new Date(ROTATION_AT + 90 * MS_PER_DAY).toISOString(),
    );
  });

  test("rejects a non-positive-integer age (a schema-bypassing caller)", () => {
    const secret = generateSharedSecret();
    expect(() => rotationWriteBack(secret, 0, ROTATION_AT)).toThrow(RangeError);
    expect(() => rotationWriteBack(secret, -1, ROTATION_AT)).toThrow(
      RangeError,
    );
    expect(() => rotationWriteBack(secret, 1.5, ROTATION_AT)).toThrow(
      RangeError,
    );
  });

  test("rejects an age whose computed expiry overflows the date range", () => {
    const secret = generateSharedSecret();
    // Far beyond year 9999 from the epoch.
    expect(() => rotationWriteBack(secret, 100_000_000, ROTATION_AT)).toThrow(
      RangeError,
    );
  });
});

describe("lastRun bookkeeping builders", () => {
  test("succeededRun records a green outcome with no failureKind", () => {
    expect(succeededRun(ROTATION_AT)).toEqual({
      at: new Date(ROTATION_AT).toISOString(),
      outcome: "succeeded",
    });
  });

  test("storageFailureRun records a benign-tier storage failure", () => {
    // The `storage` kind is what steers the next handshake failure to the benign
    // Tier-1 framing rather than the attack framing.
    expect(storageFailureRun(ROTATION_AT)).toEqual({
      at: new Date(ROTATION_AT).toISOString(),
      outcome: "failed",
      failureKind: "storage",
    });
  });

  test("failedRun records the runner-classified outcomes", () => {
    expect(failedRun(ROTATION_AT, "desynced", "auth")).toEqual({
      at: new Date(ROTATION_AT).toISOString(),
      outcome: "desynced",
      failureKind: "auth",
    });
  });
});

/** A locked critical section whose phases record the order they fire into
 * `order`, so a test can assert the persist ran strictly after the handshake. The
 * persist and handshake outcomes are configurable to drive the failure paths. */
function tracedSection(
  order: Array<string>,
  overrides: Partial<ManagedRotationCriticalSection<string>> = {},
): ManagedRotationCriticalSection<string> {
  const rotatedSecret = generateSharedSecret();
  return {
    handshake: () => {
      order.push("handshake");
      return Promise.resolve({ rotatedSecret, handshake: "carried" });
    },
    persist: () => {
      order.push("persist");
      return Promise.resolve();
    },
    tokenMaxAgeDays: undefined,
    now: () => ROTATION_AT,
    ...overrides,
  };
}

describe("runRotationCriticalSection: persist-before-gate ordering", () => {
  test("persists the rotation and resolves the gate only after the persist", async () => {
    const order: Array<string> = [];
    const gate = await runRotationCriticalSection(tracedSection(order));

    // The gate the data exchange consumes is resolved strictly after the persist,
    // so a caller cannot begin the data exchange before the secret is durable.
    expect(order).toEqual(["handshake", "persist"]);
    expect(gate.handshake).toBe("carried");
  });

  test("the persist receives the restamped write-back when a policy is set", async () => {
    const order: Array<string> = [];
    const seen: Array<{ sharedSecret: string; expires: string | null }> = [];
    const rotatedSecret = generateSharedSecret();
    await runRotationCriticalSection(
      tracedSection(order, {
        tokenMaxAgeDays: 30,
        handshake: () => {
          order.push("handshake");
          return Promise.resolve({ rotatedSecret, handshake: "carried" });
        },
        persist: (writeBack) => {
          order.push("persist");
          seen.push(writeBack);
          return Promise.resolve();
        },
      }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].sharedSecret).toBe(rotatedSecret);
    expect(seen[0].expires).toBe(
      new Date(ROTATION_AT + 30 * MS_PER_DAY).toISOString(),
    );
  });

  test("a persist failure aborts the section and carries storage bookkeeping", async () => {
    const order: Array<string> = [];
    const section = tracedSection(order, {
      persist: () => {
        order.push("persist");
        return Promise.reject(new Error("quota exceeded"));
      },
    });

    const error: unknown = await runRotationCriticalSection(section).then(
      () => {
        throw new Error(
          "the section should have rejected on the persist failure",
        );
      },
      (reason: unknown) => reason,
    );

    // The section rejects at the persist: no gate is resolved, so the data
    // exchange the caller would run next is unreachable.
    expect(order).toEqual(["handshake", "persist"]);
    expect(error).toBeInstanceOf(RotationPersistError);
    expect((error as RotationPersistError).lastRun).toEqual(
      storageFailureRun(ROTATION_AT),
    );
    // The original cause is preserved for diagnostics.
    expect((error as RotationPersistError).cause).toBeInstanceOf(Error);
  });

  test("a handshake failure aborts before any persist", async () => {
    const order: Array<string> = [];
    const section = tracedSection(order, {
      handshake: () => {
        order.push("handshake");
        return Promise.reject(new Error("handshake failed closed"));
      },
    });

    await expect(runRotationCriticalSection(section)).rejects.toThrow(
      "handshake failed closed",
    );
    // The persist never ran.
    expect(order).toEqual(["handshake"]);
  });
});
