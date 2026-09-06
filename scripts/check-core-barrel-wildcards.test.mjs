import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  CORE_BARREL,
  checkCoreBarrelWildcards,
  readBarrel,
  wildcardReExports,
} from "./check-core-barrel-wildcards.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const SCRIPT = resolve(here, "check-core-barrel-wildcards.mjs");

/** Parses synthetic barrel text under the real barrel's name. */
function findings(text) {
  return wildcardReExports(CORE_BARREL, text);
}

describe("wildcardReExports over synthetic barrel text", () => {
  it("finds nothing in a list of named re-exports", () => {
    expect(
      findings(
        [
          'export { runExchange } from "./exchange";',
          'export type { ExchangeResult } from "./exchange";',
          "export {",
          "  ConnectionError,",
          "  fromEventConnection,",
          '} from "./connection/messageConnection";',
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("finds a blanket re-export", () => {
    const found = findings(
      [
        'export { runExchange } from "./exchange";',
        'export * from "./file";',
      ].join("\n"),
    );
    expect(found).toHaveLength(1);
    expect(found[0].module).toBe('"./file"');
    expect(found[0].statement).toBe('export * from "./file";');
  });

  it("finds a namespace re-export", () => {
    const found = findings('export * as config from "./config";');
    expect(found).toHaveLength(1);
    expect(found[0].module).toBe('"./config"');
    expect(found[0].statement).toBe('export * as config from "./config";');
  });

  it("finds a type-only blanket re-export", () => {
    const found = findings('export type * from "./types";');
    expect(found).toHaveLength(1);
    expect(found[0].statement).toBe('export type * from "./types";');
  });

  it("finds every wildcard, not just the first", () => {
    const found = findings(
      [
        'export * from "./file";',
        'export { runExchange } from "./exchange";',
        'export * as psi from "./psi/link";',
      ].join("\n"),
    );
    expect(found.map((site) => site.module)).toEqual([
      '"./file"',
      '"./psi/link"',
    ]);
  });

  it("reads a wildcard spelled across several lines", () => {
    const found = findings(
      ["export *", "  as psi", '  from "./psi/link";'].join("\n"),
    );
    expect(found).toHaveLength(1);
    expect(found[0].statement).toBe('export * as psi from "./psi/link";');
  });

  it("states the line the wildcard sits on", () => {
    const found = findings(
      ["// a leading comment", "", 'export * from "./file";'].join("\n"),
    );
    expect(found[0].line).toBe(3);
  });

  it("does not read a wildcard written in a comment or a string", () => {
    expect(
      findings(
        [
          '// export * from "./file";',
          '/* export * from "./file"; */',
          "export const banned = 'export * from \"./file\";';",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("does not read a local export or an import wildcard as a re-export", () => {
    expect(
      findings(
        [
          'import * as ts from "typescript";',
          "export const VERSION = 1;",
          "export { VERSION as PROTOCOL_VERSION };",
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});

describe("checkCoreBarrelWildcards against an injected read", () => {
  it("passes a barrel of named re-exports", () => {
    const result = checkCoreBarrelWildcards({
      root: "unused",
      read: () => 'export { runExchange } from "./exchange";\n',
    });
    expect(result).toEqual({
      ok: true,
      message: `${CORE_BARREL} re-exports every name it publishes explicitly.`,
    });
  });

  it("fails a barrel holding a wildcard, naming the line and the subpath", () => {
    const result = checkCoreBarrelWildcards({
      root: "unused",
      read: () => 'export * from "./file";\n',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('export * from "./file";');
    expect(result.message).toMatch(/line 1/);
    expect(result.message).toMatch(/\.\/testing/);
  });
});

describe("the real repository barrel", () => {
  it("parses and holds no wildcard re-export today", () => {
    expect(wildcardReExports(CORE_BARREL, readBarrel(repoRoot))).toEqual([]);
  });
});

describe("the CLI entry, driven against a fixture tree", () => {
  const roots = [];

  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  /** A minimal tree holding only packages/core/src/main.ts. */
  function fixtureTree(barrel) {
    const root = mkdtempSync(join(tmpdir(), "psilink-core-barrel-wildcards-"));
    roots.push(root);
    const barrelDirectory = join(root, "packages", "core", "src");
    mkdirSync(barrelDirectory, { recursive: true });
    writeFileSync(join(barrelDirectory, "main.ts"), `${barrel}\n`);
    return root;
  }

  function runCheck(root) {
    try {
      const stdout = execFileSync(process.execPath, [SCRIPT, "--root", root], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      return { status: 0, stdout, stderr: "" };
    } catch (error) {
      return {
        status: error.status,
        stdout: error.stdout,
        stderr: error.stderr,
      };
    }
  }

  it("exits 0 for a fixture barrel of named re-exports", () => {
    const root = fixtureTree('export { runExchange } from "./exchange";');
    const result = runCheck(root);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/passed/);
  });

  it("exits 1 for a fixture barrel holding a wildcard", () => {
    const root = fixtureTree('export * from "./file";');
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/wildcard/);
    expect(result.stderr).toContain('export * from "./file";');
  });

  it("exits 2 when --root is given no tree", () => {
    try {
      execFileSync(process.execPath, [SCRIPT, "--root"], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      expect.unreachable("the check accepted a bare --root");
    } catch (error) {
      expect(error.status).toBe(2);
      expect(error.stderr).toMatch(/usage:/);
    }
  });

  it("passes against this repository with no --root", () => {
    const stdout = execFileSync(process.execPath, [SCRIPT], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(stdout).toMatch(/passed/);
  });
});
