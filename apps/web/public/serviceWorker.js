/*
 * The app-shell service worker for the hosted web application.
 *
 * It is SHELL-ONLY. It caches the app document and the build's static assets so
 * the management list, the navigation, and the surfaces that read the local
 * store render with no network. No exchange execution lives here: WebRTC is
 * unavailable to a service worker, and no Periodic Background Sync is
 * registered. Nothing an exchange touches is ever written to a cache -- the
 * only entries this worker creates are (1) one navigation document, fetched
 * from the origin root, (2) content-hashed build assets under ASSET_PATH_PREFIX,
 * and (3) the fixed STATIC_ASSETS list of icons and the manifest. Requests under
 * API_PATH_PREFIX, cross-origin requests, and non-GET requests are not
 * intercepted at all, so peer coordination and the console job API never pass
 * through a cache.
 *
 * It is deliberately hand-written and dependency-free rather than generated: a
 * fetch interceptor in front of an application that handles linkage data is a
 * surface a reviewer reads end to end, and there is nothing here a build-time
 * precache manifest would buy that deriving the shell's asset graph at install
 * does not.
 *
 * STALE CODE. Three properties together bound how long a deployment's code can
 * survive it, because the app is continuously deployed and an upgrade can
 * invalidate a stored record (whose recovery is a re-invite):
 *
 *   - The app document is NETWORK-FIRST. An online client always renders the
 *     deployment currently served; the cached document is a fallback reached
 *     only when the network fails. A successful root navigation replaces it, so
 *     the fallback tracks the deployment on every visit to the start URL -- and
 *     the manifest's start_url is the origin root, so every launch of the
 *     installed app is such a visit.
 *   - Build assets are content-hashed, so cache-first can only ever return the
 *     exact bytes their URL names. A new deployment's document references new
 *     URLs, which miss the cache and are fetched.
 *   - A new worker does NOT call skipWaiting() on install. It waits, and takes
 *     over when the last client controlled by the old worker goes away (the next
 *     cold start), or when a client that has told its operator an update is
 *     ready posts SKIP_WAITING_MESSAGE. Swapping under a live client would
 *     purge, on activate, the very asset cache that client's already-loaded code
 *     lazily fetches from -- during an exchange, on an app whose exchanges are
 *     long-running and interactive. The waiting worker is the honest form of
 *     "an update is available"; it is not a way to defer one indefinitely.
 *
 * CACHE_VERSION names the caching scheme, not the deployment: activate deletes
 * every cache whose name is not in CURRENT_CACHES, so bumping it discards
 * everything the previous scheme wrote.
 */

"use strict";

/** The caching scheme's version. Bump it when the cache layout or the entries a
 * cache may hold change; activate then discards the previous scheme's caches. */
const CACHE_VERSION = "v1";

/** Holds the one cached navigation document plus {@link STATIC_ASSETS}. */
const SHELL_CACHE = `psilink-shell-${CACHE_VERSION}`;

/** Holds content-hashed build assets under {@link ASSET_PATH_PREFIX}. */
const ASSET_CACHE = `psilink-assets-${CACHE_VERSION}`;

/** The caches this worker owns; activate deletes every other cache. */
const CURRENT_CACHES = [SHELL_CACHE, ASSET_CACHE];

/**
 * The one navigation document the shell cache holds, and the only URL a
 * navigation response is ever stored under.
 *
 * Every route of the app renders client-side from the same server-rendered
 * shell, so one document serves an offline navigation to any path: the client
 * router resolves the route from the address bar after hydration. Storing only
 * the root's own response is also what keeps the cache free of anything derived
 * from where the operator has been -- a deeper route's document embeds its path
 * and parameters (a saved exchange's id) in the router's dehydrated state, so
 * caching it would put that id at rest in a second place.
 */
const SHELL_PATH = "/";

/** The build's content-hashed asset prefix (`vite build` output). Everything
 * under it is immutable for the life of its URL, which is what makes cache-first
 * safe there. */
const ASSET_PATH_PREFIX = "/assets/";

/** Server routes: peer coordination and the console job API. Never intercepted,
 * so no request or response on them can reach a cache. */
const API_PATH_PREFIX = "/api/";

/** The unhashed static files an installed app needs, cached by exact path so the
 * shell cache's contents stay enumerable. */
const STATIC_ASSETS = [
  "/site.webmanifest",
  "/favicon.ico",
  "/favicon-16x16.png",
  "/favicon-32x32.png",
  "/apple-touch-icon.png",
  "/android-chrome-192x192.png",
  "/android-chrome-512x512.png",
];

/**
 * The cap on cached build assets. Each deployment's shell graph is a few dozen
 * files and the cache is only ever added to, so without a cap a continuously
 * deployed origin accumulates every past deployment's chunks. Oldest entries go
 * first (CacheStorage enumerates in insertion order), which is also
 * least-recently-added.
 */
const MAX_ASSET_ENTRIES = 240;

/** The message a client posts to make a waiting worker take over now, having
 * told its operator an update is ready. Mirrored by the client registration in
 * `apps/web/src/utils/appShellUpdate.ts`. */
const SKIP_WAITING_MESSAGE = "psilink-skip-waiting";

/** The message a client running as an INSTALLED app posts to have every route's
 * code cached ({@link SHELL_ROUTES}), rather than only the shell's own. Mirrored
 * by the client registration in `apps/web/src/utils/appShellUpdate.ts`. */
const WARM_ROUTES_MESSAGE = "psilink-warm-routes";

/**
 * Every route of the app, as a path whose served document names that route's
 * code. Warming reads each one's asset graph, which is how a route the operator
 * has not visited yet still opens with no network.
 *
 * Warming is NOT part of install, because it is not free: the routes that can
 * run an exchange pull in the exchange machinery, several megabytes a visitor
 * who only opens the front page never asks for. So the shell's own graph is what
 * installs, an installed app warms the rest at launch, and an ordinary tab fills
 * the rest in as the operator visits routes. The cost and the two paths are
 * argued in docs/notes/app-shell-service-worker.md.
 *
 * `apps/web/test/unit/serviceWorkerRoutes.test.ts` fails when a route file
 * exists that no entry here covers, so a new route cannot silently ship
 * offline-broken.
 */
const SHELL_ROUTES = [
  "/",
  "/saved",
  // A route with a parameter: the id is a placeholder, since what is read from
  // the response is the route's code, not the record it would render.
  "/saved/_",
  "/quick",
  "/exchange",
  "/accept",
  "/direct",
  "/verify",
];

/** The document served when the network is unreachable and no shell has been
 * cached yet -- a browser that installed the worker and went offline before ever
 * loading the app. It says so rather than leaving the browser's own network
 * error to imply the app is broken. */
const UNCACHED_OFFLINE_DOCUMENT = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>psilink is offline</title></head>
<body style="font-family: system-ui, sans-serif; margin: 2rem; max-width: 34rem">
<h1>psilink is offline</h1>
<p>This device has no network connection, and this browser has not stored a copy
of the app yet. Reconnect and open psilink once; after that the app and your
saved exchanges open without a connection.</p>
</body></html>`;

self.addEventListener("install", (event) => {
  event.waitUntil(precacheShell());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(claimAndDiscardOldCaches());
});

self.addEventListener("message", (event) => {
  if (event.data === SKIP_WAITING_MESSAGE) {
    void self.skipWaiting();
    return;
  }
  if (event.data === WARM_ROUTES_MESSAGE) event.waitUntil(warmRouteAssets());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith(API_PATH_PREFIX)) return;
  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(request));
    return;
  }
  if (url.pathname.startsWith(ASSET_PATH_PREFIX)) {
    event.respondWith(handleHashedAsset(request));
    return;
  }
  if (STATIC_ASSETS.includes(url.pathname)) {
    event.respondWith(handleStaticAsset(request));
  }
});

/** The absolute URL of the one cached navigation document. */
function shellUrl() {
  return new URL(SHELL_PATH, self.location.origin).toString();
}

/**
 * Install: fetch the shell document past the HTTP cache, store it, and precache
 * the build assets it references so a browser that goes offline immediately
 * after installing still has a working app. The asset graph is read out of the
 * served document rather than a build-time manifest, so it is by construction
 * the graph the deployment actually ships.
 *
 * A failure anywhere here is not fatal: the worker still installs, and the first
 * online navigation fills the shell cache. Failing the install instead would
 * leave the origin with no worker at all over a transient error.
 */
async function precacheShell() {
  try {
    const response = await fetch(shellUrl(), { cache: "reload" });
    if (!response.ok) return;
    const shellDocument = await response.clone().text();
    const shell = await caches.open(SHELL_CACHE);
    await shell.put(shellUrl(), response);
    await addAllIndividually(shell, STATIC_ASSETS);
    const assets = await caches.open(ASSET_CACHE);
    await addAllIndividually(assets, hashedAssetPathsIn(shellDocument));
  } catch {
    // Offline or a failing origin at install time; the first online navigation
    // fills the cache instead.
  }
}

/**
 * Cache the code behind every route in {@link SHELL_ROUTES}, so an installed app
 * opens each of them with no network rather than only the ones its operator has
 * happened to visit. Each route's served document names that route's assets; the
 * documents themselves are read and discarded (only the origin root's is ever
 * stored -- see {@link SHELL_PATH}).
 *
 * Already-cached assets are skipped, so a launch after the first costs one small
 * document per route and nothing else, and a warm that runs into a dead network
 * stops rather than working through the list failing.
 */
async function warmRouteAssets() {
  const assets = await caches.open(ASSET_CACHE);
  for (const route of SHELL_ROUTES) {
    let routeDocument;
    try {
      const response = await fetch(new URL(route, self.location.origin), {
        cache: "reload",
      });
      if (!response.ok) continue;
      routeDocument = await response.text();
    } catch {
      return;
    }
    await addAllIndividually(assets, hashedAssetPathsIn(routeDocument));
  }
}

/**
 * Activate: discard every cache this scheme does not own, then take control of
 * already-open clients. Claiming matters on the first install -- the page that
 * registered the worker is otherwise uncontrolled until its next navigation, so
 * nothing it loads reaches a cache and a reload straight into offline finds
 * nothing. A worker that reaches activate while a client is open is either that
 * first install or one whose predecessor's clients have all gone, so claiming
 * never swaps code under a running exchange.
 */
async function claimAndDiscardOldCaches() {
  const names = await caches.keys();
  await Promise.all(
    names
      .filter((name) => !CURRENT_CACHES.includes(name))
      .map((name) => caches.delete(name)),
  );
  await self.clients.claim();
}

/**
 * Navigations are network-first: the served deployment always wins while the
 * network is reachable, and only a failed fetch falls back to the cached shell.
 * A successful response is stored only when the request is the bare origin root
 * -- a deeper route's document carries its path and parameters in the router's
 * dehydrated state (see {@link SHELL_PATH}), and a query string could carry
 * anything at all.
 */
async function handleNavigation(request) {
  try {
    const response = await fetch(request);
    const url = new URL(request.url);
    if (response.ok && url.pathname === SHELL_PATH && url.search === "") {
      const shell = await caches.open(SHELL_CACHE);
      await shell.put(shellUrl(), response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(shellUrl(), { cacheName: SHELL_CACHE });
    return cached ?? uncachedOfflineResponse();
  }
}

/**
 * Content-hashed build assets are cache-first: the URL names the bytes, so a hit
 * cannot be stale, and a new deployment's assets have new URLs that miss. The
 * write is deliberately awaited rather than deferred -- the response is returned
 * only once it is stored, so an offline reload immediately after the first load
 * finds the whole graph.
 */
async function handleHashedAsset(request) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);
  if (cached !== undefined) return cached;
  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
    await trimCache(cache, MAX_ASSET_ENTRIES);
  }
  return response;
}

/**
 * The unhashed icons and manifest are cache-first with a background refresh:
 * they are tiny, they must be there for an install prompt raised offline, and
 * their URLs are stable, so a revalidation that fails simply leaves the stored
 * copy in place.
 */
async function handleStaticAsset(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  if (cached !== undefined) {
    void refreshInBackground(cache, request);
    return cached;
  }
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

/** Re-fetch `request` and replace its cached copy, swallowing a failure: this
 * runs beside a response already returned from the cache, so a rejection here
 * must not surface as an unhandled rejection in the worker. */
async function refreshInBackground(cache, request) {
  try {
    const response = await fetch(request, { cache: "reload" });
    if (response.ok) await cache.put(request, response);
  } catch {
    // Offline or a failing origin; the stored copy stands.
  }
}

/**
 * The `/assets/...` paths a served document references, deduplicated. Reading
 * them out of the document text rather than parsing it keeps the worker free of
 * an HTML parser it has no other use for; a path this misses costs nothing
 * beyond a network fetch on first use, and a path it invents fails its
 * individual precache and is skipped.
 */
function hashedAssetPathsIn(servedDocument) {
  const pattern = new RegExp(
    `${ASSET_PATH_PREFIX}[A-Za-z0-9._~-]+\\.(?:js|css)`,
    "g",
  );
  return [...new Set(servedDocument.match(pattern) ?? [])];
}

/**
 * Add each path on its own, so one 404 or transient failure does not discard the
 * whole batch the way `cache.addAll` would.
 *
 * A path already stored is skipped, which is what keeps a repeated warm from
 * refetching the whole graph. That is safe for the content-hashed assets (a
 * stored copy is the same bytes their URL names) and for the unhashed static
 * list, whose stored copies {@link handleStaticAsset} revalidates on use.
 */
async function addAllIndividually(cache, paths) {
  await Promise.all(
    paths.map(async (path) => {
      try {
        if ((await cache.match(path)) !== undefined) return;
        await cache.add(path);
      } catch {
        // One missing or failing asset; the rest of the precache stands.
      }
    }),
  );
}

/** Drop the oldest entries until `cache` holds at most `max`. */
async function trimCache(cache, max) {
  const keys = await cache.keys();
  if (keys.length <= max) return;
  for (const key of keys.slice(0, keys.length - max)) {
    await cache.delete(key);
  }
}

/** The offline document served when nothing is cached, as a 503 so it is never
 * mistaken for a successful render of the app. */
function uncachedOfflineResponse() {
  return new Response(UNCACHED_OFFLINE_DOCUMENT, {
    status: 503,
    statusText: "Offline",
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
