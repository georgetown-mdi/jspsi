/// <reference types="@vitest/browser-playwright/context" />
/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@psilink/core";

import {
  ManagedExchangeLockUnavailableError,
  managedExchangeLockName,
  runManagedExchange,
  withManagedExchangeLock,
} from "@psi/managedExchangeRun";
import {
  clearManagedExchanges,
  createManagedExchange,
  getManagedExchange,
} from "@psi/managedExchangeStore";
import { ManagedInputError } from "@psi/managedInputGuard";
import { RotationPersistError } from "@psi/managedRunRotate";
import { composeManagedExchangeFile } from "@psi/managedExchangeRecord";

import type { NewManagedExchange } from "@psi/managedExchangeRecord";
import type { WebRTCExchangeLocator } from "@psilink/core";

// The platform half of the run+rotate critical section, exercised against real
// Chromium (real Web Locks and real IndexedDB): the single-writer lock's exclusion
// under contention, the no-steal property, the strict-durability field-scoped
// rotation write, and the persist-before-success wiring end to end. The pure
// ordering and decision logic is unit-tested in Node without either platform in
// test/unit/managedRunRotate.test.ts.

const linkageTerms = getDefaultLinkageTerms("County Health Dept");

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
      linkageTerms,
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
    ...overrides,
  };
}

/** A deferred promise, so a test can hold a lock open until it chooses to release
 * it and observe a contending acquisition wait or fail. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(async () => {
  await clearManagedExchanges();
});

afterEach(async () => {
  await clearManagedExchanges();
});

describe("single-writer lock", () => {
  test("a second acquisition waits for the first to release", async () => {
    const id = "record-a";
    const order: Array<string> = [];
    const firstHeld = deferred<void>();
    const release = deferred<void>();

    const first = withManagedExchangeLock(id, async () => {
      order.push("first-enter");
      firstHeld.resolve();
      await release.promise;
      order.push("first-exit");
    });

    // Only start contending once the first holder is confirmed inside the lock.
    await firstHeld.promise;
    const second = withManagedExchangeLock(id, () => {
      order.push("second-enter");
      return Promise.resolve();
    });

    try {
      // Give the second acquisition a chance to (wrongly) barge in; it must not.
      await new Promise((r) => setTimeout(r, 50));
      expect(order).toEqual(["first-enter"]);
    } finally {
      // Release even if the assertion above throws, so a failing test cannot
      // strand the exclusive lock for the rest of the page's life.
      release.resolve();
      await Promise.all([first, second]);
    }
    // The second entered only after the first released -- serialized, not raced.
    expect(order).toEqual(["first-enter", "first-exit", "second-enter"]);
  });

  test("distinct record ids do not contend", async () => {
    const held = deferred<void>();
    const release = deferred<void>();
    const first = withManagedExchangeLock("record-a", async () => {
      held.resolve();
      await release.promise;
    });
    await held.promise;
    try {
      // A different id's lock is a different name, so it runs immediately.
      await expect(
        withManagedExchangeLock("record-b", () => Promise.resolve("ran")),
      ).resolves.toBe("ran");
    } finally {
      release.resolve();
      await first;
    }
  });

  test("ifAvailable refuses rather than waits when the lock is held", async () => {
    const id = "record-a";
    const held = deferred<void>();
    const release = deferred<void>();
    const first = withManagedExchangeLock(id, async () => {
      held.resolve();
      await release.promise;
    });
    await held.promise;

    try {
      await expect(
        withManagedExchangeLock(id, () => Promise.resolve("ran"), {
          ifAvailable: true,
        }),
      ).rejects.toBeInstanceOf(ManagedExchangeLockUnavailableError);
    } finally {
      release.resolve();
      await first;
    }
  });

  test("the lock is taken without steal (a concurrent steal is not requested)", async () => {
    // Prove the no-steal property structurally: intercept navigator.locks.request
    // and assert the run+rotate acquisition never passes `steal: true`. A steal
    // would wrench the lock from a live holder, defeating single-writer exclusion.
    const realRequest = navigator.locks.request.bind(navigator.locks);
    const seenOptions: Array<LockOptions | undefined> = [];
    // The overloads of request() make a faithful wrapper verbose; the run path
    // always calls the (name, options, callback) form, which is all we assert.
    (navigator.locks as unknown as { request: unknown }).request = (
      name: string,
      options: LockOptions,
      callback: (lock: Lock | null) => Promise<unknown>,
    ) => {
      seenOptions.push(options);
      return realRequest(name, options, callback);
    };
    try {
      await withManagedExchangeLock("record-a", () => Promise.resolve("ran"));
    } finally {
      (navigator.locks as unknown as { request: typeof realRequest }).request =
        realRequest;
    }
    expect(seenOptions).toHaveLength(1);
    expect(seenOptions[0]?.steal).toBeUndefined();
    expect(seenOptions[0]?.mode).toBe("exclusive");
  });

  test("the lock releases when the critical section rejects", async () => {
    await expect(
      withManagedExchangeLock("record-a", () =>
        Promise.reject(new Error("run failed inside the lock")),
      ),
    ).rejects.toThrow("run failed inside the lock");
    // A failed run must not strand the lock; ifAvailable would refuse (not
    // wait) if it were still held.
    await expect(
      withManagedExchangeLock("record-a", () => Promise.resolve("ran"), {
        ifAvailable: true,
      }),
    ).resolves.toBe("ran");
  });

  test("the lock name is namespaced to the record id", () => {
    expect(managedExchangeLockName("abc")).toBe("psilink-managed-exchange:abc");
  });
});

describe("runManagedExchange: persist-before-success end to end", () => {
  test("persists the rotated secret durably before the data exchange begins", async () => {
    const created = await createManagedExchange(newExchange());
    const rotatedSecret = generateSharedSecret();
    const order: Array<string> = [];
    // The stored record as seen at the moment the data exchange begins -- the
    // secret must already be the rotated one (the persist resolved first), and
    // no success stamp may exist yet (it is recorded only after the data
    // exchange completes).
    let storedAtDataExchange:
      Awaited<ReturnType<typeof getManagedExchange>> | undefined;

    const result = await runManagedExchange({
      record: created,
      acquireInput: () => Promise.resolve(undefined),
      handshake: () => {
        order.push("handshake");
        return Promise.resolve({ rotatedSecret, handshake: "carried" });
      },
      dataExchange: async (carried: string) => {
        order.push("dataExchange");
        storedAtDataExchange = await getManagedExchange(created.id);
        return `exchanged:${carried}`;
      },
    });

    expect(order).toEqual(["handshake", "dataExchange"]);
    expect(storedAtDataExchange?.sharedSecret).toBe(rotatedSecret);
    // No success stamp during the data exchange: succeeded lands strictly after.
    expect(storedAtDataExchange?.lastRun).toBeUndefined();
    expect(result.exchange).toBe("exchanged:carried");
    // The success outcome landed on the store.
    const stored = await getManagedExchange(created.id);
    expect(stored?.sharedSecret).toBe(rotatedSecret);
    expect(stored?.lastRun?.outcome).toBe("succeeded");
  });

  test("the rotation write uses a strict-durability transaction", async () => {
    const created = await createManagedExchange(newExchange());
    const rotatedSecret = generateSharedSecret();

    // Observe the durability of the readwrite transactions the run opens: the
    // persist-before-success write requests strict durability (OS writeback before
    // complete), the renderer-crash-consistency the secret at rest relies on.
    const realTransaction = IDBDatabase.prototype.transaction;
    const durabilities: Array<IDBTransactionDurability | undefined> = [];
    IDBDatabase.prototype.transaction = function (
      this: IDBDatabase,
      storeNames: string | Array<string>,
      mode?: IDBTransactionMode,
      options?: IDBTransactionOptions,
    ) {
      if (mode === "readwrite") durabilities.push(options?.durability);
      return realTransaction.call(this, storeNames, mode, options);
    };
    try {
      await runManagedExchange({
        record: created,
        acquireInput: () => Promise.resolve(undefined),
        handshake: () => Promise.resolve({ rotatedSecret, handshake: "c" }),
        dataExchange: () => Promise.resolve("done"),
      });
    } finally {
      IDBDatabase.prototype.transaction = realTransaction;
    }

    // Every readwrite the run opened (the rotation persist and the lastRun record)
    // is strict; none defaulted to relaxed durability.
    expect(durabilities.length).toBeGreaterThanOrEqual(1);
    for (const durability of durabilities) expect(durability).toBe("strict");
  });

  test("the rotation write is field-scoped: it advances the secret, not the label", async () => {
    const created = await createManagedExchange(
      newExchange({ label: "original label" }),
    );
    const rotatedSecret = generateSharedSecret();
    await runManagedExchange({
      record: created,
      acquireInput: () => Promise.resolve(undefined),
      handshake: () => Promise.resolve({ rotatedSecret, handshake: "c" }),
      dataExchange: () => Promise.resolve("done"),
    });
    const stored = await getManagedExchange(created.id);
    // The rotation advanced only the secret; the document and label are intact.
    expect(stored?.sharedSecret).toBe(rotatedSecret);
    expect(stored?.label).toBe("original label");
    expect(stored?.exchangeFile).toEqual(created.exchangeFile);
  });

  test("restamps expires from tokenMaxAgeDays on a successful run", async () => {
    const created = await createManagedExchange(
      newExchange({ tokenMaxAgeDays: 90 }),
    );
    const rotatedSecret = generateSharedSecret();
    const rotationAt = Date.parse("2026-07-14T12:00:00.000Z");
    await runManagedExchange({
      record: created,
      acquireInput: () => Promise.resolve(undefined),
      handshake: () => Promise.resolve({ rotatedSecret, handshake: "c" }),
      dataExchange: () => Promise.resolve("done"),
      now: () => rotationAt,
    });
    const stored = await getManagedExchange(created.id);
    expect(stored?.expires).toBe(
      new Date(rotationAt + 90 * 86_400_000).toISOString(),
    );
  });

  test("no policy clears any standing expires bound on rotation", async () => {
    const created = await createManagedExchange(
      newExchange({ expires: "2026-09-01T00:00:00.000Z" }),
    );
    const rotatedSecret = generateSharedSecret();
    await runManagedExchange({
      record: created,
      acquireInput: () => Promise.resolve(undefined),
      handshake: () => Promise.resolve({ rotatedSecret, handshake: "c" }),
      dataExchange: () => Promise.resolve("done"),
    });
    // A record with no max-age policy must not keep a stale bound armed.
    expect((await getManagedExchange(created.id))?.expires).toBeUndefined();
  });

  test("a persist failure records a storage failure and never begins the data exchange", async () => {
    const created = await createManagedExchange(newExchange());
    const rotatedSecret = generateSharedSecret();
    let dataExchangeRan = false;

    // Force the rotation persist to fail by aborting the FIRST readwrite
    // transaction the run opens, sparing the follow-up bookkeeping write. The
    // put's own transaction abort surfaces as a rejected persist, which the
    // ordering turns into the storage-tier failure.
    const realTransaction = IDBDatabase.prototype.transaction;
    let failNextReadwrite = true;
    IDBDatabase.prototype.transaction = function (
      this: IDBDatabase,
      storeNames: string | Array<string>,
      mode?: IDBTransactionMode,
      options?: IDBTransactionOptions,
    ) {
      const transaction = realTransaction.call(this, storeNames, mode, options);
      if (mode === "readwrite" && failNextReadwrite) {
        failNextReadwrite = false;
        // Abort on the next microtask, after the store.get/put are queued, so the
        // rotation's read-modify-write transaction fails as a storage error.
        queueMicrotask(() => {
          try {
            transaction.abort();
          } catch {
            // Already settled; nothing to abort.
          }
        });
      }
      return transaction;
    };

    let error: unknown;
    try {
      await runManagedExchange({
        record: created,
        acquireInput: () => Promise.resolve(undefined),
        handshake: () => Promise.resolve({ rotatedSecret, handshake: "c" }),
        dataExchange: () => {
          dataExchangeRan = true;
          return Promise.resolve("done");
        },
      });
    } catch (reason) {
      error = reason;
    } finally {
      IDBDatabase.prototype.transaction = realTransaction;
    }

    expect(error).toBeInstanceOf(RotationPersistError);
    expect(dataExchangeRan).toBe(false);
    // The record still holds the pre-rotation secret (the rotation did not commit),
    // and the run is recorded as a benign-tier storage failure.
    const stored = await getManagedExchange(created.id);
    expect(stored?.sharedSecret).toBe(created.sharedSecret);
    expect(stored?.lastRun?.outcome).toBe("failed");
    expect(stored?.lastRun?.failureKind).toBe("storage");
  });

  test("a total storage fault still surfaces the RotationPersistError, not the bookkeeping failure", async () => {
    const created = await createManagedExchange(newExchange());
    const rotatedSecret = generateSharedSecret();
    let dataExchangeRan = false;

    // Fail EVERY readwrite the run opens: the rotation persist fails, and so
    // does the in-catch storage bookkeeping write. The second rejection must not
    // replace the RotationPersistError -- the runner's classification, and the
    // storage lastRun the error carries, depend on the original propagating.
    const realTransaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (
      this: IDBDatabase,
      storeNames: string | Array<string>,
      mode?: IDBTransactionMode,
      options?: IDBTransactionOptions,
    ) {
      const transaction = realTransaction.call(this, storeNames, mode, options);
      if (mode === "readwrite") {
        queueMicrotask(() => {
          try {
            transaction.abort();
          } catch {
            // Already settled; nothing to abort.
          }
        });
      }
      return transaction;
    };

    let error: unknown;
    try {
      await runManagedExchange({
        record: created,
        acquireInput: () => Promise.resolve(undefined),
        handshake: () => Promise.resolve({ rotatedSecret, handshake: "c" }),
        dataExchange: () => {
          dataExchangeRan = true;
          return Promise.resolve("done");
        },
      });
    } catch (reason) {
      error = reason;
    } finally {
      IDBDatabase.prototype.transaction = realTransaction;
    }

    // The original error survives the failed bookkeeping write, still carrying
    // the storage lastRun for the runner to classify on.
    expect(error).toBeInstanceOf(RotationPersistError);
    expect((error as RotationPersistError).lastRun.failureKind).toBe("storage");
    expect(dataExchangeRan).toBe(false);
    // Nothing committed: the old secret is retained and no bookkeeping landed
    // (the write failed; the evidence travels on the error instead).
    const stored = await getManagedExchange(created.id);
    expect(stored?.sharedSecret).toBe(created.sharedSecret);
    expect(stored?.lastRun).toBeUndefined();
  });

  test("a total storage fault still surfaces the ManagedInputError, not the bookkeeping failure", async () => {
    const created = await createManagedExchange(newExchange());
    let handshakeRan = false;

    // Fail EVERY readwrite the run opens: the input tier's best-effort `input`
    // bookkeeping write fails alongside the input rejection. The second rejection
    // must not replace the ManagedInputError -- the runner's classification
    // depends on the original propagating, exactly as in the storage tier above.
    const realTransaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (
      this: IDBDatabase,
      storeNames: string | Array<string>,
      mode?: IDBTransactionMode,
      options?: IDBTransactionOptions,
    ) {
      const transaction = realTransaction.call(this, storeNames, mode, options);
      if (mode === "readwrite") {
        queueMicrotask(() => {
          try {
            transaction.abort();
          } catch {
            // Already settled; nothing to abort.
          }
        });
      }
      return transaction;
    };

    const inputFailure = new ManagedInputError({
      reason: "acquire",
      cause: new Error("the entry was not found"),
    });
    let error: unknown;
    try {
      await runManagedExchange({
        record: created,
        acquireInput: () => Promise.reject(inputFailure),
        handshake: () => {
          handshakeRan = true;
          return Promise.resolve({
            rotatedSecret: generateSharedSecret(),
            handshake: "c",
          });
        },
        dataExchange: () => Promise.resolve("done"),
      });
    } catch (reason) {
      error = reason;
    } finally {
      IDBDatabase.prototype.transaction = realTransaction;
    }

    // The exact instance survives the failed bookkeeping write -- not wrapped,
    // not replaced by the bookkeeping rejection.
    expect(error).toBe(inputFailure);
    // No connection was attempted and nothing committed: the guard failed before
    // the handshake, the pre-run secret is intact, and no bookkeeping landed.
    expect(handshakeRan).toBe(false);
    const stored = await getManagedExchange(created.id);
    expect(stored?.sharedSecret).toBe(created.sharedSecret);
    expect(stored?.lastRun).toBeUndefined();
  });

  test("two contended runs serialize: the second sees the first's rotated secret", async () => {
    const created = await createManagedExchange(newExchange());
    const firstRotated = generateSharedSecret();
    const secondRotated = generateSharedSecret();
    const firstInExchange = deferred<void>();
    const releaseFirst = deferred<void>();

    // The first run parks inside its data exchange (after it has rotated and
    // persisted, and released the lock). The second run then rotates from the
    // freshest stored record. Because the lock covers rotation+persist, the two
    // rotations cannot interleave: the second's field-scoped write lands on the
    // first's committed secret, never reverting it.
    const first = runManagedExchange({
      record: created,
      acquireInput: () => Promise.resolve(undefined),
      handshake: () =>
        Promise.resolve({ rotatedSecret: firstRotated, handshake: "1" }),
      dataExchange: async () => {
        firstInExchange.resolve();
        await releaseFirst.promise;
        return "1";
      },
    });

    await firstInExchange.promise;
    let second: Promise<unknown> = Promise.resolve();
    try {
      const secretBeforeSecond = (await getManagedExchange(created.id))
        ?.sharedSecret;
      expect(secretBeforeSecond).toBe(firstRotated);

      second = runManagedExchange({
        record: { id: created.id },
        acquireInput: () => Promise.resolve(undefined),
        handshake: () =>
          Promise.resolve({ rotatedSecret: secondRotated, handshake: "2" }),
        dataExchange: () => Promise.resolve("2"),
      });
    } finally {
      // Unpark the first run even if an assertion above throws, so neither run
      // hangs the suite.
      releaseFirst.resolve();
      await Promise.all([first, second]);
    }

    // The second rotation advanced the secret without reverting the first's write.
    expect((await getManagedExchange(created.id))?.sharedSecret).toBe(
      secondRotated,
    );
  });

  test("a data-exchange failure propagates unchanged, with the rotation kept and no success recorded", async () => {
    const created = await createManagedExchange(newExchange());
    const rotatedSecret = generateSharedSecret();
    const failure = new Error("data channel dropped mid-exchange");

    const error: unknown = await runManagedExchange({
      record: created,
      acquireInput: () => Promise.resolve(undefined),
      handshake: () => Promise.resolve({ rotatedSecret, handshake: "c" }),
      dataExchange: () => Promise.reject(failure),
    }).then(
      () => {
        throw new Error(
          "the run should have rejected with the exchange failure",
        );
      },
      (reason: unknown) => reason,
    );

    // The exact instance propagates -- not wrapped, not re-tagged -- for the
    // runner to classify and record.
    expect(error).toBe(failure);
    const stored = await getManagedExchange(created.id);
    // The rotation is real even though the exchange then failed: both parties
    // rotated at handshake completion, so the persisted secret must stay rotated.
    expect(stored?.sharedSecret).toBe(rotatedSecret);
    // No succeeded outcome was recorded; the failure bookkeeping is the runner's.
    expect(stored?.lastRun).toBeUndefined();
  });

  test("a slow run's stale success tail cannot mask a newer run's outcome", async () => {
    const created = await createManagedExchange(newExchange());
    const earlierRunAt = Date.parse("2026-07-14T12:00:00.000Z");
    const laterRunAt = Date.parse("2026-07-14T13:00:00.000Z");
    const firstInExchange = deferred<void>();
    const releaseFirst = deferred<void>();

    // The first run rotates, releases the lock, and parks in its data exchange;
    // its success bookkeeping will land last, stamped with the older clock. The
    // second run completes fully in between, recording the newer outcome.
    const first = runManagedExchange({
      record: created,
      acquireInput: () => Promise.resolve(undefined),
      handshake: () =>
        Promise.resolve({
          rotatedSecret: generateSharedSecret(),
          handshake: "1",
        }),
      dataExchange: async () => {
        firstInExchange.resolve();
        await releaseFirst.promise;
        return "1";
      },
      now: () => earlierRunAt,
    });

    await firstInExchange.promise;
    try {
      await runManagedExchange({
        record: { id: created.id },
        acquireInput: () => Promise.resolve(undefined),
        handshake: () =>
          Promise.resolve({
            rotatedSecret: generateSharedSecret(),
            handshake: "2",
          }),
        dataExchange: () => Promise.resolve("2"),
        now: () => laterRunAt,
      });
    } finally {
      releaseFirst.resolve();
      await first;
    }

    // The first run's tail wrote after the second's, but with an older stamp:
    // the monotonic bookkeeping write no-ops, keeping the newer run's outcome.
    expect((await getManagedExchange(created.id))?.lastRun?.at).toBe(
      new Date(laterRunAt).toISOString(),
    );
  });
});
