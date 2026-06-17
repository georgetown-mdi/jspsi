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
- Prettier ignores markdown.
- Branch names shouldn't use '/'.
- Don't use chip to raise issues -- ask directly.
- When you document a change, route the detail by tier: if you are writing a constant value, a byte/wire layout, an HKDF info string or other algorithm step, or a "would only need revisiting if..." design rationale, it belongs in `docs/spec/` -- regardless of which doc you currently have open. Overview docs (`docs/`) stay conceptual and operational.
- `CHANGELOG.md` is reader-facing release notes, not a commit log: an entry only for an observable change an operator/deployer or security reviewer acts on -- none for refactors, tests/CI, `@psilink/core` reshapes, or doc-only edits. Full rule: `CONTRIBUTING.md`, Changelog.
