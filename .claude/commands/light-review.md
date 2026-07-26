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

## Step 2 -- Run the review Workflow

Invoke the Workflow tool with `args` set to
`{"docs": [<the DOCS list, possibly empty>], "role": <the role name or null>, "claims": [<CLAIMS, or an empty list in lens mode>]}`
and the script below VERBATIM -- do not paraphrase it, do not edit it to pick a branch
(the script branches on `args.role` itself), and do not spawn the reviewers with the
Agent tool instead: plain agents cannot have their output format enforced, and the schema
is the point (prompt-side "return only JSON" instructions have a long failure record
here).

Commit before you invoke it: this round reviews HEAD, and the clean-tree hook blocks any
Workflow call made from a dirty tree.

```js
export const meta = {
  name: 'light-review',
  description: 'One review round over the branch diff: three schema-forced lens reviewers plus a consolidator, or one schema-forced role reviewer under a refutation contract',
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
const ROLE_SCHEMA = {
  type: 'object',
  required: ['claims', 'findings', 'summary'],
  properties: {
    claims: {
      type: 'array',
      description: 'One entry per claim you were given, no more and no fewer. Populate every property; empty array when none.',
      items: {
        type: 'object',
        required: ['claim', 'verdict', 'evidence', 'file', 'lines'],
        properties: {
          claim: { type: 'string', description: 'The claim exactly as it was given to you, copied verbatim.' },
          verdict: { type: 'string', enum: ['HOLDS', 'REFUTED', 'COULD-NOT-VERIFY'] },
          evidence: { type: 'string', description: 'What you read or ran and what it showed. Compact prose, a sentence or two.' },
          file: { type: 'string', description: 'Path the evidence sits in; empty string when the verdict rests on no single file.' },
          lines: { type: 'string', description: 'Line or range in that file, e.g. 42 or 42-58; empty string when none applies.' },
        },
      },
    },
    findings: {
      type: 'array',
      description: 'Problems you found outside the claims. Populate every property; empty array when none.',
      items: {
        type: 'object',
        required: ['name', 'description', 'severity', 'file', 'lines'],
        properties: {
          name: { type: 'string', description: 'Short label for the problem.' },
          description: { type: 'string', description: 'What is wrong and why it matters. Compact prose.' },
          severity: { type: 'string', enum: ['critical', 'major', 'minor', 'nit'] },
          file: { type: 'string' },
          lines: { type: 'string', description: 'Line or range in that file; empty string when none applies.' },
        },
      },
    },
    summary: { type: 'string', description: 'The round in a few compact sentences.' },
  },
}

const docsClause = args.docs && args.docs.length
  ? 'First read these docs for design context: ' + args.docs.join(', ') + '. When an issue could be a deliberate design decision, check whether these docs justify it before flagging it.\n\n'
  : ''

const diffScope = `Generate the diff yourself with git diff "origin/staging...HEAD" -- the ref and the three-dot form are both deliberate and non-negotiable: it shows ONLY what this branch added since it forked from staging, and it excludes every commit staging gained after the fork. That diff is the complete and exclusive scope of your review. Never widen it: do not run a two-dot git diff origin/staging HEAD, do not substitute a local staging ref (it goes stale and drags in merged work), do not diff against HEAD~N, the tip of staging, or any other base.

Review the branch's own changes and nothing else. Anything attributable to staging advancing since the branch forked -- the branch's base or starting point moving, the "root" of the branch changing, upstream commits the branch has not yet absorbed -- is OUT OF SCOPE and not this branch's responsibility. Do not flag it, describe it, or even mention that the base moved; treat such material as invisible. If a hunk merely re-states upstream staging work rather than introducing new behavior authored on this branch, ignore it. Open another file only if a hunk cannot be judged without it.`

const salvage = (who) => `${who} returned no structured result -- the structured-output retries were exhausted. The analysis usually survives in the rejected attempts: read subagents/workflows/<runId>/agent-<id>.jsonl for this run and salvage it before re-running the round.`

// Presence, not truthiness: a role of "" is a mis-invocation for the allowlist below to
// reject, not a lens round that silently drops the claims it was handed.
if (args.role !== undefined && args.role !== null) {
  // The contract is matched on this form, so a list marker the caller left on a line and
  // an enumeration the model echoed back both pair with the claim as written. A marker
  // with nothing after it strips to empty, so a blank bullet cannot pass as a claim.
  const normalizeClaim = (claim) => claim.trim().replace(/^([-*+]|\d+[.)])(\s+|$)/, '').trim()
  const ROLES = ['security-reviewer', 'adversarial-verifier']
  if (!ROLES.includes(args.role)) {
    throw new Error(`role must be ${ROLES.join(' or ')}, not "${args.role}"; no other agent runs under a refutation contract.`)
  }
  if (!Array.isArray(args.claims) || args.claims.length === 0) {
    throw new Error('a role round needs a non-empty claims array: with nothing to refute it would return a CLEAR artifact for a round that tested nothing.')
  }
  const claims = []
  for (const raw of args.claims) {
    if (typeof raw !== 'string' || normalizeClaim(raw).length === 0) {
      throw new Error(`every claim must be a non-empty string with text beyond a list marker; got ${JSON.stringify(raw)}.`)
    }
    const claim = normalizeClaim(raw)
    if (!claims.includes(claim)) claims.push(claim)
  }

  const rolePrompt = `You are reviewing the current branch (HEAD) of this repository under a refutation contract.
${diffScope}

${docsClause}Your contract is the named list of claims below. Take each one as something to REFUTE, not to confirm, and run the evidence yourself rather than taking the claim's own justification on faith. Return exactly one entry per claim, with the claim text copied verbatim so the caller can pair it back up, and a verdict of HOLDS, REFUTED, or COULD-NOT-VERIFY. COULD-NOT-VERIFY is not a pass: an unverifiable claim gates the round exactly as a refuted one does, and uncertainty defaults to refuted.

The claims:
${claims.map((claim, i) => `${i + 1}. ${claim}`).join('\n')}

Anything else you find in this diff that is worth the caller knowing goes in findings, separate from the claims -- do not stretch a claim to cover it, and do not invent a claim you were not given.`

  const result = await agent(rolePrompt, {
    label: args.role, phase: 'Review', agentType: args.role, schema: ROLE_SCHEMA, model: 'opus',
  })
  if (!result) throw new Error(salvage(args.role))

  const answered = result.claims.map((entry) => normalizeClaim(String(entry.claim ?? '')))
  const unpairable = (detail) => new Error(`${args.role} ${detail}\nIts verdicts in full, so the completed analysis is not lost with the round:\n${JSON.stringify(result.claims, null, 1)}`)
  const paired = []
  for (const claim of claims) {
    const matches = result.claims.filter((entry, i) => answered[i] === claim)
    if (matches.length !== 1) {
      throw unpairable(`returned ${matches.length} verdicts for the claim "${claim}"; the contract needs exactly one per claim.`)
    }
    paired.push({ ...matches[0], claim })
  }
  for (const claim of answered) {
    if (!claims.includes(claim)) {
      throw unpairable(`returned a verdict for "${claim}", which is not one of the claims it was given.`)
    }
  }

  return {
    claims: paired,
    findings: result.findings,
    gate: paired.some((entry) => entry.verdict !== 'HOLDS'),
    summary: result.summary,
  }
}

if (args.claims !== undefined && args.claims !== null && !(Array.isArray(args.claims) && args.claims.length === 0)) {
  throw new Error('claims were passed without a role: a lens round has no refutation contract to run them under, so it would drop them and review nothing they name. Pass --role security-reviewer or --role adversarial-verifier, or drop the claims.')
}

const reviewerPrompt = `You are a senior software engineer reviewing the current branch (HEAD) of this repository.
${diffScope}

${docsClause}Review for: correctness bugs, logic errors, security issues, missing error handling at system boundaries, type-safety issues, API-contract violations, documentation-tier placement (spec-level detail -- a constant value, byte/wire layout, an HKDF info string or other algorithm step, or "would only need revisiting if..." rationale -- written into a docs/ overview doc rather than docs/spec/), excess prose (a comment that restates the adjacent code, narrates change history -- "now", "previously", "was moved" -- duplicates a JSDoc, or cites a board item id; name such findings "excess prose: ..."), and anything else that looks wrong.

Do NOT flag missing comments or ask for more explanatory prose unless a genuinely non-obvious constraint is uncarried by the code, names, types, and tests -- this codebase treats prose as a last resort and a check, test, or rename as the preferred carrier.

Separately from the findings, answer the shape question: is there a materially simpler shape for this branch's change -- a different factoring, an existing mechanism it should have reused, a smaller surface? Set simpler=true ONLY if you can name the shape in one sentence (put it in reason); otherwise simpler=false with a short reason. Do not force it.`

const reviews = (await parallel([1, 2, 3].map((n) => () =>
  agent(reviewerPrompt, { label: `reviewer-${n}`, phase: 'Review', schema: REVIEWER_SCHEMA, model: 'sonnet' }),
))).filter(Boolean)
if (reviews.length === 0) throw new Error(salvage('Every lens reviewer'))

const consolidatorPrompt = `You are consolidating a code review of the current branch. ${reviews.length} independent reviewers examined git diff "origin/staging...HEAD" (three-dot; the branch's own changes only -- never widen the diff). Their findings:
${JSON.stringify(reviews.map((r, i) => ({ reviewer: i + 1, findings: r.findings })), null, 1)}

${docsClause}In a single pass -- no sub-agents, no iteration:
1. Drop any finding that is not about the current branch's own changes (anything describing the branch's base moving, or staging's progress since the fork) -- discard it before clustering, do not even list it as refuted.
2. Cluster findings that describe the same underlying issue across reviewers; flaggedBy is the number of distinct reviewers in the cluster.
3. Verify each cluster's core claim by reading only the specific hunks or files it names -- not the whole diff -- and set verification confirmed/refuted/unverifiable with a one-line verificationNote.`

const consolidated = await agent(consolidatorPrompt, {
  label: 'consolidator', phase: 'Consolidate', schema: CONSOLIDATOR_SCHEMA, model: 'sonnet',
})
if (!consolidated) throw new Error(salvage('The consolidator'))

return {
  reviewerCount: reviews.length,
  simplerShapeVotes: reviews.map((r) => r.simplerShape),
  clusters: consolidated.clusters,
}
```

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

### Lens mode -- the Workflow returned `{reviewerCount, simplerShapeVotes, clusters}`

4. CONFIRMED = clusters with verification `confirmed`. A confirmed file that also carried
   a confirmed cluster in the PREVIOUS light round is a REPEAT; repeat files are the
   round's hotspots.
5. CONTESTED = clusters with `flaggedBy` 1, severity critical or major, and verification
   not `refuted`.
6. Append one JSON line to the ledger:
   `{"round": N, "kind": "light", "date": "<date -I>", "reviewerCount": <reviewerCount>, "clusters": [{"name", "file", "severity", "verification"}], "simplerShapeVotes": <count of simpler=true>}`.
   A branch's first row also carries `"cap": <the round budget>` (Common item 1).
7. Write `review_findings.md`: a header line (branch, round N, kind `light`,
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

4. GATING = claims whose verdict is `REFUTED` or `COULD-NOT-VERIFY`. A gating claim's
   file that also carried a gating claim in the PREVIOUS round of this same role is a
   REPEAT; repeat files are the round's hotspots.
5. The gate is claim-scoped by design: `gate` reflects the contract's verdicts and
   nothing else. The out-of-claim `findings` never move it -- they are triage material
   for assess-review, which reads them off the artifact.
6. Append one JSON line to the ledger:
   `{"round": N, "kind": "<role>", "date": "<date -I>", "gate": <gate>, "claims": [{"claim", "verdict", "file"}], "findings": [{"name", "file", "severity"}]}`.
   A branch's first row also carries `"cap": <the round budget>` (Common item 1).
7. Write `review_findings.md`: a header block naming the role, the number of claims it
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
