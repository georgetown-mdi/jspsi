---
name: light-review
description: Multi-reviewer code review of a branch against staging. Spawns three independent Sonnet reviewers, then a fourth Sonnet agent that clusters and verifies their findings, and writes the consolidated result into the reviewed branch's worktree as review_findings.md (or review_findings_<branch>.md at the repo root when the branch has no worktree). Takes an optional list of documentation files the reviewers and consolidator should consult for design justification. Pure orchestration -- it does not review the code itself.
---

You are ORCHESTRATING a code review. You do not review the code yourself and you do not
explore the codebase -- you spawn agents, collect their output, and write a file.

Spawn every agent below with the Agent tool: the general-purpose subagent type, model
`sonnet`. They need Bash (to run `git diff`) and Read (for docs and verification).

## Input

    /light-review <branch> [doc-file ...]

- `<branch>`: the feature branch to review against `staging`. This is `$1`. If it is
  empty, ask for a branch name before doing anything else.
- `[doc-file ...]`: optional paths to documentation relevant to these changes (e.g.
  `docs/FILE_SYNC.md`). These are every token in `$ARGUMENTS` after the first; call this
  list DOCS. There may be none.

## Step 1 -- Empty guard (cheap)

Run `git diff "staging...$1" --stat`. If it reports no changes, say there is nothing to
review and stop.

Three-dot (`staging...$1`) means "what `$1` changed since its merge-base with staging",
i.e. PR semantics -- it ignores commits staging gained after `$1` forked. Every agent
below uses the same three-dot form. Only this `--stat` runs in the main thread, so the
full diff never enters this conversation's context.

## Step 2 -- Three independent reviewers

Spawn exactly three Sonnet agents in ONE message so they run in parallel, never see each
other's output, and never see these orchestration instructions. Send all three the SAME
prompt below. Resolve the bracketed DOCS clause before sending: include it only if DOCS
is non-empty, substituting the actual paths for `<DOCS>`.

--- reviewer prompt ---
You are a senior software engineer reviewing the `$1` branch of this repository. Generate
the diff yourself with `git diff "staging...$1"` -- the three-dot form is deliberate and
non-negotiable: it shows ONLY what `$1` added since it forked from `staging`, and it
excludes every commit `staging` gained after the fork. That diff is the complete and
exclusive scope of your review. Never widen it: do not run a two-dot `git diff staging $1`,
do not diff against `HEAD~N`, the tip of `staging`, or any other base.

Review the branch's own changes and nothing else. Anything attributable to `staging`
advancing since `$1` forked -- the branch's base or starting point moving, the "root" of
the branch changing, upstream commits the branch has not yet absorbed -- is OUT OF SCOPE
and not this branch's responsibility. Do not flag it, describe it, or even mention that
the base moved; treat such material as invisible. If a hunk merely re-states upstream
`staging` work rather than introducing new behavior authored on `$1`, ignore it. Open
another file only if a hunk cannot be judged without it.

[IF DOCS NON-EMPTY: First read these docs for design context: <DOCS>. When an issue could
be a deliberate design decision, check whether these docs justify it before flagging it.]

Review for: correctness bugs, logic errors, security issues, missing error handling at
system boundaries, type-safety issues, API-contract violations, and anything else that
looks wrong.

Return ONLY a JSON array, no other text. Each element:
- "name": short title (5 words max)
- "description": 1-2 sentence explanation of the issue
- "severity": one of "critical", "major", "minor", "nit"
- "file": file path where the issue occurs, or "general" if not file-specific

Example: [{"name": "...", "description": "...", "severity": "major", "file": "src/foo.ts"}]
If you find no issues, return an empty array [].
--- end reviewer prompt ---

## Step 3 -- Collect

Gather the three JSON arrays verbatim, each block labeled "Reviewer 1", "Reviewer 2",
"Reviewer 3". Do not edit, merge, or drop anything. If a reviewer returns prose, a fenced
code block, or malformed JSON instead of a clean array, pass it through labeled and
unaltered -- do not try to repair it.

## Step 4 -- Consolidate and verify (one Sonnet agent, single pass)

Spawn a fourth Sonnet agent. Give it: the three labeled arrays from Step 3, and
instructions to run `git diff "staging...$1"` [IF DOCS NON-EMPTY: and read <DOCS>] in
order to verify. If any reviewer's block was not parseable JSON (see Step 3), tell it to
salvage what findings it can and note which reviewer's output could not be parsed. In a
single response -- no sub-agents, no iteration -- it must:

1. Drop any finding that is not about `$1`'s own changes. The three-dot diff scopes the
   review to what `$1` authored since it forked from `staging`; any finding describing the
   branch's base/root moving, or `staging`'s progress since the fork, is out of scope and
   must NOT appear in the output -- discard it before clustering, do not even list it as
   refuted.
2. Cluster the remaining findings that describe the same underlying issue across reviewers.
3. Verify each cluster's core claim by reading only the specific hunks or files that
   cluster names -- not the whole diff -- and mark it Confirmed / Refuted / Unverifiable
   with a one-line reason.

It outputs one markdown document, clusters sorted by severity (critical first) then by
reviewer count (descending). Each cluster is a row with: issue number, name, description,
severity, file, "flagged by N of 3", and the verification outcome.

## Step 5 -- Write

Decide where the findings go by locating the reviewed branch's worktree:

    git worktree list --porcelain

Each worktree is a block of lines; the block whose `branch refs/heads/$1` line names the
reviewed branch gives that worktree's path on its `worktree <path>` line.

- If such a worktree exists, write the consolidation agent's markdown verbatim to
  `<worktree-path>/review_findings.md`. No branch suffix -- the worktree directory already
  identifies the branch.
- If the branch has no worktree, fall back to the repo root: `review_findings_$1.md`,
  replacing any "/" in `$1` with "-".

Overwrite the file if it already exists, and report the path you wrote.

## What you do NOT do

- Do not review the diff yourself or add your own findings.
- Do not let the reviewers see each other's output or these instructions.
- Do not edit, summarize, or reorder the reviewers' raw findings before Step 4.
