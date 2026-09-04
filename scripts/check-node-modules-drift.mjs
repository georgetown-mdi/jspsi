#!/usr/bin/env node
// Consistency check for an installed node_modules against the package-lock.json
// beside it. worktree-init.sh runs it on the tree it just provisioned; it also
// stands alone in any tree:
//
//   node scripts/check-node-modules-drift.mjs [dir] [--all]
//                                             [--shared-from <dir>]
//
// It exits 0 when the tree matches its lockfile, 1 when it drifted from it, and 2
// when it could not be verified either way.
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
// What it cannot see from the version-keyed diff alone: a `file:` tarball
// dependency keeps its version string across a re-vendor, so a mirror whose
// installed bytes lag the worktree's lockfile passes on version identity while
// running stale code. fileDependencyIntegrity() below closes that one gap with an
// independent integrity comparison; every other class here still asserts nothing
// below a version number, and a tree npm cannot diff at all is reported as
// unverified and exits non-zero rather than passing.
//
// Driving that comparison, measured 2026-08-24 against npm 11.19.0 / node 26.7.0
// in throwaway trees: `npm install --package-lock-only` on a `file:` dependency
// whose tarball changed bytes without changing its version left the lockfile's
// integrity untouched (npm treated the existing satisfying entry as up to date
// and never re-hashed), so the divergence has to be read from an install that
// actually happened rather than produced by asking npm to only refresh the
// lockfile. A real `npm install` against the new tarball, by contrast, both
// updates package-lock.json's integrity AND leaves node_modules/.package-lock.json
// -- npm's own record of what it actually extracted -- holding that same value;
// an install that has not been re-run since keeps the old value there. So a
// `file:` entry's installed staleness is read by comparing the checked
// package-lock.json's integrity for that path against node_modules/.package-lock.json's
// (which the mirror shares from the primary by symlink, same as everything else
// it mirrors) rather than by re-deriving what npm would install.
//
// A record that cannot be read is two different situations, told apart by
// whether node_modules is there at all, and the same measurement session settled
// both:
//   - No node_modules: the dry run reports every package as an `add`, which the
//     classes above already report as missing. Nothing is installed to be stale,
//     so the integrity comparison stays out of that verdict rather than replacing
//     it with a tree the check could not read.
//   - node_modules populated, its record gone: the dry run goes quiet. Against a
//     real install it reported no entry at all, and against a symlink mirror only
//     the same-version `change` entries the mirror's shape produces anyway --
//     both while the installed bytes were the pre-re-vendor ones. So npm's diff
//     names nothing here that any class above could fail on, and the record's
//     absence is exactly what blinds the one class that could. The tree is
//     reported unverified and exits 2, after the classes above have had their say
//     in the same report.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

const plural = (count, singular, pluralForm = `${singular}s`) =>
  `${count} ${count === 1 ? singular : pluralForm}`;

/** The lines a drifted tree reports: what is wrong, then how to fix it. */
export function formatDrift(dir, drift, sharedFrom = null, limit = LISTED) {
  const staleFile = drift.staleFile ?? [];
  const unreadableRecord = drift.unreadableRecord ?? null;
  const width = Math.max(
    1,
    ...[...drift.wrongVersion, ...drift.missing, ...staleFile].map(
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
    ...staleFile.map((item) => ({
      name: item.name,
      text: `installed content does not match the lockfile's integrity (version ${item.version} unchanged)`,
    })),
  ].sort(
    (a, b) => a.name.localeCompare(b.name) || a.text.localeCompare(b.text),
  );
  const lines = [
    listed.length > 0
      ? `${NAME}: node_modules in ${dir} does not match its package-lock.json.`
      : `${NAME}: node_modules in ${dir} cannot be verified against its package-lock.json.`,
  ];
  if (listed.length > 0) {
    lines.push("");
    for (const item of listed.slice(0, limit)) {
      lines.push(`  ${item.name.padEnd(width)}  ${item.text}`);
    }
    if (listed.length > limit) {
      lines.push(`  ... and ${listed.length - limit} more (--all lists them)`);
    }
  }
  if (unreadableRecord) {
    lines.push(
      "",
      `${unreadableRecord.path} could not be read (${unreadableRecord.reason}), so no file: dependency's installed bytes could be checked against the lockfile's integrity.`,
    );
  }
  const extra =
    drift.extra.length === 0
      ? ""
      : `, plus ${plural(drift.extra.length, "package")} on disk the lockfile does not list`;
  const staleFileCount =
    staleFile.length === 0
      ? ""
      : `, ${plural(staleFile.length, "stale file dependency", "stale file dependencies")}`;
  lines.push(
    "",
    `${plural(drift.wrongVersion.length, "wrong version")}, ${plural(drift.missing.length, "missing package")}${staleFileCount}${extra}.`,
  );
  if (sharedFrom) {
    lines.push(
      listed.length > 0
        ? `These packages are shared by symlink from ${sharedFrom}, whose install does not match this lockfile (it may be older, or from another branch).`
        : `This tree's packages are shared by symlink from ${sharedFrom}, whose install could not be shown to match this lockfile.`,
      `Keep sharing them (fast): run \`npm install\` in ${sharedFrom}, then re-run this script.`,
      `Fix this tree alone (slower): run \`npm ci\` in ${dir} -- it replaces the symlinks with a private tree pinned to this lockfile, cannot rewrite it, and does not write into ${sharedFrom}.`,
    );
  } else {
    lines.push(
      `Run \`npm install\` in ${dir} to reconcile it with the lockfile.`,
    );
  }
  return lines;
}

/** The install-path key's package name: "@openmined/psi.js" from
 * "node_modules/@openmined/psi.js", "leaf" from
 * "node_modules/has-nested/node_modules/leaf". */
function nameFromInstallPath(path) {
  const marker = "node_modules/";
  return path.slice(path.lastIndexOf(marker) + marker.length);
}

/**
 * What npm's own record of what it extracted, node_modules/.package-lock.json,
 * says about the lockfile's `file:` tarball dependencies (a `resolved` starting
 * "file:" carrying a string `integrity` -- a workspace's own local package links
 * the same way but with neither, so it is not in scope here). `stale` names the
 * entries whose installed bytes no longer match `lock`'s recorded integrity
 * though the version string is unchanged: the class `driftFrom`'s version-keyed
 * diff cannot see. `unreadableRecord` is set instead when an installed tree's
 * record could not be read, which leaves that class unchecked; a tree with no
 * node_modules is not that case, per the module header. An entry missing from a
 * readable record is left to `driftFrom`'s own missing/add handling.
 */
export function fileDependencyIntegrity(dir, lock) {
  const fileEntries = Object.entries(lock?.packages ?? {}).filter(
    ([, entry]) =>
      typeof entry?.resolved === "string" &&
      entry.resolved.startsWith("file:") &&
      typeof entry?.integrity === "string",
  );
  const nothingToCompare = { stale: [], unreadableRecord: null };
  if (fileEntries.length === 0) return nothingToCompare;
  if (!existsSync(join(dir, "node_modules"))) return nothingToCompare;

  const recordPath = join(dir, "node_modules", ".package-lock.json");
  let installedLock;
  try {
    installedLock = JSON.parse(readFileSync(recordPath, "utf8"));
  } catch (cause) {
    return {
      stale: [],
      unreadableRecord: { path: recordPath, reason: cause.message },
    };
  }

  const stale = [];
  for (const [path, entry] of fileEntries) {
    const installed = installedLock.packages?.[path];
    if (installed === undefined) continue;
    // A version bump is `driftFrom`'s own wrongVersion class; flagging it again
    // here would double-report the same package under two classes. This class is
    // only the gap that leaves: same recorded version, different bytes.
    if (installed.version !== entry.version) continue;
    if (installed.integrity !== entry.integrity) {
      stale.push({ name: nameFromInstallPath(path), version: entry.version });
    }
  }
  return { stale, unreadableRecord: null };
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
  const drift = driftFrom(parseNpmSummary(run(dir)), {
    lockPaths: lockfileInstallPaths(lock),
    versionAt: (relative) => installedVersionAt(join(dir, relative)),
  });
  const fileIntegrity = fileDependencyIntegrity(dir, lock);
  return {
    ...drift,
    staleFile: fileIntegrity.stale,
    unreadableRecord: fileIntegrity.unreadableRecord,
  };
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

  const drifted =
    drift.wrongVersion.length > 0 ||
    drift.missing.length > 0 ||
    drift.staleFile.length > 0;
  if (drifted || drift.unreadableRecord !== null) {
    const report = formatDrift(dir, drift, sharedFrom, all ? Infinity : LISTED);
    for (const line of report) console.error(line);
    process.exit(drifted ? 1 : 2);
  }

  const extra =
    drift.extra.length === 0
      ? ""
      : `; ${plural(drift.extra.length, "package")} on disk the lockfile does not list, which cannot change what it does`;
  console.log(`${NAME}: node_modules agrees with package-lock.json${extra}.`);
}
