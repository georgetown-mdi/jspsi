#!/usr/bin/env node
// PreToolUse hook: refuse an Edit, Write, or NotebookEdit that would write a file
// git does not ignore into a checkout of this repository that the session is not
// working in -- the MAIN worktree always, and a sibling worktree when the session
// is itself working inside a linked one.
//
// Why this exists: review and fixing run by ref. The orchestrating session stays
// in the primary checkout and never enters a branch's tree, while every branch
// lives in its own worktree under .claude/worktrees/ and every writing spawn is
// pointed at that tree by absolute path. A write that lands in the primary
// checkout instead is therefore always a mistake -- it puts the edit on whatever
// branch the primary checkout happens to hold (staging, typically), off the
// branch under review, where no round will ever see it and no PR will carry it.
//
// THE SIBLING CASE. The file tools take a literal absolute path and are not
// rooted to the session's directory, so a session working in one worktree writes
// into another simply by reusing a path it read from context -- and every
// unmodified tracked file is byte-identical across the trees, so the write
// succeeds, reads back correctly, and shows up only as an unexplained diff on
// somebody else's branch. That is refused for the same reason the main checkout
// is: the bytes land on a branch nobody meant to change.
//
// WHERE THE SESSION IS, and why it matters for exactly one of the two rules. The
// main-worktree refusal is path-scoped: it fires whoever writes and from
// wherever, since no session writes that content. The sibling refusal cannot be,
// because pointing a spawn at a tree by absolute path from the primary checkout
// is the dispatch shape the by-ref model is built on -- a session whose own
// directory is the main checkout writes into a branch's worktree as its normal
// work. So the sibling rule binds only a session already working inside a linked
// worktree, where a write into a DIFFERENT linked worktree has no legitimate
// reading. A session directory that cannot be placed in a worktree at all leaves
// the sibling rule silent, like every other unanswerable state here.
//
// A linked worktree sits UNDER the main root's path prefix (.claude/worktrees/ is
// inside it), so the worktree owning a path is the longest matching entry of
// `git worktree list --porcelain` rather than a prefix test against the first.
//
// WHAT PASSES, and why the test is IGNORED-ness rather than tracked-ness. Under
// the by-ref model the main session writes no branch content at all, so the only
// legitimate writes to this checkout are to paths git ignores -- scratch/,
// briefs, round artifacts -- plus anything outside the repository entirely
// (memory files, /tmp), which is not this hook's business. Everything else there
// is a mistake whether the file exists yet or not: a brand-new source file
// created in the primary checkout lands on whatever branch it holds exactly as
// an edit to a tracked one does, and `git check-ignore` is the one question that
// answers for both. The same question decides the sibling case, asked of the
// worktree that owns the path: an ignored file is not that branch's content
// either. It also passes the gitignored locals a worktree may carry as symlinks
// into another tree, which resolve to their target's checkout before either rule
// looks at them.
//
// FAIL OPEN, deliberately, and opposite to require-clean-tree-for-review.mjs:
// this guard shapes where work is written, and nothing about correctness or
// disclosure rides on it, while a bug here that failed closed would wedge every
// edit in every tree. So the refusal fires only where the path is positively
// determined to be non-ignored content of the main worktree; every unanswerable
// state (no git, a path git will not resolve, a check-ignore that errors rather
// than answering, an unreadable event) allows.
//
// THE DELIBERATE OVERRIDE, the idiom block-model-drop-sendmessage.mjs sets with
// its [accept-model-drop] marker: a maintainer-directed edit of a checkout the
// session is not working in stays possible by creating the sentinel file named in
// OVERRIDE_SENTINEL below IN THAT CHECKOUT, which lifts this hook for it until
// the file is deleted. Edit and Write carry no free-text field a marker could
// ride in, so the deliberate act is a file rather than a phrase. Like that marker
// it is self-applicable -- what it buys is that the override is named, visible in
// the tree, and reversible, not that it cannot be forged.
//
// STATED LIMITS.
//   - Only file_path (Edit, Write) and notebook_path (NotebookEdit) are read. A
//     tool that names its target under some other key is not seen, and neither
//     is a write made through Bash, which this hook does not gate at all.
//   - Ignored-ness is asked of git at the time of the call, and a tracked file
//     is reported as not ignored whatever the exclude patterns say (the check
//     consults the index). A path whose answer changes between this check and
//     the write is answered as git sees it now.
//   - The session's tree is read from the event's cwd, which is where the harness
//     says the session is working, not where any one command ran. A cwd that
//     silently reverted out of an entered worktree therefore reads as the tree it
//     reverted to, so the sibling rule follows the cwd rather than the intent;
//     warn-worktree-revert.mjs is what surfaces that revert.
//
// Exit 0 allows the call; exit 2 blocks it and feeds stderr back to Claude.

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

import { eventCwd, eventForTools } from "./lib/event.mjs";
import { owningWorktree, worktreeRecords } from "./lib/worktrees.mjs";

const GUARDED_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);
const PATH_KEYS = ["file_path", "notebook_path"];
const OVERRIDE_SENTINEL = join(
  ".claude",
  "allow-primary-checkout-writes.local",
);

function blockMainWorktreeWrite(target, mainRoot) {
  process.stderr.write(
    `Blocked by block-primary-checkout-writes hook: '${target}' is repository content of the ` +
      `main worktree at '${mainRoot}', which no session writes -- only paths git ignores there ` +
      "(scratch/, briefs, round artifacts) are writable, whether the file exists yet or not. " +
      "Work on a branch belongs in that branch's own worktree -- write to the absolute path " +
      "under .claude/worktrees/<tree>/ instead, and scope every command to it " +
      "(`cd <tree> && ...` or `git -C <tree> ...`). A file written here would land on whatever " +
      "branch the primary checkout holds, off the branch under review, where no review round " +
      "and no pull request will carry it. For a deliberate, maintainer-directed edit of this " +
      `checkout, create '${OVERRIDE_SENTINEL}' in it and delete it when you are done.\n`,
  );
  process.exit(2);
}

function blockSiblingWorktreeWrite(target, path, owner, sessionTree) {
  process.stderr.write(
    `Blocked by block-primary-checkout-writes hook: '${target}' is repository content of the ` +
      `worktree at '${owner}', but this session is working in '${sessionTree}'. The file tools ` +
      "take the path literally and are not rooted to the working directory, so this would edit " +
      "another branch's checkout, where every unmodified file looks identical and the write " +
      "shows up only as an unexplained diff on that branch. Did you mean " +
      `'${join(sessionTree, relative(owner, path))}'? For a deliberate edit of the other ` +
      `worktree, create '${OVERRIDE_SENTINEL}' in it and delete it when you are done.\n`,
  );
  process.exit(2);
}

function targetPath(toolInput, cwd) {
  for (const key of PATH_KEYS) {
    const value = toolInput?.[key];
    if (typeof value === "string" && value.length > 0) {
      return resolve(cwd ?? ".", value);
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

// Worktree paths of the repository the directory belongs to, main worktree
// first, each resolved through its symlinks the way a target path is; null when
// git would not answer.
function worktreePaths(directory) {
  const records = worktreeRecords(directory);
  return records === null
    ? null
    : records.map((record) => canonical(record.path));
}

// The worktree the session itself is working in, or undefined when its directory
// cannot be placed in one -- an event carrying no cwd, or one outside this
// repository. Undefined leaves the sibling rule silent.
function sessionWorktree(cwd, paths) {
  if (cwd === null) return undefined;
  return owningWorktree(canonical(cwd), paths);
}

// Whether git ignores the path: true, false, or null when git declines to
// answer at all (exit 128, a missing binary), which allows like every other
// unanswerable state. `check-ignore` exits 1 -- a real answer of "not ignored"
// -- for a path no exclude pattern covers and for every tracked file, since it
// consults the index. It takes pathnames rather than pathspecs, so no `:(...)`
// magic is passed: git answers 128 to it.
function isIgnored(root, path) {
  const relativePath = relative(root, path);
  if (relativePath.length === 0 || relativePath.startsWith("..")) return null;
  try {
    execFileSync(
      "git",
      ["-C", root, "check-ignore", "--quiet", "--", relativePath],
      { stdio: "ignore" },
    );
    return true;
  } catch (error) {
    return error?.status === 1 ? false : null;
  }
}

function main() {
  const event = eventForTools(...GUARDED_TOOLS);
  if (event === null) process.exit(0); // unreadable, or another tool

  const cwd = eventCwd(event);
  const target = targetPath(event.tool_input, cwd);
  if (target === null) process.exit(0);
  const path = canonical(target);

  const directory = nearestExistingDirectory(path);
  if (directory === null) process.exit(0);
  const paths = worktreePaths(directory);
  if (paths === null) process.exit(0);

  const mainRoot = paths[0];
  const owner = owningWorktree(path, paths);
  if (owner === undefined) process.exit(0); // outside every checkout of this repo

  const sessionTree = sessionWorktree(cwd, paths);
  const writesAnotherWorktree =
    sessionTree !== undefined &&
    sessionTree !== mainRoot &&
    sessionTree !== owner;
  if (owner !== mainRoot && !writesAnotherWorktree) process.exit(0);

  if (existsSync(join(owner, OVERRIDE_SENTINEL))) process.exit(0);
  if (isIgnored(owner, path) !== false) process.exit(0);

  if (owner === mainRoot) {
    blockMainWorktreeWrite(target, mainRoot);
  } else {
    blockSiblingWorktreeWrite(target, path, owner, sessionTree);
  }
}

try {
  main();
} catch {
  process.exit(0); // fail open: never wedge every edit on an unexpected hook error
}
