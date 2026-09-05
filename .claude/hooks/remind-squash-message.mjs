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
// THE COUNT IS TAKEN OVER THE BRANCH THE PULL REQUEST IS OPENED FOR, not over
// the event cwd's HEAD. The repo's by-ref review flow opens pull requests from
// the main checkout with `--head <branch>` while that checkout sits on staging,
// where an origin/staging..HEAD count is 0 -- which would silence this reminder
// on exactly the multi-commit branches it exists for. So when the command
// carries `--head`, the count is origin/staging..<that ref>: linked worktrees
// share one object database, so the branch resolves from whichever checkout the
// command ran in, and no network call is added. A fork-style `owner:branch`
// value counts what follows the colon. With no `--head`, or a value no ref
// resolves for, the count falls back to the cwd's HEAD.
//
// A COMMAND CAN CHAIN SEVERAL `gh pr create` CALLS, and one reminder for the whole
// command is then wrong at both ends: the count would come from the first `--head`
// and the file key from the last PR URL, so a long branch's count lands in a short
// branch's file. Past one create, the `--head` values and the PR numbers are read
// as lists in command and output order and paired by position, one reminder per
// pair carrying more than one commit, joined into a single message. Position is
// the only thing that pairs them, so the pairing is trusted only when the two
// lists are the same length: a create that failed, or output carrying part of what
// ran, leaves lists that cannot be aligned, and the hook emits nothing rather than
// address a message wrongly -- the session's retry of the failed create fires the
// hook again. Within a pair, a `--head` no ref resolves for is skipped rather than
// counted from the cwd's HEAD, which cannot be the branch of more than one pull
// request, and a run whose main checkout root will not resolve emits nothing,
// there being no per-PR file to name without it.
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
// harness's business and is not asserted here: PR URLs are looked for in the
// string-valued candidate fields in turn and taken from the first one carrying
// any -- a payload repeating one result under two field names would otherwise
// list every URL twice and break the pairing -- and a payload carrying none falls
// back to the branch key rather than being wrong. The command is likewise read as
// raw text rather than a parsed argv: a `--head` written inside another flag's
// quoted value is read as if it named the branch, which lands on the
// unresolvable-ref path, and a literal `gh pr create` inside one (a PR body
// quoting the command) counts as another create, routing a single create through
// the pairing path -- where its reminder is unchanged while the lists still pair,
// and dropped when they do not.
//
// PostToolUse hooks cannot block -- the command has already run -- so there is no
// block()/exit(2) path here, only an additionalContext message or nothing. Fail
// open on every error (unreadable event, missing git, unresolvable origin/staging):
// a hook whose only job is a reminder must never disrupt the session over it.

import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { commandOf, eventCwd, eventForTools } from "./lib/event.mjs";
import { git } from "./lib/shell.mjs";

const PR_BASE = "origin/staging";
const MESSAGE_SUBDIR = join("scratch", "squash-messages");
const CANDIDATE_FIELDS = ["output", "stdout", "stderr", "content"];

// A PR URL as `gh pr create` prints it on success, matched loosely enough to
// survive a trailing path segment or a host that is not github.com.
const PR_URL = /https?:\/\/[^\s"']+?\/pull\/(\d+)\b/g;

// `--head <branch>` or `--head=<branch>` as `gh pr create` takes it, with the
// value optionally quoted the way a shell command line carries it.
const HEAD_FLAG = /--head(?:=|\s+)(?:"([^"]*)"|'([^']*)'|(\S+))/g;

const GH_PR_CREATE = /gh pr create/g;

// Number of commits `ref` has over the PR base, or null when it cannot be
// determined (no git, not a repo, origin/staging not fetched, ref unresolvable).
function commitCountOverBase(cwd, ref) {
  const output = git(["rev-list", "--count", `${PR_BASE}..${ref}`, "--"], {
    cwd,
  });
  if (output === null) return null;
  const count = Number(output);
  return Number.isInteger(count) && count >= 0 ? count : null;
}

// Every branch the command tells `gh pr create` to open a pull request for, in
// command order. A fork-style `owner:branch` value keeps the branch.
function headRefsFromCommand(command) {
  return [...command.matchAll(HEAD_FLAG)]
    .map((match) => (match[1] ?? match[2] ?? match[3]).replace(/^[^:]*:/, ""))
    .filter((value) => value !== "");
}

function candidates(toolResponse) {
  if (typeof toolResponse === "string") return [toolResponse];
  if (toolResponse === null || typeof toolResponse !== "object") return [];
  return CANDIDATE_FIELDS.map((field) => toolResponse[field]).filter(
    (value) => typeof value === "string",
  );
}

// Every PR number in the first candidate field carrying one, in output order.
function prNumbersFromResponse(toolResponse) {
  for (const candidate of candidates(toolResponse)) {
    const numbers = [...candidate.matchAll(PR_URL)].map((match) => match[1]);
    if (numbers.length > 0) return numbers;
  }
  return [];
}

function branchKey(cwd) {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
  if (branch === null || branch === "" || branch === "HEAD") return null;
  return `branch-${branch.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
}

function mainCheckoutRoot(cwd) {
  const commonDir = git(["rev-parse", "--git-common-dir"], { cwd });
  if (commonDir === null || commonDir === "") return null;
  try {
    const root = dirname(resolve(cwd, commonDir));
    return statSync(root).isDirectory() ? root : null;
  } catch {
    return null;
  }
}

const MESSAGE_RULES =
  "an imperative subject plus a prose body summarizing the whole change, under " +
  "the Commit Messages rules in CONTRIBUTING.md (no markdown, no board ids, no " +
  "self-attribution), with the subject inside CONTRIBUTING.md's 50-character " +
  'limit, which counts the " (#NNNN)" suffix GitHub appends at squash time';

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

// The reminder for a command carrying a single `gh pr create`, or null when the
// branch does not carry enough commits to need a squash message.
function singleCreateReminder(cwd, command, toolResponse) {
  const [headRef] = headRefsFromCommand(command);
  const count =
    (headRef === undefined ? null : commitCountOverBase(cwd, headRef)) ??
    commitCountOverBase(cwd, "HEAD");
  if (count === null || count <= 1) return null;

  const key = prNumbersFromResponse(toolResponse).at(-1) ?? branchKey(cwd);
  const root = key === null ? null : mainCheckoutRoot(cwd);
  return root === null
    ? printReminder(count)
    : fileReminder(count, join(root, MESSAGE_SUBDIR, `${key}.txt`));
}

// One reminder per created pull request whose branch carries more than one
// commit, or null when nothing qualifies or the heads and the PR numbers cannot
// be paired by position.
function multiCreateReminder(cwd, command, toolResponse) {
  const headRefs = headRefsFromCommand(command);
  const prNumbers = prNumbersFromResponse(toolResponse);
  if (headRefs.length === 0 || headRefs.length !== prNumbers.length)
    return null;
  const root = mainCheckoutRoot(cwd);
  if (root === null) return null;

  const reminders = headRefs
    .map((headRef, index) => ({
      count: commitCountOverBase(cwd, headRef),
      path: join(root, MESSAGE_SUBDIR, `${prNumbers[index]}.txt`),
    }))
    .filter(({ count }) => count !== null && count > 1)
    .map(({ count, path }) => fileReminder(count, path));
  return reminders.length === 0 ? null : reminders.join("\n");
}

function main() {
  const event = eventForTools("Bash");
  if (event === null) process.exit(0); // unreadable, or another tool
  const command = commandOf(event);
  if (command === null) process.exit(0);
  const createCount = [...command.matchAll(GH_PR_CREATE)].length;
  if (createCount === 0) process.exit(0);

  const cwd = eventCwd(event) ?? process.cwd();
  const reminder =
    createCount === 1
      ? singleCreateReminder(cwd, command, event.tool_response)
      : multiCreateReminder(cwd, command, event.tool_response);
  if (reminder === null) process.exit(0);

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
