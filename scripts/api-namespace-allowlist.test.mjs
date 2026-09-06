import { posix } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  filesUnder,
  parseFile,
  sourceModules,
} from "./lib/typeScriptSources.mjs";

// Every route the web app serves under /api is accounted for by the namespace
// refusal: either the refusal lets it through on every deployment profile, or
// the job gate answers it on a profile where the job API is not enabled.
//
// The refusal (apps/web/src/utils/apiNamespace.ts) is what keeps a public
// deployment from routing to anything under /api but the peer-coordination
// broker, so the router's own answers -- the app document, its canonicalizing
// redirect, the SSR path's JSON refusal -- are not observable there. Its
// allowlist is a hand-written list of prefixes, and a route directory added
// outside it is served or refused by whatever the list happens to say, with
// nothing failing either way: an added job-gated route is refused ahead of its
// own gate, which is right, but an added ungated route is routed to on the
// public deployment, which is not. This is that obligation as a check.
//
// It is an INCLUSION check over the route tree: the entries are found by
// reading apps/web/src/routes rather than a maintained list, so one nobody
// thought to list is covered the day it lands. There is no allowance list. The
// whole tree is read, not the api directory alone, because a route's path comes
// from its file NAME as much as its directory: the router generator serves
// api.telemetry.ts at /api/telemetry, the flat style this repo already uses for
// saved.$id.tsx. The generator itself maps a name to its path here rather than
// a rule copied out of it, and a name reaching an api segment only past a
// parenthesized one is reported as undecided rather than passed over.
//
// What it decides is SYNTACTIC and coarse, and it owns only the accounting.
// "Gated" here means every module under the entry imports the job gate by name
// from a routeSupport specifier -- WHETHER each handler calls it first and
// returns its refusal is scripts/job-route-gate.test.mjs's claim, over the same
// tree, and neither check stands in for the other. An entry whose modules it
// cannot read that way is reported as unaccounted for rather than passed over.
//
// public/ is read too. A static asset there is served by Nitro's own handler,
// which does not run the server entry (apps/web/src/utils/securityHeaders.ts
// states that bypass), so an asset under public/api would answer past the
// refusal entirely. None may exist.

const SELF = "scripts/api-namespace-allowlist.test.mjs";

// The refusal, the entry that installs it, the route tree it decides over, and
// the public assets that bypass it, all repository-relative.
const GUARD_MODULE = "apps/web/src/utils/apiNamespace.ts";
const SERVER_ENTRY = "apps/web/src/server.ts";
const ROUTES_ROOT = "apps/web/src/routes";
const PUBLIC_DIR = "apps/web/public";

/** The exported names the refusal declares: the wrapper the server entry
 * installs, and the allowlist this check is read against. */
const GUARD = "withApiGuard";
const ALLOWLIST = "HOSTED_API_PREFIXES";

/** The path the routes tree is served under, held against the refusal's own
 * constant so the two cannot name different namespaces. */
const API_PATH_ROOT = "/api";
const API_PATH_ROOT_CONSTANT = "API_PATH_ROOT";

/** The job gate every job route imports, and the tail its specifier contains --
 * the same binding scripts/job-route-gate.test.mjs reads. */
const GATE = "gateJobRoute";
const GATE_MODULE_TAIL = "routeSupport";

/**
 * The string-literal elements of the array `name` is declared with in
 * `sourceFile`, or null for any other shape -- a spread, a computed value, a
 * name the module does not declare.
 */
function stringArrayConstant(sourceFile, name) {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      if (declaration.name.text !== name) continue;
      const value = declaration.initializer;
      if (value === undefined || !ts.isArrayLiteralExpression(value))
        return null;
      if (!value.elements.every((element) => ts.isStringLiteral(element)))
        return null;
      return value.elements.map((element) => element.text);
    }
  }
  return null;
}

/**
 * The string `name` is declared with in `sourceFile`, or null for any other
 * shape.
 */
function stringConstant(sourceFile, name) {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      if (declaration.name.text !== name) continue;
      const value = declaration.initializer;
      return value !== undefined && ts.isStringLiteral(value)
        ? value.text
        : null;
    }
  }
  return null;
}

/** Whether `sourceFile` imports `name` from a specifier whose tail is `tail`. */
function importsFrom(sourceFile, name, tail) {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(specifier)) continue;
    if (!specifier.text.endsWith(tail)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements)
      if ((element.propertyName ?? element.name).text === name) return true;
  }
  return false;
}

/** Whether `path` is `prefix` itself or a path under it, by whole segments. */
function isUnderPrefix(path, prefix) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * The path the router generator serves a route file at, from that file's path
 * under the routes tree with its extension removed -- the dot-separated flat
 * name and the trailing-underscore form among them.
 */
const routePathOf = await (async () => {
  try {
    const { determineInitialRoutePath, removeUnderscores } =
      await import("@tanstack/router-generator");
    return (stem) =>
      removeUnderscores(determineInitialRoutePath(stem).routePath);
  } catch {
    // Without the generator installed this reads the dot-to-slash rule alone,
    // so an underscore or bracket-escaped name is read as it is written.
    return (stem) => `/${stem.replaceAll(".", "/")}`;
  }
})();

/** The route path {@link routePathOf} reads a route file at. */
function routePathOfFile(file) {
  return routePathOf(posix.relative(ROUTES_ROOT, file).replace(/\.tsx?$/, ""));
}

/** Where in the tree a route file's entry comes from: the directory or module
 * directly under the routes tree, or under its api directory, that holds it. */
function locationOf(file) {
  const segments = posix.relative(ROUTES_ROOT, file).split("/");
  const depth = segments[0] === "api" && segments.length > 1 ? 2 : 1;
  return posix.join(ROUTES_ROOT, ...segments.slice(0, depth));
}

/**
 * The route entries the namespace holds: one per path segment directly under
 * it, with the path it is served at, where in the tree it comes from, and the
 * TypeScript modules behind it. A directory entry is a whole subtree, and a
 * file named `api.<segment>...` joins the same entry the directory
 * `api/<segment>/` would. An entry holding no module this check can read stays
 * in the reading, with an empty module list, so it is reported rather than
 * passed over.
 *
 * A route path reaching the namespace only past a parenthesized segment is not
 * decided here; {@link undecidedRoutes} reports it.
 */
function routeEntries() {
  const byRoute = new Map();
  for (const path of filesUnder(ROUTES_ROOT)) {
    const routePath = routePathOfFile(path);
    if (!isUnderPrefix(routePath, API_PATH_ROOT)) continue;
    const [segment] = routePath.slice(API_PATH_ROOT.length + 1).split("/");
    const route =
      segment === "" || segment === "index"
        ? API_PATH_ROOT
        : `${API_PATH_ROOT}/${segment}`;
    const entry = byRoute.get(route) ?? {
      route,
      locations: new Set(),
      modules: [],
    };
    entry.locations.add(locationOf(path));
    if (/\.tsx?$/.test(path)) entry.modules.push(path);
    byRoute.set(route, entry);
  }
  return [...byRoute.values()].map((entry) => ({
    ...entry,
    where: [...entry.locations].sort().join(", "),
  }));
}

/**
 * The route files whose served path this check does not decide: one whose route
 * path reaches an `api` segment only past a parenthesized one, which this check
 * reads as written while the router may not serve it as a path segment at all.
 */
function undecidedRoutes() {
  return filesUnder(ROUTES_ROOT).filter((file) => {
    const routePath = routePathOfFile(file);
    const segments = routePath.split("/");
    return (
      !isUnderPrefix(routePath, API_PATH_ROOT) &&
      segments.includes(API_PATH_ROOT.slice(1)) &&
      segments.some((segment) => /^\(.*\)$/.test(segment))
    );
  });
}

const guardSource = parseFile(GUARD_MODULE);
const allowlist = stringArrayConstant(guardSource, ALLOWLIST);
const entries = routeEntries();

describe("every /api route is accounted for by the namespace refusal", () => {
  it("reads the refusal's allowlist and the routes it decides over", () => {
    // A rot guard: a rewritten allowlist, a renamed guard, or a moved routes
    // tree would otherwise empty the enumeration and make the assertions below
    // vacuous.
    expect(
      allowlist,
      `${GUARD_MODULE} no longer declares ${ALLOWLIST} as an array of string ` +
        `literals, which is the only shape this check reads. Teach ${SELF} the ` +
        `new one.`,
    ).not.toBeNull();
    expect(allowlist.length).toBeGreaterThan(0);
    expect(
      stringConstant(guardSource, API_PATH_ROOT_CONSTANT),
      `${GUARD_MODULE} refuses under a namespace root other than ` +
        `"${API_PATH_ROOT}", so the routes tree this check reads is no longer ` +
        `the tree the refusal decides over.`,
    ).toBe(API_PATH_ROOT);
    expect(entries.length).toBeGreaterThan(0);
    expect(
      importsFrom(parseFile(SERVER_ENTRY), GUARD, "apiNamespace"),
      `${SERVER_ENTRY} no longer installs ${GUARD}, so nothing applies the ` +
        `refusal and every route below is served by the router on every ` +
        `deployment profile.`,
    ).toBe(true);
  });

  it("serves nothing under /api from the public asset tree", () => {
    const assets = filesUnder(PUBLIC_DIR).filter(
      (path) => posix.relative(PUBLIC_DIR, path).split("/")[0] === "api",
    );
    expect(
      assets,
      `${assets.length} static asset(s) sit under ${PUBLIC_DIR}/api. Nitro ` +
        `serves those without running ${SERVER_ENTRY}, so the /api refusal ` +
        `never sees the request and the asset answers on every deployment ` +
        `profile. Serve it from a path outside ${API_PATH_ROOT}.`,
    ).toEqual([]);
  });

  it("reads every route file that could be served under /api", () => {
    const undecided = undecidedRoutes();
    expect(
      undecided,
      `${undecided.length} route file(s) in ${ROUTES_ROOT} reach an ` +
        `"${API_PATH_ROOT.slice(1)}" path segment only past a parenthesized ` +
        `one, which ${SELF} reads as a path segment and the router may not ` +
        `serve as one, so whether ${API_PATH_ROOT} is where they answer is ` +
        `undecided here. Teach ${SELF} that naming rule, or name the file so ` +
        `its served path is the one it reads.`,
    ).toEqual([]);
  });

  it("holds every route directory to the allowlist or the job gate", () => {
    const unaccounted = [];
    for (const entry of entries) {
      if (allowlist.some((prefix) => isUnderPrefix(entry.route, prefix)))
        continue;
      if (entry.modules.length === 0) {
        unaccounted.push(
          `${entry.where}: no TypeScript module this check can read`,
        );
        continue;
      }
      const ungated = entry.modules.filter(
        (module) => !importsFrom(parseFile(module), GATE, GATE_MODULE_TAIL),
      );
      if (ungated.length > 0)
        unaccounted.push(
          `${entry.route} (${entry.where}): ${ungated.join(", ")} ` +
            `${ungated.length === 1 ? "does" : "do"} not import ${GATE}`,
        );
    }
    expect(
      unaccounted,
      `${unaccounted.length} route(s) under ${API_PATH_ROOT} are neither in ` +
        `${GUARD_MODULE}'s ${ALLOWLIST} nor gated by ${GATE}, so what a public ` +
        `deployment answers for them is whatever the allowlist happens to say ` +
        `and nothing fails when it is wrong. Add the route to ${ALLOWLIST} if ` +
        `every deployment serves it, or gate it.`,
    ).toEqual([]);
  });

  it("holds every allowlist entry to a route that exists", () => {
    const stale = allowlist.filter(
      (prefix) =>
        !entries.some((entry) => isUnderPrefix(prefix, entry.route)) ||
        !isUnderPrefix(prefix, API_PATH_ROOT) ||
        prefix === API_PATH_ROOT,
    );
    expect(
      stale,
      `${stale.length} ${ALLOWLIST} entr(y/ies) in ${GUARD_MODULE} name no ` +
        `route in ${ROUTES_ROOT}, or reach past ${API_PATH_ROOT} itself. An ` +
        `entry that matches nothing is dead, and one naming ` +
        `"${API_PATH_ROOT}" admits the whole namespace. Remove it, or point ` +
        `it at the route it was meant for.`,
    ).toEqual([]);
  });
});
