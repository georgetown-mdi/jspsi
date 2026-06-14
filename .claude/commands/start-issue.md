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

## Step 4 -- Plan, implement, verify

Before editing, read CONTRIBUTING.md and the files the issue's **Affected areas**
and **Implementation notes** point to, then resolve the issue's **Open
questions**. Explore with the Read and Grep tools, not shell `sed`/`cat`/`grep`:
they read and search without a permission prompt and keep large file dumps out of
context. A design-level open question -- one that changes the public surface,
the protocol, or the architecture -- is a stop-and-ask; a purely local one you
settle yourself and note your choice.

Know when to decide and when to ask:

- **Exercise autonomy** on implementation details: naming, file and helper
  layout, which existing pattern to follow, test structure, behavior-preserving
  local refactors, branch name, commit granularity. Make the call, keep moving,
  and record anything non-obvious.
- **STOP and ask** the owner or PM when a decision reaches beyond this change:
  public API / CLI flags / config-schema changes, protocol or wire-format
  changes, security-relevant behavior, adding or dropping a dependency, departing
  from a shared convention, changing the issue's scope, or discovering the task
  as written is wrong, infeasible, or conflicts with the codebase. Ask in your
  reply, in prose: state the decision, list the options with their tradeoffs, and
  recommend one. Do NOT use the question tool.

Implement on the branch, following CONTRIBUTING.md. Verify before you commit:
rebuild core (`npm run build -w packages/core`) if you touched it -- it was built
at issue start, so this only picks up changes you made. Then `npm run typecheck &&
npm run lint`, and run the tests covering what you changed. Report what you ran
and the result; do not commit on red without saying so.

Commit to the new branch following CONTRIBUTING.md's commit conventions (no
markdown, no top-level lists, no self-attribution). Never commit to staging or
main. Each substantial set of changes should receive its own commit; small
patches can be amendments. Stop at the commit -- do not push or open a PR unless
asked.
