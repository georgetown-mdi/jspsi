import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { serviceWorkerStringArray } from "../utils/serviceWorkerHarness";

// The worker's SHELL_ROUTES is what an installed app warms so every route opens
// with no network, and it is a hand-written list: a route added to src/routes/
// without an entry here ships offline-broken, and nothing about writing the route
// would say so. This is that check. It reads the route paths from the route files
// themselves -- the `createFileRoute` argument, which is what the router matches
// on -- rather than deriving them from filenames, so a change to the file-naming
// convention cannot make it silently vacuous.

const routesDirectory = fileURLToPath(
  new URL("../../src/routes", import.meta.url),
);

/**
 * The `/bench/*` subtree is excluded. Every leaf under it is a redirect to its
 * primary path (see src/routes/bench/route.tsx), so warming those paths would
 * cache a redirect rather than a surface, and the surfaces they redirect to are
 * warmed under their own paths. A leaf that ever renders something of its own
 * belongs on SHELL_ROUTES and out of this exclusion.
 */
const EXCLUDED_PREFIX = "/bench";

/** Every route file under src/routes, recursively, excluding the root route and
 * the server routes under api/ (which the worker never intercepts). */
function routeFiles(directory: string): Array<string> {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory())
      return entry.name === "api" ? [] : routeFiles(path);
    if (!entry.name.endsWith(".tsx") || entry.name === "__root.tsx") return [];
    return [path];
  });
}

/** The route path each file declares, with an index route's trailing slash
 * normalized away so `/saved/` and `/saved` compare equal. */
function declaredRoutePaths(): Array<string> {
  return routeFiles(routesDirectory)
    .map((path) => {
      const declared = /createFileRoute\("([^"]+)"\)/.exec(
        readFileSync(path, "utf8"),
      );
      if (declared === null)
        throw new Error(`${path} declares no createFileRoute path`);
      return declared[1];
    })
    .map((path) => (path.length > 1 ? path.replace(/\/$/, "") : path))
    .filter((path) => !path.startsWith(EXCLUDED_PREFIX));
}

/** Whether `path` is an instance of `pattern`, whose `$name` segments stand for
 * one path segment each. */
function matchesRoutePattern(pattern: string, path: string): boolean {
  const source = pattern
    .split("/")
    .map((segment) =>
      segment.startsWith("$")
        ? "[^/]+"
        : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("/");
  return new RegExp(`^${source}$`).test(path);
}

const shellRoutes = serviceWorkerStringArray("SHELL_ROUTES");

describe("the worker's warmed route list", () => {
  test("covers every route the app declares", () => {
    const uncovered = declaredRoutePaths().filter(
      (pattern) =>
        !shellRoutes.some((route) => matchesRoutePattern(pattern, route)),
    );

    expect(uncovered).toEqual([]);
  });

  test("names no route the app does not declare", () => {
    const patterns = declaredRoutePaths();
    const stale = shellRoutes.filter(
      (route) =>
        !patterns.some((pattern) => matchesRoutePattern(pattern, route)),
    );

    expect(stale).toEqual([]);
  });

  test("reads a real list, so neither check above is vacuous", () => {
    expect(shellRoutes.length).toBeGreaterThan(1);
    expect(declaredRoutePaths().length).toBeGreaterThan(1);
  });
});
