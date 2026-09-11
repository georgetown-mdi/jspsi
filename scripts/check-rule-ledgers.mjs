#!/usr/bin/env node
// Rule-ledger split check, run by static_checks.yaml on every PR.
//
// The agent rules live in two ledgers with different readers. CLAUDE.md is
// injected into every spawn, so a rule there is billed to every agent whether or
// not it binds one; .claude/orchestration/ruleset.md is read by the orchestrating
// session and by the five front doors that open one, so a rule there costs a
// single Read. The split only holds while each rule sits in exactly one of them:
// a rule copied back into CLAUDE.md is paid for by every spawn again, and a rule
// stated in both drifts until the two statements disagree and an agent follows
// the wrong one.
//
// Three properties encode that. A hook is claimed by one ledger, so "Enforced by
// `<hook>.mjs`" locates the rule it enforces. A `##`/`###` heading text appears
// in one ledger, so a subsection re-created wholesale is caught by name. And the
// load mechanism stays wired: CLAUDE.md names the ledger exactly once, in the
// pointer bullet, and each front door names it at least once.
//
// What this cannot see: a rule that returns under new words, with no enforcement
// claim and no heading of its own -- CLAUDE.md's byte budget
// (scripts/check-claudemd-budget.mjs) is the guard that covers bulk regrowth,
// and review covers the rest.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { enforcementClaims } from "./check-enforcement-claims.mjs";

/** The every-spawn ledger. */
export const CLAUDE_MD = "CLAUDE.md";

/** The session-only ledger CLAUDE.md points at. */
export const LEDGER = ".claude/orchestration/ruleset.md";

/** The commands and skills that load the session ledger as their first step. */
export const FRONT_DOORS = [
  ".claude/commands/start-issue.md",
  ".claude/commands/light-review.md",
  ".claude/commands/assess-review.md",
  ".claude/commands/panel.md",
  ".claude/skills/shortlist-backlog/SKILL.md",
];

/**
 * The hook file names a ledger claims enforcement by, read through the
 * enforcement-claim check's own extraction so the two agree on what a claim is.
 */
export function claimedHooks(source) {
  return new Set(enforcementClaims(source).map((claim) => claim.hook));
}

/** The `##` and `###` heading texts of a Markdown source, in order. */
export function headings(source) {
  const found = [];
  for (const line of source.split("\n")) {
    const match = /^#{2,3} +(.+?) *$/.exec(line);
    if (match) found.push(match[1]);
  }
  return found;
}

/** How many times `path` is named in `source`. */
export function mentions(source, path) {
  return source.split(path).length - 1;
}

/**
 * Every way the split between the two ledgers can be out of step, as problem
 * strings. Empty means each rule sits in one ledger and the load mechanism that
 * delivers the second one is wired.
 */
export function ledgerViolations({ claudeMd, ledger, frontDoors }) {
  const problems = [];

  const ledgerHooks = claimedHooks(ledger);
  for (const hook of claimedHooks(claudeMd)) {
    if (ledgerHooks.has(hook)) {
      problems.push(
        `${CLAUDE_MD} and ${LEDGER} both claim enforcement by \`${hook}\`. A rule and the hook that enforces it belong to one ledger: keep it whole in the file whose readers it binds, and delete it from the other. Do not state it in both.`,
      );
    }
  }

  const ledgerHeadings = new Set(headings(ledger));
  for (const heading of headings(claudeMd)) {
    if (ledgerHeadings.has(heading)) {
      problems.push(
        `"${heading}" is a heading in both ${CLAUDE_MD} and ${LEDGER}. A subsection lives in one ledger: move its bullets into the file whose readers they bind, and drop the emptied heading from the other.`,
      );
    }
  }

  const pointers = mentions(claudeMd, LEDGER);
  if (pointers === 0) {
    problems.push(
      `${CLAUDE_MD} does not name ${LEDGER}, so nothing sends a session to it. Restore the pointer bullet under "Orchestrating a session".`,
    );
  } else if (pointers > 1) {
    problems.push(
      `${CLAUDE_MD} names ${LEDGER} ${pointers} times. One pointer bullet is the whole load mechanism, and every extra mention is billed to every spawn: fold them into that bullet.`,
    );
  }

  for (const { file, source } of frontDoors) {
    if (mentions(source, LEDGER) === 0) {
      problems.push(
        `${file} does not name ${LEDGER}, so it runs without the session rules its steps assume. Add the "First" line that reads the ledger, in the shape the other front doors use.`,
      );
    }
  }

  return problems;
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions without the process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const read = (file) => readFileSync(resolve(root, file), "utf8");
  const problems = ledgerViolations({
    claudeMd: read(CLAUDE_MD),
    ledger: read(LEDGER),
    frontDoors: FRONT_DOORS.map((file) => ({ file, source: read(file) })),
  });
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }
  console.log(
    `Rule ledger check passed: ${CLAUDE_MD} and ${LEDGER} share no enforcement claim and no heading, and ${FRONT_DOORS.length} front doors load the ledger.`,
  );
}
