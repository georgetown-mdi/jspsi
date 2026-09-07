#!/usr/bin/env node
// PreToolUse hook: refuse a Write or Edit that would leave a squash-and-merge
// draft under scratch/squash-messages/ that is not what
// ../scripts/format-squash-message.mjs produces from it, or that breaks a
// Commit Messages rule the normalizer cannot fix without rewriting the message
// -- the `refusals` function there enumerates those.
//
// Why this exists: the maintainer pastes one of these files verbatim into the
// merge box, so what it holds is what lands in the history, and a reminder
// stating the rules in prose does not check the draft written under it. The
// rules are one module, ../scripts/format-squash-message.mjs, which holds the
// limits; this hook runs them over the content the call would write.
//
// WHY IT NAMES THE NORMALIZER RATHER THAN RUNNING IT. The normalizer rewraps a
// body and strips markdown without a decision from anyone, but this hook does
// not rewrite the content of the call it gates: it allows or blocks, and names
// the fix in the refusal -- draft in /tmp, run the normalizer with `--out`, and
// let the script's own write land the file. A script's fs write is not a tool
// call, so nothing here fires on it.
//
// THE PULL-REQUEST NUMBER COMES FROM THE FILE NAME, which is how
// remind-squash-message.mjs keys these files: `<number>.txt` for a pull request
// that exists, `branch-<name>.txt` when the number could not be read. A branch
// key leaves the number unknown, and the subject budget assumes the four-digit
// suffix every pull request in this repository has.
//
// FAIL OPEN, like block-primary-checkout-writes.mjs: the refusal fires only
// where the content is positively determined to break a rule, and every
// unanswerable state allows -- an unreadable event, a Write with no string
// content, an Edit whose file cannot be read or whose old_string is not in it
// (which the tool itself will refuse anyway).
//
// STATED LIMITS.
//   - Only file_path is read, so a draft written through Bash is not seen. The
//     path test is the shape scratch/squash-messages/<name>.txt, taken from the
//     path as given rather than from git, so a symlinked route to the same file
//     under another name is not this hook's business.
//   - An Edit is checked against the file on disk with the replacement applied,
//     which is the content the call produces unless the file changes between
//     this check and the write.
//
// Exit 0 allows the call; exit 2 blocks it and feeds stderr back to Claude.

import { readFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BODY_WRAP_COLUMNS,
  UNASSIGNED_PR,
  violations,
} from "../scripts/format-squash-message.mjs";
import { eventCwd, eventForTools } from "./lib/event.mjs";

const GUARDED_TOOLS = ["Edit", "Write"];
const MESSAGE_DIR = "squash-messages";
const MESSAGE_PARENT = "scratch";
const NORMALIZER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "format-squash-message.mjs",
);

/** Whether the path is a draft file under scratch/squash-messages/. */
function isDraftPath(path) {
  const directory = dirname(path);
  return (
    extname(path) === ".txt" &&
    basename(directory) === MESSAGE_DIR &&
    basename(dirname(directory)) === MESSAGE_PARENT
  );
}

/**
 * The pull-request number the file is keyed by, or null for the `branch-<name>`
 * key remind-squash-message.mjs falls back to when it could not read one.
 */
function prNumberFromPath(path) {
  const match = /^(\d+)\.txt$/.exec(basename(path));
  return match === null ? null : Number(match[1]);
}

/** The file with the Edit's replacement applied, or null when it does not apply. */
function editedContent(path, toolInput) {
  const oldString = toolInput?.old_string;
  const newString = toolInput?.new_string;
  if (typeof oldString !== "string" || typeof newString !== "string") {
    return null;
  }
  let current;
  try {
    current = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const index = current.indexOf(oldString);
  if (oldString !== "" && index === -1) return null;
  if (toolInput.replace_all === true) {
    return current.split(oldString).join(newString);
  }
  return (
    current.slice(0, index) +
    newString +
    current.slice(index + oldString.length)
  );
}

/** The content the call would leave in the file, or null when it cannot be read. */
function resultingContent(event, path) {
  if (event.tool_name === "Write") {
    const content = event.tool_input?.content;
    return typeof content === "string" ? content : null;
  }
  return editedContent(path, event.tool_input);
}

function block(path, prNumber, broken) {
  const prArgument = prNumber === null ? UNASSIGNED_PR : String(prNumber);
  process.stderr.write(
    `Blocked by block-nonconforming-squash-message hook: '${path}' is a squash-and-merge ` +
      "draft the maintainer pastes verbatim into the merge box, and this content breaks " +
      "the Commit Messages rules in CONTRIBUTING.md:\n" +
      broken.map((problem) => `  - ${problem}\n`).join("") +
      `Write the draft to /tmp and normalize it from there: \`node ${NORMALIZER} ` +
      `${prArgument} /tmp/squash-message.txt --out '${path}'\`. That rewraps the body at ` +
      `${BODY_WRAP_COLUMNS} columns, strips the markdown and the list markers, reports ` +
      "what it cannot fix without rewriting the message, and writes the file itself, so " +
      "no Write call is needed.\n",
  );
  process.exit(2);
}

function main() {
  const event = eventForTools(...GUARDED_TOOLS);
  if (event === null) process.exit(0); // unreadable, or another tool

  const target = event.tool_input?.file_path;
  if (typeof target !== "string" || target === "") process.exit(0);
  const path = resolve(eventCwd(event) ?? ".", target);
  if (!isDraftPath(path)) process.exit(0);

  const content = resultingContent(event, path);
  if (content === null) process.exit(0);

  const prNumber = prNumberFromPath(path);
  const broken = violations(content, prNumber);
  if (broken.length > 0) block(target, prNumber, broken);
}

try {
  main();
} catch {
  process.exit(0); // fail open: never wedge a session on an unexpected hook error
}
