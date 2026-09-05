import { dirname, join, relative, resolve } from "node:path";

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";

import { tmpdir } from "node:os";

import { fileURLToPath } from "node:url";

import ts from "typescript";

import { afterAll, describe, expect, test } from "vitest";

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
 *
 * Two ways the walk could pass while seeing nothing decide its shape. It reads
 * specifiers off the parsed syntax tree rather than out of the text, because a
 * side-effect `import "node:fs";` and an `await import("node:fs")` name no
 * binding and so match no `from "..."` scan. And a relative specifier that
 * resolves to no file fails the run by name rather than counting as a bare
 * package, because counting it that way drops its whole subtree from the walk
 * and leaves every claim below it unmade. The fixture cases below hold both.
 *
 * The walk resolves only the alias prefixes in its ALIASES table, so a
 * specifier through the tsconfig `@*` catch-all (`@/...`) or `@theme` is
 * treated as a bare package and its subtree is not walked. And it counts only
 * `node:`-prefixed specifiers as builtins, so an unprefixed builtin such as
 * `fs` passes.
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

/** What a specifier names: one of the app's own files, a bare package left
 * alone, or a path under the app that resolves to nothing. */
type Resolution =
  | { readonly kind: "source"; readonly file: string }
  | { readonly kind: "bare" }
  | { readonly kind: "unresolved" };

/** What `specifier`, written in `fromFile`, names under `root`. */
function resolveSource(
  root: string,
  fromFile: string,
  specifier: string,
): Resolution {
  let target: string;
  if (specifier.startsWith(".")) {
    target = resolve(dirname(join(root, fromFile)), specifier);
  } else {
    const alias = ALIASES.find(([prefix]) => specifier.startsWith(prefix));
    if (alias === undefined) return { kind: "bare" };
    target = join(root, alias[1], specifier.slice(alias[0].length));
  }
  for (const candidate of [
    target,
    `${target}.ts`,
    `${target}.tsx`,
    join(target, "index.ts"),
    join(target, "index.tsx"),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return { kind: "source", file: relative(root, candidate) };
    }
  }
  return { kind: "unresolved" };
}

/**
 * Every module specifier `file` names, in any form that loads a module at
 * runtime: a static import (default, named, namespace, type-only, or
 * side-effect), a re-export, and a dynamic `import()` given a string literal.
 * A dynamic import of a computed specifier names no module this walk can
 * follow and is not collected.
 */
function specifiersOf(root: string, file: string): Array<string> {
  const source = readFileSync(join(root, file), "utf8");
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.ESNext,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const specifiers: Array<string> = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const first = node.arguments.at(0);
      if (first !== undefined && ts.isStringLiteral(first)) {
        specifiers.push(first.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return specifiers;
}

/** The transitive closure of `entry` under `root`, the bare specifiers reached
 * along the way, and every path under `root` that resolved to no file. */
function importGraph(
  root: string,
  entry: string,
): {
  files: Array<string>;
  bare: Array<string>;
  unresolved: Array<string>;
} {
  const files = new Set<string>();
  const bare = new Set<string>();
  const unresolved = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    for (const specifier of specifiersOf(root, file)) {
      const resolution = resolveSource(root, file, specifier);
      if (resolution.kind === "source") queue.push(resolution.file);
      else if (resolution.kind === "bare") bare.add(specifier);
      else unresolved.add(`${file} -> ${specifier}`);
    }
  }
  return {
    files: [...files].sort(),
    bare: [...bare].sort(),
    unresolved: [...unresolved].sort(),
  };
}

const fixtureRoots: Array<string> = [];

/** Walks `entry` over a throwaway tree written from `files` (path -> source),
 * so a form the walk must follow is exercised without planting it in src. */
function walkFixture(
  files: Record<string, string>,
  entry: string,
): ReturnType<typeof importGraph> {
  const root = mkdtempSync(join(tmpdir(), "psilink-browser-safe-"));
  fixtureRoots.push(root);
  for (const [path, source] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, source, "utf8");
  }
  return importGraph(root, entry);
}

afterAll(() => {
  for (const root of fixtureRoots)
    rmSync(root, { recursive: true, force: true });
});

describe("the job intent's schema module stays loadable in the browser", () => {
  test("nothing its imports reach names a Node builtin", () => {
    const { files, bare, unresolved } = importGraph(
      srcRoot,
      "jobs/intentSchemas.ts",
    );
    expect(
      unresolved,
      "a specifier under src resolved to no file, so its subtree went unwalked and this claim covers less than it names",
    ).toEqual([]);
    expect(
      bare.filter((specifier) => specifier.startsWith("node:")),
      `reached from ${files.join(", ")}`,
    ).toEqual([]);
  });

  test("the walk reaches the app sources it is meant to, and resolves them", () => {
    const { files } = importGraph(srcRoot, "jobs/intentSchemas.ts");
    expect(files).toContain("jobs/workInputName.ts");
    expect(files).toContain("components/csvIntake.ts");
    expect(files.length).toBeGreaterThan(2);
  });

  test("it reports a Node builtin where one is reachable, so the walk discriminates", () => {
    const { bare } = importGraph(srcRoot, "jobs/intentArgv.ts");
    expect(bare).toContain("node:url");
  });
});

describe("the walk follows every import form a module can load through", () => {
  test("a side-effect import, which names no binding", () => {
    const { bare } = walkFixture(
      {
        "entry.ts": 'import "./leaf";\n',
        "leaf.ts": 'import "node:fs";\n',
      },
      "entry.ts",
    );
    expect(bare).toContain("node:fs");
  });

  test("a dynamic import given a string literal", () => {
    const { bare } = walkFixture(
      {
        "entry.ts":
          "export const load = async (): Promise<unknown> =>\n" +
          '  await import("./leaf");\n',
        "leaf.ts": 'import "node:fs";\n',
      },
      "entry.ts",
    );
    expect(bare).toContain("node:fs");
  });

  test("a re-export, in both of its spellings", () => {
    const { bare } = walkFixture(
      {
        "entry.ts": 'export { a } from "./named";\nexport * from "./all";\n',
        "named.ts": 'import "node:fs";\nexport const a = 1;\n',
        "all.ts": 'import "node:net";\nexport const b = 2;\n',
      },
      "entry.ts",
    );
    expect(bare).toEqual(expect.arrayContaining(["node:fs", "node:net"]));
  });

  test("each static import form that does name a binding", () => {
    const { bare } = walkFixture(
      {
        "entry.ts":
          'import fallback from "./default";\n' +
          'import { named } from "./named";\n' +
          'import * as everything from "./namespace";\n' +
          'import type { Shape } from "./typeOnly";\n' +
          "export const used = [fallback, named, everything] as Array<unknown>;\n" +
          "export type Used = Shape;\n",
        "default.ts": 'import "node:fs";\nexport default 1;\n',
        "named.ts": 'import "node:net";\nexport const named = 2;\n',
        "namespace.ts": 'import "node:os";\nexport const c = 3;\n',
        "typeOnly.ts":
          'import "node:tls";\nexport type Shape = { a: number };\n',
      },
      "entry.ts",
    );
    expect(bare).toEqual(
      expect.arrayContaining(["node:fs", "node:net", "node:os", "node:tls"]),
    );
  });

  test("a directory specifier, through its index file", () => {
    const { bare, files } = walkFixture(
      {
        "entry.ts": 'import { a } from "./nested";\nexport const b = a;\n',
        "nested/index.ts": 'import "node:fs";\nexport const a = 1;\n',
      },
      "entry.ts",
    );
    expect(files).toContain(join("nested", "index.ts"));
    expect(bare).toContain("node:fs");
  });

  test("and it names a relative specifier that resolves to nothing", () => {
    const { bare, unresolved } = walkFixture(
      { "entry.ts": 'import "./missing";\n' },
      "entry.ts",
    );
    expect(unresolved).toEqual(["entry.ts -> ./missing"]);
    expect(
      bare,
      "an unresolved path under the app was counted as a bare package, which silently drops its subtree",
    ).toEqual([]);
  });
});
