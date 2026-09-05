// The worktrees of a repository as git reports them, and the containment test
// the worktree hooks ask of a path.
//
// Agent worktrees live under .claude/worktrees/, inside the repository root, so
// every linked worktree sits under the main worktree's own path prefix. The
// worktree owning a path is therefore the longest registered path containing it
// and not the first, which is the rule two hooks each parsed
// `git worktree list --porcelain` for.

import { git } from "./shell.mjs";

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
 * Whether `path` carries the prefix a child of `directory` carries. That prefix
 * is just "/" at the filesystem root, where appending a separator would build a
 * "//" that nothing starts with and `rm -rf /` would then contain no worktree at
 * all; the root is the one directory that reads as a child of itself.
 */
export function isStrictlyInside(path, directory) {
  return path.startsWith(directory === "/" ? "/" : `${directory}/`);
}

/** Whether `path` is `directory` or lies under it. */
export function isInside(path, directory) {
  return path === directory || isStrictlyInside(path, directory);
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
