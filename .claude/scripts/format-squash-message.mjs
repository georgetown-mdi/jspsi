#!/usr/bin/env node
//
// Normalize a squash-and-merge commit message draft, and refuse the parts of it
// a machine cannot fix. Reads the draft from a path or stdin, writes the
// normalized message to stdout or to `--out <path>`.
//
// Usage:
//   node format-squash-message.mjs <pr-number|unassigned> [<draft-path>] [--out <path>]
//
// Why this exists: a draft under scratch/squash-messages/ is pasted verbatim
// into the merge box, so whatever it holds is what lands in the history. Prose
// restating CONTRIBUTING.md's Commit Messages rules at each producer -- the
// remind-squash-message.mjs reminder, squash-message.mjs's prompt -- checks
// nothing, and a 120-column body line reaches the maintainer intact. This is
// where those rules are executable, and the limits below are the only copy of
// the numbers outside CONTRIBUTING.md's own statement of the rule.
//
// THE SPLIT BETWEEN NORMALIZING AND REFUSING is what a machine can fix without
// authoring. Rewrapping a paragraph changes no words, so the body is rewrapped
// silently. Shortening an over-budget subject, unpicking a markdown marker, or
// turning a list into prose all need someone to decide what the message says, so
// each is refused with the rule named instead. The subject line is never
// rewrapped or reflowed under either half.
//
// THE SUBJECT BUDGET COUNTS THE SUFFIX. GitHub appends " (#NNNN)" to the subject
// at squash time, and CONTRIBUTING.md's 50-character limit is on what lands, so
// the budget checked here is 50 minus that suffix's width at the pull request's
// own number. A draft written before the number is known passes `unassigned`,
// which assumes the four digits every pull request in this repository has.
//
// AN INDENTED BLOCK IS LEFT VERBATIM. Rewrapping indented text would destroy the
// shape someone indented it for, so a block holding an indented line is not
// touched -- and an over-wide line inside one is refused rather than fixed,
// which keeps the wrap guarantee total.
//
// STATED LIMIT. A single word longer than the column budget occupies a line of
// its own, over budget: breaking it would change the text. `violations` exempts
// exactly that line, so a normalized draft always passes the check the
// block-nonconforming-squash-message.mjs hook runs over it.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** CONTRIBUTING.md's subject limit, counting the suffix GitHub appends. */
export const SUBJECT_LIMIT = 50;

/** CONTRIBUTING.md's body wrap: the widest a body line may be. */
export const BODY_WRAP_COLUMNS = 70;

/** The pull-request number argument for a draft written before one exists. */
export const UNASSIGNED_PR = "unassigned";

/** Digits assumed for the suffix when the pull-request number is unknown. */
export const ASSUMED_PR_DIGITS = 4;

/** Markdown a commit message does not take, each with the name of what it is. */
const MARKDOWN_MARKERS = [
  { pattern: /^\s{0,3}#{1,6}\s/, name: "a markdown heading" },
  { pattern: /^\s*(?:```|~~~)/, name: "a code fence" },
  { pattern: /^\s*>\s/, name: "a blockquote marker" },
  { pattern: /\*\*[^*]+\*\*|__[^_]+__/, name: "markdown emphasis" },
  { pattern: /`[^`]+`/, name: "an inline code span" },
  { pattern: /\[[^\]]*\]\([^)\s]*\)/, name: "a markdown link" },
];

/** A bullet or numbered item starting at column 0. */
const TOP_LEVEL_LIST = /^(?:[-*+]\s|\d+[.)]\s)/;

/** The suffix GitHub appends to the subject when it squash-merges. */
export function squashSuffix(prNumber) {
  const digits =
    prNumber === null || prNumber === UNASSIGNED_PR
      ? "N".repeat(ASSUMED_PR_DIGITS)
      : String(prNumber);
  return ` (#${digits})`;
}

/** The characters the subject itself may use, once the suffix is counted. */
export function subjectBudget(prNumber) {
  return SUBJECT_LIMIT - squashSuffix(prNumber).length;
}

/**
 * The draft as a subject, the line under it, and the body: line endings
 * normalized, trailing whitespace dropped, and the blank lines around the whole
 * message removed. `separator` is undefined when the draft is a subject alone.
 */
export function splitDraft(draft) {
  const lines = String(draft ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""));
  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  return { subject: lines[0] ?? "", separator: lines[1], body: lines.slice(2) };
}

/** The body's blank-line-separated blocks, blank lines dropped. */
function blocksOf(body) {
  const blocks = [];
  let block = [];
  for (const line of body) {
    if (line === "") {
      if (block.length > 0) blocks.push(block);
      block = [];
    } else {
      block.push(line);
    }
  }
  if (block.length > 0) blocks.push(block);
  return blocks;
}

/** Whether the block holds an indented line, which leaves it verbatim. */
function isIndented(block) {
  return block.some((line) => /^\s/.test(line));
}

/** One paragraph greedily wrapped, as lines. */
export function wrapParagraph(text, columns = BODY_WRAP_COLUMNS) {
  const lines = [];
  let line = "";
  for (const word of text.split(/\s+/).filter((word) => word !== "")) {
    if (line === "") {
      line = word;
    } else if (line.length + 1 + word.length <= columns) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

/**
 * The draft with every unindented body paragraph rewrapped and one blank line
 * between blocks. The subject line is copied through untouched.
 */
export function normalizeDraft(draft) {
  const { subject, body } = splitDraft(draft);
  const wrapped = blocksOf(body).map((block) =>
    isIndented(block) ? block : wrapParagraph(block.join(" ")),
  );
  const lines = [subject, ...wrapped.flatMap((block) => ["", ...block])];
  return `${lines.join("\n")}\n`;
}

/** A line quoted in a report, shortened so the report stays readable. */
function quoted(line) {
  return line.length <= 60 ? line : `${line.slice(0, 57)}...`;
}

/**
 * What is wrong with the draft that normalizing cannot fix: an empty or
 * over-budget subject, a missing blank line under it, markdown, a top-level
 * list, or an over-wide line inside an indented block. Empty means the draft is
 * ready once its body is rewrapped.
 */
export function refusals(draft, prNumber) {
  const { subject, separator, body } = splitDraft(draft);
  if (subject === "") {
    return ["The draft is empty; a squash message needs a subject line."];
  }

  const found = [];
  const budget = subjectBudget(prNumber);
  if (subject.length > budget) {
    found.push(
      `The subject is ${subject.length} characters and the budget is ${budget}: ` +
        `GitHub appends "${squashSuffix(prNumber)}" at squash time, and ` +
        `CONTRIBUTING.md's limit of ${SUBJECT_LIMIT} counts it. Shorten the subject.`,
    );
  }
  if (separator !== undefined && separator !== "") {
    found.push(
      "The line under the subject is not blank, so git reads the whole opening " +
        `as one subject: "${quoted(separator)}". Put a blank line between the ` +
        "subject and the body.",
    );
  }

  for (const line of [subject, ...body]) {
    if (TOP_LEVEL_LIST.test(line)) {
      found.push(
        `A commit message body is prose, not a list: "${quoted(line)}". Write ` +
          "the point as a sentence.",
      );
      continue;
    }
    const marker = MARKDOWN_MARKERS.find(({ pattern }) => pattern.test(line));
    if (marker !== undefined) {
      found.push(
        `A commit message takes no markdown, and this line holds ${marker.name}: ` +
          `"${quoted(line)}".`,
      );
    }
  }

  for (const block of blocksOf(body).filter(isIndented)) {
    for (const line of block.filter(
      (line) => line.length > BODY_WRAP_COLUMNS,
    )) {
      found.push(
        `An indented line is ${line.length} columns: "${quoted(line)}". ` +
          "Indented text is left as it was written, so wrap it by hand at " +
          `${BODY_WRAP_COLUMNS}.`,
      );
    }
  }
  return found;
}

/**
 * Body lines the normalizer would rewrap: over the column budget with more than
 * one word in them. A line holding a single long word is left out, there being
 * no way to wrap it that does not change the text.
 */
export function overlongBodyLines(draft) {
  return blocksOf(splitDraft(draft).body)
    .filter((block) => !isIndented(block))
    .flat()
    .filter(
      (line) => line.length > BODY_WRAP_COLUMNS && /\s/.test(line.trim()),
    );
}

/**
 * Every Commit Messages rule the draft breaks as written, the wrap included.
 * This is what a check over an already-written draft asks; a producer that can
 * still rewrite the draft asks `refusals` instead.
 */
export function violations(draft, prNumber) {
  return [
    ...refusals(draft, prNumber),
    ...overlongBodyLines(draft).map(
      (line) =>
        `A body line is ${line.length} columns and CONTRIBUTING.md wraps at ` +
        `${BODY_WRAP_COLUMNS}: "${quoted(line)}".`,
    ),
  ];
}

/** The normalized draft and what it still breaks, in one call. */
export function formatDraft(draft, prNumber) {
  return { text: normalizeDraft(draft), refusals: refusals(draft, prNumber) };
}

/**
 * The arguments in `argv`, or null when they are not one pull-request number,
 * at most one draft path, and at most one `--out` path. `#928` is accepted
 * because that is how a pull request is written everywhere else.
 */
export function parseArgs(argv) {
  const positional = [];
  let out = null;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--out") {
      if (out !== null || index + 1 >= argv.length) return null;
      out = argv[++index];
    } else if (argument.startsWith("--out=")) {
      if (out !== null) return null;
      out = argument.slice("--out=".length);
    } else if (argument.startsWith("-") && argument !== "-") {
      return null;
    } else {
      positional.push(argument);
    }
  }
  if (positional.length < 1 || positional.length > 2 || out === "") return null;

  const first = positional[0].trim();
  if (first === UNASSIGNED_PR) {
    return { prNumber: null, input: positional[1] ?? null, out };
  }
  const match = /^#?(\d+)$/.exec(first);
  if (!match || Number(match[1]) <= 0) return null;
  return { prNumber: Number(match[1]), input: positional[1] ?? null, out };
}

/** How the script is called, printed on an unusable argument list. */
export const USAGE =
  "Usage: node format-squash-message.mjs <pr-number|unassigned> [<draft-path>] [--out <path>]\n";

/** The refusal report, for a caller that prints it rather than throwing. */
export function refusalReport(broken) {
  return (
    "This draft breaks the Commit Messages rules in CONTRIBUTING.md, and " +
    "nothing here can fix it without rewriting the message:\n" +
    broken.map((problem) => `  - ${problem}\n`).join("")
  );
}

// CLI entry: only runs when invoked directly, so the hook and the tests can
// import the functions above without reading stdin.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (args === null) {
    process.stderr.write(USAGE);
    process.exit(2);
  }
  let draft;
  try {
    draft = readFileSync(args.input ?? 0, "utf8");
  } catch (error) {
    process.stderr.write(`could not read the draft: ${error.message}\n`);
    process.exit(1);
  }
  const { text, refusals: broken } = formatDraft(draft, args.prNumber);
  if (broken.length > 0) {
    process.stderr.write(`${refusalReport(broken)}Nothing was written.\n`);
    process.exit(2);
  }
  if (args.out === null) {
    process.stdout.write(text);
  } else {
    try {
      writeFileSync(args.out, text);
    } catch (error) {
      process.stderr.write(`could not write ${args.out}: ${error.message}\n`);
      process.exit(1);
    }
  }
  process.exit(0);
}
