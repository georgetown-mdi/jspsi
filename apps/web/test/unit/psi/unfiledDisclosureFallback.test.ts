import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { getLogger } from "@psilink/core";

import {
  clearUnfiledExchangeFlag,
  flagUnfiledExchange,
  unfiledExchangeFlagged,
} from "@psi/unfiledDisclosureFlag";
import {
  noteUnfiledDisclosureRun,
  readUnfiledDisclosures,
} from "@psi/unfiledDisclosureStore";

/**
 * What a run leaves when the browser's own database will not take the note: the
 * localStorage flag naming the exchange, and the store's fall back onto it.
 *
 * The database is stubbed into refusing rather than driven, which is the point of
 * the suite -- a full disk is not a state the browser suite can produce on demand
 * -- so the assertions are about where the fact lands, not about IndexedDB.
 */

vi.mock("@psi/managed/managedExchangeStore", () => ({
  MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME: "disclosures",
  openManagedExchangeDatabase: () =>
    Promise.reject(new Error("the quota refused the write")),
}));

const KEY = "psilink-unfiled-disclosure";

/** Install an in-memory localStorage over the node env (which has none) and hand
 * back its backing map so a test can assert what was persisted. */
function installStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
  });
  return store;
}

beforeEach(() => {
  // A refused note and a refused flag both report themselves to the diagnostic
  // log, which is the run's only remaining account of the loss; kept out of the
  // suite's output.
  vi.spyOn(getLogger("unfiledDisclosureStore"), "error").mockImplementation(
    () => {},
  );
  vi.spyOn(getLogger("unfiledDisclosureFlag"), "warn").mockImplementation(
    () => {},
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the flag", () => {
  test("a flagged exchange reads back and clears", () => {
    installStorage();

    expect(flagUnfiledExchange("exchange-a")).toBe(true);
    expect(unfiledExchangeFlagged("exchange-a")).toBe(true);
    expect(unfiledExchangeFlagged("exchange-b")).toBe(false);

    clearUnfiledExchangeFlag("exchange-a");

    expect(unfiledExchangeFlagged("exchange-a")).toBe(false);
  });

  test("clearing the last flag leaves no value at rest", () => {
    const store = installStorage();
    flagUnfiledExchange("exchange-a");

    clearUnfiledExchangeFlag("exchange-a");

    expect(store.has(KEY)).toBe(false);
  });

  test("a value written under another version is treated as absent", () => {
    const store = installStorage();
    store.set(KEY, JSON.stringify({ v: 2, exchanges: ["exchange-a"] }));

    expect(unfiledExchangeFlagged("exchange-a")).toBe(false);
  });

  test("a second flag for one exchange keeps one entry", () => {
    const store = installStorage();

    expect(flagUnfiledExchange("exchange-a")).toBe(true);
    expect(flagUnfiledExchange("exchange-a")).toBe(true);

    expect(store.get(KEY)).toBe(
      JSON.stringify({ v: 1, exchanges: ["exchange-a"] }),
    );
  });

  test("a storage that refuses the write reports that nothing was kept", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
      removeItem: () => undefined,
    });

    expect(flagUnfiledExchange("exchange-a")).toBe(false);
  });
});

describe("a note the database refuses", () => {
  test("falls back to the flag, naming the exchange", async () => {
    installStorage();

    const noted = await noteUnfiledDisclosureRun(
      "exchange-a",
      undefined,
      "2026-07-01T09:00:01.000Z",
    );

    expect(noted).toBe("flagged");
    expect(unfiledExchangeFlagged("exchange-a")).toBe(true);
  });

  test("reports that nothing was kept when the flag is refused too", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
      removeItem: () => undefined,
    });

    const noted = await noteUnfiledDisclosureRun(
      "exchange-a",
      undefined,
      "2026-07-01T09:00:01.000Z",
    );

    // Nothing in this browser stands for the disclosure, so the run reports it
    // to the diagnostic log rather than to a store that refused it.
    expect(noted).toBe("nowhere");
  });
});

describe("a read the database refuses", () => {
  test("classifies as unavailable rather than as nothing missing", async () => {
    installStorage();

    expect(await readUnfiledDisclosures("exchange-a")).toEqual({
      kind: "unavailable",
    });
  });
});
