import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  DECLARATION,
  REGISTRY_DOC,
  REGISTRY_HEADING,
  SOURCE_MODULE,
  checkWarningSources,
  declaredSources,
  documentedSources,
} from "./check-warning-sources.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const SCRIPT = resolve(here, "check-warning-sources.mjs");

/** A registry table holding `values`, under the heading the check reads. */
function registryDoc(values) {
  return [
    "### `warning`",
    "",
    REGISTRY_HEADING,
    "",
    "| `source` | The notice it names |",
    "| -------- | ------------------- |",
    ...values.map((value) => `| \`${value}\` | A notice. |`),
    "",
    "#### Persistence loss",
    "",
    "| `also` | a table under another heading |",
    "| ------ | ----------------------------- |",
    "| `notASource` | not in the registry section |",
  ].join("\n");
}

/** A module declaring `values` as the emitted set. */
function sourceModule(values) {
  return [
    "/** Not the registry. */",
    'export const OTHER_VALUES = ["decoy"] as const;',
    "",
    `export const ${DECLARATION} = [`,
    ...values.map((value) => `  "${value}",`),
    "] as const;",
    "",
    `export type WarningSource = (typeof ${DECLARATION})[number];`,
  ].join("\n");
}

/** A tree holding the two files the check reads, removed by the caller. */
function treeWith(declared, documented) {
  const root = mkdtempSync(join(tmpdir(), "warning-sources-"));
  mkdirSync(dirname(join(root, SOURCE_MODULE)), { recursive: true });
  mkdirSync(dirname(join(root, REGISTRY_DOC)), { recursive: true });
  writeFileSync(join(root, SOURCE_MODULE), sourceModule(declared));
  writeFileSync(join(root, REGISTRY_DOC), registryDoc(documented));
  return root;
}

const trees = [];
afterEach(() => {
  while (trees.length > 0)
    rmSync(trees.pop(), { recursive: true, force: true });
});

function tree(declared, documented) {
  const root = treeWith(declared, documented);
  trees.push(root);
  return root;
}

describe("reading each side", () => {
  it("reads the declared values and no other array's", () => {
    expect(declaredSources(SOURCE_MODULE, sourceModule(["a", "b"]))).toEqual([
      "a",
      "b",
    ]);
  });

  it("reads no values from a module without the declaration", () => {
    expect(
      declaredSources(SOURCE_MODULE, "export const SOMETHING = 1;"),
    ).toEqual([]);
  });

  it("reads the registry rows and not the header or another table", () => {
    expect(documentedSources(registryDoc(["a", "b"]))).toEqual(["a", "b"]);
  });

  it("reads no values from a document without the heading", () => {
    expect(documentedSources("# A document\n\nNo registry here.\n")).toEqual(
      [],
    );
  });
});

describe("comparing the two", () => {
  it("passes when the sets agree, whatever their order", () => {
    const { ok } = checkWarningSources({ root: tree(["a", "b"], ["b", "a"]) });
    expect(ok).toBe(true);
  });

  it("fails on a value emitted but not in the registry", () => {
    const { ok, message } = checkWarningSources({
      root: tree(["a", "b"], ["a"]),
    });
    expect(ok).toBe(false);
    expect(message).toContain("emitted but not in the registry: b");
  });

  it("fails on a registry row nothing emits", () => {
    const { ok, message } = checkWarningSources({
      root: tree(["a"], ["a", "b"]),
    });
    expect(ok).toBe(false);
    expect(message).toContain("in the registry but not emitted: b");
  });

  it("fails when the declaration is gone", () => {
    const root = tree(["a"], ["a"]);
    writeFileSync(join(root, SOURCE_MODULE), "export const NOTHING = 1;");
    const { ok, message } = checkWarningSources({ root });
    expect(ok).toBe(false);
    expect(message).toContain(DECLARATION);
  });

  it("fails when the registry table is gone", () => {
    const root = tree(["a"], ["a"]);
    writeFileSync(join(root, REGISTRY_DOC), "# No registry\n");
    const { ok, message } = checkWarningSources({ root });
    expect(ok).toBe(false);
    expect(message).toContain(REGISTRY_HEADING);
  });
});

describe("this repository", () => {
  it("passes, run as CI runs it", () => {
    expect(() =>
      execFileSync(process.execPath, [SCRIPT], {
        cwd: repoRoot,
        encoding: "utf8",
      }),
    ).not.toThrow();
  });

  it("exits non-zero on a tree whose sets disagree", () => {
    const root = tree(["a", "b"], ["a"]);
    expect(() =>
      execFileSync(process.execPath, [SCRIPT, "--root", root], {
        encoding: "utf8",
        stdio: "pipe",
      }),
    ).toThrow();
  });
});
