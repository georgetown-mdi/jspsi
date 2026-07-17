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
// It catches exactly ONE drift mode and is deliberately narrow: a NEW top-level
// directory appearing under a guarded root without a matching deploy entry. It
// does NOT verify the deploy filter's existing entries -- a named-file entry can
// be deleted, a subtree glob narrowed (apps/web/src/** -> apps/web/src/sub/**),
// or an out-of-root input (lib/**, package-lock.json, tsconfig.base.json,
// .github/actions/setup/**) dropped, and this test stays green. Those are direct
// edits to the deploy workflow, visible in the PR diff and reviewed there; the
// drift this guards is the kind NOT in that diff -- a new dir added elsewhere
// while the filter is left untouched. So a green run does NOT mean "the deploy
// filter is fully in sync"; review workflow edits on their own merits. See the
// paths: comments in both workflows for the divergence rationale.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const PR_WORKFLOW = ".github/workflows/eb_build_and_test.yaml";
const DEPLOY_WORKFLOW = ".github/workflows/eb_deploy.yaml";

// Roots whose tracked top-level subdirectories must each be deploy-covered or
// explicitly excluded below.
const GUARDED_ROOTS = ["apps/web", "packages/core"];

// Subtrees the deploy filter omits ON PURPOSE: a change to test or dev-tooling
// sources runs the PR suite but must not trigger a rebuild+redeploy. Allowlisting
// a directory SUPPRESSES its deploy-coverage check, so an entry here must be a real
// "this directory does not ship" decision, not a way to mute a failure. The live
// tests below assert each entry still exists, so a removed/renamed tree cannot rot
// the list. apps/web/eslint-rules holds lint-time custom rules that never ship in
// the artifact.
const DEPLOY_EXCLUDED = new Set([
  "apps/web/test",
  "packages/core/test",
  "apps/web/eslint-rules",
]);

// Inputs that feed the shipped artifact but live OUTSIDE the guarded roots, so
// the top-level-dir scan cannot see them. Assert the deploy filter still lists
// each: dropping one means a real change (e.g. a crypto-lib bump via lib/**, or
// a build-setup change via the setup action) silently never deploys -- a stale
// deploy that is invisible both here and in a workflow-diff review. This is a
// fixed floor, not a mirror of the whole filter: the set is stable (it does not
// change when web/core subdirs are added or removed), so the check only fires
// when an entry is actually deleted, which is exactly the bug worth catching.
const REQUIRED_DEPLOY_INPUTS = [
  "lib/**", // vendored @openmined/psi.js tgz, bundled into the artifact
  "package-lock.json", // lockfile npm ci resolves the artifact's deps from
  "tsconfig.base.json", // shared TS config the build inherits
  ".github/actions/setup/**", // composite action: npm ci + core build -> bundle
];

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
  // -z + core.quotepath=false: NUL-delimited, unquoted output, so a non-ASCII
  // directory name (which git otherwise wraps in quotes and octal-escapes) is
  // sliced at the right offset instead of yielding a garbage dir.
  const out = execFileSync(
    "git",
    [
      "-C",
      repoRoot,
      "-c",
      "core.quotepath=false",
      "ls-files",
      "-z",
      "--",
      root,
    ],
    { encoding: "utf8" },
  );
  const dirs = new Set();
  for (const line of out.split("\0")) {
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
      const uncovered = uncoveredDirs(dirs, deployEntries, DEPLOY_EXCLUDED);
      expect(
        uncovered,
        `new tracked dir(s) under ${root} are neither deploy-covered nor ` +
          `allowlisted: ${uncovered.join(", ")}. Add each to DEPLOY_EXCLUDED if it ` +
          `does not ship (dev/lint tooling, like apps/web/test), or a path to ` +
          `${DEPLOY_WORKFLOW} if it does. Re-check with \`npm run test:scripts\`.`,
      ).toEqual([]);
    }
  });

  it("the PR gate globs each guarded root so test-only changes still run the suite", () => {
    const prEntries = workflowPaths(PR_WORKFLOW, "pull_request");
    for (const root of GUARDED_ROOTS) {
      expect(prEntries).toContain(`${root}/**`);
    }
  });

  it("the deploy filter still lists each out-of-root artifact input", () => {
    for (const input of REQUIRED_DEPLOY_INPUTS) {
      expect(deployEntries).toContain(input);
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
