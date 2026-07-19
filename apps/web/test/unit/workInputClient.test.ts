import { afterEach, describe, expect, test, vi } from "vitest";

import {
  fetchJobInputProfile,
  fetchJobInputs,
  fetchJobRendezvous,
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
  readable: true,
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

  test("maps a 404 to the API-disabled state (JOB_DATA_ROOT unset)", async () => {
    // The gate 404s when the API is off; the picker renders only on a console
    // build, so a 404 here is deliberate config, not a transient fault.
    expect(
      await fetchJobInputs(() =>
        Promise.resolve(new Response(null, { status: 404 })),
      ),
    ).toEqual({ kind: "disabled" });
  });

  test("maps any other non-2xx to the transient error state", async () => {
    for (const status of [500, 502, 503])
      expect(
        await fetchJobInputs(() =>
          Promise.resolve(new Response(null, { status })),
        ),
      ).toEqual({ kind: "error" });
  });

  test("carries the unreadable-mount state through", async () => {
    const result = await fetchJobInputs(() =>
      Promise.resolve(
        jsonResponse({ configured: true, readable: false, files: [] }),
      ),
    );
    expect(result).toEqual({
      kind: "listing",
      listing: { configured: true, readable: false, files: [] },
    });
  });

  test("defaults an absent readable to true (non-alarming direction)", async () => {
    const result = await fetchJobInputs(() =>
      Promise.resolve(jsonResponse({ configured: true, files: [] })),
    );
    expect(result).toEqual({
      kind: "listing",
      listing: { configured: true, readable: true, files: [] },
    });
  });

  test("rejects a non-boolean readable as a malformed body", async () => {
    expect(
      await fetchJobInputs(() =>
        Promise.resolve(
          jsonResponse({ configured: true, readable: "no", files: [] }),
        ),
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
    // No prototype pollution: Object.prototype gained no enumerable key.
    expect(Object.keys(Object.prototype)).toEqual([]);
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
      ).toEqual({ kind: "unavailable", reason: "unknown" });
    }
  });

  test("maps a 404 to the not_found reason", async () => {
    expect(
      await fetchJobInputProfile("x", () =>
        Promise.resolve(new Response(null, { status: 404 })),
      ),
    ).toEqual({ kind: "unavailable", reason: "not_found" });
  });

  test("reads each closed profile-fault code off a 400 body", async () => {
    for (const reason of ["too_large", "not_a_csv", "parse_failed"] as const) {
      expect(
        await fetchJobInputProfile("x", () =>
          Promise.resolve(jsonResponse({ error: reason }, 400)),
        ),
      ).toEqual({ kind: "unavailable", reason });
    }
  });

  test("degrades an unrecognized or bodiless 400 to unknown", async () => {
    for (const response of [
      jsonResponse({ error: "surprise" }, 400),
      jsonResponse({}, 400),
      new Response(null, { status: 400 }),
    ]) {
      expect(
        await fetchJobInputProfile("x", () => Promise.resolve(response)),
      ).toEqual({ kind: "unavailable", reason: "unknown" });
    }
  });

  test("maps another non-2xx to unknown", async () => {
    expect(
      await fetchJobInputProfile("x", () =>
        Promise.resolve(new Response(null, { status: 500 })),
      ),
    ).toEqual({ kind: "unavailable", reason: "unknown" });
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
    expect(result).toEqual({ kind: "rates", rates });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(init.body as string)).toEqual({
      name: REFERENCE.name,
      standardization: STANDARDIZATION,
    });
  });

  test("classifies a deterministic non-2xx as unavailable", async () => {
    for (const status of [400, 404, 413]) {
      const result = await postJobInputCoverage(
        REFERENCE,
        STANDARDIZATION,
        new AbortController().signal,
        () => Promise.resolve(new Response(null, { status })),
      );
      expect(result).toEqual({ kind: "unavailable" });
    }
  });

  test("classifies a 429 or 5xx as transient", async () => {
    for (const status of [429, 500, 503]) {
      const result = await postJobInputCoverage(
        REFERENCE,
        STANDARDIZATION,
        new AbortController().signal,
        () => Promise.resolve(new Response(null, { status })),
      );
      expect(result).toEqual({ kind: "transient" });
    }
  });

  test("classifies a network reject as transient, an aborted one as aborted", async () => {
    expect(
      await postJobInputCoverage(
        REFERENCE,
        STANDARDIZATION,
        new AbortController().signal,
        () => Promise.reject(new Error("network down")),
      ),
    ).toEqual({ kind: "transient" });

    const aborted = new AbortController();
    aborted.abort();
    expect(
      await postJobInputCoverage(
        REFERENCE,
        STANDARDIZATION,
        aborted.signal,
        () => Promise.reject(new DOMException("aborted", "AbortError")),
      ),
    ).toEqual({ kind: "aborted" });
  });

  test("rejects a body whose entry has a malformed numeric field", async () => {
    // A NaN/undefined numeric that reached the silent-empty gate would fail it OPEN
    // for that field, so a malformed entry degrades the whole body to the unavailable
    // state rather than reporting a false coverage.
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
      expect(result).toEqual({ kind: "unavailable" });
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
    expect(result).toEqual({
      kind: "rates",
      rates: [
        {
          output: "name",
          input: "first_name",
          produced: 2,
          total: 2,
          rate: 1,
          unavailable: false,
        },
      ],
    });
  });
});

describe("fetchJobRendezvous", () => {
  const noDelay = () => Promise.resolve();

  test("returns a configured mount from a clean 200 without retrying", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse({ configured: true, path: "/mnt/rvz" })),
    );
    expect(await fetchJobRendezvous(fetchImpl, 3, noDelay)).toEqual({
      configured: true,
      path: "/mnt/rvz",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("treats a clean 200 unconfigured as definitive (no retry)", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse({ configured: false })),
    );
    expect(await fetchJobRendezvous(fetchImpl, 3, noDelay)).toEqual({
      configured: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("retries a failed probe in-page, then fails safe to unconfigured", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 503 })),
    );
    expect(await fetchJobRendezvous(fetchImpl, 3, noDelay)).toEqual({
      configured: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  test("recovers when a later attempt succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        jsonResponse({ configured: true, path: "/mnt/rvz" }),
      );
    expect(await fetchJobRendezvous(fetchImpl, 3, noDelay)).toEqual({
      configured: true,
      path: "/mnt/rvz",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("retries a rejected fetch as well", async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error("offline")));
    expect(await fetchJobRendezvous(fetchImpl, 2, noDelay)).toEqual({
      configured: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
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

  test("treats a transient 429 like a superseded response: the compute never settles", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response(null, { status: 429 })),
    );
    const provider = consoleCoverageProvider(REFERENCE);
    expect(await race(provider.compute(STANDARDIZATION), 50)).toBe("pending");
    provider.dispose();
  });

  test("settles a deterministic failure by rejecting rather than hanging", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response(null, { status: 400 })),
    );
    const provider = consoleCoverageProvider(REFERENCE);
    await expect(provider.compute(STANDARDIZATION)).rejects.toThrow();
    provider.dispose();
  });

  test("aborts the previous in-flight sweep when a new compute starts", () => {
    // Each fetch resolves only after its own signal aborts (so a live sweep never
    // settles on its own), letting the test observe that starting a second compute
    // aborts the first's signal.
    const signals: Array<AbortSignal> = [];
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal;
      signals.push(signal);
      return new Promise<Response>(() => {
        /* never settles on its own */
      });
    });
    const provider = consoleCoverageProvider(REFERENCE);
    void provider.compute(STANDARDIZATION);
    void provider.compute(STANDARDIZATION);
    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    provider.dispose();
    expect(signals[1].aborted).toBe(true);
  });
});
