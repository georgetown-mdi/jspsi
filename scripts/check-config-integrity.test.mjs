import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import {
  GUARDED_TSCONFIGS,
  GUARDED_VITEST_CONFIGS,
  checkConfigIntegrity,
  listProjects,
  resolveTsconfig,
  sourceFilesUnder,
  tsconfigViolations,
  vitestViolations,
} from "./check-config-integrity.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const SCRIPT = resolve(here, "check-config-integrity.mjs");

// Driving the real tsc and vitest costs seconds per case, well past vitest's
// default per-test timeout.
const TOOL_TIMEOUT = 120_000;

const fixtureRoots = [];

/** A scratch directory removed when the file finishes. */
function scratchDirectory() {
  const root = mkdtempSync(join(tmpdir(), "alcove-config-integrity-"));
  fixtureRoots.push(root);
  return root;
}

afterAll(() => {
  for (const root of fixtureRoots)
    rmSync(root, { recursive: true, force: true });
});

describe("tsconfigViolations", () => {
  const guard = {
    tsconfig: "packages/core/tsconfig.json",
    sourceDirectory: "packages/core/src",
    options: { strict: true, noUnusedLocals: true },
  };

  it("finds nothing when the options resolve and the file list covers src", () => {
    expect(
      tsconfigViolations(
        guard,
        {
          options: { strict: true, noUnusedLocals: true },
          files: ["/repo/packages/core/src/main.ts"],
        },
        ["/repo/packages/core/src/main.ts"],
      ),
    ).toEqual([]);
  });

  it("reports an option the resolved config no longer sets", () => {
    const [violation, ...rest] = tsconfigViolations(
      guard,
      { options: { noUnusedLocals: true }, files: ["/repo/a.ts"] },
      ["/repo/a.ts"],
    );
    expect(rest).toEqual([]);
    expect(violation).toContain("strict resolves to undefined, not true");
  });

  it("reports an option resolved to the wrong value", () => {
    const violations = tsconfigViolations(
      guard,
      {
        options: { strict: false, noUnusedLocals: true },
        files: ["/repo/a.ts"],
      },
      ["/repo/a.ts"],
    );
    expect(violations[0]).toContain("strict resolves to false, not true");
  });

  it("reports source files the resolved file list leaves out", () => {
    const violations = tsconfigViolations(
      guard,
      {
        options: { strict: true, noUnusedLocals: true },
        files: ["/repo/packages/core/src/main.ts"],
      },
      ["/repo/packages/core/src/main.ts", "/repo/packages/core/src/psi.ts"],
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("1 of 2 files");
    expect(violations[0]).toContain("/repo/packages/core/src/psi.ts");
  });

  it("reports a source directory holding nothing to compile", () => {
    const violations = tsconfigViolations(
      guard,
      { options: { strict: true, noUnusedLocals: true }, files: [] },
      [],
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("holds no TypeScript source");
  });
});

describe("vitestViolations", () => {
  const guard = { directory: "packages/core", projects: ["unit", "stress"] };

  it("finds nothing when every named project listed a file", () => {
    expect(
      vitestViolations(
        guard,
        new Map([
          ["unit", 147],
          ["stress", 2],
        ]),
      ),
    ).toEqual([]);
  });

  it("reports a missing project and names what was listed instead", () => {
    const [violation] = vitestViolations(
      guard,
      new Map([["@alcove/core", 149]]),
    );
    expect(violation).toContain('"unit", "stress"');
    expect(violation).toContain('It listed "@alcove/core"');
  });

  it("reports a listing that turned up no project at all", () => {
    const [violation] = vitestViolations(guard, new Map());
    expect(violation).toContain("It listed no project");
  });
});

describe("sourceFilesUnder", () => {
  it("walks nested directories and leaves declaration files out", () => {
    const root = scratchDirectory();
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "one.ts"), "export const one = 1;\n");
    writeFileSync(
      join(root, "types.d.ts"),
      "export declare const two: number;\n",
    );
    writeFileSync(join(root, "notes.md"), "not source\n");
    writeFileSync(
      join(root, "nested", "three.tsx"),
      "export const three = 3;\n",
    );
    expect(sourceFilesUnder(root).sort()).toEqual([
      join(root, "nested", "three.tsx"),
      join(root, "one.ts"),
    ]);
  });

  it("returns nothing for a directory that is not there", () => {
    expect(sourceFilesUnder(join(scratchDirectory(), "absent"))).toEqual([]);
  });
});

describe("checkConfigIntegrity over injected resolvers", () => {
  const tsconfigs = [
    {
      tsconfig: "packages/core/tsconfig.json",
      sourceDirectory: "packages/core/src",
      options: { strict: true },
    },
  ];
  const vitestConfigs = [{ directory: ".", projects: ["unit"] }];

  it("passes when both halves hold, counting what it held", () => {
    const result = checkConfigIntegrity({
      root: "/repo",
      tsconfigs,
      vitestConfigs,
      resolveConfig: () => ({ options: { strict: true }, files: ["/a.ts"] }),
      listVitestProjects: () => new Map([["unit", 3]]),
      sourceFiles: () => ["/a.ts"],
    });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("1 tsconfigs");
    expect(result.message).toContain("1 vitest configs");
  });

  it("fails on a clobbered tsconfig, and says to restore the config", () => {
    const result = checkConfigIntegrity({
      root: "/repo",
      tsconfigs,
      vitestConfigs,
      resolveConfig: () => ({ options: {}, files: [] }),
      listVitestProjects: () => new Map([["unit", 3]]),
      sourceFiles: () => ["/a.ts"],
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("strict resolves to undefined");
    expect(result.message).toContain(
      "Restore the config rather than the check",
    );
  });

  it("fails on a vitest config that lost its projects", () => {
    const result = checkConfigIntegrity({
      root: "/repo",
      tsconfigs,
      vitestConfigs,
      resolveConfig: () => ({ options: { strict: true }, files: ["/a.ts"] }),
      listVitestProjects: () => new Map(),
      sourceFiles: () => ["/a.ts"],
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain(
      'no project with a test file named "unit"',
    );
  });

  it("reports every violation, not the first", () => {
    const result = checkConfigIntegrity({
      root: "/repo",
      tsconfigs,
      vitestConfigs,
      resolveConfig: () => ({ options: {}, files: [] }),
      listVitestProjects: () => new Map(),
      sourceFiles: () => ["/a.ts"],
    });
    expect(result.message).toContain("strict resolves to undefined");
    expect(result.message).toContain('named "unit"');
  });
});

describe("resolveTsconfig against the real compiler", () => {
  /** A tsconfig and one source file under a scratch root. */
  function tsconfigTree(config) {
    const root = scratchDirectory();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "index.ts"), "export const value = 1;\n");
    writeFileSync(join(root, "tsconfig.json"), `${JSON.stringify(config)}\n`);
    return root;
  }

  it(
    "resolves an option written in the config and lists its source",
    { timeout: TOOL_TIMEOUT },
    () => {
      const root = tsconfigTree({
        compilerOptions: { strict: true },
        include: ["src/**/*.ts"],
      });
      const resolved = resolveTsconfig(join(root, "tsconfig.json"));
      expect(resolved.options.strict).toBe(true);
      expect(resolved.files).toEqual([join(root, "src", "index.ts")]);
    },
  );

  it(
    "resolves an option the config inherits through extends",
    { timeout: TOOL_TIMEOUT },
    () => {
      const root = tsconfigTree({
        extends: "./base.json",
        include: ["src/**/*.ts"],
      });
      writeFileSync(
        join(root, "base.json"),
        `${JSON.stringify({ compilerOptions: { strict: true } })}\n`,
      );
      expect(resolveTsconfig(join(root, "tsconfig.json")).options.strict).toBe(
        true,
      );
    },
  );

  it(
    "shows a config emptied to a stub as setting no strictness",
    { timeout: TOOL_TIMEOUT },
    () => {
      const root = tsconfigTree({});
      const resolved = resolveTsconfig(join(root, "tsconfig.json"));
      const violations = tsconfigViolations(
        {
          tsconfig: "tsconfig.json",
          sourceDirectory: "src",
          options: { strict: true },
        },
        resolved,
        [join(root, "src", "index.ts")],
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("strict resolves to undefined");
    },
  );
});

describe("listProjects against the real vitest", () => {
  /**
   * A scratch tree vitest runs in: two test files, and this repository's
   * installed packages linked in so the config's `vitest/config` import
   * resolves.
   */
  function vitestTree(config) {
    const root = scratchDirectory();
    symlinkSync(join(repoRoot, "node_modules"), join(root, "node_modules"));
    for (const directory of ["alpha", "beta"]) {
      mkdirSync(join(root, directory));
      writeFileSync(
        join(root, directory, "case.test.mjs"),
        'import { expect, it } from "vitest";\nit("holds", () => expect(1).toBe(1));\n',
      );
    }
    writeFileSync(join(root, "vitest.config.mjs"), config);
    return root;
  }

  it(
    "names every project the config declares",
    { timeout: TOOL_TIMEOUT },
    () => {
      const root = vitestTree(
        [
          'import { defineConfig } from "vitest/config";',
          "export default defineConfig({",
          "  test: {",
          "    projects: [",
          '      { test: { name: "alpha", include: ["alpha/**/*.test.mjs"] } },',
          '      { test: { name: "beta", include: ["beta/**/*.test.mjs"] } },',
          "    ],",
          "  },",
          "});",
        ].join("\n"),
      );
      const listed = listProjects(root);
      expect(listed.get("alpha")).toBe(1);
      expect(listed.get("beta")).toBe(1);
    },
  );

  it(
    "shows a config emptied to a stub as declaring none of them",
    { timeout: TOOL_TIMEOUT },
    () => {
      const root = vitestTree("export default {};\n");
      const violations = vitestViolations(
        { directory: root, projects: ["alpha", "beta"] },
        listProjects(root),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain('"alpha", "beta"');
    },
  );

  it(
    "declares a project whose include matches nothing to be absent",
    { timeout: TOOL_TIMEOUT },
    () => {
      const root = vitestTree(
        [
          'import { defineConfig } from "vitest/config";',
          "export default defineConfig({",
          "  test: {",
          "    projects: [",
          '      { test: { name: "alpha", include: ["alpha/**/*.test.mjs"] } },',
          '      { test: { name: "beta", include: ["gone/**/*.test.mjs"] } },',
          "    ],",
          "  },",
          "});",
        ].join("\n"),
      );
      const violations = vitestViolations(
        { directory: root, projects: ["alpha", "beta"] },
        listProjects(root),
      );
      expect(violations[0]).toContain('"beta"');
      expect(violations[0]).toContain('It listed "alpha"');
    },
  );
});

describe("the guarded tables", () => {
  it("names a tsconfig and a source directory that are both in the tree", () => {
    for (const guard of GUARDED_TSCONFIGS) {
      expect(
        sourceFilesUnder(resolve(repoRoot, guard.sourceDirectory)).length,
      ).toBeGreaterThan(0);
      expect(Object.keys(guard.options).length).toBeGreaterThan(0);
    }
  });

  it("guards the root vitest config, the one that registers the outside projects", () => {
    const rootGuard = GUARDED_VITEST_CONFIGS.find(
      (guard) => guard.directory === ".",
    );
    expect(rootGuard?.projects).toEqual(
      expect.arrayContaining(["harness", "scripts", "hooks", "repo-scripts"]),
    );
  });
});

describe("the CLI entry against this repository", () => {
  it("passes on the tree as committed", { timeout: TOOL_TIMEOUT }, () => {
    const stdout = execFileSync(process.execPath, [SCRIPT], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(stdout).toMatch(/passed/);
  });
});
