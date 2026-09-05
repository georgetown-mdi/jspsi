import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

import ts from "typescript";

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
 * rests on: `match` hands back a fresh `Response` each time, as a real cache does,
 * and `keys()` enumerates in insertion order, which is what lets the trim drop
 * the oldest entries. It also refuses on demand ({@link HarnessStorageFailures}),
 * modeling a browser whose storage is full or switched off. Everything else about
 * it is a plain map.
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

/** A string constant declared at the worker's top level, read from its source
 * for the same reason as {@link serviceWorkerConstant} -- and, for a value the
 * client half declares its own copy of, so a test can hold the two against each
 * other rather than against a literal. */
export function serviceWorkerString(name: string): string {
  const match = new RegExp(`const ${name} = "([^"]*)";`).exec(
    serviceWorkerSource(),
  );
  if (match === null)
    throw new Error(`serviceWorker.js declares no string const ${name}`);
  return match[1];
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

/**
 * The worker's own `hashedAssetPathsIn`, lifted out of the classic script so a
 * check can run the shipped extraction over a document a real server rendered.
 *
 * The worker exports nothing, so its source is evaluated the way {@link
 * createServiceWorkerHarness} evaluates it and the function is returned out of
 * that scope. Only the top-level listener registrations run at evaluation, so
 * the scope needs nothing past `addEventListener`; `caches` and `fetch` are
 * reached from the handlers alone, which this never fires.
 */
export function serviceWorkerAssetExtractor(): (
  servedDocument: string,
) => Array<string> {
  const evaluate = new Function(
    "self",
    "caches",
    "fetch",
    `${serviceWorkerSource()}\nreturn hashedAssetPathsIn;`,
  ) as (
    scope: unknown,
    caches: unknown,
    fetch: unknown,
  ) => (servedDocument: string) => Array<string>;
  return evaluate({ addEventListener: () => undefined }, undefined, undefined);
}

/** One name the worker's top-level code -- everything outside its function
 * declarations -- references. */
export interface TopLevelReference {
  /** The name referenced. */
  readonly name: string;
  /** The top-level `const` whose declaration the reference sits in, which for
   * the constant's own declaration is that constant. `undefined` for a
   * reference anywhere else at the top level: a listener body, or a statement
   * declaring more than one name. */
  readonly declaredConst: string | undefined;
  /** The 1-based line of `serviceWorker.js` the reference sits on, so a failure
   * names where to look. */
  readonly line: number;
}

/** One `caches.open(...)` call in the worker. */
export interface CacheOpenSite {
  /** The top-level function declaration the call sits in, or `undefined` for
   * one in the worker's top-level code. */
  readonly inFunction: string | undefined;
  /** The 1-based line of `serviceWorker.js` the call sits on. */
  readonly line: number;
}

/** The worker's code as a guard over "which functions may touch X" reads it. */
export interface ServiceWorkerSourceModel {
  /** Each top-level function declaration by name, as the set of names its body
   * references. */
  readonly functions: ReadonlyMap<string, ReadonlySet<string>>;
  /** Every name the worker's top-level code references outside those
   * declarations, in source order. */
  readonly outsideFunctions: ReadonlyArray<TopLevelReference>;
  /** The text of every string and template literal in the worker's code, each
   * `${...}` substitution removed. */
  readonly literals: ReadonlyArray<string>;
  /** For each top-level `const` declared as a string or template literal, that
   * literal's text with its substitutions removed. */
  readonly declaredLiterals: ReadonlyMap<string, string>;
  /** Every `caches.open(...)` call, in source order. */
  readonly cacheOpens: ReadonlyArray<CacheOpenSite>;
}

/** The text of a string or template literal with every `${...}` substitution
 * removed, or `undefined` for a node that is neither. */
function literalTextOf(node: ts.Node): string | undefined {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node))
    return (
      node.head.text +
      node.templateSpans.map((span) => span.literal.text).join("")
    );
  return undefined;
}

/** The one name a top-level statement declares and the literal it is declared
 * as, or `undefined` for a statement that declares no single name. */
function topLevelDeclaration(
  statement: ts.Statement,
): { name: string; literal: string | undefined } | undefined {
  if (!ts.isVariableStatement(statement)) return undefined;
  const declarations = statement.declarationList.declarations;
  if (declarations.length !== 1) return undefined;
  const { name, initializer } = declarations[0];
  if (!ts.isIdentifier(name)) return undefined;
  return {
    name: name.text,
    literal: initializer === undefined ? undefined : literalTextOf(initializer),
  };
}

/** The names the worker's own global scope answers to. A capability reached
 * through one of these is reached by the worker as surely as a bare reference
 * is, and `self.X` is the prevailing idiom in a worker script. */
const GLOBAL_SCOPE_ALIASES: ReadonlySet<string> = new Set([
  "self",
  "globalThis",
  "window",
]);

/** Whether `node` is a `caches.open(...)` call -- the one Cache API call that
 * hands back a cache its caller can write. */
function isCachesOpen(node: ts.Node): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "caches" &&
    node.expression.name.text === "open"
  );
}

/**
 * Parse the worker and report what its code names, where.
 *
 * A guard over the asset cache's writers has to distinguish a function that
 * reaches the cache from prose that mentions it, and a listener body reaching it
 * inline from the constants that name it. That is a question about the worker's
 * syntax, so it is answered by parsing the shipped file rather than scanning its
 * text: a parse sees no identifiers in a comment, and a function's extent is
 * its declaration rather than whatever its formatting suggests.
 *
 * A reference here is a name the worker's code resolves in scope -- a
 * declaration's own name included, a property being read off an object (the
 * `open` of `caches.open`) excluded, since that name resolves against the object
 * rather than the worker. The one exception is a property read off the global
 * scope itself ({@link GLOBAL_SCOPE_ALIASES}): `self.indexedDB` reaches the same
 * capability a bare `indexedDB` would, and a model that saw only the `self` in it
 * would let a guard over what the worker may touch pass the worker's own idiom.
 *
 * `code` defaults to the shipped worker. A caller passes a snippet instead only
 * to drive a guard against a source that should fail it -- a guard nothing can
 * fail asserts nothing.
 */
export function serviceWorkerSourceModel(
  code: string = serviceWorkerSource(),
): ServiceWorkerSourceModel {
  const source = ts.createSourceFile(
    serviceWorkerPath,
    code,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.JS,
  );

  const functions = new Map<string, ReadonlySet<string>>();
  const outsideFunctions: Array<TopLevelReference> = [];
  const literals: Array<string> = [];
  const declaredLiterals = new Map<string, string>();
  const cacheOpens: Array<CacheOpenSite> = [];

  const lineOf = (node: ts.Node): number =>
    ts.getLineAndCharacterOfPosition(source, node.getStart(source)).line + 1;

  const collectLiterals = (node: ts.Node): void => {
    const text = literalTextOf(node);
    if (text !== undefined) literals.push(text);
    ts.forEachChild(node, collectLiterals);
  };
  ts.forEachChild(source, collectLiterals);

  const collectReferences = (
    node: ts.Node,
    inFunction: string | undefined,
    record: (identifier: ts.Identifier) => void,
  ): void => {
    const descend = (child: ts.Node): void =>
      collectReferences(child, inFunction, record);
    if (isCachesOpen(node)) cacheOpens.push({ inFunction, line: lineOf(node) });
    if (ts.isIdentifier(node)) {
      record(node);
      return;
    }
    if (ts.isPropertyAccessExpression(node)) {
      if (
        ts.isIdentifier(node.expression) &&
        GLOBAL_SCOPE_ALIASES.has(node.expression.text) &&
        ts.isIdentifier(node.name)
      )
        record(node.name);
      descend(node.expression);
      return;
    }
    if (
      ts.isPropertyAssignment(node) &&
      !ts.isComputedPropertyName(node.name)
    ) {
      descend(node.initializer);
      return;
    }
    ts.forEachChild(node, descend);
  };

  for (const statement of source.statements) {
    const declaredFunction = ts.isFunctionDeclaration(statement)
      ? statement.name?.text
      : undefined;
    if (declaredFunction !== undefined) {
      const referenced = new Set<string>();
      collectReferences(statement, declaredFunction, (identifier) =>
        referenced.add(identifier.text),
      );
      functions.set(declaredFunction, referenced);
      continue;
    }
    const declared = topLevelDeclaration(statement);
    collectReferences(statement, undefined, (identifier) =>
      outsideFunctions.push({
        name: identifier.text,
        declaredConst: declared?.name,
        line: lineOf(identifier),
      }),
    );
    if (declared?.literal !== undefined)
      declaredLiterals.set(declared.name, declared.literal);
  }

  return {
    functions,
    outsideFunctions,
    literals,
    declaredLiterals,
    cacheOpens,
  };
}

/** How the harness answers one request path. */
export type RouteHandler = () => Response;

/**
 * The CacheStorage failures a test switches on, so the worker can be driven
 * against a browser whose storage refuses.
 *
 * Every one of these is a documented Cache API failure, not an invented one:
 * `open` rejects where storage is disabled or the bucket is gone, `put` rejects
 * with QuotaExceededError, and `match`/`keys` reject on a cache the browser has
 * torn down under the worker. Each is switchable mid-test, so a worker that
 * cached successfully can then meet a failing storage.
 */
export interface HarnessStorageFailures {
  /** Reject every `caches.open`. */
  open: (failing: boolean) => void;
  /** Reject every `cache.put` and `cache.add`, as an over-quota browser does. */
  put: (failing: boolean) => void;
  /** Reject every `cache.match` and `caches.match`. */
  match: (failing: boolean) => void;
  /** Reject every `cache.keys` and `caches.keys` -- the first step of both the
   * asset-cache trim and the activate sweep. */
  keys: (failing: boolean) => void;
}

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
  /** Switch the fabricated CacheStorage's failures on and off. */
  readonly storageFails: HarnessStorageFailures;
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
  /**
   * What the last {@link handleFetch} handed the fetch event's `waitUntil`: the
   * work a browser holds the worker alive to finish after its response is
   * served. Empty when the handler asked for no such hold, which is how a test
   * tells work that is held from work merely started.
   */
  readonly heldByLastFetch: ReadonlyArray<Promise<unknown>>;
  /** Create a cache the worker did not, standing in for a previous scheme's
   * leftovers. */
  seedCache: (name: string) => Promise<void>;
  /** The names of every cache that exists. */
  cacheNames: () => Array<string>;
  /** The URLs stored in one cache, in insertion order. Empty for a cache that
   * does not exist. */
  cachedUrls: (name: string) => Array<string>;
  /** Every event type the worker registered a listener for at evaluation, in
   * registration order. A guard over what the worker can be woken FOR reads it:
   * a background-wakeup registration the worker must not have is an event type
   * that would appear here. */
  readonly registeredEventTypes: ReadonlyArray<string>;
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

  const failing = { open: false, put: false, match: false, keys: false };

  /** Reject the way the platform does when the switched-on failure applies. A
   * real `put` over quota rejects with a QuotaExceededError DOMException; the
   * rest reject with whatever the browser's storage layer raises, so a plain
   * DOMException stands in. */
  function refuseWhenFailing(operation: keyof typeof failing): void {
    if (!failing[operation]) return;
    throw operation === "put"
      ? new DOMException("Quota exceeded", "QuotaExceededError")
      : new DOMException(
          `cache ${operation} is unavailable`,
          "InvalidStateError",
        );
  }

  function cacheApi(entries: Map<string, Response>) {
    async function store(
      request: RequestLike,
      response: Response,
    ): Promise<void> {
      refuseWhenFailing("put");
      // Delete before setting so a re-put moves the entry to the end of the
      // insertion order, matching a real cache's replace-then-append.
      const key = requestUrl(request);
      entries.delete(key);
      entries.set(key, response);
    }
    return {
      match: async (request: RequestLike) => {
        refuseWhenFailing("match");
        return entries.get(requestUrl(request))?.clone();
      },
      put: store,
      add: async (request: RequestLike) => {
        const response = await fetchImpl(request);
        if (!response.ok)
          throw new TypeError(`add() failed for ${requestUrl(request)}`);
        await store(request, response);
      },
      keys: async () => {
        refuseWhenFailing("keys");
        return [...entries.keys()].map((url) => ({ url }));
      },
      delete: async (request: RequestLike) =>
        entries.delete(requestUrl(request)),
    };
  }

  const cacheStorage = {
    open: async (name: string) => {
      refuseWhenFailing("open");
      const existing = caches.get(name);
      if (existing !== undefined) return cacheApi(existing);
      const created = new Map<string, Response>();
      caches.set(name, created);
      return cacheApi(created);
    },
    keys: async (): Promise<Array<string>> => {
      refuseWhenFailing("keys");
      return [...caches.keys()];
    },
    delete: async (name: string): Promise<boolean> => caches.delete(name),
    match: async (
      request: RequestLike,
      options: { cacheName: string },
    ): Promise<Response | undefined> => {
      refuseWhenFailing("match");
      return caches.get(options.cacheName)?.get(requestUrl(request))?.clone();
    },
  };

  const listeners = new Map<string, (event: never) => void>();
  const registeredEventTypes: Array<string> = [];
  // Reused across fetches rather than replaced, so the array the harness exposes
  // stays the live one; each fetch clears it before the handler runs.
  const heldByLastFetch: Array<Promise<unknown>> = [];
  let skipWaitingCalls = 0;
  let clientsClaimed = 0;

  const scope = {
    location: new URL(`${HARNESS_ORIGIN}/serviceWorker.js`),
    addEventListener: (type: string, listener: (event: never) => void) => {
      registeredEventTypes.push(type);
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
    storageFails: {
      open: (fails) => {
        failing.open = fails;
      },
      put: (fails) => {
        failing.put = fails;
      },
      match: (fails) => {
        failing.match = fails;
      },
      keys: (fails) => {
        failing.keys = fails;
      },
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
      heldByLastFetch.length = 0;
      fire("fetch", {
        request,
        respondWith: (promise: Promise<Response>) => {
          responded = promise;
        },
        waitUntil: (promise: Promise<unknown>) => heldByLastFetch.push(promise),
      });
      return responded === undefined ? undefined : await responded;
    },
    heldByLastFetch,
    seedCache: async (name) => {
      await cacheStorage.open(name);
    },
    cacheNames: () => [...caches.keys()],
    cachedUrls: (name) => [...(caches.get(name)?.keys() ?? [])],
    registeredEventTypes,
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
