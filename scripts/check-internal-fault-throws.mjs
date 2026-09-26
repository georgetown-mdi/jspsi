#!/usr/bin/env node
// Internal-fault throw check, run by static_checks.yaml on every PR.
//
// The CLI's error->exit boundary (`exitCodeForError`, apps/cli/src/util/exit.ts)
// reads an error's class, not its message: an `InternalConsistencyError` exits
// 70, the code docs/CLI.md tells a supervisor to report and not retry, while a
// plain `Error` falls through to 69, the code it retries as a transport fault.
// A guard on Alcove's own state that throws a plain `Error` therefore tells an
// unattended scheduler to re-run an exchange that fails the same way every
// time, and nothing fails at runtime to show it. This check fails on the two
// shapes that mark such a guard unambiguously in source:
//
//   - `throw new Error(...)` after a statement binding a value to `never` in
//     the same block or an enclosing one -- the exhaustiveness branch, whose
//     `never` binding proves at build time that the code after it is
//     unreachable while the types hold.
//   - `throw new Error(...)` whose message text says "internal error".
//
// Either shape throws `InternalConsistencyError` (packages/core/src/errors.ts)
// instead. It reads source with the TypeScript parser rather than a regex, so a
// throw written in a comment or a string is not a finding and one spelled
// across several lines is.
//
// WHAT IT DOES NOT COVER:
//
//   - Every other internal guard. A precondition check ("not connected", "role
//     is unresolved") is an internal fault too, but nothing in its syntax says
//     so; review holds those to the same class.
//   - A plain `Error` built elsewhere and thrown later, or passed to `reject`
//     or an emitter. Only a `new Error(...)` that is the thrown expression
//     itself is read.
//   - Any tree but packages/core/src and apps/cli/src, the two the CLI's exit
//     code is decided over. The web app has no process exit code.
//
// Exit condition: this check stands while the CLI maps an internal fault to
// its own exit code by class. Delete it if `exitCodeForError` stops
// distinguishing `InternalConsistencyError`.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import {
  descendants,
  parseSource,
  readSource,
  sourceModules,
} from "./lib/typeScriptSources.mjs";

/** The trees this check reads, relative to the repository root. */
export const GUARDED_TREES = ["packages/core/src", "apps/cli/src"];

const INTERNAL_ERROR_TEXT = /internal error/i;

function isPlainErrorConstruction(node) {
  return (
    node !== undefined &&
    ts.isNewExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "Error"
  );
}

function bindsNever(statement) {
  return (
    ts.isVariableStatement(statement) &&
    statement.declarationList.declarations.some(
      (declaration) => declaration.type?.kind === ts.SyntaxKind.NeverKeyword,
    )
  );
}

function statementsOf(node) {
  if (ts.isBlock(node) || ts.isCaseClause(node) || ts.isDefaultClause(node))
    return node.statements;
  return undefined;
}

// The throw's enclosing statement lists, innermost first, up to the function
// that holds it: a `never` binding ahead of the statement on the throw's path
// in any of them puts the throw in the code the binding proves unreachable. A
// binding after that statement, or in a sibling branch, does not.
function inNeverBranch(throwStatement) {
  let onPath = throwStatement;
  for (let node = throwStatement.parent; node; node = node.parent) {
    if (ts.isFunctionLike(node) || ts.isSourceFile(node)) return false;
    const statements = statementsOf(node);
    if (statements !== undefined) {
      const index = statements.indexOf(onPath);
      if (index > 0 && statements.slice(0, index).some(bindsNever)) return true;
    }
    onPath = node;
  }
  return false;
}

/**
 * Every plain-`Error` throw in `text`, parsed under `fileName`, that one of
 * the two shapes marks as an internal fault. Each finding states the file,
 * the line the parser puts the throw on, and which shape it matched.
 */
export function internalFaultPlainThrows(fileName, text) {
  const source = parseSource(fileName, text);
  const found = [];
  for (const node of descendants(source)) {
    if (!ts.isThrowStatement(node)) continue;
    if (!isPlainErrorConstruction(node.expression)) continue;
    const message = node.expression.arguments?.[0]?.getText(source) ?? "";
    const shape = inNeverBranch(node)
      ? "never-typed branch"
      : INTERNAL_ERROR_TEXT.test(message)
        ? '"internal error" text'
        : undefined;
    if (shape === undefined) continue;
    found.push({
      file: fileName,
      line:
        source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      shape,
    });
  }
  return found;
}

/**
 * Reads every TypeScript source under `trees` (through `list` and `read`,
 * injectable for a test) and reports `{ok, message}`.
 */
export function checkInternalFaultThrows({
  trees = GUARDED_TREES,
  list = sourceModules,
  read = readSource,
} = {}) {
  const found = trees.flatMap((tree) =>
    list(tree).flatMap((file) => internalFaultPlainThrows(file, read(file))),
  );
  if (found.length === 0) {
    return {
      ok: true,
      message: `no internal-fault guard in ${trees.join(" or ")} throws a plain Error.`,
    };
  }
  return {
    ok: false,
    message: [
      "an internal-fault guard throws a plain Error, which the CLI exits 69 " +
        "(retry) rather than 70 (report):",
      ...found.map((site) => `  ${site.file}:${site.line} (${site.shape})`),
      "Throw InternalConsistencyError (packages/core/src/errors.ts, exported " +
        "from @alcove/core) instead.",
    ].join("\n"),
  };
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions without the process.exit. `--root` points the run at another
// tree's copies of the guarded directories, which is how the test drives
// source this repository does not hold.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const rootFlag = args.indexOf("--root");
  if (rootFlag !== -1 && args[rootFlag + 1] === undefined) {
    console.error(
      "usage: node scripts/check-internal-fault-throws.mjs [--root <tree>]",
    );
    process.exit(2);
  }
  const trees =
    rootFlag === -1
      ? GUARDED_TREES
      : GUARDED_TREES.map((tree) => resolve(args[rootFlag + 1], tree));

  const { ok, message } = checkInternalFaultThrows({ trees });
  (ok ? console.log : console.error)(
    `internal-fault throw check ${ok ? "passed" : "failed"}: ${message}`,
  );
  if (!ok) process.exit(1);
}
