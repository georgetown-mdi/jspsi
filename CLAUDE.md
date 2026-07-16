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
- When you finish implementing a branch, end your report with a review-tier recommendation sized from the actual diff (`git diff "staging...HEAD" --stat` plus a security-surface check), not from the issue -- tiers and rule: `.claude/commands/start-issue.md`, Step 5.
- Resolving a PR's checklist requires re-reading `.github/PULL_REQUEST_TEMPLATE.md` and actually performing the Docs line's enumeration of `docs/` and `docs/spec/` against the diff; an n/a box is checked with a reason tied to this diff, never left unchecked, and a changelog n/a names the skipped class it claims (bug fix, UI polish, individual flag, refactor, test/CI/tooling, core reshape, doc-only). CI (`npm run check:pr-checklist`) backstops the mechanical tells -- an unchecked box, a deleted required line, a bare n/a.
- Board content is working context, never repo material: item ids and issue-body prose stay out of code, comments, docs, and commit messages.
- Prettier ignores markdown.
- Branch names shouldn't use '/'.
- Rebase and merge in a detached /tmp worktree (`git worktree add --detach`), never in /workspace: the IDE formatter/LSP races the working tree. Afterwards `git reset --hard` the branch in /workspace and remove the worktree.
- The Bash tool runs zsh: unquoted `$var` does not word-split, bare `grep` is ugrep, and an unmatched glob is an error -- quote globs, and use arrays or `xargs` for multi-file commands.
- `vitest -w` is watch mode and hangs a non-interactive session; use `npx vitest run` or `npm test -w <workspace>`.
- Dev containers are firewall-blocked: never give subagents web-search or web-fetch tasks.
- Workflow `schema` for long-form agents (reviewers, panelists): put the required list property first and instruct "populate every property; empty array when none". Do not tight-cap free-text fields with `maxLength` -- the validator counts characters and the model cannot, so retries never converge; ask for brevity in the property description instead (a generous runaway backstop is fine). An agent that exhausts the structured-output retries: its analysis is usually intact in the rejected attempts in its transcript -- salvage it before re-running; otherwise re-run as a plain agent with a fixed-format text contract.
- Don't use chip to raise issues -- ask directly.
- When you document a change, route the detail by tier: spec-level detail (constant values, byte/wire layout, HKDF info strings, algorithm steps) belongs in `docs/spec/`; overview docs (`docs/`) stay conceptual and operational -- regardless of which doc you currently have open. Full rule: `CONTRIBUTING.md`, Documentation.
- `CONTRIBUTING.md` is a pre-contribution quickstart, not a reference: do not add dependency-internal premises, upgrade runbooks, test-infra internals, coverage rationale, or design rationale to it -- route per its "Scope of this document" section. A CI backstop (`npm run check:contributing`) fails the build on the two mechanical tells -- a new `##`/`###` section outside its quickstart allowlist, or a `node_modules/` source-path citation -- but doc-tier placement is otherwise a review call, so keep deep material out even when it would pass.
- `CHANGELOG.md` is reader-facing release notes, not a commit log: pre-release, the default is no entry -- add one only for a genuinely major feature or a breaking change to something already listed. Full rule: `CONTRIBUTING.md`, Changelog.
- Every Agent spawn passes an explicit model, or a `subagent_type` whose `.claude/agents/` definition pins one. Enforced by `require-agent-model.mjs` (the authority for the model set and exemptions).
- Never SendMessage an agent to continue substantive work: the delivered message switches it to the session model on its next turn. Course-correct via TaskStop plus a fresh spawn; fix rounds are fresh spawns. Enforced by `block-model-drop-sendmessage.mjs` (`[accept-model-drop]` in the message is the deliberate override; its header carries the dated basis and re-verification method).
- Commit before any review round: reviewers diff `staging...HEAD` and see only commits. Enforced by `require-clean-tree-for-review.mjs`.
