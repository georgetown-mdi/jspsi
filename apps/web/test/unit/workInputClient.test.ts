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
  totalEntries: 2,
  truncated: false,
  files: [
    { name: "clients.csv", sizeBytes: 4096, modifiedAt: 1_700_000_000_000 },
  ],
};

const PROFILE = {
  name: "clients.csv",
  sizeBytes: 4096,
  modifiedAt: 1_700_000_000_000,
  rowCount: 2,
  columns: ["first_name", "dob"],
  dateInputFormat: "%m/%d/%Y",
  columnSamples: { first_name: ["Ann"], dob: ["01/02/1990"] },
};

const REFERENCE = {
  name: "clients.csv",
  sizeBytes: 4096,
  modifiedAt: 1_700_000_000_000,
};

const STANDARDIZATION: Standardization = [];

describe("fetchJobInputs", () => {
  test("returns the validated listing on a 200", async () => {
    const result = await fetchJobInputs(() =>
      Promise.resolve(jsonResponse(LISTING)),
    );
    expect(result).toEqual({ kind: "listing", listing: LISTING });
  });

  test("maps a 429 to busy and any other non-2xx to error", async () => {
    expect(
      await fetchJobInputs(() =>
        Promise.resolve(new Response(null, { status: 429 })),
      ),
    ).toEqual({ kind: "busy" });
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
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(PROFILE)));
    const result = await fetchJobInputProfile("a b.csv", fetchImpl);
    expect(result).toEqual({ kind: "profile", profile: PROFILE });
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/jobs/inputs/profile?name=a%20b.csv",
      { method: "GET" },
    );
  });

  test("maps a 429 to busy and a 404 to unavailable", async () => {
    expect(
      await fetchJobInputProfile("x", () =>
        Promise.resolve(new Response(null, { status: 429 })),
      ),
    ).toEqual({ kind: "busy" });
    expect(
      await fetchJobInputProfile("x", () =>
        Promise.resolve(new Response(null, { status: 404 })),
      ),
    ).toEqual({ kind: "unavailable" });
  });
});

describe("postJobInputCoverage", () => {
  test("posts the freshness pair and standardization, returning the rates on a 200", async () => {
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
      sizeBytes: REFERENCE.sizeBytes,
      modifiedAt: REFERENCE.modifiedAt,
      standardization: STANDARDIZATION,
    });
  });

  test("returns null on any non-2xx (busy, drift, or error)", async () => {
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
