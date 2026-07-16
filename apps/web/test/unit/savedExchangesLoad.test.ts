import { describe, expect, test } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@psilink/core";

import {
  MANAGED_EXCHANGE_SCHEMA_VERSION,
  composeManagedExchangeFile,
} from "@psi/managedExchangeRecord";
import { loadSavedExchanges } from "@bench/savedExchangesLoad";

import type { ManagedExchangeRecord } from "@psi/managedExchangeRecord";
import type { ManagedLocalState } from "@psi/managedLocalState";
import type { SavedExchangesLoadDeps } from "@bench/savedExchangesLoad";

// The home list's async load model, tested in Node with the store reads injected:
// the loading -> populated and loading -> empty ordering (the promise never resolves
// to a non-loading outcome before the reads settle), and the two failure classes --
// a store that cannot be opened at all (degrade to the quick path) versus a store
// that opens but whose read fails.

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

/** A deferred promise whose settlement the test drives, so the load's ordering is
 * observable: nothing about the outcome is decided until the test resolves it. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function deps(
  overrides: Partial<SavedExchangesLoadDeps> = {},
): SavedExchangesLoadDeps {
  return {
    openStore: () => Promise.resolve({ close: () => undefined }),
    listExchanges: () => Promise.resolve([]),
    listLocalState: () => Promise.resolve(new Map<string, ManagedLocalState>()),
    now: () => NOW,
    ...overrides,
  };
}

describe("loadSavedExchanges", () => {
  test("loading -> populated: resolves ready with a row per stored record", async () => {
    const result = await loadSavedExchanges(
      deps({
        listExchanges: () => Promise.resolve([record()]),
      }),
    );
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw new Error("expected ready");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.label).toBe("Riverbend quarterly");
  });

  test("loading -> empty: resolves ready with no rows when the store is empty", async () => {
    const result = await loadSavedExchanges(deps());
    expect(result).toEqual({ kind: "ready", rows: [] });
  });

  test("closes the probe connection on the success path so it is not leaked", async () => {
    let closed = false;
    await loadSavedExchanges(
      deps({
        openStore: () =>
          Promise.resolve({
            close: () => {
              closed = true;
            },
          }),
      }),
    );
    expect(closed).toBe(true);
  });

  test("does not resolve to a non-loading outcome before the reads settle", async () => {
    const records = deferred<Array<ManagedExchangeRecord>>();
    let settled: string | undefined;
    const pending = loadSavedExchanges(
      deps({ listExchanges: () => records.promise }),
    ).then((result) => {
      settled = result.kind;
    });

    // The open resolves immediately, but with the record read still pending the load
    // must not have resolved: the caller is still in its loading state, never a
    // premature empty or ready.
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBeUndefined();

    records.resolve([]);
    await pending;
    expect(settled).toBe("ready");
  });

  test("store cannot be opened at all -> unavailable (degrade to the quick path)", async () => {
    const result = await loadSavedExchanges(
      deps({ openStore: () => Promise.reject(new Error("storage blocked")) }),
    );
    expect(result).toEqual({ kind: "unavailable" });
  });

  test("an unopenable store never attempts the reads", async () => {
    let read = false;
    await loadSavedExchanges(
      deps({
        openStore: () => Promise.reject(new Error("no indexedDB")),
        listExchanges: () => {
          read = true;
          return Promise.resolve([]);
        },
      }),
    );
    expect(read).toBe(false);
  });

  test("store opens but the read fails -> failed, not unavailable", async () => {
    const result = await loadSavedExchanges(
      deps({
        listExchanges: () => Promise.reject(new Error("corrupt record")),
      }),
    );
    expect(result).toEqual({ kind: "failed" });
  });
});
