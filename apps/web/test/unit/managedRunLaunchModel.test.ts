import {
  LinkageTermsUnsatisfiableError,
  generateSharedSecret,
  getDefaultLinkageTerms,
} from "@psilink/core";
import { describe, expect, test } from "vitest";

import {
  classifyManagedRunFailure,
  managedReinviteRecoveryCopy,
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
import { PartnerNoShowError } from "@psi/waitForConnection";

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

  test("an unreadable input is the benign input state, retried in place", () => {
    const failure = classifyManagedRunFailure(
      new ManagedInputError({
        reason: "acquire",
        cause: new Error("NotFoundError"),
      }),
      record(),
      undefined,
      NOW,
    );
    expect(failure.kind).toBe("input");
    expect(failure.recovery).toBe("retry");
    expect(failure.message).not.toMatch(/NotFound/);
  });

  test("a linkage shortfall is not offered as a retry, and names no agreed key", () => {
    // The same file falls the same way short of the same keys however many times it
    // runs, so the surface must not offer the run again as though it might pass --
    // and the shortfall's detail is partner-authored, so the copy states the
    // condition instead of echoing it.
    for (const error of [
      new ManagedInputError({
        reason: "columns",
        unsatisfied: [{ name: "ssn", type: "ssn" }],
      }),
      new LinkageTermsUnsatisfiableError("refused at the run boundary"),
    ]) {
      const failure = classifyManagedRunFailure(
        error,
        record(),
        undefined,
        NOW,
      );
      expect(failure.kind).toBe("terms-shortfall");
      expect(failure.recovery).toBe("restate");
      expect(managedRunRetryable(failure)).toBe(false);
      expect(failure.message).not.toMatch(/ssn/);
      expect(failure.message).toMatch(/every linkage key/);
    }
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

  test("a partner who never arrived is the benign no-show state, not the transport copy", () => {
    // The defect this closes: a no-show used to fall through to the transport
    // state, whose copy sends the operator to check their own connection for a
    // partner who was simply not there.
    const failure = classifyManagedRunFailure(
      new PartnerNoShowError("timed out waiting for the other party"),
      record(),
      undefined,
      NOW,
    );
    expect(failure.kind).toBe("missed");
    expect(failure.recovery).toBe("none");
    expect(failure.title).toMatch(/partner did not arrive/i);
    expect(failure.message).not.toMatch(/temporary connection problem/);
    expect(failure.message).not.toMatch(/attack|tamper|impersonat/i);
    expect(managedRunRetryable(failure)).toBe(false);
    expect(managedRunReinvites(failure)).toBe(false);
  });

  test("a live no-show and its recorded outcome read the same", () => {
    // The bookkeeping the live launch just stamped is what a next visit tiers on,
    // so the two paths must not diverge: a record carrying the missed outcome
    // classifies to the same state as the error that produced it.
    const live = classifyManagedRunFailure(
      new PartnerNoShowError("timed out waiting for the other party"),
      record(),
      undefined,
      NOW,
    );
    const recorded = classifyManagedRunFailure(
      new Error("some later failure"),
      record({
        lastRun: { at: "2026-07-14T09:00:00.000Z", outcome: "missed" },
      }),
      undefined,
      NOW,
    );
    expect(recorded).toEqual(live);
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

  test("a recorded consent refusal is its own benign state naming what it sends", () => {
    const failure = classifyManagedRunFailure(
      new Error("refused before connecting"),
      record({ lastRun: failed("consent") }),
      undefined,
      NOW,
    );
    expect(failure.kind).toBe("consent");
    expect(failure.recovery).toBe("reconfirm");
    // The copy names settling what this exchange sends, not retrying a connection,
    // and never reads as attack framing.
    expect(failure.message).toMatch(/sends|send/i);
    expect(failure.message).toMatch(/not a connection problem/i);
    expect(failure.message).not.toMatch(/attack|tamper|desync|impersonat/i);
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

  test("a stored consent refusal surfaces the consent tier at the next visit", () => {
    const failure = managedRunFailureFromRecord(
      record({ lastRun: failed("consent") }),
      undefined,
      NOW,
    );
    expect(failure?.kind).toBe("consent");
    expect(failure?.recovery).toBe("reconfirm");
  });

  test("a stored terms shortfall surfaces its own tier, not the input re-pick", () => {
    // The case the split exists for: nobody was present when the unattended run
    // was refused, so the record alone decides what the next visit is told. The
    // remedy it names is a conforming file or re-agreed terms -- never a retry,
    // and never the file picker the input tier offers, which refuses identically.
    const failure = managedRunFailureFromRecord(
      record({ lastRun: failed("terms-shortfall") }),
      undefined,
      NOW,
    );
    if (failure === undefined) throw new Error("expected a failure state");
    expect(failure.kind).toBe("terms-shortfall");
    expect(failure.recovery).toBe("restate");
    expect(managedRunRetryable(failure)).toBe(false);
    expect(managedRunReinvites(failure)).toBe(false);
    expect(failure.message).toMatch(/every linkage key/);
    expect(failure.message).toMatch(/not a connection problem/i);
    // Benign, exactly as the consent tier is: no desync or attack framing.
    expect(failure.message).not.toMatch(/attack|tamper|desync|impersonat/i);
  });

  test("a record written before the kind existed still reads as the input tier", () => {
    // A shortfall an earlier build recorded as "input" keeps loading and reading
    // through the generic input state, whose copy covers the column case too.
    const failure = managedRunFailureFromRecord(
      record({ lastRun: failed("input") }),
      undefined,
      NOW,
    );
    expect(failure?.kind).toBe("input");
    expect(failure?.recovery).toBe("retry");
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

  test("a consent refusal is neither retryable in place nor a direct re-invite", () => {
    // The remedy is settling what this exchange sends; retrying the same input
    // refuses identically, and re-minting the secret does not touch the disclosure.
    const failure = classifyManagedRunFailure(
      new Error("refused before connecting"),
      record({ lastRun: failed("consent") }),
      undefined,
      NOW,
    );
    expect(managedRunRetryable(failure)).toBe(false);
    expect(managedRunReinvites(failure)).toBe(false);
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

describe("managedReinviteRecoveryCopy", () => {
  const prose = (side: ManagedExchangeRecord["side"]) =>
    managedReinviteRecoveryCopy(record({ side })).body.join(" ");

  test("the acceptor is told the accept saves a second exchange and to delete this one", () => {
    const copy = managedReinviteRecoveryCopy(record({ side: "acceptor" }));
    expect(copy.lead).toMatch(/ask your partner/i);
    // The second record, the delete instruction, and the affordance that performs it
    // -- the operator acts from this copy without a separate lookup.
    expect(copy.body.join(" ")).toMatch(/second/i);
    expect(copy.body.join(" ")).toMatch(/delete this superseded exchange/i);
    expect(copy.body.join(" ")).toMatch(/Delete button/);
    expect(copy.body.join(" ")).toMatch(/recurring exchanges/i);
  });

  test("the inviter's recovery gains no delete instruction", () => {
    // Re-minting rotates the record in place, so the inviter has nothing to clean up
    // and must not be told to delete the exchange it just recovered.
    const copy = managedReinviteRecoveryCopy(record({ side: "inviter" }));
    expect(copy.lead).toMatch(/re-invite your partner/i);
    expect(copy.body.join(" ")).not.toMatch(/delete/i);
    expect(copy.body.join(" ")).not.toMatch(/second/i);
  });

  test("the guidance is keyed off the record's own side, not its run history", () => {
    // Same record in every other respect: only `side` decides which recovery reads.
    expect(prose("acceptor")).not.toBe(prose("inviter"));
    expect(
      managedReinviteRecoveryCopy(
        record({ side: "acceptor", lastRun: failed("auth") }),
      ),
    ).toEqual(managedReinviteRecoveryCopy(record({ side: "acceptor" })));
    expect(
      managedReinviteRecoveryCopy(
        record({ side: "inviter", lastRun: failed("storage") }),
      ),
    ).toEqual(managedReinviteRecoveryCopy(record({ side: "inviter" })));
  });

  test("neither side's copy claims a duplicate is handled automatically", () => {
    // Nothing detects, merges, or retires a superseded record: the copy must not
    // imply otherwise, and must not read as a block on saving the second one.
    for (const side of ["acceptor", "inviter"] as const)
      expect(prose(side)).not.toMatch(
        /automatic|merge[sd]? (them|the two)|for you\b|cannot save/i,
      );
  });
});
