import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

// Drift guard for the two web/core path filters. The pull-request gate
// (eb_build_and_test.yaml) globs each guarded root -- apps/web/**,
// packages/core/** -- while the deploy gate (eb_deploy.yaml) enumerates
// individual subtrees, because a deploy must not rebuild+redeploy unchanged
// runtime behavior on a test-only push. That asymmetry is deliberate, but it is
// also a trap: a NEW top-level directory under a guarded root (say
// apps/web/middleware/) is built by the PR gate yet silently skipped by the
// deploy enumeration, so the change never ships and nothing fails. This guard
// turns that silent stale-deploy into a red test at the PR that introduces the
// directory, forcing an explicit ship-or-exclude decision then and there.
//
// It is intentionally directory-level: it polices new top-level dirs, not new
// files inside an already-enumerated subtree (e.g. a new root config file),
// which still need manual filter upkeep. See the paths: comments in both
// workflows for the divergence rationale.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const PR_WORKFLOW = ".github/workflows/eb_build_and_test.yaml";
const DEPLOY_WORKFLOW = ".github/workflows/eb_deploy.yaml";

// Roots whose tracked top-level subdirectories must each be deploy-covered or
// explicitly excluded below.
const GUARDED_ROOTS = ["apps/web", "packages/core"];

// Subtrees the deploy filter omits ON PURPOSE: a change to test sources runs the
// PR suite but must not trigger a rebuild+redeploy. Adding an entry here is an
// explicit "this directory does not ship" decision; the live tests below also
// assert each entry still exists, so a removed/renamed tree cannot rot the list.
const DEPLOY_EXCLUDED = new Set(["apps/web/test", "packages/core/test"]);

// The on.<event>.paths list of a workflow. yaml 2.x uses the YAML 1.2 core
// schema, so the `on` key is a plain string (not folded to the boolean true the
// way a YAML 1.1 parser would), and parsed.on.<event>.paths reads straight off.
function workflowPaths(file, event) {
  const parsed = parse(readFileSync(resolve(repoRoot, file), "utf8"));
  const paths = parsed?.on?.[event]?.paths;
  if (!Array.isArray(paths)) {
    throw new Error(`no on.${event}.paths array in ${file}`);
  }
  return paths;
}

// Tracked top-level subdirectories under a root, e.g. "apps/web/src". A file
// directly under the root (apps/web/package.json) is not a subdirectory and is
// covered by the filters' named-file entries, so it is skipped. git ls-files is
// the source of truth for what a PR can change -- it ignores node_modules and
// untracked build output (dist, .output) without an exclusion list.
function trackedTopLevelDirs(root) {
  const out = execFileSync("git", ["-C", repoRoot, "ls-files", "--", root], {
    encoding: "utf8",
  });
  const dirs = new Set();
  for (const line of out.split("\n")) {
    if (!line) continue;
    const rest = line.slice(root.length + 1); // strip "apps/web/"
    const slash = rest.indexOf("/");
    if (slash === -1) continue; // a file directly under the root, not a subdir
    dirs.add(`${root}/${rest.slice(0, slash)}`);
  }
  return [...dirs].sort();
}

// A deploy paths entry covers dir D if, ignoring its glob, it points at D, at
// something inside D (an enumerated subtree like apps/web/deploy/aws_eb/**
// covers apps/web/deploy at directory granularity), or at an ancestor of D (a
// broad glob like apps/web/** would cover apps/web/src). A "!negation" entry
// keeps its leading "!", so it never equals or prefixes a real dir -- negations
// never falsely mark a directory covered.
function deployCovers(entry, dir) {
  const path = entry.replace(/\/\*\*$/, "");
  return (
    path === dir || path.startsWith(`${dir}/`) || dir.startsWith(`${path}/`)
  );
}

// Dirs that are neither deploy-covered nor explicitly excluded -- the drift.
function uncoveredDirs(realDirs, deployEntries, excluded) {
  return realDirs.filter(
    (dir) =>
      !excluded.has(dir) && !deployEntries.some((e) => deployCovers(e, dir)),
  );
}

describe("ci path-filter drift guard (logic)", () => {
  const deploy = [
    "lib/**",
    "apps/web/deploy/aws_eb/**",
    "apps/web/public/**",
    "apps/web/src/**",
    "packages/core/src/**",
  ];

  it("treats an enumerated subtree as covered, at directory granularity", () => {
    expect(uncoveredDirs(["apps/web/src"], deploy, new Set())).toEqual([]);
    // apps/web/deploy is covered via the deeper apps/web/deploy/aws_eb/** entry.
    expect(uncoveredDirs(["apps/web/deploy"], deploy, new Set())).toEqual([]);
  });

  it("flags a new top-level dir the deploy filter does not enumerate", () => {
    expect(uncoveredDirs(["apps/web/middleware"], deploy, new Set())).toEqual([
      "apps/web/middleware",
    ]);
  });

  it("treats an allowlisted (deploy-excluded) dir as fine", () => {
    expect(
      uncoveredDirs(["apps/web/test"], deploy, new Set(["apps/web/test"])),
    ).toEqual([]);
  });

  it("does not let a broad ancestor glob be faked by a negation entry", () => {
    // "!apps/web/test/**" must NOT count as covering apps/web/test.
    expect(deployCovers("!apps/web/test/**", "apps/web/test")).toBe(false);
    // ...while a genuine broad glob does cover a child dir.
    expect(deployCovers("apps/web/**", "apps/web/src")).toBe(true);
  });
});

describe("ci path-filter drift guard (live workflows)", () => {
  const deployEntries = workflowPaths(DEPLOY_WORKFLOW, "push");

  it("every tracked top-level dir under a guarded root is deploy-covered or allowlisted", () => {
    for (const root of GUARDED_ROOTS) {
      const dirs = trackedTopLevelDirs(root);
      // Sanity: the root has tracked subdirs, so the assertion is actually live.
      expect(dirs.length).toBeGreaterThan(0);
      expect(uncoveredDirs(dirs, deployEntries, DEPLOY_EXCLUDED)).toEqual([]);
    }
  });

  it("the PR gate globs each guarded root so test-only changes still run the suite", () => {
    const prEntries = workflowPaths(PR_WORKFLOW, "pull_request");
    for (const root of GUARDED_ROOTS) {
      expect(prEntries).toContain(`${root}/**`);
    }
  });

  it("no deploy-excluded entry has rotted (each still exists as a tracked dir)", () => {
    for (const excluded of DEPLOY_EXCLUDED) {
      const root = GUARDED_ROOTS.find((r) => excluded.startsWith(`${r}/`));
      expect(root, `${excluded} is not under a guarded root`).toBeDefined();
      expect(trackedTopLevelDirs(root)).toContain(excluded);
    }
  });
});
