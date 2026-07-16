#!/usr/bin/env node
// PreToolUse hook: refuse a Workflow (review/panel) call while the working tree is
// uncommitted.
//
// Why this exists: reviewers diff `git diff staging...HEAD`, which sees only
// commits. An uncommitted change is invisible to that diff, so a review run against
// a dirty tree returns a FALSE clean -- and a review's clean verdict is what the
// orchestration process trusts, with no downstream backstop to catch the miss.
//
// This is the OPPOSITE default from block-protected-push.mjs. That hook fails OPEN
// because GitHub branch protection backstops a push it misses. Here nothing
// backstops a false clean, so every state where the tree cannot be CONFIRMED clean
// must block: a non-git cwd, a git error, a missing cwd, and a dirty status all
// exit 2. Only an unparseable or non-Workflow event exits 0 -- a clean-tree
// precondition is benign for any workflow, and committing is always available, so
// this applies to every Workflow call rather than being scoped to review scripts
// (scoping by script text would fail open on the scriptPath and resume forms).
//
// Why the porcelain check is a clean signal: `scratch/` and `review_findings.md`
// are gitignored, so a normal review round's own artifacts never appear in
// `git status --porcelain` and never trip this.
//
// Exit 0 allows the call; exit 2 blocks it and feeds stderr back to Claude.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const DIRTY_ENTRIES_SHOWN = 10;

function block(reason) {
  // A multi-line reason (the dirty-entry list) is self-terminating; only a
  // single-line reason takes a trailing period, so the period never glues onto
  // the last listed entry.
  const suffix = reason.includes("\n") ? "\n" : ".\n";
  process.stderr.write(
    `Blocked by require-clean-tree-for-review hook: ${reason}${suffix}`,
  );
  process.exit(2);
}

// Run git with the given args, returning trimmed stdout, or null on any failure
// (non-zero exit, missing binary, non-git directory). The caller decides what a
// null means -- here every null is a fail-closed block.
function git(args) {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function main() {
  let event;
  try {
    event = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.exit(0); // unparseable event -- do not interfere
  }
  if (event.tool_name !== "Workflow") process.exit(0);

  // From here every path fails CLOSED. A missing or non-string cwd is a
  // fail-closed case, not a crash: without a directory to inspect the tree cannot
  // be confirmed clean.
  const cwd = event.cwd;
  if (typeof cwd !== "string" || cwd.length === 0) {
    block(
      "could not locate a git repo to confirm a clean tree; commit and retry",
    );
  }

  const root = git(["-C", cwd, "rev-parse", "--show-toplevel"]);
  if (!root) {
    block(
      "could not locate a git repo to confirm a clean tree; commit and retry",
    );
  }

  const status = git(["-C", root, "status", "--porcelain"]);
  if (status === null) {
    block(
      "could not read git status to confirm a clean tree; commit and retry",
    );
  }
  if (status.length === 0) process.exit(0);

  const entries = status.split("\n");
  const shown = entries.slice(0, DIRTY_ENTRIES_SHOWN);
  const more = entries.length - shown.length;
  const list =
    shown.map((e) => `  ${e}`).join("\n") +
    (more > 0 ? `\n  ...and ${more} more` : "");
  block(
    "the working tree is not clean; reviewers diff staging...HEAD and see only " +
      "commits, so commit or stash first. Uncommitted entries:\n" +
      list,
  );
}

try {
  main();
} catch {
  // Structural fail-closed backstop: the two exit-0 cases (unparseable event,
  // non-Workflow tool) are decided before any throwing code, so any error that
  // reaches here is on a path that must block, not allow.
  block("could not confirm a clean tree; commit and retry");
}
