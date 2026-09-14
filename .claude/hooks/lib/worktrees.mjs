// The worktrees of a repository as git reports them, and the containment test
// the worktree hooks ask of a path.
//
// Agent worktrees live under .claude/worktrees/, inside the repository root, so
// every linked worktree sits under the main worktree's own path prefix. The
// worktree owning a path is therefore the longest registered path containing it,
// not the first; this module gives that rule to every hook that needs it rather
// than each parsing `git worktree list --porcelain` on its own.

import { git } from "./shell.mjs";

const CLAUDE_DIR = ".claude";
const WORKTREES_DIR = "worktrees";

const WORKTREE_FIELD = "worktree ";
const HEAD_FIELD = "HEAD ";
const BRANCH_FIELD = "branch ";

/**
 * The records in a `git worktree list --porcelain` listing, in the order git
 * prints them, which puts the main worktree first from any of them. Each record
 * is `{path, head, branch}`, head and branch null when the listing omits them (a
 * bare repository, a detached HEAD). Lines belonging to no record, and fields
 * this repository's hooks do not read, are skipped.
 */
export function parseWorktreeRecords(listing) {
  const records = [];
  for (const line of listing.split("\n")) {
    if (line.startsWith(WORKTREE_FIELD)) {
      records.push({
        path: line.slice(WORKTREE_FIELD.length),
        head: null,
        branch: null,
      });
      continue;
    }
    const current = records[records.length - 1];
    if (current === undefined) continue;
    if (line.startsWith(HEAD_FIELD)) {
      current.head = line.slice(HEAD_FIELD.length);
    } else if (line.startsWith(BRANCH_FIELD)) {
      current.branch = line.slice(BRANCH_FIELD.length);
    }
  }
  return records;
}

/**
 * The worktree records of the repository `directory` belongs to, or null when
 * git would not answer at all: no git, a directory that is gone, a path outside
 * every repository, or a listing with no worktree in it.
 */
export function worktreeRecords(directory) {
  const listing = git(["-C", directory, "worktree", "list", "--porcelain"]);
  if (listing === null) return null;
  const records = parseWorktreeRecords(listing);
  return records.length === 0 ? null : records;
}

/**
 * Whether `path` holds the prefix a child of `directory` holds. That prefix
 * is just "/" at the filesystem root, where appending a separator would build a
 * "//" that nothing starts with and `rm -rf /` would then contain no worktree at
 * all; the root is the one directory that is treated as a child of itself.
 */
export function isStrictlyInside(path, directory) {
  return path.startsWith(directory === "/" ? "/" : `${directory}/`);
}

/** Whether `path` is `directory` or lies under it. */
export function isInside(path, directory) {
  return path === directory || isStrictlyInside(path, directory);
}

/**
 * The `.claude/worktrees` root a path lies under and the single worktree inside
 * it the path belongs to, or null when the path is nowhere near one. The tree is
 * null for the root itself, which is no worktree. Read from the path's own
 * segments rather than from git, so it answers for a tree that is gone and for
 * one no repository here registers.
 */
export function worktreeContext(path) {
  const parts = path.split("/");
  for (let i = 0; i + 1 < parts.length; i++) {
    if (parts[i] === CLAUDE_DIR && parts[i + 1] === WORKTREES_DIR) {
      return {
        root: parts.slice(0, i + 2).join("/"),
        tree: parts.length > i + 2 ? parts.slice(0, i + 3).join("/") : null,
      };
    }
  }
  return null;
}

/**
 * The worktree a path belongs to: the longest registered path containing it, so
 * a linked worktree nested under the main root wins over the main root itself.
 * Undefined when no registered path contains the path at all.
 */
export function owningWorktree(path, paths) {
  return paths
    .filter((candidate) => isInside(path, candidate))
    .sort((first, second) => second.length - first.length)[0];
}
