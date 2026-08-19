#!/usr/bin/env node
// PreToolUse hook: refuse an Edit, Write, or NotebookEdit that would change a
// TRACKED file in the repository's MAIN worktree.
//
// Why this exists: review and fixing now run by ref. The orchestrating session
// stays in the primary checkout and never enters a branch's tree, while every
// branch lives in its own worktree under .claude/worktrees/ and every writing
// spawn is pointed at that tree by absolute path. A write that lands in the
// primary checkout instead is therefore always a mistake -- it puts the edit on
// whatever branch the primary checkout happens to hold (staging, typically),
// off the branch under review, where no round will ever see it and no PR will
// carry it.
//
// PATH-SCOPED, NOT ACTOR-SCOPED. The rule is about where the bytes land, not who
// writes them: an implementer writing into .claude/worktrees/<tree>/... is
// untouched, and a write to a tracked primary-checkout file is refused whoever
// makes it. A linked worktree sits UNDER the main root's path prefix here
// (.claude/worktrees/ is inside it), so the owning worktree is the longest
// matching entry of `git worktree list --porcelain` rather than a prefix test
// against the first one.
//
// WHAT PASSES. Untracked and gitignored paths -- scratch/, briefs, round
// artifacts, memory files, anything under /tmp -- are not repository content and
// pass. A path outside any repository is not this hook's business and passes.
//
// FAIL OPEN, deliberately, and opposite to require-clean-tree-for-review.mjs:
// this guard shapes where work is written, and nothing about correctness or
// disclosure rides on it, while a bug here that failed closed would wedge every
// edit in every tree. So the refusal fires only where the path is positively
// determined to be tracked content of the main worktree; every unanswerable
// state (no git, a path git will not resolve, an unreadable event) allows.
//
// THE DELIBERATE OVERRIDE, the idiom block-model-drop-sendmessage.mjs sets with
// its [accept-model-drop] marker: a maintainer-directed primary-checkout edit
// stays possible by creating the sentinel file named in OVERRIDE_SENTINEL below,
// which lifts this hook for that checkout until it is deleted. Edit and Write
// carry no free-text field a marker could ride in, so the deliberate act is a
// file rather than a phrase. Like that marker it is self-applicable -- what it
// buys is that the override is named, visible in the tree, and reversible, not
// that it cannot be forged.
//
// STATED LIMITS.
//   - Only file_path (Edit, Write) and notebook_path (NotebookEdit) are read. A
//     tool that names its target under some other key is not seen, and neither
//     is a write made through Bash, which this hook does not gate at all.
//   - Tracked-ness is asked of git at the time of the call. A file staged for
//     deletion, or one whose tracked-ness changes between this check and the
//     write, is answered as git sees it now.
//
// Exit 0 allows the call; exit 2 blocks it and feeds stderr back to Claude.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

const GUARDED_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);
const PATH_KEYS = ["file_path", "notebook_path"];
const OVERRIDE_SENTINEL = join(
  ".claude",
  "allow-primary-checkout-writes.local",
);

function block(target, mainRoot) {
  process.stderr.write(
    `Blocked by block-primary-checkout-writes hook: '${target}' is tracked content of the ` +
      `main worktree at '${mainRoot}', which no session edits in place. Work on a branch ` +
      "belongs in that branch's own worktree -- write to the absolute path under " +
      ".claude/worktrees/<tree>/ instead, and scope every command to it (`cd <tree> && ...` " +
      "or `git -C <tree> ...`). An edit made here would land on whatever branch the primary " +
      "checkout holds, off the branch under review, where no review round and no pull request " +
      `will carry it. For a deliberate, maintainer-directed edit of this checkout, create ` +
      `'${OVERRIDE_SENTINEL}' in it and delete it when you are done.\n`,
  );
  process.exit(2);
}

// Run git, returning trimmed stdout, or null on any failure. Every null here
// allows the call: this hook fails open.
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

function targetPath(toolInput, cwd) {
  for (const key of PATH_KEYS) {
    const value = toolInput?.[key];
    if (typeof value === "string" && value.length > 0) {
      return resolve(
        typeof cwd === "string" && cwd.length > 0 ? cwd : ".",
        value,
      );
    }
  }
  return null;
}

// The path with symlinks resolved through the part of it that exists on disk, so
// a repository reached through a symlinked parent still matches the absolute
// paths git reports. A file that does not exist yet (a fresh Write) keeps its
// trailing components appended to the resolved prefix.
function canonical(path) {
  const trailing = [];
  let current = path;
  for (;;) {
    try {
      return join(realpathSync(current), ...trailing.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      trailing.push(basename(current));
      current = parent;
    }
  }
}

function nearestExistingDirectory(path) {
  let current = dirname(path);
  for (;;) {
    if (existsSync(current)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// Worktree paths of the repository the directory belongs to, main worktree first
// (git lists it first, from any of them); null when git would not answer.
function worktreePaths(directory) {
  const listing = git(["-C", directory, "worktree", "list", "--porcelain"]);
  if (listing === null) return null;
  const paths = listing
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => canonical(line.slice("worktree ".length)));
  return paths.length === 0 ? null : paths;
}

function isInside(path, directory) {
  return path === directory || path.startsWith(`${directory}/`);
}

// The worktree a path belongs to: the longest registered path containing it, so
// a linked worktree nested under the main root wins over the main root itself.
function owningWorktree(path, paths) {
  return paths
    .filter((candidate) => isInside(path, candidate))
    .sort((a, b) => b.length - a.length)[0];
}

function isTracked(root, path) {
  const relativePath = relative(root, path);
  if (relativePath.length === 0 || relativePath.startsWith("..")) return false;
  return (
    git([
      "-C",
      root,
      "ls-files",
      "--error-unmatch",
      "--",
      `:(literal)${relativePath}`,
    ]) !== null
  );
}

function main() {
  let event;
  try {
    event = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.exit(0); // unparseable event -- do not interfere
  }
  if (!GUARDED_TOOLS.has(event.tool_name)) process.exit(0);

  const target = targetPath(event.tool_input, event.cwd);
  if (target === null) process.exit(0);
  const path = canonical(target);

  const directory = nearestExistingDirectory(path);
  if (directory === null) process.exit(0);
  const paths = worktreePaths(directory);
  if (paths === null) process.exit(0);

  const mainRoot = paths[0];
  if (owningWorktree(path, paths) !== mainRoot) process.exit(0);
  if (existsSync(join(mainRoot, OVERRIDE_SENTINEL))) process.exit(0);
  if (!isTracked(mainRoot, path)) process.exit(0);

  block(target, mainRoot);
}

try {
  main();
} catch {
  process.exit(0); // fail open: never wedge every edit on an unexpected hook error
}
