#!/usr/bin/env node
// Legacy product name check, run by static_checks.yaml through check:all.
//
// Alcove's earlier name was psilink, its repository's jspsi and its container
// image's psi-link. This check fails on any tracked text file that
// holds one of those three names, matched case-insensitively, naming the file
// and line, and on any tracked path that holds one. Its job is to stop the old
// name returning while branches cut before the rename are merged: such a merge
// reintroduces it with no conflict to show. docs/notes/rename-to-alcove.md
// records the rename.
//
// WHAT IT READS: `git ls-files` of the tree it runs in (this repository, or the
// tree `--root` names), and each listed file's contents from the working tree.
// ALLOWLIST names the files that name the old product on purpose, each with its
// reason; their contents are not scanned, their paths are.
//
// WHAT IT CANNOT SEE:
//
//   - Untracked and ignored files: scratch/, node_modules/, a file not yet
//     added. package-lock.json is tracked and is scanned.
//   - Files skipped as binary by extension (BINARY_EXTENSIONS). A binary file
//     of any other extension is scanned as text.
//   - The name spelled some other way: split by a space or a line break, or
//     encoded.
//   - Git history, branch names, and everything outside the tree: the project
//     boards, a clone's directory name, a shell's environment.
//
// EXPIRY. The guard has no job once the branches cut before the rename are
// merged, so it has a date: after EXPIRES_ON it fails without scanning, with a
// message saying to delete it together with its entry in scripts/run-checks.mjs,
// its check:no-legacy-names script in package.json, and its test. `--today
// YYYY-MM-DD` stands in for the current date so the test can drive both arms.

import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { obligationRoot } from "./lib/deferredObligation.mjs";

/** The last date, UTC, on which the check scans rather than fails as expired. */
export const EXPIRES_ON = "2026-12-24";

/** The three names, matched anywhere in a line or path, in any case. */
export const LEGACY_NAME = /jspsi|psilink|psi-link/i;

/** Extensions read as binary and not scanned. */
export const BINARY_EXTENSIONS = [".png", ".ico", ".tgz"];

/** Tracked files whose contents name the old product on purpose. */
export const ALLOWLIST = [
  {
    path: "CHANGELOG.md",
    reason:
      "The rename's entry tells an operator which files to rename, by their old names.",
  },
  {
    path: "docs/notes/rename-to-alcove.md",
    reason:
      "The decision record of the rename maps each old name to its new one.",
  },
  {
    path: "scripts/check-no-legacy-names.mjs",
    reason: "This check matches the names, so it has to spell them.",
  },
  {
    path: "scripts/check-no-legacy-names.test.mjs",
    reason: "The test's fixtures hold the names the check is driven against.",
  },
];

const ALLOWED_PATHS = new Set(ALLOWLIST.map((entry) => entry.path));

/** The files `git ls-files` lists for the tree at `root`. */
export function trackedFiles(root) {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter((path) => path !== "");
}

/**
 * Every place in the tree at `root` holding a legacy name: `{path, line, text}`,
 * where `line` is 0 for a match in the path itself.
 */
export function findLegacyNames(root) {
  const found = [];
  for (const path of trackedFiles(root)) {
    if (LEGACY_NAME.test(path)) found.push({ path, line: 0, text: path });
    if (ALLOWED_PATHS.has(path)) continue;
    if (BINARY_EXTENSIONS.includes(extname(path).toLowerCase())) continue;
    const absolute = resolve(root, path);
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (!stat.isFile()) continue;
    const lines = readFileSync(absolute, "utf8").split("\n");
    for (const [index, text] of lines.entries()) {
      if (LEGACY_NAME.test(text)) {
        found.push({ path, line: index + 1, text: text.trim() });
      }
    }
  }
  return found;
}

/** Whether a check run on `today` (YYYY-MM-DD) falls after EXPIRES_ON. */
export function isExpired(today) {
  return today > EXPIRES_ON;
}

/** Reports `{ok, message}` for the tree at `root` as of `today`. */
export function checkNoLegacyNames({ root, today }) {
  if (isExpired(today)) {
    return {
      ok: false,
      message:
        `the guard expired on ${EXPIRES_ON}. Delete scripts/check-no-legacy-names.mjs ` +
        "and scripts/check-no-legacy-names.test.mjs, its entry in " +
        "scripts/run-checks.mjs, and the check:no-legacy-names script in package.json.",
    };
  }
  const found = findLegacyNames(root);
  if (found.length === 0) {
    return {
      ok: true,
      message: "no tracked file or path names jspsi, psilink, or psi-link.",
    };
  }
  const sites = found
    .map((site) =>
      site.line === 0
        ? `  ${site.path}: the path holds the name`
        : `  ${site.path}:${site.line}: ${site.text.slice(0, 160)}`,
    )
    .join("\n");
  return {
    ok: false,
    message: [
      "these tracked files still hold the product's old name:",
      sites,
      "Write Alcove (or alcove, ALCOVE_ in an identifier) instead. A file that " +
        "has to name the old product goes on ALLOWLIST in " +
        "scripts/check-no-legacy-names.mjs with its reason.",
    ].join("\n"),
  };
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions without the process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const root = obligationRoot(args, "scripts/check-no-legacy-names.mjs");
  const todayFlag = args.indexOf("--today");
  let today = new Date().toISOString().slice(0, 10);
  if (todayFlag !== -1) {
    today = args[todayFlag + 1];
    if (today === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(today)) {
      console.error(
        "usage: node scripts/check-no-legacy-names.mjs [--root <tree>] [--today YYYY-MM-DD]",
      );
      process.exit(2);
    }
  }
  const { ok, message } = checkNoLegacyNames({ root, today });
  (ok ? console.log : console.error)(
    `legacy name check ${ok ? "passed" : "failed"}: ${message}`,
  );
  if (!ok) process.exit(1);
}
