#!/usr/bin/env node
// PR-body checklist guard, run by pr_checklist.yaml on every PR (including a
// body edit, so fixing the description re-runs the check without a new commit).
//
//   1. The `## Checklist` section must exist (the template ships one).
//   2. No box may be left unchecked: `- [ ]` means unresolved.
//   3. The three required lines (Docs, CHANGELOG.md, Security review) must each
//      open a line of their own -- the template says "Do not delete lines here"
//      -- so prose naming one inside another line cannot stand in for it.
//   4. Every checked line must carry a `-- <resolution>` clause with real text.
//   5. An n/a resolution must be `n/a: <reason>` with a non-empty reason; a bare
//      "n/a" (or "n/a" plus punctuation only) earns nothing.
//   6. The Security review line must name the sha it reviewed, and that sha must
//      be the PR head: a commit pushed after a review turns the PR red until the
//      new head is reviewed and the line updated.
//   7. The PR title must fit in 50 characters once GitHub's own `(#<number>)`
//      squash-merge suffix is appended. This rule runs on the runner only,
//      where PR_NUMBER is required and the budget is derived from it;
//      titleBudget()'s 42-character fallback serves a direct call with no
//      number, not reachable through this CLI.
//
// The limits are deliberate. This is a mechanical BACKSTOP for the tells that a
// checklist was left unresolved or resolved dishonestly by shape; whether a
// stated reason is true stays a review call, the same philosophy as
// check-contributing-scope.mjs, and an author who edits the sha without
// re-reading the diff passes rule 6, which reads a string and not a review.
// Only the first `## Checklist` section is read, so a line in a second one is
// not.
//
// Rule 7's own limit: CONTRIBUTING.md lets a pull request carrying a single
// commit skip a hand-written squash message, since GitHub takes that commit's
// own message as the squash subject -- so for a single-commit PR, the title
// checked here is not necessarily the subject that lands. This check enforces
// the title regardless: it is the one field the workflow can see, and the
// maintainer can align the two at merge. It does not branch on commit count to
// guess GitHub's squash behavior.
//
// The template's guidance comments contain example checklist lines, so HTML
// comments are stripped before parsing -- an example can never satisfy or trip
// a rule.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The template's Security review line, whose sha the attestation rule reads. */
const REVIEW_PREFIX = "Security review";

/**
 * The checklist lines the template requires, each matched by the literal text
 * its label opens with: a mention inside another line -- "the Security review is
 * recorded below" -- is prose, and can never stand in for the line itself.
 */
export const REQUIRED_LINES = [
  { name: "Docs", prefix: "Docs:" },
  { name: "Changelog", prefix: "CHANGELOG.md" },
  { name: "Security review", prefix: REVIEW_PREFIX },
];

// The `-- <resolution>` separator: `--` bounded by whitespace (or line end), so
// a flag mention like `--event-stream` inside an item is never mistaken for it.
const RESOLUTION_SEPARATOR = /\s--(?:\s|$)/;

// GitHub stores a body edited in the browser with CRLF endings, and a carriage
// return is a line terminator the item pattern cannot match: unnormalized, every
// checklist line parses as no item at all, so a fully resolved body fails.
function normalizeLineEndings(text) {
  return text.replace(/\r\n?/g, "\n");
}

const COMMENT_OPEN = "<!--";
const COMMENT_CLOSE = "-->";

/** A run's newlines alone, so blanking it leaves every later line number intact. */
function newlinesOf(text) {
  return text.replace(/[^\n]/g, "");
}

/**
 * Blank out HTML comments while preserving line numbers, so the template's
 * example checklist lines inside guidance comments are never parsed as content.
 * An unterminated `<!--` comments out the rest of the body. Scanned opener to
 * closer rather than matched with a lazy `<!--[\s\S]*?-->`, which rescans to the
 * end of the body from every opener and so is quadratic in a run of them: a PR
 * body may be 65536 characters of anything an author likes.
 */
export function stripHtmlComments(text) {
  const parts = [];
  let cursor = 0;
  for (;;) {
    const open = text.indexOf(COMMENT_OPEN, cursor);
    if (open === -1) {
      parts.push(text.slice(cursor));
      return parts.join("");
    }
    parts.push(text.slice(cursor, open));
    const close = text.indexOf(COMMENT_CLOSE, open + COMMENT_OPEN.length);
    if (close === -1) {
      parts.push(newlinesOf(text.slice(open)));
      return parts.join("");
    }
    parts.push(newlinesOf(text.slice(open, close + COMMENT_CLOSE.length)));
    cursor = close + COMMENT_CLOSE.length;
  }
}

/**
 * The Checklist section's items, or null when the section is absent. Each is
 * split at the first `--` separator: the label is the template's own line text,
 * the clause is the author's resolution. The required-line and attestation rules
 * read labels only, so free text in a reason clause can never satisfy a deleted
 * line's presence requirement or attest a commit. A label's backticks are
 * dropped: the template code-spans parts of its line text, and an author's copy
 * need not span the same parts.
 */
function parseChecklist(body) {
  const lines = stripHtmlComments(normalizeLineEndings(body)).split("\n");

  const start = lines.findIndex((line) => /^##\s+Checklist\s*$/.test(line));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }

  const items = [];
  for (let i = start + 1; i < end; i++) {
    const m = /^\s*-\s*\[([ xX])\]\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const text = m[2];
    const separator = RESOLUTION_SEPARATOR.exec(text);
    items.push({
      line: i + 1,
      checked: m[1] !== " ",
      label: (separator ? text.slice(0, separator.index) : text)
        .replace(/`/g, "")
        .trim(),
      clause: separator
        ? text.slice(separator.index + separator[0].length).trim()
        : "",
    });
  }
  return items;
}

function checklistFindings(items) {
  const violations = [];
  if (items === null) {
    violations.push(
      'no "## Checklist" section -- restore the template\'s Checklist with every line resolved',
    );
    return violations;
  }

  for (const { name, prefix } of REQUIRED_LINES) {
    if (!items.some((item) => item.label.startsWith(prefix))) {
      violations.push(
        `required ${name} checklist line (opening "${prefix}") is missing -- the template says "Do not delete lines here"`,
      );
    }
  }

  for (const { line, checked, clause } of items) {
    if (!checked) {
      violations.push(
        `line ${line}: unchecked box -- resolve it: check when done, or check with "n/a: <reason>"`,
      );
      continue;
    }
    if (clause === "") {
      violations.push(
        `line ${line}: checked box without a "-- <resolution>" clause -- state what was done, or "n/a: <reason>"`,
      );
      continue;
    }
    const na = /^n\/a\b\s*(:?)\s*(.*)$/i.exec(clause);
    if (na) {
      const [, colon, reason] = na;
      if (colon !== ":" || !/\w/.test(reason)) {
        violations.push(
          `line ${line}: n/a without a reason -- an n/a must be "n/a: <reason>" tied to this diff`,
        );
      }
    }
  }

  return violations;
}

/** Return the list of checklist violations in PR body `text` (empty = clean). */
export function checklistViolations(text) {
  return checklistFindings(parseChecklist(text));
}

// The attested sha, abbreviated or full, read only from the slot the template
// gives it -- `Security review of <sha>` at the head of the label. A hex string
// anywhere else, in a parenthetical or a resolution clause, is prose a reader
// weighs, not the commit this line attests. A sha written as a code span
// matches: the label reaches here with its backticks already dropped.
const ATTESTED_SHA = /^Security review of\s+([0-9a-f]{7,40})\b/i;

function attestationFindings(items, headSha) {
  const reviews = (items ?? []).filter((item) =>
    item.label.startsWith(REVIEW_PREFIX),
  );
  if (reviews.length === 0) return []; // a deleted line is the checklist's finding
  if (reviews.length > 1) {
    return [
      `line ${reviews[1].line}: more than one Security review line -- keep the section's single line, so there is one sha to read`,
    ];
  }
  const [review] = reviews;
  const attested = ATTESTED_SHA.exec(review.label)?.[1];
  if (attested === undefined) {
    return [
      `line ${review.line}: the Security review line names no sha -- write "Security review of <sha>" with the commit the review read`,
    ];
  }
  if (
    typeof headSha === "string" &&
    !headSha.toLowerCase().startsWith(attested.toLowerCase())
  ) {
    return [
      `line ${review.line}: the Security review line attests ${attested}, which is not this PR's head (${headSha.slice(0, 12)}) -- review the head and update the sha`,
    ];
  }
  return [];
}

/**
 * Return the list of review-attestation violations in PR body `text`, given the
 * PR's head sha -- null when it cannot be determined, as in a local run, which
 * checks only that the line names a sha.
 */
export function attestationViolations(text, headSha) {
  return attestationFindings(parseChecklist(text), headSha);
}

/**
 * The PR head sha this run checks against, from the `PR_HEAD_SHA` the workflow
 * sets, or null when there is none (a local run). An unset or blank value is a
 * head this script could not read, not a head that happens to match nothing,
 * which would leave the comparison silently skipped and the run green.
 */
export function prHeadSha() {
  const value = process.env.PR_HEAD_SHA;
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * The PR title this run checks, from the `PR_TITLE` the workflow sets, or
 * null when there is none (a local run). An unset or blank value is a title
 * this script could not read, not a title that happens to be empty, which
 * would leave the title rule silently skipped and the run green.
 */
export function prTitle() {
  const value = process.env.PR_TITLE;
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** Every PR-body violation this guard checks for (empty = clean). */
export function bodyViolations(text, headSha) {
  const items = parseChecklist(text);
  return [...checklistFindings(items), ...attestationFindings(items, headSha)];
}

/**
 * The character budget for a PR title once GitHub's squash-merge suffix -- a
 * space, `(#`, the PR number, and `)` -- is appended, plus that suffix itself
 * for the violation message (null when the budget is the fallback, with no
 * number to render one from). Derived from `prNumber`'s own digit count
 * rather than a hard-coded width, so a five-digit PR number moves the
 * boundary instead of silently passing a stale one; unset or blank falls
 * back to the 42-character figure CONTRIBUTING.md's guidance quotes, sized
 * for today's four-digit numbers.
 */
export function titleBudget(prNumber) {
  const digits =
    typeof prNumber === "string" || typeof prNumber === "number"
      ? String(prNumber).trim()
      : "";
  if (digits === "") return { budget: 42, suffix: null };
  const suffix = ` (#${digits})`;
  return { budget: 50 - suffix.length, suffix };
}

/**
 * Title-length violations for the squash-merge subject a PR title becomes
 * (empty array = clean): an empty or whitespace-only title, and a title that
 * would not fit the 50-character commit-subject budget once GitHub's merge
 * suffix is appended.
 */
export function titleViolations(title, prNumber) {
  if (typeof title !== "string" || title.trim() === "") {
    return [
      "PR title is empty -- it becomes the squash-merge commit subject, so it must carry one",
    ];
  }
  const { budget, suffix } = titleBudget(prNumber);
  if (title.length <= budget) return [];
  const suffixNote =
    suffix !== null
      ? `GitHub's "${suffix}" merge suffix`
      : `GitHub's " (#<number>)" merge suffix (no PR number available locally, so the 42-character fallback budget applies)`;
  return [
    `PR title is ${title.length} characters, over the ${budget}-character budget once ${suffixNote} is appended -- shorten the title, it becomes the squash-merge commit subject`,
  ];
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions without the process.exit. The body comes from the PR_BODY
// environment variable (how pr_checklist.yaml passes the attacker-influenceable
// text without shell interpolation) or, for local use, a file path argument.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let body;
  let source;
  if (process.env.PR_BODY !== undefined) {
    body = process.env.PR_BODY;
    source = "PR body";
  } else if (process.argv[2] !== undefined) {
    source = process.argv[2];
    body = readFileSync(source, "utf8");
  } else {
    console.error(
      "usage: PR_BODY=<body> node scripts/check-pr-checklist.mjs\n" +
        "   or: node scripts/check-pr-checklist.mjs <body-file>",
    );
    process.exit(2);
  }
  const onRunner = process.env.GITHUB_ACTIONS === "true";
  // On the runner the head must be readable, or the attestation degrades to a
  // presence check and a green result would mean nothing: say so and stop
  // instead of passing quietly.
  const headSha = prHeadSha();
  if (headSha === null && onRunner) {
    console.error(
      "PR checklist check could not read the head sha the workflow passes in PR_HEAD_SHA, so the Security review line's attestation cannot be verified.",
    );
    process.exit(2);
  }
  // Same reasoning as the head sha above: on the runner an unreadable title
  // would leave the title rule silently skipped and the run green. Off the
  // runner there is no PR event to read a title from, so the rule is skipped
  // outright rather than treated as a failure to read one.
  const title = prTitle();
  if (title === null && onRunner) {
    console.error(
      "PR checklist check could not read the PR title the workflow passes in PR_TITLE, so the title-length rule cannot be checked.",
    );
    process.exit(2);
  }
  // Same reasoning again: on the runner an unreadable PR_NUMBER would leave
  // titleBudget() silently on its fallback figure, mismatched to the suffix
  // GitHub actually appends.
  const rawPrNumber = process.env.PR_NUMBER;
  const prNumber =
    typeof rawPrNumber === "string" && rawPrNumber.trim() !== ""
      ? rawPrNumber
      : null;
  if (prNumber === null && onRunner) {
    console.error(
      "PR checklist check could not read the PR number the workflow passes in PR_NUMBER, so the title-length rule's budget cannot be derived.",
    );
    process.exit(2);
  }
  const bodyIssues = bodyViolations(body, headSha);
  const titleIssues = onRunner ? titleViolations(title, prNumber) : [];
  const violations = [...bodyIssues, ...titleIssues];
  if (violations.length > 0) {
    console.error(
      `PR checklist check failed (${violations.length} issue${violations.length === 1 ? "" : "s"}):\n`,
    );
    for (const v of bodyIssues) console.error("  " + source + ": " + v);
    for (const v of titleIssues) console.error("  PR title: " + v);
    console.error(
      "\nSee .github/PULL_REQUEST_TEMPLATE.md, Checklist: every line resolved, every n/a earned with a reason, and the Security review line naming the head it reviewed.",
    );
    process.exit(1);
  }
  console.log("PR checklist check passed.");
}
