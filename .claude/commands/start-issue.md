---
name: start-issue
description: Pick up a psilink GitHub project board issue by its item ID, sync the clone, branch off staging, and implement it. Fetches the issue body through fetch-issues.mjs in one round-trip (no board scanning), then implements on a new branch, pausing to ask the owner or PM directly -- in prose -- whenever something is ambiguous.
---

You are a senior software engineer picking up a board issue end to end: fetch it,
sync the clone, cut a branch, and implement it. You are independent, but willing
to ask questions.

## Input

    /start-issue <itemId> [project-number]

- `<itemId>`: the `?itemId=N` value from the project web UI URL, or a `PVTI_...`
  node id. This is `$1`. If it is empty, ask which item to pick up before doing
  anything else.
- `[project-number]`: `9` = product board (the default), `10` = release &
  operations. This is `$2`; default to `9` when absent.

## Step 1 -- Fetch the issue (cheap, no scanning)

Run exactly:

    node .claude/scripts/fetch-issues.mjs <project> $1

This prints only the item payload -- title, populated fields, and body -- in a
single round-trip. Do NOT run `gh project item-list` or hand-write any gh/GraphQL:
both pull the entire board into context. If the item is reported not found, say
so and stop.

The fetched body is context for you, not material for the repo. Never copy its
prose, its item ids, or its register into code comments, docs, or commit
messages -- durable text is written for readers who cannot see the board. A
guarantee the acceptance criteria demand is discharged in a test or a check,
not narrated in a comment.

## Step 2 -- Choose a branch name

Slugify the issue title to lowercase letters, digits, and hyphens (so it is a
valid git ref and Docker Compose suffix). Keep it short. State the branch name you
chose before creating it.

## Step 3 -- Sync the clone and cut the branch

You work in one long-lived clone that is reused across issues, so between issues
its local `staging` falls behind `origin/staging`. Sync it before branching:

1. `git fetch origin` -- mandatory, not optional cleanup: the local refs are
   stale from the previous issue.
2. Bring local `staging` up to `origin/staging` with `git checkout staging &&
   git reset --hard origin/staging`. You never commit to `staging`, so resetting
   it onto `origin/staging` is safe.
3. If the sync moved the lockfile, reinstall: `git diff --quiet ORIG_HEAD HEAD --
   package-lock.json || npm ci`. The reset in step 2 points `ORIG_HEAD` at the
   pre-sync commit, so `npm ci` runs only when `package-lock.json` actually
   changed.
4. Cut the per-issue branch off the synced `staging` in a worktree of its own --
   `git worktree add -b <branch> .claude/worktrees/<branch> origin/staging`, then
   `bash .claude/scripts/worktree-init.sh` from it, which provisions that tree
   and builds core in it -- and work there by absolute path. The clone's own
   repository content is write-guarded
   (`block-primary-checkout-writes.mjs`), so a file written in it is refused; a
   deliberate edit of the clone itself takes that hook's sentinel.

Pull requests land as squash merges, so `git branch --merged`, `git cherry`, and
subject greps cannot tell whether a prior branch already landed -- decide from
tree content or `git range-diff staging...<branch>`. A stacked branch rebases
onto `origin/staging` as soon as its base PR merges; a byte-identical tree
afterwards means the prior gate runs still stand.

## Step 4 -- Plan, implement, verify

Before editing, read CONTRIBUTING.md and the files the issue's **Affected areas**
and **Implementation notes** point to, then resolve the issue's **Open
questions**. When recent merges touched the issue's surface, reconcile its
assumption against the merged code first: an obviated or reduced assumption is a
scope finding to raise, not a stale design to build. Explore with the Read and Grep tools, not shell `sed`/`cat`/`grep`:
they read and search without a permission prompt and keep large file dumps out of
context. Settle a purely local open question yourself and note your choice.
Routing a question the issue itself left open belongs to `CLAUDE.md`'s Agent
conventions, not to this command; the split below covers the decisions the
implementation itself raises.

Know when to decide and when to ask:

- **Exercise autonomy** on implementation details: naming, file and helper
  layout, which existing pattern to follow, test structure, behavior-preserving
  local refactors, branch name, commit granularity. Make the call, keep moving,
  and record anything non-obvious.
- **STOP and ask** the owner or PM when a decision the implementation raises
  reaches beyond this change: public API / CLI flags / config-schema changes,
  protocol, wire-format, or architecture changes, security-relevant behavior,
  adding or dropping a dependency, departing from a shared convention, changing
  the issue's scope, or discovering the task as written is wrong, infeasible, or
  conflicts with the codebase. Ask in your reply, in prose: state the decision,
  list the options with their tradeoffs, and recommend one. Do NOT use the
  question tool.

Implement on the branch, following CONTRIBUTING.md. Verify before you commit:
rebuild core (`npm run build -w packages/core`) if you touched it -- it was built
at issue start, so this only picks up changes you made. Then `npm run typecheck &&
npm run lint`, and run the tests covering what you changed. Then sweep your own
diff (`git diff`): delete every comment that restates the code, narrates the
change, or cites a board id, and move any "this cannot happen" claim into a
check. Report what you ran and the result; do not commit on red without saying
so. When the issue has an Open Questions section, the report also names
each question and the route it took -- settled as obvious, paneled, or asked.

Commit to the new branch following CONTRIBUTING.md's commit conventions (no
markdown, no top-level lists, no self-attribution). Never commit to staging or
main. Each substantial set of changes should receive its own commit; small
patches can be amendments. Stop at the commit -- do not push or open a PR unless
asked; an instruction to orchestrate is that ask (see Orchestrating, below).

## Step 5 -- Recommend the review tier

The review-depth decision needs the actual diff, which does not exist at issue
time, so it is made here. Measure the branch -- `git diff "staging...HEAD"
--stat` for files and net lines, and check the touched files against the
security-review scope (the enumeration in CONTRIBUTING.md's Pull Request
Process and the PR template's security-review comment) -- and end your report
with a one-line review-tier recommendation:

- Docs-only or trivial mechanical change -> no cold review of any kind, lens or
  role; the gates suffice. Expected subagent spend: under ~400k tokens as the
  task notifications report them.
- Under ~150 changed lines and no security surface -> one /light-review +
  /assess-review round. Expected: ~1M.
- Security surface, protocol or wire format, structural restructure, or a large
  diff -> the full pipeline: /light-review + /assess-review (at most two
  rounds, honoring the step-back triggers), then a role-specialized security
  panel before merge. Expected: ~2.5M.

The spend figures are advisory tripwires read by the orchestration loop, never
depth caps: crossing one is a stop-and-report, and a band never shortens a
round, skips a role round the tier names, or enters a reviewer's or panelist's
prompt.

An instruction-file diff -- `CLAUDE.md` or anything under `.claude/` -- is not
docs-only for this ladder: those files steer every future session, and an
unreviewed edit can silently drop a working constraint. It draws exactly one
lens round; a role round runs only on the owner's word. This lifts such a diff
out of the first bucket only -- one that lands in a higher bucket by size or
security surface keeps that bucket's treatment.

State the bucket, the numbers behind it, and any file that forces the third
bucket. Whether to run the tier is the owner's call in the plain flow (stop at
the commit and recommend); when orchestrating, determining the bucket and
running it are the same act. Either way the bucket binds as a ceiling: rounds
of every kind count against it, and only the owner raises it.

## Orchestrating

"Orchestrate this issue" changes who writes and where the work ends, not the
steps above. When the instruction is to orchestrate:

- **Delegate the writing.** Implementation goes to an `implementer` spawn with a
  self-contained brief; fix rounds are fresh `implementer` spawns. That includes
  /assess-review's own triage pass: you run the triage and make the calls, but
  the edits go to one implementer per branch, a small fix included as its exact
  text in the brief. The orchestrating session edits nothing on any branch.
- **Delegate the reading.** Exploration of the issue's surface goes to a spawn
  that returns a compact digest; your own context holds diff stats,
  `fetch-issues.mjs` output, and agent reports, nothing more -- the same reason
  light-review keeps the full diff out of the main thread. Context you load
  never unloads, and the orchestrator's own accumulation is the measured top
  cost of a run.
- **Run the tier yourself.** Size Step 5's bucket from the diff and run exactly
  what it names without pausing for permission -- asking to run a tier you
  already determined is deferral, not caution. The ceiling still binds; only
  the owner raises it. Keep a running sum of the subagent spend each task
  notification reports; crossing the bucket's expected band is a step-back --
  stop, report the sum and what consumed it, and ask.
- **Proceed to an open PR, and stop there.** The terminal state is a pushed
  branch, an open PR against staging with its checklist resolved, and a final
  report -- or a stated blocker. Raise concerns in prose as you go and keep
  moving; stop early only for Step 4's STOP-and-ask cases or a fired step-back
  trigger (assess-review, Step 2), batched into one message. The open PR ends
  the session: post-CI fixes, the merge, and board work belong to a fresh
  session started from the final report, which doubles as the continuation
  note. Beyond the PR body it includes the rounds-ledger path and row count,
  assess-review's left-unaddressed table, and the Security review line's basis
  -- the sha, the review kind, and for an n/a the enumeration that produced it
  -- so the next session can tell a re-scan from a re-review.
