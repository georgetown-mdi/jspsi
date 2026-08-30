import { readdirSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";

import {
  descendants,
  parseFile,
  parseSource,
} from "./lib/typeScriptSources.mjs";

// A test that cannot run on this host says so as a skip, not as an early
// `return` from its body.
//
// A body that returns before its first assertion still reports PASSED, so a leg
// that never ran is counted as coverage. `scripts/lib/skippedLegReporter.mjs`
// exists to make exactly that visible -- it names every skipped test at the end
// of a run -- and an early return routes around it: there is no skip for it to
// report. `test.skipIf` / `describe.skipIf` put the same condition where vitest
// can see it, so the leg is counted and named instead.
//
// The rule is about the hosts the suites are RUN on, which is what makes the
// vacuous pass reachable rather than hypothetical: every workflow that runs
// vitest runs it on `ubuntu-latest`, and a developer host is Linux or macOS. A
// gate that returns early when the platform is `linux` or `darwin` is therefore
// one somebody's green run is already counting, and this check fails on it.
//
// The inverse gate -- `if (process.platform === "win32") return;`, a POSIX
// assertion whose Windows branch has nothing to compare against -- returns early
// on neither of those hosts. It is the same shape and would report a vacuous
// pass on a Windows host; that it is left standing is a scope decision, not a
// finding that it is correct.
//
// Reach and limits, stated rather than implied.
//
// It walks every test module in the repository -- `*.test.{ts,tsx,mts,mjs}`
// outside the directories below -- rather than a maintained list, so a new suite
// is covered the day it lands. There is no allowance list.
//
// A gate is an `if` whose then-branch holds a `return` and which sits inside a
// callback passed to `test`, `it`, `describe`, `suite`, or `bench`, or to a
// chain rooted at one of those, so `test.each(...)(...)` is read. An early
// return anywhere else -- a module-level helper, a hook -- is not a test's own
// exit and is not read.
//
// The platform is decided from `process.platform` written literally, and from a
// module-scope `const` whose initializer reaches it, resolved through further
// such consts. A platform read written any other way -- `os.platform()`, a
// destructured `const { platform } = process`, a value imported from another
// module -- is not seen at all, and so is not reported. That is the reach;
// nothing here fails closed on a spelling it does not know.
//
// A condition it does see but cannot evaluate is reported as unreadable rather
// than passed over. The evaluable forms are `process.platform` compared against
// a string literal with `===` or `!==`, those combined with `&&`, `||`, `!` and
// parentheses, and an identifier bound to one of those. Anything else -- a
// `startsWith`, a ternary, a call -- is a failure to answer.
//
// Where the reading errs it errs toward over-reporting: a `return` written
// inside a nested function in the then-branch counts as the gate's exit, so a
// gate whose branch does not actually leave the test would be reported. That
// direction costs a spurious failure to be answered, never a miss.

const SELF = "scripts/platform-gate-skips.test.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Directories carrying no test module of this repository's own.
const NOT_WALKED = new Set([
  ".git",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "research",
  "scratch",
]);

// The hosts the suites are run on, and so the hosts on which an early return
// reports a pass nobody is told about.
const RUN_ON = ["linux", "darwin"];

// The names whose call carries a test body as a callback argument.
const RUNNERS = new Set(["test", "it", "describe", "suite", "bench"]);

// Floors the walk has to clear. A move of the test trees, a rename of the
// suffix, or a reading that stopped recognising how a test is declared would
// otherwise empty the enumeration and leave every assertion below vacuous --
// which is the failure this check exists to catch.
const TEST_MODULE_FLOOR = 300;
const TEST_DECLARATION_FLOOR = 2000;

// Parsing the whole tree costs a few seconds, which is the wrong scale for
// vitest's 5s default on the case that happens to run first.
const WALK_TIMEOUT_MS = 120_000;

/**
 * Every test module of this repository, repository-relative and sorted. Which
 * tree to walk is this check's own claim, not the shared reader's.
 */
export function testModules(dir = ".") {
  const found = [];
  for (const entry of readdirSync(resolve(REPO_ROOT, dir), {
    withFileTypes: true,
  })) {
    if (NOT_WALKED.has(entry.name)) continue;
    const path = dir === "." ? entry.name : posix.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...testModules(path));
    else if (/\.test\.(m?tsx?|m?js)$/.test(entry.name)) found.push(path);
  }
  return found.sort();
}

/** Whether `node` is the expression `process.platform`. */
function readsPlatform(node) {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "process" &&
    node.name.text === "platform"
  );
}

/** The runner name a call is rooted at, or null for a call that is not one. */
function runnerOfCall(call) {
  let callee = call.expression;
  while (ts.isCallExpression(callee) || ts.isPropertyAccessExpression(callee))
    callee = callee.expression;
  return ts.isIdentifier(callee) && RUNNERS.has(callee.text)
    ? callee.text
    : null;
}

/**
 * Every test a module declares: a runner call carrying a function argument. The
 * enumeration the gate reading stands on, counted on its own so a reading that
 * stopped recognising one fails loudly.
 */
export function testDeclarations(sourceFile) {
  return descendants(sourceFile).filter(
    (node) =>
      ts.isCallExpression(node) &&
      runnerOfCall(node) !== null &&
      node.arguments.some(
        (argument) =>
          ts.isArrowFunction(argument) || ts.isFunctionExpression(argument),
      ),
  );
}

/**
 * The module-scope `const` initializers that reach `process.platform`, keyed by
 * the name they are bound to. Built in source order and resolved in it, so a
 * const standing on an earlier one is followed, a name bound to anything else is
 * absent, and no chain can close on itself.
 */
function platformBindings(sourceFile) {
  const bindings = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const { initializer } = declaration;
      if (initializer === undefined || !ts.isIdentifier(declaration.name))
        continue;
      const reaches = [initializer, ...descendants(initializer)].some(
        (node) =>
          readsPlatform(node) ||
          (ts.isIdentifier(node) && bindings.has(node.text)),
      );
      if (reaches) bindings.set(declaration.name.text, initializer);
    }
  }
  return bindings;
}

/** Whether `condition` reaches the platform, and so is this check's business. */
function readsThePlatform(condition, bindings) {
  return [condition, ...descendants(condition)].some(
    (node) =>
      readsPlatform(node) || (ts.isIdentifier(node) && bindings.has(node.text)),
  );
}

/**
 * What `condition` yields on a host reporting `platform`, or null for a shape
 * this check does not evaluate. Null is a failure to answer, never a pass.
 */
export function evaluateForPlatform(condition, platform, bindings) {
  if (ts.isParenthesizedExpression(condition))
    return evaluateForPlatform(condition.expression, platform, bindings);
  if (
    ts.isPrefixUnaryExpression(condition) &&
    condition.operator === ts.SyntaxKind.ExclamationToken
  ) {
    const operand = evaluateForPlatform(condition.operand, platform, bindings);
    return operand === null ? null : !operand;
  }
  if (ts.isIdentifier(condition)) {
    const bound = bindings.get(condition.text);
    return bound === undefined
      ? null
      : evaluateForPlatform(bound, platform, bindings);
  }
  if (!ts.isBinaryExpression(condition)) return null;
  const operator = condition.operatorToken.kind;
  if (
    operator === ts.SyntaxKind.AmpersandAmpersandToken ||
    operator === ts.SyntaxKind.BarBarToken
  ) {
    const left = evaluateForPlatform(condition.left, platform, bindings);
    const right = evaluateForPlatform(condition.right, platform, bindings);
    if (left === null || right === null) return null;
    return operator === ts.SyntaxKind.AmpersandAmpersandToken
      ? left && right
      : left || right;
  }
  const equals = operator === ts.SyntaxKind.EqualsEqualsEqualsToken;
  if (!equals && operator !== ts.SyntaxKind.ExclamationEqualsEqualsToken)
    return null;
  for (const [read, literal] of [
    [condition.left, condition.right],
    [condition.right, condition.left],
  ]) {
    if (!readsPlatform(read)) continue;
    if (!ts.isStringLiteral(literal)) return null;
    return equals ? literal.text === platform : literal.text !== platform;
  }
  return null;
}

/**
 * The test a node sits inside -- its runner and its name -- or null when no
 * enclosing callback is a test body. Every enclosing function is read rather
 * than the nearest, since a gate may sit inside a nested callback of the body.
 */
function enclosingTest(node) {
  for (let parent = node.parent; parent !== undefined; parent = parent.parent) {
    if (!ts.isArrowFunction(parent) && !ts.isFunctionExpression(parent))
      continue;
    const call = parent.parent;
    if (
      call === undefined ||
      !ts.isCallExpression(call) ||
      !call.arguments.includes(parent)
    )
      continue;
    const runner = runnerOfCall(call);
    if (runner === null) continue;
    const [first] = call.arguments;
    return {
      runner,
      name:
        first !== undefined && ts.isStringLiteral(first)
          ? first.text
          : "(a name this check cannot read)",
    };
  }
  return null;
}

/** A node's source text on one line, for a failure message. */
function oneLine(node) {
  return node.getText().replace(/\s+/g, " ");
}

/**
 * Every platform gate a test module declares: `{ file, line, condition, test,
 * vacuousOn }` for one this check evaluated, `{ ..., unreadable: true }` for a
 * condition it saw and could not. `vacuousOn` names the hosts of {@link RUN_ON}
 * the gate returns early on, empty for a gate that runs on both.
 */
export function platformGates(sourceFile) {
  const bindings = platformBindings(sourceFile);
  const gates = [];
  for (const node of descendants(sourceFile)) {
    if (!ts.isIfStatement(node)) continue;
    const exits = [node.thenStatement, ...descendants(node.thenStatement)].some(
      (child) => ts.isReturnStatement(child),
    );
    if (!exits) continue;
    const condition = node.expression;
    if (!readsThePlatform(condition, bindings)) continue;
    const test = enclosingTest(node);
    if (test === null) continue;
    const gate = {
      file: sourceFile.fileName,
      line:
        sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
          .line + 1,
      condition: oneLine(condition),
      test: `${test.runner} ${JSON.stringify(test.name)}`,
    };
    const verdicts = RUN_ON.map((platform) => [
      platform,
      evaluateForPlatform(condition, platform, bindings),
    ]);
    if (verdicts.some(([, verdict]) => verdict === null)) {
      gates.push({ ...gate, unreadable: true });
      continue;
    }
    gates.push({
      ...gate,
      vacuousOn: verdicts
        .filter(([, verdict]) => verdict)
        .map(([platform]) => platform),
    });
  }
  return gates;
}

const modules = testModules();
let declarations = 0;
let gates = [];

// Read once, here, rather than per case: the tree is the same whichever case
// pays for it.
beforeAll(() => {
  for (const file of modules) {
    const sourceFile = parseFile(file);
    declarations += testDeclarations(sourceFile).length;
    gates = gates.concat(platformGates(sourceFile));
  }
}, WALK_TIMEOUT_MS);

describe("a test gated off a host it runs on declares that as a skip", () => {
  it("finds the test modules and the declarations gates are read inside", () => {
    expect(
      modules.length,
      `the walk found ${modules.length} test modules, under the floor of ` +
        `${TEST_MODULE_FLOOR}: the test trees moved, or the suffix ${SELF} ` +
        `matches did. Every assertion below is vacuous until it is pointed at ` +
        `them again.`,
    ).toBeGreaterThanOrEqual(TEST_MODULE_FLOOR);
    expect(
      declarations,
      `the walk found ${declarations} test declarations, under the floor of ` +
        `${TEST_DECLARATION_FLOOR}: what ${SELF} reads as a test no longer ` +
        `matches how the suites declare one, so no gate can be found inside one.`,
    ).toBeGreaterThanOrEqual(TEST_DECLARATION_FLOOR);
  });

  it("evaluates every platform gate it finds", () => {
    const unreadable = gates.filter((gate) => gate.unreadable);
    expect(
      unreadable.map(
        (gate) =>
          `${gate.file}:${gate.line}: \`${gate.condition}\` in ${gate.test}`,
      ),
      `${unreadable.length} platform gate(s) are written in a shape ${SELF} ` +
        `cannot evaluate, so it cannot say whether the test they gate reports ` +
        `a pass on a host that never ran it. Teach it the shape, or write the ` +
        `gate as a comparison of process.platform against a string literal.`,
    ).toEqual([]);
  });

  it("reports no test that returns early on a host the suites run on", () => {
    const vacuous = gates.filter((gate) => (gate.vacuousOn ?? []).length > 0);
    expect(
      vacuous.map(
        (gate) =>
          `${gate.file}:${gate.line}: ${gate.test} returns early on ` +
          `${gate.vacuousOn.join(" and ")} (\`${gate.condition}\`)`,
      ),
      `${vacuous.length} test(s) return from the body on a host the suites are ` +
        `run on, so they report PASSED there having asserted nothing and the ` +
        `skipped-leg reporter has no skip to name. Declare the condition with ` +
        `test.skipIf / describe.skipIf instead.`,
    ).toEqual([]);
  });
});

// What makes the emptiness above evidence: a gate in each shape IS found and
// decided here, so a reading that quietly stopped finding one fails rather than
// passing the tree.
describe("what the gate reading decides", () => {
  const read = (body) => platformGates(parseSource("fixture.test.ts", body));

  it("names a test that returns early on Linux", () => {
    const [gate] = read(
      `test("a", () => {\n  if (process.platform !== "darwin") return;\n});\n`,
    );
    expect(gate.vacuousOn).toEqual(["linux"]);
    expect(gate.test).toBe('test "a"');
    expect(gate.line).toBe(2);
  });

  it("names a test that returns early on macOS", () => {
    const [gate] = read(
      `it("a", () => {\n` +
        `  if (process.platform === "darwin" || process.platform === "win32") return;\n` +
        `});\n`,
    );
    expect(gate.vacuousOn).toEqual(["darwin"]);
  });

  it("names a suite whose body returns before it declares anything", () => {
    const [gate] = read(
      `describe("a", () => {\n  if (process.platform !== "win32") return;\n});\n`,
    );
    expect(gate.vacuousOn).toEqual(["linux", "darwin"]);
    expect(gate.test).toBe('describe "a"');
  });

  it("follows a module-scope const to the platform behind it", () => {
    const [gate] = read(
      `const posix = process.platform !== "darwin" && process.platform !== "win32";\n` +
        `test("a", () => {\n  if (!posix) return;\n});\n`,
    );
    expect(gate.vacuousOn).toEqual(["darwin"]);
  });

  it("leaves a gate that runs on both hosts alone", () => {
    const [gate] = read(
      `test("a", () => {\n  if (process.platform === "win32") return;\n});\n`,
    );
    expect(gate.vacuousOn).toEqual([]);
  });

  it("reads a gate nested inside a callback of the body", () => {
    const [gate] = read(
      `test("a", async () => {\n  await run(() => {\n` +
        `    if (process.platform !== "win32") return;\n  });\n});\n`,
    );
    expect(gate.vacuousOn).toEqual(["linux", "darwin"]);
  });

  it("reads a gate under a chained runner", () => {
    const [gate] = read(
      `test.each([1])("a %s", () => {\n` +
        `  if (process.platform !== "darwin") return;\n});\n`,
    );
    expect(gate.test).toBe('test "a %s"');
    expect(gate.vacuousOn).toEqual(["linux"]);
  });

  it("reports a condition it cannot evaluate rather than passing it", () => {
    const [gate] = read(
      `test("a", () => {\n  if (process.platform.startsWith("dar")) return;\n});\n`,
    );
    expect(gate.unreadable).toBe(true);
  });

  it("says nothing about an early return outside a test body", () => {
    expect(
      read(
        `function helper() {\n  if (process.platform !== "darwin") return;\n}\n`,
      ),
    ).toEqual([]);
  });

  it("says nothing about a gate whose branch does not exit", () => {
    expect(
      read(
        `test("a", () => {\n  if (process.platform !== "darwin") log("x");\n});\n`,
      ),
    ).toEqual([]);
  });

  it("says nothing about the skipIf the gates are written as", () => {
    expect(
      read(
        `test.skipIf(process.platform !== "darwin")("a", () => {\n  work();\n});\n`,
      ),
    ).toEqual([]);
  });
});
