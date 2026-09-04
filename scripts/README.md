# scripts/

Executables CI and contributors run against this repository. Most are the
`check:*` guards `npm run check:all` drives from the one list in
[`run-checks.mjs`](run-checks.mjs), which also states what keeps each excluded
check off it. Beside them: the doc-link checker, the `npm run dev` launcher, the
mutation run, the release and provenance verifiers, the dependency-drift check
`.github/actions/setup` runs after a cache restore, and the modules more than one
of them shares, in [`lib/`](lib).

A check's test sits beside it; a guard that asserts a workflow, Dockerfile or
config directly is the test alone. Both run in the vitest project
`repo-scripts`:

```sh
npx vitest run --project repo-scripts
```

## What belongs here, and what belongs next door

Who RUNS the file decides the directory, not what the file reads: a check whose
whole subject is `.claude/` or `CLAUDE.md` belongs here, because CI runs it.

- CI or a contributor runs it from a plain checkout: here.
- An agent session or the harness runs it -- board tooling, worktree
  provisioning, the Workflow bodies the slash commands invoke by path:
  [`.claude/scripts/`](../.claude/scripts/README.md).
- Claude Code runs it on a tool event, deciding whether the call proceeds:
  [`.claude/hooks/`](../.claude/hooks).

A new check is also a new line in `run-checks.mjs`, in `CHECKS` or in
`OUT_OF_CHECK_ALL` with what keeps it off the merge path; the test beside that
file fails while a `check:*` script is in neither.
