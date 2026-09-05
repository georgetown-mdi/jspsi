import { describe, expect, test } from "vitest";

import {
  serviceWorkerSource,
  serviceWorkerSourceModel,
} from "../utils/serviceWorkerHarness";

// ASSET_CACHE is the worker's one growing cache, written by the fetch path on
// its own initiative and by the install/route-warm batch writer. Both keep
// the cache within MAX_ASSET_ENTRIES after their batch, an invariant a third
// writer could silently break. This guard names the two allowed writers, so
// any other site reaching the cache fails here rather than shipping. What
// they actually do is driven end to end in serviceWorker.test.ts.

/** The functions the worker's asset cache is written by, and what each one is.
 * A site outside this set fails the checks below; so does an entry here that no
 * longer reaches the cache, which is what keeps the list from going stale. */
const NAMED_WRITERS: Record<string, string> = {
  handleHashedAsset:
    "the cache-first fetch path for one content-hashed build asset",
  cacheAssetsWithinCap:
    "the batch writer the install precache and the route warm share",
};

const namedWriters = Object.keys(NAMED_WRITERS).sort();

describe("the asset cache's writers", () => {
  test("are the only functions that reach it", () => {
    const { functions } = serviceWorkerSourceModel();

    const reaching = [...functions]
      .filter(([, referenced]) => referenced.has("ASSET_CACHE"))
      .map(([name]) => name)
      .sort();

    expect(reaching).toEqual(namedWriters);
  });

  test("are the only code that reaches it at all", () => {
    const { outsideFunctions } = serviceWorkerSourceModel();

    // Outside every function the cache may be named twice: where its name is
    // built, and in the list of caches activate keeps. Anything else out here is
    // a listener body or another top-level statement touching it directly, and
    // reports the line it sits on in place of a constant's name.
    const naming = outsideFunctions
      .filter((reference) => reference.name === "ASSET_CACHE")
      .map((reference) => reference.declaredConst ?? `line ${reference.line}`);

    expect(naming).toEqual(["ASSET_CACHE", "CURRENT_CACHES"]);
  });

  test("cannot be bypassed by writing the cache's name a second time", () => {
    const { declaredLiterals, literals } = serviceWorkerSourceModel();

    // The literal half of the name, which any second writer naming the cache
    // without the constant would have to repeat.
    const literal = declaredLiterals.get("ASSET_CACHE");
    if (literal === undefined)
      throw new Error("serviceWorker.js declares no ASSET_CACHE cache name");
    expect(literal).not.toBe("");

    expect(literals.filter((text) => text.includes(literal))).toEqual([
      literal,
    ]);
  });

  test("each bound what they store", () => {
    const { functions } = serviceWorkerSourceModel();

    for (const name of namedWriters) {
      const referenced = functions.get(name);
      if (referenced === undefined)
        throw new Error(`serviceWorker.js declares no function ${name}`);
      const writer = `${name} (${NAMED_WRITERS[name]})`;
      expect([...referenced], writer).toContain("trimCache");
      expect([...referenced], writer).toContain("MAX_ASSET_ENTRIES");
    }
  });

  test("are read out of the worker itself, so none of the above is vacuous", () => {
    const { functions, outsideFunctions, cacheOpens } =
      serviceWorkerSourceModel();

    // The worker is valid JavaScript, so the parse the checks above read is a
    // complete one rather than what a parser salvaged from a broken file.
    expect(() => new Function(serviceWorkerSource())).not.toThrow();
    expect(functions.size).toBeGreaterThan(namedWriters.length);

    // Every site that opens a cache at all sits inside one of those functions,
    // which is what makes "outside every function" above an exhaustive reading
    // rather than whatever the parse happened to leave over.
    expect(cacheOpens.length).toBeGreaterThan(0);
    expect(
      cacheOpens
        .filter((site) => site.inFunction === undefined)
        .map((site) => `line ${site.line}`),
    ).toEqual([]);

    // Prose is not code: the worker's comment on tryCache names
    // QuotaExceededError, and no reference above is a mention in a comment.
    expect(serviceWorkerSource()).toContain("QuotaExceededError");
    const referenced = new Set([
      ...[...functions.values()].flatMap((names) => [...names]),
      ...outsideFunctions.map((reference) => reference.name),
    ]);
    expect(referenced.has("QuotaExceededError")).toBe(false);
  });
});
