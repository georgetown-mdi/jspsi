import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  descendants,
  parseFile,
  parseSource,
  sourceModules,
} from "./lib/typeScriptSources.mjs";

// Every HTTP method handler of the console's job API calls gateJobRoute, calls
// it before anything else in its body, and returns the refusal it yields.
//
// The gate is what keeps the job API off the public web deployment -- a disabled
// API answers 404, indistinguishable from an unknown route -- and what refuses a
// non-loopback Host and a cross-origin browser request on an API that has no
// per-request auth beyond it. A handler that omits the call, and a handler that
// makes the call and drops the refusal in its outcome, are exposed on all three
// counts alike, and each handler is otherwise pinned only by its own test, so
// one added in either shape ships with nothing failing.
// apps/web/src/jobs/routeSupport.ts states the property in prose, and prose
// asserting a code fact rots silently; this is that claim as a check.
//
// It is an INCLUSION check over the directory: the route modules are found by
// walking the routes tree, and the handlers by reading each module's inline
// `handlers` map, so a module or a method nobody thought to list is covered the
// day it lands. There is no allowance list -- every handler gates.
//
// Per HANDLER, not per module: a module-level reading would pass a module that
// gates GET and misses DELETE, and a module here has up to three methods.
//
// Reach and limits, stated rather than implied.
//
// A handler is a property of an object literal assigned to a property named
// `handlers`, written inline as an arrow function, a function expression, or an
// object-literal method. Anything else -- a `handlers` value that is not an
// object literal, a spread, a handler referenced by name or produced by a
// wrapper -- is reported as a shape the check cannot read rather than passed
// over, and so is a file in the routes tree holding no `handlers` map at all.
// A new idiom is a failure to answer, never a silent gap.
//
// What it decides about the call is SYNTACTIC. It counts a call to a name the
// module imports as gateJobRoute from a module path ending in `routeSupport`:
// the binding is matched by imported name and specifier, not resolved, so a
// same-named export of some other module would satisfy it. Position is decided
// as "the call appears in the body's first statement" -- the readable proxy for
// "before any filesystem use or spawn", which is not decidable here. A handler
// whose body is a single expression rather than a block has no first statement
// to hold the call and is treated as gating late.
//
// Obtaining the outcome is not acting on it, so the outcome is read too -- for a
// handler that gates in its first statement, one that does not being already
// named by the position check. The readable shape is the routes' own: the first
// statement binds the whole call to a name, and the statement that FOLLOWS it
// tests that name's discriminant against one of the outcome type's kinds and
// leaves the handler on the refusing side -- a `return` or a `throw`, written
// directly, at the end of a block, or on both sides of a nested `if`. Either
// polarity is read (`=== "response"` and `!== "manager"` alike), which rests on
// the outcome union having exactly two kinds; the rot guard below fails if it
// grows a third.
//
// The success-first guard clause is that shape with its refusing side left
// implicit: the test's own branch takes the passing kind and exits, and the
// refusal is whatever the handler falls through to. It is treated as acting
// when BOTH exit -- the branch, which is what makes the rest of the body the
// refusing path alone, and that rest, treated as an `else` block would be.
//
// A handler is DECIDED to ignore the refusal when it discards the call's value,
// when nothing follows the call, when the statement that follows does not test
// the outcome's discriminant, when an explicit refusing branch falls through
// into the rest of the body, or when the test is the last statement there and so
// the refusing side runs off the end of the handler. Anything between that and
// the readable shapes -- a destructured binding, a guard behind a helper
// predicate, a `switch`, a ternary, a fall-through refusal this check does not
// read as leaving the handler, a test whose own branch falls through as well --
// is reported as a shape this check cannot read.
//
// What it still does NOT decide: that the refusing branch returns the gate's own
// response rather than some other refusal, that nothing after the guard uses the
// outcome unsafely, or that a branch leaves the handler by any means other than
// a syntactic `return` or `throw`. The per-route tests are what cover those.

const SELF = "scripts/job-route-gate.test.mjs";

// The routes tree whose every module is a job-API route, and the module
// declaring the gate, both repository-relative.
const ROUTES_DIR = "apps/web/src/routes/api/jobs";
const GATE_MODULE = "apps/web/src/jobs/routeSupport.ts";

// The exported name the route modules import, and the tail every import
// specifier of it must contain.
const GATE = "gateJobRoute";
const GATE_MODULE_TAIL = "routeSupport";

// The gate's outcome type, the property discriminating its arms, and the kind
// whose arm holds the refusal a handler has to return.
const OUTCOME_TYPE = "GateOutcome";
const DISCRIMINANT = "kind";
const REFUSING_KIND = "response";

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

/** Whether `node` is itself a call to one of `bindings`. */
function isGateCall(node, bindings) {
  return (
    node !== undefined &&
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    bindings.has(node.expression.text)
  );
}

/** Whether `node` or a descendant of it calls one of `bindings`. */
function callsTheGate(node, bindings) {
  if (node === undefined) return false;
  return (
    isGateCall(node, bindings) ||
    descendants(node).some((child) => isGateCall(child, bindings))
  );
}

/** Whether the gate call sits in the first statement of a handler's block. */
function gatesFirst(body, bindings) {
  if (body === undefined || !ts.isBlock(body)) return false;
  const first = body.statements[0];
  return first !== undefined && callsTheGate(first, bindings);
}

/**
 * The discriminant kinds the gate's outcome type declares, in source order: the
 * string literal typing each union arm's discriminant property. Empty for
 * anything but a union of object types discriminated by a string literal, which
 * is the shape the guards below are decided against.
 */
function outcomeKinds(sourceFile) {
  const alias = sourceFile.statements.find(
    (statement) =>
      ts.isTypeAliasDeclaration(statement) &&
      statement.name.text === OUTCOME_TYPE,
  );
  if (alias === undefined || !ts.isUnionTypeNode(alias.type)) return [];
  const kinds = [];
  for (const arm of alias.type.types) {
    if (!ts.isTypeLiteralNode(arm)) continue;
    for (const member of arm.members) {
      if (!ts.isPropertySignature(member)) continue;
      if (member.name.getText() !== DISCRIMINANT) continue;
      const type = member.type;
      if (
        type !== undefined &&
        ts.isLiteralTypeNode(type) &&
        ts.isStringLiteral(type.literal)
      )
        kinds.push(type.literal.text);
    }
  }
  return kinds;
}

const OUTCOME_KINDS = outcomeKinds(parseFile(GATE_MODULE));

/** A node's source text on one line, for a failure message. */
function oneLine(node) {
  return node.getText().replace(/\s+/g, " ");
}

/** Whether `node` reads the discriminant of the outcome bound to `name`. */
function readsDiscriminant(node, name) {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === name &&
    node.name.text === DISCRIMINANT
  );
}

/** Whether `node` or a descendant of it satisfies `predicate`. */
function anyNode(node, predicate) {
  return predicate(node) || descendants(node).some(predicate);
}

/**
 * Whether `statement` leaves the handler on every path: a `return` or a `throw`,
 * written directly, as the last statement of a block, or on both sides of a
 * nested `if`. An absent statement (a missing `else`) leaves the handler running.
 */
function exitsHandler(statement) {
  if (statement === undefined) return false;
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement))
    return true;
  if (ts.isBlock(statement)) return exitsHandler(statement.statements.at(-1));
  if (ts.isIfStatement(statement))
    return (
      exitsHandler(statement.thenStatement) &&
      exitsHandler(statement.elseStatement)
    );
  return false;
}

/**
 * Which branch of an `if` runs when the outcome bound to `name` is the refusing
 * kind -- `"then"` or `"else"` -- or null when the condition is not a strict
 * comparison of that outcome's discriminant against one of {@link OUTCOME_KINDS}.
 * Reading the inverted polarity (`!== "manager"`) rests on the union having
 * exactly two kinds, which the rot guard pins.
 */
function refusingBranch(condition, name) {
  if (!ts.isBinaryExpression(condition)) return null;
  const operator = condition.operatorToken.kind;
  const equals = operator === ts.SyntaxKind.EqualsEqualsEqualsToken;
  if (!equals && operator !== ts.SyntaxKind.ExclamationEqualsEqualsToken)
    return null;
  for (const [access, literal] of [
    [condition.left, condition.right],
    [condition.right, condition.left],
  ]) {
    if (!readsDiscriminant(access, name)) continue;
    if (!ts.isStringLiteral(literal) || !OUTCOME_KINDS.includes(literal.text))
      return null;
    const trueMeansRefused = equals
      ? literal.text === REFUSING_KIND
      : literal.text !== REFUSING_KIND;
    return trueMeansRefused ? "then" : "else";
  }
  return null;
}

/**
 * The name the handler's first statement binds the gate's outcome to:
 * `{ name }`, `{ discarded: true }` for a call whose value goes nowhere, or
 * `{ unreadable }` for a binding shape the outcome cannot be followed through.
 * Called only for a handler whose first statement holds the gate call.
 */
function boundOutcome(first, bindings) {
  if (ts.isExpressionStatement(first) && isGateCall(first.expression, bindings))
    return { discarded: true };
  if (!ts.isVariableStatement(first))
    return {
      unreadable:
        `a gate call inside a first statement written as ` +
        `${ts.SyntaxKind[first.kind]} rather than bound by a declaration, so ` +
        `its outcome cannot be followed`,
    };
  const declarations = first.declarationList.declarations;
  if (declarations.length !== 1)
    return {
      unreadable:
        `a first statement binding ${declarations.length} names, so which one ` +
        `holds the gate's outcome is ambiguous`,
    };
  const [declaration] = declarations;
  if (!isGateCall(declaration.initializer, bindings))
    return {
      unreadable:
        `a gate call nested inside the initializer of ` +
        `\`${oneLine(declaration.name)}\` rather than bound whole to it`,
    };
  if (!ts.isIdentifier(declaration.name))
    return {
      unreadable:
        `a gate outcome destructured into \`${oneLine(declaration.name)}\` ` +
        `rather than bound to a name`,
    };
  return { name: declaration.name.text };
}

/**
 * How a handler treats the outcome it obtained: `{ acted: true }`, `{ acted:
 * false, reason }` for one decided to ignore the refusal, or `{ unreadable }`.
 * Called only for a handler whose first statement holds the gate call.
 */
function readOutcome(body, bindings) {
  const bound = boundOutcome(body.statements[0], bindings);
  if (bound.unreadable !== undefined) return { unreadable: bound.unreadable };
  if (bound.discarded === true)
    return {
      acted: false,
      reason: "the gate's outcome is discarded rather than bound to a name",
    };
  const name = bound.name;
  const next = body.statements[1];
  if (next === undefined)
    return {
      acted: false,
      reason:
        "the gate call is the handler's only statement, so its refusal is " +
        "never returned",
    };
  // A handler that tests the outcome further down still runs whatever precedes
  // that test on a refused request, so it is reported here rather than passed.
  const untested = {
    acted: false,
    reason: body.statements
      .slice(2)
      .some((statement) =>
        anyNode(statement, (node) => readsDiscriminant(node, name)),
      )
      ? `\`${name}.${DISCRIMINANT}\` is tested only after other statements have run`
      : `the statement after the gate call does not test \`${name}.${DISCRIMINANT}\``,
  };
  if (!ts.isIfStatement(next))
    return anyNode(next, (node) => readsDiscriminant(node, name))
      ? {
          unreadable:
            `an outcome test inside a ${ts.SyntaxKind[next.kind]} rather than ` +
            `an \`if\` following the gate call`,
        }
      : untested;
  const branch = refusingBranch(next.expression, name);
  if (branch === null)
    return anyNode(
      next.expression,
      (node) => ts.isIdentifier(node) && node.text === name,
    )
      ? {
          unreadable:
            `an outcome guard \`${oneLine(next.expression)}\` this check ` +
            `cannot read as a \`${DISCRIMINANT}\` comparison`,
        }
      : untested;
  const refusingSide =
    branch === "then" ? next.thenStatement : next.elseStatement;
  const fallsThrough = {
    acted: false,
    reason:
      `the branch taken when \`${name}.${DISCRIMINANT}\` is ` +
      `"${REFUSING_KIND}" does not return or throw`,
  };
  if (refusingSide !== undefined)
    return exitsHandler(refusingSide) ? { acted: true } : fallsThrough;
  // The refusing side is the `else` the guard clause leaves implicit, so the
  // refusal is what the handler falls through to. Reading the rest of the body
  // as that branch's block holds only while the test's own branch exits: a
  // branch that falls through too leaves the remainder serving both kinds.
  const afterTest = body.statements.slice(2).at(-1);
  if (afterTest === undefined) return fallsThrough;
  if (!exitsHandler(next.thenStatement))
    return {
      unreadable:
        `an outcome test whose own branch falls through as well, so what ` +
        `follows it runs on a refusal and on a pass alike`,
    };
  if (!exitsHandler(afterTest))
    return {
      unreadable:
        `a refusing side that falls through the outcome test into a trailing ` +
        `${ts.SyntaxKind[afterTest.kind]}, which this check does not read as ` +
        `returning or throwing`,
    };
  return { acted: true };
}

/** `path METHOD`, the way a failure names a handler. */
function describeHandler(handler) {
  return `${handler.file} ${handler.method}`;
}

/** How a handler's outcome reading came out, the way a fixture pins it. */
function describeOutcome(outcome) {
  if (outcome === undefined) return "(not read)";
  if (outcome.unreadable !== undefined)
    return `unreadable: ${outcome.unreadable}`;
  return outcome.acted ? "acts" : outcome.reason;
}

/**
 * Read a routes tree into its modules, their handlers, their gate calls, and
 * what each handler does with the outcome. The outcome is read only for a
 * handler that gates in its first statement: for any other, the reading has no
 * call to follow from there, and the position tests below already name it.
 */
function readRoutes(modules, parse = parseFile) {
  const readings = [];
  for (const file of modules) {
    const sourceFile = parse(file);
    const bindings = gateBindings(sourceFile);
    readings.push({
      file,
      handlers: declaredHandlers(sourceFile).map((handler) => {
        if (handler.unreadable) return handler;
        const gatedFirst = gatesFirst(handler.body, bindings);
        return {
          ...handler,
          gated: callsTheGate(handler.body, bindings),
          gatedFirst,
          outcome: gatedFirst ? readOutcome(handler.body, bindings) : undefined,
        };
      }),
    });
  }
  return readings;
}

/** The handlers of every module in a reading, flattened. */
function allHandlers(readings) {
  return readings.flatMap((reading) => reading.handlers);
}

/**
 * What a reading could not read: a module with no map, a handler with no body,
 * a handler whose treatment of the gate's outcome is written in a shape the
 * outcome reading does not decide.
 */
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
    ...allHandlers(readings)
      .filter((handler) => handler.outcome?.unreadable !== undefined)
      .map(
        (handler) =>
          `${describeHandler(handler)}: ${handler.outcome.unreadable}`,
      ),
  ];
}

const modules = sourceModules(ROUTES_DIR);
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
    const twoKinds =
      OUTCOME_KINDS.length === 2 && OUTCOME_KINDS.includes(REFUSING_KIND);
    expect(
      twoKinds,
      `${GATE_MODULE} declares ${OUTCOME_TYPE} over ` +
        `[${OUTCOME_KINDS.join(", ")}] rather than the two kinds, one of them ` +
        `"${REFUSING_KIND}", that the outcome guards below are decided ` +
        `against: reading an inverted guard rests on the other kind meaning ` +
        `"not refused", which a third arm breaks. Teach ${SELF} the new union.`,
    ).toBe(true);
  });

  it("reads every handler of every module in the routes tree", () => {
    const unreadable = unreadableIn(readings);
    expect(
      unreadable,
      `${unreadable.length} route handler shape(s) under ${ROUTES_DIR} are ` +
        `shapes this check cannot read, so it cannot say whether they call ` +
        `${GATE} and return the refusal it yields. Write the handler inline in ` +
        `the module's \`handlers\` map, guard it in the routes' own idiom, or ` +
        `teach ${SELF} the new one.`,
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

  it("returns the gate's refusal from every handler", () => {
    const ignoring = handlers
      .filter((handler) => handler.outcome?.acted === false)
      .map(
        (handler) => `${describeHandler(handler)}: ${handler.outcome.reason}`,
      );
    expect(
      ignoring,
      `${ignoring.length} job-API handler(s) obtain the ${GATE} outcome and ` +
        `never return the refusal in it, so a request the gate refused -- on a ` +
        `public deployment, from a non-loopback Host, from a cross-origin page ` +
        `-- is served anyway, and the call reads as a gate that is not one. ` +
        `Follow the call with \`if (outcome.${DISCRIMINANT} === ` +
        `"${REFUSING_KIND}") return outcome.${REFUSING_KIND};\`.`,
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

  it("reports a handler that obtains the outcome and drops the refusal", () => {
    // The other half of the same defect, pinned against sources of its own: a
    // module whose handlers all call the gate in their first statement -- so
    // every check above passes -- and act on what it returned in the routes'
    // idiom, in the inverted and else-side polarities, or not at all.
    const sources = {
      "acting/route.ts": `import { gateJobRoute } from "@jobs/routeSupport";
         export const Route = createFileRoute("/api/jobs/acting/")({
           server: {
             handlers: {
               GET: ({ request }) => {
                 const gate = gateJobRoute(request);
                 if (gate.kind === "response") return gate.response;
                 return jobJsonResponse(gate.manager.added());
               },
               PUT: ({ request }) => {
                 const gate = gateJobRoute(request);
                 if (gate.kind !== "manager") {
                   log.warn("refused");
                   return gate.response;
                 }
                 return jobEmptyResponse(204);
               },
               POST: ({ request }) => {
                 const gate = gateJobRoute(request);
                 if (gate.kind === "manager") {
                   return jobJsonResponse(gate.manager.added());
                 } else return gate.response;
               },
             },
           },
         });`,
      "dropping/route.ts": `import { gateJobRoute } from "@jobs/routeSupport";
         export const Route = createFileRoute("/api/jobs/dropping/")({
           server: {
             handlers: {
               GET: ({ request }) => {
                 const gate = gateJobRoute(request);
                 return jobJsonResponse(gate.manager.added());
               },
               PUT: ({ request }) => {
                 const gate = gateJobRoute(request);
                 if (gate.kind === "response") log.warn("refused");
                 return jobJsonResponse(gate.manager.added());
               },
               POST: ({ request }) => {
                 const gate = gateJobRoute(request);
                 if (gate.kind === "manager") return jobEmptyResponse(204);
               },
               PATCH: ({ request }) => {
                 const gate = gateJobRoute(request);
                 const listing = readdirSync(useJobInputDir());
                 if (gate.kind === "response") return gate.response;
                 return jobJsonResponse(listing);
               },
               DELETE: ({ request }) => {
                 gateJobRoute(request);
                 return jobEmptyResponse(204);
               },
               HEAD: ({ request }) => {
                 const gate = gateJobRoute(request);
               },
             },
           },
         });`,
    };
    const read = readRoutes(Object.keys(sources), (file) =>
      parseSource(file, sources[file]),
    );
    expect(
      allHandlers(read).map(
        (handler) => `${handler.method}: ${describeOutcome(handler.outcome)}`,
      ),
    ).toEqual([
      "GET: acts",
      "PUT: acts",
      "POST: acts",
      "GET: the statement after the gate call does not test `gate.kind`",
      'PUT: the branch taken when `gate.kind` is "response" does not return or throw',
      'POST: the branch taken when `gate.kind` is "response" does not return or throw',
      "PATCH: `gate.kind` is tested only after other statements have run",
      "DELETE: the gate's outcome is discarded rather than bound to a name",
      "HEAD: the gate call is the handler's only statement, so its refusal is never returned",
    ]);
  });

  it("reads a guard clause whose refusal is the fall-through", () => {
    // The same idiom written success-first, in both polarities: the handler's
    // own branch takes the passing kind and returns, and the refusal is the
    // statement it falls through to. That gates as completely as the explicit
    // form, so it is read as acting rather than reported as a branch that does
    // not return -- but only while the passing branch exits, since a test both
    // of whose sides fall through leaves what follows serving a refused request
    // too.
    const sources = {
      "guarding/route.ts": `import { gateJobRoute } from "@jobs/routeSupport";
         export const Route = createFileRoute("/api/jobs/guarding/")({
           server: {
             handlers: {
               GET: ({ request }) => {
                 const gate = gateJobRoute(request);
                 if (gate.kind === "manager") {
                   return jobJsonResponse(gate.manager.added());
                 }
                 return gate.response;
               },
               PUT: ({ request }) => {
                 const gate = gateJobRoute(request);
                 if (gate.kind !== "response") {
                   return jobEmptyResponse(204);
                 }
                 return gate.response;
               },
               POST: ({ request }) => {
                 const gate = gateJobRoute(request);
                 if (gate.kind === "manager") {
                   return jobJsonResponse(gate.manager.added());
                 }
                 log.warn("refused");
               },
               PATCH: ({ request }) => {
                 const gate = gateJobRoute(request);
                 if (gate.kind === "manager") {
                   log.info("served");
                 }
                 return jobEmptyResponse(204);
               },
             },
           },
         });`,
    };
    const read = readRoutes(Object.keys(sources), (file) =>
      parseSource(file, sources[file]),
    );
    expect(
      allHandlers(read).map(
        (handler) => `${handler.method}: ${describeOutcome(handler.outcome)}`,
      ),
    ).toEqual([
      "GET: acts",
      "PUT: acts",
      "POST: unreadable: a refusing side that falls through the outcome test into a trailing ExpressionStatement, which this check does not read as returning or throwing",
      "PATCH: unreadable: an outcome test whose own branch falls through as well, so what follows it runs on a refusal and on a pass alike",
    ]);
    // The unread remainder is a shape the check cannot read, never a violation
    // it did not establish: both land in the reading's unreadable list.
    expect(unreadableIn(read)).toEqual([
      "guarding/route.ts POST: a refusing side that falls through the outcome test into a trailing ExpressionStatement, which this check does not read as returning or throwing",
      "guarding/route.ts PATCH: an outcome test whose own branch falls through as well, so what follows it runs on a refusal and on a pass alike",
    ]);
  });

  it("reports an outcome shape it cannot read rather than passing it", () => {
    // The fail-closed direction for the outcome: a handler that gates and then
    // treats what it got in an idiom this check does not decide is named, not
    // waved through as acting.
    const sources = {
      "bound/route.ts": `import { gateJobRoute } from "@jobs/routeSupport";
         export const Route = createFileRoute("/api/jobs/bound/")({
           server: {
             handlers: {
               GET: ({ request }) => {
                 const { kind, response } = gateJobRoute(request);
                 if (kind === "response") return response;
                 return jobEmptyResponse(204);
               },
               PUT: ({ request }) => {
                 const gate = withTiming(gateJobRoute(request));
                 if (gate.kind === "response") return gate.response;
                 return jobEmptyResponse(204);
               },
               POST: ({ request }) => {
                 const gate = gateJobRoute(request),
                   dir = useJobInputDir();
                 if (gate.kind === "response") return gate.response;
                 return jobJsonResponse(dir);
               },
               DELETE: ({ request }) => {
                 if (gateJobRoute(request).kind === "response")
                   return jobEmptyResponse(404);
                 return jobEmptyResponse(204);
               },
             },
           },
         });`,
      "guarded/route.ts": `import { gateJobRoute } from "@jobs/routeSupport";
         export const Route = createFileRoute("/api/jobs/guarded/")({
           server: {
             handlers: {
               GET: ({ request }) => {
                 const gate = gateJobRoute(request);
                 if (isRefusal(gate)) return gate.response;
                 return jobEmptyResponse(204);
               },
               PUT: ({ request }) => {
                 const gate = gateJobRoute(request);
                 switch (gate.kind) {
                   case "response":
                     return gate.response;
                   default:
                     return jobEmptyResponse(204);
                 }
               },
               POST: ({ request }) => {
                 const gate = gateJobRoute(request);
                 return gate.kind === "response"
                   ? gate.response
                   : jobEmptyResponse(204);
               },
             },
           },
         });`,
    };
    expect(
      unreadableIn(
        readRoutes(Object.keys(sources), (file) =>
          parseSource(file, sources[file]),
        ),
      ),
    ).toEqual([
      "bound/route.ts GET: a gate outcome destructured into `{ kind, response }` rather than bound to a name",
      "bound/route.ts PUT: a gate call nested inside the initializer of `gate` rather than bound whole to it",
      "bound/route.ts POST: a first statement binding 2 names, so which one holds the gate's outcome is ambiguous",
      "bound/route.ts DELETE: a gate call inside a first statement written as IfStatement rather than bound by a declaration, so its outcome cannot be followed",
      "guarded/route.ts GET: an outcome guard `isRefusal(gate)` this check cannot read as a `kind` comparison",
      "guarded/route.ts PUT: an outcome test inside a SwitchStatement rather than an `if` following the gate call",
      "guarded/route.ts POST: an outcome test inside a ReturnStatement rather than an `if` following the gate call",
    ]);
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
