/// <reference types="@vitest/browser-playwright/context" />
/// <reference types="vite/client" />

import {
  ConnectionError,
  generateSharedSecret,
  getDefaultLinkageTerms,
} from "@psilink/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  clearManagedExchanges,
  createManagedExchange,
  getManagedExchange,
} from "@psi/managedExchangeStore";
import { ManagedExchangeExpiredError } from "@psi/managedExpiry";
import { composeManagedExchangeFile } from "@psi/managedExchangeRecord";
import { runManagedRerun } from "@psi/managedRun";

import type {
  ManagedExchangeRecord,
  NewManagedExchange,
} from "@psi/managedExchangeRecord";
import type { WebRTCExchangeLocator } from "@psilink/core";

// The re-run orchestration launched from a STORED record, against real Chromium
// (real Web Locks and real IndexedDB), with the rendezvous/handshake/data-exchange
// seams faked (no broker, no WASM): a run launches from the record with NO
// invitation, the persist-before-success ordering runs and records `lastRun`, and
// the pre-connection expiry check short-circuits before the lock. The pure
// decisions and the side dispatch are unit-tested in Node; this pins the launch
// composed over the real platform seams.

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
    handshake: () => {
      order.push("handshake");
      return Promise.resolve({ rotatedSecret, handshake: "carried" });
    },
    dataExchange: async () => {
      order.push("dataExchange");
      if (onDataExchange !== undefined) await onDataExchange();
      return "exchanged";
    },
  };
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

    // The failure landed in the record's bookkeeping (the evidence the desync
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

  test("a bound that lapses mid-run surfaces as the benign expiry state, unrecorded", async () => {
    // Live at the pre-connection check, lapsed by the time the handshake fails:
    // the clock advances past the bound inside the run, and the handshake throws
    // core's tagged expiry error (as the real handshake would with expires
    // enforced). The orchestration re-maps it to the benign expiry error; no
    // lastRun is written (the record's own expires carries the lapse).
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
                { psilinkRecoveryHintEmitted: true },
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
