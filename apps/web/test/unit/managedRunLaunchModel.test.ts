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
} from "@recurring/managedRunLaunchModel";

import {
  MANAGED_EXCHANGE_SCHEMA_VERSION,
  applyManagedExchangeLastRun,
  composeManagedExchangeFile,
} from "@psi/managedExchangeRecord";
import {
  ManagedExchangeCustodyUnreadableError,
  ManagedExchangeSpentError,
} from "@psi/managedExchangeRun";
import {
  RotationPersistError,
  missedRun,
  storageFailureRun,
} from "@psi/managedRunRotate";
import { ManagedExchangeExpiredError } from "@psi/managedExpiry";
import { ManagedExchangeLockUnavailableError } from "@psi/managedExchangeLock";
import { ManagedInputError } from "@psi/managedInputGuard";
import { PartnerNoShowError } from "@psi/waitForConnection";

import type {
  ManagedExchangeLastRun,
  ManagedExchangeRecord,
} from "@psi/managedExchangeRecord";
import type {
  ManagedRunFailure,
  ManagedRunFailureAlert,
} from "@recurring/managedRunLaunchModel";
import type { ManagedLocalState } from "@psi/managedLocalState";

// The launch surface's failure classification, tested in Node: the pre-connection
// benign states come from the error; a failed-closed handshake and every other
// recorded failure are TIERED from the record's own bookkeeping, so the surface shows
// the tier's specific copy and recovery. No benign tier is treated as attack framing;
// only the unexplained tier follows the doc's confirmation framing.

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

/** Classify a launch failure with one record standing for both readings the
 * classification takes -- the shape of a run whose own bookkeeping stamp did not
 * change what the classification reads, and of the host's fallback when the
 * post-failure reload rejects. The tests that turn on the difference between the
 * two readings build them separately. */
function classifyStateAgainstOneRecord(
  error: unknown,
  recordForBothReadings: ManagedExchangeRecord,
  local: ManagedLocalState | undefined,
  now: number,
  dataExchangeStarted: boolean,
): ManagedRunFailure {
  return classifyManagedRunFailure(
    error,
    {
      atLaunch: recordForBothReadings,
      afterRun: recordForBothReadings,
    },
    local,
    now,
    dataExchangeStarted,
  );
}

/** A classified state's copy, asserted to be there. Every state has copy except
 * the hand-off one, which the surface consumes by settling onto the stored spent
 * state, so a test reading copy off that state is reading prose that does not
 * exist. */
function withCopy(
  failure: ManagedRunFailure | undefined,
): ManagedRunFailureAlert {
  if (failure === undefined || failure.kind === "handed-off")
    throw new Error(
      `expected a classified state carrying copy, got ${String(failure?.kind)}`,
    );
  return failure;
}

/** {@link classifyStateAgainstOneRecord}, narrowed to the states that have copy --
 * what every test drives except the two that drive the hand-off state itself. */
function classifyAgainstOneRecord(
  error: unknown,
  recordForBothReadings: ManagedExchangeRecord,
  local: ManagedLocalState | undefined,
  now: number,
  dataExchangeStarted: boolean,
): ManagedRunFailureAlert {
  return withCopy(
    classifyStateAgainstOneRecord(
      error,
      recordForBothReadings,
      local,
      now,
      dataExchangeStarted,
    ),
  );
}

describe("classifyManagedRunFailure: pre-connection benign states from the error", () => {
  test("a lapsed secret is the benign expiry state with re-invite copy naming the lapse", () => {
    const failure = classifyAgainstOneRecord(
      new ManagedExchangeExpiredError("2026-07-01T00:00:00.000Z"),
      record(),
      undefined,
      NOW,
      false,
    );
    expect(failure.kind).toBe("expired");
    expect(failure.recovery).toBe("reinvite");
    expect(failure.message).toMatch(/re-invite/i);
    expect(failure.message).toMatch(/2026/);
    expect(failure.message).not.toMatch(/attack|tamper|impersonat/i);
  });

  test("an unreadable input is the benign input state, retried in place", () => {
    const failure = classifyAgainstOneRecord(
      new ManagedInputError({
        reason: "acquire",
        cause: new Error("NotFoundError"),
      }),
      record(),
      undefined,
      NOW,
      false,
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
      const failure = classifyAgainstOneRecord(
        error,
        record(),
        undefined,
        NOW,
        false,
      );
      expect(failure.kind).toBe("terms-shortfall");
      expect(failure.recovery).toBe("restate");
      expect(managedRunRetryable(failure)).toBe(false);
      expect(failure.message).not.toMatch(/ssn/);
      expect(failure.message).toMatch(/every linkage key/);
    }
  });

  test("a run in progress elsewhere is the benign already-running state", () => {
    const failure = classifyAgainstOneRecord(
      new ManagedExchangeLockUnavailableError("id"),
      record(),
      undefined,
      NOW,
      false,
    );
    expect(failure.kind).toBe("already-running");
    expect(failure.recovery).toBe("wait");
  });

  test("a run that met a handed-off copy refuses outright, with no way back offered", () => {
    // The attended half of the hand-off refusal, in the shape the real refusal
    // leaves: the operator clicked Run on a surface that loaded before the
    // hand-off, and the critical section stamped the kind before it threw. What
    // they get is the refusal and where the exchange runs now -- no retry, no
    // re-invite, and no override that would take the exchange back. Reaching this
    // kind is what settles the surface onto the spent state.
    const failure = classifyStateAgainstOneRecord(
      new ManagedExchangeSpentError("abc"),
      record({ lastRun: failed("handed-off") }),
      { spent: { spentAt: "2026-07-13T09:00:00.000Z" } },
      NOW,
      false,
    );
    expect(failure.kind).toBe("handed-off");
    expect(failure.recovery).toBe("none");
    expect(managedRunRetryable(failure)).toBe(false);
    expect(managedRunReinvites(failure)).toBe(false);
    // The state has no copy of its own: the spent surface it settles onto is
    // what names the hand-off and what the refused run did, and copy authored here
    // would be prose no surface reaches (ManagedRunSurface.tsx).
    expect(failure).not.toHaveProperty("title");
    expect(failure).not.toHaveProperty("message");
  });

  test("the recorded hand-off kind reads the same at the next visit", () => {
    // The unattended half: a scheduled run that met the hand-off stamped the kind
    // and nobody saw it happen, so the same state must come back off the record.
    const failure = managedRunFailureFromRecord(
      record({ lastRun: failed("handed-off") }),
      { spent: { spentAt: "2026-07-13T09:00:00.000Z" } },
      NOW,
    );
    expect(failure?.kind).toBe("handed-off");
    expect(failure?.recovery).toBe("none");
    expect(failure).not.toHaveProperty("message");
  });

  test("a partner who never arrived is the benign no-show state, not the transport copy", () => {
    // The defect this closes: a no-show used to fall through to the transport
    // state, whose copy sends the operator to check their own connection for a
    // partner who was simply not there.
    const failure = classifyAgainstOneRecord(
      new PartnerNoShowError("timed out waiting for the other party"),
      record(),
      undefined,
      NOW,
      false,
    );
    expect(failure.kind).toBe("missed");
    expect(failure.recovery).toBe("none");
    expect(failure.title).toMatch(/partner did not arrive/i);
    expect(failure.message).not.toMatch(/temporary connection problem/);
    expect(failure.message).not.toMatch(/attack|tamper|impersonat/i);
    expect(managedRunRetryable(failure)).toBe(false);
    expect(managedRunReinvites(failure)).toBe(false);
  });

  test("the no-show copy points a repeat no-show at a re-invite", () => {
    // A pair holding different secrets no-shows every time, and this device cannot
    // tell that from an absent partner. The reassuring reading must therefore not
    // be the whole of what the operator is told: the copy names the re-invite for
    // the partner who WAS at their machine at an agreed time, in the same register
    // the storage and imported states use.
    const failure = classifyAgainstOneRecord(
      new PartnerNoShowError("timed out waiting for the other party"),
      record(),
      undefined,
      NOW,
      false,
    );
    expect(failure.kind).toBe("missed");
    expect(failure.message).toMatch(/keeps happening/i);
    expect(failure.message).toMatch(/re-invite your partner to reconnect/i);
    expect(failure.message).toMatch(/only replaces the secret/i);
  });

  test("a live no-show against a standing missed outcome keeps the no-show state", () => {
    // The repeat case: the run before this one also ended with nobody there, so
    // the record has a missed outcome of its own and the live error agrees
    // with it. Nothing the tiering derives from that displaces the no-show's copy.
    const failure = classifyAgainstOneRecord(
      new PartnerNoShowError("timed out waiting for the other party"),
      record({
        lastRun: { at: "2026-07-14T09:00:00.000Z", outcome: "missed" },
      }),
      undefined,
      NOW,
      false,
    );
    expect(failure.kind).toBe("missed");
    expect(failure.message).toMatch(/nothing left this device/i);
  });

  test("an unrelated live failure against a standing missed outcome takes the transport copy", () => {
    // The no-show copy claims nothing was exchanged and nothing left this device.
    // That claim belongs to the failure being classified, not to the record: a
    // failed run's bookkeeping write is best-effort and can be swallowed, so the
    // host classifies against its pre-run record when the post-failure reload
    // rejects, and an earlier run's missed outcome can still be standing while
    // THIS run failed. Both phases are driven here.
    for (const dataExchangeStarted of [false, true]) {
      const failure = classifyAgainstOneRecord(
        new Error("data channel dropped"),
        record({
          lastRun: { at: "2026-07-14T09:00:00.000Z", outcome: "missed" },
        }),
        undefined,
        NOW,
        dataExchangeStarted,
      );
      expect(failure.kind).toBe("transport");
      expect(failure.message).not.toMatch(/nothing left this device/i);
      expect(failure.message).not.toMatch(/did not arrive|never connected/i);
    }
  });

  test("a no-show delivered past the data-exchange boundary takes the transport copy", () => {
    // The rendezvous raises the no-show only from a wait that never opened a
    // channel, and this is the check that holds that rather than a comment
    // asserting it: past the boundary the run cannot attest that nothing left this
    // device, whatever the error's type says, so the neutral copy stands.
    const failure = classifyAgainstOneRecord(
      new PartnerNoShowError("timed out waiting for the other party"),
      record(),
      undefined,
      NOW,
      true,
    );
    expect(failure.kind).toBe("transport");
    expect(failure.message).not.toMatch(/nothing left this device/i);
  });

  test("a hand-off refusal delivered past the data-exchange boundary takes the transport copy", () => {
    // The third of the same guard: the run surface settles on this classified state
    // to put up the spent surface, so a refusal past the boundary must not reach it
    // either. Both routes to the kind are driven: read off the error, and derived
    // from the record's own standing stamp under a plain mid-exchange failure --
    // what a run meets when its bookkeeping write is swallowed or the post-failure
    // reload falls back to the pre-run record.
    for (const error of [
      new ManagedExchangeSpentError("abc"),
      new Error("data channel dropped"),
    ]) {
      const failure = classifyAgainstOneRecord(
        error,
        record({ lastRun: failed("handed-off") }),
        { spent: { spentAt: "2026-07-13T09:00:00.000Z" } },
        NOW,
        true,
      );
      expect(failure.kind).toBe("transport");
      expect(failure.message).not.toMatch(/nothing left this device/i);
    }
  });

  test("a run that could not read its custody entry is that state from the error alone", () => {
    // The record cannot hold this one: the store that failed the run's custody
    // read is the store the post-failure reload asks next, so the reload rejects
    // with it and the classification is left the pre-run record, holding no
    // stamp at all. Derived from that record alone the state is the retryable
    // transport tier -- a retry offered for a local problem that answers the same
    // way at every attempt, which is what this kind exists to prevent.
    const failure = classifyAgainstOneRecord(
      new ManagedExchangeCustodyUnreadableError("abc", new Error("invalid")),
      record(),
      undefined,
      NOW,
      false,
    );
    expect(failure.kind).toBe("custody-unreadable");
    expect(failure.recovery).toBe("none");
    expect(managedRunRetryable(failure)).toBe(false);
    expect(managedRunReinvites(failure)).toBe(false);
    expect(failure.message).toMatch(/could not read/i);
    expect(failure.message).toMatch(/nothing left this device/i);
    expect(failure.message).not.toMatch(/temporary connection problem/);
  });

  test("a linkage shortfall delivered past the data-exchange boundary takes the transport copy", () => {
    // The twin guard: the shortfall state's copy makes the same disclosure claim,
    // and core raises the refusal inside the pre-connection prepare, so the phase
    // rather than the error's type is what licenses the copy.
    const failure = classifyAgainstOneRecord(
      new LinkageTermsUnsatisfiableError("refused at the run boundary"),
      record(),
      undefined,
      NOW,
      true,
    );
    expect(failure.kind).toBe("transport");
    expect(failure.message).not.toMatch(/nothing left this device/i);
  });
});

describe("classifyManagedRunFailure: a no-show read against standing desync evidence", () => {
  const importMarker: ManagedLocalState = {
    imported: { importedAt: "2026-07-13T00:00:00.000Z" },
  };

  test("a standing import marker frames the no-show as the restored state", () => {
    // The desync case the import marker exists to steer to re-invite: the restored
    // copy holds a secret the partnership moved past, so both rendezvous ids derive
    // from it and the dial answers peer-unavailable to the end of the budget,
    // raising a no-show every time. The marker survives the run (only a rotation
    // consumes it), so the freshest lastRun is itself a no-show, and the tier
    // derivation alone would wrongly answer "missed".
    const failure = classifyAgainstOneRecord(
      new PartnerNoShowError("timed out waiting for the other party"),
      record({
        lastRun: { at: "2026-07-14T09:00:00.000Z", outcome: "missed" },
      }),
      importMarker,
      NOW,
      false,
    );
    expect(failure.kind).toBe("imported");
    expect(failure.recovery).toBe("reinvite");
    expect(managedRunReinvites(failure)).toBe(true);
    expect(failure.title).not.toMatch(/partner did not arrive/i);
  });

  test("a standing persist failure frames the no-show as the storage state", () => {
    // The other one-sided-desync signal, reaching the classification through the
    // record the host holds: this run's own missed stamp is best-effort, and the
    // host classifies against its pre-run record when the post-failure reload
    // rejects, so the storage kind can still be what the record says.
    const failure = classifyAgainstOneRecord(
      new PartnerNoShowError("timed out waiting for the other party"),
      record({ lastRun: failed("storage") }),
      undefined,
      NOW,
      false,
    );
    expect(failure.kind).toBe("storage");
    expect(failure.recovery).toBe("reinvite");
  });

  test("a standing unreadable custody entry leaves the no-show reading alone", () => {
    // The line the storage tier's outranking does not extend to: a reading that
    // failed rotated nothing, so it is no reason to think this device's secret is
    // no longer the partnership's, and framing an absent partner as a desync on
    // its evidence would point the operator at a re-invite for neither.
    const failure = classifyAgainstOneRecord(
      new PartnerNoShowError("timed out waiting for the other party"),
      record({ lastRun: failed("custody-unreadable") }),
      undefined,
      NOW,
      false,
    );
    expect(failure.kind).toBe("missed");
  });

  test("this run's own missed stamp does not erase the evidence it is read against", () => {
    // The sequence the host actually takes, with the run's own bookkeeping applied
    // through the real monotonic write: a standing persist failure, then this
    // run's no-show stamp, which REPLACES `lastRun` with an entry holding no
    // failureKind at all. Read from the reloaded record alone, the storage tier is
    // gone and the operator is told nothing on this device is at fault -- for the
    // one-sided desync that is precisely what produces a no-show every time.
    const atLaunch = record({ lastRun: failed("storage") });
    const afterRun = applyManagedExchangeLastRun(
      atLaunch,
      missedRun(Date.parse("2026-07-14T11:00:00.000Z")),
    );
    expect(afterRun.lastRun?.outcome).toBe("missed");
    expect(afterRun.lastRun?.failureKind).toBeUndefined();

    const failure = withCopy(
      classifyManagedRunFailure(
        new PartnerNoShowError("timed out waiting for the other party"),
        { atLaunch, afterRun },
        undefined,
        NOW,
        false,
      ),
    );
    expect(failure.kind).toBe("storage");
    expect(failure.recovery).toBe("reinvite");
    expect(managedRunReinvites(failure)).toBe(true);
    expect(failure.title).not.toMatch(/partner did not arrive/i);

    // Where the guarantee ends: it is the LIVE classification's. The stored record
    // a later visit reads holds the no-show alone, so the list line and the run
    // history name that rather than the persist failure standing behind it.
    expect(
      managedRunFailureFromRecord(afterRun, undefined, NOW),
    ).toBeUndefined();
  });

  test("a second run in one visit reads the evidence the first run left", () => {
    // Two runs in one mounted visit, each run's bookkeeping applied through the
    // real monotonic write. Nothing stands at the mount, so the first run's own
    // persist failure is the whole of the standing evidence the second run's
    // no-show is read against -- and the second run's stamp erases it as it goes.
    const persistFailedAt = Date.parse("2026-07-14T10:00:00.000Z");
    const atMount = record();
    const afterPersistFailure = applyManagedExchangeLastRun(
      atMount,
      storageFailureRun(persistFailedAt),
    );
    const afterNoShow = applyManagedExchangeLastRun(
      afterPersistFailure,
      missedRun(Date.parse("2026-07-14T11:00:00.000Z")),
    );

    const firstRun = classifyManagedRunFailure(
      new RotationPersistError(persistFailedAt, new Error("the write failed")),
      { atLaunch: atMount, afterRun: afterPersistFailure },
      undefined,
      NOW,
      false,
    );
    expect(firstRun.kind).toBe("storage");

    const secondRun = classifyManagedRunFailure(
      new PartnerNoShowError("timed out waiting for the other party"),
      { atLaunch: afterPersistFailure, afterRun: afterNoShow },
      undefined,
      NOW,
      false,
    );
    expect(secondRun.kind).toBe("storage");
    expect(secondRun.recovery).toBe("reinvite");

    // Which reading the at-launch record has to be: the mount's copy predates the
    // first run's failure, so a no-show read against it tells the operator nothing
    // on this device is at fault.
    const readAgainstTheMount = classifyManagedRunFailure(
      new PartnerNoShowError("timed out waiting for the other party"),
      { atLaunch: atMount, afterRun: afterNoShow },
      undefined,
      NOW,
      false,
    );
    expect(readAgainstTheMount.kind).toBe("missed");
  });

  test("a lapsed bound frames the no-show as the expiry state, naming the lapse", () => {
    // A bound that lapses during the wait: running again cannot succeed, so the
    // no-show's "run it again when they are ready" would be the wrong instruction.
    const failure = classifyAgainstOneRecord(
      new PartnerNoShowError("timed out waiting for the other party"),
      record({ expires: "2026-07-01T00:00:00.000Z" }),
      undefined,
      NOW,
      false,
    );
    expect(failure.kind).toBe("expired");
    expect(failure.recovery).toBe("reinvite");
    expect(failure.message).toMatch(/2026/);
  });

  test("a standing auth failure does not escalate a no-show to the attack framing", () => {
    // The exclusion the tiering rests on: no handshake ran, so nothing failed
    // closed, and a no-show is not the evidence the out-of-band confirmation is
    // reserved for. Only the Tier-1 re-invite states outrank the no-show reading.
    const failure = classifyAgainstOneRecord(
      new PartnerNoShowError("timed out waiting for the other party"),
      record({ lastRun: failed("auth") }),
      undefined,
      NOW,
      false,
    );
    expect(failure.kind).toBe("missed");
    expect(failure.recovery).toBe("none");
    expect(failure.message).not.toMatch(/attack|tamper|impersonat/i);
  });

  test("a no-show with nothing standing keeps the benign state", () => {
    // The evidence has to be the record's own: a clean record is treated as the
    // no-show, so the desync framings above are never the default reading of an
    // absent partner.
    for (const lastRun of [
      undefined,
      { at: "2026-07-14T09:00:00.000Z", outcome: "missed" } as const,
      { at: "2026-07-14T09:00:00.000Z", outcome: "succeeded" } as const,
      failed("transport"),
      failed("cancelled"),
    ]) {
      const failure = classifyAgainstOneRecord(
        new PartnerNoShowError("timed out waiting for the other party"),
        record(lastRun === undefined ? {} : { lastRun }),
        undefined,
        NOW,
        false,
      );
      expect(failure.kind).toBe("missed");
    }
  });
});

describe("classifyManagedRunFailure: the recorded tiers from the record's bookkeeping", () => {
  test("a recorded storage failure is the Tier-1 storage state with re-invite", () => {
    const failure = classifyAgainstOneRecord(
      new Error("handshake failed"),
      record({ lastRun: failed("storage") }),
      undefined,
      NOW,
      false,
    );
    expect(failure.kind).toBe("storage");
    expect(failure.recovery).toBe("reinvite");
    expect(failure.message).not.toMatch(/attack|tamper|impersonat/i);
  });

  test("a recorded unreadable custody entry is its own state, not the storage one", () => {
    // The attended path: this run's own refusal, classified against the record the
    // critical section stamped for it. What it must NOT reach is the storage
    // tier, whose copy reports a rotation that did not save and whose recovery is
    // a re-invite -- neither true of a run that refused before the handshake.
    const failure = classifyAgainstOneRecord(
      new ManagedExchangeCustodyUnreadableError("abc", new Error("invalid")),
      record({ lastRun: failed("custody-unreadable") }),
      undefined,
      NOW,
      false,
    );
    expect(failure.kind).toBe("custody-unreadable");
    expect(failure.recovery).not.toBe("reinvite");
    expect(managedRunReinvites(failure)).toBe(false);
    expect(managedRunRetryable(failure)).toBe(false);
    // The copy is about this browser's own stored copy, and says nothing about a
    // secret that did not save or about re-inviting.
    expect(failure.message).toMatch(/could not read/i);
    expect(failure.message).toMatch(/nothing left this device/i);
    expect(failure.message).not.toMatch(/re-invite|different secrets|save/i);
    expect(failure.message).not.toMatch(/attack|tamper|desync|impersonat/i);
  });

  test("a recorded auth failure with an import marker is the benign imported state", () => {
    const local: ManagedLocalState = {
      imported: { importedAt: "2026-07-13T00:00:00.000Z" },
    };
    const failure = classifyAgainstOneRecord(
      new Error("handshake failed"),
      record({ lastRun: failed("auth") }),
      local,
      NOW,
      false,
    );
    expect(failure.kind).toBe("imported");
    expect(failure.recovery).toBe("reinvite");
    expect(failure.message).not.toMatch(/attack|tamper|impersonat/i);
  });

  test("a recorded auth failure with no explanation is the unexplained confirmation state", () => {
    const failure = classifyAgainstOneRecord(
      new Error("handshake failed"),
      record({ lastRun: failed("auth") }),
      undefined,
      NOW,
      false,
    );
    expect(failure.kind).toBe("unexplained");
    expect(failure.recovery).toBe("confirm");
    // The lead directs to the out-of-band confirmation, not a bare re-invite.
    expect(failure.message).toMatch(/confirm with your partner/i);
    expect(failure.message).toMatch(/do not just re-invite/i);
  });

  test("a transport drop is the retryable transport state, never attack framing", () => {
    const failure = classifyAgainstOneRecord(
      new Error("data channel dropped"),
      record({ lastRun: failed("transport") }),
      undefined,
      NOW,
      false,
    );
    expect(failure.kind).toBe("transport");
    expect(failure.recovery).toBe("retry");
    expect(failure.message).not.toMatch(/attack|tamper|desync/i);
  });

  test("a recorded consent refusal is its own benign state naming what it sends", () => {
    const failure = classifyAgainstOneRecord(
      new Error("refused before connecting"),
      record({ lastRun: failed("consent") }),
      undefined,
      NOW,
      false,
    );
    expect(failure.kind).toBe("consent");
    expect(failure.recovery).toBe("reconfirm");
    // The copy names deciding what this exchange sends, not retrying a connection,
    // and is never treated as attack framing.
    expect(failure.message).toMatch(/sends|send/i);
    expect(failure.message).toMatch(/not a connection problem/i);
    expect(failure.message).not.toMatch(/attack|tamper|desync|impersonat/i);
  });
});

describe("classifyManagedRunFailure: the derived benign tiers take this run's boundary", () => {
  // Each tier below is derived from a stored kind whose copy attests what THIS run
  // disclosed, licensed only for the run that wrote it -- but a failed run's
  // bookkeeping write is best-effort, and the host classifies against its pre-run
  // record when the post-failure reload rejects, so an earlier stamp can still be
  // standing for a mid-exchange failure. Both directions are driven per tier: before
  // the boundary the tier and its copy stand, past it the generic copy does.

  test("a stored unreadable custody entry gives way past the boundary", () => {
    // The tier whose copy attests non-disclosure most explicitly -- it names the
    // partner as not contacted -- so a stale stamp read past the boundary would
    // have the surface vouch for a run that connected.
    const stamped = record({ lastRun: failed("custody-unreadable") });
    const before = classifyAgainstOneRecord(
      new Error("data channel dropped"),
      stamped,
      undefined,
      NOW,
      false,
    );
    expect(before.kind).toBe("custody-unreadable");
    expect(before.message).toMatch(/nothing left this device/i);
    expect(before.message).toMatch(/partner was not contacted/i);

    // Both routes to the tier: this run's own custody refusal, which the error-read
    // guard already declines past the boundary, and the tier derived from the
    // standing stamp under a plain mid-exchange failure.
    for (const error of [
      new ManagedExchangeCustodyUnreadableError("abc", new Error("invalid")),
      new Error("data channel dropped"),
    ]) {
      const failure = classifyAgainstOneRecord(
        error,
        stamped,
        undefined,
        NOW,
        true,
      );
      expect(failure.kind).toBe("transport");
      expect(failure.message).not.toMatch(/nothing left this device/i);
      expect(failure.message).not.toMatch(/partner was not contacted/i);
    }
  });

  test("a stored consent refusal gives way past the boundary", () => {
    // The record-only tier: no live error brings a disclosure refusal to this
    // classification, so the standing stamp is the whole of what it reads.
    const stamped = record({ lastRun: failed("consent") });
    const before = classifyAgainstOneRecord(
      new Error("refused before connecting"),
      stamped,
      undefined,
      NOW,
      false,
    );
    expect(before.kind).toBe("consent");
    expect(before.message).toMatch(/nothing left this device/i);

    const past = classifyAgainstOneRecord(
      new Error("data channel dropped"),
      stamped,
      undefined,
      NOW,
      true,
    );
    expect(past.kind).toBe("transport");
    expect(past.message).not.toMatch(/nothing left this device/i);
    expect(past.message).not.toMatch(/stopped before connecting/i);
  });

  test("a stored linkage shortfall gives way past the boundary", () => {
    const stamped = record({ lastRun: failed("terms-shortfall") });
    const before = classifyAgainstOneRecord(
      new Error("data channel dropped"),
      stamped,
      undefined,
      NOW,
      false,
    );
    expect(before.kind).toBe("terms-shortfall");
    expect(before.message).toMatch(/nothing left this device/i);

    for (const error of [
      new LinkageTermsUnsatisfiableError("refused at the run boundary"),
      new Error("data channel dropped"),
    ]) {
      const failure = classifyAgainstOneRecord(
        error,
        stamped,
        undefined,
        NOW,
        true,
      );
      expect(failure.kind).toBe("transport");
      expect(failure.message).not.toMatch(/nothing left this device/i);
    }
  });

  test("the tiers claiming nothing about this run's disclosure keep their reading", () => {
    // The gate is scoped to the attestation rather than applied to every derived
    // tier: a persist failure names a rotation that did not save, a restore names a
    // secret the partnership may have moved past, and both recover by re-invite
    // whichever side of the boundary this run failed on. Gating them would replace
    // that recovery with a retry the desync does not have, and would put the
    // unexplained tier's confirmation out of reach of the failure that needs it.
    const restored: ManagedLocalState = {
      imported: { importedAt: "2026-07-13T00:00:00.000Z" },
    };
    const ungated: Array<
      [
        ManagedExchangeRecord,
        ManagedLocalState | undefined,
        ManagedRunFailureAlert["kind"],
      ]
    > = [
      [record({ lastRun: failed("storage") }), undefined, "storage"],
      [record({ lastRun: failed("auth") }), restored, "imported"],
      [
        record({
          expires: "2026-07-01T00:00:00.000Z",
          lastRun: failed("auth"),
        }),
        undefined,
        "expired",
      ],
      [record({ lastRun: failed("input") }), undefined, "input"],
      [record({ lastRun: failed("auth") }), undefined, "unexplained"],
    ];
    for (const [stamped, sibling, kind] of ungated)
      expect(
        classifyAgainstOneRecord(
          new Error("data channel dropped"),
          stamped,
          sibling,
          NOW,
          true,
        ).kind,
      ).toBe(kind);
  });
});

describe("managedRunFailureFromRecord: the next-visit tier (no live launch)", () => {
  test("a stored auth failure shows the unexplained tier at the next visit", () => {
    const failure = managedRunFailureFromRecord(
      record({ lastRun: failed("auth") }),
      undefined,
      NOW,
    );
    expect(failure?.kind).toBe("unexplained");
  });

  test("a stored consent refusal shows the consent tier at the next visit", () => {
    const failure = managedRunFailureFromRecord(
      record({ lastRun: failed("consent") }),
      undefined,
      NOW,
    );
    expect(failure?.kind).toBe("consent");
    expect(failure?.recovery).toBe("reconfirm");
  });

  test("a stored terms shortfall shows its own tier, not the input re-pick", () => {
    // The case the split exists for: nobody was present when the unattended run
    // was refused, so the record alone decides what the next visit is told. The
    // remedy it names is a conforming file or re-agreed terms -- never a retry,
    // and never the file picker the input tier offers, which refuses identically.
    const failure = withCopy(
      managedRunFailureFromRecord(
        record({ lastRun: failed("terms-shortfall") }),
        undefined,
        NOW,
      ),
    );
    expect(failure.kind).toBe("terms-shortfall");
    expect(failure.recovery).toBe("restate");
    expect(managedRunRetryable(failure)).toBe(false);
    expect(managedRunReinvites(failure)).toBe(false);
    expect(failure.message).toMatch(/every linkage key/);
    expect(failure.message).toMatch(/not a connection problem/i);
    // Benign, exactly as the consent tier is: no desync or attack framing.
    expect(failure.message).not.toMatch(/attack|tamper|desync|impersonat/i);
  });

  test("a record written before the kind existed is still treated as the input tier", () => {
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

  test("a stored storage failure shows the storage tier at the next visit", () => {
    const failure = withCopy(
      managedRunFailureFromRecord(
        record({ lastRun: failed("storage") }),
        undefined,
        NOW,
      ),
    );
    expect(failure.kind).toBe("storage");
    expect(failure.recovery).toBe("reinvite");
    expect(failure.message).toMatch(/could not save its updated secret/);
  });

  test("a stored unreadable custody entry shows its own tier at the next visit", () => {
    // The unattended path: nothing classified a live error, so the record's own
    // stamp is the whole evidence -- and it must be treated as the unreadable-record
    // state rather than as the persist failure whose copy and re-invite recovery
    // fit only a rotation that did not save.
    const failure = withCopy(
      managedRunFailureFromRecord(
        record({ lastRun: failed("custody-unreadable") }),
        undefined,
        NOW,
      ),
    );
    expect(failure.kind).toBe("custody-unreadable");
    expect(failure.recovery).not.toBe("reinvite");
    expect(failure.message).not.toMatch(/could not save its updated secret/);
  });

  test("a lapsed record shows the expiry tier naming the real lapsed instant", () => {
    const failure = withCopy(
      managedRunFailureFromRecord(
        record({
          expires: "2026-07-01T00:00:00.000Z",
          lastRun: failed("auth"),
        }),
        undefined,
        NOW,
      ),
    );
    expect(failure.kind).toBe("expired");
    expect(failure.message).toMatch(/2026/);
  });

  test("a never-run or succeeded record shows no failure", () => {
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
    // The next-visit read of a recorded no-show is a status line rather than a
    // launch failure state, so it names the no-show without claiming anything
    // about what a later failure disclosed (its wording is pinned in
    // savedExchangesModel.test.ts and managedDetailModel.test.ts).
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
        classifyAgainstOneRecord(
          new ManagedInputError({ reason: "acquire", cause: new Error("x") }),
          record(),
          undefined,
          NOW,
          false,
        ),
      ),
    ).toBe(true);
    expect(
      managedRunRetryable(
        classifyAgainstOneRecord(
          new Error("drop"),
          record({ lastRun: failed("transport") }),
          undefined,
          NOW,
          false,
        ),
      ),
    ).toBe(true);
    expect(
      managedRunRetryable(
        classifyAgainstOneRecord(
          new ManagedExchangeExpiredError("2026-07-01T00:00:00.000Z"),
          record(),
          undefined,
          NOW,
          false,
        ),
      ),
    ).toBe(false);
  });

  test("a consent refusal is neither retryable in place nor a direct re-invite", () => {
    // The remedy is deciding what this exchange sends; retrying the same input
    // refuses identically, and re-minting the secret does not touch the disclosure.
    const failure = classifyAgainstOneRecord(
      new Error("refused before connecting"),
      record({ lastRun: failed("consent") }),
      undefined,
      NOW,
      false,
    );
    expect(managedRunRetryable(failure)).toBe(false);
    expect(managedRunReinvites(failure)).toBe(false);
  });

  test("the storage and imported tiers re-invite; the unexplained tier does not (it gates first)", () => {
    expect(
      managedRunReinvites(
        classifyAgainstOneRecord(
          new Error("x"),
          record({ lastRun: failed("storage") }),
          undefined,
          NOW,
          false,
        ),
      ),
    ).toBe(true);
    expect(
      managedRunReinvites(
        classifyAgainstOneRecord(
          new Error("x"),
          record({ lastRun: failed("auth") }),
          undefined,
          NOW,
          false,
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
    // imply otherwise, and must not be treated as a block on saving the second one.
    for (const side of ["acceptor", "inviter"] as const)
      expect(prose(side)).not.toMatch(
        /automatic|merge[sd]? (them|the two)|for you\b|cannot save/i,
      );
  });
});
