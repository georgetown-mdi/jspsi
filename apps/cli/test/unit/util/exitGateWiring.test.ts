import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { expect, test } from "vitest";

// Every end-to-end case that watches the gate close a run runs through
// test/exitGateProbe.ts, which bootstraps the CLI itself, so deleting the
// arming call from src/index.ts would leave all of them green. These two cases
// read both files as source and pin the wiring: that what ships arms the gate
// where it says it does, and that the probe's bootstrap still has the shape of
// the one it stands in for. Neither runs the gate -- test/unit/util/
// exitGate.test.ts and the backend-agnostic boundedExit cases own its
// behaviour.

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY_POINT = resolve(HERE, "..", "..", "..", "src", "index.ts");
const PROBE = resolve(HERE, "..", "..", "..", "test", "exitGateProbe.ts");

const ARM = "armProcessReturnGate";

/** What a file's CLI bootstrap does, reduced to what both files must share. */
interface BootstrapShape {
  /** The call chain, outermost last: `buildCli`, `parseAsync`, `then`, ... */
  chain: string[];
  /** How many times the `.then` callback calls the gate. */
  armCallsInThen: number;
  /** Whether that call is the callback's last statement. */
  armIsLastInThen: boolean;
  /** How many times the whole file calls the gate. */
  armCallsInFile: number;
}

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.ESNext,
    true,
  );
}

function countArmCalls(node: ts.Node): number {
  let found = 0;
  const visit = (child: ts.Node): void => {
    if (
      ts.isCallExpression(child) &&
      ts.isIdentifier(child.expression) &&
      child.expression.text === ARM
    )
      found += 1;
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

/** The statement's call chain, and the `.then` call inside it. */
function readChain(expression: ts.Expression): {
  chain: string[];
  thenCall: ts.CallExpression | undefined;
} {
  const chain: string[] = [];
  let thenCall: ts.CallExpression | undefined;
  let node: ts.Expression = expression;
  while (ts.isCallExpression(node)) {
    const callee = node.expression;
    if (ts.isPropertyAccessExpression(callee)) {
      chain.push(callee.name.text);
      if (callee.name.text === "then") thenCall = node;
      node = callee.expression;
      continue;
    }
    if (ts.isIdentifier(callee)) chain.push(callee.text);
    break;
  }
  return { chain: chain.reverse(), thenCall };
}

function bootstrapShape(path: string): BootstrapShape {
  const source = parse(path);
  const bootstrap = source.statements.find(
    (statement) =>
      ts.isExpressionStatement(statement) && countArmCalls(statement) > 0,
  );
  if (bootstrap === undefined)
    throw new Error(`${path} has no top-level statement calling ${ARM}`);
  const expression = (bootstrap as ts.ExpressionStatement).expression;
  const { chain, thenCall } = readChain(
    ts.isVoidExpression(expression) ? expression.expression : expression,
  );
  if (thenCall === undefined)
    throw new Error(`${path}'s bootstrap has no .then call`);
  const callback = thenCall.arguments[0];
  if (callback === undefined || !ts.isArrowFunction(callback))
    throw new Error(`${path}'s .then takes no arrow function`);
  const body = callback.body;
  const last = ts.isBlock(body)
    ? body.statements[body.statements.length - 1]
    : undefined;
  return {
    chain,
    armCallsInThen: countArmCalls(body),
    armIsLastInThen: last !== undefined && countArmCalls(last) === 1,
    armCallsInFile: countArmCalls(source),
  };
}

test("wiring pin, not behaviour: the shipped entry point arms the gate once, in the .then of parseAsync", () => {
  const shape = bootstrapShape(ENTRY_POINT);
  expect(shape.chain).toEqual(["buildCli", "parseAsync", "then", "catch"]);
  expect(shape.armCallsInThen).toBe(1);
  expect(shape.armIsLastInThen).toBe(true);
  expect(shape.armCallsInFile).toBe(1);
});

test("wiring pin, not behaviour: the exit-gate probe bootstraps in the shape of the entry point", () => {
  expect(bootstrapShape(PROBE)).toEqual(bootstrapShape(ENTRY_POINT));
});
