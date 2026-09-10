---
title: "What CLAUDE.md Costs Each Spawn"
---

# CLAUDE.md's per-spawn cost, and the orchestrator-only share of it

_Status: measurement, and the split taken against it on 2026-09-10 on the
owner's ruling. The measurement sections stand as measured; what the ruling
moved out of [CLAUDE.md](../../CLAUDE.md) and what it left there is the closing
Decision section. The rules classified below are cited by section, not restated.
See [docs/notes/README.md](README.md)._

## Method

CLAUDE.md is 20,817 bytes, about 5,204 tokens at the characters/4 estimator used
throughout; "Agent conventions" is 15,228 of them, 73.2 percent, and
[`scripts/check-claudemd-budget.mjs`](../../scripts/check-claudemd-budget.mjs)
caps the file at 21,487. Three measurements, each driven against the harness:

- **What a spawn receives.** One agent of each type -- `general-purpose`,
  `Explore`, `implementer`, `ux-reviewer`, `project-manager` -- at
  `model: "sonnet"`, using no tool, reporting only what its own context held:
  two distinctive CLAUDE.md sentences, body text from `.claude/pm/ruleset.md`,
  `.claude/commands/*.md` or `.claude/skills/`, and the files it could name.
- **The orchestrator-only share.** Every bullet under "Agent conventions"
  classified by hand, each one's size taken from the file's own bytes.
- **Spawns and calls.** Counted from the harness transcript store,
  `~/.claude/projects/-workspace/<session>/subagents/`, one `.jsonl` and one
  `.meta.json` per spawn. Calls are distinct `requestId` values over the
  assistant records, so one request emitting several records counts once.

## What each spawn type receives

| Spawn type | CLAUDE.md | Memory index | `pm/ruleset.md` body | `commands/*.md` body | `skills/` text | Self-estimated chars |
| ---------- | --------- | ------------ | -------------------- | -------------------- | -------------- | -------------------- |
| `general-purpose` | whole | yes | no | no | catalog only | 20,000-21,000 |
| `Explore` | absent | no | no | no | catalog only | 0 (reported absent) |
| `implementer` | whole | yes | no | no | no | 8,500 |
| `ux-reviewer` | whole | yes | no | no | no | 12,000-13,000 |
| `project-manager` | whole | yes | no | no | no | 16,000-17,000 |

- CLAUDE.md arrives whole where it arrives at all: every type receiving it named
  the same five `##` sections in order. `Explore` receives none of it, so no
  split changes its cost. `security-reviewer` and `adversarial-verifier` need a
  refutation contract to spawn; unmeasured, they share the `.claude/agents/`
  mechanism, so their row is inferred to match `implementer`.
- No type receives the body of `.claude/pm/ruleset.md` or of any
  `.claude/commands/*.md`; both are cited by path only. The `project-manager`
  role definition tells it to read the ruleset while the ruleset's text is
  absent from its context.
- The self-estimated character counts span 8,500 to 21,000 against an actual
  20,817: they establish presence and absence, not size.

## The orchestrator-only share

Both partitions cover the 45 bullets under "Agent conventions", sized in bytes.

- **By role** -- orchestrator-only only where no spawned role's own work touches
  the bullet, so the closing review-tier recommendation (citing
  `.claude/commands/start-issue.md`, Step 5), the one-shot foreground and
  explicit-model rules, and the 600-token report bound all stay. **5,995 bytes,
  about 1,499 tokens -- 28.8 percent of the file.**
- **By session** -- main-session-only where the bullet governs conducting a
  session: review contracts and round caps, fix dispatch, spawn and SendMessage
  mechanics, decision and briefing rules, worktree orchestration. **9,431 bytes,
  about 2,358 tokens -- 45.3 percent of the file.**

The by-role partition is a subset of the by-session one; the 3,436-byte (859
token) gap is ten bullets a subagent consumes while the section they sit in
reads as orchestration. "Writing, tooling and commits", "Boards and PM" and
"Documentation routing" are every-agent entire under both.

## Spawns per session, and calls per spawn

The three most recent sessions with subagent transcripts, excluding this
measurement's own session and its caller's in-flight one. Pooled: 107 spawns,
median 53 requests per spawn, mean 64.2; every type observed receives CLAUDE.md,
so the whole population is in scope.

| Session (last activity) | Spawns | Median requests per spawn | Total requests | Spawn types |
| ----------------------- | ------ | ------------------------- | -------------- | ----------- |
| 2026-09-06 | 61 | 58 | 4,636 | 56 implementer, 3 general-purpose, 2 project-manager |
| 2026-09-06 | 38 | 37 | 1,817 | 31 implementer, 7 general-purpose |
| 2026-09-05 | 8 | 41.5 | 421 | 6 implementer, 2 general-purpose |

## The saving

CLAUDE.md sits in each spawn's prefix, so its cost falls on every request that
spawn makes. The cached figure bills the first request at full input rate and
the rest at 0.1; the full-rate figure bills every request in full, an upper
bound.

| Partition | Per spawn, 53 requests | Per session, mean of the three |
| --------- | ---------------------- | ------------------------------ |
| By role (1,499 tok) | 9,294 tok-eq cached / 79,447 tok full | 392,000 tok-eq cached / 3.43M tok full |
| By session (2,358 tok) | 14,620 tok-eq cached / 124,974 tok full | 616,000 tok-eq cached / 5.40M tok full |

Against the input token-equivalents those spawns billed (105.4M pooled, summed
from each request's `usage` with cache creation at 1.25 and reads at 0.1), the
cached saving is **1.1 percent** of subagent input by role, **1.8** by session.

## What the measurement answers about a session-only file

The harness injects CLAUDE.md and the user memory index into a spawn, and no
other repository file's body -- not `.claude/pm/ruleset.md`, not any
`.claude/commands/*.md`, both of which sessions load by reading them. Content
moved into a file the session reads therefore leaves every spawn prefix, for one
Read into the session's own prefix: the mechanism a split needs already carries
those two files.

## What this does not settle

Whether the split is worth making. The saving is real but small against subagent
input spend, and is bought by putting a rule behind a file someone must read: a
bullet an orchestrating subagent needs and stops receiving is a correctness cost
no token figure prices, and neither partition was validated against an agent
deprived of the text. The sizes rest on a hand classification of 45 bullets,
roughly ten arguable, and on three sessions whose spawn counts range from 8 to
61; a session's mix of spawn types moves the per-session figure more than the
partition boundary does.

## Decision

The split was taken on the owner's ruling, against these numbers.

**What moved**, into [`.claude/orchestration/ruleset.md`](../../.claude/orchestration/ruleset.md):
the by-role partition, plus the gap bullets whose reader is the session -- worktree
orchestration, the whole review flow, the session-model choice, and the decision
and briefing rules. Two bullets split at a sentence: the primary-checkout rule
keeps its write fence in CLAUDE.md and sends only the fix-dispatch sentence, and
the model rule keeps "every Agent spawn passes an explicit model" and sends the
rest.

**What stayed**, under one rule: a bullet a spawned role consumes stays in
CLAUDE.md. That keeps the four the by-role partition already named, and all of
"Writing, tooling and commits", "Boards and PM" and "Documentation routing".

**Load mechanism.** CLAUDE.md names the ledger once, in the pointer bullet under
"Orchestrating a session", and the five front doors the ledger's own preamble
lists -- the `start-issue`, `light-review`, `assess-review` and `panel`
commands, and the `shortlist-backlog` skill -- each open with a line reading it.
That is the shape `.claude/pm/ruleset.md` and its two front doors already use.

**The check.** `npm run check:rule-ledgers`
([`scripts/check-rule-ledgers.mjs`](../../scripts/check-rule-ledgers.mjs)) holds
each hook claim and each heading to one ledger and holds the load mechanism
wired; `npm run check:enforcement-claims` validates the claims in both
files. Neither can see a rule that returns to CLAUDE.md under new words with no
enforcement claim and no heading of its own -- the byte budget is the guard that
covers bulk regrowth.

**Sizes.** CLAUDE.md was 21,031 bytes before the split and is 14,364 after, its
budget ceiling 14,400; the ledger is 7,907, the difference being its preamble
and headings.
6,667 bytes left every spawn's prefix, 31.7 percent of the pre-split file --
between this note's two partitions.

**The one assumption no check holds.** That the harness injects CLAUDE.md into a
spawn and does not inject the ledger. It is measured in the table above and
nowhere enforced: a harness that began injecting `.claude/` file bodies would
return the whole cost with nothing turning red.
