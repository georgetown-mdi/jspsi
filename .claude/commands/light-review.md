---
name: light-review
description: Code review of one or more target refs against staging, one Workflow per ref. Default lens mode runs three independent schema-forced Sonnet reviewers and a Sonnet consolidator. Role mode (--role security-reviewer|adversarial-verifier --claims <file>) runs one schema-forced Opus role reviewer against a named list of claims to refute. Either mode computes each round's trajectory against prior rounds of its kind and writes branch-keyed artifacts under the primary checkout's scratch/review-rounds/. Takes an optional list of documentation files every agent it spawns should consult for design justification. Pure orchestration -- it does not review the code itself, and it never enters a branch's worktree.
---

You are ORCHESTRATING a code review. You do not review the code yourself and you
do not explore the codebase -- you run one Workflow per target ref, compute each
round's trajectory, and write the artifacts.

You stay where you are. Every step below works by ref and by absolute path: do
not `cd` into a branch's worktree, and do not check anything out.

## Input

    /light-review [--target <ref> ...] [--role <name> --claims <path>] [doc-file ...]

- `--target <ref>`: optional and repeatable. The ref to review, once per ref.
  With none, the target is the branch `HEAD` resolves to where you are standing,
  and the round is the plain single-branch one. Call this list TARGETS.
- `--role <name>`: optional. `security-reviewer` or `adversarial-verifier`, and nothing
  else -- stop if the name is anything else. Selects ROLE mode; without it you are in
  LENS mode.
- `--claims <path>`: the refutation contract for role mode, one claim per line.
- `[doc-file ...]`: optional paths to documentation relevant to these changes (e.g.
  `docs/spec/FILE_SYNC.md`). These are the remaining tokens in `$ARGUMENTS` after the
  flags above; call this list DOCS. There may be none.

A role round's claims are one contract, so `--role` takes exactly one `--target`.
Several targets under one role invocation is a mis-invocation: stop and say so.

## The refutation contract

Role mode requires the contract. If `--role` is given and `--claims` is missing, its
file is unreadable, or it yields no claims, stop and say the round belongs to the plain
`/light-review` lens form or a lens-scoped `general-purpose` reviewer. The requirement
is CLAUDE.md's, not this command's: quote its refutation-contract bullet in Agent
conventions as the reason -- these two roles run only under a named list of claims to
refute -- rather than presenting the stop as a rule of your own.

Role mode also requires adversary-reachable surface in the branch diff: production code
handling remote, partner, or browser-delivered input, key material, or a protocol
invariant. A diff that is test-only, docs-only, or support-script-only takes the lens
round only, whatever its size.

Read the claims file in the main thread: every non-empty line is one claim, trimmed,
with a leading list marker (`- `, `* `, `1. `) stripped. Call this list CLAIMS.

Hold each claim to the contract-language rules before running the round. A claim states
a measured bound, never totality: "no bypass among the following measured deliveries",
with the remainder a stated limit. After a deliberate narrowing of a control, a
no-regression claim covers what the kept checks are for, never the union of everything
any prior head caught. A claim that breaks
either rule ("cannot be bypassed", "no way to", "genuinely binds", or a post-narrowing
claim scoped to prior heads' union coverage) is a defective contract: stop and rewrite
it first. A round run on a totality claim can only gate. A claim
names WHICH fixed message, error class, or UI state results only when that message or
state was measured to exist on `origin/staging` first; otherwise it states the property
(refuses, does not throw, renders without crashing) and leaves the resulting surface to
the reviewer's measurement. A claim naming an unmeasured message is a defective
contract of the same kind as a totality claim -- three of six refutations in the
2026-09-02 review program were of this kind, each costing a role round -- so stop and
rewrite it.

A plan-stage contract -- claims about a design rather than the code -- must include
the assumption claim, that the plan solves the right problem, among CLAIMS; commit the
design document on the branch first, so the diff the round reviews is non-empty.

## Step 1 -- Locate the targets and their trees (cheap)

Run `git worktree list --porcelain` once. Its FIRST record is the primary
checkout; call that path PRIMARY. Every artifact this command writes lives under
`PRIMARY/scratch/review-rounds/`, whatever directory you are standing in -- a
branch reviewed twice from different directories must accumulate both rounds in
one ledger, or its trajectory and its round cap silently reset.

For each entry of TARGETS (or, with none given, for the one branch
`git branch --show-current` reports):

1. BRANCH is the ref with any `refs/heads/` prefix stripped. Its artifact key is
   BRANCH with every character outside `A-Za-z0-9._-` replaced by `_` and any
   leading dots dropped -- branch names contain no `/` by repo convention, so the
   key is normally BRANCH itself.
2. TREE is the `worktree` path of the record whose `branch` is that ref, or none
   when no record holds it. A ref with no tree is reviewable by a lens round,
   which only reads; a role round that must RUN code against it has nowhere to
   run, so say so and stop rather than checking anything out.
3. Run `git diff "origin/staging...<ref>" --stat`. If it reports no changes, say
   there is nothing to review on that ref and drop it from the round.

Three-dot (`origin/staging...<ref>`) means "what that ref changed since its merge-base
with staging", i.e. PR semantics -- it ignores commits staging gained after the branch
forked. The remote-tracking ref is the base, not a local `staging`, which goes stale and
silently widens the round with work that already merged. Every agent below uses the same
ref and the same three-dot form. Only these `--stat` runs happen in the main thread, so
no full diff enters this conversation's context.

Also read each target's rounds ledger (`PRIMARY/scratch/review-rounds/<key>.jsonl`)
if it exists: its first row's `cap` is that branch's round budget (a first row
without `cap` predates the field -- treat the budget as unset). When a ledger already
holds `cap` rows, drop that target and say its round budget is spent -- only the owner
raises it.

The ledger also sizes a role contract. From round 3 on -- the ledger already holds two
rows of any kind -- CLAIMS covers only the DELTA: a claim whose subject the last fix
touched, plus one claim per path that fix added. Re-running an unaffected claim the
ledger already records as HOLDS is forbidden.
A base sync -- the merge shape assess-review.md's Step 4 defines, a merge of
origin/staging into the branch -- is not a fix: the branch owns no verdict at the
merged head, so the delta rule does not apply. The contract is the branch's standing
contract in full (the union of the claims its role rounds have run, recorded verbatim
in the ledger's rows), every claim re-run at the merge head; re-running its HOLDS
claims is required there rather than forbidden.
Whatever the round, cap the list at `max(5, ceil(<changed lines>/60))` claims and never
above 12, where `<changed lines>` is the insertions plus deletions in that target's
`--stat` total above. A contract over that ceiling is trimmed to the claims most
important to the round, not run long; say in your report which claims you dropped and why.

## Step 2 -- Run one review Workflow per target

Invoke the Workflow tool ONCE PER SURVIVING TARGET, all of them in a single
message so they run concurrently. Each call sets `scriptPath` to the ABSOLUTE
path `<PRIMARY>/.claude/scripts/light-review-workflow.mjs`, with PRIMARY from Step 1 --
the bare relative `.claude/scripts/light-review-workflow.mjs` fails the call with
"script file not found" -- and `args` to
`{"targetRef": "<ref>", "worktreePath": <TREE, or null when no tree holds the ref>, "docs": [<the DOCS list, possibly empty>], "role": <the role name or null>, "claims": [<CLAIMS, or an empty list in lens mode>]}`.

One call reviews one ref. There is no batched multi-ref call to build: the fan-out
is several Workflow calls, which is the only shape available -- a subagent cannot
invoke Workflow at all, so the calls are yours to make from this thread.

The script is checked in and passed by path: do not paste its text into the call, do not
copy it out to edit it (it branches on the role in `args` itself, and both modes are
pinned by `.claude/scripts/light-review-script.test.mjs`), and do not spawn the reviewers with the
Agent tool instead -- plain agents cannot have their output format enforced, and the schema
is the point; a prompt-side "return only JSON" instruction does not hold here.

Each target must be committed before you invoke it: the round reviews the ref, and
`require-clean-tree-for-review.mjs` blocks the call when the tree holding any target
is dirty -- and when a round against that same branch is already in flight, which is
the lock Step 3 releases.

The script returns `{reviewerCount, simplerShapeVotes, clusters}` in lens mode and
`{claims, findings, gate, summary}` in role mode; Step 3 turns whichever came back into
that target's ledger row and findings file.

## Step 3 -- Trajectory, ledger, write

Do this once per target that ran, keyed on that target's BRANCH. Both modes end the
same way: one line appended to that branch's rounds ledger, and its findings file
written (overwrite if present). Report the paths you wrote, and never delete a ledger.

Common to both:

1. The rounds ledger is `PRIMARY/scratch/review-rounds/<key>.jsonl` and the findings
   file is `PRIMARY/scratch/review-rounds/<key>.findings.md`, with `<key>` from Step
   1 (`mkdir -p` the directory; scratch/ is gitignored). That exact findings path is
   what assess-review looks for; it hard-stops without it. Read the ledger if it
   exists; this round's number is its line count + 1, counting rounds of every kind.
   The first row written for a branch also contains `"cap"`: the Step 5 bucket's total
   round allowance for this diff (1 for the second bucket or the instruction-file
   floor, 3 for the full pipeline; a cap the owner raises is edited in place with a
   note).
2. Delete `PRIMARY/scratch/review-rounds/<key>.lock`, the in-flight round lock the
   clean-tree gate wrote when it let this round start. A lock left behind refuses the
   branch's next round until it ages out, so releasing it is part of booking the
   round, not cleanup you may skip. Delete it even when the round failed or you are
   abandoning its result.
3. Every ledger row contains `"kind"`: the role name in role mode, `"light"` in lens mode.
   Trajectory comparisons -- REPEAT files, hotspots, whether the contested list grew --
   run against prior rounds of the SAME kind only. A role round's claims and a lens
   round's clusters are not comparable evidence. Kind scopes trajectory only:
   the round number and the branch's round budget count rounds of every kind.
4. REPEATs and hotspots are computed on file paths. An entry whose `file` is empty names
   no file, so it is never a repeat and never a hotspot -- skip it rather than letting
   every fileless entry collide into one.
5. Every row contains `"dispositions"`: one `{"item", "disposition"}` entry per thing this
   round put on the table -- each confirmed cluster in lens mode, and each gating claim
   plus each out-of-claim finding in role mode -- where `item` is the cluster name, the
   claim text, or the finding name. You write every one as `"open"` and triage none of
   them; assess-review rewrites them in place to `fixed`, `contested`, `narrowed`,
   `limit`, or `deferred` as it disposes of each, and a row still holding `open` after
   triage is a finding nobody decided.

### Lens mode -- the Workflow returned `{reviewerCount, simplerShapeVotes, clusters}`

6. CONFIRMED = clusters with verification `confirmed`. A confirmed file that also held
   a confirmed cluster in the PREVIOUS light round is a REPEAT; repeat files are the
   round's hotspots.
7. CONTESTED = clusters with `flaggedBy` 1, severity critical or major, and verification
   not `refuted`.
8. Append one JSON line to the ledger:
   `{"round": N, "kind": "light", "date": "<date -I>", "ref": "<the target ref>", "reviewerCount": <reviewerCount>, "clusters": [{"name", "file", "severity", "verification"}], "simplerShapeVotes": <count of simpler=true>, "dispositions": [{"item": <confirmed cluster name>, "disposition": "open"}]}`.
   A branch's first row also contains `"cap": <the round budget>` (Common item 1).
9. Write the findings file: a header line (branch, target ref, round N, kind `light`,
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

6. GATING = claims whose verdict is `REFUTED` or `COULD-NOT-VERIFY`. A gating claim's
   file that also held a gating claim in the PREVIOUS round of this same role is a
   REPEAT; repeat files are the round's hotspots.
7. The gate is claim-scoped by design: `gate` reflects the contract's verdicts and
   nothing else. The out-of-claim `findings` never move it -- they are triage material
   for assess-review, which reads them off the artifact.
8. Append one JSON line to the ledger:
   `{"round": N, "kind": "<role>", "date": "<date -I>", "ref": "<the target ref>", "gate": <gate>, "claims": [{"claim", "verdict", "file"}], "findings": [{"name", "file", "severity"}], "dispositions": [{"item": <gating claim or finding>, "disposition": "open"}]}`.
   A branch's first row also contains `"cap": <the round budget>` (Common item 1).
9. Write the findings file: a header block naming the branch, the target ref, the role,
   the number of claims it was contracted to refute, and the gate outcome (`gate` true
   is GATED, false is CLEAR), then a verdict table -- one row per claim with the claim,
   its verdict, the evidence, and `file:lines` -- then a `## Findings outside the claims`
   section (the findings, one row each with name, description, severity, `file:lines`;
   say "none" when the list is empty), then a `## Trajectory` section with: the round
   number and kind; the gate outcome; the gating claims split into new vs repeat; the
   hotspot files; and the role's summary.

Each returned entry's `claim` is the contract's own text -- the Workflow paired the
role's answer back to the claim as asked. Write it verbatim into the table and the
ledger; a paraphrase makes the round untraceable to the contract it ran under. An entry
also holding `echoInexact` came back with a truncated or re-wrapped echo of its claim,
over which the Workflow restored the contract's text -- write that restored text like
any other. An echo that instead extends the claim with added text is not restored: it
verified a different, more specific assertion, so the Workflow leaves it unpaired and
the round fails rather than attaching its verdict to the contract claim.

## Authoring a Workflow schema

This command's own scripts are checked in and never edited here, but they are
the repo's reference Workflows, so the schema rules for a long-form agent live
here: put the required list property first; instruct "populate every property;
empty array when none"; and set no `maxLength` on free text -- the validator
counts characters, the model cannot, so retries never converge; ask for brevity
in the property's description instead.

## What you do NOT do

- Do not enter a target's worktree, check a ref out, or change your working directory.
- Do not review the diff yourself or add your own findings.
- Do not edit, drop, or reorder the consolidator's clusters, or a role's verdicts.
- Do not soften a verdict, and do not re-verdict a role's claims yourself -- the role's
  own output is the artifact.
- Do not fix anything -- that is assess-review's job.
