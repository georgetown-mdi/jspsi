#!/usr/bin/env node
// Rebase-invariance verifier, run by an agent re-attesting a review across a
// rebase.
//
// `.claude/commands/assess-review.md` (Step 4) lets a round-attested head be
// re-attested with no fresh round when a rebase onto a moved base left the
// branch's own effective diff unchanged: the same paths, holding the same
// programs at both ends, once comments are removed and markdown is excluded.
// This decides that property. A reading of the two diffs is never the
// verification, for the reason the sibling verifier states -- nothing in CI can
// catch a false claim, since `npm run check:pr-checklist` compares the sha on
// the checklist line against the head and has no view of whether the property
// holds.
//
// The comparison is the sibling's, run twice over the paths the branch's diff
// touches: once between the two bases and once between the two heads. A path is
// invariant when both comparisons report exempt or comment-only, which is what
// `verify-nonexecutable-delta.mjs` decides -- markdown by its path, source by
// parsing each side and printing it back with comments suppressed, YAML by
// materializing each side, and everything else UNVERIFIABLE, which fails the
// run. That module holds the whole comparison, its soundness probes, and the
// two cheaper primitives measured wrong; none of it is reimplemented here.
//
// Both comparisons are needed, and each catches a different way a rebase moves
// the branch's diff. A conflict resolution that invents an executable line
// shows up between the two heads. A staging range that changed a file the
// branch also changed shows up between the two bases, and the head comparison
// sees it too, since the rebased head holds both changes. A file staging
// changed that the branch did not touch is in neither diff and is not compared:
// that unread content is what the path in Step 4 admits, on the ground it
// argues there, and it is the reason a verdict here is about the branch's own
// change rather than about the tree it now sits on.
//
// Path collection fails closed the same way the comparison does. A diff record
// whose shape this verifier does not model leaves the run with no verdict at
// all rather than a path set quietly one short, because a path missing from the
// set is a path nothing compares.
//
// The shape the path applies to is checked rather than assumed, since Step 4
// routes a base sync and a rebase differently: each base must be an ancestor of
// its own head, the new base must descend from the old one, and the attested
// head must NOT be an ancestor of the new head. That last check is what
// separates the two -- a base sync leaves a merge commit whose first parent is
// the attested head, so the attested head is an ancestor of it, while a rebase
// re-authors the branch's commits and leaves it none. A head this verifier
// refuses on shape takes the rules Step 4 already states.
//
// Not covered, beyond what the sibling's header lists: markdown content
// wholesale, including a conflict resolved inside a governing document, and
// every path outside the branch's own diff.
//
// Which tree the verdict is about: git runs in the worktree the process was
// invoked from, never the one holding this file, and the run names that
// worktree above its verdicts. Name full shas -- a per-worktree ref (`HEAD`,
// `HEAD~n`, `ORIG_HEAD`) means a different commit in each linked tree.
//
// Exit codes: 0 the property holds; 1 it is violated or a changed path could
// not be verified; 2 usage, a shape this path does not apply to, an invocation
// from outside a git worktree, or a git error; 3 the verifier failed the
// sibling's soundness probes.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  collectVerdicts,
  parseChangedPaths,
  soundnessProbes,
} from "./verify-nonexecutable-delta.mjs";

/**
 * The paths one end's branch diff touches, as `{paths, unreadable}`. A record
 * whose shape `parseChangedPaths` does not model lands in `unreadable` with its
 * raw text, so the run refuses rather than comparing a path set that silently
 * lost an entry.
 */
export function branchChangedPaths({ base, head, git }) {
  const paths = [];
  const unreadable = [];
  for (const entry of parseChangedPaths(
    git(["diff", "--raw", "--no-renames", "-z", base, head]),
  )) {
    if (entry.status === null) unreadable.push(entry.record);
    else paths.push(entry.path);
  }
  return { paths, unreadable };
}

/**
 * Whether `ancestor` is an ancestor of `descendant`, which git also answers
 * true for two names of one commit. Only the documented "not an ancestor" exit
 * is read as false; any other git failure throws, so a bad ref does not pass
 * for an answered question.
 */
export function isAncestor({ ancestor, descendant, git }) {
  try {
    git(["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

/**
 * The reason these four refs are not a rebase of a reviewed branch, or null
 * where they are. Each check names the shape it rules out; Step 4 routes the
 * shapes ruled out here through the rules it already states.
 */
export function rebaseShapeError({ oldBase, oldHead, newBase, newHead, git }) {
  const ancestry = (ancestor, descendant) =>
    isAncestor({ ancestor, descendant, git });
  if (!ancestry(oldBase, oldHead))
    return `the pre-rebase base ${oldBase} is not an ancestor of the pre-rebase head ${oldHead}, so it is not that head's base`;
  if (!ancestry(newBase, newHead))
    return `the post-rebase base ${newBase} is not an ancestor of the post-rebase head ${newHead}, so it is not that head's base`;
  if (!ancestry(oldBase, newBase))
    return `the post-rebase base ${newBase} does not descend from the pre-rebase base ${oldBase}, so the branch was not rebased onto a moved base`;
  if (ancestry(oldHead, newHead))
    return `the pre-rebase head ${oldHead} is an ancestor of ${newHead}, so the head moved by a merge or by added work rather than by a rebase`;
  return null;
}

const RANK = {
  identical: 0,
  exempt: 1,
  "comment-only": 1,
  "executable-delta": 2,
  unverifiable: 3,
};

const IDENTICAL = { verdict: "identical" };

/**
 * One result per path, rolling the two comparisons into the worst verdict
 * either of them reported. A path absent from a comparison is identical at that
 * end -- git reports no record for a blob and mode that match -- so it needs no
 * verdict of its own. `where` names the end the reported verdict came from.
 */
export function rollUpVerdicts({ paths, base, head }) {
  const byPath = (verdicts) => new Map(verdicts.map((v) => [v.path, v]));
  const ends = [
    { where: "base", verdicts: byPath(base) },
    { where: "head", verdicts: byPath(head) },
  ];
  return [...paths].sort().map((path) => {
    let worst = { path, verdict: "identical", where: null };
    for (const { where, verdicts } of ends) {
      const found = verdicts.get(path) ?? IDENTICAL;
      if (RANK[found.verdict] > RANK[worst.verdict])
        worst = { ...found, path, where };
    }
    return worst;
  });
}

/**
 * Per-path results for the branch's diff across the rebase. `git` runs one git
 * command from an array of arguments and returns its stdout, throwing on a
 * nonzero exit; injecting it lets a test drive a fixture repository through the
 * same code the CLI runs against this one. `unreadable` holds the diff records
 * whose shape stopped the run from naming a path set at all.
 */
export function collectInvariance({ oldBase, oldHead, newBase, newHead, git }) {
  const before = branchChangedPaths({ base: oldBase, head: oldHead, git });
  const after = branchChangedPaths({ base: newBase, head: newHead, git });
  const unreadable = [...before.unreadable, ...after.unreadable];
  if (unreadable.length > 0) return { results: [], unreadable };
  const paths = new Set([...before.paths, ...after.paths]);
  const compare = (attested, head) =>
    collectVerdicts({ attested, head, git, paths: [...paths] });
  return {
    results: rollUpVerdicts({
      paths,
      base: compare(oldBase, newBase),
      head: compare(oldHead, newHead),
    }),
    unreadable,
  };
}

const END_NAMES = { base: "the branch's base", head: "the branch's head" };

/** Overall outcome for a run's path results, with the process exit code. */
export function summarizeInvariance(results) {
  const moved = results.filter((result) => RANK[result.verdict] >= 2);
  const holds = moved.length === 0;
  return { holds, moved, first: moved[0] ?? null, exitCode: holds ? 0 : 1 };
}

const LABELS = {
  identical: "identical",
  exempt: "exempt",
  "comment-only": "comment-only",
  "executable-delta": "EXECUTABLE DELTA",
  unverifiable: "UNVERIFIABLE",
};

/** The one-line reason a violated run gives, naming the first path that moved. */
export function violationLine({ path, verdict, where }) {
  const end = END_NAMES[where] ?? "the branch's diff";
  return verdict === "unverifiable"
    ? `${path} could not be verified at ${end}`
    : `${path} changed at ${end}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [oldBase, oldHead, newBase, newHead, ...extra] = process.argv.slice(2);
  if (!oldBase || !oldHead || !newBase || !newHead || extra.length > 0) {
    process.stderr.write(
      "Usage: node .claude/scripts/verify-rebase-invariance.mjs <pre-rebase-base> <pre-rebase-head> <post-rebase-base> <post-rebase-head>\n" +
        "The pre-rebase head is the sha the checklist line attests. Where the bases were not\n" +
        "written down, derive them: the pre-rebase base is 'git merge-base <pre-rebase-head>\n" +
        "<post-rebase-head>' and the post-rebase base is 'git merge-base <post-rebase-head>\n" +
        "origin/staging'.\n" +
        "All four refs resolve in the git worktree this is run from, whatever tree holds the\n" +
        "script, and that worktree is what the verdict is about. A per-worktree ref (HEAD,\n" +
        "HEAD~n, ORIG_HEAD) means a different commit in each linked tree, so name full shas\n" +
        "unless you are running inside the tree you mean.\n",
    );
    process.exit(2);
  }

  const probes = soundnessProbes();
  const failedProbes = probes.filter((probe) => !probe.ok);
  if (failedProbes.length > 0) {
    for (const probe of failedProbes) {
      process.stderr.write(`soundness probe failed: ${probe.name}\n`);
    }
    process.stderr.write(
      `verifier is unsound on typescript ${ts.version} -- no verdict; fix .claude/scripts/verify-nonexecutable-delta.mjs before attesting anything\n`,
    );
    process.exit(3);
  }

  let worktree;
  try {
    worktree = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    process.stderr.write(
      `error: ${process.cwd()} is not inside a git worktree -- this verifier reports on the tree it is run from, so run it inside the one whose refs you are naming (git: ${error.message ?? error})\n`,
    );
    process.exit(2);
  }

  const git = (args) =>
    execFileSync("git", args, {
      cwd: worktree,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });

  const refs = { oldBase, oldHead, newBase, newHead, git };
  let collected;
  try {
    for (const ref of [oldBase, oldHead, newBase, newHead]) {
      git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    }
    const shape = rebaseShapeError(refs);
    if (shape !== null) {
      process.stderr.write(
        `error: ${shape} -- this path is for a rebase; take the rules assess-review.md Step 4 states for the shape you have\n`,
      );
      process.exit(2);
    }
    collected = collectInvariance(refs);
  } catch (error) {
    process.stderr.write(`error: ${error.message ?? error}\n`);
    process.exit(2);
  }

  process.stdout.write(
    `soundness probes: ${probes.length}/${probes.length} passed on typescript ${ts.version}\n`,
  );
  process.stdout.write(`worktree: ${worktree}\n`);
  process.stdout.write(
    `branch diff before the rebase: ${oldBase}..${oldHead}\n`,
  );
  process.stdout.write(
    `branch diff after the rebase:  ${newBase}..${newHead}\n`,
  );

  if (collected.unreadable.length > 0) {
    for (const record of collected.unreadable) {
      process.stderr.write(
        `diff record "${record}" has a shape this verifier does not model, so the paths the branch touches cannot be listed\n`,
      );
    }
    process.stdout.write(
      "\nrebase-invariance property: VIOLATES -- the branch's changed paths could not be listed; this head takes a full review round\n",
    );
    process.exit(1);
  }

  const width = Math.max(...Object.values(LABELS).map((label) => label.length));
  process.stdout.write("paths the branch's diff touches:\n");
  if (collected.results.length === 0) process.stdout.write("  (none)\n");
  for (const { path, verdict, where, reason } of collected.results) {
    const end = where === null ? "" : ` at ${END_NAMES[where]}`;
    process.stdout.write(
      `  [${LABELS[verdict].padEnd(width)}] ${path}${end}\n`,
    );
    if (reason !== undefined)
      process.stdout.write(`   ${" ".repeat(width)} ${reason}\n`);
  }

  const { holds, moved, first, exitCode } = summarizeInvariance(
    collected.results,
  );
  process.stdout.write(
    holds
      ? "\nrebase-invariance property: HOLDS -- the branch's effective diff is unchanged by the rebase; this head may be re-attested, recording both heads on the checklist line\n"
      : `\nrebase-invariance property: VIOLATES -- ${violationLine(first)}${moved.length > 1 ? ` (${moved.length} paths moved in all)` : ""}; this head takes a full review round\n`,
  );
  process.exit(exitCode);
}
