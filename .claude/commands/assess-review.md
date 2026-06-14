---
name: assess-review
description: Triage a cold code review's findings in the working directory where you implemented -- read the local review_findings.md, fix what is worth fixing in the same pass, read the trend across rounds, and report what was left plus a security-review readiness call. Run by the implementing agent in that same working directory (no branch argument); pairs with light-review, which deposits the findings file there.
---

You are the engineer who wrote the changes, now triaging a cold code review of
them -- and fixing what is worth fixing in the same pass.

## Step 1 -- Read the findings

The review file is in your working directory -- the same session that
implemented the changes is still running here, so there is nothing to locate or
pass as an argument (the branch is just your current `HEAD`). light-review has
already deposited its consolidated findings as `review_findings.md` there. Read
it.

If `review_findings.md` is not in your working directory, stop and say so:
light-review has not run for this branch yet. Do not go hunting for it elsewhere.

## Step 2 -- Assess: trajectory and brittle areas

Start with the whole, not the parts:

- **Soundness.** Comment on the overall approach and any patterns across the
  findings.
- **Trajectory.** Reconstruct earlier rounds from the branch's commit history
  (`git log staging..HEAD` -- prior review-fix commits show what past rounds
  already addressed) and compare against the current findings. Is the
  count net-decreasing (converging) or are fixes spawning fresh findings (churn)?
- **Brittle areas.** When the same file or module keeps surfacing across rounds,
  name it. A blind full-diff pass has diminishing returns there -- recommend
  pivoting to a focused, independent assessment of just that area (point fresh
  agents at it cold) rather than another whole-branch cold round. Say which areas,
  and why they look brittle.

## Step 3 -- Triage and fix

For each finding: verify it if it merits verification (read the specific
hunks/files it names, not the whole diff), then decide.

- **Default to fixing.** Drive-by corrections are welcome -- you do not need
  permission to fix something small and clearly right.
- **Autonomy boundary.** Settle implementation details yourself. STOP and ask the
  owner or PM before a fix that reaches beyond this change: public API / CLI /
  config-schema, protocol or wire format, security-relevant behavior, a
  dependency, a shared convention, or the branch's scope. Ask in prose with the
  options and a recommendation; do NOT use the question tool.
- **Leave it** only when it is truly out of scope for this branch, or genuinely
  not worth the change. Do NOT file a board issue for anything -- no automated
  filings; an unaddressed finding is recorded in Step 4, not on the board.

Apply the fixes. If you changed anything, verify before committing: build core
if you touched it (`npm run build -w packages/core`), then `npm run typecheck &&
npm run lint`, and run the tests covering what you changed. Commit to the branch
-- never staging or main -- following CONTRIBUTING.md's commit conventions (no
markdown, no top-level lists, no self-attribution). Report what you ran.

## Step 4 -- Report what you left, and readiness

**Left unaddressed.** A compact table, one row per actionable finding you did not
fix (omit the table entirely if there are none). One phrase per cell -- this is
the part you will re-read later, so keep it scannable:

| Finding | Why not fixed | Severity | Will it resurface? |

-- what the finding is, why you left it, how big it actually is, and whether it
is latent and likely to come back to bite.

**Security-review readiness.** One line: ready, or not yet and what is gating it.
The branch is ready when the diff has stabilized (trajectory converging, not
churning), no unaddressed finding touches a security-relevant surface, brittle
areas are shored up or independently assessed, and typecheck/lint/tests are
green. When it is ready, say so.

## Step 5 -- Clean up

Delete `review_findings.md` from your working directory.
