<!--
PR description. Drop any optional section that has nothing non-obvious to say -- keep small PRs small. Delete every HTML comment (guidance, not content) before submitting.
Conventions:
- ASCII only: `-` (not `*`) for bullets; no en-dash, em-dash, or arrow characters.
- Imperative mood, terse and technical. Single space after periods. Soft-wrap; do not hard-wrap lines.
- Headings start at `##`. Do not repeat the PR title as a heading.
-->

## Summary

One short paragraph, outcome first: what this PR delivers and why it matters. The "how" goes in Changes.

Implements [<id>](https://github.com/orgs/georgetown-mdi/projects/<board>/views/1?pane=issue&itemId=<id>).
<!--
Board items are GitHub Project draft itemIds, not issue numbers -- `Closes #<id>` renders as a broken link. Use the full itemId URL; board is 9 (Product) or 10 (Release & Operations). Pick one verb for the line above, or delete the line for a bug fix or doc tweak with no board item:
  Implements -- closes the task
  Part of -- partial delivery
  Depends on -- needs another item merged first
  Follow-on -- spun off, tracked separately
-->

## Changes

<!-- The map of the diff (the "how"); the "why" is in Summary. Focused PR (<= ~5 files): one bullet per file. Broad PR (rename, refactor, cross-cutting): group by area and call out only what is non-obvious. -->

- <file or area>: <what changed>

## Test plan

<!-- CI runs typecheck, lint, format, and the test suites and is the authority on pass/fail. Here, record what you exercised locally and the coverage this change adds, and point a reviewer at the evidence. -->

Ran: <suites or files exercised locally, e.g. `npx vitest run packages/core/test/foo.test.ts`>
New tests cover: <the specific behaviors verified, or n/a -- reason>

## Background

<!-- Optional. Context that predates this PR: root cause, the invariant preserved, a non-obvious constraint. Omit if the Summary covers it. -->

## Out of scope / follow-on

<!-- Optional. Deferred work, each with its board link. Delete if none. -->

- <deferred item and its board link>

## Checklist

<!--
Pre-merge obligations CI does not verify. Resolve every line: check it when done OR when genuinely not applicable -- a checked box means "resolved", and the trailing clause says which. Checking n/a items too keeps the PR-list progress badge honest (it counts only checked boxes); never leave a box unchecked to mean n/a. Every n/a MUST carry a reason tied to this diff; a bare "n/a" does not count. Do not delete lines here.
  done:  - [x] CHANGELOG.md [Unreleased] updated -- added under Fixed
  n/a:   - [x] CHANGELOG.md [Unreleased] updated -- n/a: internal refactor, no user-facing change
-->

- [ ] Docs: enumerated `docs/` and `docs/spec/` and updated affected pages or added new ones at the appropriate level of detail for the document tier (`/docs` high level + design; `/docs/spec` low level + details) -- <which pages, or n/a: no documented behavior changed>
- [ ] `CHANGELOG.md` `[Unreleased]` updated -- <the entry, or n/a: reason>
<!--
Security review applies if this PR touches any of -- do it and record the type, else n/a:
- cryptographic code or its inputs: the PSI / key-exchange protocol, key derivation, or canonical encoding
- the application-layer AEAD, or the frame-size / directory-listing / liveness / connect bounds
- credential or secret handling: the key file, signing identity, result CSV, or config @path resolution
- authentication, fingerprint / certificate pinning, or token expiry / token_max_age_days
- what is disclosed: data sent, logged, displayed, or written to disk, or what the result reveals (cardinality, linkage terms, consent-surfaced fields)
- a security-relevant dependency: @openmined/psi.js, @noble/curves, any AEAD / key-agreement / KDF library, or the SFTP stack (ssh2 / ssh2-sftp-client)
Modifying an existing control counts, not only adding one. Full list: CONTRIBUTING Dependency Policy.
-->
- [ ] Security review -- <type of review done, or n/a: none of the above touched>
