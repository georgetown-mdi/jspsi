import { beforeEach, describe, expect, test } from "vitest";

import { securityResponseHeaders } from "@utils/securityHeaders";

import {
  HARNESS_ORIGIN,
  createServiceWorkerHarness,
  navigationRequest,
  serviceWorkerConstant,
  serviceWorkerStringArray,
  settleBackgroundWork,
  subresourceRequest,
} from "../../utils/serviceWorkerHarness";

import type { ServiceWorkerHarness } from "../../utils/serviceWorkerHarness";

// The shipped app-shell worker (apps/web/public/serviceWorker.js), driven
// through a fabricated service-worker global scope so the real install,
// activate, message, and fetch handlers run. None of this needs a browser;
// what Chromium does own -- that an offline shell renders the list from the
// local store -- is test/browser/offlineShell.test.ts.

const SHELL_CACHE = "psilink-shell-v1";
const ASSET_CACHE = "psilink-assets-v1";

/** The app document as the server renders it: the asset graph the worker reads at
 * install is discovered from these references. */
function shellDocument(assets: Array<string> = ["/assets/index-AAAA1111.js"]) {
  const links = assets
    .map((asset) => `<link rel="modulepreload" href="${asset}"/>`)
    .join("");
  return `<!DOCTYPE html><html><head>${links}</head><body>psilink</body></html>`;
}

function html(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function javascript(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/javascript" },
  });
}

/** A harness whose origin serves the shell, the static assets the worker
 * precaches, and one build asset. */
function servedHarness(assets: Array<string> = ["/assets/index-AAAA1111.js"]) {
  const harness = createServiceWorkerHarness();
  harness.network.route("/", () => html(shellDocument(assets)));
  for (const path of [
    "/site.webmanifest",
    "/favicon.ico",
    "/favicon-16x16.png",
    "/favicon-32x32.png",
    "/apple-touch-icon.png",
    "/android-chrome-192x192.png",
    "/android-chrome-512x512.png",
  ])
    harness.network.route(path, () => new Response("icon", { status: 200 }));
  for (const asset of assets)
    harness.network.route(asset, () => javascript(`// ${asset}`));
  return harness;
}

/** The document the worker would serve a navigation with no network: what is in
 * the shell cache, read the only way the worker exposes it. */
async function cachedShell(harness: ServiceWorkerHarness): Promise<Response> {
  harness.network.goOffline();
  const response = await harness.handleFetch(navigationRequest("/"));
  harness.network.goOnline();
  if (response === undefined)
    throw new Error("the worker did not answer the navigation");
  return response;
}

describe("install", () => {
  let harness: ServiceWorkerHarness;
  beforeEach(() => {
    harness = servedHarness([
      "/assets/index-AAAA1111.js",
      "/assets/app-BB22.css",
    ]);
  });

  test("caches the shell document, the static assets, and the shell's asset graph", async () => {
    await harness.install();

    expect(harness.cachedUrls(SHELL_CACHE)).toContain(`${HARNESS_ORIGIN}/`);
    expect(harness.cachedUrls(SHELL_CACHE)).toContain(
      `${HARNESS_ORIGIN}/site.webmanifest`,
    );
    // The precache runs concurrently, so the order entries land in is not fixed.
    expect(harness.cachedUrls(ASSET_CACHE).sort()).toEqual([
      `${HARNESS_ORIGIN}/assets/app-BB22.css`,
      `${HARNESS_ORIGIN}/assets/index-AAAA1111.js`,
    ]);
  });

  test("does not skip waiting, so a new worker cannot swap code under a running page", async () => {
    await harness.install();

    expect(harness.skipWaitingCalls).toBe(0);
  });

  test("still installs when the origin is unreachable", async () => {
    harness.network.goOffline();

    await expect(harness.install()).resolves.toBeUndefined();
    expect(harness.cachedUrls(SHELL_CACHE)).toEqual([]);
  });

  test("skips an asset that fails rather than discarding the whole precache", async () => {
    const partial = createServiceWorkerHarness();
    partial.network.route("/", () =>
      html(shellDocument(["/assets/present-1111.js", "/assets/gone-2222.js"])),
    );
    partial.network.route("/assets/present-1111.js", () => javascript("ok"));

    await partial.install();

    expect(partial.cachedUrls(ASSET_CACHE)).toEqual([
      `${HARNESS_ORIGIN}/assets/present-1111.js`,
    ]);
  });
});

describe("activate", () => {
  test("discards every cache outside the current scheme and claims open clients", async () => {
    const harness = servedHarness();
    await harness.seedCache("psilink-shell-v0");
    await harness.seedCache("psilink-assets-v0");
    await harness.seedCache("something-else");
    await harness.install();

    await harness.activate();

    expect(harness.cacheNames().sort()).toEqual([ASSET_CACHE, SHELL_CACHE]);
    expect(harness.clientsClaimed).toBe(1);
  });
});

describe("the skip-waiting message", () => {
  test("makes a waiting worker take over", async () => {
    const harness = servedHarness();

    await harness.postMessage("psilink-skip-waiting");

    expect(harness.skipWaitingCalls).toBe(1);
  });

  test("ignores any other message", async () => {
    const harness = servedHarness();

    await harness.postMessage({ type: "psilink-skip-waiting" });
    await harness.postMessage("something-else");

    expect(harness.skipWaitingCalls).toBe(0);
  });
});

describe("the warm-routes message", () => {
  /** A harness serving the shell plus a distinct code chunk per route, so what
   * each route contributes to the asset cache is identifiable. */
  function routedHarness() {
    const harness = servedHarness();
    for (const route of serviceWorkerStringArray("SHELL_ROUTES")) {
      const asset = `/assets/route${route.replaceAll("/", "-")}-1234.js`;
      harness.network.route(route, () =>
        html(`<html><head><script src="${asset}"></script></head></html>`),
      );
      harness.network.route(asset, () => javascript(`// ${route}`));
    }
    return harness;
  }

  test("caches the code behind every route, not just the shell's", async () => {
    const harness = routedHarness();
    await harness.install();
    await harness.activate();

    await harness.postMessage("psilink-warm-routes");

    for (const route of serviceWorkerStringArray("SHELL_ROUTES"))
      expect(harness.cachedUrls(ASSET_CACHE)).toContain(
        `${HARNESS_ORIGIN}/assets/route${route.replaceAll("/", "-")}-1234.js`,
      );
  });

  test("stores no document but the origin root's", async () => {
    const harness = routedHarness();
    await harness.install();
    await harness.activate();

    await harness.postMessage("psilink-warm-routes");

    expect(harness.cachedUrls(SHELL_CACHE)).not.toContain(
      `${HARNESS_ORIGIN}/saved`,
    );
  });

  test("re-fetches no asset it already holds", async () => {
    const harness = routedHarness();
    await harness.install();
    await harness.activate();
    await harness.postMessage("psilink-warm-routes");
    const assetRequests = () =>
      harness.network.requested.filter((path) => path.startsWith("/assets/"))
        .length;
    const before = assetRequests();

    await harness.postMessage("psilink-warm-routes");

    expect(assetRequests()).toBe(before);
  });

  test("stops rather than working through the list with no network", async () => {
    const harness = routedHarness();
    await harness.install();
    await harness.activate();
    harness.network.goOffline();
    const before = harness.network.requested.length;

    await harness.postMessage("psilink-warm-routes");

    expect(harness.network.requested.length).toBe(before + 1);
  });
});

describe("requests the worker does not intercept", () => {
  let harness: ServiceWorkerHarness;
  beforeEach(async () => {
    harness = servedHarness();
    await harness.install();
    await harness.activate();
  });

  test("leaves a non-GET request alone", async () => {
    const response = await harness.handleFetch(
      subresourceRequest("/assets/index-AAAA1111.js", "POST"),
    );

    expect(response).toBeUndefined();
  });

  test("leaves a cross-origin request alone", async () => {
    const response = await harness.handleFetch({
      url: "https://elsewhere.example/asset.js",
      method: "GET",
      mode: "cors",
    });

    expect(response).toBeUndefined();
  });

  test("leaves the API routes alone, so no exchange traffic reaches a cache", async () => {
    harness.network.route("/api/peerjs/id", () => new Response("peer-id"));

    const response = await harness.handleFetch(
      subresourceRequest("/api/peerjs/id"),
    );

    expect(response).toBeUndefined();
    expect(harness.cachedUrls(SHELL_CACHE)).not.toContain(
      `${HARNESS_ORIGIN}/api/peerjs/id`,
    );
  });

  test("leaves a same-origin file outside the cached set alone", async () => {
    harness.network.route("/robots.txt", () => new Response("User-agent: *"));

    const response = await harness.handleFetch(
      subresourceRequest("/robots.txt"),
    );

    expect(response).toBeUndefined();
  });
});

describe("navigations", () => {
  let harness: ServiceWorkerHarness;
  beforeEach(async () => {
    harness = servedHarness();
    await harness.install();
    await harness.activate();
  });

  test("serve the network's document while it is reachable", async () => {
    harness.network.route("/", () => html("<html>fresh deployment</html>"));

    const response = await harness.handleFetch(navigationRequest("/"));

    expect(await response?.text()).toContain("fresh deployment");
  });

  test("refresh the cached shell from a root navigation", async () => {
    harness.network.route("/", () => html("<html>fresh deployment</html>"));

    await harness.handleFetch(navigationRequest("/"));

    const cached = await cachedShell(harness);
    expect(await cached.text()).toContain("fresh deployment");
  });

  test("serve the cached shell when the network fails", async () => {
    harness.network.goOffline();

    const response = await harness.handleFetch(navigationRequest("/saved"));

    expect(response?.status).toBe(200);
    expect(await response?.text()).toContain("psilink");
  });

  test("answer every route from the one cached shell", async () => {
    harness.network.goOffline();

    const list = await harness.handleFetch(navigationRequest("/saved"));
    const run = await harness.handleFetch(
      navigationRequest("/saved/9f2c1b7e-managed"),
    );

    expect(list?.status).toBe(200);
    expect(run?.status).toBe(200);
  });

  test("never store a document for a route below the origin root", async () => {
    harness.network.route("/saved/9f2c1b7e-managed", () =>
      html("<html>a saved exchange</html>"),
    );

    await harness.handleFetch(navigationRequest("/saved/9f2c1b7e-managed"));

    expect(harness.cachedUrls(SHELL_CACHE)).not.toContain(
      `${HARNESS_ORIGIN}/saved/9f2c1b7e-managed`,
    );
  });

  test("never store a document fetched with a query string", async () => {
    harness.network.route("/", () => html("<html>with a query</html>"));

    await harness.handleFetch(navigationRequest("/?token=abc"));

    const cached = await cachedShell(harness);
    expect(await cached.text()).not.toContain("with a query");
  });

  test("do not store a failed document", async () => {
    harness.network.route("/", () => new Response("gateway", { status: 502 }));

    await harness.handleFetch(navigationRequest("/"));

    const cached = await cachedShell(harness);
    expect(await cached.text()).not.toContain("gateway");
  });

  test("say so when nothing is cached and the network is gone", async () => {
    const cold = createServiceWorkerHarness();
    cold.network.goOffline();

    const response = await cold.handleFetch(navigationRequest("/"));

    expect(response?.status).toBe(503);
    expect(await response?.text()).toContain("psilink is offline");
  });
});

describe("build assets", () => {
  let harness: ServiceWorkerHarness;
  beforeEach(async () => {
    harness = servedHarness();
    await harness.install();
    await harness.activate();
  });

  test("come from the cache without a second request", async () => {
    const before = harness.network.requested.length;

    const response = await harness.handleFetch(
      subresourceRequest("/assets/index-AAAA1111.js"),
    );

    expect(await response?.text()).toContain("/assets/index-AAAA1111.js");
    expect(harness.network.requested.length).toBe(before);
  });

  test("a new deployment's asset misses the cache and is fetched", async () => {
    harness.network.route("/assets/index-CCCC3333.js", () =>
      javascript("// the new deployment"),
    );

    const response = await harness.handleFetch(
      subresourceRequest("/assets/index-CCCC3333.js"),
    );

    expect(await response?.text()).toContain("the new deployment");
    expect(harness.cachedUrls(ASSET_CACHE)).toContain(
      `${HARNESS_ORIGIN}/assets/index-CCCC3333.js`,
    );
  });

  test("are bounded, oldest first, so redeployments cannot grow the cache forever", async () => {
    const cap = serviceWorkerConstant("MAX_ASSET_ENTRIES");
    for (let index = 0; index <= cap; index += 1) {
      const path = `/assets/chunk-${index}.js`;
      harness.network.route(path, () => javascript(`// ${index}`));
      await harness.handleFetch(subresourceRequest(path));
    }

    const cached = harness.cachedUrls(ASSET_CACHE);
    expect(cached.length).toBe(cap);
    expect(cached).not.toContain(`${HARNESS_ORIGIN}/assets/index-AAAA1111.js`);
    expect(cached).toContain(`${HARNESS_ORIGIN}/assets/chunk-${cap}.js`);
  });
});

describe("the asset-cache cap", () => {
  const cap = serviceWorkerConstant("MAX_ASSET_ENTRIES");

  /** `count` distinct build-asset paths, numbered so their insertion order is
   * readable in a failure. */
  function chunkPaths(prefix: string, count: number): Array<string> {
    return Array.from(
      { length: count },
      (_, index) => `/assets/${prefix}-${String(index).padStart(4, "0")}.js`,
    );
  }

  /** Serve `assets` from `route`, as a document naming them plus the assets
   * themselves. */
  function routeServing(
    harness: ServiceWorkerHarness,
    route: string,
    assets: Array<string>,
  ): void {
    const scripts = assets
      .map((asset) => `<script src="${asset}"></script>`)
      .join("");
    harness.network.route(route, () =>
      html(`<html><head>${scripts}</head></html>`),
    );
    for (const asset of assets)
      harness.network.route(asset, () => javascript(`// ${asset}`));
  }

  test("bounds an install whose own asset graph overflows it", async () => {
    const harness = servedHarness(chunkPaths("install", cap + 12));

    await harness.install();

    // Which of the batch's own entries survive is the order its concurrent adds
    // completed in, so the count is what the worker fixes here.
    expect(harness.cachedUrls(ASSET_CACHE).length).toBe(cap);
    expect(harness.cachedUrls(SHELL_CACHE)).toContain(`${HARNESS_ORIGIN}/`);
  });

  test("bounds a warm, keeping the routes it reached last", async () => {
    const routes = serviceWorkerStringArray("SHELL_ROUTES");
    const perRoute = Math.ceil((cap * 2) / routes.length);
    const harness = servedHarness();
    await harness.install();
    await harness.activate();
    // Registered after the install so the shell's own asset is the cache's
    // oldest entry, which is what the cap should reach first.
    const assetsOf = new Map(
      routes.map((route) => [
        route,
        chunkPaths(`route${route.replaceAll("/", "-")}`, perRoute),
      ]),
    );
    for (const [route, assets] of assetsOf)
      routeServing(harness, route, assets);

    await harness.postMessage("psilink-warm-routes");

    const cached = harness.cachedUrls(ASSET_CACHE);
    expect(cached.length).toBe(cap);
    expect(cached).not.toContain(`${HARNESS_ORIGIN}/assets/index-AAAA1111.js`);
    // The warm stores a route's batch whole before moving on, so eviction walks
    // the route list from its start rather than touching what was just written.
    for (const asset of assetsOf.get(routes[routes.length - 1]) ?? [])
      expect(cached).toContain(`${HARNESS_ORIGIN}${asset}`);
    for (const asset of assetsOf.get(routes[0]) ?? [])
      expect(cached).not.toContain(`${HARNESS_ORIGIN}${asset}`);
  });
});

describe("the manifest and icons", () => {
  test("come from the cache and are revalidated behind the response", async () => {
    const harness = servedHarness();
    await harness.install();
    await harness.activate();
    harness.network.route(
      "/site.webmanifest",
      () => new Response("a redeployed manifest", { status: 200 }),
    );

    const first = await harness.handleFetch(
      subresourceRequest("/site.webmanifest"),
    );
    expect(await first?.text()).toBe("icon");

    await settleBackgroundWork();
    const second = await harness.handleFetch(
      subresourceRequest("/site.webmanifest"),
    );
    expect(await second?.text()).toBe("a redeployed manifest");
  });

  test("hold that revalidation on the fetch event, not merely start it", async () => {
    const harness = servedHarness();
    await harness.install();
    await harness.activate();
    harness.network.route(
      "/site.webmanifest",
      () => new Response("a redeployed manifest", { status: 200 }),
    );

    const served = await harness.handleFetch(
      subresourceRequest("/site.webmanifest"),
    );
    expect(await served?.text()).toBe("icon");

    // A browser may terminate the worker the moment its response settles, so the
    // refresh is handed to the event rather than left running loose: settling
    // exactly what the browser was handed -- no timers, nothing else -- is what
    // stores the fresh copy.
    expect(harness.heldByLastFetch).toHaveLength(1);
    await Promise.all(harness.heldByLastFetch);

    const second = await harness.handleFetch(
      subresourceRequest("/site.webmanifest"),
    );
    expect(await second?.text()).toBe("a redeployed manifest");
  });

  test("hold nothing when the response came from the network", async () => {
    // No install, so nothing is stored: the request is answered by the network
    // and there is no cached copy behind it to revalidate.
    const harness = servedHarness();

    const response = await harness.handleFetch(
      subresourceRequest("/site.webmanifest"),
    );

    expect(await response?.text()).toBe("icon");
    expect(harness.heldByLastFetch).toHaveLength(0);
  });

  test("keep the stored copy when the revalidation fails", async () => {
    const harness = servedHarness();
    await harness.install();
    await harness.activate();
    harness.network.goOffline();

    const response = await harness.handleFetch(
      subresourceRequest("/site.webmanifest"),
    );
    await settleBackgroundWork();

    expect(await response?.text()).toBe("icon");
    const again = await harness.handleFetch(
      subresourceRequest("/site.webmanifest"),
    );
    expect(await again?.text()).toBe("icon");
  });
});

// A browser can refuse a cache at any moment -- quota exhausted, storage
// switched off, the bucket evicted under the worker. A storage failure may
// cost the offline copy, but never the response: it must not fail a request
// the network answered, nor serve a stale document over a fresher one the
// network delivered.

describe("a fetch handler meeting a failing cache", () => {
  let harness: ServiceWorkerHarness;
  const NEW_ASSET = "/assets/index-CCCC3333.js";

  beforeEach(async () => {
    harness = servedHarness();
    await harness.install();
    await harness.activate();
    harness.network.route(NEW_ASSET, () => javascript("// the new deployment"));
  });

  test("serves the navigation the network delivered when the write fails", async () => {
    harness.network.route("/", () => html("<html>fresh deployment</html>"));
    harness.storageFails.put(true);

    const response = await harness.handleFetch(navigationRequest("/"));

    expect(response?.status).toBe(200);
    expect(await response?.text()).toContain("fresh deployment");
  });

  test("serves the navigation the network delivered when the cache will not open", async () => {
    harness.network.route("/", () => html("<html>fresh deployment</html>"));
    harness.storageFails.open(true);

    const response = await harness.handleFetch(navigationRequest("/"));

    expect(response?.status).toBe(200);
    expect(await response?.text()).toContain("fresh deployment");
  });

  test("says the app is offline when the network is gone and the fallback cannot be read", async () => {
    harness.network.goOffline();
    harness.storageFails.match(true);

    const response = await harness.handleFetch(navigationRequest("/"));

    expect(response?.status).toBe(503);
    expect(await response?.text()).toContain("psilink is offline");
  });

  test("serves a build asset when the cache will not open", async () => {
    harness.storageFails.open(true);

    const response = await harness.handleFetch(subresourceRequest(NEW_ASSET));

    expect(await response?.text()).toContain("the new deployment");
  });

  test("serves a build asset when the write fails", async () => {
    harness.storageFails.put(true);

    const response = await harness.handleFetch(subresourceRequest(NEW_ASSET));

    expect(await response?.text()).toContain("the new deployment");
    expect(harness.cachedUrls(ASSET_CACHE)).not.toContain(
      `${HARNESS_ORIGIN}${NEW_ASSET}`,
    );
  });

  test("serves a build asset when the trim fails, having stored it", async () => {
    harness.storageFails.keys(true);

    const response = await harness.handleFetch(subresourceRequest(NEW_ASSET));

    expect(await response?.text()).toContain("the new deployment");
    expect(harness.cachedUrls(ASSET_CACHE)).toContain(
      `${HARNESS_ORIGIN}${NEW_ASSET}`,
    );
  });

  test("re-fetches a stored build asset when the lookup fails", async () => {
    harness.storageFails.match(true);

    const response = await harness.handleFetch(
      subresourceRequest("/assets/index-AAAA1111.js"),
    );

    expect(await response?.text()).toContain("/assets/index-AAAA1111.js");
  });

  test("serves a static asset when the cache will not open", async () => {
    harness.storageFails.open(true);

    const response = await harness.handleFetch(
      subresourceRequest("/site.webmanifest"),
    );

    expect(await response?.text()).toBe("icon");
  });
});

describe("the worker's lifecycle meeting a failing cache", () => {
  test("installs with nothing stored rather than failing the install", async () => {
    const harness = servedHarness();
    harness.storageFails.open(true);

    await expect(harness.install()).resolves.toBeUndefined();

    expect(harness.cacheNames()).toEqual([]);
  });

  test("still claims its clients when the caches cannot be enumerated", async () => {
    const harness = servedHarness();
    await harness.install();
    harness.storageFails.keys(true);

    await expect(harness.activate()).resolves.toBeUndefined();

    expect(harness.clientsClaimed).toBe(1);
  });

  test("settles a route warm rather than leaving waitUntil rejected", async () => {
    const harness = servedHarness();
    await harness.install();
    await harness.activate();
    harness.storageFails.open(true);

    await expect(
      harness.postMessage("psilink-warm-routes"),
    ).resolves.toBeUndefined();
  });
});

describe("the synthesized offline document", () => {
  test("has the security headers every other document of this origin does", async () => {
    const cold = createServiceWorkerHarness();
    cold.network.goOffline();

    const response = await cold.handleFetch(navigationRequest("/"));

    // Held against the server's own header set rather than a copy of the values,
    // so the worker's literals cannot drift from what every rendered document
    // has. The count keeps the loop from passing vacuously.
    expect(Object.keys(securityResponseHeaders).length).toBe(4);
    for (const [header, value] of Object.entries(securityResponseHeaders))
      expect(response?.headers.get(header)).toBe(value);
  });
});
