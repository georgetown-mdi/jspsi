---
name: assess-review
description: Triage a cold code review of one branch -- read that branch's findings file under the primary checkout, judge trajectory and step-back triggers here in the orchestrating session, dispatch the fixes to one implementer pointed at the branch's own worktree, and report what was left plus a security-review readiness call. Takes the branch as an argument and never enters its tree, so several branches can be in triage at once; pairs with light-review, which deposits the findings file.
---

You are the engineer accountable for the changes, triaging a cold code review
of them. The JUDGMENT is yours and happens here: what the round means, whether the
branch is converging, which findings get fixed, and whether it is ready. The
EDITING is not: it is dispatched to one implementer working in the branch's own
worktree.

You stay where you are. You do not `cd` into the branch's worktree, and you do not
check anything out -- reads go through `git -C <tree>` and `git show <ref>:<path>`,
and anything that must RUN goes to a spawn.

## Input

    /assess-review [<branch>]

- `<branch>`: the branch to triage. With none, it is the branch
  `git branch --show-current` reports where you are standing.

## Step 1 -- Read the findings

Run `git worktree list --porcelain` once. Its FIRST record is the primary
checkout; call that path PRIMARY. Its record whose `branch` is this branch names
that branch's worktree; call that absolute path TREE (a branch with no worktree
has none, and any fix will need one made before it can be written).

The branch's artifact key is its name with every character outside `A-Za-z0-9._-`
replaced by `_` and any leading dots dropped. light-review has already deposited
its consolidated findings at `PRIMARY/scratch/review-rounds/<key>.findings.md`.
Read it.

If that file is not there, stop and say so: light-review has not run for this
branch yet. Do not go hunting for it elsewhere, and do not read another branch's.

## Step 2 -- Assess: trajectory and brittle areas

Start with the whole, not the parts:

- **Soundness.** Comment on the overall approach and any patterns across the
  findings.
- **Trajectory.** Read the `## Trajectory` section light-review wrote into the
  findings file, and the rounds ledger at
  `PRIMARY/scratch/review-rounds/<key>.jsonl` for the rounds before it (fall back
  to reconstructing rounds from `git log staging..<branch>` review-fix commits if
  either is missing; a review lens run by a `general-purpose` spawn is
  invisible to accounting keyed on `subagent_type`, which undercounts the
  rounds a branch ran). Converging is confirmed-new falling with repeats near
  zero; churn is fixes spawning findings.
- **Kind.** Each ledger row has a `kind`: `light` for a lens round, or the
  name of the role that ran it (`security-reviewer`, `adversarial-verifier`).
  A row with no `kind` predates the field and is a `light` round. Compare a
  round only against prior rounds of the same kind -- a role round's claims and
  a lens round's clusters count different things. Same-kind scoping governs
  trajectory only: the branch's round budget is the ledger's full line count,
  every kind included, capped by the review-tier bucket (start-issue.md, Step
  5) -- a round of a new kind is not a fresh budget. In a role row, a claim whose
  verdict is `REFUTED` or `COULD-NOT-VERIFY` is a confirmed finding on its file,
  and so is an out-of-claim `finding` of severity critical or major -- the role
  round's gate ignores those by design, the trajectory does not.

On a branch whose ledger holds no prior row, skip the trajectory read:
triggers 1-3 and 7 each compare against a previous round, so with nothing
before this round check only triggers 4-6.

Then check the **step-back triggers**. If ANY fires, do NOT proceed to
fix-and-rerun: stop, and recommend a structural pivot instead -- a focused
independent assessment of the churning area (fresh agents, cold), a judge
panel of alternative shapes, or a narrowing (delete or defer the churning
surface, its limit stated in the spec) -- presented to the owner in prose with
options and a recommendation. Churn escalates to a different activity, never to
another blind whole-branch round.

1. The same file or area has confirmed findings in three consecutive rounds
   (two, for a diff under ~150 lines).
2. This round confirmed as many findings as the previous round's fixes closed,
   or more.
3. Reviewers propose contradictory remedies for the same hunk, or the contested
   list (high-severity, single-reviewer findings) grew from the previous round.
   A role round has one reviewer, so this trigger reads light rounds only.
4. Two or more reviewers voted that a materially simpler shape exists. Only a
   light round holds that vote.
5. A fix you are about to order would grow the branch's diff by roughly a third
   or more.
6. The driving board issue's **Affected areas** is in context and the diff has
   spread well beyond it.
7. A confirmed finding or gating claim lands on code a previous fix round added,
   rather than on the branch's original change, in two consecutive rounds -- the
   guard is churning, not the change, and the pivot to weigh first is narrowing.

## Step 3 -- Triage: decide here, dispatch the writing

For each finding: verify it if it merits verification (read the specific
hunks/files it names at the ref, not the whole diff), then decide.

A gated claim or confirmed review finding has four dispositions, not one:

1. **Fix it.**
2. **Contest it** by measuring the disputed behavior first-hand -- a verdict
   reached by reading alone is still open until a run decides it.
3. **Narrow the claim** to what is measured, recording the remainder as a limits
   line in the governing `docs/spec/` file, written on the branch in the same
   pass. That line is the whole of the narrow exit by default. A follow-on board
   item is the escalation above it, taken only when the remainder itself needs a
   runtime change, and no session files more than one such item autonomously --
   past that, the rest are proposals in the report for the owner to scope.
4. **Record it as a stated limit**: the finding is true, it stands, and what it
   costs is written into the round's dispositions ledger. No branch edit, no
   `docs/spec/` line, and NO BOARD ITEM -- the ledger entry is the record, and it
   is durable because the ledger is per branch and survives the round.

The last two are the cheap ones, not failures. A true finding whose fix would
grow the guarded surface is usually best narrowed, and one that costs nothing a
user or partner can reach is usually best stated.

**Stated limit is the DEFAULT** for a confirmed finding that changes no runtime
behavior on a user- or partner-reachable surface: an internal naming preference,
a test-only ergonomic, a support-script nicety, a shape a reviewer would write
differently. Reach past it -- to a fix, or to any sink that costs a board item --
only for a finding that reaches such a surface, or one you can say in a line why
the branch is worse for leaving. Absent that line, state it and move on.

- **Default to fixing.** You do not need permission to fix something small and
  clearly right.
- **Contest by measurement before fixing for it.** A finding or refuted claim
  about an external tool's behavior that rests on reading rather than running
  is still open: reproduce the claimed behavior against the real tool first.
  The run happens in the branch's tree, so it is a spawn's to make, not yours --
  give the spawn the exact command and have it report the outcome. A first-hand
  run that contradicts the finding closes it (record the command and outcome in
  Step 4); one that confirms it makes the fix a measured one.
- **A gated role round's disposition can take a consult.** Choosing among fix,
  contest, narrow, and stated limit on a gated `security-reviewer` or
  `adversarial-verifier` round is the adjudication CLAUDE.md's model-tier rule
  reserves Fable for -- a one-shot, owner-approved consult on the choice, never
  a Fable fix round.
- **A fix that adds behavior gets a test.** When a fix introduces new branching
  or a new code path (error handling, a guard, a fallback), the brief orders its
  guarantees pinned with a test in the same pass. No later round re-reviews a
  fix: another round exists only for the step-back triggers.
- **A pattern in the findings gets a class sweep.** When several findings share
  one mechanism (a port dropping behavior its original had, a rename
  missing sites, a repeated idiom misused), the brief orders one focused pass
  over that class across the whole branch -- a review round samples; the sweep
  completes.
- **Prose findings get a high bar.** Order a fix for a finding that asks for a
  comment, JSDoc, or doc paragraph only when the missing constraint is
  unrecoverable from the code, names, types, and tests AND its absence enables a
  concrete wrong edit you can name -- and prefer encoding it as a check, a test,
  or a more explicit name over prose. Reviews here have a measured many-to-one
  bias toward adding prose; do not ratchet. The same bar applies to prose you
  are tempted to add defensively while triaging: pre-empting a re-raise is not a
  reason.
- **Autonomy boundary.** Decide implementation details yourself. STOP and ask the
  owner or PM before a fix that reaches beyond this change: public API / CLI /
  config-schema, protocol or wire format, security-relevant behavior, a
  dependency, a shared convention, or the branch's scope. Ask in prose with the
  options and a recommendation; do NOT use the question tool.
- **Leave it** only when it is truly out of scope for this branch, not worth
  the change, or best taken as a limit per the four dispositions above
  -- narrowed, where the brief writes the limits line into the governing
  `docs/spec/` file in the same pass, or stated, where the ledger entry is the
  whole record. Do NOT file a board issue for anything -- no automated filings;
  an unaddressed finding is recorded in the ledger and in Step 4, not on the
  board, and a follow-on is filed only on the owner's word.

### Dispatching the fixes

Everything you decided to fix goes into ONE fix brief for this branch, run by
ONE `implementer` spawn -- one per branch, never one per finding, and never an
edit you make yourself: you are not in the branch's tree, and the fix that lands
there is the one the brief describes.

- Write the brief to a file under `PRIMARY/scratch/` and hand the spawn its path,
  not its text: a pasted brief is re-billed on every call the spawn makes.
- When the branch has no worktree, make one before dispatching: from the primary
  checkout, `git worktree add .claude/worktrees/<key> <branch>`. The brief then
  tells the implementer to run `bash .claude/scripts/worktree-init.sh` from that
  tree before its first edit, which is what provisions it.
- Name the tree by ABSOLUTE PATH -- "the branch's worktree at `<TREE>`". Do not
  write "your worktree" or "this worktree": those are treated as a claim of harness
  isolation, and `require-declared-worktree-isolation.mjs` blocks a spawn that
  makes one without the flag. The spawn is NOT worktree-isolated; the branch's
  tree already exists and is where its work belongs.
- Direct EVERY command in the brief to that path explicitly -- `cd <TREE> &&
  <command>` or `git -C <TREE> <command>`, once per command. A subagent's Bash
  working directory reverts between calls, so a single leading `cd` does not
  stick and the commands after it run in the wrong tree.
- **Direct the implementer's scratch to `/tmp`.** Every fix brief tells the
  implementer that its own scratch -- measurement files, repro probes, one-off
  scripts, build-output experiments -- goes to `/tmp`, never inside the branch
  worktree: an untracked leftover there blocks
  `require-clean-tree-for-review.mjs` on the branch's next round.
- **A small fix travels as its exact edit.** For a fix under roughly 20 lines,
  the brief contains the edit itself -- the file, the old text, the new text, and
  the test to run -- and the spawn is a `sonnet` implementer applying it. Writing
  the edit out is the cheap path: the reading and the judgment already happened
  here, and re-deriving them is what a full spawn would charge for. Dispatching
  it rather than making it inline buys something else on a security surface: the
  fresh hands keep reviewer independence intact.
- **A larger fix travels as a task.** Above that, the brief states the findings,
  the constraint, and the verification, and the spawn is a full `opus`
  implementer. A branch mixing both sizes takes one `opus` spawn with the small
  edits written out inside the same brief.
- The brief ends by ordering the verification and the commit: build core
  (`npm run build -w packages/core`) if the fix touched it, then `npm run
  typecheck && npm run lint`, then the tests covering what changed, then a commit
  to the branch -- never staging or main -- following CONTRIBUTING.md's commit
  conventions (no markdown, no top-level lists, no self-attribution). Report what
  the spawn ran and what it reported.

Then record what you decided. The round's row in
`PRIMARY/scratch/review-rounds/<key>.jsonl` contains a `dispositions` entry per
confirmed cluster, gating claim, and out-of-claim finding, each written `open`
by the round that raised it. Rewrite each in place to the disposition you took:
`fixed`, `contested` (the disputed behavior was measured first-hand and did not
hold), `narrowed` (the limits line is on the branch), `limit` (accepted as it
stands, no board item), or `deferred` (it has a row in Step 4's table). A `limit`
entry has a `note` beside it -- one phrase saying what the branch is living
with -- because the entry is the whole record of that finding and an unannotated
one is treated as an entry nobody wrote down. An entry left `open` says nobody decided
that finding, so leave none behind -- and a round whose entries are all still
`open` is a round that was read and not triaged.

## Step 4 -- Report what you left, and readiness

**Left unaddressed.** A compact table, one row per actionable finding you did not
fix (omit the table entirely if there are none). One phrase per cell -- this is
the part you will re-read later, so keep it scannable:

| Finding | Why not fixed | Severity | Will it resurface? |

-- what the finding is, why you left it, how big it actually is, and whether it
is latent and likely to come back to bite.

**Security-review readiness.** One line: ready, or not yet and what is gating it.
The branch is ready when the diff has stabilized (trajectory converging, not
churning), no unaddressed finding touches a security-relevant surface (one
narrowed, or recorded as a stated limit, stops gating readiness once the owner
ratifies that disposition), brittle areas are shored up or independently
assessed, and typecheck/lint/tests are green. When it is ready, say so.

**Re-attestation.** A fix committed here moves the head, so a Security review
line already attesting an earlier sha goes stale. The mechanical paths below are
the DEFAULT here, not the fallback: batch the round's open findings into one fix
pass, run the verifier
(`node .claude/scripts/verify-nonexecutable-delta.mjs <attested-sha> <head-sha>`,
or `verify-rebase-invariance.mjs` where the head moved by a rebase)
before scheduling anything, and re-attest once for the batch rather than once per
finding. The verdict is about the git worktree the command runs in, which the run
names in its output -- the primary checkout when the flow's own invocation calls
the script there by path, while the branch sits in its own worktree. Both shas
resolve the same from either, since linked worktrees share one object database,
so name them in full: a per-worktree ref (`HEAD`, `HEAD~n`, `ORIG_HEAD`) means a
different commit in each tree. A fresh full round is what the verifier's answer
buys -- it runs when the verifier reports an executable delta that the narrowing
path does not cover, never as the reflex the act of fixing triggers.

Each path is recorded on the checklist line naming both shas:

- **An n/a line.** Re-run the security-scope enumeration against the new head's
  diff -- a scan, not a review round.
- **Narrowing.** A head whose diff against the attested sha only deletes guarded
  surface or strictly narrows it -- no new or changed enforcement, no new input
  reached -- is re-attested by verifying exactly that property of the diff,
  recorded as a narrowing verification. Anything added or changed voids this
  path and takes a full round.
- **No executable delta.** A head whose diff against the attested sha changes no
  executable line -- comments and markdown only -- is likewise re-attested by
  verifying exactly that property, recorded as a non-executable-delta
  verification. That property is verified mechanically or not at all, and a
  reading of the diff is never the verification: every changed source file must
  be identical at the two shas once comments are removed, compared by parsing
  each to a source file and printing it back with comments suppressed. The
  checked-in verifier does exactly that, and fails closed on any changed path it
  cannot parse. Both cheaper primitives are measured wrong and neither is to be
  reached for again -- the compiler's emit erases types along with comments, so
  a type-only edit compares identical under it, and a raw scanner has no parser
  context, so a backtick inside a comment puts it in template state and it
  reports comment-only edits as changes. A single executable line voids this
  path and takes a full round, as does a delta that only a reviewer could judge
  harmless.
- **A rebase that left the branch's own diff alone.** A head the branch was
  REBASED to -- its commits re-authored onto a later origin/staging, which
  leaves the attested head no ancestor of the new one -- is re-attested by
  verifying that the move changed nothing the branch itself authored: the
  branch's diff against its base holds the same paths, and each holds the same
  program at both ends, once comments are removed and markdown is excluded.
  Verified mechanically or not at all, by `node
  .claude/scripts/verify-rebase-invariance.mjs <pre-rebase-base>
  <pre-rebase-head> <post-rebase-base> <post-rebase-head>`, which runs the
  comparison above twice over exactly those paths -- once between the two bases,
  once between the two heads -- and fails closed on a path it cannot read.
  Recorded as a rebase-invariance verification naming both heads. An executable
  line a conflict resolution invented, a staging range that changed a file the
  branch also changed, and a path the comparison cannot read each void it and
  take a full round; so does a head of any other shape, which the verifier
  refuses rather than answering about.

That fourth path composes the branch with staging content no round has read,
which is the same objection that keeps a base sync out, and it answers it rather
than routing around it: a rebase leaves the branch's own effective diff as an
object that can be compared across the move, and a merge does not. Where that
diff is identical at both ends, the round that read it still stands. What the
path does not attest is the content the branch now sits on -- paths outside its
own diff are not compared -- and what covers that is mechanical rather than
read: the gates re-run at the new head, and a pull-request gate runs against the
head merged with the base tip, so a composition that fails to build, typecheck,
lint, or test is caught there. The residual is an interaction that compiles and
passes, which is why a single executable line inside the branch's own diff sends
the head to a full round. The whole argument, the markdown exclusion it inherits
and the `docs/spec/` conflict that exclusion leaves unread:
[`docs/notes/rebase-reattestation.md`](../../docs/notes/rebase-reattestation.md).

A head moved by a BASE SYNC -- a merge commit whose first parent is the attested
sha and whose second parent is on origin/staging -- is outside all four paths.
The attested-to-head diff contains the whole merged staging range, so the verifier
answers for what that range touched rather than for the merge, and a conflict
resolution is branch-authored change no round has read. What it reports across
one is measured rather than asserted here:
`.claude/scripts/verify-nonexecutable-delta.test.mjs` builds real base-sync
merges and pins each verdict -- a staging range that moved code VIOLATES, so does
a line a conflict resolution invents over a range that did not, and a range that
is itself only comments and markdown HOLDS. That last verdict says only that the
merged range happened to be quiet, so the route does not branch on it: a base
sync takes a round whatever the verifier reports. Re-run the branch's standing
refutation contract in full at the merge head
(`/light-review --role <role> --claims <file> --target <branch>`). The standing
contract is the union of the claims the branch's role rounds have run -- each
ledger row records its claims verbatim, so the union survives a lost claims
file -- and never the last row's delta subset.
No verdict applies across the merge -- a claim's truth is not a function of
its recorded subject file, the ledger does not record the file set a claim
ranges over, and the merge composes the branch with content no round has read --
while re-verifying a claim that held costs little inside the one round that must
run anyway. The round reads the effective diff at the merge head, so the
resolution delta is inside what it reads. It counts against the branch's round
budget like any other round; a spent cap is the owner's to raise, noted in the
ledger. The checklist line then attests the merge head citing that round. An n/a
line keeps its own path above -- the enumeration re-runs against the merged
head's diff the same way -- and a head moved by anything other than that merge
shape is not a base sync: a rebase takes the fourth path above, and any other
shape takes the rules as already written.

## Step 5 -- Clean up

Delete `PRIMARY/scratch/review-rounds/<key>.findings.md`. Leave the rest of
`PRIMARY/scratch/review-rounds/` in place -- it is the cross-round trajectory
ledger, and it is keyed per branch so another branch's triage is untouched.
