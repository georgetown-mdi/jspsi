import {
  ConnectionError,
  InternalConsistencyError,
  LinkageTermsUnsatisfiableError,
  OutboundDisclosureRefusalError,
  generateSharedSecret,
  getDefaultLinkageTerms,
} from "@psilink/core";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  MANAGED_EXCHANGE_SCHEMA_VERSION,
  composeManagedExchangeFile,
} from "@psi/managed/managedExchangeRecord";
import {
  ManagedExchangeCustodyUnreadableError,
  ManagedExchangeSpentError,
} from "@psi/managed/managedExchangeRun";
import {
  ManagedExchangeExpiredError,
  benignRerunOutcome,
  remapLapsedRunFailure,
  rerunFailureLastRun,
  runManagedRerun,
} from "@psi/managed/managedRun";
import {
  ManagedInputError,
  managedInputFailureKind,
} from "@psi/managed/managedInputGuard";
import { ManagedExchangeLockUnavailableError } from "@psi/managed/managedExchangeLock";
import { PartnerNoShowError } from "@psi/transport/waitForConnection";
import { RotationPersistError } from "@psi/managed/managedRunRotate";
import { parseManagedLocalState } from "@psi/managed/managedLocalStateShape";
import { recordManagedExchangeLastRun } from "@psi/managed/managedExchangeStore";

import type { ManagedExchangeRecord } from "@psi/managed/managedExchangeRecord";

// The pure orchestration of a re-run, tested in Node for the parts that do NOT
// touch the platform (the pre-connection expiry short-circuit, which never reaches
// the lock, and the benign-outcome classification); the full launch-from-record path
// is exercised against real Chromium in test/browser/managedRun.test.ts. One ordering
// claim -- the phase boundary reported to the caller's failure classification --
// needs the run driven end to end here, against stubbed Web Locks and store writes.

vi.mock("@psi/managed/managedExchangeStore", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  persistManagedExchangeRotation: vi.fn(() => Promise.resolve()),
  recordManagedExchangeLastRun: vi.fn(() => Promise.resolve()),
}));

// The critical section reads the record's sibling state inside the lock to refuse
// a copy an export handed off. It is a real IndexedDB read in the browser, so it
// is the third platform piece these Node tests stub; `handedOff` is what the
// stubbed read answers with.
const handedOff = vi.hoisted(
  (): {
    state: { spent?: { spentAt: string } } | undefined;
    // What the read rejects with instead of answering, for the entry a schema
    // bound or an app upgrade invalidated.
    unreadable: unknown;
  } => ({ state: undefined, unreadable: undefined }),
);
vi.mock("@psi/managed/managedLocalState", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getManagedLocalState: () =>
    handedOff.unreadable === undefined
      ? Promise.resolve(handedOff.state)
      : Promise.reject(handedOff.unreadable),
}));

/** Grant the run+rotate lock immediately, so a Node test can drive the run through
 * the critical section the browser's Web Locks owns. */
function stubGrantingWebLocks(): void {
  vi.stubGlobal("navigator", {
    locks: {
      request: (
        _name: string,
        _options: unknown,
        critical: (lock: object) => Promise<unknown>,
      ) => critical({}),
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(recordManagedExchangeLastRun).mockClear();
  handedOff.state = undefined;
  handedOff.unreadable = undefined;
});

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

/** The rejection a corrupted or app-upgrade-invalidated sibling entry produces:
 * the validating read's own error, rather than a stand-in for one. */
function unreadableSiblingEntry(): unknown {
  try {
    parseManagedLocalState({ spent: { spentAt: "not an instant" } });
  } catch (error) {
    return error;
  }
  throw new Error("an invalid sibling entry must not parse");
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
  test("a lapsed record rejects with the expiry error before any platform call runs", async () => {
    const now = Date.parse("2026-07-14T12:00:00.000Z");
    const lapsed = record({ expires: "2026-07-01T00:00:00.000Z" });

    await expect(
      runManagedRerun(lapsed, unreachableSeams, { now: () => now }),
    ).rejects.toBeInstanceOf(ManagedExchangeExpiredError);
  });

  test("the expiry error has the record's lapsed instant", async () => {
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

describe("runManagedRerun: the phase boundary reported to the caller", () => {
  test("the caller learns the boundary before the data exchange runs", async () => {
    // The value the surface classifies a failure against: without this report a
    // classifier would have to take the record's own bookkeeping for the phase,
    // which is a best-effort write about whichever run last managed to stamp it.
    stubGrantingWebLocks();
    let boundaryReported = false;
    let reportedWhenExchangeRan: boolean | undefined;

    const result = await runManagedRerun(
      record(),
      {
        acquireInput: () => Promise.resolve("rows"),
        handshake: () =>
          Promise.resolve({
            rotatedSecret: generateSharedSecret(),
            handshake: "carried",
          }),
        dataExchange: () => {
          reportedWhenExchangeRan = boundaryReported;
          return Promise.resolve("exchanged");
        },
      },
      {
        onDataExchangeStart: () => {
          boundaryReported = true;
        },
      },
    );

    expect(reportedWhenExchangeRan).toBe(true);
    expect(result.exchange).toBe("exchanged");
  });

  test("a failure before the data exchange leaves the boundary unreported", async () => {
    // The phase every state whose copy says nothing left this device rests on: a
    // run that never reached the data exchange must not be treated as one that did.
    stubGrantingWebLocks();
    let boundaryReported = false;

    await expect(
      runManagedRerun(
        record(),
        {
          acquireInput: () => Promise.resolve("rows"),
          handshake: () =>
            Promise.reject(new PartnerNoShowError("nobody arrived")),
          dataExchange: () => {
            throw new Error("the data exchange must not run");
          },
        },
        {
          onDataExchangeStart: () => {
            boundaryReported = true;
          },
        },
      ),
    ).rejects.toBeInstanceOf(PartnerNoShowError);

    expect(boundaryReported).toBe(false);
  });
});

describe("runManagedRerun: a copy an export handed off", () => {
  test("refuses inside the lock, before the input is read", async () => {
    // The record loaded before the hand-off is what an attended surface still
    // holds and what a scheduled window claimed, so the refusal cannot rest on
    // either reading: the run re-reads the sibling state itself.
    stubGrantingWebLocks();
    handedOff.state = { spent: { spentAt: "2026-07-13T09:00:00.000Z" } };
    let inputRead = false;

    await expect(
      runManagedRerun(record(), {
        acquireInput: () => {
          inputRead = true;
          return Promise.resolve("rows");
        },
        handshake: () => {
          throw new Error("the handshake must not run for a handed-off copy");
        },
        dataExchange: () => {
          throw new Error(
            "the data exchange must not run for a handed-off copy",
          );
        },
      }),
    ).rejects.toBeInstanceOf(ManagedExchangeSpentError);

    // Nothing was read from the operator's file and nothing was dialed: the
    // refusal precedes the input guard, which precedes every connection.
    expect(inputRead).toBe(false);
  });

  test("records the handed-off outcome for whoever is not there to see it", async () => {
    // The scheduled case: nobody is present to answer, so the refusal is what the
    // record holds afterwards rather than a line in a log nobody reads.
    stubGrantingWebLocks();
    handedOff.state = { spent: { spentAt: "2026-07-13T09:00:00.000Z" } };
    const at = Date.parse("2026-07-14T12:00:00.000Z");

    await expect(
      runManagedRerun(
        record(),
        {
          acquireInput: () => Promise.resolve("rows"),
          handshake: () => {
            throw new Error("the handshake must not run for a handed-off copy");
          },
          dataExchange: () => {
            throw new Error(
              "the data exchange must not run for a handed-off copy",
            );
          },
        },
        { now: () => at },
      ),
    ).rejects.toBeInstanceOf(ManagedExchangeSpentError);

    expect(vi.mocked(recordManagedExchangeLastRun).mock.calls).toEqual([
      [
        "record-under-test",
        {
          at: new Date(at).toISOString(),
          outcome: "failed",
          failureKind: "handed-off",
        },
      ],
    ]);
  });

  test("an unreadable sibling entry refuses the run under its own kind", async () => {
    // A run that cannot read its custody does not proceed on the assumption the
    // copy is still this device's. The record then holds the custody-unreadable
    // kind rather than the retryable transport fault an unclassified failure would
    // offer for a permanent local problem, or the storage kind, which would report
    // a rotation that did not save -- and this run never reached the rotation.
    stubGrantingWebLocks();
    handedOff.unreadable = unreadableSiblingEntry();
    const at = Date.parse("2026-07-14T12:00:00.000Z");
    let inputRead = false;

    await expect(
      runManagedRerun(
        record(),
        {
          acquireInput: () => {
            inputRead = true;
            return Promise.resolve("rows");
          },
          handshake: () => {
            throw new Error("the handshake must not run on an unread custody");
          },
          dataExchange: () => {
            throw new Error(
              "the data exchange must not run on an unread custody",
            );
          },
        },
        { now: () => at },
      ),
    ).rejects.toBeInstanceOf(ManagedExchangeCustodyUnreadableError);

    // Fail-closed on the same terms as the hand-off refusal beside it: no file
    // read, nothing dialed.
    expect(inputRead).toBe(false);
    expect(vi.mocked(recordManagedExchangeLastRun).mock.calls).toEqual([
      [
        "record-under-test",
        {
          at: new Date(at).toISOString(),
          outcome: "failed",
          failureKind: "custody-unreadable",
        },
      ],
    ]);
  });

  test("a record with no hand-off runs as before", async () => {
    stubGrantingWebLocks();
    handedOff.state = { spent: undefined };

    const result = await runManagedRerun(record(), {
      acquireInput: () => Promise.resolve("rows"),
      handshake: () =>
        Promise.resolve({
          rotatedSecret: generateSharedSecret(),
          handshake: "carried",
        }),
      dataExchange: () => Promise.resolve("exchanged"),
    });

    expect(result.exchange).toBe("exchanged");
  });
});

describe("benignRerunOutcome", () => {
  test("classifies the benign pre-connection states", () => {
    expect(
      benignRerunOutcome(
        new ManagedExchangeExpiredError("2026-07-01T00:00:00Z"),
        false,
      ),
    ).toBe("expired");
    expect(
      benignRerunOutcome(
        new ManagedInputError({ reason: "acquire", cause: new Error("x") }),
        false,
      ),
    ).toBe("input");
    expect(
      benignRerunOutcome(new ManagedExchangeLockUnavailableError("id"), false),
    ).toBe("already-running");
    expect(benignRerunOutcome(new ManagedExchangeSpentError("id"), false)).toBe(
      "handed-off",
    );
    expect(
      benignRerunOutcome(
        new ManagedExchangeCustodyUnreadableError("id", new Error("invalid")),
        false,
      ),
    ).toBe("custody-unreadable");
  });

  test("an unreadable custody entry past the data-exchange boundary is not a benign outcome", () => {
    // The refusal is raised inside the lock before the input guard, exactly as
    // the hand-off one is, so it follows the same guard rather than resting on
    // where it is raised: past the boundary its copy's claim that nothing left
    // this device cannot be made.
    expect(
      benignRerunOutcome(
        new ManagedExchangeCustodyUnreadableError("id", new Error("invalid")),
        true,
      ),
    ).toBeUndefined();
  });

  test("a hand-off refusal past the data-exchange boundary is not a benign outcome", () => {
    // The refusal is raised inside the lock before the input guard, so it cannot
    // follow payload flow; this is the check that holds that rather than a
    // comment asserting it. Delivered past the boundary it is no longer the state
    // whose copy says nothing left this device.
    expect(benignRerunOutcome(new ManagedExchangeSpentError("id"), true)).toBe(
      undefined,
    );
  });

  test("a partner who never arrived is the benign missed state", () => {
    expect(
      benignRerunOutcome(new PartnerNoShowError("nobody came"), false),
    ).toBe("missed");
  });

  test("a no-show past the data-exchange boundary is not a benign outcome", () => {
    // This classification follows the same phase guard as its bookkeeping
    // counterpart (rerunFailureLastRun records "transport" for this same shape), so
    // the two cannot disagree about a disclosure. The rendezvous raises the no-show
    // only from a wait that never opened a channel; past the boundary it is no
    // longer the state whose copy says nothing left this device, so it falls
    // through to the caller's generic transport path.
    expect(
      benignRerunOutcome(new PartnerNoShowError("nobody came"), true),
    ).toBeUndefined();
  });

  test("an input rejection past the data-exchange boundary is not a benign outcome", () => {
    // The input guard's own column grading raises the same non-disclosure outcome
    // core's refusal does, so it follows the same boundary guard rather than
    // reaching the surface's "nothing left this device" copy on the strength of
    // the error's type. The guard runs before any connection.
    expect(
      benignRerunOutcome(
        new ManagedInputError({
          reason: "columns",
          unsatisfied: [{ name: "ssn", type: "ssn" }],
        }),
        true,
      ),
    ).toBeUndefined();
    expect(
      benignRerunOutcome(
        new ManagedInputError({ reason: "acquire", cause: new Error("x") }),
        true,
      ),
    ).toBeUndefined();
  });

  test("a linkage shortfall past the data-exchange boundary is not a benign outcome", () => {
    // The same guard, for the same reason: the shortfall state's copy tells the
    // operator the run stopped before connecting and nothing left this device, and
    // core raises it from the pre-connection prepare -- past the boundary that
    // claim cannot be made, whatever raised it.
    expect(
      benignRerunOutcome(
        new LinkageTermsUnsatisfiableError("refused at the run boundary"),
        true,
      ),
    ).toBeUndefined();
  });

  test("a handshake/storage/transport failure is not a benign pre-connection state", () => {
    expect(
      benignRerunOutcome(new Error("connection dropped"), false),
    ).toBeUndefined();
    expect(
      benignRerunOutcome(new RotationPersistError(0, new Error("db")), false),
    ).toBeUndefined();
  });
});

describe("rerunFailureLastRun: the runner's failure bookkeeping", () => {
  const AT = Date.parse("2026-07-14T12:00:00.000Z");

  test("a security-kind failure before the data exchange records an auth-kind failed run", () => {
    // The handshake failing closed provably precedes any payload, so the disclosure
    // copy can accurately say nothing was disclosed.
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

  test("a partner who never arrived records the benign missed outcome", () => {
    // The write this whole path exists for: a no-show is its own outcome, not the
    // transport fault a fall-through would file it as. No failureKind rides along --
    // the outcome is the whole account, and the read side keys off it alone.
    expect(
      rerunFailureLastRun(
        new PartnerNoShowError("timed out waiting for the other party"),
        AT,
        false,
        false,
      ),
    ).toEqual({ at: new Date(AT).toISOString(), outcome: "missed" });
  });

  test("a no-show outranks the abort probe", () => {
    // The rendezvous raises the no-show only on a wait that spent its whole budget,
    // which an abort cannot manufacture -- an aborted wait rejects through its own
    // path. So a cancel landing while this run unwinds must not overwrite the one
    // thing the run did establish: the partner was not there.
    expect(
      rerunFailureLastRun(
        new PartnerNoShowError("timed out waiting for the other party"),
        AT,
        true,
        false,
      ),
    ).toEqual({ at: new Date(AT).toISOString(), outcome: "missed" });
  });

  test("a no-show past the data-exchange boundary records transport, not missed", () => {
    // The "missed" outcome is what the disclosure copy reads to say nothing left
    // this device, so it follows the same phase guard as the auth and consent
    // tiers: past the boundary it cannot make that claim.
    expect(
      rerunFailureLastRun(
        new PartnerNoShowError("timed out waiting for the other party"),
        AT,
        false,
        true,
      ),
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
      false,
    );
    expect(lastRun?.failureKind).toBe("cancelled");
  });

  test("failures whose bookkeeping is owned elsewhere or absent by design record nothing", () => {
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
    // Expiry and lock-unavailable: no run began; a lapse is held by `expires`.
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
    // The hand-off refusal: recorded inside the critical section that raised it,
    // so the runner must not stamp a second, coarser entry over it.
    expect(
      rerunFailureLastRun(
        new ManagedExchangeSpentError("id"),
        AT,
        false,
        false,
      ),
    ).toBeUndefined();
    // The unread custody refusal beside it, for the same reason: the section
    // stamped the custody-unreadable tier, and a transport stamp over it would
    // offer a retry for a local problem that reproduces.
    expect(
      rerunFailureLastRun(
        new ManagedExchangeCustodyUnreadableError("id", new Error("invalid")),
        AT,
        false,
        false,
      ),
    ).toBeUndefined();
  });
});

describe("remapLapsedRunFailure: a bound that lapses mid-run", () => {
  const NOW = Date.parse("2026-07-14T12:00:00.000Z");

  /** Core's expiry errors have the recovery-hint tag (preserved across the
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
    // single-pass reply-cap safety check mid-data-exchange -- so a bound that lapses
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
    expect(benignRerunOutcome(refusal(), false)).toBe("terms-shortfall");
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
    expect(benignRerunOutcome(columns, false)).toBe("terms-shortfall");
    expect(managedInputFailureKind(columns.rejection)).toBe("terms-shortfall");
    // An acquisition failure stays the retryable input state.
    const acquire = new ManagedInputError({
      reason: "acquire",
      cause: new Error("gone"),
    });
    expect(benignRerunOutcome(acquire, false)).toBe("input");
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
