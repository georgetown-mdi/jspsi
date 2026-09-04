import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assess,
  splitCopies,
  topLevelInstalls,
  workspaceDirectories,
} from "./check-nested-root-package.mjs";
import { CHECKS } from "./run-checks.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const readRoot = (name) =>
  readFileSync(resolve(repoRoot, name), { encoding: "utf8" });
const readRootJson = (name) => JSON.parse(readRoot(name));

/** A lockfile of the shape npm writes for this repository's workspaces. */
function lockfile({ workspaces = ["apps/web"], packages = {} } = {}) {
  const entries = { "": { name: "jspsi", version: "0.0.0" } };
  for (const workspace of workspaces) {
    entries[workspace] = { name: workspace, version: "0.1.0" };
  }
  return { lockfileVersion: 3, packages: { ...entries, ...packages } };
}

/**
 * The committed lockfile with the split the vite ^8.1.4 -> ^8.1.5 bump left
 * recorded in it: the stale hoisted copy kept at the root, the raised version
 * nested under the workspace that asked for it.
 */
function committedLockWithViteSplit() {
  const lock = structuredClone(readRootJson("package-lock.json"));
  lock.packages["node_modules/vite"] = {
    ...lock.packages["node_modules/vite"],
    version: "8.1.4",
  };
  lock.packages["apps/web/node_modules/vite"] = {
    version: "8.1.5",
    dev: true,
  };
  return lock;
}

const linesOf = (lock, allowlist) => assess(lock, allowlist).lines.join("\n");

describe("what the lockfile records", () => {
  it("reads the workspaces off the keys outside every node_modules", () => {
    expect(
      workspaceDirectories(
        lockfile({
          workspaces: ["apps/cli", "packages/core"],
          packages: { "node_modules/vite": { version: "8.2.1" } },
        }),
      ),
    ).toEqual(["apps/cli", "packages/core"]);
  });

  it("reads only the top level of a node_modules directory", () => {
    const lock = lockfile({
      packages: {
        "node_modules/vite": { version: "8.2.1" },
        "node_modules/@scope/tool": { version: "1.0.0" },
        "node_modules/@scope/tool/node_modules/vite": { version: "7.0.0" },
        "apps/web/node_modules/plugin": { version: "1.0.0" },
        "apps/web/node_modules/plugin/node_modules/vite": { version: "6.0.0" },
      },
    });
    expect([...topLevelInstalls(lock, "").keys()]).toEqual([
      "vite",
      "@scope/tool",
    ]);
    expect([...topLevelInstalls(lock, "apps/web").keys()]).toEqual(["plugin"]);
  });
});

describe("the verdict", () => {
  it("fires on the split the measured vite bump left", () => {
    const verdict = assess(committedLockWithViteSplit());
    expect(verdict.ok).toBe(false);
    const message = verdict.lines.join("\n");
    expect(message).toContain("vite is split across the workspace boundary");
    expect(message).toContain("apps/web/node_modules/vite installs 8.1.5");
    expect(message).toContain("node_modules/vite installs 8.1.4");
    expect(message).toContain("npm install --package-lock-only");
    expect(message).toContain("docs/spec/DEPENDENCY_PINS.md");
  });

  it("fires when the two copies have the same version", () => {
    const verdict = assess(
      lockfile({
        packages: {
          "node_modules/vite": { version: "8.2.1" },
          "apps/web/node_modules/vite": { version: "8.2.1" },
        },
      }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.lines.join("\n")).toContain(
      "apps/web/node_modules/vite installs 8.2.1 while node_modules/vite installs 8.2.1",
    );
  });

  it("passes over a workspace copy the root does not hold", () => {
    const verdict = assess(
      lockfile({
        workspaces: ["apps/cli", "apps/web"],
        packages: {
          "apps/cli/node_modules/tsx": { version: "4.23.12" },
          "apps/web/node_modules/@mantine/core": { version: "9.5.1" },
        },
      }),
    );
    expect(verdict.ok, verdict.lines.join("\n")).toBe(true);
  });

  it("passes over a copy nested under another package, either side", () => {
    const verdict = assess(
      lockfile({
        packages: {
          "node_modules/semver": { version: "6.3.1" },
          "node_modules/nitropack": { version: "2.13.4" },
          "node_modules/nitropack/node_modules/semver": { version: "7.7.4" },
          "apps/web/node_modules/plugin": { version: "1.0.0" },
          "apps/web/node_modules/plugin/node_modules/semver": {
            version: "7.8.5",
          },
        },
      }),
    );
    expect(verdict.ok, verdict.lines.join("\n")).toBe(true);
  });

  it("names every split, across workspaces and scoped names", () => {
    const verdict = assess(
      lockfile({
        workspaces: ["apps/cli", "apps/web"],
        packages: {
          "node_modules/vite": { version: "8.2.1" },
          "node_modules/@noble/curves": { version: "2.3.0" },
          "apps/web/node_modules/vite": { version: "8.2.2" },
          "apps/cli/node_modules/@noble/curves": { version: "1.9.7" },
        },
      }),
    );
    expect(verdict.ok).toBe(false);
    const message = verdict.lines.join("\n");
    expect(message).toContain("2 packages");
    expect(message).toContain(
      "@noble/curves is split across the workspace boundary",
    );
    expect(message).toContain("vite is split across the workspace boundary");
  });

  it("describes a linked root copy as the link it is", () => {
    expect(
      linesOf(
        lockfile({
          workspaces: ["apps/web", "packages/core"],
          packages: {
            "node_modules/@psilink/core": {
              resolved: "packages/core",
              link: true,
            },
            "apps/web/node_modules/@psilink/core": { version: "0.0.9" },
          },
        }),
      ),
    ).toContain(
      "apps/web/node_modules/@psilink/core installs 0.0.9 while node_modules/@psilink/core links packages/core",
    );
  });

  it("still names a copy whose entry has neither version nor link", () => {
    expect(
      linesOf(
        lockfile({
          packages: {
            "node_modules/vite": {},
            "apps/web/node_modules/vite": { version: "8.2.1" },
          },
        }),
      ),
    ).toContain("node_modules/vite installs an entry carrying no version");
  });
});

describe("the allowlist", () => {
  const split = lockfile({
    workspaces: ["apps/cli", "apps/web"],
    packages: {
      "node_modules/ws": { version: "8.21.3" },
      "apps/web/node_modules/ws": { version: "7.5.10" },
      "apps/cli/node_modules/ws": { version: "6.2.3" },
    },
  });

  it("suppresses the split it names and states the reason on the pass", () => {
    const only = lockfile({
      packages: {
        "node_modules/ws": { version: "8.21.3" },
        "apps/web/node_modules/ws": { version: "7.5.10" },
      },
    });
    const verdict = assess(only, {
      "apps/web/node_modules/ws": "the browser suite pins the 7 line",
    });
    expect(verdict.ok, verdict.lines.join("\n")).toBe(true);
    expect(verdict.lines.join("\n")).toContain(
      "apps/web/node_modules/ws stands by design: the browser suite pins the 7 line",
    );
  });

  it("suppresses only the path it names", () => {
    const verdict = assess(split, {
      "apps/web/node_modules/ws": "the browser suite pins the 7 line",
    });
    expect(verdict.ok).toBe(false);
    const message = verdict.lines.join("\n");
    expect(message).toContain("apps/cli/node_modules/ws installs 6.2.3");
    expect(message).not.toContain("apps/web/node_modules/ws installs 7.5.10");
  });

  it("fails on an entry naming no split the lockfile holds", () => {
    const verdict = assess(lockfile(), {
      "apps/web/node_modules/ws": "long since re-resolved",
    });
    expect(verdict.ok).toBe(false);
    const message = verdict.lines.join("\n");
    expect(message).toContain("does not carry as a split");
    expect(message).toContain("apps/web/node_modules/ws");
    expect(message).toContain("scripts/check-nested-root-package.mjs");
  });

  it("refuses an entry holding no reason", () => {
    for (const reason of ["", "   ", true, undefined]) {
      const verdict = assess(split, { "apps/web/node_modules/ws": reason });
      expect(verdict.ok, String(reason)).toBe(false);
      expect(verdict.lines.join("\n")).toContain(
        "apps/web/node_modules/ws is allowed with no reason given",
      );
    }
  });
});

describe("what it refuses to answer for", () => {
  it("refuses a shared directory holding a different package on each side", () => {
    const verdict = assess(
      lockfile({
        packages: {
          "node_modules/string-width": {
            name: "string-width-fork",
            version: "4.2.3",
          },
          "apps/web/node_modules/string-width": { version: "7.2.0" },
        },
      }),
    );
    expect(verdict.ok).toBe(false);
    const message = verdict.lines.join("\n");
    expect(message).toContain(
      "apps/web/node_modules/string-width holds string-width and node_modules/string-width holds string-width-fork",
    );
    expect(message).toContain("scripts/check-nested-root-package.mjs");
  });

  it("refuses a lockfile containing no packages map", () => {
    const verdict = assess({ lockfileVersion: 1 });
    expect(verdict.ok).toBe(false);
    expect(verdict.lines.join("\n")).toContain("no `packages` map");
  });
});

describe("the real repository", () => {
  it("has no package split across the workspace boundary", () => {
    const verdict = assess(readRootJson("package-lock.json"));
    expect(verdict.ok, verdict.lines.join("\n")).toBe(true);
  });

  it("leaves the root's own aliased copies alone", () => {
    const lock = readRootJson("package-lock.json");
    const rootInstalls = topLevelInstalls(lock, "");
    expect(rootInstalls.get("string-width-cjs").entry.name).toBe(
      "string-width",
    );
    expect(splitCopies(lock)).toEqual([]);
  });

  it("exits 0 from the CLI entry point", () => {
    const output = execFileSync(
      process.execPath,
      [resolve(here, "check-nested-root-package.mjs")],
      { encoding: "utf8" },
    );
    expect(output).toContain("Nested root-package check passed");
  });

  it("exits 1 from the CLI entry point over a split lockfile", () => {
    // Realpath, because the entry guard compares process.argv[1] -- the path as
    // spelled on the command line -- against a module URL node has already
    // resolved through its symlinks. Where the system temporary directory is
    // itself a symlink, as macOS's /var is, the unresolved path misses the guard
    // and the copy exits 0 without ever running the check.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "nested-root-")));
    try {
      // The entry reads its input from the directory above itself, so a copy
      // under a fixture lockfile is what puts the failing branch on a process.
      mkdirSync(join(root, "scripts"));
      const script = join(root, "scripts/check-nested-root-package.mjs");
      copyFileSync(resolve(here, "check-nested-root-package.mjs"), script);
      writeFileSync(
        join(root, "package-lock.json"),
        JSON.stringify(committedLockWithViteSplit()),
        "utf8",
      );

      let status = 0;
      let stderr = "";
      try {
        execFileSync(process.execPath, [script], {
          encoding: "utf8",
          stdio: "pipe",
        });
      } catch (error) {
        status = error.status;
        stderr = error.stderr;
      }
      expect(status).toBe(1);
      expect(stderr).toContain("vite is split across the workspace boundary");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is wired as a check script and on the gate's list", () => {
    expect(readRootJson("package.json").scripts).toHaveProperty(
      "check:nested-root-package",
      "node scripts/check-nested-root-package.mjs",
    );
    expect(CHECKS.map((check) => check.script)).toContain(
      "check:nested-root-package",
    );
  });

  it("is what the recorded hoist behaviour names as watching for it", () => {
    expect(readRoot("docs/spec/DEPENDENCY_PINS.md")).toContain(
      "scripts/check-nested-root-package.mjs",
    );
  });
});
