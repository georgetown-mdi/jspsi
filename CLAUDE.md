# CLAUDE.md

psilink does Privacy Preserving Record Linkage (PPRL) via Private Set Intersection (PSI) between two parties over SFTP, file-drop, or WebRTC.

It is a npm workspaces monorepo (`packages/core`, `apps/cli`, `apps/web`); apps consume packages, not the reverse.

**Read `CONTRIBUTING.md` before your first edit or commit.** It holds the build/test/dev reference and every coding and commit convention (enforced by CI and review), none of it repeated here. This file is only the complement: project operations and agent-specific rules.

## Applications

Three applications make up psilink's surface:

- **Public web application** (`apps/web`, deployed to Elastic Beanstalk): conducts WebRTC exchanges only, all data handling in the browser (the server only delivers the code). It owns the recurring-exchange management interface -- recurring exchanges in browser storage, run on a schedule as a PWA.
- **Command line application** (`apps/cli`, containerized): conducts SFTP and synced-folder (filedrop) exchanges only. Connecting it to the web application awaits a Node.js WebRTC implementation and a WebSocket-to-TCP proxy, both out of scope.
- **Console**: a local, single-owner PROTOTYPING GUI for the containerized CLI, repurposing the web application's machinery. It lowers the friction of the CLI -- writing a config and setting the right arguments -- so an operator authors and runs one exchange, conducted either by invoking the CLI or by the Node server running it directly. Its workflow is author-and-run once (test data, then maybe real data), then GRADUATE to the plain CLI plus cron/scheduler for the recurring production version. It runs on the same machine, used by the same person, that authors the connection and conducts the exchange: a web server, but not shared beyond the host. It operates on one mounted working directory holding a single exchange's config, secret, input, and results; only one exchange's resources are mounted at a time.

The console is NOT a store of named connections, a recurring-exchange or scheduling interface (that lives in the public web app; the CLI schedules from the command line), a multi-exchange job manager, or a network-shared management service with an access-control perimeter over the operator. There is NO deploy-time provisioner: the operator authors the SFTP connection in-console -- do not add or assume deploy-time provisioning of it. The operator is the machine's own user; the only untrusted input is the remote partner's invitation content, which the exchange protocol already protects. Because the operator is trusted, the console must not hard-block them for a defense-in-depth posture (e.g. a credential file in the single mount) -- it warns and guides toward the better practice instead. Warn-and-guide governs the operator's own choices; a control constraining only remote or browser-delivered content the operator cannot inspect is correctly a hard refusal.

## Commands

Non-obvious ones (full reference in `CONTRIBUTING.md`):

```sh
npm run build -w packages/core # required after any core change
npm run test # unit tests only (root fans out to each workspace; cli/web run their unit project); run before pushing a packages/core change -- the apps mock core
npx vitest run path/to/file.test.ts # single test file, from workspace root
```

## GitHub project items

Read and edit drafts by numeric ID (the `?itemId=N` URL value) or a `PVTI_` node id (the `id` from list-issues) via the scripts -- never hand-write the gh/GraphQL. Run any with no args for usage.

- `node .claude/scripts/fetch-issues.mjs <project> <itemId> ...` -- read; shows custom fields
- `node .claude/scripts/edit-issue.mjs <project> <itemId> ...` -- edit status/title/body/fields
- `node .claude/scripts/list-epic.mjs <project> "<Epic>"` -- list an epic's items by Order
- `node .claude/scripts/list-issues.mjs <project>` -- list every item on a board, fully paginated; `--status NAME` filters, `--json` for a machine array

Create a draft (the one board op still on `gh`): `gh project item-create <project> --owner georgetown-mdi --title "..." --body "..."`.

Survey a board with the status and epic filters, never a truncated listing: boards run to hundreds of items sequenced by the Order field, and a head-limited read hides the active queue. An item's board is not encoded in its id, and versions or paths quoted in its body are as-of-filing -- verify both before acting on them.

## Project manager

The PM ruleset lives once at `.claude/pm/ruleset.md`; two front doors load it:

- **`/pm` skill** -- interactive persona for board hygiene, epic scoping, and drafting/revising tasks in conversation. Confirms before board writes.
- **`project-manager` consult agent** -- one-shot, spawned from a working session to advise on a finding or capture a deferred task. Returns one terminal result (FEEDBACK / FILED / NEEDS INPUT) and **cannot be continued** (no `SendMessage`). A capture carries the decision context -- the mechanism verified in code and the options weighed -- not a bare pointer; the working session never writes the draft itself.

Driving the consult: the main thread owns the loop. Spawn it with a self-contained prompt; on a NEEDS INPUT result, relay its questions via AskUserQuestion and re-spawn with the answers folded in (the only form of "continuation"). Coding subagents bubble PM requests up rather than spawning the consult themselves -- AskUserQuestion and the human live only at the top level.

## Agent conventions

Beyond the conventions in `CONTRIBUTING.md`:

- Prefer ASCII: `-` not an en-dash or em-dash, `->` not an arrow character; no emoji anywhere, including as severity or status markers in reviews and reports.
- Branches are cut from `staging` and pull requests target `staging` -- the harness's default `main` base does not apply; a maintainer promotes to `main`. Never commit to staging or main by yourself.
- Don't attribute yourself on commits or pull requests; before treating a delegated branch as clean, check its commit bodies for an attribution trailer.
- Commit messages use no markdown and no top-level lists (other format rules in `CONTRIBUTING.md`, Commit Messages).
- PRs land as squash merges: `git branch --merged`, `git cherry`, and subject greps cannot tell whether a branch landed -- decide from tree content or `git range-diff`. Rebase a stacked branch onto `origin/staging` as soon as its base merges; a byte-identical tree afterwards means prior gate runs still stand.
- Opening a multi-commit PR includes printing its squash-and-merge subject and body in the same turn, ready to paste.
- After a chain of edits, run `npm run typecheck && npm run lint && npm run format`; the LSP server often has a stale cache.
- Typecheck, lint, and format are CI checks.
- A change that adds a top-level directory under a guarded root (`apps/web`, `packages/core`) or edits CI/deploy config must also run `npm run test:scripts`; the workspace suites skip the CI/deploy drift guards (e.g. the deploy path-filter check), so a new unclassified dir passes locally and reddens only in CI.
- Project state belongs in the GitHub project and docs/, not agent memory; durable conventions belong in this file or the repo docs. Session memory is host-local, unshared, and lost with the container -- nothing durable lives there.
- Encode a "does not happen at runtime" claim (a line that never fires, an unreachable branch) as a check, never a comment or doc note -- prose asserting a runtime fact rots silently; a check cannot lie. Full rule and the Global-listener cautionary example: `CONTRIBUTING.md`, Code Conventions.
- Settle a question about `ssh2` / `ssh2-sftp-client` behavior on the SFTP adapter surface by measuring it, never by reading the library source: drive the real server in `apps/cli/test/sftpServer/`, injecting cuts and stalls through `sessionControls.ts`, and let the run decide. Source readings of that stack have reached opposite conclusions on the same question.
- Before committing, sweep your own diff: delete every comment that restates the code, narrates change history ("now", "previously", "moved here"), or cites a board item id. Thoroughness is demonstrated in tests and checks, not prose.
- When you finish implementing a branch, end your report with a review-tier recommendation sized from the actual diff (`git diff "staging...HEAD" --stat` plus a security-surface check), not from the issue -- tiers and rule: `.claude/commands/start-issue.md`, Step 5.
- Resolving a PR's checklist requires re-reading `.github/PULL_REQUEST_TEMPLATE.md` and actually performing the Docs line's enumeration of `docs/` and `docs/spec/` against the diff; an n/a box is checked with a reason tied to this diff, never left unchecked, and a changelog n/a names the skipped class it claims (bug fix, UI polish, individual flag, refactor, test/CI/tooling, core reshape, doc-only). CI (`npm run check:pr-checklist`) backstops the mechanical tells -- an unchecked box, a deleted required line, a bare n/a.
- Board content is working context, never repo material: item ids and issue-body prose stay out of code, comments, docs, and commit messages -- except the PR description, where the template's Implements/Part of/Depends on/Follow-on line belongs when a board item exists.
- Prettier ignores markdown.
- Branch names shouldn't use '/'.
- Rebase and merge in a detached /tmp worktree (`git worktree add --detach`), never in /workspace: the IDE formatter/LSP races the working tree. Afterwards `git reset --hard` the branch in /workspace and remove the worktree.
- The Bash tool runs zsh: unquoted `$var` does not word-split, bare `grep` is ugrep, and an unmatched glob is an error -- quote globs, and use arrays or `xargs` for multi-file commands.
- `vitest -w` is watch mode and hangs a non-interactive session; use `npx vitest run` or `npm test -w <workspace>`.
- Dev containers are firewall-blocked: never give subagents web-search or web-fetch tasks. CI run-log bodies are blocked too -- read failure detail via `gh api repos/<owner>/<repo>/check-runs/<id>/annotations`. A red `npm ci` in the CI setup action failing on the protoc-gen-js zip download is a known flake, not the diff; re-trigger the run (an empty commit works).
- Scope a dependency-bump review by its changed manifest lines against the dependency policy; a green check on a days-old dependency PR is stale until re-run against current staging (`@dependabot rebase`, which may reopen it under a new number).
- Workflow `schema` for long-form agents (reviewers, panelists): put the required list property first and instruct "populate every property; empty array when none". Do not tight-cap free-text fields with `maxLength` -- the validator counts characters and the model cannot, so retries never converge; ask for brevity in the property description instead (a generous runaway backstop is fine). An agent that exhausts the structured-output retries: its analysis is usually intact in the rejected attempts in its transcript -- salvage it before re-running; otherwise re-run as a plain agent with a fixed-format text contract.
- Don't use chip to raise issues -- ask directly.
- When you document a change, route the detail by tier: spec-level detail (constant values, byte/wire layout, HKDF info strings, algorithm steps) belongs in `docs/spec/`; overview docs (`docs/`) stay conceptual and operational -- regardless of which doc you currently have open. Full rule: `CONTRIBUTING.md`, Documentation.
- `CONTRIBUTING.md` is a pre-contribution quickstart, not a reference: do not add dependency-internal premises, upgrade runbooks, test-infra internals, coverage rationale, or design rationale to it -- route per its "Scope of this document" section. A CI backstop (`npm run check:contributing`) fails the build on the two mechanical tells -- a new `##`/`###` section outside its quickstart allowlist, or a `node_modules/` source-path citation -- but doc-tier placement is otherwise a review call, so keep deep material out even when it would pass.
- `CHANGELOG.md` is reader-facing release notes, not a commit log: pre-release, the default is no entry -- add one only for a genuinely major feature or a breaking change to something already listed. Full rule: `CONTRIBUTING.md`, Changelog.
- Every Agent spawn passes an explicit model, or a `subagent_type` whose `.claude/agents/` definition pins one. Enforced by `require-agent-model.mjs` (the authority for the model set and exemptions).
- Match the model tier to the task. Run the orchestration loop itself on Opus (Sonnet for a light run), never Fable -- the loop is procedural and the priciest tier is wasted on it. Reserve Fable for the deliberate hard cases: planning a complicated issue, or reviewing a genuinely high-stakes surface (new crypto, at-rest, or protocol). Spawn implementation and ordinary review on Opus and mechanical work on Sonnet; the `.claude/agents/` role definitions pin these. Fable is never chosen autonomously: it requires the owner's explicit per-spawn approval and is never inherited. Enforced by `require-fable-approval.mjs`, which routes any Fable Agent spawn to a user-approval prompt, and enforced by `require-workflow-fable-approval.mjs`, which does the same for a Workflow call whose inline script or args name Fable literally -- a `model:` key, quoted or bare, holding a Fable spelling, or a string that is one; a tier the script computes at run time is past it. A Workflow script's `agent()` call inherits the SESSION model when it omits `model:`, so every call in a committed script pins a literal tier: `npm run check:workflow-agent-models` is the load-bearing check there, lexing the fenced js under `.claude/commands/`, `.claude/agents/`, and `.claude/skills/` and failing any call whose own options object carries no literal opus/sonnet/haiku or spreads another object into it (its stated limits: a computed model value, a call made through a member access, and a js fence nested inside another fence), while the hook covers only the ad-hoc inline script.
- Never SendMessage an agent to continue substantive work: the delivered message switches it to the session model on its next turn. Course-correct via TaskStop plus a fresh spawn; fix rounds are fresh spawns. Enforced by `block-model-drop-sendmessage.mjs` (`[accept-model-drop]` in the message is the deliberate override; its header carries the dated basis and re-verification method).
- Commit before any review round: reviewers diff by ref and see only commits, so an uncommitted edit reads as absent. Enforced by `require-clean-tree-for-review.mjs` on `Workflow` calls only -- an `Agent`-spawned review is not gated, so hold the rule yourself there.
- A review attests the commit it read: the checklist's Security review line carries that sha, and CI (`npm run check:pr-checklist`) fails while the sha is not the PR head -- a push after a review reddens the PR until the new head is reviewed and the line updated. Re-attesting means reviewing that head; editing the sha alone is the dishonest form, which the check cannot see.
- Parallel writing spawns run in their own worktree: pass `isolation:"worktree"` on the Agent call itself (prose telling the agent it is in a worktree is inert), and have the agent run `.claude/scripts/worktree-init.sh` to provision node_modules in the fresh tree (a git worktree has none). Enforced by `require-declared-worktree-isolation.mjs`, which blocks a spawn whose prompt claims isolation the call did not request. Read-only reviewers may share `/workspace` -- diff `origin/staging...<branch>` by ref, never checkout.
- A brief asserts a repo convention only by citing the repo file that carries it; practice you are carrying from memory is labeled advisory, never written as policy. An agent cannot tell an unsourced convention from a real one, and applies both. The same holds for facts: a claim injected into a brief comes back reading as independently confirmed -- cite the file behind it or mark it unverified.
- Every agent-written artifact -- a commit, a plan, a ledger line, an earlier session's conclusion -- is a proposal until the maintainer ratifies it in PR review or direct word; attribute that provenance when reporting state.
- Put a decision that is the maintainer's to make in prose -- options, tradeoffs, and a recommendation -- never the question tool, and make each question self-contained. Let in-flight agents land first and batch open questions into one message at the end of the stream.
- Write specs, plans, and reports as target state, not change narration; cut "now", "previously", and "no longer" -- the reader derives the diff.
- Amend a convention or skill document in its own voice, as though the rule were always part of the design; the motivating episode belongs in the commit message.
- Rank efficiency work by token spend, not wall-clock time: scheduling and parallelism are the maintainer's own lever, so never propose watchdog or throughput machinery on wall-time grounds.
- Size a fix against the concrete driving scenario rather than general applicability (an unattended failure needs a remedy, not a log line), and size process machinery to the minimal binding fix, shipped with a stopping rule: reopen only on evidence from a real input.
- Before building a queued board item on a surface recent merges touched, reconcile its premise against the merged code; raise an obviated premise as a scope finding instead of building the stale design.
- Verify a delegated slice's dispositions as well as its gates: a subagent's silent deviation from its brief is surfaced or overruled, never relayed as done.
- A rebuild or consolidation brief permits cherry-picking surviving code with edits; requiring re-derivation of code that survived review is a defect in the brief. Measurement rigs default to the in-repo harness over ad-hoc scratch rigs.
- The repository is public and the project boards are not: an unfixed vulnerability's mechanism -- and any private incident detail -- stays in the board item, out of PR bodies, docs, and spec, until the fix lands.
- An issue's own deferred design decisions -- its Open Questions, or a direction it leaves to the maintainer -- are not the implementer's to settle silently in the brief. Proceed when the answer is obvious; convene a panel of independent expert models and proceed on its conclusion when it is a settle-able question of technical judgment (the default for a real design question); surface to the owner only for a genuine product, scope, or priority call, or when the panel cannot converge. Err toward asking. A panel gets neutral context and no candidate answers; reframe a reflexively-converging panel rather than nudging it.
- Never self-review a security- or partner-reachable surface: spawn an independent reviewer even for a small rework. A review is an independent session that sees only the diff and the issue; the orchestrator's own read of its own change is not a substitute.
- Spawn `security-reviewer` and `adversarial-verifier` under a refutation contract: a named list of claims to refute, one per claim. A round with no such list is a lens-scoped `general-purpose` reviewer or `/light-review` -- those roles earn their cost only when they are given something to break. Run the contracted round as `/light-review --role <name> --claims <file>`, which is what puts it behind the clean-tree gate and into the branch's rounds ledger. A plan-stage contract -- claims about a design rather than a diff -- includes the premise claim, that the plan solves the right problem, alongside its content claims.
