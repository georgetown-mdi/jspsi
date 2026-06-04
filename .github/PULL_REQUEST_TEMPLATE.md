<!--
PR description guidance. A PR is a task closed out, so this skeleton mirrors the PM task template (Summary / Acceptance criteria / Affected areas / notes). Drop any optional section that has nothing non-obvious to say -- keep small PRs small. Conventions: ASCII only, `-` (not `*`) for bullets, no en-dash, em-dash, or arrow characters, imperative mood, terse and technical, single space after periods, wrap and don't break lines. Start headings at `##`; do not repeat the PR title as a heading.
-->

## Summary

One short paragraph, outcome first: what this PR delivers and why it matters, not how.

Implements <board> item [<id>](https://github.com/orgs/georgetown-mdi/projects/<board>/views/1?pane=issue&itemId=<id>).
<!--
Board items are GitHub Project draft IDs, not issue numbers -- `Closes #<id>` does not work and renders as a broken link. Always use the full itemId URL. Use project 9 (Product) or 10 (Release & Operations). Pick the verb:
  Implements [<id>](url) -- this PR closes out the task
  Part of     [<id>](url) -- partial delivery
  Depends on  [<id>](url) -- needs another item merged first
  Follow-on:  [<id>](url) -- spun off, tracked separately
-->

## Changes

<!--
Focused PR (<= ~5 files): one bullet or table row per file, with the why. Broad PR (rename, refactor, cross-cutting): group by area or pattern and call out only what is non-obvious.
-->

-

## Background

<!-- Optional. Root cause, the invariant being preserved, a non-obvious constraint honored. Omit if the Summary already says everything. -->

## Breaking change

<!-- Only if applicable. What breaks and what a consumer must do. Delete if not. -->

## Out of scope / follow-on

<!-- Optional. Deferred work, each with its board link. Delete if none. -->

-

## Test plan

<!-- How the change was verified. The evidence it works -- maps back to the task's acceptance criteria. Verification only; housekeeping goes below. -->

- [ ] `npm run typecheck && npm run lint` clean
- [ ] `npm test -w packages/core` (N/N)
- [ ] `npm run test:unit -w apps/cli` and/or `apps/web` as relevant
- [ ] CLI integration tests: `npm run test:integration -w apps/cli`

New tests cover: <name the specific behaviors, as the acceptance criteria do>

## Checklist

<!-- Pre-merge hygiene that keeps the rest of the repo consistent. Not testing. Check or mark n/a -- do not delete; a deliberate "n/a" is the signal you looked. -->

- [ ] Ran `ls docs/` and checked each file for impact; updated affected pages or confirmed none needed
  <!-- docs/ currently: CLI, COMMUNICATION, COMPLIANCE, DEPLOYMENT, DESIGN, EXCHANGE_SPEC, FILE_SYNC, PROTOCOL, README, RELEASES, ROADMAP, SECURITY_DESIGN; do not rely on these being the only documents -- enumerate the directory -->
- [ ] `CHANGELOG.md` `[Unreleased]` updated, or n/a
- [ ] Cryptographic code changed? Security review requested (see Dependency Policy), or n/a
