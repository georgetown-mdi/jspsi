#!/usr/bin/env node
// Core barrel wildcard check, run by static_checks.yaml on every PR.
//
// packages/core/src/main.ts is a curated list of named exports: what
// @psilink/core publishes is decided one name at a time, and a symbol whose
// only callers outside core are test files belongs on the ./testing subpath
// instead. One `export * from "./someModule"` line undoes that -- the barrel
// goes back to publishing whatever its modules happen to export, and every
// later addition to a re-exported module joins the public API without anyone
// deciding it should. This check fails on that line.
//
// It reads the barrel with the TypeScript parser rather than a regex, so a
// wildcard written inside a comment or a string is not a finding and one
// spelled across several lines is.
//
// WHAT IT MATCHES, all three forms of a re-export that names no symbol:
//
//   - `export * from "./module"` -- the blanket barrel.
//   - `export * as name from "./module"` -- the same module surface, published
//     under one namespace object.
//   - `export type * from "./module"` -- the blanket barrel over the module's
//     type surface.
//
// WHAT IT DOES NOT COVER:
//
//   - Whether a NAMED export belongs on the main entry at all. That is the
//     curation decision itself, which review makes; this check holds only that
//     the list stays a list.
//   - The other published entries, packages/core/src/testing.ts and
//     packages/core/src/untrustedText.ts. They publish test material and one
//     parser, and neither is the curated product surface this holds.
//   - A wildcard reached indirectly: `export { x } from "./m"` where `./m`
//     itself re-exports another module with a wildcard. The barrel still names
//     what it publishes, which is what this check is about.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { descendants, parseSource } from "./lib/typeScriptSources.mjs";

/** The barrel this check guards, relative to the repository root. */
export const CORE_BARREL = "packages/core/src/main.ts";

/** Reads CORE_BARREL out of the tree at `root`. */
export function readBarrel(root) {
  return readFileSync(resolve(root, CORE_BARREL), "utf8");
}

/**
 * Every wildcard re-export in `text`, parsed under `fileName`. Each finding
 * states the line the parser puts the statement on, the module it re-exports,
 * and the statement as written.
 */
export function wildcardReExports(fileName, text) {
  const source = parseSource(fileName, text);
  const found = [];
  for (const node of descendants(source)) {
    if (!ts.isExportDeclaration(node)) continue;
    if (node.moduleSpecifier === undefined) continue;
    const clause = node.exportClause;
    if (clause !== undefined && !ts.isNamespaceExport(clause)) continue;
    found.push({
      line:
        source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      module: node.moduleSpecifier.getText(source),
      statement: node.getText(source).replace(/\s+/g, " "),
    });
  }
  return found;
}

/**
 * Reads the barrel out of the tree at `root` (through `read`, injectable for a
 * test) and reports `{ok, message}`.
 */
export function checkCoreBarrelWildcards({ root, read = readBarrel } = {}) {
  const found = wildcardReExports(CORE_BARREL, read(root));
  if (found.length === 0) {
    return {
      ok: true,
      message: `${CORE_BARREL} re-exports every name it publishes explicitly.`,
    };
  }
  const sites = found
    .map((site) => `  line ${site.line}: ${site.statement}`)
    .join("\n");
  return {
    ok: false,
    message: [
      `${CORE_BARREL} re-exports with a wildcard, which publishes whatever ` +
        "the named module exports rather than a decided list:",
      sites,
      "Name each export you mean to publish, and put a symbol whose only " +
        "callers outside packages/core are test files on the ./testing " +
        "subpath (packages/core/src/testing.ts) instead.",
    ].join("\n"),
  };
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions without the process.exit. `--root` points the run at another tree,
// which is how the test drives a barrel this repository does not hold.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const rootFlag = args.indexOf("--root");
  if (rootFlag !== -1 && args[rootFlag + 1] === undefined) {
    console.error(
      "usage: node scripts/check-core-barrel-wildcards.mjs [--root <tree>]",
    );
    process.exit(2);
  }
  const root =
    rootFlag === -1
      ? resolve(dirname(fileURLToPath(import.meta.url)), "..")
      : resolve(args[rootFlag + 1]);

  const { ok, message } = checkCoreBarrelWildcards({ root });
  (ok ? console.log : console.error)(
    `core barrel wildcard check ${ok ? "passed" : "failed"}: ${message}`,
  );
  if (!ok) process.exit(1);
}
