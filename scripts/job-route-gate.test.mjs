import { readFileSync, readdirSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Every HTTP method handler of the console's job API calls gateJobRoute, and
// calls it before anything else in its body.
//
// The gate is what keeps the job API off the public web deployment -- a disabled
// API answers 404, indistinguishable from an unknown route -- and what refuses a
// non-loopback Host and a cross-origin browser request on an API that has no
// per-request auth beyond it. A handler that omits the call is exposed on all
// three counts, and each handler is otherwise pinned only by its own test, so
// one added without the call ships with nothing failing.
// apps/web/src/jobs/routeSupport.ts states the property in prose, and prose
// asserting a code fact rots silently; this is that claim as a check.
//
// It is an INCLUSION check over the directory: the route modules are found by
// walking the routes tree, and the handlers by reading each module's inline
// `handlers` map, so a module or a method nobody thought to list is covered the
// day it lands. There is no allowance list -- every handler gates.
//
// Per HANDLER, not per module: a module-level reading would pass a module that
// gates GET and misses DELETE, and a module here carries up to three methods.
//
// Reach and limits, stated rather than implied.
//
// A handler is a property of an object literal assigned to a property named
// `handlers`, written inline as an arrow function, a function expression, or an
// object-literal method. Anything else -- a `handlers` value that is not an
// object literal, a spread, a handler referenced by name or produced by a
// wrapper -- is reported as a shape the check cannot read rather than passed
// over, and so is a file in the routes tree carrying no `handlers` map at all.
// A new idiom is a failure to answer, never a silent gap.
//
// What it decides about the call is SYNTACTIC. It counts a call to a name the
// module imports as gateJobRoute from a module path ending in `routeSupport`:
// the binding is matched by imported name and specifier, not resolved, so a
// same-named export of some other module would satisfy it. Position is decided
// as "the call appears in the body's first statement" -- the readable proxy for
// "before any filesystem use or spawn", which is not decidable here. A handler
// whose body is a single expression rather than a block has no first statement
// to hold the call and reads as gating late.
//
// What it does NOT decide: that the handler acts on the gate's outcome. A
// handler that calls the gate and discards the short-circuit response it returns
// passes here; the per-route tests are what cover that.

const SELF = "scripts/job-route-gate.test.mjs";

// The routes tree whose every module is a job-API route, and the module
// declaring the gate, both repository-relative.
const ROUTES_DIR = "apps/web/src/routes/api/jobs";
const GATE_MODULE = "apps/web/src/jobs/routeSupport.ts";

// The exported name the route modules import, and the tail every import
// specifier of it must carry.
const GATE = "gateJobRoute";
const GATE_MODULE_TAIL = "routeSupport";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Parse a TypeScript source file with parent pointers, for ancestor walks. */
function parseSource(fileName, text) {
  return ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

/** Parse a repository-relative source file as this checkout ships it. */
function parseFile(file) {
  return parseSource(file, readFileSync(resolve(root, file), "utf8"));
}

/** Every descendant of `node`, in source order. */
function descendants(node) {
  const found = [];
  const visit = (child) => {
    found.push(child);
    ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
  return found;
}

/** Every TypeScript source under `dir`, repository-relative and sorted. */
function routeModules(dir = ROUTES_DIR) {
  const found = [];
  for (const entry of readdirSync(resolve(root, dir), {
    withFileTypes: true,
  })) {
    const path = posix.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...routeModules(path));
    else if (/\.tsx?$/.test(entry.name)) found.push(path);
  }
  return found.sort();
}

/**
 * The local names a module binds to the gate: the aliases of a `gateJobRoute`
 * named import from a specifier naming the routeSupport module.
 */
function gateBindings(sourceFile) {
  const names = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(specifier)) continue;
    if (!specifier.text.endsWith(GATE_MODULE_TAIL)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements)
      if ((element.propertyName ?? element.name).text === GATE)
        names.add(element.name.text);
  }
  return names;
}

/**
 * The handlers a module declares, one entry per HTTP method: `{ file, method,
 * body }` for a shape the check reads, `{ file, method, unreadable }` for one it
 * does not. A `handlers` property whose value is not an object literal is a
 * single unreadable entry for the map itself.
 */
function declaredHandlers(sourceFile) {
  const file = sourceFile.fileName;
  const handlers = [];
  for (const node of descendants(sourceFile)) {
    if (!ts.isPropertyAssignment(node)) continue;
    if (node.name.getText() !== "handlers") continue;
    const map = node.initializer;
    if (!ts.isObjectLiteralExpression(map)) {
      handlers.push({
        file,
        method: "(the whole map)",
        unreadable: `a \`handlers\` value written as ${ts.SyntaxKind[map.kind]} rather than an object literal`,
      });
      continue;
    }
    for (const property of map.properties) {
      if (ts.isMethodDeclaration(property)) {
        handlers.push({
          file,
          method: property.name.getText(),
          body: property.body,
        });
        continue;
      }
      if (!ts.isPropertyAssignment(property)) {
        handlers.push({
          file,
          method: property.name?.getText() ?? "(unnamed)",
          unreadable: `a handler entry written as ${ts.SyntaxKind[property.kind]}`,
        });
        continue;
      }
      const value = property.initializer;
      if (!ts.isArrowFunction(value) && !ts.isFunctionExpression(value)) {
        handlers.push({
          file,
          method: property.name.getText(),
          unreadable: `a handler written as ${ts.SyntaxKind[value.kind]} rather than inline`,
        });
        continue;
      }
      handlers.push({
        file,
        method: property.name.getText(),
        body: value.body,
      });
    }
  }
  return handlers;
}

/** Whether `node` or a descendant of it calls one of `bindings`. */
function callsTheGate(node, bindings) {
  if (node === undefined) return false;
  const isGateCall = (child) =>
    ts.isCallExpression(child) &&
    ts.isIdentifier(child.expression) &&
    bindings.has(child.expression.text);
  return isGateCall(node) || descendants(node).some(isGateCall);
}

/** Whether the gate call sits in the first statement of a handler's block. */
function gatesFirst(body, bindings) {
  if (body === undefined || !ts.isBlock(body)) return false;
  const first = body.statements[0];
  return first !== undefined && callsTheGate(first, bindings);
}

/** `path METHOD`, the way a failure names a handler. */
function describeHandler(handler) {
  return `${handler.file} ${handler.method}`;
}

/** Read a routes tree into its modules, their handlers, and their gate calls. */
function readRoutes(modules, parse = parseFile) {
  const readings = [];
  for (const file of modules) {
    const sourceFile = parse(file);
    const bindings = gateBindings(sourceFile);
    readings.push({
      file,
      handlers: declaredHandlers(sourceFile).map((handler) => ({
        ...handler,
        gated: handler.unreadable
          ? undefined
          : callsTheGate(handler.body, bindings),
        gatedFirst: handler.unreadable
          ? undefined
          : gatesFirst(handler.body, bindings),
      })),
    });
  }
  return readings;
}

/** The handlers of every module in a reading, flattened. */
function allHandlers(readings) {
  return readings.flatMap((reading) => reading.handlers);
}

/** What a reading could not read: a module with no map, a handler with no body. */
function unreadableIn(readings) {
  return [
    ...readings
      .filter((reading) => reading.handlers.length === 0)
      .map(
        (reading) =>
          `${reading.file}: no inline \`handlers\` map, so no handler of it is checked`,
      ),
    ...allHandlers(readings)
      .filter((handler) => handler.unreadable)
      .map((handler) => `${describeHandler(handler)}: ${handler.unreadable}`),
  ];
}

const modules = routeModules();
const readings = readRoutes(modules);
const handlers = allHandlers(readings);

describe("every job-API route handler is gated", () => {
  it("finds the route modules and the gate they are read against", () => {
    // A rot guard: a routes move, a rename of the gate, or an extraction of the
    // handlers behind a helper would otherwise empty the enumeration and make
    // every assertion below vacuous.
    expect(modules.length).toBeGreaterThan(0);
    expect(handlers.length).toBeGreaterThanOrEqual(modules.length);
    const exported = parseFile(GATE_MODULE).statements.some(
      (statement) =>
        ts.isFunctionDeclaration(statement) &&
        statement.name?.text === GATE &&
        statement.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
        ),
    );
    expect(
      exported,
      `${GATE_MODULE} no longer exports ${GATE}. Every handler below is read ` +
        `against that name, so the rename has to reach ${SELF} too.`,
    ).toBe(true);
  });

  it("reads every handler of every module in the routes tree", () => {
    const unreadable = unreadableIn(readings);
    expect(
      unreadable,
      `${unreadable.length} route handler shape(s) under ${ROUTES_DIR} are ` +
        `shapes this check cannot read, so it cannot say whether they call ` +
        `${GATE}. Write the handler inline in the module's \`handlers\` map, ` +
        `or teach ${SELF} the new idiom.`,
    ).toEqual([]);
  });

  it("calls the gate from every handler", () => {
    const ungated = handlers
      .filter((handler) => handler.gated === false)
      .map(describeHandler);
    expect(
      ungated,
      `${ungated.length} job-API handler(s) never call ${GATE}, so a public ` +
        `deployment serves them instead of 404ing, and neither the loopback ` +
        `Host allowlist nor the cross-origin browser check runs before their ` +
        `side effects. Open each with ${GATE} and return its short-circuit ` +
        `response.`,
    ).toEqual([]);
  });

  it("calls the gate before anything else in the handler", () => {
    const late = handlers
      .filter((handler) => handler.gated === true && !handler.gatedFirst)
      .map(describeHandler);
    expect(
      late,
      `${late.length} job-API handler(s) call ${GATE} somewhere other than ` +
        `their first statement, so work runs ahead of the gate -- a ` +
        `filesystem read or a spawn there happens on a request the gate would ` +
        `have refused. Move the call to the top of the handler body.`,
    ).toEqual([]);
  });

  it("reports a handler its module's siblings gate and it does not", () => {
    // The defect this check exists for, pinned against a source of its own: a
    // module in the routes' own idiom whose GET gates, whose DELETE does not,
    // and whose PUT gates only after reading the filesystem. A per-module
    // reading passes all three.
    const sources = {
      "added/route.ts": `import { createFileRoute } from "@tanstack/react-router";
         import { gateJobRoute } from "@jobs/routeSupport";
         export const Route = createFileRoute("/api/jobs/added/")({
           server: {
             handlers: {
               GET: ({ request }) => {
                 const gate = gateJobRoute(request);
                 if (gate.kind === "response") return gate.response;
                 return jobJsonResponse(gate.manager.added());
               },
               PUT: async ({ request }) => {
                 const listing = await readdir(useJobInputDir());
                 const gate = gateJobRoute(request);
                 if (gate.kind === "response") return gate.response;
                 return jobJsonResponse(listing);
               },
               DELETE: () => {
                 rmSync(useJobInputDir(), { recursive: true });
                 return jobEmptyResponse(204);
               },
             },
           },
         });`,
    };
    const added = readRoutes(Object.keys(sources), (file) =>
      parseSource(file, sources[file]),
    );
    expect(
      allHandlers(added).map(
        (handler) =>
          `${handler.method}: ` +
          (!handler.gated ? "ungated" : handler.gatedFirst ? "first" : "late"),
      ),
    ).toEqual(["GET: first", "PUT: late", "DELETE: ungated"]);
  });

  it("reports the shapes it cannot read rather than passing them", () => {
    // The fail-closed direction, pinned the same way: a handler whose body the
    // check never sees is named, not skipped. Silence on any of these would be
    // the check reporting a clean tree it did not read.
    const sources = {
      "named/route.ts": `export const Route = createFileRoute("/api/jobs/named/")({
           server: { handlers: { GET: readNamedJob, ...sharedHandlers } },
         });`,
      "built/route.ts": `export const Route = createFileRoute("/api/jobs/built/")({
           server: { handlers: buildJobHandlers() },
         });`,
      "none/helper.ts": `export function useNamedJob() { return null; }`,
    };
    expect(
      unreadableIn(
        readRoutes(Object.keys(sources), (file) =>
          parseSource(file, sources[file]),
        ),
      ),
    ).toEqual([
      "none/helper.ts: no inline `handlers` map, so no handler of it is checked",
      "named/route.ts GET: a handler written as Identifier rather than inline",
      "named/route.ts (unnamed): a handler entry written as SpreadAssignment",
      "built/route.ts (the whole map): a `handlers` value written as CallExpression rather than an object literal",
    ]);
  });
});
