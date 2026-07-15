import { describe, expect, test } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@psilink/core";

import {
  classifyManagedRunFailure,
  managedRunFailureFromRecord,
  managedRunReinvites,
  managedRunRetryable,
} from "@bench/managedRunLaunchModel";

import {
  MANAGED_EXCHANGE_SCHEMA_VERSION,
  composeManagedExchangeFile,
} from "@psi/managedExchangeRecord";
import { ManagedExchangeExpiredError } from "@psi/managedExpiry";
import { ManagedExchangeLockUnavailableError } from "@psi/managedExchangeRun";
import { ManagedInputError } from "@psi/managedInputGuard";

import type {
  ManagedExchangeLastRun,
  ManagedExchangeRecord,
} from "@psi/managedExchangeRecord";
import type { ManagedLocalState } from "@psi/managedLocalState";

// The launch surface's failure classification, tested in Node: the pre-connection
// benign states come from the error; a failed-closed handshake and every other
// recorded failure are TIERED from the record's own bookkeeping, so the surface shows
// the tier's specific copy and recovery. No benign tier reads as attack framing; only
// the unexplained tier follows the doc's confirmation framing.

const NOW = Date.parse("2026-07-14T12:00:00.000Z");

function record(
  overrides: Partial<ManagedExchangeRecord> = {},
): ManagedExchangeRecord {
  return {
    schemaVersion: MANAGED_EXCHANGE_SCHEMA_VERSION,
    id: "abc",
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

function failed(
  failureKind: ManagedExchangeLastRun["failureKind"],
): ManagedExchangeLastRun {
  return { at: "2026-07-14T09:00:00.000Z", outcome: "failed", failureKind };
}

describe("classifyManagedRunFailure: pre-connection benign states from the error", () => {
  test("a lapsed secret is the benign expiry state with re-invite copy naming the lapse", () => {
    const failure = classifyManagedRunFailure(
      new ManagedExchangeExpiredError("2026-07-01T00:00:00.000Z"),
      record(),
      undefined,
      NOW,
    );
    expect(failure.kind).toBe("expired");
    expect(failure.recovery).toBe("reinvite");
    expect(failure.message).toMatch(/re-invite/i);
    expect(failure.message).toMatch(/2026/);
    expect(failure.message).not.toMatch(/attack|tamper|impersonat/i);
  });

  test("an input problem is the benign input state, naming no partner-influenced detail", () => {
    const failure = classifyManagedRunFailure(
      new ManagedInputError({
        reason: "columns",
        unsatisfied: [{ name: "ssn", type: "ssn" }],
      }),
      record(),
      undefined,
      NOW,
    );
    expect(failure.kind).toBe("input");
    expect(failure.recovery).toBe("retry");
    expect(failure.message).not.toMatch(/ssn/);
  });

  test("a run in progress elsewhere is the benign already-running state", () => {
    const failure = classifyManagedRunFailure(
      new ManagedExchangeLockUnavailableError("id"),
      record(),
      undefined,
      NOW,
    );
    expect(failure.kind).toBe("already-running");
    expect(failure.recovery).toBe("wait");
  });
});

describe("classifyManagedRunFailure: the recorded tiers from the record's bookkeeping", () => {
  test("a recorded storage failure is the Tier-1 storage state with re-invite", () => {
    const failure = classifyManagedRunFailure(
      new Error("handshake failed"),
      record({ lastRun: failed("storage") }),
      undefined,
      NOW,
    );
    expect(failure.kind).toBe("storage");
    expect(failure.recovery).toBe("reinvite");
    expect(failure.message).not.toMatch(/attack|tamper|impersonat/i);
  });

  test("a recorded auth failure with an import marker is the benign imported state", () => {
    const local: ManagedLocalState = {
      imported: { importedAt: "2026-07-13T00:00:00.000Z" },
    };
    const failure = classifyManagedRunFailure(
      new Error("handshake failed"),
      record({ lastRun: failed("auth") }),
      local,
      NOW,
    );
    expect(failure.kind).toBe("imported");
    expect(failure.recovery).toBe("reinvite");
    expect(failure.message).not.toMatch(/attack|tamper|impersonat/i);
  });

  test("a recorded auth failure with no explanation is the unexplained confirmation state", () => {
    const failure = classifyManagedRunFailure(
      new Error("handshake failed"),
      record({ lastRun: failed("auth") }),
      undefined,
      NOW,
    );
    expect(failure.kind).toBe("unexplained");
    expect(failure.recovery).toBe("confirm");
    // The lead directs to the out-of-band confirmation, not a bare re-invite.
    expect(failure.message).toMatch(/confirm with your partner/i);
    expect(failure.message).toMatch(/do not just re-invite/i);
  });

  test("a transport drop is the retryable transport state, never attack framing", () => {
    const failure = classifyManagedRunFailure(
      new Error("data channel dropped"),
      record({ lastRun: failed("transport") }),
      undefined,
      NOW,
    );
    expect(failure.kind).toBe("transport");
    expect(failure.recovery).toBe("retry");
    expect(failure.message).not.toMatch(/attack|tamper|desync/i);
  });
});

describe("managedRunFailureFromRecord: the next-visit tier (no live launch)", () => {
  test("a stored auth failure surfaces the unexplained tier at the next visit", () => {
    const failure = managedRunFailureFromRecord(
      record({ lastRun: failed("auth") }),
      undefined,
      NOW,
    );
    expect(failure?.kind).toBe("unexplained");
  });

  test("a stored storage failure surfaces the storage tier at the next visit", () => {
    const failure = managedRunFailureFromRecord(
      record({ lastRun: failed("storage") }),
      undefined,
      NOW,
    );
    expect(failure?.kind).toBe("storage");
  });

  test("a lapsed record surfaces the expiry tier naming the real lapsed instant", () => {
    const failure = managedRunFailureFromRecord(
      record({ expires: "2026-07-01T00:00:00.000Z", lastRun: failed("auth") }),
      undefined,
      NOW,
    );
    expect(failure?.kind).toBe("expired");
    expect(failure?.message).toMatch(/2026/);
  });

  test("a never-run or succeeded record surfaces no failure", () => {
    expect(
      managedRunFailureFromRecord(record(), undefined, NOW),
    ).toBeUndefined();
    expect(
      managedRunFailureFromRecord(
        record({
          lastRun: { at: "2026-07-14T09:00:00.000Z", outcome: "succeeded" },
        }),
        undefined,
        NOW,
      ),
    ).toBeUndefined();
  });

  test("a missed window is informational, not a launch failure", () => {
    expect(
      managedRunFailureFromRecord(
        record({
          lastRun: { at: "2026-07-14T09:00:00.000Z", outcome: "missed" },
        }),
        undefined,
        NOW,
      ),
    ).toBeUndefined();
  });
});

describe("managedRunRetryable and managedRunReinvites", () => {
  test("input and transport are retryable in place; the re-invite tiers are not", () => {
    expect(
      managedRunRetryable(
        classifyManagedRunFailure(
          new ManagedInputError({ reason: "acquire", cause: new Error("x") }),
          record(),
          undefined,
          NOW,
        ),
      ),
    ).toBe(true);
    expect(
      managedRunRetryable(
        classifyManagedRunFailure(
          new Error("drop"),
          record({ lastRun: failed("transport") }),
          undefined,
          NOW,
        ),
      ),
    ).toBe(true);
    expect(
      managedRunRetryable(
        classifyManagedRunFailure(
          new ManagedExchangeExpiredError("2026-07-01T00:00:00.000Z"),
          record(),
          undefined,
          NOW,
        ),
      ),
    ).toBe(false);
  });

  test("the storage and imported tiers re-invite; the unexplained tier does not (it gates first)", () => {
    expect(
      managedRunReinvites(
        classifyManagedRunFailure(
          new Error("x"),
          record({ lastRun: failed("storage") }),
          undefined,
          NOW,
        ),
      ),
    ).toBe(true);
    expect(
      managedRunReinvites(
        classifyManagedRunFailure(
          new Error("x"),
          record({ lastRun: failed("auth") }),
          undefined,
          NOW,
        ),
      ),
    ).toBe(false);
  });
});
