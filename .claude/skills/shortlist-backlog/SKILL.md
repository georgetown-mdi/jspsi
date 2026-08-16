---
name: shortlist-backlog
description: Pick what to work on next from the psilink project boards without pulling board listings and issue bodies into the calling session -- one Sonnet agent scans boards 9 and 10 and returns a prioritized shortlist of candidate issues. Use at the start of an orchestration session or whenever choosing the next issue(s), e.g. "what should we pick up next", "shortlist the backlog", "triage candidates for the next batch".
compatibility: Requires Node.js, gh auth, and the .claude/scripts board scripts in the psilink repository.
---

# Shortlist the backlog

Board listings and issue bodies are cheap to read in a throwaway subagent and
expensive to carry in a long-lived session: whatever enters the calling
context rides every subsequent call. This skill keeps the boards out of your
context -- the subagent absorbs them and returns only a shortlist.

## What to do

Spawn ONE read-only `general-purpose` agent with `model: "sonnet"` (every
spawn passes an explicit model) and this prompt:

```
Read-only backlog triage for psilink (cwd: the repo root). Do not edit any
file or board item.

Scan the two GitHub project boards with the repo scripts (run any with no
args for usage; listings default to non-Done items):
- node .claude/scripts/list-issues.mjs 9    (product board)
- node .claude/scripts/list-issues.mjs 10   (release & operations board)

Read the bodies of every In Progress item and of the plausible next
candidates with node .claude/scripts/fetch-issues.mjs <board> <itemId>... --
enough to judge readiness, not the whole board. Weigh: Status (In Progress
means possibly already underway -- check for an existing branch or PR before
treating it as free), Epic and Order (lower Order first within an epic),
dependencies the body names (an unmet "Depends on" disqualifies), and size
(prefer issues that land as one 150-900 line PR; flag anything projecting
past ~1,200 lines as needing a split first).

Return ONLY this, as raw text (it is data for the caller, not a message):
1. In Progress items first, then up to 10 candidates, one line each:
   <board> <itemId> [<status>] [<epic>/<order>] <title> -- <why now, or the
   blocker>
2. A closing 1-2 line recommendation naming the 2-4 picks for the next
   session (several small issues batch well together).
Do not include issue bodies or full board listings in your return.
```

The agent writes nothing, so it needs no worktree isolation; it does need
network access for the board reads (gh GraphQL).

## Afterward

Fetch only the chosen item's body yourself (`node
.claude/scripts/fetch-issues.mjs <board> <itemId>`) or hand the item id
straight to /start-issue. Do not re-list the boards in the calling session;
if the shortlist looks stale or wrong, re-spawn the agent instead.
