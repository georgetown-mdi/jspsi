#!/usr/bin/env node
// PostToolUse hook: after a `gh pr create` call, tell the session to WRITE a
// ready-to-paste squash-and-merge commit message to a per-PR file under the main
// checkout's scratch/, when the PR branch carries more than one commit over its
// base.
//
// Why this exists: psilink merges pull requests with squash-and-merge, so GitHub
// folds every commit on the branch into one commit whose default message is the PR
// title plus a bullet list of commit subjects, not a coherent hand-written summary.
// A maintainer squash-merging a multi-commit PR is better served by a ready-to-paste
// subject and body that follow the repo's Commit Messages rules; this hook surfaces
// that need right after the PR is opened rather than leaving it for the maintainer
// to notice is missing.
//
// WHY A FILE RATHER THAN THE TRANSCRIPT. A message printed into the reply is gone
// by merge time: the session keeps working, the message scrolls out of reach, and
// the maintainer merging later has nowhere to look it up. A file keyed by PR
// number has a stable address, and scratch/ is gitignored, so a draft parked
// there never becomes repository content.
//
// THE PATH IS COMPUTED HERE rather than described to the session, so the
// instruction names one absolute file instead of a convention each session
// re-derives:
//   - The key is the PR number parsed out of the `gh pr create` output's PR URL.
//     Where no URL is there to parse, it is the current branch name, sanitized to
//     filename characters and prefixed `branch-` so that a branch named for a
//     number cannot collide with a PR-numbered file.
//   - The directory is scratch/squash-messages/ in the MAIN worktree, found by
//     resolving `git rev-parse --git-common-dir` against the event's cwd and
//     taking its parent. That output is relative in the main worktree and
//     absolute from a linked one (git 2.39.5), which the resolve against cwd
//     settles either way -- so a PR opened from a branch worktree still leaves
//     its message where the maintainer looks, in the checkout they merge from.
// When neither the key nor the root can be determined, the reminder falls back to
// asking for the message in the reply: a message in the transcript is worth more
// than an instruction to write a path that was guessed.
//
// STATED LIMIT. What a PostToolUse payload carries for a Bash result is the
// harness's business and is not asserted here: the PR URL is looked for in every
// string-valued candidate field, and a payload carrying none of them falls back to
// the branch key rather than being wrong.
//
// PostToolUse hooks cannot block -- the command has already run -- so there is no
// block()/exit(2) path here, only an additionalContext message or nothing. Fail
// open on every error (unreadable event, missing git, unresolvable origin/staging):
// a hook whose only job is a reminder must never disrupt the session over it.

import { readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";

const PR_BASE = "origin/staging";
const MESSAGE_SUBDIR = join("scratch", "squash-messages");
const CANDIDATE_FIELDS = ["output", "stdout", "stderr", "content"];

// A PR URL as `gh pr create` prints it on success, matched loosely enough to
// survive a trailing path segment or a host that is not github.com.
const PR_URL = /https?:\/\/[^\s"']+?\/pull\/(\d+)\b/g;

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

// Number of commits HEAD carries over the PR base, or null when it cannot be
// determined (no git, not a repo, origin/staging not fetched).
function commitCountOverBase(cwd) {
  try {
    const count = Number(git(cwd, ["rev-list", "--count", `${PR_BASE}..HEAD`]));
    return Number.isInteger(count) && count >= 0 ? count : null;
  } catch {
    return null;
  }
}

function candidates(toolResponse) {
  if (typeof toolResponse === "string") return [toolResponse];
  if (toolResponse === null || typeof toolResponse !== "object") return [];
  return CANDIDATE_FIELDS.map((field) => toolResponse[field]).filter(
    (value) => typeof value === "string",
  );
}

// The last PR URL in the output wins: `gh pr create` prints its progress line
// first and the URL of the pull request it created last.
function prNumberKey(toolResponse) {
  for (const candidate of candidates(toolResponse)) {
    const matches = [...candidate.matchAll(PR_URL)];
    if (matches.length > 0) return matches[matches.length - 1][1];
  }
  return null;
}

function branchKey(cwd) {
  try {
    const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (branch === "" || branch === "HEAD") return null;
    return `branch-${branch.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
  } catch {
    return null;
  }
}

function mainCheckoutRoot(cwd) {
  try {
    const commonDir = git(cwd, ["rev-parse", "--git-common-dir"]);
    if (commonDir === "") return null;
    const root = dirname(resolve(cwd, commonDir));
    return statSync(root).isDirectory() ? root : null;
  } catch {
    return null;
  }
}

const MESSAGE_RULES =
  "an imperative subject 50 characters or fewer plus a prose body summarizing " +
  "the whole change, under the repo's Commit Messages rules (no markdown, no " +
  "board ids, no self-attribution)";

function fileReminder(count, path) {
  return (
    `This PR branch has ${count} commits over ${PR_BASE}. Write a ready-to-paste ` +
    `squash-and-merge commit message to ${path} -- ${MESSAGE_RULES}. Report only ` +
    "that path and the subject line in your reply: the maintainer reads the " +
    "message out of the file when they squash-merge, and a body printed into the " +
    "transcript is out of reach by then."
  );
}

function printReminder(count) {
  return (
    `This PR branch has ${count} commits over ${PR_BASE}. Print a ready-to-use ` +
    "squash-and-merge commit message for the maintainer to paste when squash-" +
    `merging -- ${MESSAGE_RULES}.`
  );
}

function main() {
  let event;
  try {
    event = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.exit(0); // unreadable event -- do not interfere
  }
  if (event.tool_name !== "Bash") process.exit(0);
  const command = event?.tool_input?.command;
  if (typeof command !== "string" || !command.includes("gh pr create")) {
    process.exit(0);
  }

  const cwd = typeof event.cwd === "string" ? event.cwd : process.cwd();
  const count = commitCountOverBase(cwd);
  if (count === null || count <= 1) process.exit(0);

  const key = prNumberKey(event.tool_response) ?? branchKey(cwd);
  const root = key === null ? null : mainCheckoutRoot(cwd);
  const reminder =
    root === null
      ? printReminder(count)
      : fileReminder(count, join(root, MESSAGE_SUBDIR, `${key}.txt`));

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: reminder,
      },
    }),
  );
  process.exit(0);
}

try {
  main();
} catch {
  process.exit(0); // fail open: never disrupt the session on an unexpected error
}
