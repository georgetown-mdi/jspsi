import { dirname, join, relative, resolve } from "node:path";

import { readFileSync } from "node:fs";

import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

/**
 * The job intent's schema module is what a browser guard reads a field contract
 * from, so nothing in its import graph may reach a Node builtin: one such import
 * makes the module unloadable in the browser, and the guard's constant gets
 * copied out into a module of its own instead. The composition modules beside it
 * are the server's, and `intentArgv` does import `node:url` -- this walk is what
 * keeps that import from creeping back across the boundary.
 *
 * The walk resolves what the app's own specifiers can reach: the `@`-prefixed
 * source aliases and relative paths. A bare package specifier is left alone --
 * this asserts nothing about a dependency's own graph, which the bundler
 * resolves and which no source edit here changes.
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "../..");
const srcRoot = join(webRoot, "src");

const ALIASES: ReadonlyArray<[string, string]> = [
  ["@components/", "components/"],
  ["@console/", "console/"],
  ["@exchange/", "exchange/"],
  ["@jobs/", "jobs/"],
  ["@psi/", "psi/"],
  ["@recurring/", "recurring/"],
  ["@styles/", "styles/"],
  ["@utils/", "utils/"],
];

/** The file `specifier` names, relative to `srcRoot`, or undefined when it
 * points outside the app's own sources. */
function resolveSource(
  fromFile: string,
  specifier: string,
): string | undefined {
  let target: string | undefined;
  if (specifier.startsWith(".")) {
    target = resolve(dirname(join(srcRoot, fromFile)), specifier);
  } else {
    const alias = ALIASES.find(([prefix]) => specifier.startsWith(prefix));
    if (alias === undefined) return undefined;
    target = join(srcRoot, alias[1], specifier.slice(alias[0].length));
  }
  for (const candidate of [target, `${target}.ts`, `${target}.tsx`]) {
    try {
      readFileSync(candidate, "utf8");
      return relative(srcRoot, candidate);
    } catch {
      continue;
    }
  }
  return undefined;
}

/** Every specifier `file` imports or re-exports from. */
function specifiersOf(file: string): Array<string> {
  const source = readFileSync(join(srcRoot, file), "utf8");
  return [...source.matchAll(/\bfrom\s+"([^"]+)"/g)].map((match) => match[1]);
}

/** The transitive closure of `entry` over the app's own sources, plus every
 * bare specifier reached along the way. */
function importGraph(entry: string): {
  files: Array<string>;
  bare: Array<string>;
} {
  const files = new Set<string>();
  const bare = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    for (const specifier of specifiersOf(file)) {
      const resolved = resolveSource(file, specifier);
      if (resolved === undefined) bare.add(specifier);
      else queue.push(resolved);
    }
  }
  return { files: [...files].sort(), bare: [...bare].sort() };
}

describe("the job intent's schema module stays loadable in the browser", () => {
  test("nothing its imports reach names a Node builtin", () => {
    const { files, bare } = importGraph("jobs/intentSchemas.ts");
    expect(
      bare.filter((specifier) => specifier.startsWith("node:")),
      `reached from ${files.join(", ")}`,
    ).toEqual([]);
  });

  test("the walk reaches the app sources it is meant to, and resolves them", () => {
    const { files } = importGraph("jobs/intentSchemas.ts");
    expect(files).toContain("jobs/workInputName.ts");
    expect(files).toContain("components/csvIntake.ts");
    expect(files.length).toBeGreaterThan(2);
  });

  test("it reports a Node builtin where one is reachable, so the walk discriminates", () => {
    const { bare } = importGraph("jobs/intentArgv.ts");
    expect(bare).toContain("node:url");
  });
});
