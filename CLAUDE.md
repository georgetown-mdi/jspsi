# CLAUDE.md

psilink does Privacy Preserving Record Linkage (PPRL) via Private Set Intersection (PSI) between two parties over SFTP, file-drop, or WebRTC.

It is a npm workspaces monorepo (`packages/core`, `packages/peerjs-broker`, `apps/cli`, `apps/web`); apps consume packages, not the reverse.

**Read `CONTRIBUTING.md` before your first edit or commit.** It holds the build/test/dev reference and every coding and commit convention (enforced by CI and review), not reproduced here in full. This file is only the complement: project operations and agent-specific rules.

## Applications

Three applications make up psilink's surface (full architecture: `docs/DESIGN.md`, Architecture):

- **Public web application** (`apps/web`, deployed to Elastic Beanstalk): conducts WebRTC exchanges only, all data handling in the browser (the server only delivers the code). It owns the recurring-exchange management interface -- recurring exchanges in browser storage, run on a schedule as a PWA.
- **Command line application** (`apps/cli`, containerized): conducts SFTP, synced-folder (filedrop), and WebRTC exchanges. A CLI party and a browser party exchange over WebRTC through the shared peer-coordination server (`psilink exchange` on a `channel: webrtc` config). No WebSocket-to-TCP proxy is involved: that prerequisite is for a BROWSER reaching a TCP service (an SFTP server), not for the CLI, which opens sockets itself.
- **Console**: a local, single-owner PROTOTYPING GUI for the containerized CLI, repurposing the web application's machinery. It lowers the friction of the CLI -- writing a config and setting the right arguments -- so an operator authors and runs one exchange, conducted either by invoking the CLI or by the Node server running it directly. Its workflow is author-and-run once (test data, then maybe real data), then GRADUATE to the plain CLI plus cron/scheduler for the recurring production version. One machine, one person, authoring the connection and conducting the exchange: a web server, but not shared beyond the host. It operates on one mounted working directory holding a single exchange's config, secret, input, and results; only one exchange's resources are mounted at a time.

The console is NOT a store of named connections, a recurring-exchange or scheduling interface (that lives in the public web app; the CLI schedules from the command line), a multi-exchange job manager, or a network-shared management service with an access-control perimeter over the operator. There is NO deploy-time provisioner: the operator authors the SFTP connection in-console. The operator is the machine's own user; the only untrusted input is the remote partner's invitation content, which the exchange protocol already protects. Because the operator is trusted, the console must not hard-block them for a defense-in-depth posture (e.g. a credential file in the single mount) -- it warns and guides toward the better practice instead. Warn-and-guide governs the operator's own choices; a control constraining only remote or browser-delivered content the operator cannot inspect is correctly a hard refusal.

## Commands

Non-obvious ones (full reference in `CONTRIBUTING.md`):

```sh
npm run build -w packages/core # required after any core change
npm run test # unit tests only (root fans out to each workspace); run before pushing a core change -- the apps mock core
npx vitest run path/to/file.test.ts # single test file, from workspace root
```

## GitHub project items

Read and edit drafts by numeric ID (the `?itemId=N` URL value) or a `PVTI_` node id via the scripts -- never hand-write the gh/GraphQL. Run any with no args for usage.

- `node .claude/scripts/fetch-issues.mjs <project> <itemId> ...` -- read; shows custom fields
- `node .claude/scripts/edit-issue.mjs <project> <itemId> ...` -- edit status/title/body/fields
- `node .claude/scripts/list-epic.mjs <project> "<Epic>"` -- list an epic's items by Order
- `node .claude/scripts/list-issues.mjs <project>` -- list a board's non-Done items, fully paginated; `--all` includes Done, `--status NAME` filters, `--json` emits a machine array. A session choosing what to work on next prefers the `shortlist-backlog` skill over reading listings and bodies itself

Create a draft (the one board op still on `gh`): `gh project item-create <project> --owner georgetown-mdi --title "..." --body "..."`.

An item's board is not encoded in its id, and versions or paths quoted in its body are as-of-filing -- verify both before acting on them.

## Project manager

The PM ruleset lives once at `.claude/pm/ruleset.md`; two front doors load it:

- **`/pm` skill** -- interactive persona for board hygiene, epic scoping, and drafting/revising tasks in conversation. Confirms before board writes.
- **`project-manager` consult agent** -- one-shot, spawned to advise on a finding or capture a deferred task. Returns one terminal result (FEEDBACK / FILED / APPENDED / DECLINED / NEEDS INPUT) and **cannot be continued** (no `SendMessage`).

The main thread owns the consult loop. On a NEEDS INPUT result, relay its questions via AskUserQuestion and re-spawn with the answers folded in -- the only form of "continuation". Coding subagents raise PM requests to their caller, which raises them onward until they reach the top-level session, rather than spawning the consult themselves: AskUserQuestion and the human live only at the top level. A mechanical board write goes straight through `.claude/scripts/edit-issue.mjs`; the consult is for judgment -- whether to file at all, which board, what scope -- never for typing.

## Agent conventions

Beyond the conventions in `CONTRIBUTING.md`:

### Writing, tooling and commits

- Prefer ASCII: `-` not an en-dash or em-dash, `->` not an arrow character; no emoji anywhere, including as severity or status markers in reviews and reports.
- Write the plainest accurate word: no coined metaphor where a domain word exists, no internal name in text a user reads, and a user-visible string states what happened and what to do. The rule, the comment length bound and the negative wordlist: `CONTRIBUTING.md`, Code Conventions.
- Never set the commit identity yourself -- no `git config` write to `user.*`, no `-c`/`--author=`/environment override: git resolves it from `.git/config`, and the harness context block's address is not it. Report a wrong configured identity to the maintainer; never override it. Enforced by `block-git-identity-override.mjs` on Bash.
- Commit messages use no markdown and no top-level lists (other format rules in `CONTRIBUTING.md`, Commit Messages).
- A squash-and-merge draft goes into `scratch/squash-messages/` through the normalizer, never straight from a `Write`: draft it in /tmp and run `node .claude/scripts/format-squash-message.mjs <pr-number|unassigned> <draft> --out <path>`, which rewraps the body and drops markdown and list markers, then reports what it cannot fix without rewriting the message. Enforced by `block-nonconforming-squash-message.mjs` on `Write` and `Edit`; the limits live in the modules the normalizer reads.
- Before committing, sweep your own diff: delete every comment that restates the code, narrates change history ("now", "previously", "moved here"), or cites a board item id. Thoroughness lives in tests and checks, not prose.
- After a chain of edits, run `npm run typecheck && npm run lint && npm run format && npm run check:all` (all four are CI checks); the LSP server often has a stale cache. `check:all` drives every repo-wide guard from one list, `scripts/run-checks.mjs`, which names what each holds and why the few it skips are out -- so a guarded-root or CI-config change needs no separate command, while a `packages/peerjs-broker` change also runs `npm run check:deploy-trigger-graph` itself, the one guard the list leaves to `eb_build_and_test.yaml`.
- Encode a "does not happen at runtime" claim as a check, never a comment or doc note -- prose asserting a runtime fact rots silently; a check cannot lie. Full rule: `CONTRIBUTING.md`, Code Conventions.
- Settle a question about an external tool's behavior -- npm, Docker, `ssh2` / `ssh2-sftp-client` -- by driving the real tool, never by reading its source or modeling its semantics. Reimplementing a tool's parser or config resolution to predict its behavior is a review finding: assert the outcome against the real tool, or state the limit. The SFTP adapter's harness: `docs/TESTING.md`.
- Prettier ignores markdown.
- The Bash tool runs zsh: unquoted `$var` does not word-split, bare `grep` is ugrep, and an unmatched glob is an error -- quote globs, and use arrays or `xargs` for multi-file commands.
- `vitest -w` is watch mode and hangs a non-interactive session; use `npx vitest run` or `npm test -w <workspace>`.
- Never sleep-poll a background run: every poll re-bills the polling session's whole context. Wait for the completion notification, or block on the condition itself (`until <test>; do sleep 2; done`), spending the interval on other work. Enforced by `block-sleep-poll.mjs` on Bash.

### Branches, worktrees and checkouts

- Branches are cut from `staging` and pull requests target `staging` -- the harness's default `main` base does not apply. Never commit to staging or main by yourself; don't attribute yourself on commits or pull requests.
- Branch names shouldn't use '/'.
- Rebase and merge in a detached /tmp worktree (`git worktree add --detach`), never in a tree the IDE watches -- /workspace or a tree under `.claude/worktrees/`: the IDE formatter/LSP races a live tree, and no ignore file fences it. Afterwards `git reset --hard` the branch in /workspace and remove the worktree.
- An orchestrating session writes no branch content, and neither does a checkout it is not working in -- the MAIN worktree always, a sibling worktree from inside a linked one -- since a stray write lands on the wrong branch, file or edit alike. Only gitignored paths (`scratch/`, briefs, round artifacts) and paths outside the repository are writable. Enforced by `block-primary-checkout-writes.mjs` on `Edit`, `Write`, and `NotebookEdit`; details in its header.

### Spawns and reports

- When you finish implementing a branch, end your report with a review-tier recommendation sized from the actual diff (`git diff "staging...HEAD" --stat` plus a security-surface check), not from the issue. Tiers and rule: `.claude/commands/start-issue.md`, Step 5.
- A one-shot agent -- a `.claude/agents/` role spawn, a `/light-review` round, a `Workflow` `agent()` call -- has no next turn: run a long command in the FOREGROUND with a raised `timeout` (Bash ceiling, 600000 ms), never `run_in_background`, since a completion notification cannot re-invoke a returned agent. Split a longer command into stages, or hand it back to the caller.
- Dev containers are firewall-blocked: never give subagents web-search or web-fetch tasks. CI run-log bodies are not blocked -- read failure detail via `gh run view --job <id> --log-failed`, falling back to the check-run annotations API only when no log body is available.
- Every Agent spawn passes an explicit model, or names a `subagent_type` whose `.claude/agents/` definition pins the tier -- Opus for implementation and ordinary review, Sonnet for mechanical work. Enforced by `require-agent-model.mjs`.
- A brief or report asserts a repo convention or a fact only by citing the repo file that states it; anything taken from memory is labeled advisory or unverified -- an agent cannot tell an unsourced claim from a real one, and applies both.
- A subagent's final report stays within roughly 600 tokens; anything longer -- a survey's inventory above all -- goes in a file the report names by path.
- Every agent-written artifact -- a commit, a plan, an earlier session's conclusion -- is a proposal until the maintainer ratifies it in PR review or direct word; attribute that provenance when reporting state.
- Weight the concrete driving scenario over general applicability -- an unattended failure needs a remedy, not a log line -- and rank efficiency work by token spend, not wall-clock time: scheduling and parallelism are the maintainer's own lever.
- A control the issue's acceptance criteria do not require -- a new check, guard, or freeze -- is proposed in a line the owner can scope or defer before it is built: a policy making a surface in-scope for review licenses reviewing it, not constructing on it.

### Boards and PM

- Project state belongs in the GitHub project and docs/, and durable conventions in this file or the repo docs -- never agent memory, unshared and outside the repo. A fact you had to re-derive is durable: record it the first time, not the second.
- Board content is working context, never repo material: item ids and issue-body prose stay out of code, comments, docs, and commit messages -- except the PR description, where the template's Implements/Part of/Depends on/Follow-on line belongs when a board item exists.
- The repository is public and the project boards are not: an unfixed vulnerability's mechanism, and any private incident detail, stay in the board item, out of PR bodies, docs, and spec, until the fix lands.

### Documentation routing

- Route documentation detail by tier: spec-level -> `docs/spec/`; conceptual and operational -> `docs/`; design rationale and decisions taken -> `docs/notes/`, which points at the spec rather than restating it -- regardless of which doc you have open. Full rule: `CONTRIBUTING.md`, Documentation.
- `CONTRIBUTING.md` is a pre-contribution quickstart, not a reference: route deep material per its "Scope of this document" section. `npm run check:contributing` catches two mechanical tells only, so keep deep material out even when it would pass.
- `CHANGELOG.md` is reader-facing release notes, not a commit log: pre-release, the default is no entry -- add one only for a major feature a reader browsing the repository needs to know exists, or a breaking change to something already listed. Full rule: `CONTRIBUTING.md`, Changelog.

### Orchestrating a session

- The rules for conducting a session -- spawns, rounds, fix dispatch, owner decisions -- live in `.claude/orchestration/ruleset.md`. A session reads it before its first `Agent` or `Workflow` call and again after a context reset; `require-orchestration-ruleset-read.mjs` refuses that call until it has. A spawned agent does not read it; its rules are above.
