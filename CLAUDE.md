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

The main thread owns the consult loop. On a NEEDS INPUT result, relay its questions via AskUserQuestion and re-spawn with the answers folded in -- the only form of "continuation". Coding subagents bubble PM requests up rather than spawning the consult themselves: AskUserQuestion and the human live only at the top level. A mechanical board write goes straight through `.claude/scripts/edit-issue.mjs`; the consult is for judgment -- whether to file at all, which board, what scope -- never for typing.

## Agent conventions

Beyond the conventions in `CONTRIBUTING.md`:

### Writing, tooling and commits

- Prefer ASCII: `-` not an en-dash or em-dash, `->` not an arrow character; no emoji anywhere, including as severity or status markers in reviews and reports.
- Never set the commit identity yourself -- no `git config` write to `user.*`, no `-c`/`--author=`/environment override: git resolves it from `.git/config`, and the harness context block's address is not it. Report a wrong configured identity to the maintainer; never override it. Enforced by `block-git-identity-override.mjs` on Bash.
- Commit messages use no markdown and no top-level lists (other format rules in `CONTRIBUTING.md`, Commit Messages).
- Before committing, sweep your own diff: delete every comment that restates the code, narrates change history ("now", "previously", "moved here"), or cites a board item id. Thoroughness lives in tests and checks, not prose.
- After a chain of edits, run `npm run typecheck && npm run lint && npm run format` (all three are CI checks); the LSP server often has a stale cache.
- A change adding a top-level directory under a guarded root (`apps/web`, `packages/core`) or editing CI/deploy config also runs `npm run test:scripts`: the workspace suites skip the CI/deploy drift guards, so an unclassified dir passes locally, reddening only in CI. `packages/peerjs-broker` instead takes `npm run check:deploy-trigger-graph` -- its own `eb_build_and_test.yaml` step, not run by `test:scripts` -- so run it yourself for a broker change.
- Encode a "does not happen at runtime" claim as a check, never a comment or doc note -- prose asserting a runtime fact rots silently; a check cannot lie. Full rule, with the Global-listener example: `CONTRIBUTING.md`, Code Conventions.
- Settle a question about an external tool's behavior -- npm, Docker, `ssh2` / `ssh2-sftp-client` -- by driving the real tool, never by reading its source or modeling its semantics. Reimplementing a tool's parser or config resolution to predict its behavior is a review finding: assert the outcome against the real tool, or state the limit. The SFTP adapter's harness: `docs/TESTING.md`.
- Prettier ignores markdown.
- The Bash tool runs zsh: unquoted `$var` does not word-split, bare `grep` is ugrep, and an unmatched glob is an error -- quote globs, and use arrays or `xargs` for multi-file commands.
- `vitest -w` is watch mode and hangs a non-interactive session; use `npx vitest run` or `npm test -w <workspace>`.
- Never sleep-poll a background run: every poll re-bills the polling session's whole context. Wait for the completion notification, or block on the condition itself (`until <test>; do sleep 2; done`), spending the interval on other work. Enforced by `block-sleep-poll.mjs` on Bash.

### Branches, worktrees and checkouts

- Branches are cut from `staging` and pull requests target `staging` -- the harness's default `main` base does not apply. Never commit to staging or main by yourself; don't attribute yourself on commits or pull requests.
- Branch names shouldn't use '/'.
- Rebase and merge in a detached /tmp worktree (`git worktree add --detach`), never in a tree the IDE watches -- /workspace or a tree under `.claude/worktrees/`: the IDE formatter/LSP races a live tree, and no ignore file fences it. Afterwards `git reset --hard` the branch in /workspace and remove the worktree.
- An orchestrating session writes no branch content, and neither does a checkout it is not working in -- the MAIN worktree always, a sibling worktree from inside a linked one -- since a stray write lands on the wrong branch, file or edit alike. Only gitignored paths (`scratch/`, briefs, round artifacts) and paths outside the repository are writable. A small assess-review fix (under 20 changed lines) goes out as a `sonnet` implementer's exact edit, not inline; anything larger is a full spawn (`.claude/commands/assess-review.md`, Step 3). Enforced by `block-primary-checkout-writes.mjs` on `Edit`, `Write`, and `NotebookEdit`; details in its header.
- Parallel writing spawns run in their own worktree: pass `isolation:"worktree"` on the `Agent` call as a PARAMETER, never only in the prompt (prose telling the agent it is in one is inert) -- re-read the call for that parameter before submitting a worktree-mentioning spawn. Enforced by `require-declared-worktree-isolation.mjs`. Read-only reviewers may share `/workspace`, diffing by ref. Have the agent run `.claude/scripts/worktree-init.sh` before its first edit, provisioning `node_modules` and re-pointing a fresh `main`-based tree onto `origin/staging`; details in its header.
- A worktree under `.claude/worktrees/` holds work that exists nowhere else until committed, so do not disturb a live one: leave another session's tree alone, retire a finished one with `git worktree remove <path>` (no `--force`) only once every in-flight agent has landed, and never switch out of one you have entered while an agent or review Workflow may still run there -- since a non-isolated run's write fence follows the session, switching cuts its shell mid-run and finishes the round read-only. Only a worktree-isolated spawn, or the by-ref flow that never enters a tree, is immune. Enforced by `block-worktree-deletions.mjs` on Bash -- rephrasing around its refusal destroys the tree just the same; details in its header.

### Review flow

- When you finish implementing a branch, end your report with a review-tier recommendation sized from the actual diff (`git diff "staging...HEAD" --stat` plus a security-surface check), not from the issue. Tiers and rule: `.claude/commands/start-issue.md`, Step 5.
- Resolving a PR's checklist means re-reading `.github/PULL_REQUEST_TEMPLATE.md` and performing the Docs line's enumeration against the diff; an n/a box is checked with a reason tied to this diff, and a changelog n/a names the class it skips. CI (`npm run check:pr-checklist`) backstops only the mechanical tells.
- A `Workflow` `schema` for a long-form agent follows the authoring rules in `.claude/commands/light-review.md`, Authoring a Workflow schema. An agent that exhausts its structured-output retries usually left analysis intact in the rejected attempts; salvage before re-running.
- Review and fixing run BY REF from the primary checkout, keeping several branches in review at once: `/light-review --target <ref>`, then `/assess-review <branch>`, then one implementer per branch pointed at that branch's worktree by absolute path. No step of that flow changes directory or checks anything out.
- Commit before any review round -- reviewers diff by ref and see only commits, so an uncommitted edit reads as absent -- and a review attests the commit it read: the checklist's Security review line carries that sha, and CI (`npm run check:pr-checklist`) fails while it is not the PR head. Re-attesting means reviewing that head; editing the sha alone is dishonest and invisible to the check. Details on re-attesting a moved head, the base-sync route needing none, and what voids each: `.claude/commands/assess-review.md`, Step 4. Enforced by `require-clean-tree-for-review.mjs` on `Workflow` calls only (an `Agent`-spawned review is not gated, so hold the rule yourself); details in its header.
- Never self-review a security- or partner-reachable surface: spawn an independent reviewer, even for a small rework -- it alone sees the diff and the issue. Spawn `security-reviewer` and `adversarial-verifier` only under a refutation contract (a named list of claims to refute, one per claim), and only when the diff carries adversary-reachable surface -- a test-only, docs-only, or support-script-only diff takes the lens round only, whatever its size -- run as `/light-review --role <name> --claims <file>`. Enforced by `require-review-contract.mjs` on a direct `Agent` spawn of either role; details: `.claude/commands/light-review.md`, The refutation contract.
- A gated claim or confirmed review finding has four dispositions: fix it, contest it by measurement, narrow it to what is measured, or record it as a stated limit in the round's dispositions ledger with no board item filed -- default for a confirmed finding that changes no runtime behavior on a user- or partner-reachable surface. Each exit's mechanics: `.claude/commands/assess-review.md`, Step 3.

### Models and spawns

- A one-shot agent -- a `.claude/agents/` role spawn, a `/light-review` round, a `Workflow` `agent()` call -- has no next turn: run a long command in the FOREGROUND with a raised `timeout` (Bash ceiling, 600000 ms), never `run_in_background`, since a completion notification cannot re-invoke a returned agent. Split a longer command into stages, or hand it back to the caller.
- Dev containers are firewall-blocked: never give subagents web-search or web-fetch tasks. CI run-log bodies are not blocked -- read failure detail via `gh run view --job <id> --log-failed`, falling back to the check-run annotations API only when no log body is available.
- Every Agent spawn passes an explicit model, or names a `subagent_type` whose `.claude/agents/` definition pins the tier -- Opus for implementation and ordinary review, Sonnet for mechanical work. Enforced by `require-agent-model.mjs`. The session model, Fable included, is the owner's choice, never an agent's, reserved for planning a complicated issue, a high-stakes review (new crypto, at-rest, protocol), or adjudicating a gated role round: a Fable spawn needs the owner's explicit per-spawn approval and is never inherited; accept a harness downgrade, never argue it. Enforced by `require-fable-approval.mjs` (`Agent` spawns) and `require-workflow-fable-approval.mjs` (a `Workflow` call naming Fable literally); a committed `Workflow` script's `agent()` call inherits the SESSION model when it omits `model:`, so every one pins a literal tier (`npm run check:workflow-agent-models`).
- Never SendMessage an agent to continue substantive work: the delivered message switches it to the session model on its next turn. Course-correct via TaskStop plus a fresh spawn -- fix rounds are fresh spawns too. Enforced by `block-model-drop-sendmessage.mjs`, whose header carries the `[accept-model-drop]` message override.

### Boards and PM

- Project state belongs in the GitHub project and docs/, and durable conventions in this file or the repo docs -- never agent memory, unshared and outside the repo. A fact you had to re-derive is durable: record it the first time, not the second.
- Board content is working context, never repo material: item ids and issue-body prose stay out of code, comments, docs, and commit messages -- except the PR description, where the template's Implements/Part of/Depends on/Follow-on line belongs when a board item exists.
- The repository is public and the project boards are not: an unfixed vulnerability's mechanism, and any private incident detail, stay in the board item, out of PR bodies, docs, and spec, until the fix lands.

### Documentation routing

- Route documentation detail by tier: spec-level -> `docs/spec/`; conceptual and operational -> `docs/`; design rationale and decisions taken -> `docs/notes/`, which points at the spec rather than restating it -- regardless of which doc you have open. Full rule: `CONTRIBUTING.md`, Documentation.
- `CONTRIBUTING.md` is a pre-contribution quickstart, not a reference: route deep material per its "Scope of this document" section. `npm run check:contributing` catches two mechanical tells only, so keep deep material out even when it would pass.
- `CHANGELOG.md` is reader-facing release notes, not a commit log: pre-release, the default is no entry -- add one only for a genuinely major feature or a breaking change to something already listed. Full rule: `CONTRIBUTING.md`, Changelog.

### Decisions, briefs and reporting

- A brief or report asserts a repo convention or a fact only by citing the repo file that carries it; anything carried from memory is labeled advisory or unverified -- an agent cannot tell an unsourced claim from a real one, and applies both.
- An orchestration session hands off at roughly 150 tool calls, past which its cost per call runs 2-3x: wrap there and write a continuation brief to a file, never pasted into the next session's prompt -- a paste enters that session's context at full width and is re-billed on every call it makes, while a path costs one Read.
- A subagent's final report stays within roughly 600 tokens; anything longer -- a survey's inventory above all -- goes in a file the report names by path.
- Every agent-written artifact -- a commit, a plan, an earlier session's conclusion -- is a proposal until the maintainer ratifies it in PR review or direct word; attribute that provenance when reporting state.
- NEVER open a decision with AskUserQuestion. A maintainer's decision goes in PROSE -- options, tradeoffs, a recommendation -- the question tool has one place only: relaying a PM consult's NEEDS INPUT round. Let in-flight agents land first, batching open questions into one message. Follow-on work a branch surfaces the same way: list only what changes behavior, as proposals in the PR body or report, filed on the owner's word.
- Weight the concrete driving scenario over general applicability -- an unattended failure needs a remedy, not a log line -- and rank efficiency work by token spend, not wall-clock time: scheduling and parallelism are the maintainer's own lever.
- A rebuild brief permits cherry-picking surviving code with edits; forced re-derivation of code that survived review is a defect in the brief.
- An issue's own deferred design decisions -- Open Questions, or a direction left to the maintainer -- are not the orchestrator's to settle silently. Proceed when obvious, after measuring the quantity in dispute: an immaterial delta is itself the answer, reported in a line. `/panel` settles a technical-judgment question whose answer changes runtime behavior or a public or partner-facing surface; proceed on its conclusion. Surface to the owner for a genuine product, scope, or priority call, or when the panel cannot converge -- a one-message ask is cheap, not a failure of autonomy.
- A control the issue's acceptance criteria do not require -- a new check, guard, or freeze -- is proposed in a line the owner can scope or defer before it is built: a policy making a surface in-scope for review licenses reviewing it, not constructing on it.
