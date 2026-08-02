---
name: light-review
description: Code review of the current branch (HEAD) against staging, through one Workflow. Default lens mode runs three independent schema-forced Sonnet reviewers and a Sonnet consolidator. Role mode (--role security-reviewer|adversarial-verifier --claims <file>) runs one schema-forced Opus role reviewer against a named list of claims to refute. Either mode computes the round's trajectory against prior rounds of its kind and writes review_findings.md in the working directory. Takes an optional list of documentation files every agent it spawns should consult for design justification. Pure orchestration -- it does not review the code itself.
---

You are ORCHESTRATING a code review. You do not review the code yourself and you
do not explore the codebase -- you run one Workflow, compute the round's
trajectory, and write a file.

## Input

    /light-review [--role <name> --claims <path>] [doc-file ...]

- `--role <name>`: optional. `security-reviewer` or `adversarial-verifier`, and nothing
  else -- stop if the name is anything else. Selects ROLE mode; without it you are in
  LENS mode.
- `--claims <path>`: the refutation contract for role mode, one claim per line.
- `[doc-file ...]`: optional paths to documentation relevant to these changes (e.g.
  `docs/spec/FILE_SYNC.md`). These are the remaining tokens in `$ARGUMENTS` after the
  flags above; call this list DOCS. There may be none.

Role mode requires the contract. If `--role` is given and `--claims` is missing, its
file is unreadable, or it yields no claims, stop and say the round belongs to the plain
`/light-review` lens form or a lens-scoped `general-purpose` reviewer. Quote the
refutation-contract bullet in CLAUDE.md's Agent conventions as the reason -- these two
roles run only under a named list of claims to refute -- and do not restate it as a rule
of your own.

In role mode, read the claims file in the main thread: every non-empty line is one
claim, trimmed, with a leading list marker (`- `, `* `, `1. `) stripped. Call this list
CLAIMS.

Hold each claim to the contract-language rules in CLAUDE.md's refutation-contract
bullet before running the round. A claim asserting totality ("cannot be bypassed",
"no way to", "genuinely binds") rather than a measured bound, or a post-narrowing
no-regression claim scoped to prior heads' union coverage rather than to what the
kept checks are for, is a defective contract: stop and rewrite it first. A round run
on a totality claim can only gate, because the reviewer's job is to find the
counterexample the claim's own wording promises does not exist.

A plan-stage contract -- claims about a design rather than the code -- must include
the premise claim, that the plan solves the right problem, among CLAIMS; commit the
design document on the branch first, so the diff the round reviews is non-empty.

## Step 1 -- Empty guard (cheap)

Run `git diff "origin/staging...HEAD" --stat`. If it reports no changes, say there is
nothing to review and stop.

Three-dot (`origin/staging...HEAD`) means "what the current branch changed since its
merge-base with staging", i.e. PR semantics -- it ignores commits staging gained after
the branch forked. The remote-tracking ref is the base, not a local `staging`, which
goes stale and silently widens the round with work that already merged. Every agent
below uses the same ref and the same three-dot form. Only this `--stat` runs in the main
thread, so the full diff never enters this conversation's context.

Also read the rounds ledger (`scratch/review-rounds/<branch>.jsonl`) if it exists:
its first row's `cap` is the branch's round budget (a first row without `cap`
predates the field -- treat the budget as unset). When the ledger already holds
`cap` rows, stop and say the bucket's round budget is spent -- only the owner
raises it.

The ledger also sizes a role contract. From round 3 on -- the ledger already holds two
rows of any kind -- CLAIMS covers only the DELTA: a claim whose subject the last fix
touched, plus one claim per path that fix added. Re-running an unaffected claim the
ledger already records as HOLDS is forbidden: it re-buys a verdict the branch owns.
Whatever the round, cap the list at `max(5, ceil(<changed lines>/60))` claims and never
above 12, where `<changed lines>` is the insertions plus deletions in the `--stat` total
above. A contract over that ceiling is trimmed to the claims that carry the round, not
run long; say in your report which claims you dropped and why.

## Step 2 -- Run the review Workflow

Invoke the Workflow tool with `scriptPath` set to `scripts/light-review-workflow.mjs` and
`args` set to
`{"docs": [<the DOCS list, possibly empty>], "role": <the role name or null>, "claims": [<CLAIMS, or an empty list in lens mode>]}`.

The script is checked in and passed by path: do not paste its text into the call, do not
copy it out to edit it (it branches on the role in `args` itself, and both modes are
pinned by `scripts/light-review-script.test.mjs`), and do not spawn the reviewers with the
Agent tool instead -- plain agents cannot have their output format enforced, and the schema
is the point (prompt-side "return only JSON" instructions have a long failure record here).

Commit before you invoke it: this round reviews HEAD, and the clean-tree hook blocks any
Workflow call made from a dirty tree.

The script returns `{reviewerCount, simplerShapeVotes, clusters}` in lens mode and
`{claims, findings, gate, summary}` in role mode; Step 3 turns whichever came back into
the ledger row and the findings file.

## Step 3 -- Trajectory, ledger, write

Both modes end the same way: one line appended to the rounds ledger, and
`review_findings.md` written (overwrite if present) in the working directory. That exact
filename is what assess-review looks for; it hard-stops without it. Report the path you
wrote, and never delete the ledger.

Common to both:

1. `BRANCH=$(git branch --show-current)`; the rounds ledger is
   `scratch/review-rounds/<BRANCH>.jsonl` (`mkdir -p scratch/review-rounds`; scratch/ is
   gitignored). Read it if it exists; this round's number is its line count + 1, counting
   rounds of every kind. The first row written for a branch also carries `"cap"`: the
   Step 5 bucket's total round allowance for this diff (1 for the second bucket or the
   instruction-file floor, 3 for the full pipeline; a cap the owner raises is edited in
   place with a note).
2. Every ledger row carries `"kind"`: the role name in role mode, `"light"` in lens mode.
   Trajectory comparisons -- REPEAT files, hotspots, whether the contested list grew --
   run against prior rounds of the SAME kind only. A role round's claims and a lens
   round's clusters are not comparable evidence. Kind scopes trajectory only:
   the round number and the branch's round budget count rounds of every kind.
3. REPEATs and hotspots are computed on file paths. An entry whose `file` is empty names
   no file, so it is never a repeat and never a hotspot -- skip it rather than letting
   every fileless entry collide into one.
4. Every row carries `"dispositions"`: one `{"item", "disposition"}` entry per thing this
   round put on the table -- each confirmed cluster in lens mode, and each gating claim
   plus each out-of-claim finding in role mode -- where `item` is the cluster name, the
   claim text, or the finding name. You write every one as `"open"`; you are the round,
   not its triage. assess-review rewrites them in place to `fixed`, `contested`,
   `narrowed`, or `deferred` as it disposes of each, and a row still carrying `open`
   after triage is a finding nobody decided.

### Lens mode -- the Workflow returned `{reviewerCount, simplerShapeVotes, clusters}`

5. CONFIRMED = clusters with verification `confirmed`. A confirmed file that also carried
   a confirmed cluster in the PREVIOUS light round is a REPEAT; repeat files are the
   round's hotspots.
6. CONTESTED = clusters with `flaggedBy` 1, severity critical or major, and verification
   not `refuted`.
7. Append one JSON line to the ledger:
   `{"round": N, "kind": "light", "date": "<date -I>", "reviewerCount": <reviewerCount>, "clusters": [{"name", "file", "severity", "verification"}], "simplerShapeVotes": <count of simpler=true>, "dispositions": [{"item": <confirmed cluster name>, "disposition": "open"}]}`.
   A branch's first row also carries `"cap": <the round budget>` (Common item 1).
8. Write `review_findings.md`: a header line (branch, round N, kind `light`,
   `reviewerCount` reviewers), then the clusters sorted by severity (critical first) then
   flaggedBy (descending) -- one row each with issue number, name, description, severity,
   file, "flagged by N of `<reviewerCount>`", and the verification outcome with its note
   -- then a `## Trajectory` section with: the round number; confirmed-new vs
   confirmed-repeat counts; the hotspot files; the contested list; and the simpler-shape
   vote ("N of `<reviewerCount>` reviewers see a materially simpler shape", each reason on
   its own line when N > 0).

`reviewerCount` is the number of reviewers that actually returned, which is 3 only when
none was lost to schema exhaustion. Write the number the Workflow returned, never the
number you asked for.

### Role mode -- the Workflow returned `{claims, findings, gate, summary}`

5. GATING = claims whose verdict is `REFUTED` or `COULD-NOT-VERIFY`. A gating claim's
   file that also carried a gating claim in the PREVIOUS round of this same role is a
   REPEAT; repeat files are the round's hotspots.
6. The gate is claim-scoped by design: `gate` reflects the contract's verdicts and
   nothing else. The out-of-claim `findings` never move it -- they are triage material
   for assess-review, which reads them off the artifact.
7. Append one JSON line to the ledger:
   `{"round": N, "kind": "<role>", "date": "<date -I>", "gate": <gate>, "claims": [{"claim", "verdict", "file"}], "findings": [{"name", "file", "severity"}], "dispositions": [{"item": <gating claim or finding>, "disposition": "open"}]}`.
   A branch's first row also carries `"cap": <the round budget>` (Common item 1).
8. Write `review_findings.md`: a header block naming the role, the number of claims it
   was contracted to refute, and the gate outcome (`gate` true is GATED, false is CLEAR),
   then a verdict table -- one row per claim with the claim, its verdict, the evidence,
   and `file:lines` -- then a `## Findings outside the claims` section (the findings, one
   row each with name, description, severity, `file:lines`; say "none" when the list is
   empty), then a `## Trajectory` section with: the round number and kind; the gate
   outcome; the gating claims split into new vs repeat; the hotspot files; and the role's
   summary.

Each returned entry's `claim` is the contract's own text -- the Workflow paired the
role's answer back to the claim as asked. Write it verbatim into the table and the
ledger; a paraphrase makes the round untraceable to the contract it ran under.

## What you do NOT do

- Do not review the diff yourself or add your own findings.
- Do not edit, drop, or reorder the consolidator's clusters, or a role's verdicts.
- Do not soften a verdict, and do not re-verdict a role's claims yourself -- the role's
  own output is the artifact.
- Do not fix anything -- that is assess-review's job.
