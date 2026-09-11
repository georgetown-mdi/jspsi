#!/usr/bin/env node
// The fd-3 warning-source registry check, run by static_checks.yaml on every PR.
//
// A `warning` event on the CLI's machine-interface stream names which notice
// raised it in its `source` field, so an unattended supervisor tells the
// cross-party host-key divergence security signal from a routine per-run notice
// without parsing `message`. That only works while the value set is published:
// docs/spec/CLI_EVENTS.md's Warning sources table is what a supervisor's author
// reads, and WARNING_SOURCES in apps/cli/src/eventStream.ts is what the CLI
// emits. A value added to one and not the other leaves either a documented
// source nothing emits or an emitted source nobody can look up, and neither
// fails anything at runtime. This check fails on that.
//
// It reads the code side with the TypeScript parser rather than a regex, so a
// value written in a comment or in another declaration's array is not read as a
// registry entry. The spec side is read as the table rows under the registry
// heading, keyed on the heading and on the first column's code span rather than
// on any line number.
//
// WHAT IT DOES NOT COVER:
//
//   - Whether a value is emitted anywhere. The compiler holds that end: `source`
//     is a required parameter of the emission boundary, so a call site cannot
//     compile without choosing one, and the unit tests in
//     apps/cli/test/unit/protocol.test.ts pin which value each warning site
//     emits.
//   - What a value MEANS. The table's second column is prose for a supervisor's
//     author, and review reads it.
//   - The order of either list. The table is ordered for a reader and the
//     declaration for whoever edits it; only the sets have to agree.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { descendants, parseSource } from "./lib/typeScriptSources.mjs";

/** The module declaring the emitted value set, relative to the repository root. */
export const SOURCE_MODULE = "apps/cli/src/eventStream.ts";

/** The spec holding the published registry, relative to the repository root. */
export const REGISTRY_DOC = "docs/spec/CLI_EVENTS.md";

/** The declaration read out of {@link SOURCE_MODULE}. */
export const DECLARATION = "WARNING_SOURCES";

/** The heading in {@link REGISTRY_DOC} the registry table sits under. */
export const REGISTRY_HEADING = "#### Warning sources";

/**
 * The string literals of the `WARNING_SOURCES` array in `text`, parsed under
 * `fileName`. Returns an empty array when the declaration is absent or is not
 * an array of string literals, which the caller reports as its own failure.
 */
export function declaredSources(fileName, text) {
  const source = parseSource(fileName, text);
  for (const node of descendants(source)) {
    if (!ts.isVariableDeclaration(node)) continue;
    if (!ts.isIdentifier(node.name) || node.name.text !== DECLARATION) continue;
    // `[...] as const` parses as an assertion wrapping the array literal.
    const initializer =
      node.initializer !== undefined && ts.isAsExpression(node.initializer)
        ? node.initializer.expression
        : node.initializer;
    if (initializer === undefined || !ts.isArrayLiteralExpression(initializer))
      return [];
    return initializer.elements
      .filter((element) => ts.isStringLiteral(element))
      .map((element) => element.text);
  }
  return [];
}

/**
 * The first-column values of the registry table under {@link REGISTRY_HEADING}
 * in `text`. A row's value is the code span the first cell holds. Collection
 * starts past the table's alignment separator, so the header row is not read as
 * an entry, and the section ends at the next heading.
 */
export function documentedSources(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === REGISTRY_HEADING);
  if (start === -1) return [];
  const found = [];
  let inBody = false;
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("#")) break;
    if (!line.trimStart().startsWith("|")) continue;
    if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) {
      inBody = true;
      continue;
    }
    if (!inBody) continue;
    const firstCell = line.split("|")[1] ?? "";
    const span = /^\s*`([^`]+)`\s*$/.exec(firstCell);
    if (span !== null) found.push(span[1]);
  }
  return found;
}

/**
 * Compare the declared set against the documented one in the tree at `root`,
 * reporting `{ok, message}`.
 */
export function checkWarningSources({ root } = {}) {
  const read = (file) => readFileSync(resolve(root, file), "utf8");
  const declared = declaredSources(SOURCE_MODULE, read(SOURCE_MODULE));
  const documented = documentedSources(read(REGISTRY_DOC));
  if (declared.length === 0) {
    return {
      ok: false,
      message:
        `${SOURCE_MODULE} declares no ${DECLARATION} array of string ` +
        "literals, so the emitted warning-source set could not be read.",
    };
  }
  if (documented.length === 0) {
    return {
      ok: false,
      message:
        `${REGISTRY_DOC} holds no registry table under "${REGISTRY_HEADING}", ` +
        "so the published warning-source set could not be read.",
    };
  }
  const undocumented = declared.filter((value) => !documented.includes(value));
  const unemitted = documented.filter((value) => !declared.includes(value));
  if (undocumented.length === 0 && unemitted.length === 0) {
    return {
      ok: true,
      message: `${declared.length} warning sources, the same set in ${SOURCE_MODULE} and ${REGISTRY_DOC}.`,
    };
  }
  const lines = [];
  if (undocumented.length > 0)
    lines.push(
      `  emitted but not in the registry: ${undocumented.join(", ")}`,
      `  add a row for each to ${REGISTRY_DOC} under "${REGISTRY_HEADING}", ` +
        "stating the notice it names.",
    );
  if (unemitted.length > 0)
    lines.push(
      `  in the registry but not emitted: ${unemitted.join(", ")}`,
      `  add each to ${DECLARATION} in ${SOURCE_MODULE}, or drop its row.`,
    );
  return {
    ok: false,
    message: [
      "the warning-source set a supervisor reads and the set the CLI emits " +
        "disagree:",
      ...lines,
    ].join("\n"),
  };
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions without the process.exit. `--root` points the run at another tree,
// which is how the test drives a registry this repository does not hold.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const rootFlag = args.indexOf("--root");
  if (rootFlag !== -1 && args[rootFlag + 1] === undefined) {
    console.error(
      "usage: node scripts/check-warning-sources.mjs [--root <tree>]",
    );
    process.exit(2);
  }
  const root =
    rootFlag === -1
      ? resolve(dirname(fileURLToPath(import.meta.url)), "..")
      : resolve(args[rootFlag + 1]);

  const { ok, message } = checkWarningSources({ root });
  (ok ? console.log : console.error)(
    `warning source registry check ${ok ? "passed" : "failed"}: ${message}`,
  );
  if (!ok) process.exit(1);
}
