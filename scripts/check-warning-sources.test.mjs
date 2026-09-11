import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  REGISTRIES,
  checkWarningSources,
  declaredSources,
  documentedSources,
} from "./check-warning-sources.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const SCRIPT = resolve(here, "check-warning-sources.mjs");

const [CLI_REGISTRY, RELAY_REGISTRY] = REGISTRIES;

/** A registry table holding `values`, under the heading `registry` reads. */
function registryDoc(registry, values) {
  return [
    "### `warning`",
    "",
    registry.heading,
    "",
    "| `source` | The notice it names |",
    "| -------- | ------------------- |",
    ...values.map((value) => `| \`${value}\` | A notice. |`),
    "",
    "#### Another section",
    "",
    "| `also` | a table under another heading |",
    "| ------ | ----------------------------- |",
    "| `notASource` | not in the registry section |",
  ].join("\n");
}

/** A module declaring `values` as the set `registry` emits. */
function sourceModule(registry, values) {
  return [
    "/** Not the registry. */",
    'export const OTHER_VALUES = ["decoy"] as const;',
    "",
    `export const ${registry.declaration} = [`,
    ...values.map((value) => `  "${value}",`),
    "] as const;",
    "",
    `export type OneSource = (typeof ${registry.declaration})[number];`,
  ].join("\n");
}

/** Write one registry's two files into the tree at `root`. */
function writeRegistry(root, registry, declared, documented) {
  for (const file of [registry.module, registry.doc])
    mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, registry.module), sourceModule(registry, declared));
  writeFileSync(join(root, registry.doc), registryDoc(registry, documented));
}

/**
 * A tree holding every registry's two files, removed by the caller. Each entry
 * of `sets` is the `[declared, documented]` pair for the registry at the same
 * index; an omitted entry takes an agreeing default whose one value is that
 * registry's alone, so a test states only the registry it is exercising and no
 * default collides with another's.
 */
function treeWith(sets) {
  const root = mkdtempSync(join(tmpdir(), "warning-sources-"));
  REGISTRIES.forEach((registry, index) => {
    const fallback = [`default${index}`];
    const [declared, documented] = sets[index] ?? [fallback, fallback];
    writeRegistry(root, registry, declared, documented);
  });
  return root;
}

const trees = [];
afterEach(() => {
  while (trees.length > 0)
    rmSync(trees.pop(), { recursive: true, force: true });
});

function tree(sets = []) {
  const root = treeWith(sets);
  trees.push(root);
  return root;
}

/** The pair list that gives `registry` these sets and every other the default. */
function only(registry, declared, documented) {
  return REGISTRIES.map((candidate) =>
    candidate === registry ? [declared, documented] : undefined,
  );
}

describe("reading each side", () => {
  it("reads the declared values and no other array's", () => {
    expect(
      declaredSources(
        CLI_REGISTRY.module,
        sourceModule(CLI_REGISTRY, ["a", "b"]),
        CLI_REGISTRY.declaration,
      ),
    ).toEqual(["a", "b"]);
  });

  it("reads no values from a module without the declaration", () => {
    expect(
      declaredSources(
        CLI_REGISTRY.module,
        "export const SOMETHING = 1;",
        CLI_REGISTRY.declaration,
      ),
    ).toEqual([]);
  });

  it("reads each declaration only under its own name", () => {
    expect(
      declaredSources(
        RELAY_REGISTRY.module,
        sourceModule(CLI_REGISTRY, ["a"]),
        RELAY_REGISTRY.declaration,
      ),
    ).toEqual([]);
  });

  it("reads the registry rows and not the header or another table", () => {
    expect(
      documentedSources(
        registryDoc(CLI_REGISTRY, ["a", "b"]),
        CLI_REGISTRY.heading,
      ),
    ).toEqual(["a", "b"]);
  });

  it("reads no values from a document without the heading", () => {
    expect(
      documentedSources("# A document\n\nNo registry here.\n", "## Missing"),
    ).toEqual([]);
  });
});

describe.each(REGISTRIES)("comparing the two sides of $stream", (registry) => {
  it("passes when the sets agree, whatever their order", () => {
    const { ok } = checkWarningSources({
      root: tree(only(registry, ["a", "b"], ["b", "a"])),
    });
    expect(ok).toBe(true);
  });

  it("fails on a value emitted but not in the registry", () => {
    const { ok, message } = checkWarningSources({
      root: tree(only(registry, ["a", "b"], ["a"])),
    });
    expect(ok).toBe(false);
    expect(message).toContain("emitted but not in the registry: b");
    expect(message).toContain(registry.stream);
  });

  it("fails on a registry row nothing emits", () => {
    const { ok, message } = checkWarningSources({
      root: tree(only(registry, ["a"], ["a", "b"])),
    });
    expect(ok).toBe(false);
    expect(message).toContain("in the registry but not emitted: b");
    expect(message).toContain(registry.declaration);
  });

  it("fails when the declaration is gone", () => {
    const root = tree();
    writeFileSync(join(root, registry.module), "export const NOTHING = 1;");
    const { ok, message } = checkWarningSources({ root });
    expect(ok).toBe(false);
    expect(message).toContain(registry.declaration);
  });

  it("fails when the registry table is gone", () => {
    const root = tree();
    writeFileSync(join(root, registry.doc), "# No registry\n");
    const { ok, message } = checkWarningSources({ root });
    expect(ok).toBe(false);
    expect(message).toContain(registry.heading);
  });
});

describe("comparing the registries against each other", () => {
  it("fails on a relay value the CLI emits too", () => {
    const { ok, message } = checkWarningSources({
      root: tree([
        [
          ["shared", "cliOnly"],
          ["shared", "cliOnly"],
        ],
        [
          ["shared", "relayOnly"],
          ["shared", "relayOnly"],
        ],
      ]),
    });
    expect(ok).toBe(false);
    expect(message).toContain("on both streams: shared");
    expect(message).not.toContain("cliOnly");
  });

  it("passes on disjoint sets that each agree with their spec", () => {
    const { ok } = checkWarningSources({
      root: tree([
        [["cliOnly"], ["cliOnly"]],
        [["relayOnly"], ["relayOnly"]],
      ]),
    });
    expect(ok).toBe(true);
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
    const root = tree(only(RELAY_REGISTRY, ["a", "b"], ["a"]));
    expect(() =>
      execFileSync(process.execPath, [SCRIPT, "--root", root], {
        encoding: "utf8",
        stdio: "pipe",
      }),
    ).toThrow();
  });
});
