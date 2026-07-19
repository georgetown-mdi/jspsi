import { afterEach, describe, expect, test, vi } from "vitest";

import {
  fetchJobInputProfile,
  fetchJobInputs,
  postJobInputCoverage,
} from "@psi/workInputClient";
import { consoleCoverageProvider } from "@components/useNonEmptyRates";

import type { Standardization } from "@psilink/core";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const LISTING = {
  configured: true,
  files: [
    { name: "clients.csv", sizeBytes: 4096, modifiedAt: 1_700_000_000_000 },
  ],
};

// The wire profile: columnSamples ride as an ordered array of {column, values}
// pairs, which the client validates into a Map.
const PROFILE_WIRE = {
  name: "clients.csv",
  sizeBytes: 4096,
  modifiedAt: 1_700_000_000_000,
  rowCount: 2,
  columns: ["first_name", "dob"],
  dateInputFormat: "%m/%d/%Y",
  columnSamples: [
    { column: "first_name", values: ["Ann"] },
    { column: "dob", values: ["01/02/1990"] },
  ],
};

const REFERENCE = {
  name: "clients.csv",
};

const STANDARDIZATION: Standardization = [];

describe("fetchJobInputs", () => {
  test("returns the validated listing on a 200", async () => {
    const result = await fetchJobInputs(() =>
      Promise.resolve(jsonResponse(LISTING)),
    );
    expect(result).toEqual({ kind: "listing", listing: LISTING });
  });

  test("maps any non-2xx to error", async () => {
    expect(
      await fetchJobInputs(() =>
        Promise.resolve(new Response(null, { status: 500 })),
      ),
    ).toEqual({ kind: "error" });
  });

  test("maps a malformed body and a network error to error", async () => {
    expect(
      await fetchJobInputs(() =>
        Promise.resolve(jsonResponse({ configured: "yes" })),
      ),
    ).toEqual({ kind: "error" });
    expect(
      await fetchJobInputs(() => Promise.reject(new Error("down"))),
    ).toEqual({ kind: "error" });
  });
});

describe("fetchJobInputProfile", () => {
  test("returns the validated profile on a 200 and encodes the name", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(PROFILE_WIRE)));
    const result = await fetchJobInputProfile("a b.csv", fetchImpl);
    expect(result.kind).toBe("profile");
    if (result.kind !== "profile") throw new Error("expected a profile");
    const { profile } = result;
    expect(profile.name).toBe("clients.csv");
    expect(profile.columns).toEqual(["first_name", "dob"]);
    expect(profile.dateInputFormat).toBe("%m/%d/%Y");
    expect(profile.columnSamples).toBeInstanceOf(Map);
    expect(profile.columnSamples.get("first_name")).toEqual(["Ann"]);
    expect(profile.columnSamples.get("dob")).toEqual(["01/02/1990"]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/jobs/inputs/profile?name=a%20b.csv",
      { method: "GET" },
    );
  });

  test("validates prototype-member column names into ordinary map data", async () => {
    // A column named __proto__/constructor/prototype arrives as an array element, so
    // the validator keys it into a Map with no prototype-setter write and no inherited
    // member resolved on read.
    const wire = {
      ...PROFILE_WIRE,
      columns: ["__proto__", "constructor", "prototype"],
      columnSamples: [
        { column: "__proto__", values: ["a", "b"] },
        { column: "constructor", values: ["c"] },
        { column: "prototype", values: ["d"] },
      ],
    };
    const result = await fetchJobInputProfile("x", () =>
      Promise.resolve(jsonResponse(wire)),
    );
    expect(result.kind).toBe("profile");
    if (result.kind !== "profile") throw new Error("expected a profile");
    const { columnSamples } = result.profile;
    expect(columnSamples.get("__proto__")).toEqual(["a", "b"]);
    expect(columnSamples.get("constructor")).toEqual(["c"]);
    expect(columnSamples.get("prototype")).toEqual(["d"]);
    // No pollution: a fresh object is unaffected.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("rejects a columnSamples that is not an array of pairs", async () => {
    for (const bad of [
      { ...PROFILE_WIRE, columnSamples: { first_name: ["Ann"] } },
      { ...PROFILE_WIRE, columnSamples: [{ column: "a", values: "Ann" }] },
      { ...PROFILE_WIRE, columnSamples: [{ column: 1, values: ["Ann"] }] },
      { ...PROFILE_WIRE, columnSamples: [{ values: ["Ann"] }] },
    ]) {
      expect(
        await fetchJobInputProfile("x", () =>
          Promise.resolve(jsonResponse(bad)),
        ),
      ).toEqual({ kind: "unavailable" });
    }
  });

  test("maps a non-2xx to unavailable", async () => {
    expect(
      await fetchJobInputProfile("x", () =>
        Promise.resolve(new Response(null, { status: 404 })),
      ),
    ).toEqual({ kind: "unavailable" });
  });
});

describe("postJobInputCoverage", () => {
  test("posts the name and standardization, returning the rates on a 200", async () => {
    const rates = [
      {
        output: "name",
        input: "first_name",
        produced: 2,
        total: 2,
        rate: 1,
        unavailable: false,
      },
    ];
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({ rates })));
    const controller = new AbortController();
    const result = await postJobInputCoverage(
      REFERENCE,
      STANDARDIZATION,
      controller.signal,
      fetchImpl,
    );
    expect(result).toEqual(rates);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(init.body as string)).toEqual({
      name: REFERENCE.name,
      standardization: STANDARDIZATION,
    });
  });

  test("returns null on any non-2xx", async () => {
    for (const status of [400, 413, 429, 500]) {
      const result = await postJobInputCoverage(
        REFERENCE,
        STANDARDIZATION,
        new AbortController().signal,
        () => Promise.resolve(new Response(null, { status })),
      );
      expect(result).toBeNull();
    }
  });

  test("resolves null when the fetch rejects (offline / abort)", async () => {
    const result = await postJobInputCoverage(
      REFERENCE,
      STANDARDIZATION,
      new AbortController().signal,
      () => Promise.reject(new Error("network down")),
    );
    expect(result).toBeNull();
  });

  test("rejects a body whose entry has a malformed numeric field", async () => {
    // A NaN/undefined numeric that reached the silent-empty gate would fail it OPEN
    // for that field, so a malformed entry degrades the whole body to the error
    // state (null) rather than reporting a false coverage.
    for (const bad of [
      { output: "name", input: "first_name", produced: 2, total: 2 },
      { output: "name", input: "first_name", produced: "2", total: 2, rate: 1 },
      {
        output: "name",
        input: "first_name",
        produced: 2,
        total: 2,
        rate: null,
      },
      {
        output: "name",
        input: "first_name",
        produced: 2,
        total: 2,
        rate: 1,
        unavailable: "no",
      },
      { output: "", input: "first_name", produced: 2, total: 2, rate: 1 },
    ]) {
      const result = await postJobInputCoverage(
        REFERENCE,
        STANDARDIZATION,
        new AbortController().signal,
        () => Promise.resolve(jsonResponse({ rates: [bad] })),
      );
      expect(result).toBeNull();
    }
  });

  test("accepts an entry that omits the unavailable flag, defaulting it false", async () => {
    const result = await postJobInputCoverage(
      REFERENCE,
      STANDARDIZATION,
      new AbortController().signal,
      () =>
        Promise.resolve(
          jsonResponse({
            rates: [
              {
                output: "name",
                input: "first_name",
                produced: 2,
                total: 2,
                rate: 1,
              },
            ],
          }),
        ),
    );
    expect(result).toEqual([
      {
        output: "name",
        input: "first_name",
        produced: 2,
        total: 2,
        rate: 1,
        unavailable: false,
      },
    ]);
  });
});

describe("consoleCoverageProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Resolve to "settled" if `promise` settles before `ms`, else "pending". */
  function race(promise: Promise<unknown>, ms: number): Promise<string> {
    return Promise.race([
      promise.then(() => "settled"),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("pending"), ms),
      ),
    ]);
  }

  test("resolves the rates on a clean sweep", async () => {
    const rates = [
      {
        output: "name",
        input: "first_name",
        produced: 2,
        total: 2,
        rate: 1,
        unavailable: false,
      },
    ];
    vi.stubGlobal("fetch", () => Promise.resolve(jsonResponse({ rates })));
    const provider = consoleCoverageProvider(REFERENCE);
    await expect(provider.compute(STANDARDIZATION)).resolves.toEqual(rates);
    provider.dispose();
  });

  test("treats a 429 like a superseded response: the compute never settles", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response(null, { status: 429 })),
    );
    const provider = consoleCoverageProvider(REFERENCE);
    expect(await race(provider.compute(STANDARDIZATION), 50)).toBe("pending");
    provider.dispose();
  });
});
