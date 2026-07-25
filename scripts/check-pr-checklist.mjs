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
//   1. The `## Checklist` section must exist (the template ships one), and only
//      once: a second copy hides whatever the first one's rules would have read.
//      One heading scan answers both halves, so the section the rules read and
//      the copies the duplicate rule counts are the same headings however they
//      are spelled -- ATX or setext, any case, any trailing decoration.
//   2. No box may be left unchecked: `- [ ]` means unresolved.
//   3. The three required lines (Docs, CHANGELOG.md, Security review) must each
//      open a line of their own -- the template says "Do not delete lines here"
//      -- so prose naming one inside another line cannot stand in for it.
//   4. Every checked line must carry a `-- <resolution>` clause with real text.
//   5. An n/a resolution must be `n/a: <reason>` with a non-empty reason; a bare
//      "n/a" (or "n/a" plus punctuation only) earns nothing.
//
// The Claims to refute section is the same shape of obligation for the
// description's assertions about its own code: nothing else in the process reads
// a PR's claims against the code, so the section must exist once and say
// something -- the enumerated claims, or `none -- <reason>`. A bare "none" fails
// exactly as a bare "n/a" does, and so does a line still carrying one of the
// template's own placeholders verbatim. The none test reads what a line renders
// as, not what it means: it collapses the spellings of an unreasoned none, while
// a sentence that says nothing at length passes it -- that, like whether an
// enumerated claim is true, is a review call.
//
// The Security review line additionally names the sha it reviewed, and that sha
// must be the PR head. pr_checklist.yaml re-runs on `synchronize`, so a commit
// pushed after a review turns the PR red until the new head is reviewed and the
// line updated. The check caps nothing -- a branch may take as many rounds as it
// needs -- and it sits at the merge boundary, where the review actually has to
// hold.
//
// The template's guidance comments contain example checklist lines, so HTML
// comments are stripped before parsing -- an example can never satisfy or trip
// a rule.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The template's Security review line, whose sha the attestation gate reads. */
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

// Markdown decoration: it changes how a line looks, never what it answers.
const EMPHASIS_MARKERS = /[*_`~]/g;

const WORD_CHARACTER = /[\p{L}\p{N}]/u;

/**
 * Cut the leading and trailing characters that carry no word -- markers, pipes,
 * brackets, quotes, punctuation. Scanned rather than matched with an unanchored
 * `[^\p{L}\p{N}]+$`, whose backtracking is quadratic in the length of a run: a
 * PR body may be 65536 characters of anything an author likes.
 */
function trimToWords(text) {
  let start = 0;
  let end = text.length;
  while (start < end && !WORD_CHARACTER.test(text[start])) start += 1;
  while (end > start && !WORD_CHARACTER.test(text[end - 1])) end -= 1;
  return text.slice(start, end);
}

/**
 * Reduce a line to the answer it renders as. HTML tags, `&nbsp;`, the
 * backslashes of escaped punctuation, emphasis and code markers, an ordered-list
 * marker, and every leading and trailing character that is neither letter nor
 * digit come off. The label, none, and n/a tests read this form, so `+ none`,
 * `> none`, `(none)`, `<b>none</b>` and `None...` are one spelling to judge
 * rather than a list of renderings to chase.
 */
function renderedText(line) {
  return trimToWords(
    line
      .replace(/<[^<>]*>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/\\/g, "")
      .replace(EMPHASIS_MARKERS, "")
      .replace(/^\s*\d+[.)]\s*/, ""),
  );
}

/** Whether `label` opens with the template's `prefix`, however it is decorated. */
function opensWith(label, prefix) {
  return renderedText(label).toLowerCase().startsWith(prefix.toLowerCase());
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
 * An unterminated `<!--` comments out the rest of the body, matching GitHub's
 * rendering.
 *
 * Scanned opener to closer rather than matched with a lazy `<!--[\s\S]*?-->`,
 * which rescans to the end of the body from every opener and so is quadratic in
 * a run of them: a PR body may be 65536 characters of anything an author likes.
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

// The guarded sections, named by the text their heading opens with. Only the
// first of each is read, so the section scan and the duplicate rule ask this
// same question of the same headings.
const CHECKLIST_SECTION = "Checklist";
const CLAIMS_SECTION = "Claims to refute";

// An ATX heading: up to three leading spaces (a fourth makes it code), one to
// six `#`, then the title an empty heading omits.
const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;

// A setext underline: the run of `=` (H1) or `-` (H2) under a heading's text.
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;

// A line no underline promotes to a heading: it opens a list item or a
// blockquote, or is indented as code, so the run below it belongs to that block
// as a thematic break rather than underlining it.
const SETEXT_INELIGIBLE = /^ {4}|^ {0,3}(?:[-*+>]|\d+[.)])(?:[ \t]|$)/;

/**
 * Every heading in `lines` as `{level, title, start, end}`, where `end` is the
 * heading's last line -- its underline, for a setext heading.
 *
 * One scan answers for both guarded sections and for both questions asked of
 * them, so there is no spelling that opens a section to one rule and hides it
 * from the other: a respelled second copy is a duplicate rather than a section
 * nothing reads.
 */
function scanHeadings(lines) {
  const headings = [];
  for (let i = 0; i < lines.length; i++) {
    const atx = ATX_HEADING.exec(lines[i]);
    if (atx !== null) {
      headings.push({
        level: atx[1].length,
        title: atx[2] ?? "",
        start: i,
        end: i,
      });
      continue;
    }
    const underline = SETEXT_UNDERLINE.exec(lines[i + 1] ?? "");
    if (
      underline !== null &&
      lines[i].trim() !== "" &&
      !SETEXT_INELIGIBLE.test(lines[i])
    ) {
      headings.push({
        level: underline[1][0] === "=" ? 1 : 2,
        title: lines[i],
        start: i,
        end: i + 1,
      });
      i += 1;
    }
  }
  return headings;
}

/** Whether `heading` opens the guarded section `name`, however it is decorated. */
function opensSection(heading, name) {
  return opensWith(heading.title, name);
}

/**
 * Locate the body of the guarded section `name`: `{start, end}` line indices,
 * `start` being the heading's last line and `end` the next heading at that level
 * or above (or the end of the body). Null when the section is absent.
 */
function sectionBounds(headings, lineCount, name) {
  const index = headings.findIndex((heading) => opensSection(heading, name));
  if (index === -1) return null;
  const section = headings[index];
  for (let i = index + 1; i < headings.length; i++) {
    if (headings[i].level <= section.level) {
      return { start: section.end, end: headings[i].start };
    }
  }
  return { start: section.end, end: lineCount };
}

/**
 * Whether `headings` carries more than one heading for the guarded section
 * `name`. Only the first section is read, so a body that repeats one -- a
 * prefilled template left below a resolved draft -- would hide every line the
 * second one carries.
 */
function isDuplicated(headings, name) {
  return headings.filter((heading) => opensSection(heading, name)).length > 1;
}

// GitHub stores a body edited in the browser with CRLF endings, and a carriage
// return is a line terminator that `.` does not match: unnormalized, every
// checklist line parses as no item at all and all three required lines read as
// deleted, so a fully resolved body fails.
function normalizeLineEndings(text) {
  return text.replace(/\r\n?/g, "\n");
}

/**
 * The body every rule reads: its lines with the endings normalized and the HTML
 * comments blanked, its headings, and the Checklist section's items.
 *
 * Built once per invocation. `bodyViolations` runs three rules over one text,
 * and stripping and splitting it per rule multiplies whatever a hostile body
 * costs to scan.
 */
function parseBody(text) {
  const lines = stripHtmlComments(normalizeLineEndings(text)).split("\n");
  const headings = scanHeadings(lines);
  return { lines, headings, items: checklistItems(lines, headings) };
}

/**
 * Parse the Checklist section's items, or null when the section is absent.
 *
 * Each item is split at the first `--` separator: the label is the template's
 * own line text, the clause is the author's resolution. The required-line check
 * matches labels only, so free text in a reason clause can never satisfy a
 * deleted line's presence requirement.
 */
function checklistItems(lines, headings) {
  const section = sectionBounds(headings, lines.length, CHECKLIST_SECTION);
  if (section === null) return null;

  const items = [];
  for (let i = section.start + 1; i < section.end; i++) {
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
  return items;
}

/**
 * An n/a resolution earns its place only as `n/a: <reason>`: a bare "n/a", or
 * one whose reason is punctuation, resolves nothing.
 */
function isUnreasonedNa(clause) {
  const na = /^n\/a\b\s*(:?)\s*(.*)$/i.exec(renderedText(clause));
  if (na === null) return false;
  const [, colon, reason] = na;
  return colon !== ":" || !/\w/.test(reason);
}

function checklistFindings({ headings, items }) {
  const violations = [];
  if (items === null) {
    violations.push(
      'no "## Checklist" section -- restore the template\'s Checklist with every line resolved',
    );
    return violations;
  }
  if (isDuplicated(headings, CHECKLIST_SECTION)) {
    violations.push(
      'duplicate "## Checklist" section -- only the first is read; delete the leftover copy rather than leave its lines unread',
    );
  }

  for (const { name, prefix } of REQUIRED_LINES) {
    if (!items.some((item) => opensWith(item.label, prefix))) {
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
    if (isUnreasonedNa(clause)) {
      violations.push(
        `line ${line}: n/a without a reason -- an n/a must be "n/a: <reason>" tied to this diff`,
      );
    }
  }

  return violations;
}

/** Return the list of checklist violations in PR body `text` (empty = clean). */
export function checklistViolations(text) {
  return checklistFindings(parseBody(text));
}

// A claims section that says nothing: "none" alone, whatever renders it -- a
// list marker, a table cell, a blockquote, emphasis, an HTML tag, wrapping
// quotes or brackets, trailing punctuation, letters spaced apart. What makes a
// none earned is the reason after it, exactly as for a checklist n/a, so an
// unreasoned n/a in that place says as little as no reason at all.
const BARE_NONE = /^n\s*o\s*n\s*e$/i;

function isUnearnedNone(line) {
  const separator = RESOLUTION_SEPARATOR.exec(line);
  if (separator === null) return BARE_NONE.test(renderedText(line));
  const clause = line.slice(separator.index + separator[0].length).trim();
  return (
    BARE_NONE.test(renderedText(line.slice(0, separator.index))) &&
    (clause === "" || isUnreasonedNa(clause))
  );
}

/**
 * The claims section's placeholders, read verbatim from the shipped template
 * (its guidance comment included, since an author can copy a placeholder out of
 * one): a line still carrying one is unfilled. Matching the template's literal
 * text rather than the shape of a placeholder is what lets a real claim quote a
 * multi-parameter generic -- `Record<string, number>`, `Promise<Result<T, E>>`
 * -- without reading as unfilled. A reword that escapes extraction fails the
 * suite, which runs this rule against that same template.
 */
export const CLAIMS_PLACEHOLDERS = readClaimsPlaceholders();

function readClaimsPlaceholders() {
  const template = readFileSync(
    fileURLToPath(
      new URL("../.github/PULL_REQUEST_TEMPLATE.md", import.meta.url),
    ),
    "utf8",
  );
  const lines = normalizeLineEndings(template).split("\n");
  const section = sectionBounds(
    scanHeadings(lines),
    lines.length,
    CLAIMS_SECTION,
  );
  if (section === null) return [];
  const text = lines.slice(section.start + 1, section.end).join("\n");
  return [...new Set(text.match(/<[^<>\n]+>/g) ?? [])];
}

const CLAIMS_GUIDANCE =
  'enumerate every behavioral assertion this PR makes about its own code ("bounded by", "idempotent", "cannot happen", "measured as") with what enforces each, or write "none -- <reason>"';

function claimsFindings({ lines, headings }) {
  const section = sectionBounds(headings, lines.length, CLAIMS_SECTION);
  if (section === null) {
    return [`no "## Claims to refute" section -- ${CLAIMS_GUIDANCE}`];
  }
  if (isDuplicated(headings, CLAIMS_SECTION)) {
    return [
      'duplicate "## Claims to refute" section -- only the first is read; delete the leftover copy rather than leave its lines unread',
    ];
  }

  const body = lines
    .slice(section.start + 1, section.end)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (body.length === 0) {
    return [`empty "## Claims to refute" section -- ${CLAIMS_GUIDANCE}`];
  }
  if (body.some(isUnearnedNone)) {
    return [
      'bare "none" under "## Claims to refute" -- a none must be "none -- <reason>" tied to this diff',
    ];
  }
  if (
    body.some((line) =>
      CLAIMS_PLACEHOLDERS.some((placeholder) => line.includes(placeholder)),
    )
  ) {
    return [
      `unfilled placeholder under "## Claims to refute" -- ${CLAIMS_GUIDANCE}`,
    ];
  }
  return [];
}

/** Return the list of Claims-to-refute violations in PR body `text`. */
export function claimsViolations(text) {
  return claimsFindings(parseBody(text));
}

// The attested sha, hex and abbreviated or full, read only from the slot the
// template gives it -- `Security review of <sha>` at the head of the label. A
// hex string anywhere else, in a parenthetical or a resolution clause, is prose
// a reader weighs, not the commit this line attests. The suite runs this against
// the shipped template, so a reword of that line fails here rather than quietly
// leaving every attestation unread.
const ATTESTED_SHA = /^Security review of\s+([0-9a-f]{7,40})\b/i;

function attestationFindings({ items }, headSha) {
  const reviews = (items ?? []).filter((item) =>
    opensWith(item.label, REVIEW_PREFIX),
  );
  if (reviews.length === 0) return []; // a deleted line is the checklist's finding
  if (reviews.length > 1) {
    return [
      `line ${reviews[1].line}: more than one Security review line -- keep the template's single line, so the sha the check reads is the sha a reader reads`,
    ];
  }
  const [review] = reviews;
  const attested = ATTESTED_SHA.exec(renderedText(review.label))?.[1];
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
 * PR's head sha (null when it cannot be determined, as in a local run, which
 * checks only that the line names a sha).
 */
export function attestationViolations(text, headSha) {
  return attestationFindings(parseBody(text), headSha);
}

/**
 * A head sha only when it is one. The event payload is JSON this script does not
 * write, so a non-string or blank `head.sha` is a head it could not read -- not
 * a head that happens to match nothing, which would leave the attestation
 * comparison silently skipped and the run green.
 */
function readableSha(value) {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * The PR head sha this run checks against, from the event payload the workflow
 * already receives, or null when there is none (a local run against a file).
 */
export function prHeadSha() {
  if (process.env.PR_HEAD_SHA !== undefined) {
    return readableSha(process.env.PR_HEAD_SHA);
  }
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath === undefined) return null;
  try {
    const event = JSON.parse(readFileSync(eventPath, "utf8"));
    return readableSha(event?.pull_request?.head?.sha);
  } catch {
    return null;
  }
}

/** Every PR-body violation this guard checks for (empty = clean). */
export function bodyViolations(text, headSha) {
  const body = parseBody(text);
  return [
    ...checklistFindings(body),
    ...claimsFindings(body),
    ...attestationFindings(body, headSha),
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
  // On the runner the head must be readable, or the attestation degrades to a
  // presence check and a green result would mean nothing: say so and stop
  // instead of passing quietly.
  const headSha = prHeadSha();
  if (headSha === null && process.env.GITHUB_ACTIONS === "true") {
    console.error(
      "PR description check could not read the head sha from the workflow event payload, so the Security review line's attestation cannot be verified.",
    );
    process.exit(2);
  }
  const violations = bodyViolations(body, headSha);
  if (violations.length > 0) {
    console.error(
      `PR description check failed (${violations.length} issue${violations.length === 1 ? "" : "s"}):\n`,
    );
    for (const v of violations) console.error("  " + source + ": " + v);
    console.error(
      "\nSee .github/PULL_REQUEST_TEMPLATE.md: every Checklist line resolved with an earned reason, the Security review line naming the head it reviewed, and every claim the description makes about its own code listed under Claims to refute.",
    );
    process.exit(1);
  }
  console.log("PR description check passed.");
}
