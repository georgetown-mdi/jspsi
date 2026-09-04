#!/usr/bin/env node
//
// Draft the squash-and-merge commit message for a pull request and print it to
// stdout. Companion to the remind-squash-message.mjs hook, which raises the same
// need at `gh pr create` time; this is the maintainer's side of it, run against
// a pull request that already exists.
//
// psilink squash-merges, so the message GitHub proposes -- the PR title plus a
// bullet list of commit subjects -- is what lands in the history unless someone
// writes a better one. Writing that message is a fixed, repeated prompt, so it
// is a script rather than a habit: one `claude -p` run, pinned to sonnet, over
// the branch's commits, the PR body, and CONTRIBUTING.md.
//
// Usage:
//   node squash-message.mjs <pr-number>
//
// A pull request holding ONE commit is refused rather than drafted for: GitHub
// squash-merges it with that commit's own message, so a drafted one is discarded
// on merge and the writing belongs in the commit instead. The count is `gh pr
// view --json commits`, the list GitHub squashes, rather than a local revision
// walk that would depend on which checkout the script ran from. A `gh` that
// cannot answer -- absent, unauthenticated, offline -- leaves the count unknown,
// which says so on stderr and drafts anyway: the guard is defense in depth for a
// manual run, not the reason the script exists.
//
// GENERATION ONLY. The run is given a read-only tool allowance -- reading files,
// `git log`, `git show`, `gh pr view`, and `gh pr diff` -- and `gh pr merge`,
// `gh pr edit`, and `git push` are named on the deny list besides. Nothing here
// merges, edits, or pushes anything: the message goes to stdout and the
// maintainer decides what to do with it. The colocated test pins that property
// of the argv this builds.
//
// The prompt is left in the maintainer's own words rather than elaborated. It
// names CONTRIBUTING.md with an `@` mention because that is what the interactive
// ritual does, and the conventions it must follow (imperative subject, 50
// characters or fewer, prose body, no markdown) live there rather than being
// restated into the prompt where they would drift from the document.
//
// The prompt goes in on STDIN, and each tool list is one comma-joined token.
// Both are what the real CLI needs rather than preferences: `--allowedTools` and
// `--disallowedTools` are variadic, so they keep consuming argv and swallow a
// trailing prompt argument -- which then arrives as a pile of one-word deny
// rules and the run dies asking for input it was given.

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root: this script lives at .claude/scripts/ inside it. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The tools the run needs, all of them read-only. */
export const ALLOWED_TOOLS = [
  "Read",
  "Bash(git log:*)",
  "Bash(git show:*)",
  "Bash(gh pr view:*)",
  "Bash(gh pr diff:*)",
];

/**
 * The spellings that would make this script do something rather than say
 * something. Redundant with the allowlist above and kept anyway: the allowlist
 * is what a later edit widens, and this list is what such an edit has to delete
 * on purpose.
 */
export const DISALLOWED_TOOLS = [
  "Bash(gh pr merge:*)",
  "Bash(gh pr edit:*)",
  "Bash(gh pr close:*)",
  "Bash(git push:*)",
  "Edit",
  "Write",
];

/** The maintainer's prompt, verbatim, for one pull request. */
export function prompt(prNumber) {
  return (
    "Please use the commit history, the PR body, and @CONTRIBUTING.md to " +
    `write a short squash-and-merge commit message for PR #${prNumber}.`
  );
}

/**
 * The pull-request number in `argv`, or null when there is not exactly one
 * readable positive integer. `#928` is accepted because that is how a PR is
 * written everywhere else; anything else is a usage error rather than a value
 * interpolated into the prompt.
 */
export function parsePrNumber(argv) {
  if (argv.length !== 1) return null;
  const match = /^#?(\d+)$/.exec(argv[0].trim());
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isInteger(number) && number > 0 ? number : null;
}

/** The `gh` argument vector that reports how many commits a pull request holds. */
export function commitCountArgs(prNumber) {
  return [
    "pr",
    "view",
    String(prNumber),
    "--json",
    "commits",
    "--jq",
    ".commits | length",
  ];
}

/**
 * The count in `gh`'s stdout, or null when it is not a plain non-negative
 * integer. Anything else -- an error message, empty output, a JSON blob from a
 * `gh` whose flags moved -- is an unknown count rather than a number coerced
 * out of it.
 */
export function parseCommitCount(stdout) {
  const text = String(stdout ?? "").trim();
  return /^\d+$/.test(text) ? Number(text) : null;
}

/**
 * The reason to refuse `prNumber`, or null when there is a message worth
 * drafting. A null `commitCount` is an unknown count, which does not refuse.
 */
export function refusal(prNumber, commitCount) {
  if (commitCount !== 1) return null;
  return (
    `PR #${prNumber} carries one commit, so GitHub squash-merges it with that ` +
    "commit's own message and a drafted one would be discarded. Amend the " +
    "commit instead.\n"
  );
}

/** The `claude` argument vector. The prompt is not in it; it goes on stdin. */
export function claudeArgs() {
  return [
    "-p",
    "--model",
    "sonnet",
    "--allowedTools",
    ALLOWED_TOOLS.join(","),
    "--disallowedTools",
    DISALLOWED_TOOLS.join(","),
  ];
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions without spawning anything.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const prNumber = parsePrNumber(process.argv.slice(2));
  if (prNumber === null) {
    process.stderr.write("Usage: node squash-message.mjs <pr-number>\n");
    process.exit(2);
  }
  const counted = spawnSync("gh", commitCountArgs(prNumber), {
    cwd: ROOT,
    encoding: "utf8",
  });
  const commitCount =
    !counted.error && counted.status === 0
      ? parseCommitCount(counted.stdout)
      : null;
  if (commitCount === null) {
    process.stderr.write(
      "could not read the pull request's commit count from gh; drafting without the single-commit check\n",
    );
  }
  const refused = refusal(prNumber, commitCount);
  if (refused !== null) {
    process.stderr.write(refused);
    process.exit(2);
  }
  const run = spawnSync("claude", claudeArgs(), {
    cwd: ROOT,
    input: prompt(prNumber),
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (run.error) {
    process.stderr.write(`could not run claude: ${run.error.message}\n`);
    process.exit(1);
  }
  process.exit(run.status ?? 1);
}
