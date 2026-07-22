#!/usr/bin/env node
// PostToolUse hook: after a `gh pr create` call, remind the orchestrator to print
// a ready-to-use squash-and-merge commit message when the PR branch carries more
// than one commit over its base.
//
// Why this exists: psilink merges pull requests with squash-and-merge, so GitHub
// folds every commit on the branch into one commit whose default message is the PR
// title plus a bullet list of commit subjects, not a coherent hand-written summary.
// A maintainer squash-merging a multi-commit PR is better served by a ready-to-paste
// subject and body that follow the repo's Commit Messages rules; this hook surfaces
// that reminder right after the PR is opened rather than leaving it for the
// maintainer to notice is missing.
//
// PostToolUse hooks cannot block -- the command has already run -- so there is no
// block()/exit(2) path here, only an additionalContext message or nothing. Fail
// open on every error (unreadable event, missing git, unresolvable origin/staging):
// a hook whose only job is a reminder must never disrupt the session over it.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const PR_BASE = "origin/staging";

// Number of commits HEAD carries over the PR base, or null when it cannot be
// determined (no git, not a repo, origin/staging not fetched).
function commitCountOverBase(cwd) {
  try {
    const out = execFileSync(
      "git",
      ["rev-list", "--count", `${PR_BASE}..HEAD`],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    const count = Number(out);
    return Number.isInteger(count) && count >= 0 ? count : null;
  } catch {
    return null;
  }
}

function reminder(count) {
  return (
    `This PR branch has ${count} commits over ${PR_BASE}. Print a ready-to-use ` +
    "squash-and-merge commit message for the maintainer to paste when squash-" +
    "merging -- an imperative subject 50 characters or fewer plus a prose body " +
    "summarizing the whole change, under the repo's Commit Messages rules (no " +
    "markdown, no board ids, no self-attribution)."
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

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: reminder(count),
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
