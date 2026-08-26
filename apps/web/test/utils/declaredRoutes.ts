import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// The route paths the app's router declares, read from the route files' own
// `createFileRoute` argument -- which is what the router matches on -- rather
// than derived from filenames, so a change to the file-naming convention cannot
// make a check built on this silently vacuous.
//
// Two checks over the app-shell worker's warm read them: the source-level guard
// that holds SHELL_ROUTES to this list, and the integration check that drives
// those routes against the built server. One implementation, so a route the
// router declares cannot be a route only one of them knows about.

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
export const EXCLUDED_ROUTE_PREFIX = "/bench";

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
export function declaredRoutePaths(): Array<string> {
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
    .filter((path) => !path.startsWith(EXCLUDED_ROUTE_PREFIX));
}

/** Whether `path` is an instance of `pattern`, whose `$name` segments stand for
 * one path segment each. */
export function matchesRoutePattern(pattern: string, path: string): boolean {
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
