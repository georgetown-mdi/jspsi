import { describe, expect, test } from "vitest";

import {
  classifyManagedRunFailure,
  managedRunRetryable,
} from "@bench/managedRunLaunchModel";
import { ManagedExchangeExpiredError } from "@psi/managedExpiry";
import { ManagedExchangeLockUnavailableError } from "@psi/managedExchangeRun";
import { ManagedInputError } from "@psi/managedInputGuard";

// The launch surface's failure classification, tested in Node: the three benign
// pre-connection states get their own honest copy, and every other failure gets
// the generic message -- no desync or attack copy is invented here.

describe("classifyManagedRunFailure", () => {
  test("a lapsed secret is the benign expiry state with re-invite copy naming the lapse", () => {
    const failure = classifyManagedRunFailure(
      new ManagedExchangeExpiredError("2026-07-01T00:00:00.000Z"),
    );
    expect(failure.kind).toBe("expired");
    expect(failure.message).toMatch(/re-invite/i);
    // The lapsed instant the error carries is named for the operator (the exact
    // rendering is locale/timezone formatting; the year pins its presence).
    expect(failure.message).toMatch(/2026/);
    // Benign framing, never attack copy.
    expect(failure.message).not.toMatch(/attack|tamper|impersonat/i);
  });

  test("an input problem is the benign input state, naming no partner-influenced detail", () => {
    const failure = classifyManagedRunFailure(
      new ManagedInputError({
        reason: "columns",
        unsatisfied: [{ name: "ssn", type: "ssn" }],
      }),
    );
    expect(failure.kind).toBe("input");
    // The unsatisfied field names never surface in the copy.
    expect(failure.message).not.toMatch(/ssn/);
  });

  test("a run in progress elsewhere is the benign already-running state", () => {
    const failure = classifyManagedRunFailure(
      new ManagedExchangeLockUnavailableError("id"),
    );
    expect(failure.kind).toBe("already-running");
  });

  test("any other failure is the generic message, not desync or attack copy", () => {
    const failure = classifyManagedRunFailure(new Error("handshake failed"));
    expect(failure.kind).toBe("generic");
    expect(failure.message).not.toMatch(/attack|tamper|desync/i);
  });
});

describe("managedRunRetryable", () => {
  test("input and generic are retryable in place; expiry and already-running are not", () => {
    expect(
      managedRunRetryable(classifyManagedRunFailure(new Error("drop"))),
    ).toBe(true);
    expect(
      managedRunRetryable(
        classifyManagedRunFailure(
          new ManagedInputError({ reason: "acquire", cause: new Error("x") }),
        ),
      ),
    ).toBe(true);
    expect(
      managedRunRetryable(
        classifyManagedRunFailure(
          new ManagedExchangeExpiredError("2026-07-01T00:00:00.000Z"),
        ),
      ),
    ).toBe(false);
    expect(
      managedRunRetryable(
        classifyManagedRunFailure(
          new ManagedExchangeLockUnavailableError("id"),
        ),
      ),
    ).toBe(false);
  });
});
