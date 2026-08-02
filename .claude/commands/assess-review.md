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
- **Trajectory.** Read the `## Trajectory` section light-review wrote into
  `review_findings.md`, and the rounds ledger at
  `scratch/review-rounds/<branch>.jsonl` for the rounds before it (fall back to
  reconstructing rounds from `git log staging..HEAD` review-fix commits if
  either is missing; a review lens carried by a `general-purpose` spawn is
  invisible to accounting keyed on `subagent_type`, which undercounts the
  rounds a branch ran). Converging is confirmed-new falling with repeats near
  zero; churn is fixes spawning findings.
- **Kind.** Each ledger row carries a `kind`: `light` for a lens round, or the
  name of the role that ran it (`security-reviewer`, `adversarial-verifier`).
  A row with no `kind` predates the field and is a `light` round. Compare a
  round only against prior rounds of the same kind -- a role round's claims and
  a lens round's clusters count different things. Same-kind scoping governs
  trajectory only: the branch's round budget is the ledger's full line count,
  every kind included, capped by the review-tier bucket (start-issue.md, Step
  5) -- a round of a new kind is not a fresh budget. In a role row, a claim whose
  verdict is `REFUTED` or `COULD-NOT-VERIFY` is a confirmed finding on its file,
  and so is an out-of-claim `finding` of severity critical or major -- the role
  round's gate ignores those by design, the trajectory does not.

On a branch whose ledger holds no prior row, skip the trajectory read:
triggers 1-3 and 7 each compare against a previous round, so with nothing
before this round check only triggers 4-6.

Then check the **step-back triggers**. If ANY fires, do NOT proceed to
fix-and-rerun: stop, and recommend a structural pivot instead -- a focused
independent assessment of the churning area (fresh agents, cold), a judge
panel of alternative shapes, or a narrowing (delete or defer the churning
surface, its limit stated in the spec) -- presented to the owner in prose with
options and a recommendation. Churn escalates to a different activity, never to
another blind whole-branch round.

1. The same file or area carries confirmed findings in three consecutive rounds
   (two, for a diff under ~150 lines).
2. This round confirmed as many findings as the previous round's fixes closed,
   or more.
3. Reviewers propose contradictory remedies for the same hunk, or the contested
   list (high-severity, single-reviewer findings) grew from the previous round.
   A role round has one reviewer, so this trigger reads light rounds only.
4. Two or more reviewers voted that a materially simpler shape exists. Only a
   light round carries that vote.
5. A fix you are about to make would grow the branch's diff by roughly a third
   or more.
6. The driving board issue's **Affected areas** is in context and the diff has
   spread well beyond it.
7. A confirmed finding or gating claim lands on code a previous fix round added,
   rather than on the branch's original change, in two consecutive rounds -- the
   guard is churning, not the change, and the pivot to weigh first is narrowing.

## Step 3 -- Triage and fix

For each finding: verify it if it merits verification (read the specific
hunks/files it names, not the whole diff), then decide.

- **Default to fixing.** Drive-by corrections are welcome -- you do not need
  permission to fix something small and clearly right. A fix under roughly 20
  lines is made HERE, by you, in this pass: a fresh implementer spawn to carry
  twenty lines costs more than the whole finding, and it re-reads the branch
  you already have in context.
- **Contest by measurement before fixing for it.** A finding or refuted claim
  about an external tool's behavior that rests on reading rather than running
  is still open: reproduce the claimed behavior against the real tool first.
  A first-hand run that contradicts the finding closes it -- record the command
  and outcome in Step 4 -- and one that confirms it makes the fix a measured
  one.
- **A gated role round's disposition can take a consult.** Choosing among fix,
  contest, and documented limit on a gated `security-reviewer` or
  `adversarial-verifier` round is the adjudication CLAUDE.md's model-tier rule
  reserves Fable for -- a one-shot, owner-approved consult on the choice, never
  a Fable fix round.
- **A fix that adds behavior gets a test.** When a fix introduces new branching
  or a new code path (error handling, a guard, a fallback), pin its guarantees
  with a test in the same pass. No later round re-reviews a fix: another round
  exists only for the step-back triggers.
- **A pattern in the findings gets a class sweep.** When several findings share
  one mechanism (a port dropping behavior its original carried, a rename
  missing sites, a repeated idiom misused), run one focused pass over that
  class across the whole branch in the same triage -- a review round samples;
  the sweep completes.
- **Prose findings get a high bar.** Fix a finding that asks for a comment,
  JSDoc, or doc paragraph only when the missing constraint is unrecoverable
  from the code, names, types, and tests AND its absence enables a concrete
  wrong edit you can name -- and prefer carrying it as a check, a test, or a
  more explicit name over prose. Reviews here have a measured many-to-one bias
  toward adding prose; do not ratchet. The same bar applies to prose you are
  tempted to add defensively while triaging: pre-empting a re-raise is not a
  reason.
- **Autonomy boundary.** Settle implementation details yourself. STOP and ask the
  owner or PM before a fix that reaches beyond this change: public API / CLI /
  config-schema, protocol or wire format, security-relevant behavior, a
  dependency, a shared convention, or the branch's scope. Ask in prose with the
  options and a recommendation; do NOT use the question tool.
- **Leave it** only when it is truly out of scope for this branch, genuinely
  not worth the change, or best taken as a documented limit per CLAUDE.md's
  three-disposition rule -- for that last, write the limits line into the
  governing `docs/spec/` file in the same pass and propose the remedy as a
  follow-on in Step 4's table. Do NOT file a board issue for anything -- no
  automated filings; an unaddressed finding is recorded in Step 4, not on the
  board, and a follow-on is filed only on the owner's word.

Apply the fixes. If you changed anything, verify before committing: build core
if you touched it (`npm run build -w packages/core`), then `npm run typecheck &&
npm run lint`, and run the tests covering what you changed. Commit to the branch
-- never staging or main -- following CONTRIBUTING.md's commit conventions (no
markdown, no top-level lists, no self-attribution). Report what you ran.

Then record what you decided. The round's row in
`scratch/review-rounds/<branch>.jsonl` carries a `dispositions` entry per
confirmed cluster, gating claim, and out-of-claim finding, each written `open`
by the round that raised it. Rewrite each in place to the disposition you took:
`fixed`, `contested` (you measured the disputed behavior first-hand and it did
not hold), `narrowed` (the limits line is on the branch), or `deferred` (it has
a row in Step 4's table). An entry left `open` says nobody decided that finding,
so leave none behind -- and a round whose entries are all still `open` is a
round that was read and not triaged.

## Step 4 -- Report what you left, and readiness

**Left unaddressed.** A compact table, one row per actionable finding you did not
fix (omit the table entirely if there are none). One phrase per cell -- this is
the part you will re-read later, so keep it scannable:

| Finding | Why not fixed | Severity | Will it resurface? |

-- what the finding is, why you left it, how big it actually is, and whether it
is latent and likely to come back to bite.

**Security-review readiness.** One line: ready, or not yet and what is gating it.
The branch is ready when the diff has stabilized (trajectory converging, not
churning), no unaddressed finding touches a security-relevant surface (one taken
as a documented limit stops gating readiness once the owner ratifies that
disposition), brittle areas are shored up or independently assessed, and
typecheck/lint/tests are green. When it is ready, say so.

## Step 5 -- Clean up

Delete `review_findings.md` from your working directory. Leave
`scratch/review-rounds/` in place -- it is the cross-round trajectory ledger.
