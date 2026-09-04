---
name: panel
description: Convene a bounded expert panel on one settle-able design question -- three independent schema-forced panelists reading a clean staging checkout, one Workflow, no consolidator. Whether to convene at all is CLAUDE.md's deferred-question rule (measure first; stakes gate); this command only runs a convened panel correctly.
---

You are CONVENING a panel, not sitting on it. You do not answer the question
yourself, and you do not tell the panelists anything you already believe about
it -- the round's value is three answers formed without you.

## Input

    /panel "<question>" [context-file ...]

- `<question>`: one settle-able question of technical judgment, phrased
  neutrally -- no candidate answer, no hint of which way you or the issue lean.
  If you cannot phrase it without a candidate, it is not ready for a panel.
- `[context-file ...]`: optional repo-relative paths (docs, specs) every
  panelist should read for context. Call this list DOCS; there may be none.

Whether a panel should run at all is not this command's call: CLAUDE.md's
deferred-question rule holds the stakes gate and the measure-first rule. A
panel's conclusion answers a design question; it is never a review round -- it
does not enter `scratch/review-rounds/` and does not satisfy the PR checklist's
Security review line.

## Step 1 -- Clean base

Panelists read a clean mainline checkout, never your working tree: a candidate
edit sitting in the tree is a leading answer. Commit any work in progress (the
clean-tree hook blocks every Workflow call from a dirty tree), then run:

    git worktree remove --force /tmp/panel-base 2>/dev/null; rm -rf /tmp/panel-base
    git worktree add --detach /tmp/panel-base origin/staging

The first line clears a stale base left by an interrupted run.

`/tmp/panel-base` has no `node_modules`: a question that needs code RUN rather
than read is out of this command's scope -- measure it yourself first instead.

## Step 2 -- Run the panel Workflow

Invoke the Workflow tool with `scriptPath` set to the ABSOLUTE path of
`.claude/scripts/panel-workflow.mjs` in this repository (`git rev-parse --show-toplevel`
gives the root) -- the bare relative spelling fails the call with "script file
not found" -- and `args` set to
`{"question": "<the question>", "docs": [<DOCS, possibly empty>]}`.

The script is checked in and passed by path: do not paste its text into the call
and do not copy it out to edit it -- it spawns the three panelists on the tiers
`.claude/scripts/panel-script.test.mjs` pins. It returns the panelists that answered,
each `{position, rationale, keyRisk}`.

## Step 3 -- Read the verdicts and close

1. Remove the worktree: `git worktree remove /tmp/panel-base --force`.
2. Three aligned positions: converged -- the question is settled. Proceed on
   the conclusion and record it in your report: the question, the conclusion,
   and one line of rationale per panelist.
3. A 2-1 split where the majority's rationale answers the dissent's keyRisk:
   proceed on the majority, record the dissent.
4. No convergence, or a dissent the majority does not answer: take the
   question to the owner in prose with each returned position. Do NOT re-run the
   panel -- a re-run is for contamination evidence only (a panelist read a
   candidate edit or was told a preferred answer), never for disagreement, and
   never because agreement came quickly.
5. A panelist that returned null exhausted its schema retries; its analysis is
   usually intact in the rejected attempts in its transcript -- salvage it.
   Two surviving panelists that agree still converge; otherwise treat the
   round as no convergence.

## What you do NOT do

- Do not vote yourself, and do not weight verdicts by which you prefer.
- Do not tell panelists your view, the issue's lean, or each other's answers.
- Do not use a panel's output to satisfy any review obligation.
