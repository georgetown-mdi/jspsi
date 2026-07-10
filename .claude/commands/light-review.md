---
name: light-review
description: Multi-reviewer code review of the current branch (HEAD) against staging. Runs three independent schema-forced Sonnet reviewers and a Sonnet consolidator through one Workflow, computes the round's trajectory against prior rounds, and writes review_findings.md in the working directory. Takes an optional list of documentation files the reviewers and consolidator should consult for design justification. Pure orchestration -- it does not review the code itself.
---

You are ORCHESTRATING a code review. You do not review the code yourself and you
do not explore the codebase -- you run one Workflow, compute the round's
trajectory, and write a file.

## Input

    /light-review [doc-file ...]

- `[doc-file ...]`: optional paths to documentation relevant to these changes (e.g.
  `docs/spec/FILE_SYNC.md`). These are every token in `$ARGUMENTS`; call this list DOCS.
  There may be none.

## Step 1 -- Empty guard (cheap)

Run `git diff "staging...HEAD" --stat`. If it reports no changes, say there is nothing to
review and stop.

Three-dot (`staging...HEAD`) means "what the current branch changed since its merge-base
with staging", i.e. PR semantics -- it ignores commits staging gained after the branch
forked. Every agent below uses the same three-dot form. Only this `--stat` runs in the
main thread, so the full diff never enters this conversation's context.

## Step 2 -- Run the review Workflow

Invoke the Workflow tool with `args` set to `{"docs": [<the DOCS list, possibly empty>]}`
and the script below VERBATIM -- do not paraphrase it, and do not spawn the reviewers
with the Agent tool instead: plain agents cannot have their output format enforced, and
the schema is the point (prompt-side "return only JSON" instructions have a long failure
record here).

```js
export const meta = {
  name: 'light-review',
  description: 'Three schema-forced reviewers over the branch diff, then a consolidator that clusters and verifies',
  phases: [{ title: 'Review' }, { title: 'Consolidate' }],
}

const FINDING = {
  type: 'object',
  required: ['name', 'description', 'severity', 'file'],
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
    severity: { type: 'string', enum: ['critical', 'major', 'minor', 'nit'] },
    file: { type: 'string' },
  },
}
const REVIEWER_SCHEMA = {
  type: 'object',
  required: ['findings', 'simplerShape'],
  properties: {
    findings: { type: 'array', items: FINDING },
    simplerShape: {
      type: 'object',
      required: ['simpler', 'reason'],
      properties: { simpler: { type: 'boolean' }, reason: { type: 'string' } },
    },
  },
}
const CONSOLIDATOR_SCHEMA = {
  type: 'object',
  required: ['clusters'],
  properties: {
    clusters: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'description', 'severity', 'file', 'flaggedBy', 'verification', 'verificationNote'],
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'major', 'minor', 'nit'] },
          file: { type: 'string' },
          flaggedBy: { type: 'number' },
          verification: { type: 'string', enum: ['confirmed', 'refuted', 'unverifiable'] },
          verificationNote: { type: 'string' },
        },
      },
    },
  },
}

const docsClause = args.docs && args.docs.length
  ? 'First read these docs for design context: ' + args.docs.join(', ') + '. When an issue could be a deliberate design decision, check whether these docs justify it before flagging it.\n\n'
  : ''

const reviewerPrompt = `You are a senior software engineer reviewing the current branch (HEAD) of this repository.
Generate the diff yourself with git diff "staging...HEAD" -- the three-dot form is deliberate and non-negotiable: it shows ONLY what this branch added since it forked from staging, and it excludes every commit staging gained after the fork. That diff is the complete and exclusive scope of your review. Never widen it: do not run a two-dot git diff staging HEAD, do not diff against HEAD~N, the tip of staging, or any other base.

Review the branch's own changes and nothing else. Anything attributable to staging advancing since the branch forked -- the branch's base or starting point moving, the "root" of the branch changing, upstream commits the branch has not yet absorbed -- is OUT OF SCOPE and not this branch's responsibility. Do not flag it, describe it, or even mention that the base moved; treat such material as invisible. If a hunk merely re-states upstream staging work rather than introducing new behavior authored on this branch, ignore it. Open another file only if a hunk cannot be judged without it.

${docsClause}Review for: correctness bugs, logic errors, security issues, missing error handling at system boundaries, type-safety issues, API-contract violations, documentation-tier placement (spec-level detail -- a constant value, byte/wire layout, an HKDF info string or other algorithm step, or "would only need revisiting if..." rationale -- written into a docs/ overview doc rather than docs/spec/), excess prose (a comment that restates the adjacent code, narrates change history -- "now", "previously", "was moved" -- duplicates a JSDoc, or cites a board item id; name such findings "excess prose: ..."), and anything else that looks wrong.

Do NOT flag missing comments or ask for more explanatory prose unless a genuinely non-obvious constraint is uncarried by the code, names, types, and tests -- this codebase treats prose as a last resort and a check, test, or rename as the preferred carrier.

Separately from the findings, answer the shape question: is there a materially simpler shape for this branch's change -- a different factoring, an existing mechanism it should have reused, a smaller surface? Set simpler=true ONLY if you can name the shape in one sentence (put it in reason); otherwise simpler=false with a short reason. Do not force it.`

const reviews = (await parallel([1, 2, 3].map((n) => () =>
  agent(reviewerPrompt, { label: `reviewer-${n}`, phase: 'Review', schema: REVIEWER_SCHEMA, model: 'sonnet' }),
))).filter(Boolean)

const consolidatorPrompt = `You are consolidating a code review of the current branch. ${reviews.length} independent reviewers examined git diff "staging...HEAD" (three-dot; the branch's own changes only -- never widen the diff). Their findings:
${JSON.stringify(reviews.map((r, i) => ({ reviewer: i + 1, findings: r.findings })), null, 1)}

${docsClause}In a single pass -- no sub-agents, no iteration:
1. Drop any finding that is not about the current branch's own changes (anything describing the branch's base moving, or staging's progress since the fork) -- discard it before clustering, do not even list it as refuted.
2. Cluster findings that describe the same underlying issue across reviewers; flaggedBy is the number of distinct reviewers in the cluster.
3. Verify each cluster's core claim by reading only the specific hunks or files it names -- not the whole diff -- and set verification confirmed/refuted/unverifiable with a one-line verificationNote.`

const consolidated = await agent(consolidatorPrompt, {
  label: 'consolidator', phase: 'Consolidate', schema: CONSOLIDATOR_SCHEMA, model: 'sonnet',
})

return {
  reviewerCount: reviews.length,
  simplerShapeVotes: reviews.map((r) => r.simplerShape),
  clusters: consolidated.clusters,
}
```

## Step 3 -- Trajectory, ledger, write

The Workflow returns `{reviewerCount, simplerShapeVotes, clusters}`. Compute this round's
trajectory in the main thread:

1. `BRANCH=$(git branch --show-current)`; the rounds ledger is
   `scratch/review-rounds/<BRANCH>.jsonl` (`mkdir -p scratch/review-rounds`; scratch/ is
   gitignored). Read it if it exists; this round's number is its line count + 1.
2. CONFIRMED = clusters with verification `confirmed`. A confirmed file that also carried
   a confirmed cluster in the PREVIOUS round is a REPEAT; repeat files are the round's
   hotspots.
3. CONTESTED = clusters with `flaggedBy` 1, severity critical or major, and verification
   not `refuted`.
4. Append one JSON line to the ledger:
   `{"round": N, "date": "<date -I>", "clusters": [{"name", "file", "severity", "verification"}], "simplerShapeVotes": <count of simpler=true>}`.
5. Write `review_findings.md` (overwrite if present): a header line (branch, round N,
   reviewer count), then the clusters sorted by severity (critical first) then flaggedBy
   (descending) -- one row each with issue number, name, description, severity, file,
   "flagged by N of 3", and the verification outcome with its note -- then a
   `## Trajectory` section with: the round number; confirmed-new vs confirmed-repeat
   counts; the hotspot files; the contested list; and the simpler-shape vote ("N of 3
   reviewers see a materially simpler shape", each reason on its own line when N > 0).

Report the path you wrote. assess-review consumes the Trajectory section; never delete
the ledger.

## What you do NOT do

- Do not review the diff yourself or add your own findings.
- Do not edit, drop, or reorder the consolidator's clusters.
- Do not fix anything -- that is assess-review's job.
