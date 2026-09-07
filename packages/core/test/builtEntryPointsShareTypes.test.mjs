// The published declaration files, as a consumer's TypeScript reads them: the
// built `@psilink/core` and `@psilink/core/testing`, not this source tree. Plain
// JavaScript because that is what the artifacts are.
//
// PreparedExchange, ExchangeResult, and the StandardizedDataset class the first
// holds reach both entries. A fixture the testing entry returns only assigns to a
// main-entry parameter while ONE declaration of each is emitted, so the two
// entries' declarations build together (packages/core/rollup.config.ts). Built as
// separate dts passes they each get their own copy, and TypeScript treats two
// copies of a class with a private member as different types. The source tree has
// one copy either way, so no source-level test sees the split.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, expect, test } from "vitest";

import {
  CORE_DIR,
  describeCoreDistStaleness,
  formatCoreDistStaleness,
} from "../../../scripts/lib/coreDistFreshness.mjs";

// The types both published entries reach, whose identity the shared declaration
// build holds.
const SHARED_TYPES = [
  "PreparedExchange",
  "ExchangeResult",
  "StandardizedDataset",
];

const DIST_DIR = join(CORE_DIR, "dist");

/** Every declaration file the build emits, by file name. */
function emittedDeclarations() {
  const names = readdirSync(DIST_DIR).filter((name) => name.endsWith(".d.ts"));
  return new Map(
    names.map((name) => [name, readFileSync(join(DIST_DIR, name), "utf8")]),
  );
}

function declaresType(source, name) {
  return new RegExp(
    `^(?:declare )?(?:abstract class|class|interface|type) ${name}\\b`,
    "m",
  ).test(source);
}

// The local names an import clause with a relative specifier brings in, paired
// with the declaration file that specifier names (rollup writes the runtime
// `.js` specifier beside the `.d.ts` it emits).
function relativeImports(source) {
  const imports = [];
  const clause = /import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]*)['"]/g;
  for (const [, names, specifier] of source.matchAll(clause)) {
    const from = specifier.replace(/^\.\//, "").replace(/\.js$/, ".d.ts");
    for (const entry of names.split(",")) {
      const local = entry
        .trim()
        .split(/\s+as\s+/)
        .pop();
      if (local !== "") imports.push({ local, from });
    }
  }
  return imports;
}

beforeAll(() => {
  const staleness = describeCoreDistStaleness();
  if (staleness !== null) throw new Error(formatCoreDistStaleness(staleness));
});

test("each type both entries reach is declared once across the built declarations", () => {
  const declarations = emittedDeclarations();

  const redeclared = SHARED_TYPES.map((name) => [
    name,
    [...declarations]
      .filter(([, source]) => declaresType(source, name))
      .map(([file]) => file),
  ]).filter(([, files]) => files.length !== 1);

  expect(redeclared).toEqual([]);
});

test("the testing entry imports the types it shares with the main entry", () => {
  const declarations = emittedDeclarations();
  const imported = relativeImports(declarations.get("testing.d.ts"));

  for (const name of ["PreparedExchange", "ExchangeResult"]) {
    const source = imported.find((entry) => entry.local === name);
    expect(source?.from).toBeDefined();
    expect([...declarations.keys()]).toContain(source.from);
  }
});
