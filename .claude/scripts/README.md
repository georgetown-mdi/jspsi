# .claude/scripts/

Executables an agent session or the harness runs, on request rather than on a
push:

- the project-board tooling every board read and write goes through
  (`fetch-issues.mjs`, `edit-issue.mjs`, `list-issues.mjs`, `list-epic.mjs`,
  `lint-issues.mjs`), and `lib/projectItems.mjs` under them
- `worktree-init.sh`, which places a fresh worktree on its branching base and
  provisions its `node_modules`
- `squash-message.mjs`, which drafts the squash message a pull request lands as
- `verify-nonexecutable-delta.mjs`, which decides whether a review attestation
  survives a moved head
- `measure-pr-checks.mjs`, which measures the wall clock a pull request pays for
  its checks and names the critical path that gates the merge. It makes several
  hundred GitHub API calls, so it is asked for explicitly:
  `npm run measure:pr-checks -- [runs]`. With no arguments it prints its usage
  rather than starting a run
- `*-workflow.mjs`, the Workflow script bodies `/light-review` and `/panel`
  invoke by absolute path. Each is a script BODY, not a module: the harness
  injects `args`, `agent`, and `parallel`, and takes the top-level `return` as
  the run's result. No ES module parser accepts that, so eslint ignores them and
  the test beside each one compiles it into a function to drive it.

Tests sit beside their subject, in the vitest project named `scripts` -- the
project covering the repository's own `scripts/` is `repo-scripts`:

```sh
npx vitest run --project scripts
```

## What belongs here, and what belongs next door

The directory is decided by who RUNS the file, not by what the file reads.

- A session or the harness runs it: here.
- CI or a contributor runs it against the repository, including a check whose
  whole subject is `.claude/` or `CLAUDE.md`: [`scripts/`](../../scripts/README.md).
- Claude Code runs it on a tool event, deciding whether the call proceeds:
  [`.claude/hooks/`](../hooks).
