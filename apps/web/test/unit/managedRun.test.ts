import {
  ConnectionError,
  InternalConsistencyError,
  LinkageTermsUnsatisfiableError,
  OutboundDisclosureRefusalError,
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
import {
  ManagedInputError,
  managedInputFailureKind,
} from "@psi/managedInputGuard";
import { ManagedExchangeLockUnavailableError } from "@psi/managedExchangeRun";
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
  test("classifies the benign pre-connection states", () => {
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

  test("a security-kind failure before the data exchange records an auth-kind failed run", () => {
    // The handshake failing closed provably precedes any payload, so the disclosure
    // copy can honestly say nothing was disclosed.
    const lastRun = rerunFailureLastRun(
      new ConnectionError("key exchange authentication failed", "security"),
      AT,
      false,
      false,
    );
    expect(lastRun).toEqual({
      at: new Date(AT).toISOString(),
      outcome: "failed",
      failureKind: "auth",
    });
  });

  test("a security-kind failure after the data exchange began records transport, not auth", () => {
    // Core's EncryptedMessageConnection can raise a security-kind error on a tampered
    // frame mid-data-exchange; past the phase boundary that is not the pre-disclosure
    // handshake failure, so it records "transport" (the neither-way disclosure bucket)
    // rather than the nothing-disclosed "auth".
    const lastRun = rerunFailureLastRun(
      new ConnectionError("frame tampered mid-exchange", "security"),
      AT,
      false,
      true,
    );
    expect(lastRun).toEqual({
      at: new Date(AT).toISOString(),
      outcome: "failed",
      failureKind: "transport",
    });
  });

  test("any other run failure records a transport-kind failed run", () => {
    expect(
      rerunFailureLastRun(new Error("channel dropped"), AT, false, false),
    ).toEqual({
      at: new Date(AT).toISOString(),
      outcome: "failed",
      failureKind: "transport",
    });
  });

  test("a send-side disclosure refusal before the data exchange records a consent-kind failed run", () => {
    expect(
      rerunFailureLastRun(
        new OutboundDisclosureRefusalError(
          "this run would send a set nobody chose",
        ),
        AT,
        false,
        false,
      ),
    ).toEqual({
      at: new Date(AT).toISOString(),
      outcome: "failed",
      failureKind: "consent",
    });
  });

  test("a disclosure refusal after the data exchange began records transport, not consent", () => {
    // The "consent" tier's copy tells the operator nothing left this device, which
    // only the phase boundary can prove -- so a refusal delivered past it is not
    // stamped consent, whatever raised it. Both send-side gates refuse inside the
    // pre-connection prepare today; this pins that the tier depends on the boundary
    // rather than on where the gates happen to sit.
    const lastRun = rerunFailureLastRun(
      new OutboundDisclosureRefusalError(
        "this run would send a set nobody chose",
      ),
      AT,
      false,
      true,
    );
    expect(lastRun).toEqual({
      at: new Date(AT).toISOString(),
      outcome: "failed",
      failureKind: "transport",
    });
  });

  test("a disclosure refusal outranks the abort probe", () => {
    // Unlike a teardown-provoked error, the refusal is a deterministic local state
    // that refuses identically next run, so recording it as the operator's own
    // cancellation would drop the remedy the record can name.
    const lastRun = rerunFailureLastRun(
      new OutboundDisclosureRefusalError(
        "this run would send a set nobody chose",
      ),
      AT,
      true,
      false,
    );
    expect(lastRun?.failureKind).toBe("consent");
  });

  test("a cancelled run records cancelled, even when the error looks like a trust failure", () => {
    // Teardown on an operator abort can provoke a security-shaped error; the
    // abort probe wins so the bookkeeping reads cancelled, not auth.
    const lastRun = rerunFailureLastRun(
      new ConnectionError("closed mid-handshake", "security"),
      AT,
      true,
      false,
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
        false,
      ),
    ).toBeUndefined();
    expect(
      rerunFailureLastRun(
        new RotationPersistError(AT, new Error("db")),
        AT,
        false,
        false,
      ),
    ).toBeUndefined();
    // Expiry and lock-unavailable: no run began; a lapse is carried by `expires`.
    expect(
      rerunFailureLastRun(
        new ManagedExchangeExpiredError("2026-07-01T00:00:00.000Z"),
        AT,
        false,
        false,
      ),
    ).toBeUndefined();
    expect(
      rerunFailureLastRun(
        new ManagedExchangeLockUnavailableError("id"),
        AT,
        false,
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

  test("an internal fault on a lapsed record is not re-mapped to the expiry", () => {
    // Core tags InternalConsistencyError on the class, and raises it from the
    // single-pass reply-cap backstop mid-data-exchange -- so a bound that lapses
    // during a long run satisfies the tag and the lapse alike, unlike the
    // handshake-time expiry the re-map exists for. Re-mapping it would report a
    // defect in psilink as a benign expiry and offer a fresh invitation, which
    // cannot fix it.
    expect(
      remapLapsedRunFailure(
        new InternalConsistencyError(
          "server: single-pass built a reply above the byte cap both parties " +
            "derive from their declared sizes; report it with this message.",
        ),
        { expires: "2026-07-14T11:59:00.000Z" },
        NOW,
      ),
    ).toBeUndefined();
  });

  test("a record with no bound never re-maps", () => {
    expect(remapLapsedRunFailure(taggedExpiryError(), {}, NOW)).toBeUndefined();
  });
});

describe("a run refused for terms this file cannot satisfy", () => {
  const AT = Date.parse("2026-07-14T12:00:00.000Z");
  const refusal = () =>
    new LinkageTermsUnsatisfiableError(
      "this input cannot satisfy every linkage key the agreed terms declare",
    );

  test("is a benign pre-connection state of its own, not a transport drop", () => {
    // It comes out of the pre-connection prepare, so no connection was attempted --
    // and it is held apart from the acquisition failure, which putting the file back
    // clears: this one reproduces on every run from the same file, so the surface it
    // reaches must not offer the run again as though it might pass.
    expect(benignRerunOutcome(refusal())).toBe("terms-shortfall");
  });

  test("the input guard's own column rejection reaches the same state, live and recorded", () => {
    // The guard grades ahead of the prepare, on the same rule, so its rejection and
    // core's refusal are one state rather than two the surface must reconcile. The
    // kind the critical section stamps for it comes from the same classifier, so a
    // revisit cannot read a state the live launch never showed.
    const columns = new ManagedInputError({
      reason: "columns",
      unsatisfied: [],
    });
    expect(benignRerunOutcome(columns)).toBe("terms-shortfall");
    expect(managedInputFailureKind(columns.rejection)).toBe("terms-shortfall");
    // An acquisition failure stays the retryable input state.
    const acquire = new ManagedInputError({
      reason: "acquire",
      cause: new Error("gone"),
    });
    expect(benignRerunOutcome(acquire)).toBe("input");
    expect(managedInputFailureKind(acquire.rejection)).toBe("input");
  });

  test("records its own tier, not the transport drop and not the input problem", () => {
    // The transport tier is retried in place and the input tier is re-picked in
    // place; this refusal reproduces on every run from the same file, so either
    // would send the next visit after a remedy that refuses identically.
    expect(rerunFailureLastRun(refusal(), AT, false, false)).toEqual({
      at: new Date(AT).toISOString(),
      outcome: "failed",
      failureKind: "terms-shortfall",
    });
  });

  test("a linkage refusal after the data exchange began records transport, not terms-shortfall", () => {
    // The "terms-shortfall" tier's copy tells the operator nothing left this device,
    // which only the phase boundary can prove. Core raises this refusal inside the
    // pre-connection prepare today; this pins that the tier depends on the boundary
    // rather than on where the refusal happens to be raised, so a later call site
    // past the boundary falls through to the neither-way transport bucket.
    expect(rerunFailureLastRun(refusal(), AT, false, true)).toEqual({
      at: new Date(AT).toISOString(),
      outcome: "failed",
      failureKind: "transport",
    });
  });

  test("keeps the terms-shortfall tier even on a cancelled run", () => {
    // The refusal is a deterministic local state read before the connection, so
    // it is not a teardown-provoked error the cancellation could explain.
    expect(rerunFailureLastRun(refusal(), AT, true, false)?.failureKind).toBe(
      "terms-shortfall",
    );
  });
});
