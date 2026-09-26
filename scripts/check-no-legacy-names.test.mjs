import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import {
  ALLOWLIST,
  EXPIRES_ON,
  findLegacyNames,
  isExpired,
} from "./check-no-legacy-names.mjs";
import { CHECKS } from "./run-checks.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const SCRIPT = resolve(here, "check-no-legacy-names.mjs");

const readRoot = (relative) =>
  readFileSync(resolve(repoRoot, relative), "utf8");

const BEFORE_EXPIRY = "2026-10-01";
const AFTER_EXPIRY = "2026-12-25";

/**
 * A backstop on the one case below that scans this whole repository through a
 * child process, sized as a safety check for a hang rather than an assertion
 * about how fast a loaded machine runs `git grep`: that scan cost 0.6-2.1 s on
 * this container idle and rose to 3.6 s with eight parallel `npm run
 * test:scripts` runs contending for CPU -- past vitest's 5,000 ms default.
 */
const REPO_SCAN_HANG_BACKSTOP_MS = 30_000;

// The script driven as the workflow runs it, against `root` or -- with no root
// -- against this repository.
function runCheck({ root, today = BEFORE_EXPIRY } = {}) {
  const args = [SCRIPT, "--today", today];
  if (root !== undefined) args.push("--root", root);
  try {
    const stdout = execFileSync(process.execPath, args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    return { status: error.status, stdout: error.stdout, stderr: error.stderr };
  }
}

const temporaryRoots = [];
afterAll(() => {
  for (const root of temporaryRoots)
    rmSync(root, { recursive: true, force: true });
});

/**
 * A git tree holding `files` (path -> contents), every one added to the index
 * so `git ls-files` lists it; `untracked` are written and not added.
 */
function fixtureTree(files, untracked = {}) {
  const root = mkdtempSync(resolve(tmpdir(), "alcove-legacy-names-"));
  temporaryRoots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const [path, contents] of Object.entries({ ...files, ...untracked })) {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    writeFileSync(resolve(root, path), contents);
  }
  const tracked = Object.keys(files);
  if (tracked.length > 0) {
    execFileSync("git", ["add", "--", ...tracked], { cwd: root });
  }
  return root;
}

describe("findLegacyNames", () => {
  it("finds nothing in a tree that names only Alcove", () => {
    const root = fixtureTree({
      "README.md": "# Alcove\n\nRun `alcove exchange`.\n",
    });
    expect(findLegacyNames(root)).toEqual([]);
  });

  it("names the file and line of each spelling, in any case", () => {
    const root = fixtureTree({
      "docs/a.md": "line one\nrun psilink here\n",
      "src/b.ts": 'const x = "PSILINK_VERSION";\n',
      "c.yaml": "repo: georgetown-mdi/JsPsi\n",
      "d.sh": "docker pull vdorie/Psi-Link\n",
    });
    expect(findLegacyNames(root)).toEqual([
      { path: "c.yaml", line: 1, text: "repo: georgetown-mdi/JsPsi" },
      { path: "d.sh", line: 1, text: "docker pull vdorie/Psi-Link" },
      { path: "docs/a.md", line: 2, text: "run psilink here" },
      { path: "src/b.ts", line: 1, text: 'const x = "PSILINK_VERSION";' },
    ]);
  });

  it("reports a tracked path that holds the name", () => {
    const root = fixtureTree({ "support/start-psilink.sh": "echo alcove\n" });
    expect(findLegacyNames(root)).toEqual([
      {
        path: "support/start-psilink.sh",
        line: 0,
        text: "support/start-psilink.sh",
      },
    ]);
  });

  it("does not read an untracked file", () => {
    const root = fixtureTree(
      { "README.md": "Alcove\n" },
      { "scratch/notes.md": "psilink\n" },
    );
    expect(findLegacyNames(root)).toEqual([]);
  });

  it("skips a binary file by its extension", () => {
    const root = fixtureTree({
      "icon.png": "psilink",
      "favicon.ICO": "psilink",
      "lib/pkg.tgz": "psilink",
    });
    expect(findLegacyNames(root)).toEqual([]);
  });

  it("does not scan an allowlisted file's contents", () => {
    const root = fixtureTree(
      Object.fromEntries(ALLOWLIST.map((entry) => [entry.path, "psilink\n"])),
    );
    expect(findLegacyNames(root)).toEqual([]);
  });

  it("gives every allowlist entry a reason", () => {
    for (const entry of ALLOWLIST) {
      expect(entry.reason.length, entry.path).toBeGreaterThan(0);
    }
  });
});

describe("the expiry", () => {
  it("scans on the expiry date itself and fails the day after", () => {
    expect(isExpired(EXPIRES_ON)).toBe(false);
    expect(isExpired(AFTER_EXPIRY)).toBe(true);
  });

  it("fails an expired run without scanning, naming what to delete", () => {
    const root = fixtureTree({ "README.md": "Alcove\n" });
    const result = runCheck({ root, today: AFTER_EXPIRY });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`expired on ${EXPIRES_ON}`);
    for (const named of [
      "scripts/check-no-legacy-names.mjs",
      "scripts/check-no-legacy-names.test.mjs",
      "scripts/run-checks.mjs",
      "check:no-legacy-names",
      "package.json",
    ]) {
      expect(result.stderr).toContain(named);
    }
  });
});

describe("the check, driven as the workflow runs it", () => {
  it("passes a clean tree", () => {
    const root = fixtureTree({ "README.md": "Alcove\n" });
    const result = runCheck({ root });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("legacy name check passed");
  });

  it("fails a tree holding the name, naming the file and line", () => {
    const root = fixtureTree({ "docs/a.md": "one\nsee psilink.yaml\n" });
    const result = runCheck({ root });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docs/a.md:2: see psilink.yaml");
  });

  it("refuses a malformed --today", () => {
    const root = fixtureTree({ "README.md": "Alcove\n" });
    expect(runCheck({ root, today: "tomorrow" }).status).toBe(2);
  });

  it(
    "passes this repository before the expiry",
    { timeout: REPO_SCAN_HANG_BACKSTOP_MS },
    () => {
      const result = runCheck();
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    },
  );
});

describe("the check's registration", () => {
  it("is the command the workflow invokes", () => {
    expect(JSON.parse(readRoot("package.json")).scripts).toHaveProperty(
      "check:no-legacy-names",
      "node scripts/check-no-legacy-names.mjs",
    );
  });

  it("is on the list the Static Checks gate runs", () => {
    expect(CHECKS.map((check) => check.script)).toContain(
      "check:no-legacy-names",
    );
  });
});
