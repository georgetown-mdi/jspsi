#!/usr/bin/env node
// PR-body guard, run by pr_checklist.yaml on every PR (including a body edit, so
// fixing the description re-runs the check without a new commit).
//
// The PR template's Checklist section is a set of pre-merge obligations CI does
// not verify; the template requires every line resolved -- checked when done, or
// checked with an `n/a: <reason>`. This is a mechanical BACKSTOP for the tells
// that a checklist was left unresolved or resolved dishonestly by shape; whether
// a stated reason is true stays a review call, the same philosophy as
// check-contributing-scope.mjs.
//
//   1. The `## Checklist` section must exist (the template ships one).
//   2. No box may be left unchecked: `- [ ]` means unresolved.
//   3. The three required lines (Docs, CHANGELOG.md, Security review) must each
//      be present -- the template says "Do not delete lines here".
//   4. Every checked line must carry a `-- <resolution>` clause with real text.
//   5. An n/a resolution must be `n/a: <reason>` with a non-empty reason; a bare
//      "n/a" (or "n/a" plus punctuation only) earns nothing.
//
// The Claims to refute section is the same shape of obligation for the
// description's assertions about its own code: nothing else in the process reads
// a PR's claims against the code, so the section must exist and say something --
// the enumerated claims, or `none -- <reason>`. A bare "none" fails exactly as a
// bare "n/a" does. Whether an enumerated claim is true stays a review call.
//
// The template's guidance comments contain example checklist lines, so HTML
// comments are stripped before parsing -- an example can never satisfy or trip
// a rule.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The checklist lines the template requires, matched by a stable substring. */
export const REQUIRED_LINES = [
  { name: "Docs", substring: "Docs:" },
  { name: "Changelog", substring: "CHANGELOG.md" },
  { name: "Security review", substring: "Security review" },
];

// The `-- <resolution>` separator: `--` bounded by whitespace (or line end), so
// a flag mention like `--event-stream` inside an item is never mistaken for it.
const RESOLUTION_SEPARATOR = /\s--(?:\s|$)/;

/**
 * Blank out HTML comments while preserving line numbers, so the template's
 * example checklist lines inside guidance comments are never parsed as content.
 * An unterminated `<!--` comments out the rest of the body, matching GitHub's
 * rendering.
 */
export function stripHtmlComments(text) {
  let result = text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ""));
  const unterminated = result.indexOf("<!--");
  if (unterminated !== -1) {
    result =
      result.slice(0, unterminated) +
      result.slice(unterminated).replace(/[^\n]/g, "");
  }
  return result;
}

/**
 * Locate the body of the `##` section whose heading matches `heading`, returning
 * `{start, end}` line indices (`start` is the heading itself, `end` is the next
 * `##` heading or the end of the body), or null when the section is absent.
 */
function sectionBounds(lines, heading) {
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/** Return the list of checklist violations in PR body `text` (empty = clean). */
export function checklistViolations(text) {
  const violations = [];
  const lines = stripHtmlComments(text).split("\n");

  const section = sectionBounds(lines, /^##\s+Checklist\s*$/);
  if (section === null) {
    violations.push(
      'no "## Checklist" section -- restore the template\'s Checklist with every line resolved',
    );
    return violations;
  }
  const { start, end } = section;

  // Split each item at the first `--` separator: the label is the template's
  // own line text, the clause is the author's resolution. The required-line
  // check matches labels only, so free text in a reason clause can never
  // satisfy a deleted line's presence requirement.
  const items = [];
  for (let i = start + 1; i < end; i++) {
    const m = /^\s*-\s*\[([ xX])\]\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const text = m[2];
    const separator = RESOLUTION_SEPARATOR.exec(text);
    items.push({
      line: i + 1,
      checked: m[1] !== " ",
      label: separator ? text.slice(0, separator.index) : text,
      clause: separator
        ? text.slice(separator.index + separator[0].length).trim()
        : "",
    });
  }

  for (const { name, substring } of REQUIRED_LINES) {
    if (!items.some((item) => item.label.includes(substring))) {
      violations.push(
        `required ${name} checklist line (matching "${substring}") is missing -- the template says "Do not delete lines here"`,
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

// A claims section that says nothing: "none" alone, or with punctuation only.
// The reason is what makes a none earned, exactly as for a checklist n/a.
const BARE_NONE = /^[-*\s]*none\b[\s.,;:!-]*$/i;

const CLAIMS_GUIDANCE =
  'enumerate every behavioral assertion this PR makes about its own code ("bounded by", "idempotent", "cannot happen", "measured as") with what enforces each, or write "none -- <reason>"';

/** Return the list of Claims-to-refute violations in PR body `text`. */
export function claimsViolations(text) {
  const lines = stripHtmlComments(text).split("\n");

  const section = sectionBounds(lines, /^##\s+Claims to refute\s*$/i);
  if (section === null) {
    return [`no "## Claims to refute" section -- ${CLAIMS_GUIDANCE}`];
  }

  const body = lines
    .slice(section.start + 1, section.end)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (body.length === 0) {
    return [`empty "## Claims to refute" section -- ${CLAIMS_GUIDANCE}`];
  }
  if (body.some((line) => BARE_NONE.test(line))) {
    return [
      'bare "none" under "## Claims to refute" -- a none must be "none -- <reason>" tied to this diff',
    ];
  }
  return [];
}

/** Every PR-body violation this guard checks for (empty = clean). */
export function bodyViolations(text) {
  return [...checklistViolations(text), ...claimsViolations(text)];
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
  const violations = bodyViolations(body);
  if (violations.length > 0) {
    console.error(
      `PR description check failed (${violations.length} issue${violations.length === 1 ? "" : "s"}):\n`,
    );
    for (const v of violations) console.error("  " + source + ": " + v);
    console.error(
      "\nSee .github/PULL_REQUEST_TEMPLATE.md: every Checklist line resolved with an earned reason, and every claim the description makes about its own code listed under Claims to refute.",
    );
    process.exit(1);
  }
  console.log("PR description check passed.");
}
