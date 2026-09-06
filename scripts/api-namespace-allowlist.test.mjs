import { posix } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { REGENERATE_COMMAND } from "./check-routetree-fresh.mjs";
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
// allowlist is a hand-written list of prefixes, and a route added outside it is
// served or refused by whatever the list happens to say, with nothing failing
// either way: an added job-gated route is refused ahead of its own gate, which
// is right, but an added ungated route is routed to on the public deployment,
// which is not. This is that obligation as a check.
//
// It is an INCLUSION check over the ROUTER'S OWN ACCOUNT of what it serves:
// the entries come from the generated route tree
// (apps/web/src/routeTree.gen.ts), whose FileRoutesByFullPath names every path
// the router resolves to and the module that answers it. Nothing here maps a
// file name to a path -- a route's path comes from its name as much as its
// directory (api.telemetry.ts, a `_`-prefixed pathless layout, a parenthesized
// group), and every rule for reading one is the generator's, so a copy of that
// rule here would decide a name the generator decides differently. There is no
// allowance list, and one nobody thought to list is covered the day it lands.
//
// The generated tree is a checked-in build product, so this check is only as
// current as it is; scripts/check-routetree-fresh.mjs is what holds it to what
// the pinned generator produces. Independent of that, an arm below holds the
// modules the tree names against the route tree on disk in both directions, so
// a route file added or removed without the regeneration is reported here
// rather than read past.
//
// What it decides is SYNTACTIC and coarse, and it owns only the accounting.
// "Gated" here means every module answering under the entry imports the job
// gate by name from a routeSupport specifier -- WHETHER each handler calls it
// first and returns its refusal is scripts/job-route-gate.test.mjs's claim,
// over the job route directory, and neither check stands in for the other. An
// entry whose modules it cannot read that way is reported as unaccounted for
// rather than passed over.
//
// public/ is read too. A static asset there is served by Nitro's own handler,
// which does not run the server entry (apps/web/src/utils/securityHeaders.ts
// states that bypass), so an asset under public/api would answer past the
// refusal entirely. None may exist.

const SELF = "scripts/api-namespace-allowlist.test.mjs";

// The refusal, the entry that installs it, the router's account of the routes
// it decides over, the tree those routes are written in, and the public assets
// that bypass it, all repository-relative.
const GUARD_MODULE = "apps/web/src/utils/apiNamespace.ts";
const SERVER_ENTRY = "apps/web/src/server.ts";
const ROUTE_TREE = "apps/web/src/routeTree.gen.ts";
const ROUTES_ROOT = "apps/web/src/routes";
const PUBLIC_DIR = "apps/web/public";

/** The exported names the refusal declares: the wrapper the server entry
 * installs, and the allowlist this check is read against. */
const GUARD = "withApiGuard";
const ALLOWLIST = "HOSTED_API_PREFIXES";

/** The interface in the generated route tree that names every path the router
 * serves, mapped to the route that answers it. */
const SERVED_PATHS = "FileRoutesByFullPath";

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

/** The route modules the routes tree holds, by their extensionless path, so a
 * specifier the generated tree writes without one names the file it was read
 * from. */
const modulesByStem = new Map(
  sourceModules(ROUTES_ROOT).map((file) => [file.replace(/\.tsx?$/, ""), file]),
);

/**
 * Every name the generated route tree imports, mapped to the module it comes
 * from, repository-relative and extensionless.
 */
function importedRoutes(sourceFile) {
  const base = posix.dirname(ROUTE_TREE);
  const byName = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(specifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements)
      byName.set(element.name.text, posix.join(base, specifier.text));
  }
  return byName;
}

/**
 * Every name the generated route tree derives from another by a call on it --
 * `X.update(...)`, `X._addFileChildren(...)` -- mapped to that other name, so a
 * served path naming the derived one is read back to the module it was built
 * from.
 */
function derivedRoutes(sourceFile) {
  const byName = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const value = declaration.initializer;
      if (value === undefined || !ts.isCallExpression(value)) continue;
      const callee = value.expression;
      if (!ts.isPropertyAccessExpression(callee)) continue;
      if (!ts.isIdentifier(callee.expression)) continue;
      byName.set(declaration.name.text, callee.expression.text);
    }
  }
  return byName;
}

/**
 * Every path the router serves, as `{path, route}` pairs read from
 * {@link SERVED_PATHS}, or null when that interface is absent or holds a member
 * written in any shape other than a quoted path typed `typeof <route>` -- the
 * only one this check reads, so a generator that writes another fails the rot
 * guard rather than shrinking the enumeration.
 */
function servedPaths(sourceFile) {
  for (const statement of sourceFile.statements) {
    if (!ts.isInterfaceDeclaration(statement)) continue;
    if (statement.name.text !== SERVED_PATHS) continue;
    const served = [];
    for (const member of statement.members) {
      if (!ts.isPropertySignature(member)) return null;
      if (!ts.isStringLiteral(member.name)) return null;
      const type = member.type;
      if (type === undefined || !ts.isTypeQueryNode(type)) return null;
      if (!ts.isIdentifier(type.exprName)) return null;
      served.push({ path: member.name.text, route: type.exprName.text });
    }
    return served;
  }
  return null;
}

const treeSource = parseFile(ROUTE_TREE);
const imported = importedRoutes(treeSource);
const derived = derivedRoutes(treeSource);
const served = servedPaths(treeSource) ?? [];

/**
 * The route module `route` is built from, repository-relative, or null when the
 * generated tree does not read back to one this checkout holds.
 */
function moduleOf(route) {
  const seen = new Set();
  let current = route;
  while (!imported.has(current)) {
    if (seen.has(current)) return null;
    seen.add(current);
    const next = derived.get(current);
    if (next === undefined) return null;
    current = next;
  }
  return modulesByStem.get(imported.get(current)) ?? null;
}

/**
 * The route entries the namespace holds: one per path segment directly under
 * it, with the served paths it answers and the modules behind them. A served
 * path whose module the generated tree does not read back to stays in the
 * reading, listed as unreadable, so it is reported rather than passed over.
 */
function routeEntries() {
  const byRoute = new Map();
  for (const { path, route } of served) {
    if (!isUnderPrefix(path, API_PATH_ROOT)) continue;
    const [segment] = path.slice(API_PATH_ROOT.length + 1).split("/");
    const key = segment === "" ? API_PATH_ROOT : `${API_PATH_ROOT}/${segment}`;
    const entry = byRoute.get(key) ?? {
      route: key,
      modules: new Set(),
      unreadable: new Set(),
    };
    const module = moduleOf(route);
    if (module === null) entry.unreadable.add(path);
    else entry.modules.add(module);
    byRoute.set(key, entry);
  }
  return [...byRoute.values()];
}

const guardSource = parseFile(GUARD_MODULE);
const allowlist = stringArrayConstant(guardSource, ALLOWLIST);
const entries = routeEntries();

describe("every /api route is accounted for by the namespace refusal", () => {
  it("reads the refusal's allowlist and the routes it decides over", () => {
    // A rot guard: a rewritten allowlist, a renamed guard, or a generated route
    // tree this check no longer reads would otherwise empty the enumeration and
    // make the assertions below vacuous.
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
    expect(
      servedPaths(treeSource),
      `${ROUTE_TREE} no longer declares ${SERVED_PATHS} as quoted paths typed ` +
        `\`typeof <route>\`, which is the only shape this check reads, so the ` +
        `paths the router serves cannot be enumerated from it. Teach ${SELF} ` +
        `the new one.`,
    ).not.toBeNull();
    expect(entries.length).toBeGreaterThan(0);
    expect(
      importsFrom(parseFile(SERVER_ENTRY), GUARD, "apiNamespace"),
      `${SERVER_ENTRY} no longer installs ${GUARD}, so nothing applies the ` +
        `refusal and every route below is served by the router on every ` +
        `deployment profile.`,
    ).toBe(true);
  });

  it("reads a route tree that names the route files on disk", () => {
    // The enumeration above is only as current as this generated file, so the
    // two are held against each other in both directions rather than this
    // check reading past a route the tree does not yet name.
    const named = new Set(
      [...imported.values()].filter((stem) => isUnderPrefix(stem, ROUTES_ROOT)),
    );
    const drifted = [
      ...[...named]
        .filter((stem) => !modulesByStem.has(stem))
        .map((stem) => `${stem}: named by ${ROUTE_TREE}, absent from disk`),
      ...[...modulesByStem.values()]
        .filter((file) => !named.has(file.replace(/\.tsx?$/, "")))
        .map((file) => `${file}: on disk, unnamed by ${ROUTE_TREE}`),
    ].sort();
    expect(
      drifted,
      `${drifted.length} route module(s) differ between ${ROUTES_ROOT} and ` +
        `${ROUTE_TREE}, so the served paths this check reads are not this ` +
        `checkout's. Regenerate the route tree and commit it:\n\n  ` +
        `${REGENERATE_COMMAND}`,
    ).toEqual([]);
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

  it("holds every route under /api to the allowlist or the job gate", () => {
    const unaccounted = [];
    for (const entry of entries) {
      if (allowlist.some((prefix) => isUnderPrefix(entry.route, prefix)))
        continue;
      for (const path of [...entry.unreadable].sort())
        unaccounted.push(
          `${path}: ${ROUTE_TREE} names no module this check can read`,
        );
      const ungated = [...entry.modules]
        .sort()
        .filter(
          (module) => !importsFrom(parseFile(module), GATE, GATE_MODULE_TAIL),
        );
      if (ungated.length > 0)
        unaccounted.push(
          `${entry.route}: ${ungated.join(", ")} ` +
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
        `route in ${ROUTE_TREE}, or reach past ${API_PATH_ROOT} itself. An ` +
        `entry that matches nothing is dead, and one naming ` +
        `"${API_PATH_ROOT}" admits the whole namespace. Remove it, or point ` +
        `it at the route it was meant for.`,
    ).toEqual([]);
  });
});
