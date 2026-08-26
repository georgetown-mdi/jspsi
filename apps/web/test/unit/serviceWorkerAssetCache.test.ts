import { describe, expect, test } from "vitest";

import {
  serviceWorkerSource,
  serviceWorkerSourceRegions,
} from "../utils/serviceWorkerHarness";

// ASSET_CACHE is the worker's one growing cache: the fetch path adds to it on its
// own initiative and an installed app warms every route's code into it at each
// launch. Both of its writers therefore carry an invariant the cap alone does not
// state -- each brings the cache back within MAX_ASSET_ENTRIES after its batch,
// so a continuously deployed origin cannot accumulate past deployments' chunks.
// A third writer would be the way that invariant is lost, and nothing about
// adding one would say so. This guard names the two, so any other site reaching
// the cache -- another function, or a listener body doing it inline -- fails here
// rather than shipping. What the writers actually do is driven end to end in
// serviceWorker.test.ts; this is only about who may do it.

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
    const { functions } = serviceWorkerSourceRegions();

    const reaching = [...functions]
      .filter(([, body]) => body.includes("ASSET_CACHE"))
      .map(([name]) => name)
      .sort();

    expect(reaching).toEqual(namedWriters);
  });

  test("are the only code that reaches it at all", () => {
    const { outsideFunctions } = serviceWorkerSourceRegions();

    // Outside every function the cache may be named twice: where its name is
    // built, and in the list of caches activate keeps. Anything else out here is
    // a listener body or another top-level statement touching it directly.
    const naming = outsideFunctions
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.includes("ASSET_CACHE"));

    expect(naming).toHaveLength(2);
    expect(naming[0]).toMatch(/^const ASSET_CACHE = /);
    expect(naming[1]).toMatch(/^const CURRENT_CACHES = \[/);
  });

  test("cannot be bypassed by writing the cache's name a second time", () => {
    const { code } = serviceWorkerSourceRegions();
    const declared = /const ASSET_CACHE = `([^`]*)`;/.exec(code);
    if (declared === null)
      throw new Error("serviceWorker.js declares no ASSET_CACHE cache name");

    // The literal half of the name, which any second writer naming the cache
    // without the constant would have to repeat.
    const literal = declared[1].replace("${CACHE_VERSION}", "");
    expect(literal).not.toBe("");

    expect(code.split(literal)).toHaveLength(2);
  });

  test("each bound what they store", () => {
    const { functions } = serviceWorkerSourceRegions();

    for (const name of namedWriters) {
      const body = functions.get(name);
      if (body === undefined)
        throw new Error(`serviceWorker.js declares no function ${name}`);
      expect(body, `${name} (${NAMED_WRITERS[name]})`).toContain("trimCache(");
      expect(body, `${name} (${NAMED_WRITERS[name]})`).toContain(
        "MAX_ASSET_ENTRIES",
      );
    }
  });

  test("are read out of the worker itself, so none of the above is vacuous", () => {
    const { code, functions } = serviceWorkerSourceRegions();

    // The comment strip ran, so the checks above read code rather than prose.
    expect(serviceWorkerSource()).toContain("/**");
    expect(code).not.toContain("/**");

    // The split produced compilable code and found more than the writers named
    // here, so a shredded parse cannot report an empty set of violations.
    expect(() => new Function(code)).not.toThrow();
    expect(functions.size).toBeGreaterThan(namedWriters.length);

    // Every site that opens a cache at all sits inside one of those functions,
    // which is what makes "outside every function" above an exhaustive reading
    // rather than whatever the split happened to leave over.
    const opens = (text: string) => text.split("caches.open(").length - 1;
    expect(opens(code)).toBeGreaterThan(0);
    expect(opens([...functions.values()].join("\n"))).toBe(opens(code));
  });
});
