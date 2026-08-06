import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  admits,
  assess,
  declaredRanges,
  installedVersions,
} from "./check-brace-expansion-override.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const readRoot = (name) =>
  readFileSync(resolve(repoRoot, name), { encoding: "utf8" });
const readRootJson = (name) => JSON.parse(readRoot(name));

const TARGET = "5.0.8";

const OVERRIDE = { overrides: { "brace-expansion": "^5.0.8" } };
const NO_OVERRIDE = { overrides: { "some-other-package": "^1.0.0" } };

/**
 * A lockfile whose requirers declare the given ranges, over a single installed
 * copy at `installed` unless a fixture asks for another shape.
 */
function lockfile(
  ranges,
  { installed = [TARGET], field = "dependencies" } = {},
) {
  const packages = { "": { name: "root" } };
  installed.forEach((version, index) => {
    const path =
      index === 0
        ? "node_modules/brace-expansion"
        : `node_modules/nested-${index}/node_modules/brace-expansion`;
    packages[path] = { version };
  });
  ranges.forEach((range, index) => {
    packages[`node_modules/requirer-${index}`] = {
      version: "1.0.0",
      [field]: { "brace-expansion": range },
    };
  });
  return { lockfileVersion: 3, packages };
}

const linesOf = (manifest, lock) => assess(manifest, lock).lines.join("\n");

describe("range semantics", () => {
  it("reads the caret line the override sits on", () => {
    expect(admits("^5.0.8", TARGET)).toBe(true);
    expect(admits("^5.0.5", TARGET)).toBe(true);
    expect(admits("^5", TARGET)).toBe(true);
    expect(admits("^5.1.0", TARGET)).toBe(false);
    expect(admits("^0.0.3", "0.0.3")).toBe(true);
    expect(admits("^0.0.3", "0.0.4")).toBe(false);
    expect(admits("^0.2.3", "0.3.0")).toBe(false);
    expect(admits("^0", "0.9.9")).toBe(true);
    expect(admits("^0", "1.0.0")).toBe(false);
  });

  it("caps below the target on every major line, not only on ^2", () => {
    for (const range of [
      "^1.1.11",
      "^2.0.1",
      "^2.0.2",
      "^3.0.0",
      "~4.0.0",
      "4.x",
      "1",
      "<5.0.0",
      "<=5.0.7",
      ">=2.0.0 <3.0.0",
      "^1.0.0 || ^2.0.0",
    ]) {
      expect(admits(range, TARGET), range).toBe(false);
    }
  });

  it("admits the target from an uncapped requirer", () => {
    for (const range of [
      "*",
      "x",
      "",
      "5.0.8",
      "=5.0.8",
      "v5.0.8",
      "5.0.x",
      "5",
      "~5.0.8",
      ">=2.0.0",
      ">5.0.7",
      ">=5.0.0 <6.0.0",
      "^2.0.1 || ^5.0.0",
    ]) {
      expect(admits(range, TARGET), range).toBe(true);
    }
  });

  it("reads a partial version an inequality names as the span it names", () => {
    expect(admits(">1.2", "1.2.9")).toBe(false);
    expect(admits(">1.2", "1.3.0")).toBe(true);
    expect(admits("<=1.2", "1.2.9")).toBe(true);
    expect(admits("<=1.2", "1.3.0")).toBe(false);
    expect(admits(">1", "1.9.9")).toBe(false);
    expect(admits(">1", "2.0.0")).toBe(true);
    expect(admits(">=1.2", "1.2.0")).toBe(true);
    expect(admits("<1.2", "1.2.0")).toBe(false);
  });

  it("refuses a spelling it does not read rather than answering for it", () => {
    for (const range of [
      "1.0.0 - 2.0.0",
      "^1.0.0-beta.2",
      "2.0.0-rc.24",
      ">=2.0.0-0",
      "1.x.2",
      "npm:brace-expansion@5",
      "file:../brace-expansion",
      "latest",
      "^2.0.1 || 1.0.0 - 2.0.0",
      undefined,
    ]) {
      expect(admits(range, TARGET), String(range)).toBeNull();
    }
  });
});

describe("lockfile reading", () => {
  it("takes the installed versions from every copy, however nested", () => {
    expect(installedVersions(lockfile([], { installed: [TARGET] }))).toEqual([
      TARGET,
    ]);
    expect(
      installedVersions(lockfile([], { installed: [TARGET, "5.1.0"] })),
    ).toEqual(["5.0.8", "5.1.0"]);
    expect(installedVersions(lockfile([], { installed: [] }))).toEqual([]);
  });

  it("reads a declaration from every dependency map a requirer can use", () => {
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      const declared = declaredRanges(lockfile(["^2.0.2"], { field }));
      expect(declared).toEqual([
        {
          path: "node_modules/requirer-0",
          field,
          range: "^2.0.2",
        },
      ]);
      expect(assess(OVERRIDE, lockfile(["^2.0.2"], { field })).ok).toBe(true);
    }
  });
});

describe("the verdict", () => {
  it("holds while a requirer caps below the installed version", () => {
    const verdict = assess(OVERRIDE, lockfile(["^2.0.2", "^5.0.5"]));
    expect(verdict.ok).toBe(true);
    expect(verdict.lines.join("\n")).toContain(
      'node_modules/requirer-0 (dependencies) declares "^2.0.2"',
    );
  });

  it("holds on a cap outside the ^2 line", () => {
    expect(assess(OVERRIDE, lockfile(["^1.1.11", "^5.0.5"])).ok).toBe(true);
    expect(assess(OVERRIDE, lockfile(["~4.0.0"])).ok).toBe(true);
  });

  it("trips once every requirer admits the installed version", () => {
    const verdict = assess(OVERRIDE, lockfile(["^5.0.5", ">=2.0.0"]));
    expect(verdict.ok).toBe(false);
    const message = verdict.lines.join("\n");
    expect(message).toContain("drop it from package.json");
    expect(message).toContain("npm audit --package-lock-only");
    expect(message).toContain("docs/spec/DEPENDENCY_PINS.md");
    expect(message).toContain("not npm's resolution without the override");
  });

  it("trips on an uncapped requirer standing alone", () => {
    expect(assess(OVERRIDE, lockfile(["^5.0.5"])).ok).toBe(false);
  });

  it("trips when the lockfile declares no requirer at all", () => {
    const verdict = assess(OVERRIDE, lockfile([]));
    expect(verdict.ok).toBe(false);
    expect(verdict.lines.join("\n")).toContain("drop it from package.json");
  });

  it("passes with no override, whatever the requirers declare", () => {
    for (const ranges of [["^5.0.5"], ["^2.0.2"], []]) {
      const verdict = assess(NO_OVERRIDE, lockfile(ranges));
      expect(verdict.ok).toBe(true);
      expect(verdict.lines.join("\n")).toContain("No root");
    }
    expect(assess({}, lockfile(["^5.0.5"])).ok).toBe(true);
  });

  it("reads a nested override object as an override that stands", () => {
    const nested = { overrides: { "brace-expansion": { ".": "^5.0.8" } } };
    expect(assess(nested, lockfile(["^5.0.5"])).ok).toBe(false);
    expect(assess(nested, lockfile(["^2.0.2"])).ok).toBe(true);
  });

  it("trips when the override rewrites an edge onto nothing installed", () => {
    const verdict = assess(OVERRIDE, lockfile(["^2.0.2"], { installed: [] }));
    expect(verdict.ok).toBe(false);
    expect(verdict.lines.join("\n")).toContain("installs no brace-expansion");
  });
});

describe("what it refuses to answer for", () => {
  it("refuses a lockfile carrying no packages map", () => {
    const verdict = assess(OVERRIDE, { lockfileVersion: 1 });
    expect(verdict.ok).toBe(false);
    expect(verdict.lines.join("\n")).toContain("no `packages` map");
  });

  it("refuses two installed copies, where a cap has no single answer", () => {
    const verdict = assess(
      OVERRIDE,
      lockfile(["^5.0.5"], { installed: [TARGET, "2.1.2"] }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.lines.join("\n")).toContain("2 versions of brace-expansion");
  });

  it("refuses an installed version it cannot compare against", () => {
    const verdict = assess(
      OVERRIDE,
      lockfile(["^5.0.5"], { installed: ["5.1.0-rc.1"] }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.lines.join("\n")).toContain("plain major.minor.patch");
  });

  it("refuses a declared range it does not read, naming the requirer", () => {
    const verdict = assess(OVERRIDE, lockfile(["^2.0.2", "1.0.0 - 2.0.0"]));
    expect(verdict.ok).toBe(false);
    const message = verdict.lines.join("\n");
    expect(message).toContain("does not read");
    expect(message).toContain(
      'node_modules/requirer-1 (dependencies) declares "1.0.0 - 2.0.0"',
    );
  });

  it("names the file to model an unread shape in", () => {
    expect(linesOf(OVERRIDE, { lockfileVersion: 1 })).toContain(
      "scripts/check-brace-expansion-override.mjs",
    );
  });
});

describe("the real repository", () => {
  it("still has a requirer the override overrules", () => {
    const verdict = assess(
      readRootJson("package.json"),
      readRootJson("package-lock.json"),
    );
    expect(verdict.ok, verdict.lines.join("\n")).toBe(true);
  });

  it("exits 0 from the CLI entry point", () => {
    const output = execFileSync(
      process.execPath,
      [resolve(here, "check-brace-expansion-override.mjs")],
      { encoding: "utf8" },
    );
    expect(output).toContain("brace-expansion override check passed");
  });

  it("exits 1 from the CLI entry point over a redundant override", () => {
    const root = mkdtempSync(join(tmpdir(), "brace-expansion-override-"));
    try {
      // The entry reads its two inputs from the directory above itself, so a
      // copy under a fixture pair is what puts the failing branch on a process.
      mkdirSync(join(root, "scripts"));
      const script = join(root, "scripts/check-brace-expansion-override.mjs");
      copyFileSync(resolve(here, "check-brace-expansion-override.mjs"), script);
      const writeJson = (name, value) =>
        writeFileSync(join(root, name), JSON.stringify(value), "utf8");
      writeJson("package.json", OVERRIDE);
      writeJson("package-lock.json", lockfile(["^5.0.5"]));

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
      expect(stderr).toContain("drop it from package.json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is wired as a check script and a CI step", () => {
    expect(readRootJson("package.json").scripts).toHaveProperty(
      "check:brace-expansion-override",
      "node scripts/check-brace-expansion-override.mjs",
    );
    expect(readRoot(".github/workflows/static_checks.yaml")).toContain(
      "run: npm run check:brace-expansion-override",
    );
  });

  it("is what the override's revisit trigger names as watching it", () => {
    expect(readRoot("docs/spec/DEPENDENCY_PINS.md")).toContain(
      "scripts/check-brace-expansion-override.mjs",
    );
  });
});
