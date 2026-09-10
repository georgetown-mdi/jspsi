#!/usr/bin/env node
// PreToolUse hook: refuse a `gh pr create` or `gh pr edit` call whose `--title`
// is longer than the squash-merge subject budget, before it reaches GitHub.
//
// Why this exists: psilink squash-merges, so a pull request's title becomes the
// commit subject with GitHub's " (#NNNN)" appended, and CONTRIBUTING.md's
// 50-character subject limit counts that suffix. Every other reading of that
// budget comes after the fact -- the PR Checklist workflow fails the open pull
// request, and ../scripts/format-squash-message.mjs refuses a draft written past
// it -- so a session reusing a board item's own title pays a red run and a
// retitle for it. This is the same rule at the moment the title is written.
//
// THE BUDGET IS NOT A NUMBER HERE. `subjectBudget` in
// ../scripts/format-squash-message.mjs is the one source, so the suffix width,
// the limit it is subtracted from, and the digits assumed for an unknown pull
// request all move together with the normalizer and the drafts it writes.
//
// THE PULL-REQUEST NUMBER, where the call carries one. `gh pr edit` names the
// pull request first, so a number or a pull-request URL written there gives the
// exact suffix; a branch name, an absent argument, and every `gh pr create` call
// leave it unknown, where the normalizer's assumed four-digit suffix applies.
//
// STATED LIMITS.
//   - A title this hook cannot see stays the PR Checklist workflow's to catch: one
//     typed at `gh`'s prompt, written in the editor `--editor` opens, taken from
//     the commits by `--fill`, or set in GitHub's web interface.
//   - At create time the suffix is an estimate, since the pull request has no
//     number yet. Four digits is what every pull request in this repository has;
//     past #9999 the real budget is one character tighter than the one checked
//     here, and the checklist run on the open pull request measures it against
//     the number GitHub assigned.
//   - The flag is read as `--title V`, `--title=V`, `-t V`, `-t=V` or `-tV`. A
//     `-t` riding inside a combined shorthand cluster (`-dt V`) is left alone,
//     because which flag in the cluster takes the value depends on gh's own
//     shorthand table.
//   - Quotes are removed the way a shell removes them, but nothing is expanded
//     and no backslash escape is honored: a title holding a variable or a command
//     substitution is measured as the literal text written, and a title escaped
//     word by word rather than quoted measures as its first word.
//
// Exit 0 allows the call; exit 2 blocks it and feeds stderr back to Claude. Any
// unexpected failure here falls through to exit 0 (fail open) so a bug in this
// hook can never wedge every Bash command.

import {
  SUBJECT_LIMIT,
  squashSuffix,
  subjectBudget,
} from "../scripts/format-squash-message.mjs";
import { commandOf, eventForTools } from "./lib/event.mjs";
import { splitSegments, tokenize, tokenizeRaw } from "./lib/shell.mjs";

/** The `gh pr` subcommands that take a title. `new` is an alias of `create`. */
const TITLED_SUBCOMMANDS = new Set(["create", "new", "edit"]);

const LONG_FLAG = "--title";
const SHORT_FLAG = "-t";

/**
 * A word with its quote characters removed the way a shell removes them: a pair
 * is dropped and whatever the pair held is kept, so an apostrophe inside a
 * double-quoted title survives to be counted.
 */
function unquote(word) {
  let text = "";
  let open = null;
  for (const character of word) {
    if (open === null && (character === '"' || character === "'")) {
      open = character;
    } else if (character === open) {
      open = null;
    } else {
      text += character;
    }
  }
  return text;
}

/**
 * A segment's words, each read two ways: `text` has every quote character
 * stripped, so a structural word matches whether or not it was written quoted,
 * and `written` keeps them, so a title is still counted at the length it was
 * written. `tokenize` is defined over `tokenizeRaw`, so the two split alike;
 * were that ever to stop holding, read no words rather than pair the wrong two.
 */
function wordsOf(segment) {
  const written = tokenizeRaw(segment);
  const stripped = tokenize(segment);
  if (stripped.length !== written.length) return [];
  return stripped.map((text, index) => ({ text, written: written[index] }));
}

/** The title a single word carries, or null when it carries none of its own. */
function attachedTitle({ text, written }) {
  const value = unquote(written);
  if (text.startsWith(`${LONG_FLAG}=`)) {
    return value.slice(LONG_FLAG.length + 1);
  }
  if (!text.startsWith(SHORT_FLAG) || text.length === SHORT_FLAG.length) {
    return null;
  }
  const attached = value.slice(SHORT_FLAG.length);
  return attached.startsWith("=") ? attached.slice(1) : attached;
}

/** Every title the words set, in the order they were written. */
function titlesIn(words) {
  const titles = [];
  for (const [index, word] of words.entries()) {
    if (word.text === LONG_FLAG || word.text === SHORT_FLAG) {
      const value = words[index + 1];
      if (value !== undefined) titles.push(unquote(value.written));
      continue;
    }
    const attached = attachedTitle(word);
    if (attached !== null) titles.push(attached);
  }
  return titles;
}

/** The pull request a word names, or null when it names none as a number. */
function prNumberOf(word) {
  if (word === undefined) return null;
  const match =
    /^#?(\d+)$/.exec(word.text) ?? /\/pull\/(\d+)(?:\/[^/]*)?$/.exec(word.text);
  return match === null ? null : Number(match[1]);
}

/**
 * Where a `gh pr create` or `gh pr edit` invocation starts in the words, and the
 * pull request it names, or null when the segment holds no such invocation. A
 * quoted span is one word, so the command quoted inside a `--body` is not one.
 */
function invocationIn(words) {
  for (let index = 0; index + 2 < words.length; index++) {
    const namesInvocation =
      words[index].text === "gh" &&
      words[index + 1].text === "pr" &&
      TITLED_SUBCOMMANDS.has(words[index + 2].text);
    if (namesInvocation) {
      return { from: index + 3, prNumber: prNumberOf(words[index + 3]) };
    }
  }
  return null;
}

function block(title, prNumber) {
  const budget = subjectBudget(prNumber);
  const estimate =
    prNumber === null
      ? " The pull request has no number yet, so the four-digit suffix every pull request here has is assumed."
      : "";
  process.stderr.write(
    `Blocked by block-over-budget-pr-title hook: the title is ${title.length} characters ` +
      `and the budget is ${budget}: "${title}".\n` +
      `GitHub squash-merges, so this title becomes the commit subject with "${squashSuffix(prNumber)}" ` +
      `appended, and CONTRIBUTING.md's Commit Messages limit of ${SUBJECT_LIMIT} counts that suffix.` +
      `${estimate}\n` +
      `Shorten the title to ${budget} characters or fewer; a board item's own title is usually longer ` +
      "than that, so write a shorter one for the pull request.\n",
  );
  process.exit(2);
}

function main() {
  const event = eventForTools("Bash");
  if (event === null) process.exit(0); // unreadable, or another tool
  const command = commandOf(event);
  if (command === null) process.exit(0);

  for (const segment of splitSegments(command)) {
    const words = wordsOf(segment);
    const invocation = invocationIn(words);
    if (invocation === null) continue;
    const budget = subjectBudget(invocation.prNumber);
    for (const title of titlesIn(words.slice(invocation.from))) {
      if (title.length > budget) block(title, invocation.prNumber);
    }
  }
  process.exit(0);
}

try {
  main();
} catch {
  process.exit(0); // fail open: never wedge Bash on an unexpected hook error
}
