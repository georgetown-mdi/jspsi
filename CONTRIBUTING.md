---
title: "Contributing to PSI-Link"
---

# Contributing to PSI-Link

Thank you for your interest in contributing. PSI-Link handles personally identifiable information in high-stakes environments; correctness, security, and auditability matter more than velocity. Please read this document before opening a pull request.

## Scope of this document

This is the pre-contribution quickstart: repository layout, how to build and test, the conventions CI and review enforce, and the pull-request and dependency-review process. It is not a reference. Keep deeper material out of it:

- Dependency-internal premises and upgrade runbooks -> [docs/spec/DEPENDENCY_PINS.md](docs/spec/DEPENDENCY_PINS.md).
- Test-infrastructure internals and the coverage rationale -> [docs/TESTING.md](docs/TESTING.md).
- Wire formats, constants, algorithm steps, and the "would only need revisiting if..." rationale behind them -> [docs/spec/](docs/spec/README.md).

## Repository Structure

PSI-Link is organized as an npm workspaces monorepo. The workspaces and the supporting directories, all of them:

| Path             | Description                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------ |
| `packages/core/` | Shared library: PSI primitive, exchange orchestration, file-sync transport, config schemas |
| `packages/peerjs-broker/` | The PeerJS-compatible WebRTC signaling broker: vendored server source plus a standalone entry point (`npm start -w packages/peerjs-broker`). Ships TypeScript source with no build step of its own, reading `@psilink/core` from that workspace's `dist/`; the web app bundles it into its server |
| `apps/cli/`      | Node.js CLI (`psilink`), built with Rollup, distributed as a Docker image                  |
| `apps/web/`      | TanStack Start (React/SSR) web app; serves the peer-coordination broker above at `/api`    |
| `docs/`          | Documentation, three tiers: `docs/` overview (conceptual/operational), `docs/spec/` technical, `docs/notes/` design records |
| `scripts/`       | Repository checks CI runs (doc links, PR checklist, claim and drift guards) with their tests |
| `support/`       | [Field guides](support/README.md) for the environment around psilink -- Windows, Docker, agency networks -- plus the FIPS measurement harness |
| `lib/`           | The vendored `@openmined/psi.js` tarball and its checksum                                  |
| `test_data/`     | Two synthetic CSVs with partial overlap, for practicing a complete exchange                |
| `design/`        | Interface design records: [`design/web-redesign/`](design/web-redesign/README.md) is the linkage-bench mockup and rationale the web app implements. Not a build input |
| `infra/`         | [Terraform](infra/aws_eb/README.md) for creating the web app's Elastic Beanstalk environment. A draft, and run by nothing here -- the deployment payload CI does use is `apps/web/deploy/aws_eb/`. Beside it, [the standing WebRTC relay's reference deployment](infra/relay/README.md), also run by nothing here |

## Prerequisites

- **Node.js** 26 or later (npm 11 or later is included)
- **Docker** for building the container image

The OpenMined PSI module is vendored at `lib/openmined-psi.js-2.0.6-seclink.3.tgz` (the WASM engine plus native N-API prebuilds). No Emscripten or native toolchain is required to work against it.

## Development Setup

```sh
git clone git@github.com:georgetown-mdi/jspsi.git psilink
cd psilink
npm install
npm run build -w packages/core   # core must be built before the apps and the broker
```

For work that spans `packages/core` and the web app, run the dev loop from the repository root:

```sh
npm run dev            # core's build watcher + the web dev server
npm run dev:console    # the same, with the console deployment profile
```

The apps consume `@psilink/core` from its built `dist/`, so a core edit made while a bare `npm run dev -w apps/web` is running never reaches the page. The root script brings `dist/` up to date before the server starts and rebuilds it on every later change; either side exiting stops the other.

No additional environment variables are required for local development or the tests. The CLI SFTP integration suite starts its own server; set `PSILINK_SFTP_BACKEND=native` to run it against a native OpenSSH `sshd` instead of the in-process default (see [docs/TESTING.md](docs/TESTING.md), which documents the variable).

## Building

```sh
npm run build -w packages/core   # must build before the apps and the broker; rebuild after any core change
npm run build -w apps/cli        # -> apps/cli/dist/; Docker image built separately (docs/RELEASES.md)
npm run build -w apps/web
```

## Testing

```sh
npm test -w packages/core
npm run test:unit -w apps/cli
npm run test:unit -w apps/web
npx vitest run path/to/file.test.ts   # single file
```

Building, running the dev server, or testing `apps/web` regenerates the checked-in `src/routeTree.gen.ts` (see [apps/web/README.md](apps/web/README.md#generated-route-tree)), so it can churn in a working tree with no route change. Stage explicit paths rather than `git add -A`, which also sweeps stray review or scratch artifacts into a commit.

### Integration and browser tests

Must pass before a PR merges to `main` or `staging`. Each suite is
self-managing -- it starts and stops the server it needs -- so no manual setup
beyond the builds above is required:

```sh
npm run test:integration -w apps/cli         # SFTP adapter driven over a loopback server
npm run test:integration:webrtc -w apps/cli  # WebRTC transport over loopback werift peers
npm run test:integration:backend-agnostic -w apps/cli  # the integration files no SFTP backend differentiates
npm run test:integration -w apps/web
npm run test:browser     -w apps/web         # cross-impl vectors + live exchange, real Chromium
npm run test:interop     -w apps/web         # a real psilink process and a web party, one live exchange
```

The interop suite drives the built CLI, so run `npm run build -w apps/cli` first;
it skips itself otherwise.

The native SFTP backends and hardened profiles, why the WebRTC, backend-agnostic,
and interop suites are projects of their own, the console sentinel, the
warm-server inner loop, and the browser-suite plumbing are in
[docs/TESTING.md](docs/TESTING.md).

### Coverage

Coverage is an informational report (`npm run coverage`), not part of `npm test`
and not a CI gate. There is deliberately no global percentage threshold -- do
not add one. Rationale and what the report covers: [docs/TESTING.md](docs/TESTING.md#coverage).

## Code Conventions

- **TypeScript** with strict mode throughout. Avoid `any`; if you must use it, add a comment explaining why.
- **Naming**: `camelCase` in TypeScript; `snake_case` in user-facing JSON and YAML files. Semicolons required. Prefer a long, explicit, self-documenting name over a short one plus a clarifying comment.
- **Comments**: write one only when the _why_ is non-obvious - a hidden constraint, subtle invariant, or known limitation. Do not restate what the code does. Multi-line `//` blocks are permitted for genuinely complex runtime constraints that cannot fit on one line.
- **Encode runtime invariants as checks, not prose**: a claim that something does not happen at runtime - a line that never fires, an unreachable branch, a callback that never runs - belongs in an executable check that fails when the claim breaks, not a comment or doc note that cannot; prose asserting a runtime fact rots silently, a check cannot lie. Cautionary example: a note that the ssh2-sftp-client "Global ... listener" console lines were "found NOT to fire" went stale when later host-key work made them fire (no library bump); the CLI integration console sentinel enforces that invariant as a check instead. A best-effort check must say so - a backstop is not a guarantee.
- **JSDoc**: `/** */` on all exports; `/** @internal */` (with no description) for test-only exports.
- **Validation**: define the TypeScript interface first, then derive the Zod schema with `z.ZodType<Interface>`. Apply `camelizeKeys` before Zod parsing so user-facing YAML/JSON remains `snake_case` while TypeScript sees `camelCase`.
- **Transport branching**: `connection.channel` is the discriminant. Use allowlists (not blocklists) so a new channel is rejected unless explicitly added. The guards are in `packages/core/src/config/connection.ts`, `packages/core/src/config/invitation.ts`, `packages/core/src/config/exchangeFile.ts`, `apps/cli/src/commands/exchange.ts`, `apps/cli/src/protocol.ts`, and `apps/cli/src/onlineBootstrap.ts`.
- **New channels**: add a discriminant value and config interface to `packages/core/src/config/connection.ts`, update the `ConnectionConfig` union, then update the guards. See existing `sftp`, `webrtc`, and `filedrop` entries for examples.
- **Security primitives**: extract shared cryptographic helpers as soon as they are correct and tested. Do not defer to a "second caller" rule for security code - silent independent re-implementations are a failure mode. A security-relevant fix lands at the single upstream chokepoint that closes the whole class, preferring a misuse made unrepresentable over one documented; when that reaches past the issue's stated scope, say so and ask before landing it.
- **Sensitive-file parsing**: parse any secret-bearing config or credential document -- the CLI's operator config (`psilink.yaml`), key file (`.psilink.key`), and signing identity, and the web app's imported YAML/JSON linkage-terms document (untrusted free text an operator could paste a secret into) -- only through the shared sensitive-parse chokepoint in `@psilink/core` (`parseSensitiveYaml` / `parseSensitiveJson`), which `apps/cli/src/sensitiveFile.ts` re-exports, never a raw YAML/JSON parser. An ESLint rule enforces this: raw YAML parsers are banned across `packages/core/src`, `apps/cli/src`, and `apps/web/src`, and raw `JSON.parse` in `apps/cli/src` (the web app's JSON half is deferred until the browser secret-store work, its current JSON being non-secret peer/wire data); the rule message names the entry points and the one-line `eslint-disable` opt-out for a non-sensitive parse. Rationale and the leak channels: the module header and `docs/SECURITY_DESIGN.md` (Console and log hygiene).
- **Untrusted-JSON parsing**: parse any untrusted JSON -- a partner wire frame, a transport-controlled file, an invitation token -- only through the `packages/core/src/utils/boundedJson.ts` chokepoint (`parseBoundedJson`), never a raw `JSON.parse` -- an ESLint rule enforces this across `@psilink/core` (its message names the entry point and the one-line `eslint-disable` opt-out for a trusted parse). The chokepoint structurally bounds the body before `JSON.parse` so a pathological object or array cannot drive the parser into an uncatchable, process-terminating abort. Rationale: the module header and `docs/spec/CHANNEL_SECURITY.md` (Application-layer parsed-input bounds).
- **Operator-facing escaping**: escape untrusted text at ONE altitude, the display sink. A fragment interpolated into an `Error` message or `cause` is composed RAW -- `sanitizeErrorForDisplay` escapes the whole rendered chain once where it is shown -- while a value that reaches a `log.*`, `console.*`, or UI sink without ever becoming an `Error` is escaped with `sanitizeForDisplay` at that call site, which is its sink. Escaping at both altitudes double-escapes: `sanitizeForDisplay` doubles a literal backslash on every pass, so one backslash in a partner filename reaches the operator as four. An ESLint rule bans rendering a raw error at a sink (`err.message`, `String(err)`, `${err}`, `console.error(err)`) across `packages/core/src` and `apps/cli/src`, excepting the parse chokepoints those blocks already ignore; the rule message names both entry points and the one-line `eslint-disable` opt-out. A few routes still escape at composition and again at their sink -- `docs/spec/CHANNEL_SECURITY.md` enumerates them; do not add another. The CLI integration console sentinel is the runtime half, failing on any captured line carrying a byte outside printable ASCII once the renderer's own `\ncaused by: ` framing is removed. Both halves are bounded: the rule matches the raw error where it sits directly in a sink argument and does not follow it through an intermediate local, and the sentinel sees only `console` calls, so neither a direct `process.stderr.write` nor a dependency that writes the file descriptor itself passes through either. Neither is a claim about every byte that lands on the terminal.
- **CLI durations**: a duration-valued CLI flag parses its value through the shared `parseDuration` / human-readable `<int><unit>` format (`apps/cli/src/util/duration.ts`), read from args via `durationFlagSeconds` (`apps/cli/src/util/cli.ts`), never a bare integer of seconds, so the accepted value syntax stays consistent across flags.
- **CLI flag naming**: a flag names the object of the action rather than the mechanism, stays self-scoping (a generic `--yes` overclaims), does not stutter with its subcommand, and a weighty or irreversible action gets no terse short form.
- **Windows paths**: support wherever a user can supply a local path. Normalize backslashes on ingestion; use `fileURLToPath` for `file://` URLs.
- **Markdown**: soft line wrapping, single space after periods, ASCII punctuation (`-` not em-dash, `->` not arrow character).

Linting and formatting are enforced by CI. Run locally before pushing:

```sh
npm run typecheck
npm run lint
npm run format
```

## Documentation

PSI-Link documentation is three-tier:

- `docs/` (overview) - conceptual and operational documents for program officers, security reviewers, compliance officers, IT staff, and contributors.
- `docs/spec/` - the technical specification tier: wire formats, byte encodings, normative constant values, protocol internals, and implementation-level design, for implementors and auditors. See [`docs/spec/README.md`](docs/spec/README.md) for the index and routing guide.
- `docs/notes/` - tracked, citeable design records and explorations: the model behind a mechanism, the options weighed, and the decisions taken. Non-normative - nothing here binds an implementation, and a note points at the spec for the normative rows rather than restating them. Indexed by [`docs/notes/README.md`](docs/notes/README.md), which carries the maturity ladder from `scratch/` up to the formal tiers.

When behavior changes, update the matching tier:

- User-configurable or operational behavior -> the relevant overview doc in `docs/`.
- Wire format, protocol internals, or implementation-level spec -> the relevant `docs/spec/` file.
- A change touching both tiers updates both.

If you are writing a constant value, a byte/wire layout, an HKDF info string or other algorithm step, or the "would only need revisiting if..." rationale behind one of those, it belongs in `docs/spec/` - regardless of which doc you currently have open. Overview docs (`docs/`) stay conceptual and operational, including operational rationale such as the coverage-gate decision.

Overview docs must stay scannable: no multi-hundred-word paragraphs -- use subheadings and lists. When an edit lands in a section that is already a wall of text, restructure the section rather than growing a sentence in place.

Write documentation as the target state, not a narration of what changed -- no "now", "previously", or "no longer"; the reader cannot see the diff, and change history belongs in the commit message.

Use an obviously fake placeholder for any credential-shaped value in an example config or sample document -- GitHub push protection rejects a push whose commits add a real-looking secret anywhere, docs and example YAML included, and recovering means amending the offending commit rather than adding a follow-up on top of it.

The governance documents -- [SECURITY.md](SECURITY.md), [PRIVACY.md](PRIVACY.md), [docs/INCIDENT_RESPONSE.md](docs/INCIDENT_RESPONSE.md), [docs/SECURITY_DESIGN.md](docs/SECURITY_DESIGN.md), [docs/COMPLIANCE.md](docs/COMPLIANCE.md), and [docs/SHARED_RESPONSIBILITY.md](docs/SHARED_RESPONSIBILITY.md) -- carry `review_owner` and `last_reviewed` in their YAML front matter, so an agency reviewer can see who owns each one and when it was last confirmed correct without reading the git history. The owner is a role rather than a person, so it survives a change of maintainer. A substantive change to one of these -- anything that alters what the document asserts, as opposed to a typo, link, or formatting fix -- sets its `last_reviewed` to the date the change lands. The date means someone read the document and found it still correct, so leave it where it is for an edit that was not that.

Documentation-tier placement is in scope for code review: a reviewer flags spec-level detail written into a `docs/` overview doc.

## Changelog

`CHANGELOG.md` is reader-facing release notes for whoever runs or vets PSI-Link from outside this repo, browsing to learn what it does and whether it is worth adopting -- not a second copy of the git history. It is a short list of the product's headline capabilities, not a record of the work done.

- Pre-release, the default answer to "does this PR need a changelog entry?" is no. Add one only for a genuinely major feature -- a new capability a reader browsing the repo needs to know exists -- or a breaking change to something already listed. Everything else is skipped: individual flags and config fields, UI polish, operational and error-handling refinements, bug fixes, changed defaults, exit-code and format tweaks, internal refactors, test/CI/tooling changes, `@psilink/core` API reshapes, and doc-only edits. When in doubt, leave it out; a reviewer adds an entry back far more cheaply than the log recovers from bloat.
- One or two lines per entry, stating the capability; push rationale and wire detail to `docs/`, `docs/spec/`, or the PR and link it with a trailing `See docs/...`.
- Group under Added / Changed / Deprecated / Removed / Fixed / Security; prefix a breaking change `BREAKING:`. Keep the Security section to the headline security posture, not each hardening change.
- Once there are releases operators upgrade between, the bar drops to any change a reader acts on when deciding whether to upgrade -- a changed default, behavior, exit code, wire/on-disk format, or security fix -- and security entries are recorded exhaustively per release. Until then, hold the higher bar.

## Commit Messages

- Imperative mood, present tense: "Fix key rotation after failed exchange", not "Fixed ..." or "Fixes ...".
- Subject line 50 characters or fewer. For a squash-merge message that budget
  includes the " (#NNNN)" pull-request suffix GitHub appends on merge, so
  draft the subject itself to roughly 42 characters.
- Include a body for non-trivial commits explaining motivation and context, not just what changed. Hard-wrap body lines at roughly 70 characters.
- A pull request is squash-merged, so its squash message is the commit that lands. `node .claude/scripts/squash-message.mjs <pr-number>` drafts one from the branch's commits, the PR body, and this document, and prints it for the maintainer to review before pasting; it merges nothing. A pull request carrying a single commit needs no hand-written squash message -- GitHub takes that commit's own message -- so the script refuses one and the work goes into the commit itself.

## Pull Request Process

1. For significant changes, open a draft issue on the Github project first to align on approach. Bug fixes and documentation improvements do not require a prior issue.
2. Keep pull requests focused - one logical change per PR.
3. Ensure typecheck, lint, format, and the relevant tests pass before marking the PR ready for review (CI enforces all four). Record what you ran and the coverage you added in the PR's Test plan, and resolve every line of the template Checklist.
4. Changes within the security-review scope -- cryptographic code, the channel-security controls, credential or disclosure surfaces, or a security-relevant dependency -- require explicit security review before merging (see [Dependency Policy](#dependency-policy) for the full enumeration).
5. Update documentation when behavior changes - see [Documentation](#documentation) for which tier. Add a `CHANGELOG.md` entry when the change is visible to an operator or a reviewer - see [Changelog](#changelog).
6. A maintainer will review and squash-merge. Force-pushes to `main` are not permitted.

### Pull Request Description

Opening a PR populates [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md), whose inline comments explain each section and the writing conventions (ASCII, imperative mood, `##` headings, board-reference verbs). Fill in what applies; delete any optional section with nothing non-obvious to say -- keep small PRs small.

## Dependency Policy

A change requires explicit security review and maintainer approval before merging if it touches any of the following. This list is the trigger; [docs/SECURITY_DESIGN.md](docs/SECURITY_DESIGN.md) is the model behind it, consulted only to decide a case the list does not settle.

- Cryptographic code or its inputs: the PSI protocol, the P-256 ECDH key exchange / handshake / key schedule, token generation / rotation / derivation, or canonical encoding.
- The application-layer AEAD: encryption, the nonce / sequence scheme, or the integrity / replay / reordering / gap checks.
- The channel-hardening controls: the frame-size, directory-listing, liveness / timeout, connect-probe, and whole-exchange bounds, the web WebRTC data-channel inbound bound, plus the SFTP crash-safety and authenticated abort-marker controls.
- Credential and secret handling: how the key file, signing identity, or result CSV is written or permissioned; how secrets are stored, transmitted, logged, or referenced (the configuration `@path` resolution).
- Authentication and identity: the auth gate's fail-closed behavior, fingerprint / certificate pinning and verification, or token expiry and `token_max_age_days` enforcement.
- What is disclosed: any change to what is sent on the wire, logged, displayed, or written to disk, or to what the result reveals (cardinality, linkage terms, consent-surfaced fields).
- A security-relevant dependency (see Cryptographic dependencies, the SFTP stack, and the WebRTC stack below).

Modifying an existing control in these areas is in scope exactly as adding one is: a change that weakens or removes a guarantee triggers review no less than a new control does.

PSI-Link is licensed under [Apache 2.0](LICENSE.md); add third-party dependencies conservatively. For every new dependency:

1. Confirm the license permits Apache 2.0 distribution. Copyleft licenses (GPL, AGPL) are not compatible. The [Dependency Review workflow](.github/workflows/dependency_review.yaml) enforces this automatically for the strong-copyleft GPL/AGPL family via its `deny-licenses` blocklist, failing any PR that introduces a dependency under one. That gate is a backstop, not the whole rule: it fails only on a _declared_ denied SPDX id, so a passing check is not proof a dependency is clean -- one that ships no license metadata (or `NOASSERTION`) is reported but does not fail it. This review stays the authority for weak copyleft (LGPL, MPL), whose acceptability is linkage-dependent, and for any dependency whose license the action cannot resolve or that declares none (exempt a mis-flagged dependency with the workflow's `allow-dependencies-licenses` and clear it here).
2. Run `npm audit --omit=dev -w packages/core -w apps/cli -w apps/web` -- the scope the shipped image runs -- and resolve any known vulnerabilities before merging. [Static Checks](.github/workflows/static_checks.yaml) runs that exact command as a merge gate on every pull request and fails on any finding, so this is a faster local answer rather than the only one; resolve a red gate by a reviewed bump, never by `npm audit fix`. A finding outside that scope is a development-tree finding, reported by the scheduled [Dependency Audit](.github/workflows/dependency_audit.yaml) and triaged separately rather than at merge time; see [docs/spec/DEPENDENCY_PINS.md](docs/spec/DEPENDENCY_PINS.md).
3. Prefer packages that are actively maintained and publish a security policy.
4. If the package ships its own `NOTICE` file and is redistributed to end users, fold its attribution into the top-level [`NOTICE`](NOTICE).

On a dependency-bump pull request, scope the review by the changed (`+`/`-`) manifest lines against this policy, and treat a green check on a PR opened days ago as stale until it is re-run against the current `staging` (`@dependabot rebase`).

**Cryptographic dependencies** - `@openmined/psi.js`, `@noble/curves`, and any AEAD, key-agreement, or key-derivation library - require explicit security review and maintainer approval before merging. These libraries underpin the privacy and integrity guarantees of every exchange. Dependency upgrades driven by security advisories take priority over feature work.

**The SFTP stack (`ssh2` / `ssh2-sftp-client`) and the WebRTC stack (`peerjs` / `peerjs-js-binarypack`)** are reached past their public APIs into internals, so each is exact-pinned (in `apps/cli/package.json` and `apps/web/package.json` respectively). Every bump is a deliberate, security-reviewed edit -- never an `npm audit fix` that slips in unreviewed -- and must re-verify the internal premises first. Why they are pinned, the premises, and the per-stack upgrade checklist: [docs/spec/DEPENDENCY_PINS.md](docs/spec/DEPENDENCY_PINS.md).

Per-dependency licenses are recorded authoritatively in the CycloneDX SBOM attached to each release - every direct and transitive dependency with its license; see [docs/RELEASES.md](docs/RELEASES.md#software-bill-of-materials-sbom). Attributions for redistributed and vendored components are in the top-level [`NOTICE`](NOTICE).

## Export Control

PSI-Link incorporates cryptographic software. Distribution may be subject to U.S. Export Administration Regulations (EAR). Most open-source cryptographic software qualifies for License Exception ENC under ECCN 5D002, but the exception requires a one-time notification to BIS and NSA. This notification is pending and will be completed before the 1.0 release. See [docs/COMPLIANCE.md](docs/COMPLIANCE.md#export-control-ear) for the full regulatory framing.

## Reporting Security Issues

Do not open a public issue for security vulnerabilities. See [SECURITY.md](SECURITY.md) for the private reporting process.

## Reporting Other Issues

Open a [GitHub issue](https://github.com/georgetown-mdi/jspsi/issues). Include the version (Docker image tag or `package.json` version), the operating system, and a minimal reproducing case.
