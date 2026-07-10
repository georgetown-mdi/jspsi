# CLAUDE.md

psilink does Privacy Preserving Record Linkage (PPRL) via Private Set Intersection (PSI) between two parties over SFTP, file-drop, or WebRTC.

It is a npm workspaces monorepo (`packages/core`, `apps/cli`, `apps/web`); apps consume packages, not the reverse.

**Read `CONTRIBUTING.md` before your first edit or commit.** It holds the build/test/dev reference and every coding and commit convention (enforced by CI and review), none of it repeated here. This file is only the complement: project operations and agent-specific rules.

## Commands

Non-obvious ones (full reference in `CONTRIBUTING.md`):

```sh
npm run build -w packages/core # required after any core change
npm run test # unit tests only (root fans out to each workspace; cli/web run their unit project)
npx vitest run path/to/file.test.ts # single test file, from workspace root
```

## GitHub project items

Read and edit drafts by numeric ID (the `?itemId=N` URL value) or a `PVTI_` node id (the `id` from list-issues) via the scripts -- never hand-write the gh/GraphQL. Run any with no args for usage.

- `node .claude/scripts/fetch-issues.mjs <project> <itemId> ...` -- read; shows custom fields
- `node .claude/scripts/edit-issue.mjs <project> <itemId> ...` -- edit status/title/body/fields
- `node .claude/scripts/list-epic.mjs <project> "<Epic>"` -- list an epic's items by Order
- `node .claude/scripts/list-issues.mjs <project>` -- list every item on a board, fully paginated; `--status NAME` filters, `--json` for a machine array

Create a draft (the one board op still on `gh`): `gh project item-create <project> --owner georgetown-mdi --title "..." --body "..."`.

## Project manager

The PM ruleset lives once at `.claude/pm/ruleset.md`; two front doors load it:

- **`/pm` skill** -- interactive persona for board hygiene, epic scoping, and drafting/revising tasks in conversation. Confirms before board writes.
- **`project-manager` consult agent** -- one-shot, spawned from a working session to advise on a finding or capture a deferred task. Returns one terminal result (FEEDBACK / FILED / NEEDS INPUT) and **cannot be continued** (no `SendMessage`).

Driving the consult: the main thread owns the loop. Spawn it with a self-contained prompt; on a NEEDS INPUT result, relay its questions via AskUserQuestion and re-spawn with the answers folded in (the only form of "continuation"). Coding subagents bubble PM requests up rather than spawning the consult themselves -- AskUserQuestion and the human live only at the top level.

## Agent conventions

Beyond the conventions in `CONTRIBUTING.md`:

- Prefer ASCII: `-` not an en-dash or em-dash, `->` not an arrow character.
- Never commit to staging or main by yourself; don't attribute yourself on commits or pull requests.
- Commit messages use no markdown and no top-level lists (other format rules in `CONTRIBUTING.md`, Commit Messages).
- After a chain of edits, run `npm run typecheck && npm run lint && npm run format`; the LSP server often has a stale cache.
- Typecheck, lint, and format are CI checks.
- Project state belongs in the GitHub project and docs/, not agent memory.
- Encode a "does not happen at runtime" claim (a line that never fires, an unreachable branch) as a check, never a comment or doc note -- prose asserting a runtime fact rots silently; a check cannot lie. Full rule and the Global-listener cautionary example: `CONTRIBUTING.md`, Code Conventions.
- Before committing, sweep your own diff: delete every comment that restates the code, narrates change history ("now", "previously", "moved here"), or cites a board item id. Thoroughness is demonstrated in tests and checks, not prose.
- Board content is working context, never repo material: item ids and issue-body prose stay out of code, comments, docs, and commit messages.
- Prettier ignores markdown.
- Branch names shouldn't use '/'.
- Rebase and merge in a detached /tmp worktree (`git worktree add --detach`), never in /workspace: the IDE formatter/LSP races the working tree. Afterwards `git reset --hard` the branch in /workspace and remove the worktree.
- The Bash tool runs zsh: unquoted `$var` does not word-split, bare `grep` is ugrep, and an unmatched glob is an error -- quote globs, and use arrays or `xargs` for multi-file commands.
- `vitest -w` is watch mode and hangs a non-interactive session; use `npx vitest run` or `npm test -w <workspace>`.
- Dev containers are firewall-blocked: never give subagents web-search or web-fetch tasks.
- Don't use chip to raise issues -- ask directly.
- When you document a change, route the detail by tier: spec-level detail (constant values, byte/wire layout, HKDF info strings, algorithm steps) belongs in `docs/spec/`; overview docs (`docs/`) stay conceptual and operational -- regardless of which doc you currently have open. Full rule: `CONTRIBUTING.md`, Documentation.
- `CONTRIBUTING.md` is a pre-contribution quickstart, not a reference: do not add dependency-internal premises, upgrade runbooks, test-infra internals, coverage rationale, or design rationale to it -- route per its "Scope of this document" section. A CI backstop (`npm run check:contributing`) fails the build on the two mechanical tells -- a new `##`/`###` section outside its quickstart allowlist, or a `node_modules/` source-path citation -- but doc-tier placement is otherwise a review call, so keep deep material out even when it would pass.
- `CHANGELOG.md` is reader-facing release notes, not a commit log: an entry only for an observable change an operator/deployer or security reviewer acts on -- none for refactors, tests/CI, `@psilink/core` reshapes, or doc-only edits. Full rule: `CONTRIBUTING.md`, Changelog.
