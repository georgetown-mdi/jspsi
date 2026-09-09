import { dirname, join, relative, resolve } from "node:path";

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";

import { builtinModules } from "node:module";

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
 * The walk resolves what the app's own specifiers can reach: every path alias
 * apps/web/tsconfig.json declares, and relative paths. A bare package specifier
 * is left alone -- this asserts nothing about a dependency's own graph, which the
 * bundler resolves and which no source edit here changes.
 *
 * Three ways the walk could pass while seeing nothing decide its shape.
 *
 * It reads specifiers off the parsed syntax tree rather than out of the text,
 * because a side-effect `import "node:fs";` and an `await import("node:fs")`
 * name no binding and so match no `from "..."` scan.
 *
 * A path under the app that resolves to no file fails the run by name rather
 * than counting as a bare package, because counting it that way drops its whole
 * subtree from the walk and leaves every claim below it unmade.
 *
 * And every specifier is placed by the TypeScript compiler's own resolver,
 * `ts.resolveModuleName` under apps/web/tsconfig.json's merged options, so each
 * alias the project declares resolves the way the project resolves it -- the
 * `@*` -> `./src/*` catch-all included, under which `@/jobs/intentSchemas` and
 * `@theme` name app sources -- and a specifier the resolver places in
 * node_modules is the bare package it leaves alone. A re-implementation of the
 * `paths` matching would answer for its own rules instead, walking neither
 * subtree behind an alias it got wrong while still reporting green.
 *
 * A builtin is any specifier Node resolves as one -- `node:`-prefixed or not --
 * since `import "fs"` loads the same module and is as unloadable in a browser.
 * It is answered ahead of the resolver, which places a builtin on an
 * `@types/node` declaration or nowhere at all depending on what is installed
 * beside the tree being walked.
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "../..");

/**
 * `configPath`'s resolved compiler options -- `extends`, `baseUrl` and `paths`
 * merged the way `tsc` merges them -- read through the TypeScript API rather
 * than a hand re-parse of the JSON, so a specifier resolves under the options
 * the project actually compiles with. apps/web/tsconfig.json extends
 * tsconfig.base.json, which a plain read of its own `compilerOptions` misses.
 */
function resolvedCompilerOptions(configPath: string): ts.CompilerOptions {
  const read = ts.readConfigFile(configPath, (path) =>
    readFileSync(path, "utf8"),
  );
  if (read.error !== undefined) {
    throw new Error(
      `${configPath} is unreadable: ${ts.flattenDiagnosticMessageText(read.error.messageText, " ")}`,
    );
  }
  const options = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    dirname(configPath),
  ).options;
  if (Object.keys(options.paths ?? {}).length === 0) {
    throw new Error(
      `${configPath} declares no compilerOptions.paths, so this walk resolves nothing through an alias and every claim it makes covers less than it names`,
    );
  }
  return options;
}

const WEB_COMPILER_OPTIONS = resolvedCompilerOptions(
  join(webRoot, "tsconfig.json"),
);

/** The alias patterns apps/web/tsconfig.json declares, as the compiler holds
 * them. */
const ALIAS_PATTERNS = Object.keys(WEB_COMPILER_OPTIONS.paths ?? {});

/** What a walk resolves under: `src` is where it numbers its files from, and
 * `options` are the app's own compiler options re-rooted at the tree, so a
 * `paths` target lands inside it. */
type Tree = { readonly src: string; readonly options: ts.CompilerOptions };

/** The tree rooted at `base`, the directory a `paths` target is relative to. */
function treeAt(base: string): Tree {
  return {
    src: join(base, "src"),
    options: { ...WEB_COMPILER_OPTIONS, pathsBasePath: base },
  };
}

const appTree = treeAt(webRoot);

const NODE_BUILTINS = new Set(builtinModules);

/** Whether `specifier` names a Node builtin, in either spelling: `node:fs` and
 * `fs` load the same module, and neither loads in a browser. */
function isNodeBuiltin(specifier: string): boolean {
  if (specifier.startsWith("node:")) return true;
  return NODE_BUILTINS.has(specifier.split("/")[0]);
}

/** What a specifier names: one of the app's own files, a bare package left
 * alone, or a path under the app that resolves to nothing. */
type Resolution =
  | { readonly kind: "source"; readonly file: string }
  | { readonly kind: "bare" }
  | { readonly kind: "unresolved" };

/** What `specifier`, written in `fromFile`, names under `tree`. */
function resolveSource(
  tree: Tree,
  fromFile: string,
  specifier: string,
): Resolution {
  if (isNodeBuiltin(specifier)) return { kind: "bare" };
  const { resolvedModule } = ts.resolveModuleName(
    specifier,
    join(tree.src, fromFile),
    tree.options,
    ts.sys,
  );
  if (resolvedModule === undefined) return { kind: "unresolved" };
  if (resolvedModule.isExternalLibraryImport === true) return { kind: "bare" };
  return {
    kind: "source",
    file: relative(tree.src, resolvedModule.resolvedFileName),
  };
}

/**
 * Every module specifier `file` names, in any form that loads a module at
 * runtime: a static import (default, named, namespace, type-only, or
 * side-effect), a re-export, and a dynamic `import()` given a string literal.
 * A dynamic import of a computed specifier names no module this walk can
 * follow and is not collected.
 */
function specifiersOf(tree: Tree, file: string): Array<string> {
  const source = readFileSync(join(tree.src, file), "utf8");
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

/** The transitive closure of `entry` under `tree`, the bare specifiers reached
 * along the way, and every path under `tree` that resolved to no file. */
function importGraph(
  tree: Tree,
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
    for (const specifier of specifiersOf(tree, file)) {
      const resolution = resolveSource(tree, file, specifier);
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
 * so a form the walk must follow is exercised without planting it in src. The
 * fixture mirrors the app's shape -- sources under `src/`, aliases resolved
 * against the tree root -- so a case can be written through a tsconfig alias and
 * land inside the fixture rather than in apps/web/src. */
function walkFixture(
  files: Record<string, string>,
  entry: string,
): ReturnType<typeof importGraph> {
  const base = mkdtempSync(join(tmpdir(), "psilink-browser-safe-"));
  fixtureRoots.push(base);
  const tree = treeAt(base);
  for (const [path, source] of Object.entries(files)) {
    const full = join(tree.src, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, source, "utf8");
  }
  return importGraph(tree, entry);
}

afterAll(() => {
  for (const root of fixtureRoots)
    rmSync(root, { recursive: true, force: true });
});

describe("the job intent's schema module stays loadable in the browser", () => {
  test("nothing its imports reach names a Node builtin", () => {
    const { files, bare, unresolved } = importGraph(
      appTree,
      "jobs/intentSchemas.ts",
    );
    expect(
      unresolved,
      "a specifier under src resolved to no file, so its subtree went unwalked and this claim covers less than it names",
    ).toEqual([]);
    expect(
      bare.filter(isNodeBuiltin),
      `reached from ${files.join(", ")}`,
    ).toEqual([]);
  });

  test("the walk reaches the app sources it is meant to, and resolves them", () => {
    const { files } = importGraph(appTree, "jobs/intentSchemas.ts");
    expect(files).toContain("jobs/workInputName.ts");
    expect(files).toContain("components/csvIntake.ts");
    expect(files.length).toBeGreaterThan(2);
  });

  test("it reports a Node builtin where one is reachable, so the walk discriminates", () => {
    const { bare } = importGraph(appTree, "jobs/intentArgv.ts");
    expect(bare).toContain("node:url");
  });
});

describe("the walk resolves every alias apps/web/tsconfig.json declares", () => {
  test("it reads them from the config, catch-all included", () => {
    expect(
      ALIAS_PATTERNS,
      "the tsconfig `@*` -> ./src/* catch-all is not among the aliases read, so a specifier written through it counts as a bare package and its subtree goes unwalked",
    ).toContain("@*");
    expect(ALIAS_PATTERNS).toEqual(
      expect.arrayContaining(["@components/*", "@utils/*"]),
    );
  });

  test("the catch-all names an app source, not a bare package", () => {
    const { bare, files } = walkFixture(
      {
        "entry.ts": 'import "@/leaf";\n',
        "leaf.ts": 'import "node:fs";\n',
      },
      "entry.ts",
    );
    expect(
      bare,
      "a `@/`-routed specifier was counted a bare package, so its subtree went unwalked",
    ).not.toContain("@/leaf");
    expect(files).toContain("leaf.ts");
    expect(bare).toContain("node:fs");
  });

  test("an alias with no path separator resolves too", () => {
    const { bare, files } = walkFixture(
      {
        "entry.ts": 'import "@theme";\n',
        "theme.ts": 'import "node:fs";\n',
      },
      "entry.ts",
    );
    expect(files).toContain("theme.ts");
    expect(bare).toContain("node:fs");
  });

  test("a specific alias wins over the catch-all", () => {
    const { files } = walkFixture(
      {
        "entry.ts": 'import "@utils/leaf";\n',
        "utils/leaf.ts": "export const a = 1;\n",
      },
      "entry.ts",
    );
    expect(files).toContain(join("utils", "leaf.ts"));
  });

  test("an aliased path that resolves to nothing is named, not counted bare", () => {
    const { bare, unresolved } = walkFixture(
      { "entry.ts": 'import "@/missing";\n' },
      "entry.ts",
    );
    expect(unresolved).toEqual(["entry.ts -> @/missing"]);
    expect(
      bare,
      "an unresolved aliased path was counted as a bare package, which silently drops its subtree",
    ).toEqual([]);
  });

  test("a real package the catch-all also matches stays bare", () => {
    const { bare, unresolved } = importGraph(appTree, "jobs/intentSchemas.ts");
    expect(unresolved).toEqual([]);
    expect(
      bare,
      "@psilink/core matches the `@*` catch-all and resolves to no app source, so the walk must fall back to node resolution and leave it alone",
    ).toContain("@psilink/core");
  });
});

describe("the walk counts a Node builtin in either spelling", () => {
  test("an unprefixed builtin is a builtin", () => {
    const { bare } = walkFixture(
      {
        "entry.ts": 'import "./leaf";\n',
        "leaf.ts": 'import "fs";\n',
      },
      "entry.ts",
    );
    expect(bare).toContain("fs");
    expect(
      bare.filter(isNodeBuiltin),
      "an unprefixed `fs` import passed as an ordinary package, and it is as unloadable in a browser as `node:fs`",
    ).toContain("fs");
  });

  test("a builtin's subpath counts too", () => {
    expect(isNodeBuiltin("fs/promises")).toBe(true);
    expect(isNodeBuiltin("node:fs/promises")).toBe(true);
  });

  test("an ordinary package does not", () => {
    expect(isNodeBuiltin("zod")).toBe(false);
    expect(isNodeBuiltin("@psilink/core")).toBe(false);
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
