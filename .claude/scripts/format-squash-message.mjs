#!/usr/bin/env node
//
// Normalize a squash-and-merge commit message draft, and refuse what a machine
// cannot fix without rewriting the message. Reads the draft from a path or
// stdin, writes the normalized message to stdout or to `--out <path>`.
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
// THE SPLIT BETWEEN NORMALIZING AND REFUSING is whether the fix keeps the words.
// Rewrapping a paragraph, dropping a markdown marker, turning a list item into a
// paragraph, and putting the blank line under the subject all leave the text
// saying what it said, so they happen silently. A fix that would not keep them
// is refused instead: shortening a subject over the budget drops something it
// says, and reflowing an over-wide line inside an indented block destroys the
// shape it was indented for. `refusals` below is the enumeration.
//
// WHAT A CHECK OVER AN ALREADY-WRITTEN DRAFT ASKS. `violations` is empty
// exactly when no refusal fires and the draft is what this script produces from
// it, character for character, so the hook gating a hand-written file has one
// question to ask and the file this script writes always passes it. A body
// wrapped by hand at some other column is not what it produces; the fix is one
// run of this script. Both entry points -- this one and squash-message.mjs --
// run `violations` over what normalizing produced and refuse to hand on output
// it rejects, so a shape the normalizer mangles is a failed run rather than a
// mangled message the maintainer pastes.
//
// WHAT NORMALIZING DOES TO MARKDOWN. Emphasis and an inline code span lose their
// markers and keep the text. A heading marker, a code fence line, and a
// blockquote marker are dropped, and a heading's text becomes a paragraph of its
// own. `[text](url)` becomes `text` with the url in parentheses after it, unless
// the text already holds the url. A list item becomes its own paragraph with its
// marker removed, its continuation lines joined into it, and an indented item
// riding with the item above it.
//
// THE SUBJECT BUDGET COUNTS THE SUFFIX. GitHub appends " (#NNNN)" to the subject
// at squash time, and CONTRIBUTING.md's 50-character limit is on what lands, so
// the budget checked here is 50 minus that suffix's width at the pull request's
// own number, measured against the subject as normalized. A draft written before
// the number is known passes `unassigned`, which assumes the four digits every
// pull request in this repository has.
//
// AN INDENTED BLOCK IS LEFT VERBATIM. Rewrapping indented text would destroy the
// shape someone indented it for, so a block holding an indented line is not
// touched -- and an over-wide line inside one is refused rather than fixed,
// which keeps the wrap guarantee total. A block holding a list marker at column
// 0 is a list rather than indented text, whatever its items are indented by.
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

/** A fenced-code delimiter, whose line is dropped whole. */
const CODE_FENCE = /^\s*(?:```|~~~)/;

/** A heading marker, whose line becomes a paragraph of its own. */
const HEADING = /^\s{0,3}#{1,6}\s+/;

/** A blockquote marker, dropped from the front of the line. */
const BLOCKQUOTE = /^\s*>\s?/;

// A bullet or numbered item starting at column 0. A numbered marker runs to two
// digits: a longer run of digits before a period at the start of a line is
// prose, a year most often.
const TOP_LEVEL_LIST = /^(?:[-*+]|\d{1,2}[.)])\s+/;

/** The same item indented under another one. */
const NESTED_LIST = /^\s+(?:[-*+]|\d{1,2}[.)])\s+/;

/** A markdown link, as text and url. */
const LINK = /\[([^\]]*)\]\(([^)\s]*)\)/g;

/**
 * Markdown a commit message does not take, each with the name of what it is.
 * This names what a report says; what normalizing does with each is
 * `plainText` and `paragraphsOf` below.
 */
const MARKDOWN_MARKERS = [
  { pattern: HEADING, name: "a markdown heading" },
  { pattern: BLOCKQUOTE, name: "a blockquote marker" },
  {
    pattern: /\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|(?<!\w)_[^_]+_(?!\w)/,
    name: "markdown emphasis",
  },
  { pattern: /`[^`]+`/, name: "an inline code span" },
  { pattern: /\[[^\]]*\]\([^)\s]*\)/, name: "a markdown link" },
];

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
 * normalized, trailing whitespace dropped, code fence lines removed, and the
 * blank lines around the whole message removed. `separator` is the line under
 * the subject as written, and the body holds every line after the subject with
 * one blank separator dropped.
 */
export function splitDraft(draft) {
  const lines = String(draft ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => !CODE_FENCE.test(line));
  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  const separator = lines[1];
  return {
    subject: lines[0] ?? "",
    separator,
    body: separator === "" ? lines.slice(2) : lines.slice(1),
  };
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

/**
 * Whether a line a marker sits under is a line a list is written below: a
 * heading, which normalizing gives a paragraph of its own, or a lead-in ending
 * in a colon once its own markers are stripped, so that "The points:" opens one
 * however it was emphasized.
 */
function opensList(above) {
  return HEADING.test(above) || plainText(above).endsWith(":");
}

/**
 * Which lines of the block start a list item. A marker at column 0 starts one
 * where the block opens on it, where an item is already open, or where the line
 * above opens a list; anywhere else it is a word that happens to sit at the
 * front of a wrapped line, and splitting there would lose it.
 */
function itemStarts(block) {
  const starts = [];
  let open = false;
  for (const [index, raw] of block.entries()) {
    const line = raw.replace(BLOCKQUOTE, "");
    const above = index === 0 ? "" : block[index - 1].replace(BLOCKQUOTE, "");
    const item =
      TOP_LEVEL_LIST.test(line) && (index === 0 || open || opensList(above));
    starts.push(item);
    open ||= item;
  }
  return starts;
}

/** Whether the block is indented text, which is copied through as it stands. */
function isVerbatim(block) {
  return (
    block.some((line) => /^\s/.test(line)) && !itemStarts(block).some(Boolean)
  );
}

/** One line with its inline markdown markers removed. */
function plainText(line) {
  return line
    .replace(LINK, (_match, text, url) =>
      text.includes(url) ? text : `${text} (${url})`,
    )
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/(?<!\w)_([^_]+)_(?!\w)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

/** The subject with its markers removed. It is never rewrapped or reflowed. */
function normalizeSubject(subject) {
  return plainText(
    subject
      .replace(BLOCKQUOTE, "")
      .replace(HEADING, "")
      .replace(TOP_LEVEL_LIST, ""),
  );
}

/** A non-verbatim block as the paragraphs it normalizes to, markers removed. */
function paragraphsOf(block) {
  const paragraphs = [];
  const starts = itemStarts(block);
  let current = [];
  const flush = () => {
    const text = current.join(" ").replace(/\s+/g, " ").trim();
    if (text !== "") paragraphs.push(text);
    current = [];
  };
  for (const [index, raw] of block.entries()) {
    const line = raw.replace(BLOCKQUOTE, "");
    if (HEADING.test(line)) {
      flush();
      current.push(plainText(line.replace(HEADING, "")));
      flush();
    } else if (starts[index]) {
      flush();
      current.push(plainText(line.replace(TOP_LEVEL_LIST, "")));
    } else {
      current.push(plainText(line.replace(NESTED_LIST, "")));
    }
  }
  flush();
  return paragraphs;
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
 * The draft with its markdown and its lists turned into paragraphs, every
 * paragraph rewrapped, and one blank line between blocks. Indented blocks and
 * the subject's own words are copied through.
 */
export function normalizeDraft(draft) {
  const { subject, body } = splitDraft(draft);
  const blocks = blocksOf(body).flatMap((block) =>
    isVerbatim(block)
      ? [block]
      : paragraphsOf(block).map((paragraph) => wrapParagraph(paragraph)),
  );
  const lines = [
    normalizeSubject(subject),
    ...blocks.flatMap((block) => ["", ...block]),
  ];
  return `${lines.join("\n")}\n`;
}

/** A line quoted in a report, shortened so the report stays readable. */
function quoted(line) {
  return line.length <= 60 ? line : `${line.slice(0, 57)}...`;
}

/**
 * What is wrong with the draft that normalizing cannot fix: an empty draft, a
 * subject over budget once the suffix is counted, or an over-wide line inside an
 * indented block. Empty means the draft is ready once it is normalized.
 */
export function refusals(draft, prNumber) {
  const { subject, body } = splitDraft(draft);
  const normalized = normalizeSubject(subject);
  if (normalized === "") {
    return ["The draft is empty; a squash message needs a subject line."];
  }

  const found = [];
  const budget = subjectBudget(prNumber);
  if (normalized.length > budget) {
    found.push(
      `The subject is ${normalized.length} characters and the budget is ${budget}: ` +
        `GitHub appends "${squashSuffix(prNumber)}" at squash time, and ` +
        `CONTRIBUTING.md's limit of ${SUBJECT_LIMIT} counts it. Shorten the subject.`,
    );
  }

  for (const block of blocksOf(body).filter(isVerbatim)) {
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
    .filter((block) => !isVerbatim(block))
    .flat()
    .filter(
      (line) => line.length > BODY_WRAP_COLUMNS && /\s/.test(line.trim()),
    );
}

/**
 * What normalizing would change about the draft, named rule by rule where a rule
 * names it. The list is empty exactly when the draft is already what the
 * normalizer produces, so a caller that cannot rewrite the draft can gate on it;
 * the names are a report, and anything they miss is reported as the difference
 * it is.
 */
function unnormalized(draft) {
  if (normalizeDraft(draft) === draft) return [];

  const found = [];
  const { subject, separator, body } = splitDraft(draft);
  if (separator !== undefined && separator !== "") {
    found.push(
      "The line under the subject is not blank, so git reads the whole opening " +
        `as one subject: "${quoted(separator)}". Normalizing puts a blank line ` +
        "between the subject and the body.",
    );
  }
  if (/^\s*(?:```|~~~)/m.test(String(draft ?? ""))) {
    found.push(
      "A commit message takes no markdown, and this draft holds a code fence. " +
        "Normalizing drops the fence line.",
    );
  }

  const listed = (line) =>
    `A commit message body is prose, not a list: "${quoted(line)}". ` +
    "Normalizing drops the marker and makes the item a paragraph.";
  const marked = (line) => {
    const marker = MARKDOWN_MARKERS.find(({ pattern }) => pattern.test(line));
    return marker === undefined
      ? null
      : `A commit message takes no markdown, and this line holds ${marker.name}: ` +
          `"${quoted(line)}". Normalizing drops the marker and keeps the text.`;
  };

  for (const block of [[subject], ...blocksOf(body)].filter(
    (block) => !isVerbatim(block),
  )) {
    const starts = itemStarts(block);
    const isList = starts.some(Boolean);
    for (const [index, line] of block.entries()) {
      if (starts[index] || (isList && NESTED_LIST.test(line))) {
        found.push(listed(line));
        continue;
      }
      const message = marked(line);
      if (message !== null) found.push(message);
    }
  }

  found.push(
    ...overlongBodyLines(draft).map(
      (line) =>
        `A body line is ${line.length} columns and CONTRIBUTING.md wraps at ` +
        `${BODY_WRAP_COLUMNS}: "${quoted(line)}".`,
    ),
  );

  if (found.length === 0) {
    found.push(
      "The draft is not what the normalizer produces from it: the blank lines, " +
        "the trailing whitespace, or the final newline differ.",
    );
  }
  return found;
}

/**
 * Every Commit Messages rule the draft breaks as written, the ones normalizing
 * fixes included. This is what a check over an already-written draft asks; a
 * producer that can still normalize the draft asks `refusals` instead.
 */
export function violations(draft, prNumber) {
  return [...refusals(draft, prNumber), ...unnormalized(draft)];
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

/**
 * The report for output `violations` still rejects: normalizing produced a
 * message its own check refuses, which is a bug here rather than something the
 * draft's author can reword around.
 */
export function selfCheckReport(broken) {
  return (
    "format-squash-message.mjs produced a message that breaks the rules it " +
    "checks for, which is a bug in the script:\n" +
    broken.map((problem) => `  - ${problem}\n`).join("") +
    "Write the message by hand under CONTRIBUTING.md's Commit Messages rules.\n"
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
  const remaining = violations(text, args.prNumber);
  if (remaining.length > 0) {
    process.stderr.write(`${selfCheckReport(remaining)}Nothing was written.\n`);
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
