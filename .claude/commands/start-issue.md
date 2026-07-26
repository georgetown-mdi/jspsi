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
that pulls the entire board into context and is the inefficiency this command
exists to avoid. If the item is reported not found, say so and stop.

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
   git reset --hard origin/staging`. You never commit to `staging` -- it is only
   a sync target -- so resetting it onto `origin/staging` is always safe and
   leaves nothing to reconcile.
3. If the sync moved the lockfile, reinstall: `git diff --quiet ORIG_HEAD HEAD --
   package-lock.json || npm ci`. The reset in step 2 points `ORIG_HEAD` at the
   pre-sync commit, so `npm ci` runs only when `package-lock.json` actually
   changed.
4. Rebuild core: `npm run build -w packages/core`. The apps import
   `@psilink/core` from its built `dist/`, and `staging` may have advanced since
   the last issue, so rebuild at every issue start after the sync.
5. Cut the per-issue branch off the synced `staging`: `git checkout -b <branch>`,
   then confirm with `git branch --show-current`.

Pull requests land as squash merges, so `git branch --merged`, `git cherry`, and
subject greps cannot tell whether a prior branch already landed -- decide from
tree content or `git range-diff staging...<branch>`. A stacked branch rebases
onto `origin/staging` as soon as its base PR merges; a byte-identical tree
afterwards means the prior gate runs still stand.

## Step 4 -- Plan, implement, verify

Before editing, read CONTRIBUTING.md and the files the issue's **Affected areas**
and **Implementation notes** point to, then resolve the issue's **Open
questions**. When recent merges touched the issue's surface, reconcile its
premise against the merged code first: an obviated or reduced premise is a scope
finding to raise, not a stale design to build. Explore with the Read and Grep tools, not shell `sed`/`cat`/`grep`:
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
so.

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
  role; the gates suffice.
- Under ~150 changed lines and no security surface -> one /light-review +
  /assess-review round.
- Security surface, protocol or wire format, structural restructure, or a large
  diff -> the full pipeline: /light-review + /assess-review (at most two
  rounds, honoring the step-back triggers), then a role-specialized security
  panel before merge.

An instruction-file diff -- `CLAUDE.md` or anything under `.claude/` -- is not
docs-only for this ladder: those files steer every future session, and an
unreviewed edit can silently drop a working constraint. It draws exactly one
lens round; a role round runs only on the owner's word.

State the bucket, the numbers behind it, and any file that forces the third
bucket. Whether to run the tier is the owner's call in the plain flow (stop at
the commit and recommend); when orchestrating, determining the bucket and
running it are the same act. Either way the bucket binds as a ceiling: rounds
of every kind count against it, and only the owner raises it.

## Orchestrating

"Orchestrate this issue" changes who writes and where the work ends, not the
steps above. When the instruction is to orchestrate:

- **Delegate the writing.** Implementation goes to an `implementer` spawn with a
  self-contained brief; fix rounds are fresh `implementer` spawns. The
  orchestrating session edits nothing on the branch itself.
- **Run the tier yourself.** Size Step 5's bucket from the diff and run exactly
  what it names without pausing for permission -- asking to run a tier you
  already determined is deferral, not caution. The ceiling still binds; only
  the owner raises it.
- **Proceed to an open PR.** The terminal state is a pushed branch, an open PR
  against staging with its checklist resolved, and a final report -- or a
  stated blocker. Raise concerns in prose as you go and keep moving; stop only
  for Step 4's STOP-and-ask cases, batched into one message.
