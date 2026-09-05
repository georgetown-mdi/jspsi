---
title: "Checking Source Comments for History Narration"
---

# Comment history narration: what the check matches, and what it costs

_Status: decided and built. This note records the corpus measurement behind
[`scripts/check-comment-history-narration.mjs`](../../scripts/check-comment-history-narration.mjs)
-- why it matches phrases rather than the three words
[CONTRIBUTING.md](../../CONTRIBUTING.md) names, what it reports over the tree,
and its false-positive rate over a sample of merged pull requests. See
[docs/notes/README.md](README.md)._

## The rule the check encodes

CONTRIBUTING.md's Documentation section asks for the target state, not a
narration of what changed: no "now", "previously" or "no longer", because the
reader cannot see the diff. It holds in the documentation tiers and in source
comments alike. Nothing failed while it was prose, and a narrating comment
survives the rewrites of the code it describes and then misleads.

The check covers the source-comment half, over the comment lines a change adds
or modifies. Comments already in the tree are out of scope: the range is the
diff against the base branch, so nothing sweeps the repository, and an existing
block drains when someone edits it. The Markdown half stays with review --
prose has no comment syntax to scope a match to.

## The base the range is measured against

In CI the base is the pull request event's own `base.sha`, handed to the check
as `PSILINK_NARRATION_BASE` by
[static_checks.yaml](../../.github/workflows/static_checks.yaml); the symbolic
refs -- `origin/<base branch>`, then `origin/staging` -- are the fallback a
local run and any non-pull-request event take. Nothing here was driven against
a real runner from this container, so this pull request's own CI run is the
measurement of the wiring.

## Why phrases and not the three words

Measured over the tree at `66419d3a`: 1,230 files in the scanned extensions,
117,042 comment lines. The three words CONTRIBUTING.md names appear on:

| Word         | Comment lines |
| ------------ | ------------- |
| `now`        | 329           |
| `no longer`  | 188           |
| `previously` | 11            |

Nearly every one is a statement about run time, not about the repository:
`Date.now()`, "release the buffered prefix now", "a path that no longer
exists", "a terminal error built from a previously captured fault". A check on
the bare words would report a few hundred lines that are all correct as
written, and a check nobody can keep green is worse than the prose rule.

So each tell binds a temporal word to a change verb or a change noun --
"was previously", "used to hold", "no longer needed", "this change", "the old
implementation", "we no longer", "moved here from". Four families were tried
and dropped for colliding with this repository's own vocabulary:

- `before the rename`, `after the split`, `before the rewrite` -- the atomic
  write path renames files and the transform path rewrites values, so eight
  comment lines matched and all eight were about run time.
- `the old code`, `the previous version`, `the previous signature scheme` -- an
  invitation code and a record version are domain nouns here.
- `now instead of`, `now rather than` -- both matches were "fails here and now
  instead of" and "would emit right now rather than".
- `what used to be true` -- an idiom about a record going stale, in two script
  headers. The tell excludes a `used to` preceded by `what`.

## What it reports today

Five comment lines in the whole tree, four of them narration the rule asks to
be rewritten and one a legitimate use:

| Line                                                | Verdict                                     |
| --------------------------------------------------- | ------------------------------------------- |
| `apps/cli/test/unit/stderrLogging.test.ts:69`         | narration ("formerly stdout")              |
| `apps/cli/test/integration/sftpConnection.test.ts:598` | narration ("the original residual this change closes") |
| `apps/web/test/unit/identityLabelParity.test.ts:8`    | narration ("the cross-reference each file used to hold") |
| `packages/core/test/vectors/generate-transform-regex-vectors.mjs:5` | narration ("before this change") |
| `.claude/scripts/verify-nonexecutable-delta.test.mjs:773` | legitimate: "this change" names an entry in a git diff the test builds |

None of them fails anything until someone edits the block it sits in, which is
the scope decision above. The legitimate one takes the override when its file is
next touched.

## The false-positive rate

Sample: the 100 most recent squash merges on `staging`, `1d01a880` through
`66419d3a`, 1,903 changed files in the scanned extensions. Each merge's own
diff was replayed and the check run over the comment lines it added.

- 2 reports across 100 pull requests.
- 1 was narration (`identityLabelParity.test.ts`).
- 1 was a false positive (`verify-nonexecutable-delta.test.mjs`).

One false report in 100 pull requests, and roughly one report of any kind in 50.
The reproduction is a diff replay over `git log --first-parent`; it is not
committed, because it measures a sample that moves under it.

## The override

A comment carrying `allow-history-narration -- <why>` is exempt, with the reason
required after the `--` the way this repository writes an
`eslint-disable-next-line`. It exempts the comment it sits in: one `//` line, or
one whole block comment. It is for the case the check cannot tell apart -- a
sentence about what an external tool changed between its versions, or about a
change the code under test performs -- not for narration someone would rather
keep.

## What it does not reach

The script header carries the full list; the load-bearing ones are Markdown,
every file outside the JavaScript and TypeScript family, and narration written
with none of the tells. The tells are the phrases that measured at an
acceptable false-positive rate, not a model of the English of change: a
reviewer still reads the comment.
