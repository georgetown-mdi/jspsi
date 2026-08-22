import { beforeEach, describe, expect, test } from "vitest";

import {
  HARNESS_ORIGIN,
  createServiceWorkerHarness,
  navigationRequest,
  serviceWorkerConstant,
  serviceWorkerStringArray,
  settleBackgroundWork,
  subresourceRequest,
} from "../utils/serviceWorkerHarness";

import type { ServiceWorkerHarness } from "../utils/serviceWorkerHarness";

// The shipped app-shell worker (apps/web/public/serviceWorker.js), driven through a
// fabricated service-worker global scope so the real install, activate, message, and
// fetch handlers run. Node is the right place for all of it: none of the worker's
// behavior needs a browser, and the file is a static asset a browser test could only
// reach through a real registration, whose lifecycle is exactly what is under test
// here. What Chromium does own -- that an offline shell renders the list from the
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
