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

/** Run once on the next read of the stored value, after that read has taken the
 * value it returns: how a test stands a second context's write exactly in the
 * window a read-modify-write leaves open. */
let onNextRead: (() => void) | undefined;

/** Install an in-memory localStorage over the node env (which has none) and hand
 * back its backing map so a test can assert what was persisted. */
function installStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => {
      const value = store.get(key) ?? null;
      const racing = onNextRead;
      onNextRead = undefined;
      racing?.();
      return value;
    },
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

/** Stand in for a context that reaches no lock manager: a browser without the
 * Web Locks API, where the writes below run unlocked. The node this suite runs
 * on implements the API, so the tests that hold the lock drive that one rather
 * than a stub of it. */
function installNoLockManager(): void {
  vi.stubGlobal("navigator", {});
}

beforeEach(() => {
  onNextRead = undefined;
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
  test("a flagged exchange reads back and clears", async () => {
    installStorage();

    expect(await flagUnfiledExchange("exchange-a")).toBe(true);
    expect(unfiledExchangeFlagged("exchange-a")).toBe(true);
    expect(unfiledExchangeFlagged("exchange-b")).toBe(false);

    await clearUnfiledExchangeFlag("exchange-a");

    expect(unfiledExchangeFlagged("exchange-a")).toBe(false);
  });

  test("clearing the last flag leaves no value at rest", async () => {
    const store = installStorage();
    await flagUnfiledExchange("exchange-a");

    await clearUnfiledExchangeFlag("exchange-a");

    expect(store.has(KEY)).toBe(false);
  });

  test("a value written under another version is treated as absent", () => {
    const store = installStorage();
    store.set(KEY, JSON.stringify({ v: 2, exchanges: ["exchange-a"] }));

    expect(unfiledExchangeFlagged("exchange-a")).toBe(false);
  });

  test("a second flag for one exchange keeps one entry", async () => {
    const store = installStorage();

    expect(await flagUnfiledExchange("exchange-a")).toBe(true);
    expect(await flagUnfiledExchange("exchange-a")).toBe(true);

    expect(store.get(KEY)).toBe(
      JSON.stringify({ v: 1, exchanges: ["exchange-a"] }),
    );
  });

  test("flags past the count bound are refused, keeping the ones stored", async () => {
    const store = installStorage();
    for (let index = 0; index < 20; index += 1)
      expect(await flagUnfiledExchange(`exchange-${index}`)).toBe(true);

    // An earlier exchange's unrecorded run is no less true than a later one's,
    // so the twenty-first is refused rather than displacing the first.
    expect(await flagUnfiledExchange("exchange-20")).toBe(false);
    expect(unfiledExchangeFlagged("exchange-0")).toBe(true);
    expect(unfiledExchangeFlagged("exchange-20")).toBe(false);
    expect(store.get(KEY)).toContain("exchange-0");
  });

  test("a flag that would take the value past its length bound is refused", async () => {
    const store = installStorage();
    // A record id is any non-empty string, so an imported record can carry one
    // this long; the value is written where storage is already short, so the
    // write is refused rather than grown.
    const enormous = "x".repeat(5000);

    expect(await flagUnfiledExchange(enormous)).toBe(false);
    expect(store.has(KEY)).toBe(false);
  });

  test("a flag within the length bound is stored", async () => {
    installStorage();
    const long = "x".repeat(4000);

    expect(await flagUnfiledExchange(long)).toBe(true);
    expect(unfiledExchangeFlagged(long)).toBe(true);
    // The next flag no longer fits beside it, and the one stored stands.
    expect(await flagUnfiledExchange("x".repeat(500))).toBe(false);
    expect(unfiledExchangeFlagged(long)).toBe(true);
  });

  test("a storage that refuses the write reports that nothing was kept", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
      removeItem: () => undefined,
    });

    expect(await flagUnfiledExchange("exchange-a")).toBe(false);
  });
});

describe("two contexts writing the flag value", () => {
  test("the lock keeps a flag written while another context clears one", async () => {
    const store = installStorage();
    await flagUnfiledExchange("exchange-a");

    // The second context writes in the window the clear's read opens: the clear
    // has taken the value it will write back, and has not written it yet.
    let racing: Promise<boolean> | undefined;
    onNextRead = () => {
      racing = flagUnfiledExchange("exchange-b");
    };
    await clearUnfiledExchangeFlag("exchange-a");
    expect(await racing).toBe(true);

    expect(store.get(KEY)).toBe(
      JSON.stringify({ v: 1, exchanges: ["exchange-b"] }),
    );
  });

  test("without a lock manager the clear drops that flag", async () => {
    const store = installStorage();
    installNoLockManager();
    await flagUnfiledExchange("exchange-a");

    let racing: Promise<boolean> | undefined;
    onNextRead = () => {
      racing = flagUnfiledExchange("exchange-b");
    };
    await clearUnfiledExchangeFlag("exchange-a");
    expect(await racing).toBe(true);

    // The stated limit of the unlocked fallback: the clear wrote back a value
    // taken before the flag landed, so the run that flag stood for is unnamed.
    expect(store.has(KEY)).toBe(false);
    expect(unfiledExchangeFlagged("exchange-b")).toBe(false);
  });

  test("a lock manager that refuses the request still writes", async () => {
    const store = installStorage();
    vi.stubGlobal("navigator", {
      locks: {
        request: () => Promise.reject(new Error("no lock for this context")),
      },
    });

    expect(await flagUnfiledExchange("exchange-a")).toBe(true);
    expect(store.get(KEY)).toBe(
      JSON.stringify({ v: 1, exchanges: ["exchange-a"] }),
    );
    await expect(
      clearUnfiledExchangeFlag("exchange-a"),
    ).resolves.toBeUndefined();
    expect(store.has(KEY)).toBe(false);
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
