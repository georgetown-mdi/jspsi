import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

// Every fake below stands in for an asynchronous platform API, so each returns a
// promise whether or not its own body has anything to await.
/* eslint-disable @typescript-eslint/require-await */

/**
 * A node harness that runs `apps/web/public/serviceWorker.js` itself.
 *
 * The worker is a classic script with no exports -- it is a static asset, not a
 * module -- so a test cannot import it. This evaluates the shipped file with
 * `self`, `caches`, and `fetch` bound to fabricated implementations, captures
 * the listeners it registers, and drives them through {@link
 * ServiceWorkerHarness}. What is under test is therefore the file that deploys,
 * not a restatement of it.
 *
 * The fabricated CacheStorage models the two behaviors the worker's correctness
 * rests on: a `match` hands back a fresh `Response` each time (a real cache does,
 * which is why one cached shell can answer more than one navigation), and
 * `keys()` enumerates in insertion order (which is what makes the trim drop the
 * oldest entries). Everything else about it is a plain map.
 *
 * Requests are plain `{ url, method, mode }` objects rather than `Request`s
 * because `new Request(url, { mode: "navigate" })` is required to throw, so a
 * navigation -- the case the whole offline path turns on -- cannot be built any
 * other way. The worker reads exactly those three fields.
 */

/** Where the harness pretends the worker is served from. */
export const HARNESS_ORIGIN = "https://linkage.example.org";

const serviceWorkerPath = fileURLToPath(
  new URL("../../public/serviceWorker.js", import.meta.url),
);

/** A request as the worker reads one. */
export interface HarnessRequest {
  readonly url: string;
  readonly method: string;
  readonly mode: string;
}

/** Anything the worker passes to `fetch` or uses as a cache key: a URL string or
 * object, a harness request, or one of the keys the fabricated cache hands back.
 * `fetch` accepts all of these, so the harness must too -- a fake that took only
 * strings would make a `URL` argument look like a network failure. */
type RequestLike = string | URL | { readonly url: string };

/** The worker source, for a test that needs a constant the classic script
 * declares (its top-level `const`s are lexical, so evaluating it exposes none). */
export function serviceWorkerSource(): string {
  return readFileSync(serviceWorkerPath, "utf8");
}

/** A numeric constant declared at the worker's top level, read from its source
 * so a test cannot assert against a stale copy of the value. */
export function serviceWorkerConstant(name: string): number {
  const match = new RegExp(`const ${name} = (\\d+);`).exec(
    serviceWorkerSource(),
  );
  if (match === null)
    throw new Error(`serviceWorker.js declares no numeric const ${name}`);
  return Number(match[1]);
}

/** A string-array constant declared at the worker's top level, read from its
 * source for the same reason as {@link serviceWorkerConstant}. */
export function serviceWorkerStringArray(name: string): Array<string> {
  const block = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`).exec(
    serviceWorkerSource(),
  );
  if (block === null)
    throw new Error(`serviceWorker.js declares no array const ${name}`);
  return [...block[1].matchAll(/"([^"]*)"/g)].map((match) => match[1]);
}

/** How the harness answers one request path. */
export type RouteHandler = () => Response;

/** The harness's fabricated network. */
export interface HarnessNetwork {
  /** Answer a GET of `path` with `handler`'s response. */
  route: (path: string, handler: RouteHandler) => void;
  /** Reject every request, as a browser with no connectivity does. */
  goOffline: () => void;
  /** Answer routed requests again. */
  goOnline: () => void;
  /** Every request path the worker has asked for, in order. */
  readonly requested: ReadonlyArray<string>;
}

/** The driver a test uses to run the worker's lifecycle and its fetch handler. */
export interface ServiceWorkerHarness {
  readonly network: HarnessNetwork;
  /** Fire `install` and settle everything it passed to `waitUntil`. */
  install: () => Promise<void>;
  /** Fire `activate` and settle everything it passed to `waitUntil`. */
  activate: () => Promise<void>;
  /** Deliver a `message` event and settle everything it passed to `waitUntil`. */
  postMessage: (data: unknown) => Promise<void>;
  /**
   * Fire a `fetch` event for `request`. Resolves to the response the worker
   * supplied, or `undefined` when it did not call `respondWith` -- which is the
   * worker declining to intercept, leaving the request to the browser.
   */
  handleFetch: (request: HarnessRequest) => Promise<Response | undefined>;
  /** Create a cache the worker did not, standing in for a previous scheme's
   * leftovers. */
  seedCache: (name: string) => Promise<void>;
  /** The names of every cache that exists. */
  cacheNames: () => Array<string>;
  /** The URLs stored in one cache, in insertion order. Empty for a cache that
   * does not exist. */
  cachedUrls: (name: string) => Array<string>;
  /** How many times `skipWaiting()` was called. */
  readonly skipWaitingCalls: number;
  /** How many times `clients.claim()` was called. */
  readonly clientsClaimed: number;
}

function requestUrl(request: RequestLike): string {
  if (typeof request === "string")
    return new URL(request, HARNESS_ORIGIN).toString();
  if (request instanceof URL) return request.toString();
  return request.url;
}

/** Build the harness and evaluate the worker into it. */
export function createServiceWorkerHarness(): ServiceWorkerHarness {
  const routes = new Map<string, RouteHandler>();
  const requested: Array<string> = [];
  let offline = false;

  const fetchImpl = async (request: RequestLike): Promise<Response> => {
    const url = new URL(requestUrl(request));
    requested.push(url.pathname);
    if (offline) throw new TypeError("Failed to fetch");
    const handler = routes.get(url.pathname);
    if (handler === undefined)
      return new Response("not found", { status: 404 });
    return handler();
  };

  const caches = new Map<string, Map<string, Response>>();

  function cacheApi(entries: Map<string, Response>) {
    async function store(
      request: RequestLike,
      response: Response,
    ): Promise<void> {
      // Delete before setting so a re-put moves the entry to the end of the
      // insertion order, matching a real cache's replace-then-append.
      const key = requestUrl(request);
      entries.delete(key);
      entries.set(key, response);
    }
    return {
      match: async (request: RequestLike) =>
        entries.get(requestUrl(request))?.clone(),
      put: store,
      add: async (request: RequestLike) => {
        const response = await fetchImpl(request);
        if (!response.ok)
          throw new TypeError(`add() failed for ${requestUrl(request)}`);
        await store(request, response);
      },
      keys: async () => [...entries.keys()].map((url) => ({ url })),
      delete: async (request: RequestLike) =>
        entries.delete(requestUrl(request)),
    };
  }

  const cacheStorage = {
    open: async (name: string) => {
      const existing = caches.get(name);
      if (existing !== undefined) return cacheApi(existing);
      const created = new Map<string, Response>();
      caches.set(name, created);
      return cacheApi(created);
    },
    keys: async (): Promise<Array<string>> => [...caches.keys()],
    delete: async (name: string): Promise<boolean> => caches.delete(name),
    match: async (
      request: RequestLike,
      options: { cacheName: string },
    ): Promise<Response | undefined> =>
      caches.get(options.cacheName)?.get(requestUrl(request))?.clone(),
  };

  const listeners = new Map<string, (event: never) => void>();
  let skipWaitingCalls = 0;
  let clientsClaimed = 0;

  const scope = {
    location: new URL(`${HARNESS_ORIGIN}/serviceWorker.js`),
    addEventListener: (type: string, listener: (event: never) => void) => {
      listeners.set(type, listener);
    },
    skipWaiting: async () => {
      skipWaitingCalls += 1;
    },
    clients: {
      claim: async () => {
        clientsClaimed += 1;
      },
    },
  };

  // The worker is a classic script: evaluating it inside a function whose
  // parameters shadow `self`, `caches`, and `fetch` is a service-worker global
  // scope, minus everything the worker does not touch.
  const evaluate = new Function(
    "self",
    "caches",
    "fetch",
    serviceWorkerSource(),
  ) as (scope: unknown, caches: unknown, fetch: unknown) => void;
  evaluate(scope, cacheStorage, fetchImpl);

  function fire<TEvent>(type: string, event: TEvent): void {
    (listeners.get(type) as ((event: TEvent) => void) | undefined)?.(event);
  }

  async function fireLifecycle(type: "install" | "activate"): Promise<void> {
    const pending: Array<Promise<unknown>> = [];
    fire(type, {
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    });
    await Promise.all(pending);
  }

  return {
    network: {
      route: (path, handler) => routes.set(path, handler),
      goOffline: () => {
        offline = true;
      },
      goOnline: () => {
        offline = false;
      },
      requested,
    },
    install: () => fireLifecycle("install"),
    activate: () => fireLifecycle("activate"),
    postMessage: async (data) => {
      const pending: Array<Promise<unknown>> = [];
      fire("message", {
        data,
        waitUntil: (promise: Promise<unknown>) => pending.push(promise),
      });
      await Promise.all(pending);
    },
    handleFetch: async (request) => {
      let responded: Promise<Response> | undefined;
      fire("fetch", {
        request,
        respondWith: (promise: Promise<Response>) => {
          responded = promise;
        },
      });
      return responded === undefined ? undefined : await responded;
    },
    seedCache: async (name) => {
      await cacheStorage.open(name);
    },
    cacheNames: () => [...caches.keys()],
    cachedUrls: (name) => [...(caches.get(name)?.keys() ?? [])],
    get skipWaitingCalls() {
      return skipWaitingCalls;
    },
    get clientsClaimed() {
      return clientsClaimed;
    },
  };
}

/** A request shaped the way a browser makes one for a page navigation. */
export function navigationRequest(path: string): HarnessRequest {
  return {
    url: new URL(path, HARNESS_ORIGIN).toString(),
    method: "GET",
    mode: "navigate",
  };
}

/** A request shaped the way a browser makes one for a subresource. */
export function subresourceRequest(
  path: string,
  method = "GET",
): HarnessRequest {
  return {
    url: new URL(path, HARNESS_ORIGIN).toString(),
    method,
    mode: "cors",
  };
}

/** Yield to the microtask and timer queues so work the worker started beside a
 * response it already returned (its background revalidation) settles. */
export async function settleBackgroundWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
