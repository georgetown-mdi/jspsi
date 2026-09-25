/// <reference types="@vitest/browser-playwright/context" />
/// <reference types="vite/client" />

import {
  ConnectionError,
  generateSharedSecret,
  getDefaultLinkageTerms,
} from "@alcove/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  ManagedExchangeLockUnavailableError,
  withManagedExchangeLock,
} from "@psi/managed/managedExchangeLock";
import {
  clearManagedExchanges,
  createManagedExchange,
  getManagedExchange,
} from "@psi/managed/managedExchangeStore";
import { ManagedExchangeExpiredError } from "@psi/managed/managedExpiry";
import { PartnerNoShowError } from "@psi/transport/waitForConnection";
import { composeManagedExchangeFile } from "@psi/managed/managedExchangeRecord";
import { readManagedFailure } from "@psi/managed/managedFailureTiers";
import { runManagedRerun } from "@psi/managed/managedRun";

import type {
  ManagedExchangeRecord,
  NewManagedExchange,
} from "@psi/managed/managedExchangeRecord";
import type { WebRTCExchangeLocator } from "@alcove/core";

// The re-run orchestration launched from a STORED record, against real Chromium
// (real Web Locks and real IndexedDB), with the rendezvous/handshake/data-exchange
// seams faked (no broker, no WASM): a run launches from the record with NO
// invitation, the persist-before-success ordering runs and records `lastRun`, and
// the pre-connection expiry check short-circuits before the lock. The pure
// decisions are unit-tested in Node; this covers the launch on the real platform.

const webrtcLocator: WebRTCExchangeLocator = {
  channel: "webrtc",
  host: "signaling.example.org",
  port: 3000,
  path: "/api/",
};

function newExchange(
  overrides: Partial<NewManagedExchange> = {},
): NewManagedExchange {
  return {
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: webrtcLocator,
      linkageTerms: getDefaultLinkageTerms("County Health Dept"),
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
    ...overrides,
  };
}

/** The faked seams a launch drives without a broker or WASM: acquireInput returns a
 * trivial input, handshake yields a rotated secret and a carried marker, and
 * dataExchange returns a result. Records the order so the test can assert
 * persist-before-success. */
function fakeSeams(
  rotatedSecret: string,
  order: Array<string>,
  onDataExchange?: () => Promise<void>,
) {
  return {
    acquireInput: () => {
      order.push("acquireInput");
      return Promise.resolve({ input: true });
    },
    handshake: async (
      _input: unknown,
      markRotationInFlight: () => Promise<void>,
    ) => {
      await markRotationInFlight();
      order.push("handshake");
      return { rotatedSecret, handshake: "carried" };
    },
    dataExchange: async () => {
      order.push("dataExchange");
      if (onDataExchange !== undefined) await onDataExchange();
      return "exchanged";
    },
  };
}

/** Whether an operator's own Run could take this record's lock right now, on the
 * attended surface's own fail-fast discipline. */
async function attendedRunCouldStart(id: string): Promise<boolean> {
  try {
    await withManagedExchangeLock(id, () => Promise.resolve(), {
      ifAvailable: true,
    });
    return true;
  } catch (error) {
    if (error instanceof ManagedExchangeLockUnavailableError) return false;
    throw error;
  }
}

beforeEach(async () => {
  await clearManagedExchanges();
});

afterEach(async () => {
  await clearManagedExchanges();
});

describe("runManagedRerun launched from a stored record", () => {
  test("launches from the record with no invitation and records success", async () => {
    const created = await createManagedExchange(newExchange());
    const rotatedSecret = generateSharedSecret();
    const order: Array<string> = [];

    // The launch takes ONLY the stored record and the run seams -- no invitation,
    // no token, no fresh secret. The record's own fields drive the run.
    const result = await runManagedRerun(
      created,
      fakeSeams(rotatedSecret, order),
    );

    expect(result.exchange).toBe("exchanged");
    // The pre-connection input guard ran before the handshake, and the data
    // exchange ran last (after the persist).
    expect(order).toEqual(["acquireInput", "handshake", "dataExchange"]);

    const stored = await getManagedExchange(created.id);
    // The rotated secret is durably persisted and the run recorded succeeded.
    expect(stored?.sharedSecret).toBe(rotatedSecret);
    expect(stored?.lastRun?.outcome).toBe("succeeded");
  });

  test("persists the rotated secret durably BEFORE the data exchange begins", async () => {
    const created = await createManagedExchange(newExchange());
    const rotatedSecret = generateSharedSecret();
    const order: Array<string> = [];
    let storedAtDataExchange: ManagedExchangeRecord | undefined;

    await runManagedRerun(
      created,
      fakeSeams(rotatedSecret, order, async () => {
        storedAtDataExchange = await getManagedExchange(created.id);
      }),
    );

    // At the moment the data exchange begins, the store already holds the rotated
    // secret (the persist resolved first) and no success stamp yet.
    expect(storedAtDataExchange?.sharedSecret).toBe(rotatedSecret);
    expect(storedAtDataExchange?.lastRun).toBeUndefined();
    // The same write removed the rotation-in-flight marker.
    expect(storedAtDataExchange?.rotationInFlightSince).toBeUndefined();
  });

  test("a lapsed record short-circuits before the lock, seams never run", async () => {
    const created = await createManagedExchange(
      newExchange({
        tokenMaxAgeDays: 30,
        expires: "2026-07-01T00:00:00.000Z",
      }),
    );
    const order: Array<string> = [];

    await expect(
      runManagedRerun(created, fakeSeams(generateSharedSecret(), order), {
        now: () => Date.parse("2026-07-14T12:00:00.000Z"),
      }),
    ).rejects.toBeInstanceOf(ManagedExchangeExpiredError);

    // No seam ran -- no connection was attempted -- and the stored secret is intact.
    expect(order).toEqual([]);
    const stored = await getManagedExchange(created.id);
    expect(stored?.sharedSecret).toBe(created.sharedSecret);
    expect(stored?.lastRun).toBeUndefined();
  });

  test("the acceptor side launches from the record the same way", async () => {
    const created = await createManagedExchange(
      newExchange({ side: "acceptor" }),
    );
    const rotatedSecret = generateSharedSecret();
    const order: Array<string> = [];

    const result = await runManagedRerun(
      created,
      fakeSeams(rotatedSecret, order),
    );

    expect(result.exchange).toBe("exchanged");
    expect((await getManagedExchange(created.id))?.sharedSecret).toBe(
      rotatedSecret,
    );
  });
});

describe("runManagedRerun: the runner's failure bookkeeping", () => {
  test("a failed-closed handshake records an auth-kind failed run", async () => {
    const created = await createManagedExchange(newExchange());

    await expect(
      runManagedRerun(created, {
        acquireInput: () => Promise.resolve(undefined),
        handshake: () =>
          Promise.reject(
            new ConnectionError(
              "key exchange authentication failed",
              "security",
            ),
          ),
        dataExchange: () => Promise.resolve("unreached"),
      }),
    ).rejects.toBeInstanceOf(ConnectionError);

    // The failure was written to the record's bookkeeping (the evidence the desync
    // tiering later reads), and the secret did not rotate.
    const stored = await getManagedExchange(created.id);
    expect(stored?.lastRun?.outcome).toBe("failed");
    expect(stored?.lastRun?.failureKind).toBe("auth");
    expect(stored?.sharedSecret).toBe(created.sharedSecret);
  });

  test("a data-exchange drop records a transport-kind failed run, rotation kept", async () => {
    const created = await createManagedExchange(newExchange());
    const rotatedSecret = generateSharedSecret();

    await expect(
      runManagedRerun(created, {
        acquireInput: () => Promise.resolve(undefined),
        handshake: () => Promise.resolve({ rotatedSecret, handshake: "c" }),
        dataExchange: () =>
          Promise.reject(new Error("data channel dropped mid-exchange")),
      }),
    ).rejects.toThrow("data channel dropped mid-exchange");

    const stored = await getManagedExchange(created.id);
    // The rotation is real (both parties rotated at handshake completion) and the
    // failed outcome is recorded so the list does not keep showing a stale success.
    expect(stored?.sharedSecret).toBe(rotatedSecret);
    expect(stored?.lastRun?.outcome).toBe("failed");
    expect(stored?.lastRun?.failureKind).toBe("transport");
  });

  test("a cancelled run records cancelled", async () => {
    const created = await createManagedExchange(newExchange());

    await expect(
      runManagedRerun(
        created,
        {
          acquireInput: () => Promise.resolve(undefined),
          handshake: () => Promise.reject(new Error("torn down mid-listen")),
          dataExchange: () => Promise.resolve("unreached"),
        },
        { aborted: () => true },
      ),
    ).rejects.toThrow("torn down mid-listen");

    const stored = await getManagedExchange(created.id);
    expect(stored?.lastRun?.outcome).toBe("failed");
    expect(stored?.lastRun?.failureKind).toBe("cancelled");
  });

  test("a cancel cutting a stalled payload exchange frees the lock and records cancelled", async () => {
    // The recovery a partner that stops mid-payload would otherwise leave
    // nowhere but closing the tab: the lock spans the payload exchange, so the
    // run holds it while a wait the partner's silence sustains stands. The
    // cancel reaches that wait by closing the run's connection, whose `closed`
    // rejection is what the exchange below stands in for (the driver's own half
    // is pinned in test/unit/psi/managedRunDriver.test.ts). What this holds is
    // everything after it, on real Web Locks and real IndexedDB.
    const created = await createManagedExchange(newExchange());
    const rotatedSecret = generateSharedSecret();
    const controller = new AbortController();
    let reachedExchange!: () => void;
    const exchanging = new Promise<void>((resolve) => {
      reachedExchange = resolve;
    });

    const running = runManagedRerun(
      created,
      {
        acquireInput: () => Promise.resolve(undefined),
        handshake: () => Promise.resolve({ rotatedSecret, handshake: "c" }),
        dataExchange: async () => {
          reachedExchange();
          await new Promise<void>((resolve) => {
            controller.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
          throw new ConnectionError("connection closed", "closed");
        },
      },
      { aborted: () => controller.signal.aborted },
    );

    await exchanging;
    // The run is stalled in its exchange with the lock in its hands.
    expect(await attendedRunCouldStart(created.id)).toBe(false);
    controller.abort();
    await expect(running).rejects.toThrow("connection closed");

    // Free for the next run, without the tab that held it being destroyed.
    expect(await attendedRunCouldStart(created.id)).toBe(true);
    const stored = await getManagedExchange(created.id);
    // Where a failed run leaves the record: the rotation stands, the outcome is
    // the operator's cancel, and no success was stamped over it.
    expect(stored?.sharedSecret).toBe(rotatedSecret);
    expect(stored?.lastRun?.outcome).toBe("failed");
    expect(stored?.lastRun?.failureKind).toBe("cancelled");
  });

  test("a bound that lapses mid-run shows as the benign expiry state, unrecorded", async () => {
    // Live at the pre-connection check, lapsed by the time the handshake fails:
    // the clock advances past the bound inside the run, and the handshake throws
    // core's tagged expiry error (as the real handshake would with expires
    // enforced). The orchestration re-maps it to the benign expiry error; no
    // lastRun is written (the record's own expires holds the lapse).
    const expires = "2026-07-14T12:05:00.000Z";
    const created = await createManagedExchange(newExchange({ expires }));
    let clock = Date.parse("2026-07-14T12:00:00.000Z");

    await expect(
      runManagedRerun(
        created,
        {
          acquireInput: () => Promise.resolve(undefined),
          handshake: () => {
            clock = Date.parse("2026-07-14T12:10:00.000Z");
            return Promise.reject(
              Object.assign(
                new Error(
                  `shared secret expired at ${expires} during the round-trip`,
                ),
                { alcoveRecoveryHintEmitted: true },
              ),
            );
          },
          dataExchange: () => Promise.resolve("unreached"),
        },
        { now: () => clock },
      ),
    ).rejects.toBeInstanceOf(ManagedExchangeExpiredError);

    const stored = await getManagedExchange(created.id);
    expect(stored?.lastRun).toBeUndefined();
    expect(stored?.sharedSecret).toBe(created.sharedSecret);
  });
});

describe("runManagedRerun: a rotation in flight across a crash", () => {
  test("the marker is on disk before the key exchange and gone after the rotation", async () => {
    const created = await createManagedExchange(newExchange());
    const at = Date.parse("2026-07-14T12:00:00.000Z");
    let storedAtKeyExchange: ManagedExchangeRecord | undefined;

    await runManagedRerun(
      created,
      {
        acquireInput: () => Promise.resolve({ input: true }),
        handshake: async (_input, markRotationInFlight) => {
          await markRotationInFlight();
          storedAtKeyExchange = await getManagedExchange(created.id);
          return {
            rotatedSecret: generateSharedSecret(),
            handshake: "carried",
          };
        },
        dataExchange: () => Promise.resolve("exchanged"),
      },
      { now: () => at },
    );

    expect(storedAtKeyExchange?.sharedSecret).toBe(created.sharedSecret);
    expect(storedAtKeyExchange?.rotationInFlightSince).toBe(
      new Date(at).toISOString(),
    );
    const stored = await getManagedExchange(created.id);
    expect(stored?.rotationInFlightSince).toBeUndefined();
    expect(stored?.lastRun?.outcome).toBe("succeeded");
  });

  test("a run cut in its key exchange is read at the next no-show and cleared by the next success", async () => {
    const created = await createManagedExchange(newExchange());
    const cutAt = Date.parse("2026-07-14T12:00:00.000Z");

    // The key exchange started and the run ended before the rotation write:
    // the secret stands, and the marker is what the run left behind.
    await expect(
      runManagedRerun(
        created,
        {
          acquireInput: () => Promise.resolve({ input: true }),
          handshake: async (_input, markRotationInFlight) => {
            await markRotationInFlight();
            throw new ConnectionError("the channel closed", "transport");
          },
          dataExchange: () => Promise.resolve("never"),
        },
        { now: () => cutAt },
      ),
    ).rejects.toBeInstanceOf(ConnectionError);
    const afterCut = await getManagedExchange(created.id);
    expect(afterCut?.sharedSecret).toBe(created.sharedSecret);
    expect(afterCut?.rotationInFlightSince).toBe(new Date(cutAt).toISOString());
    // Not yet a reading of its own: no run since has missed the partner.
    expect(
      readManagedFailure(afterCut as ManagedExchangeRecord, undefined, cutAt)
        .tier,
    ).toBe("transport");

    // The next run meets nobody -- the partner's rendezvous follows a secret
    // this device did not save.
    const missedAt = cutAt + 86_400_000;
    await expect(
      runManagedRerun(
        afterCut as ManagedExchangeRecord,
        {
          acquireInput: () => Promise.resolve({ input: true }),
          handshake: () =>
            Promise.reject(new PartnerNoShowError("nobody arrived")),
          dataExchange: () => Promise.resolve("never"),
        },
        { now: () => missedAt },
      ),
    ).rejects.toBeInstanceOf(PartnerNoShowError);
    const afterMiss = await getManagedExchange(created.id);
    expect(afterMiss?.rotationInFlightSince).toBe(
      new Date(cutAt).toISOString(),
    );
    expect(
      readManagedFailure(
        afterMiss as ManagedExchangeRecord,
        undefined,
        missedAt,
      ),
    ).toEqual({ tier: "partial-rotation", standing: false });

    // A completed rotation clears it, and the reading with it.
    const doneAt = missedAt + 86_400_000;
    await runManagedRerun(
      afterMiss as ManagedExchangeRecord,
      {
        acquireInput: () => Promise.resolve({ input: true }),
        handshake: async (_input, markRotationInFlight) => {
          await markRotationInFlight();
          return {
            rotatedSecret: generateSharedSecret(),
            handshake: "carried",
          };
        },
        dataExchange: () => Promise.resolve("exchanged"),
      },
      { now: () => doneAt },
    );
    const afterSuccess = await getManagedExchange(created.id);
    expect(afterSuccess?.rotationInFlightSince).toBeUndefined();
    expect(
      readManagedFailure(
        afterSuccess as ManagedExchangeRecord,
        undefined,
        doneAt,
      ).tier,
    ).toBe("none");
  });
});
