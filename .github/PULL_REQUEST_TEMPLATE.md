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

- [ ] Ran `ls docs/` and `ls docs/spec/`, checked each file for impact, and updated affected pages or confirmed none needed (enumerate both directories -- do not rely on a static list)
- [ ] Any detail I added to a `docs/` overview is conceptual -- no constants, byte/wire layouts, algorithm steps, or deferred-decision rationale (those go in `docs/spec/`), or n/a
  <!-- Tier litmus, kept in sync across this template, CLAUDE.local.md, CONTRIBUTING.md, and docs/spec/README.md: If you are writing a constant value, a byte/wire layout, an HKDF info string or other algorithm step, or a "would only need revisiting if..." design rationale, it belongs in `docs/spec/` - regardless of which doc you currently have open. Overview docs (`docs/`) stay conceptual and operational. -->
- [ ] `CHANGELOG.md` `[Unreleased]` updated, or n/a
- [ ] Cryptographic code changed? Security review requested (see Dependency Policy), or n/a
