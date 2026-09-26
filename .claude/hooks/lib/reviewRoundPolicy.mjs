// Which review rounds a branch's rounds ledger still admits, for the
// light-review gate in require-clean-tree-for-review.mjs.
//
// The rule enforced: round 3 or later does not start after a round that fixed
// nothing -- every entry in its `dispositions` is `limit`, `deferred`, or
// `narrowed`, or it raised none. Two things still start a round past that
// point: the owner's cap raise, passed as `ownerCapRaise: true` in the
// Workflow args, and a branch's first role round, which a diff with
// adversary-reachable surface keeps whatever its size or round index.
//
// The two size thresholds are advisory only: the refusal states them as the
// session's default recommendation when it asks the owner for a raise, and
// nothing here refuses on them. They are measured quartiles of branch diff
// size, re-fit at each retro, not fixed constants.

/** Changed lines (insertions plus deletions) at or under which a diff is small. */
export const SMALL_DIFF_LINES = 482;

/** Changed lines over which a diff is large. */
export const LARGE_DIFF_LINES = 1089;

/** The rounds the two thresholds were measured on. */
export const THRESHOLD_WINDOW = "2026-08-31 to 2026-09-25";

/** The first round a round that fixed nothing keeps from starting. */
export const FIRST_YIELD_LIMITED_ROUND = 3;

const NO_FIX_DISPOSITIONS = new Set(["limit", "deferred", "narrowed"]);
const ROLE_KINDS = new Set(["security-reviewer", "adversarial-verifier"]);

/**
 * The rows of a rounds ledger's text, one JSON object per non-blank line.
 * Throws on a line that is not a JSON object, naming its position.
 */
export function parseLedger(text) {
  const rows = [];
  text.split("\n").forEach((line, index) => {
    if (line.trim().length === 0) return;
    let row;
    try {
      row = JSON.parse(line);
    } catch (cause) {
      throw new Error(`ledger line ${index + 1} is not JSON`, { cause });
    }
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`ledger line ${index + 1} is not a JSON object`);
    }
    rows.push(row);
  });
  return rows;
}

/**
 * Whether a ledger row records a round that fixed nothing. A row without a
 * `dispositions` array predates the field and is not counted as one.
 */
export function fixedNothing(row) {
  if (!Array.isArray(row?.dispositions)) return false;
  return row.dispositions.every((entry) =>
    NO_FIX_DISPOSITIONS.has(entry?.disposition),
  );
}

/**
 * The size-keyed recommendation the session states to the owner when asking
 * for a cap raise, for a diff of `changedLines` (null when unmeasured).
 */
export function sizeAdvice(changedLines) {
  const measured = `thresholds measured on the rounds of ${THRESHOLD_WINDOW} and re-fit at each retro`;
  if (!Number.isInteger(changedLines) || changedLines < 0) {
    return "The branch's changed-line count could not be measured, so no size-keyed recommendation applies.";
  }
  if (changedLines <= SMALL_DIFF_LINES) {
    return (
      `Default recommendation to the owner at ${changedLines} changed lines (at or under ${SMALL_DIFF_LINES}, ${measured}): ` +
      "run a role round only when the lens round fixed a major or the owner names the surface; " +
      "a diff with adversary-reachable surface keeps its role round whatever its size."
    );
  }
  if (changedLines > LARGE_DIFF_LINES) {
    return (
      `Default recommendation to the owner at ${changedLines} changed lines (over ${LARGE_DIFF_LINES}, ${measured}): ` +
      "run round 4 or later only after a round that fixed a runtime major."
    );
  }
  return `At ${changedLines} changed lines (between ${SMALL_DIFF_LINES} and ${LARGE_DIFF_LINES}, ${measured}), no size-keyed recommendation applies.`;
}

/**
 * Why the ledger refuses the next round, or null when it admits it. `rows` is
 * the branch's ledger, `role` the requested role or null for a lens round,
 * `ownerCapRaise` the owner's override, and `changedLines` the branch's diff
 * size for the advisory, null when unmeasured.
 */
export function roundRefusal({ ref, rows, role, ownerCapRaise, changedLines }) {
  if (ownerCapRaise === true) return null;
  const round = rows.length + 1;
  if (round < FIRST_YIELD_LIMITED_ROUND) return null;
  if (!fixedNothing(rows[rows.length - 1])) return null;
  const firstRoleRound =
    typeof role === "string" && !rows.some((row) => ROLE_KINDS.has(row.kind));
  if (firstRoleRound) return null;
  return (
    `round ${round} of '${ref}' would follow round ${rows.length}, which fixed nothing ` +
    "(every entry in its dispositions is limit, deferred, or narrowed, or it raised none), " +
    `and round ${FIRST_YIELD_LIMITED_ROUND} or later does not start after a round that fixed nothing. ` +
    "Only the owner restarts it: with the owner's word, re-run with ownerCapRaise: true in the " +
    "Workflow args (/light-review --owner-cap-raise) and note the raise in the ledger. " +
    sizeAdvice(changedLines)
  );
}
