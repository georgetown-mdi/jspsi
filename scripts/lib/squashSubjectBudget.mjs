// CONTRIBUTING.md's commit-subject limit, and the budget a pull-request title
// has under it once GitHub's squash-merge suffix is counted.
//
// Three readers measure that one rule: check-pr-checklist.mjs beside this file,
// which fails an open pull request whose title is over budget; the
// .claude/hooks guard that refuses an over-budget `gh pr create --title` before
// the call reaches GitHub; and the .claude/scripts normalizer that refuses a
// draft subject over the same budget. Two computations of one budget can
// disagree, and a title one reader accepts then fails another.
//
// The module sits in scripts/lib because who RUNS a file decides its directory
// (scripts/README.md): CI runs the checklist check from a plain checkout, so
// that check imports nothing from the agent harness, while a harness file
// reading a check's helper module is the direction .claude/scripts already
// takes with lib/markdownFences.mjs.

/** CONTRIBUTING.md's subject limit, counting the suffix GitHub appends. */
export const SUBJECT_LIMIT = 50;

/** The pull-request number argument for a draft written before one exists. */
export const UNASSIGNED_PR = "unassigned";

/** Digits assumed for the suffix when the pull-request number is unknown. */
export const ASSUMED_PR_DIGITS = 4;

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
