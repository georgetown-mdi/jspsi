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
// reading apps/web/src/routes/api rather than a maintained list, so one nobody
// thought to list is covered the day it lands. There is no allowance list.
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
const ROUTES_DIR = "apps/web/src/routes/api";
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

/** The path a module directly under the routes tree is served at. */
function routeOfModule(name) {
  const stem = name.replace(/\.tsx?$/, "");
  return stem === "index" ? API_PATH_ROOT : `${API_PATH_ROOT}/${stem}`;
}

/**
 * The route entries directly under the routes tree: one per directory or module
 * there, with the path it is served at and the TypeScript modules it holds. A
 * directory entry is a whole subtree; `index.ts` is the namespace root itself.
 * An entry holding no module this check can read stays in the reading, with an
 * empty module list, so it is reported rather than passed over.
 */
function routeEntries() {
  const byName = new Map();
  for (const path of filesUnder(ROUTES_DIR)) {
    const [name, ...rest] = posix.relative(ROUTES_DIR, path).split("/");
    const entry = byName.get(name) ?? {
      route: rest.length > 0 ? `${API_PATH_ROOT}/${name}` : routeOfModule(name),
      path: posix.join(ROUTES_DIR, name),
      modules: [],
    };
    if (/\.tsx?$/.test(path)) entry.modules.push(path);
    byName.set(name, entry);
  }
  return [...byName.values()];
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

  it("holds every route directory to the allowlist or the job gate", () => {
    const unaccounted = [];
    for (const entry of entries) {
      if (allowlist.some((prefix) => isUnderPrefix(entry.route, prefix)))
        continue;
      if (entry.modules.length === 0) {
        unaccounted.push(
          `${entry.path}: no TypeScript module this check can read`,
        );
        continue;
      }
      const ungated = entry.modules.filter(
        (module) => !importsFrom(parseFile(module), GATE, GATE_MODULE_TAIL),
      );
      if (ungated.length > 0)
        unaccounted.push(
          `${entry.route} (${entry.path}): ${ungated.join(", ")} ` +
            `${ungated.length === 1 ? "does" : "do"} not import ${GATE}`,
        );
    }
    expect(
      unaccounted,
      `${unaccounted.length} route(s) under ${ROUTES_DIR} are neither in ` +
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
        `route under ${ROUTES_DIR}, or reach past ${API_PATH_ROOT} itself. An ` +
        `entry that matches nothing is dead, and one naming ` +
        `"${API_PATH_ROOT}" admits the whole namespace. Remove it, or point ` +
        `it at the route it was meant for.`,
    ).toEqual([]);
  });
});
