# Re-attesting a review across a rebase

_Status: decided on the maintainer's ruling and built, as a fourth mechanical
re-attestation path beside the three in `.claude/commands/assess-review.md`
(Step 4). The three existing paths are unchanged, and so is the rule that a
base-sync merge takes a full round. See [docs/notes/README.md](README.md)._

## The problem

A review round attests the commit it read, and the pull-request checklist line
names that sha. A branch that then falls behind a code-moving `staging` commit
has to move: it is rebased, its head changes, and the attestation goes stale.
Under the three existing paths that head takes a full standing-contract role
round -- 150-250k tokens each -- even where the rebase changed nothing the
branch itself authored and the conflicts it resolved were markdown and comment
wording.

The question is not whether that round is thorough. It is whether it reads
anything the earlier round did not: where the branch's own change is identical
before and after the move, the round re-reads the same program and reaches the
same answer.

## What the path verifies

The branch's effective diff -- its diff against its own base -- must be
unchanged by the rebase:

- the same paths, and
- the same program at each path, at both ends of the move, once comments are
  removed and markdown is excluded.

`.claude/scripts/verify-rebase-invariance.mjs` decides it by running the
non-executable-delta comparison twice over exactly the paths the branch's diff
touches: once between the pre- and post-rebase bases, once between the two
heads. Both comparisons are needed and each catches a different way a rebase
moves the branch's diff.

| What the rebase did | Where it shows |
| --- | --- |
| The conflict resolution invented an executable line | Between the two heads |
| The staging range changed a file the branch also changed | Between the two bases, and again between the two heads |
| The staging range changed a file the branch did not touch | Neither -- that path is not compared |

The comparison itself is the sibling verifier's, not a second implementation of
it: markdown decided by its path, source by parsing each side and printing it
back with comments suppressed, YAML by materializing each side, and every other
path unverifiable, which fails the run.

## Why a rebase is admitted where a base sync is not

A rebase composes the branch with staging content no round has read, exactly as
a base-sync merge does. That argument is what keeps a base sync outside all
four paths, and the exception has to answer it rather than route around it.

The difference is that the branch's own effective diff survives a rebase as a
comparable object, and a merge's does not:

- After a rebase the branch's commits are re-authored onto the new base, so the
  branch's diff against its base exists at both ends and can be compared.
- After a base sync the attested-to-head diff holds the whole merged staging
  range, so the verifier answers for what that range touched rather than for
  the branch's change. There is nothing to compare it against.

What a round attested was the branch's change. Where that change is identical
at both ends, the round's reading of it stands, and re-reading it buys the same
answer at a round's price.

## What the path does not attest

- **The content the branch now sits on.** Paths outside the branch's own diff
  are not compared, and no verdict here is about them. This is the ground the
  exception concedes.
- **The composition, as a matter of review.** What covers it instead is
  mechanical: every gate re-runs at the new head, and a pull-request gate runs
  against the head merged with the base tip, so a composition that fails to
  build, typecheck, lint, or pass a test is caught there. Running that merge is
  `actions/checkout`'s default on a `pull_request` event, and
  `npm run check:checkout-ref-override` holds every pull-request-triggered
  workflow to it. What is left over is an interaction that compiles and passes
  every test while being wrong -- the residual risk this path accepts, and the
  reason a single executable line inside the branch's own diff sends the head
  to a full round.
- **Markdown.** Excluded, as it is under the non-executable-delta path, where a
  markdown-only delta already holds. So a conflict resolved inside a governing
  document -- a `docs/spec/` file -- is not read by this path. That is a stated
  limit rather than a verified property; excluding markdown in one path and not
  the other would have been the inconsistency, and the alternative was to make
  the cheapest possible re-attestation depend on a file class the existing path
  already waives.

## The shape check

Step 4 routes a rebase and a base sync differently, so the verifier checks
which one it has rather than trusting the caller:

- each base must be an ancestor of its own head;
- the post-rebase base must descend from the pre-rebase one;
- the attested head must NOT be an ancestor of the new head.

The last is the discriminator. A base sync leaves a merge commit whose first
parent is the attested head, so the attested head is an ancestor of it; a
rebase re-authors the branch's commits and leaves it none. A head the verifier
refuses on shape takes the rules Step 4 already states.

## Why it is a script rather than a reading

Nothing in CI can catch a false claim here. `npm run check:pr-checklist`
compares the sha on the checklist line against the pull request's head and has
no view of whether the claimed property holds, so an eyeballed "the rebase
changed nothing" lands an unreviewed head as reviewed. The property is verified
mechanically or not at all -- the same rule the non-executable-delta path
states, for the same reason.
