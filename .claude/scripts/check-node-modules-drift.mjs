#!/usr/bin/env node
// Consistency check for an installed node_modules against the package-lock.json
// beside it. worktree-init.sh runs it on the tree it just provisioned; it also
// stands alone in any tree:
//
//   node .claude/scripts/check-node-modules-drift.mjs [dir] [--all]
//                                                    [--shared-from <dir>]
//
// Why it exists: worktree-init.sh does not install, it shares the primary clone's
// already-installed packages by absolute symlink. A worktree therefore inherits
// whatever the primary happens to hold, including an install that has fallen
// behind its own lockfile, and nothing in the provisioning path ever consulted a
// lockfile. That inheritance is silent and it bites: a worktree provisioned from
// a primary carrying prettier 3.8.4 against a lockfile pinning 3.9.6 reformats
// dozens of untouched source files on `npm run format`.
//
// npm decides; this script only reads its verdict. CLAUDE.md: settle a question
// about an external tool's behavior by driving the real tool, never by reading its
// source or modeling its semantics -- and it names a check that reimplements a
// tool's resolution to predict what the tool would do as itself a review finding.
// So the comparison is `npm install --dry-run --json`, which builds the ideal tree
// from package-lock.json and diffs it against what is on disk. Deciding here which
// lockfile entries npm would install on this platform, or where it would dedupe
// them, would be exactly that reimplementation.
//
// Measured 2026-08-02 against npm 11.17.0 / node 26.4.0, driving the real tool in
// the repo's own drifted worktree and in synthetic trees (the colocated test
// rebuilds the synthetic ones on every run):
//   - `--offline` against a complete lockfile needs neither network nor a warm
//     cache: pointed at an empty `--cache`, the dry run still produced the full
//     diff, and the versions it named were the lockfile's. Provisioning therefore
//     stays offline, and cache state cannot change the verdict.
//   - `--dry-run` writes nothing -- not node_modules, not the lockfile.
//   - npm prints its human-readable `change <name> <from> => <to>` lines to stdout
//     ahead of the `--json` summary even at `--loglevel=error`, so the summary is
//     parsed from the first line that is a bare `{`.
//   - npm masks uuid-shaped segments of every path it prints: run under a
//     directory named 11111111-2222-3333-4444-555555555555 it reports that segment
//     as `***`, in the summary and in its errors alike. A reported path is
//     therefore not always a path that can be opened, and probing one as-is under
//     such a directory -- a temp tree named for a session id, say -- reads every
//     entry as absent and calls a fully provisioned worktree empty. Each reported
//     path is mapped back to a tree-relative install path, the longest
//     package-lock.json key it ends with, before anything is opened.
//
// Reading the verdict over a symlink mirror. npm compares an ideal tree of real
// directories against a mirror of links, so most of its diff is mirror shape
// rather than drift, and the classes are told apart by version:
//   - `change` with differing from/to versions: the wrong version is installed.
//     This is the class that bites, and it fails.
//   - `change` with equal from/to versions: npm plans to replace a link with a
//     real directory holding the same version. Shape, not drift; ignored. (In the
//     repo's drifted worktree, 549 of 603 change entries were this.)
//   - `add`: npm does not walk into a linked package's own node_modules, so a dep
//     nested under a shared package reads as absent. Ignored when the install path
//     already holds the version npm names -- measured: all 71 add entries in the
//     drifted worktree did -- failed as missing when the path holds nothing, and
//     failed as a wrong version when it holds another version.
//   - `remove`: a package on disk the lockfile does not list. Reported, never
//     failed: a primary shared across branches legitimately carries packages this
//     branch's lockfile never mentions, and an extra package cannot change what
//     the lockfile does describe.
//
// What it cannot see: anything below a version number. Two installs of the same
// version compare equal here whatever their contents, so a corrupted or patched
// package passes. It also asserts nothing about a tree npm cannot diff at all --
// an npm failure or an unrecognized summary shape is reported as unverified and
// exits non-zero rather than passing.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const NAME = "check-node-modules-drift";
const LISTED = 12;

const DRY_RUN_ARGS = [
  "install",
  "--dry-run",
  "--json",
  "--offline",
  "--no-audit",
  "--no-fund",
];

/**
 * npm's `--json` install summary, parsed out of stdout. The human-readable change
 * lines npm prints first are skipped by starting at the first unindented `{`; the
 * summary object is printed at column 0 and every brace inside it is indented.
 */
export function parseNpmSummary(stdout) {
  const lines = stdout.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] !== "{") continue;
    try {
      return JSON.parse(lines.slice(index).join("\n"));
    } catch {
      continue;
    }
  }
  throw new Error("npm printed no --json install summary");
}

/** Version recorded by the package.json at an install path; null when absent. */
export function installedVersionAt(path) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
  } catch {
    return null;
  }
  return typeof manifest.version === "string" ? manifest.version : null;
}

/** The lockfile's own install paths, longest first for suffix matching. */
export function lockfileInstallPaths(lock) {
  return Object.keys(lock?.packages ?? {})
    .filter((key) => key.includes("node_modules/"))
    .sort((a, b) => b.length - a.length);
}

/**
 * The tree-relative install path an absolute path npm reported denotes, or null
 * when no lockfile entry claims it. Matching by lockfile key rather than by
 * stripping the tree root is what survives npm's path masking, which can rewrite
 * any segment above the tree.
 */
export function treeRelativePath(reportedPath, lockPaths) {
  const normalized = reportedPath.replaceAll("\\", "/");
  return lockPaths.find((key) => normalized.endsWith(`/${key}`)) ?? null;
}

function requireFields(entry, fields, kind) {
  for (const field of fields) {
    if (typeof entry?.[field] !== "string") {
      throw new Error(
        `npm's --json summary has an unrecognized ${kind} entry (no string "${field}"): ${JSON.stringify(entry)}`,
      );
    }
  }
}

/**
 * npm's summary sorted into the classes above: `wrongVersion` and `missing` are
 * drift, `extra` is reported only. `versionAt` takes a tree-relative install path,
 * so the test can drive the classification without a tree on disk.
 */
export function driftFrom(summary, { lockPaths, versionAt }) {
  const wrongVersion = [];
  const missing = [];
  for (const entry of summary.change ?? []) {
    requireFields(entry?.from, ["name", "version", "path"], "change.from");
    requireFields(entry?.to, ["name", "version", "path"], "change.to");
    if (entry.from.version === entry.to.version) continue;
    wrongVersion.push({
      name: entry.to.name,
      installed: entry.from.version,
      locked: entry.to.version,
    });
  }
  for (const entry of summary.add ?? []) {
    requireFields(entry, ["name", "version", "path"], "add");
    const relative = treeRelativePath(entry.path, lockPaths);
    if (relative === null) {
      throw new Error(
        `npm reported an install path no package-lock.json entry claims: ${entry.path}`,
      );
    }
    const installed = versionAt(relative);
    if (installed === null) {
      missing.push({ name: entry.name, locked: entry.version });
    } else if (installed !== entry.version) {
      wrongVersion.push({ name: entry.name, installed, locked: entry.version });
    }
  }
  const extra = (summary.remove ?? []).map((entry) => {
    requireFields(entry, ["name", "version"], "remove");
    return { name: entry.name, version: entry.version };
  });
  return { wrongVersion, missing, extra };
}

const plural = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** The lines a drifted tree reports: what is wrong, then how to fix it. */
export function formatDrift(dir, drift, sharedFrom = null, limit = LISTED) {
  const lines = [
    `${NAME}: node_modules in ${dir} does not match its package-lock.json.`,
    "",
  ];
  const width = Math.max(
    1,
    ...[...drift.wrongVersion, ...drift.missing].map(
      (item) => item.name.length,
    ),
  );
  const listed = [
    ...drift.wrongVersion.map((item) => ({
      name: item.name,
      text: `${item.installed} installed, lockfile pins ${item.locked}`,
    })),
    ...drift.missing.map((item) => ({
      name: item.name,
      text: `not installed, lockfile pins ${item.locked}`,
    })),
  ].sort(
    (a, b) => a.name.localeCompare(b.name) || a.text.localeCompare(b.text),
  );
  for (const item of listed.slice(0, limit)) {
    lines.push(`  ${item.name.padEnd(width)}  ${item.text}`);
  }
  if (listed.length > limit) {
    lines.push(`  ... and ${listed.length - limit} more (--all lists them)`);
  }
  const extra =
    drift.extra.length === 0
      ? ""
      : `, plus ${plural(drift.extra.length, "package")} on disk the lockfile does not list`;
  lines.push(
    "",
    `${plural(drift.wrongVersion.length, "wrong version")}, ${plural(drift.missing.length, "missing package")}${extra}.`,
  );
  if (sharedFrom) {
    lines.push(
      `These packages are shared by symlink from ${sharedFrom}, whose install does not match this lockfile (it may be older, or from another branch).`,
      `Keep sharing them (fast): run \`npm install\` in ${sharedFrom}, then re-run this script.`,
      `Fix this tree alone (slower): run \`npm install\` in ${dir} -- it replaces the symlinks with a private tree matching this lockfile, and does not write into ${sharedFrom}.`,
    );
  } else {
    lines.push(
      `Run \`npm install\` in ${dir} to reconcile it with the lockfile.`,
    );
  }
  return lines;
}

/** Drive npm's dry-run diff in `dir` and sort its verdict into drift classes. */
export function checkTree(dir, run = runNpmDryRun) {
  const lockPath = join(dir, "package-lock.json");
  let lock;
  try {
    lock = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch (cause) {
    throw new Error(`${lockPath} could not be read`, { cause });
  }
  return driftFrom(parseNpmSummary(run(dir)), {
    lockPaths: lockfileInstallPaths(lock),
    versionAt: (relative) => installedVersionAt(join(dir, relative)),
  });
}

/** npm's own diff of `dir`'s ideal tree against what is installed there. */
export function runNpmDryRun(dir) {
  return execFileSync("npm", DRY_RUN_ARGS, {
    cwd: dir,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions without the process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const all = args.includes("--all");
  const sharedIndex = args.indexOf("--shared-from");
  const sharedFrom =
    sharedIndex === -1 ? null : resolve(args[sharedIndex + 1] ?? "");
  if (sharedIndex !== -1) args.splice(sharedIndex, 2);
  const dir = resolve(
    args.find((arg) => !arg.startsWith("--")) ?? process.cwd(),
  );

  let drift;
  try {
    drift = checkTree(dir);
  } catch (error) {
    console.error(
      `${NAME}: could not verify ${dir} against its package-lock.json -- ${error.message}`,
    );
    process.exit(2);
  }

  if (drift.wrongVersion.length > 0 || drift.missing.length > 0) {
    const report = formatDrift(dir, drift, sharedFrom, all ? Infinity : LISTED);
    for (const line of report) console.error(line);
    process.exit(1);
  }

  const extra =
    drift.extra.length === 0
      ? ""
      : `; ${plural(drift.extra.length, "package")} on disk the lockfile does not list, which cannot change what it does`;
  console.log(`${NAME}: node_modules agrees with package-lock.json${extra}.`);
}
