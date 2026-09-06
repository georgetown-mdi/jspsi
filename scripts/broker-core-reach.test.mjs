import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { ESLint } from "eslint";
import { afterAll, describe, expect, it } from "vitest";

import {
  filesUnder,
  parseFile,
  sourceModules,
} from "./lib/typeScriptSources.mjs";

// What the standalone signaling broker can reach at run time. It is the one
// process here that listens on the internet with no application around it, so
// the packages in its runtime closure are the packages an advisory can force a
// redeploy of it over -- a cost that has nothing to do with whether the advisory
// is exploitable through the broker.
//
// Two halves, because either alone can be satisfied while the reach is wide. The
// first holds the broker's own source to `@psilink/core/untrusted-text`; it
// scans every file under packages/peerjs-broker/src, including the vendored ones
// the repo-wide eslint ignores leave unlinted, so a root import added there
// fails here rather than passing unnoticed. The second measures what that
// subpath resolves to once BUILT: an entry that re-exports from a module which
// imports zod narrows nothing, and only the built graph shows it.
//
// The eslint ban beside them (eslint.config.mjs, the packages/peerjs-broker/src
// block) is what a contributor meets first; it covers the linted tree only,
// which is why the scan below does not lean on it.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const BROKER_SRC = "packages/peerjs-broker/src";
const brokerSrc = join(repoRoot, BROKER_SRC);
const coreDir = join(repoRoot, "packages/core");
const coreDist = join(coreDir, "dist");

/** The core entry point this workspace reads, and the rebuild that produces it. */
const CORE_SUBPATH = "@psilink/core/untrusted-text";
const CORE_BUILD_COMMAND = "npm run build -w packages/core";

/**
 * Every package the broker's own source may name at run time. `ws` is the
 * WebSocket server it is built on; the core subpath holds the display,
 * redaction and bounded-parse chokepoints it shares with the rest of psilink
 * (CONTRIBUTING.md, Untrusted-JSON parsing and Operator-facing escaping). A
 * `node:` builtin is neither installed nor advisory-bearing, so it is out of
 * scope rather than listed.
 */
const BROKER_RUNTIME_PACKAGES = ["ws", CORE_SUBPATH];

// Loading the flat config and typescript-eslint parser for the first time is the
// expensive part of a lintText call, so it is paid once here rather than by each
// eslint case.
const eslint = new ESLint({
  cwd: repoRoot,
  overrideConfigFile: join(repoRoot, "eslint.config.mjs"),
});

/**
 * Files a source tree may hold that can hold no import: the license text
 * vendored beside the server source. Every other file under the broker's source
 * directory is one the guards below have to have read.
 */
const NON_SOURCE_FILE_NAMES = ["LICENSE"];

/**
 * Every file under `dir` the scan does not read -- the whole tree, less the
 * TypeScript sources the shared walk finds and the names above. What the two
 * guards below conclude about this workspace holds only over the files they
 * read, so a source of another extension added here is a route around them.
 */
function unreadFilesUnder(dir) {
  const scanned = new Set(sourceModules(dir));
  return filesUnder(dir).filter(
    (file) =>
      !scanned.has(file) &&
      !NON_SOURCE_FILE_NAMES.includes(posix.basename(file)),
  );
}

/**
 * Every module specifier `path` names, each with whether TypeScript erases it
 * before the file runs. A `import type` declaration and a type-only named
 * import both erase; a plain import, a live default binding beside a type-only
 * named list, an `export ... from`, a `require(...)` and a dynamic `import(...)`
 * do not.
 */
function specifiersOf(path) {
  const found = [];
  const record = (node, typeOnly) => {
    if (node && ts.isStringLiteral(node))
      found.push({ text: node.text, typeOnly });
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const named = clause?.namedBindings;
      const allTypeOnly =
        clause?.isTypeOnly === true ||
        (clause?.name === undefined &&
          named !== undefined &&
          ts.isNamedImports(named) &&
          named.elements.length > 0 &&
          named.elements.every((element) => element.isTypeOnly));
      record(node.moduleSpecifier, allTypeOnly === true);
    } else if (ts.isExportDeclaration(node)) {
      record(node.moduleSpecifier, node.isTypeOnly);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      record(node.arguments[0], false);
    }
    ts.forEachChild(node, visit);
  };
  visit(parseFile(path));
  return found;
}

const isRelative = (specifier) => specifier.startsWith(".");
const isBuiltin = (specifier) => specifier.startsWith("node:");

/** A specifier's package name, so a subpath import is reported under the package
 * an advisory would name. */
function packageOf(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/**
 * Every package the module graph rooted at `entry` reaches, following the
 * relative chunk imports rollup emits and stopping at anything else. Reads the
 * BUILT output, which is what a consumer resolves.
 */
function resolvedClosure(entry) {
  const external = new Set();
  const seen = new Set();
  const visit = (path) => {
    if (seen.has(path)) return;
    seen.add(path);
    for (const { text } of specifiersOf(path)) {
      if (isBuiltin(text)) continue;
      if (!isRelative(text)) {
        external.add(packageOf(text));
        continue;
      }
      visit(resolve(dirname(path), text));
    }
  };
  visit(entry);
  return [...external].sort();
}

function requireBuiltDist(file) {
  const path = join(coreDist, file);
  try {
    statSync(path);
  } catch {
    throw new Error(
      `packages/core/dist/${file} is missing, so the broker's reach cannot be ` +
        `measured. Build core first:\n\n    ${CORE_BUILD_COMMAND}\n`,
    );
  }
  return path;
}

describe("specifiersOf", () => {
  let tempRoot;
  let caseCount = 0;

  afterAll(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  });

  /** `source`'s specifiers, written to a real file so specifiersOf runs the
   * same parse and walk it runs against the broker's own source. */
  function specifiersFor(source) {
    tempRoot ??= mkdtempSync(resolve(tmpdir(), "broker-core-reach-"));
    const file = resolve(tempRoot, `case-${caseCount++}.ts`);
    writeFileSync(file, source);
    return specifiersOf(file);
  }

  it("treats a default binding beside a type-only named import as live", () => {
    expect(
      specifiersFor('import Default, { type Foo } from "mod";\nDefault;\n'),
    ).toEqual([{ text: "mod", typeOnly: false }]);
  });

  it("treats a namespace import as live", () => {
    expect(specifiersFor('import * as ns from "mod";\nns;\n')).toEqual([
      { text: "mod", typeOnly: false },
    ]);
  });

  it("treats a type-only named import with no default binding as erased", () => {
    expect(specifiersFor('import { type Foo } from "mod";\n')).toEqual([
      { text: "mod", typeOnly: true },
    ]);
  });

  it("treats an `import type` declaration as erased", () => {
    expect(specifiersFor('import type X from "mod";\n')).toEqual([
      { text: "mod", typeOnly: true },
    ]);
  });
});

describe("the broker's own source", { timeout: 60_000 }, () => {
  const files = sourceModules(BROKER_SRC);

  it("scans every file in the workspace", () => {
    // A walk that found nothing would pass every assertion below.
    expect(files.length).toBeGreaterThan(10);
  });

  it("leaves no file of the workspace unread", () => {
    const unread = unreadFilesUnder(BROKER_SRC);
    expect(
      unread,
      `${unread.length} file(s) under ${BROKER_SRC} are read by neither guard ` +
        `below. The scan walks this workspace's TypeScript sources, so a ` +
        `source of any other extension takes its imports past both. Widen the ` +
        `walk in scripts/lib/typeScriptSources.mjs to cover the file, or add ` +
        `its name to NON_SOURCE_FILE_NAMES when it can hold no import at all.`,
    ).toEqual([]);
  });

  it("names no package outside its declared runtime set", () => {
    const offenders = files.flatMap((path) =>
      specifiersOf(path)
        .filter(
          ({ text, typeOnly }) =>
            !typeOnly &&
            !isRelative(text) &&
            !isBuiltin(text) &&
            !BROKER_RUNTIME_PACKAGES.includes(text),
        )
        .map(({ text }) => `${path}: ${text}`),
    );
    expect(offenders).toEqual([]);
  });

  it("never names the @psilink/core package root", () => {
    // Held apart from the set above because a type-only root import passes that
    // one -- it erases -- while still being the import a later edit turns into a
    // value import without touching this workspace's dependency list.
    const offenders = files.flatMap((path) =>
      specifiersOf(path)
        .filter(({ text }) => text === "@psilink/core")
        .map(() => path),
    );
    expect(offenders).toEqual([]);
  });

  it("is refused by eslint when it imports the package root", async () => {
    const [result] = await eslint.lintText(
      'import { getLogger } from "@psilink/core";\nexport const log = getLogger("x");\n',
      { filePath: join(brokerSrc, "reachFixture.ts") },
    );
    const messages = result.messages.filter(
      (message) => message.ruleId === "no-restricted-imports",
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].message).toContain(CORE_SUBPATH);
  });

  it("is not refused by eslint when it imports the subpath", async () => {
    const [result] = await eslint.lintText(
      `import { sanitizeForDisplay } from "${CORE_SUBPATH}";\nexport const escape = sanitizeForDisplay;\n`,
      { filePath: join(brokerSrc, "reachFixture.ts") },
    );
    expect(
      result.messages.filter(
        (message) => message.ruleId === "no-restricted-imports",
      ),
    ).toEqual([]);
  });
});

describe("what the scan reads of a workspace tree", () => {
  const roots = [];

  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  /** A tree shaped like the broker's own -- nested TypeScript beside the
   * vendored license text -- with `extras` planted in its root. */
  function plantedTree(extras) {
    const root = mkdtempSync(resolve(tmpdir(), "broker-source-tree-"));
    roots.push(root);
    mkdirSync(join(root, "contrib"));
    writeFileSync(join(root, "standalone.ts"), 'import "ws";\n');
    writeFileSync(join(root, "contrib/index.ts"), 'import "ws";\n');
    writeFileSync(join(root, "contrib/LICENSE"), "MIT\n");
    for (const [name, text] of Object.entries(extras))
      writeFileSync(join(root, name), text);
    return root;
  }

  it("reads a tree of TypeScript and its license text whole", () => {
    expect(unreadFilesUnder(plantedTree({}))).toEqual([]);
  });

  it("reports a source of an extension the scan does not read", () => {
    const root = plantedTree({ "relay.mjs": 'import "zod";\n' });
    expect(unreadFilesUnder(root)).toEqual([posix.join(root, "relay.mjs")]);
  });
});

describe("the built @psilink/core/untrusted-text closure", () => {
  const coreDependencies = Object.keys(
    JSON.parse(readFileSync(join(coreDir, "package.json"), "utf8"))
      .dependencies,
  );

  it("reaches no package at all, on either published condition", () => {
    // Stated as an equality rather than an absence list, so a dependency added
    // to one of the modules behind the subpath fails here whatever it is called.
    expect(resolvedClosure(requireBuiltDist("untrusted-text.esm.js"))).toEqual(
      [],
    );
    expect(resolvedClosure(requireBuiltDist("untrusted-text.cjs"))).toEqual([]);
  });

  it("holds none of the packages core declares", () => {
    // The named form of the same measurement, derived from core's manifest so
    // the list cannot go stale: zod, papaparse, yaml, luxon, the PSI bindings
    // and the rest are each absent by name rather than by byte count.
    const reached = resolvedClosure(requireBuiltDist("untrusted-text.esm.js"));
    expect(reached.filter((name) => coreDependencies.includes(name))).toEqual(
      [],
    );
  });

  it("measures something: the package root does hold them", () => {
    // The canary. A walk that resolved nothing, or a chunk layout this stopped
    // following, would report an empty closure for every entry point.
    const reached = resolvedClosure(requireBuiltDist("core.esm.js"));
    expect(
      reached.filter((name) => coreDependencies.includes(name)).length,
    ).toBeGreaterThan(4);
  });
});
