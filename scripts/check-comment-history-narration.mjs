#!/usr/bin/env node
// Comment history-narration guard, run by static_checks.yaml on every pull
// request.
//
// CONTRIBUTING.md's Documentation section states the rule in prose: write the
// target state, not a narration of what changed -- no "now", "previously" or
// "no longer" -- because the reader cannot see the diff, and change history
// belongs in the commit message. It holds in the documentation tiers and in
// source comments alike. A narrating comment goes stale the moment the next
// change lands, and nothing fails when it does: a sentence about what a function
// returns "now" survives three rewrites of that function and then tells the next
// reader something false.
//
// This is the source-comment half of that rule as a check. It reads only the
// comment lines a change ADDS or MODIFIES, so a comment already in the tree is
// out of scope and drains when someone edits the block it sits in. No
// repository-wide sweep stands behind it, and none is implied by it.
//
// THE THREE PARTS
//
//   A. THE RANGE. What the working tree holds that the base branch does not: a
//      merge base against the base branch, then a zero-context diff from there
//      to the working tree, plus the untracked files. Uncommitted work is in
//      scope because the rule is a pre-commit sweep -- a contributor running
//      `npm run check:all` before committing is the run this is written for. The
//      base comes from baseCandidates below; nothing here reaches the network,
//      so the ref has to be in the checkout already.
//
//   B. THE COMMENT LINES. Comments are read out of the TypeScript parse rather
//      than matched out of the raw text, so a `//` inside a string or a regular
//      expression is not a comment and a comment inside a template literal is.
//      Adjacent comment lines are joined into one block before matching, since a
//      phrase written across a line break is one phrase to a reader and two
//      lines to a scan.
//
//   C. THE TELLS. NARRATION_TELLS below, each a phrase whose ordinary reading is
//      a statement about how this repository changed. They are phrases rather
//      than the three words CONTRIBUTING.md names, which is the design decision
//      this check rests on: measured over the 115,834 comment lines of the tree
//      it was written against, bare "now" appears on 329, "no longer" on 187 and
//      "previously" on 11, and nearly every one of those is a statement about
//      run time -- `Date.now()`, a path that no longer exists, a previously
//      captured error. A check on the bare words would report a few hundred
//      correct lines, which is a check nobody keeps green. Each tell below binds
//      the temporal word to a change verb or a change noun instead. The
//      measurement, and the false-positive rate over a sample of merged pull
//      requests, are in docs/notes/comment-history-narration-check.md.
//
// WHAT THIS CHECK DOES NOT COVER
//
//   - Narration written with none of the tells. "The parser accepts a bare
//     number now" reads as narration to a reviewer and matches nothing here. The
//     tells are the phrases that measured at an acceptable false-positive rate,
//     not a model of the English of change; the reviewer still reads the comment.
//   - Documentation. CONTRIBUTING.md's rule holds in `docs/` too, and none of it
//     is read here: Markdown has no comment syntax to scope a match to, so the
//     same phrases over a document would report its legitimate history sections.
//     The Markdown half stays with review.
//   - Any file outside SCANNED_EXTENSIONS. A YAML, shell or Dockerfile comment
//     narrating history is unreported, and so is a `.jsx` one -- the parse
//     selects JSX by the `.tsx` name, and this repository writes JSX there.
//   - A comment already in the tree. That is the scope decision above rather
//     than a gap: an untouched block is never read, while a block that IS
//     touched is read whole, so editing one line of a narrating comment reports
//     the comment.
//   - Whether the narration is TRUE. It reports the shape of the sentence. A
//     comment about what an external tool changed between its own versions is
//     the legitimate case it cannot tell apart, and takes the override.
//   - A path git prints quoted. `core.quotePath` has git C-escape a non-ASCII
//     path in the diff header, and that spelling names no file on disk, so the
//     file is skipped rather than read.
//   - A base branch it cannot find. It fails rather than passing an empty range:
//     a check that silently reads nothing is worse than no check.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { parseSource } from "./lib/typeScriptSources.mjs";

/** The file extensions whose comments this check reads. */
export const SCANNED_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".mjs",
  ".cjs",
];

/**
 * The marker that exempts a comment, written with its reason after `--` the way
 * this repository writes an `eslint-disable-next-line`. It exempts the comment
 * it sits in: one `//` line, or one whole block comment.
 */
export const OVERRIDE_MARKER = "allow-history-narration";

/**
 * The base-branch candidates, in order; the first that resolves in the checkout
 * is what the range is measured from. `PSILINK_NARRATION_BASE` is the override
 * -- a ref or a sha -- for a branch cut from something other than staging.
 */
export function baseCandidates(env) {
  const candidates = [];
  if (env.PSILINK_NARRATION_BASE) candidates.push(env.PSILINK_NARRATION_BASE);
  if (env.GITHUB_BASE_REF) {
    candidates.push(`origin/${env.GITHUB_BASE_REF}`, env.GITHUB_BASE_REF);
  }
  candidates.push("origin/staging", "staging");
  return candidates;
}

/**
 * The phrases reported as history narration. `tell` names the form for the
 * failure message; `pattern` matches a comment block's text with the comment
 * markers stripped and the lines joined by single spaces.
 */
export const NARRATION_TELLS = [
  {
    tell: "a past state named as past",
    pattern:
      /\b(?:was|were|is|are|had|has|have)\s+previously\b|\bpreviously[,;:]|\bformerly\b|\bhistorically\b|\buntil recently\b/i,
  },
  {
    tell: "what the code used to do",
    pattern:
      /(?<!\bwhat\s)\bused to\s+(?:be|live|sit|hold|call|read|write|return|take|throw|emit|run|handle|accept|happen|land|fire|do)\b/i,
  },
  {
    tell: "code called surplus to a past need",
    pattern: /\bno longer\s+(?:needed|used|necessary|required|relevant)\b/i,
  },
  {
    tell: "a reference to the change itself",
    pattern:
      /\bthis\s+(?:change|commit|patch|rewrite|refactor|pull request|PR)\b/i,
  },
  {
    tell: "an earlier version of the code named as such",
    pattern:
      /\bthe\s+(?:old|previous|original|earlier|former|prior)\s+(?:implementation|behaviou?r|approach|design)\b|\b(?:old|previous|earlier|former)\s+behaviou?rs?\b/i,
  },
  {
    tell: "the author narrating their own edit",
    pattern:
      /\bwe\s+(?:now|no longer|used to|previously)\b|\b(?:has|have|had)\s+(?:since\s+)?been\s+(?:renamed|moved|extracted|inlined|promoted|hoisted|folded|superseded)\b/i,
  },
  {
    tell: "code described by where it came from",
    pattern:
      /\bmoved here (?:from|out of)\b|\b(?:renamed|extracted|inlined|hoisted|lifted|split)\s+(?:out\s+)?(?:from|of)\s+(?:the\s+)?(?:old|previous|former)\b/i,
  },
];

/** Whether this check reads the comments of `file`. */
export function isScannedFile(file) {
  return SCANNED_EXTENSIONS.some((extension) => file.endsWith(extension));
}

/** One comment line with its markers and leading indentation removed. */
function stripCommentMarkers(line) {
  return line
    .replace(/^\s*(?:\/\/+|\/\*+|\*+\/|\*)\s?/, "")
    .replace(/\s*\*+\/\s*$/, "")
    .trimEnd();
}

/**
 * The comment blocks of one source: maximal runs of comments on consecutive
 * lines, joined into the text a reader sees. Each block records the span of
 * joined text every source line contributed, so a match maps back to a line.
 *
 * The comments come from the parse walked node by node: TypeScript attaches
 * every comment as leading or trailing trivia of some token, and the end-of-file
 * token carries the ones past the last statement.
 */
export function commentBlocks(fileName, text) {
  const source = parseSource(fileName, text);
  const ranges = new Map();
  const collect = (found) => {
    if (found) for (const range of found) ranges.set(range.pos, range);
  };
  const visit = (node) => {
    collect(ts.getLeadingCommentRanges(text, node.getFullStart()));
    collect(ts.getTrailingCommentRanges(text, node.getEnd()));
    node.forEachChild(visit);
  };
  visit(source);
  collect(
    ts.getLeadingCommentRanges(text, source.endOfFileToken.getFullStart()),
  );

  const lines = text.split("\n");
  const commented = new Set();
  for (const range of ranges.values()) {
    const first = source.getLineAndCharacterOfPosition(range.pos).line;
    const last = source.getLineAndCharacterOfPosition(range.end).line;
    for (let line = first; line <= last; line += 1) commented.add(line);
  }

  const blocks = [];
  let open = null;
  for (const line of [...commented].sort((a, b) => a - b)) {
    if (open === null || line !== open.lines.at(-1) + 1) {
      open = { lines: [], text: "", spans: [] };
      blocks.push(open);
    }
    const stripped = stripCommentMarkers(lines[line]);
    if (open.text.length > 0) open.text += " ";
    open.spans.push({
      end: open.text.length + stripped.length,
      line: line + 1,
    });
    open.text += stripped;
    open.lines.push(line);
  }
  return blocks;
}

/** The source line the joined block text at `offset` came from. */
function lineOfOffset(block, offset) {
  return (block.spans.find((span) => offset < span.end) ?? block.spans.at(-1))
    .line;
}

/** A window of the joined block text around `offset`, for the failure report. */
function excerptAt(block, offset) {
  const start = Math.max(0, offset - 20);
  return `${start > 0 ? "..." : ""}${block.text.slice(start, offset + 70).trim()}`;
}

/**
 * Every history-narration tell in one source, as `{ line, tell, excerpt }`. A
 * block carrying OVERRIDE_MARKER reports nothing; a block carrying it with no
 * reason after `--` reports that instead, so the override cannot be pasted in
 * empty.
 */
export function narrationInSource(fileName, text) {
  const found = [];
  for (const block of commentBlocks(fileName, text)) {
    const marker = block.text.indexOf(OVERRIDE_MARKER);
    if (marker !== -1) {
      if (/^\s*--\s*\S/.test(block.text.slice(marker + OVERRIDE_MARKER.length)))
        continue;
      found.push({
        line: lineOfOffset(block, marker),
        tell: `${OVERRIDE_MARKER} carries no reason after \`--\``,
        excerpt: excerptAt(block, marker),
      });
      continue;
    }
    for (const { tell, pattern } of NARRATION_TELLS) {
      const match = pattern.exec(block.text);
      if (match) {
        found.push({
          line: lineOfOffset(block, match.index),
          tell,
          excerpt: excerptAt(block, match.index),
        });
      }
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

/** Runs git in `root` and returns its stdout, or null when it exits non-zero. */
function git(root, args, { allowFailure = false } = {}) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}

/**
 * The commit the range is measured from: the merge base of HEAD and the first
 * candidate that resolves. Throws naming every candidate when none does, since
 * an unresolvable base leaves an empty range that would read as a pass.
 */
export function resolveBase(root, env) {
  const candidates = baseCandidates(env);
  for (const ref of candidates) {
    const mergeBase = git(root, ["merge-base", ref, "HEAD"], {
      allowFailure: true,
    });
    if (mergeBase) return { commit: mergeBase.trim(), ref };
  }
  throw new Error(
    `Comment history-narration check: none of ${candidates.join(", ")} resolves to a commit this checkout shares history with, so there is no range to read. Set PSILINK_NARRATION_BASE to the ref or sha this branch was cut from, or fetch the base branch into the checkout.`,
  );
}

/**
 * The lines each scanned file GAINS between `base` and the working tree, as
 * `file -> Set of 1-based line numbers`. A modified line is an added line to a
 * zero-context diff, which is what this check wants to read.
 *
 * Untracked files count whole: a file written and not yet committed is the
 * pre-commit run's subject, and `git diff` does not report it.
 */
export function changedLines(root, base) {
  const changed = new Map();
  const addLines = (file, from, count) => {
    const lines = changed.get(file) ?? new Set();
    for (let line = from; line < from + count; line += 1) lines.add(line);
    changed.set(file, lines);
  };

  const diff = git(root, [
    "diff",
    "--unified=0",
    "--no-color",
    "--no-ext-diff",
    "--diff-filter=d",
    base,
    "--",
    ...SCANNED_EXTENSIONS.map((extension) => `*${extension}`),
  ]);
  let file = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const path = line.slice(4).trim();
      file = path === "/dev/null" ? null : path.replace(/^b\//, "");
      continue;
    }
    if (file === null || !line.startsWith("@@")) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      addLines(
        file,
        Number(hunk[1]),
        hunk[2] === undefined ? 1 : Number(hunk[2]),
      );
    }
  }

  const untracked = git(root, [
    "ls-files",
    "-z",
    "--others",
    "--exclude-standard",
  ])
    .split("\0")
    .filter((path) => path.length > 0 && isScannedFile(path));
  for (const path of untracked) {
    addLines(
      path,
      1,
      readFileSync(resolve(root, path), "utf8").split("\n").length,
    );
  }
  return changed;
}

/**
 * Reads every scanned file the range touches, reporting the tells that land on
 * a line the range added.
 */
export function scanRange(root, changed) {
  const violations = [];
  let files = 0;
  for (const [file, lines] of [...changed].sort()) {
    const path = resolve(root, file);
    if (!isScannedFile(file) || !existsSync(path)) continue;
    files += 1;
    for (const found of narrationInSource(file, readFileSync(path, "utf8"))) {
      if (lines.has(found.line)) violations.push({ file, ...found });
    }
  }
  return { files, violations };
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions without the process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const base = resolveBase(root, process.env);
  const { files, violations } = scanRange(
    root,
    changedLines(root, base.commit),
  );
  if (violations.length > 0) {
    console.error(
      `Comment history-narration check failed (${violations.length} comment line${violations.length === 1 ? "" : "s"}):\n`,
    );
    for (const violation of violations) {
      console.error(
        `  ${violation.file}:${violation.line} -- ${violation.tell}`,
      );
      console.error(`    ${violation.excerpt}`);
    }
    console.error(
      "\nA comment states the target state, not what changed (CONTRIBUTING.md, Documentation): the reader cannot see the diff, and change history belongs in the commit message. Rewrite the comment to say what the code does.",
    );
    console.error(
      `If the sentence is about something other than this repository's own history -- what an external tool changed between its versions, or a change the code under test performs -- write \`${OVERRIDE_MARKER} -- <why>\` in the comment.`,
    );
    process.exit(1);
  }
  console.log(
    `Comment history-narration check passed: no history narration on the comment lines ${files} changed file${files === 1 ? "" : "s"} add against ${base.ref}.`,
  );
}
