#!/usr/bin/env node
// The warning-source registry check, run by static_checks.yaml on every PR.
//
// A `warning` event names which notice raised it in its `source` field, so an
// unattended supervisor tells the cross-party host-key divergence security
// signal from a routine per-run notice -- or a relay degradation from either --
// without parsing `message`. That only works while each value set is published,
// and two streams publish one: the CLI's own fd-3 stream, and the console
// relay's job event stream, which passes the CLI's values through and adds the
// notices it composes itself. For each, a spec table is what a supervisor's
// author reads and a declaration in source is what the process emits. A value
// added to one and not the other leaves either a documented source nothing
// emits or an emitted source nobody can look up, and neither fails anything at
// runtime. This check fails on that, and on a relay value that collides with a
// CLI one -- the two sets share a field on one stream, so a collision would
// leave a supervisor unable to tell which process raised the warning.
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
//     is a required parameter of each emission boundary, so a call site cannot
//     compile without choosing one, and unit tests pin which value each warning
//     site emits (apps/cli/test/unit/protocol.test.ts for the CLI's,
//     apps/web/test/unit/jobs/relayWarningSources.test.ts for the relay's).
//   - What a value MEANS. Each table's second column is prose for a supervisor's
//     author, and review reads it.
//   - The order of any list. A table is ordered for a reader and a declaration
//     for whoever edits it; only the sets have to agree.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { descendants, parseSource } from "./lib/typeScriptSources.mjs";

/**
 * The registries this check holds, each one stream's own set: the module
 * declaring what that stream emits, and the spec table publishing it. Paths are
 * relative to the repository root.
 */
export const REGISTRIES = [
  {
    stream: "the CLI's fd-3 event stream",
    module: "apps/cli/src/eventStream.ts",
    declaration: "WARNING_SOURCES",
    doc: "docs/spec/CLI_EVENTS.md",
    heading: "#### Warning sources",
  },
  {
    stream: "the console relay's job event stream",
    module: "apps/web/src/jobs/cliDriver.ts",
    declaration: "RELAY_WARNING_SOURCES",
    doc: "docs/spec/SERVER_JOB_API.md",
    heading: "### Warning sources on the job stream",
  },
];

/**
 * The string literals of the `declaration` array in `text`, parsed under
 * `fileName`. Returns an empty array when the declaration is absent or is not
 * an array of string literals, which the caller reports as its own failure.
 */
export function declaredSources(fileName, text, declaration) {
  const source = parseSource(fileName, text);
  for (const node of descendants(source)) {
    if (!ts.isVariableDeclaration(node)) continue;
    if (!ts.isIdentifier(node.name) || node.name.text !== declaration) continue;
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
 * The first-column values of the registry table under `heading` in `text`. A
 * row's value is the code span the first cell holds. Collection starts past the
 * table's alignment separator, so the header row is not read as an entry, and
 * the section ends at the next heading.
 */
export function documentedSources(text, heading) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
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
 * Compare one registry's declared set against its documented one, reporting
 * `{values, failures}`: the declared values (empty when a side could not be
 * read) and the lines describing every disagreement found.
 */
function checkRegistry(registry, read) {
  const declared = declaredSources(
    registry.module,
    read(registry.module),
    registry.declaration,
  );
  const documented = documentedSources(read(registry.doc), registry.heading);
  if (declared.length === 0)
    return {
      values: [],
      failures: [
        `${registry.module} declares no ${registry.declaration} array of ` +
          "string literals, so the warning-source set " +
          `${registry.stream} emits could not be read.`,
      ],
    };
  if (documented.length === 0)
    return {
      values: [],
      failures: [
        `${registry.doc} holds no registry table under ` +
          `"${registry.heading}", so the published warning-source set for ` +
          `${registry.stream} could not be read.`,
      ],
    };
  const undocumented = declared.filter((value) => !documented.includes(value));
  const unemitted = documented.filter((value) => !declared.includes(value));
  const failures = [];
  if (undocumented.length > 0 || unemitted.length > 0)
    failures.push(
      `the warning-source set a supervisor reads for ${registry.stream} and ` +
        "the set it emits disagree:",
    );
  if (undocumented.length > 0)
    failures.push(
      `  emitted but not in the registry: ${undocumented.join(", ")}`,
      `  add a row for each to ${registry.doc} under "${registry.heading}", ` +
        "stating the notice it names.",
    );
  if (unemitted.length > 0)
    failures.push(
      `  in the registry but not emitted: ${unemitted.join(", ")}`,
      `  add each to ${registry.declaration} in ${registry.module}, or drop ` +
        "its row.",
    );
  return { values: declared, failures };
}

/**
 * Compare every registry's declared set against its documented one in the tree
 * at `root`, and the registries against each other, reporting `{ok, message}`.
 */
export function checkWarningSources({ root } = {}) {
  const read = (file) => readFileSync(resolve(root, file), "utf8");
  const results = REGISTRIES.map((registry) => checkRegistry(registry, read));
  const failures = results.flatMap((result) => result.failures);
  const [cli, relay] = results;
  const [, relayRegistry] = REGISTRIES;
  const collisions =
    cli === undefined || relay === undefined
      ? []
      : relay.values.filter((value) => cli.values.includes(value));
  if (collisions.length > 0)
    failures.push(
      "a synthesized relay source collides with a CLI one, so the field " +
        "cannot say which process raised the warning:",
      `  on both streams: ${collisions.join(", ")}`,
      `  give each a value of its own in ${relayRegistry.declaration} ` +
        `(${relayRegistry.module}) and its registry row.`,
    );
  if (failures.length > 0) return { ok: false, message: failures.join("\n") };
  const counted = REGISTRIES.map(
    (registry, index) =>
      `${results[index].values.length} for ${registry.stream}`,
  );
  return {
    ok: true,
    message: `${counted.join(", and ")}, each the same set in its module and its spec, with no value on both.`,
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
