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

PSI-Link is organized as an npm workspaces monorepo.

| Path             | Description                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------ |
| `packages/core/` | Shared library: PSI primitive, exchange orchestration, file-sync transport, config schemas |
| `apps/cli/`      | Node.js CLI (`psilink`), built with Rollup, distributed as a Docker image                  |
| `apps/web/`      | TanStack Start (React/SSR) web app with built-in PeerJS peer-coordination server           |
| `docs/`          | Documentation, two tiers: `docs/` overview (conceptual/operational), `docs/spec/` technical |

## Prerequisites

- **Node.js** 26 or later (npm 10 or later is included)
- **Docker** for building the container image

The OpenMined PSI module is vendored at `lib/openmined-psi.js-2.0.6-seclink.2.tgz` (the WASM engine plus native N-API prebuilds). No Emscripten or native toolchain is required to work against it.

## Development Setup

```sh
git clone git@github.com:georgetown-mdi/jspsi.git psilink
cd psilink
npm install
npm run build -w packages/core   # core must be built before the apps
```

No additional environment variables are required for local development or the tests. The CLI SFTP integration suite starts its own server; set `PSILINK_SFTP_BACKEND=native` to run it against a native OpenSSH `sshd` instead of the in-process default (see Integration tests below).

## Building

```sh
npm run build -w packages/core   # must build before the apps; rebuild after any core change
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

### Integration and browser tests

Must pass before a PR merges to `main` or `staging`. Each suite is
self-managing -- it starts and stops the server it needs -- so no manual setup
is required:

```sh
npm run test:integration -w apps/cli   # SFTP adapter driven over a loopback server
npm run test:integration -w apps/web
npm run test:browser     -w apps/web   # cross-impl vectors + live exchange, real Chromium
```

The native SFTP backends and hardened profiles, the console sentinel, the
warm-server inner loop, and the browser-suite plumbing are in
[docs/TESTING.md](docs/TESTING.md).

### Coverage

Coverage is an informational report (`npm run coverage`), not part of `npm test`
and not a CI gate. There is deliberately no global percentage threshold -- do
not add one. Rationale and what the report covers: [docs/TESTING.md](docs/TESTING.md#coverage).

## Code Conventions

- **TypeScript** with strict mode throughout. Avoid `any`; if you must use it, add a comment explaining why.
- **Naming**: `camelCase` in TypeScript; `snake_case` in user-facing JSON and YAML files. Semicolons required.
- **Comments**: write one only when the _why_ is non-obvious - a hidden constraint, subtle invariant, or known limitation. Do not restate what the code does. Multi-line `//` blocks are permitted for genuinely complex runtime constraints that cannot fit on one line.
- **Encode runtime invariants as checks, not prose**: a claim that something does not happen at runtime - a line that never fires, an unreachable branch, a callback that never runs - belongs in an executable check that fails when the claim breaks, not a comment or doc note that cannot; prose asserting a runtime fact rots silently, a check cannot lie. Cautionary example: a note that the ssh2-sftp-client "Global ... listener" console lines were "found NOT to fire" went stale when later host-key work made them fire (no library bump); the CLI integration console sentinel enforces that invariant as a check instead. A best-effort check must say so - a backstop is not a guarantee.
- **JSDoc**: `/** */` on all exports; `/** @internal */` (with no description) for test-only exports.
- **Validation**: define the TypeScript interface first, then derive the Zod schema with `z.ZodType<Interface>`. Apply `camelizeKeys` before Zod parsing so user-facing YAML/JSON remains `snake_case` while TypeScript sees `camelCase`.
- **Transport branching**: `connection.channel` is the discriminant. Use allowlists (not blocklists) in `exchange.ts` and `protocol.ts` so a new channel is rejected unless explicitly added.
- **New channels**: add a discriminant value and config interface to `packages/core/src/config/connection.ts`, update the `ConnectionConfig` union, then update the guards. See existing `sftp`, `webrtc`, and `filedrop` entries for examples.
- **Security primitives**: extract shared cryptographic helpers as soon as they are correct and tested. Do not defer to a "second caller" rule for security code - silent independent re-implementations are a failure mode.
- **Sensitive-file parsing**: parse any secret-bearing config or credential document -- the CLI's operator config (`psilink.yaml`), key file (`.psilink.key`), and signing identity, and the web app's imported YAML/JSON linkage-terms document (untrusted free text an operator could paste a secret into) -- only through the shared sensitive-parse chokepoint in `@psilink/core` (`parseSensitiveYaml` / `parseSensitiveJson`), which `apps/cli/src/sensitiveFile.ts` re-exports, never a raw YAML/JSON parser. An ESLint rule enforces this: raw YAML parsers are banned across `packages/core/src`, `apps/cli/src`, and `apps/web/src`, and raw `JSON.parse` in `apps/cli/src` (the web app's JSON half is deferred until the browser secret-store work, its current JSON being non-secret peer/wire data); the rule message names the entry points and the one-line `eslint-disable` opt-out for a non-sensitive parse. Rationale and the leak channels: the module header and `docs/SECURITY_DESIGN.md` (Diagnostics hardening).
- **Untrusted-JSON parsing**: parse any untrusted JSON -- a partner wire frame, a transport-controlled file, an invitation token -- only through the `packages/core/src/utils/boundedJson.ts` chokepoint (`parseBoundedJson`), never a raw `JSON.parse` -- an ESLint rule enforces this across `@psilink/core` (its message names the entry point and the one-line `eslint-disable` opt-out for a trusted parse). The chokepoint structurally bounds the body before `JSON.parse` so a pathological object or array cannot drive the parser into an uncatchable, process-terminating abort. Rationale: the module header and `docs/spec/CHANNEL_SECURITY.md` (Application-layer parsed-input bounds).
- **CLI durations**: a duration-valued CLI flag parses its value through the shared `parseDuration` / human-readable `<int><unit>` format (`apps/cli/src/util/duration.ts`), read from args via `durationFlagSeconds` (`apps/cli/src/util/cli.ts`), never a bare integer of seconds, so the accepted value syntax stays consistent across flags.
- **Windows paths**: support wherever a user can supply a local path. Normalize backslashes on ingestion; use `fileURLToPath` for `file://` URLs.
- **Markdown**: soft line wrapping, single space after periods, ASCII punctuation (`-` not em-dash, `->` not arrow character).

Linting and formatting are enforced by CI. Run locally before pushing:

```sh
npm run typecheck
npm run lint
npm run format
```

## Documentation

PSI-Link documentation is two-tier:

- `docs/` (overview) - conceptual and operational documents for program officers, security reviewers, compliance officers, IT staff, and contributors.
- `docs/spec/` - the technical specification tier: wire formats, byte encodings, normative constant values, protocol internals, and implementation-level design, for implementors and auditors. See [`docs/spec/README.md`](docs/spec/README.md) for the index and routing guide.

When behavior changes, update the matching tier:

- User-configurable or operational behavior -> the relevant overview doc in `docs/`.
- Wire format, protocol internals, or implementation-level spec -> the relevant `docs/spec/` file.
- A change touching both tiers updates both.

If you are writing a constant value, a byte/wire layout, an HKDF info string or other algorithm step, or the "would only need revisiting if..." rationale behind one of those, it belongs in `docs/spec/` - regardless of which doc you currently have open. Overview docs (`docs/`) stay conceptual and operational, including operational rationale such as the coverage-gate decision.

Overview docs must stay scannable: no multi-hundred-word paragraphs -- use subheadings and lists. When an edit lands in a section that is already a wall of text, restructure the section rather than growing a sentence in place.

Documentation-tier placement is in scope for code review: a reviewer flags spec-level detail written into a `docs/` overview doc.

## Changelog

`CHANGELOG.md` is reader-facing release notes for whoever runs or vets PSI-Link from outside this repo -- an operator deciding whether to upgrade, or a security reviewer -- not a second copy of the git history. For each change, ask who reads it and why they act on it.

- Add an entry for an observable change a reader acts on: a command, flag, or config field; a changed default, behavior, exit code, or wire/on-disk format; a breaking change; a perceptible performance change; a security-relevant change.
- Skip what no reader acts on: internal refactors, test/CI/tooling changes, `@psilink/core` API reshapes (the apps are its only consumer), and doc-only edits. If a refactor also changes one of the above, the observable part still gets an entry.
- One or two lines per entry, stating the observable change; push rationale and wire detail to `docs/`, `docs/spec/`, or the PR and link it with a trailing `See docs/...`.
- Group under Added / Changed / Deprecated / Removed / Fixed / Security; prefix a breaking change `BREAKING:`. Pre-release, keep security entries to the headline changes; record them more exhaustively after release.

## Commit Messages

- Imperative mood, present tense: "Fix key rotation after failed exchange", not "Fixed ..." or "Fixes ...".
- Subject line 50 characters or fewer.
- Include a body for non-trivial commits explaining motivation and context, not just what changed.

## Pull Request Process

1. For significant changes, open a draft issue on the Github project first to align on approach. Bug fixes and documentation improvements do not require a prior issue.
2. Keep pull requests focused - one logical change per PR.
3. Ensure typecheck, lint, format, and the relevant tests pass before marking the PR ready for review (CI enforces all four). Record what you ran and the coverage you added in the PR's Test plan, and resolve every line of the template Checklist.
4. Changes within the security-review scope -- cryptographic code, the channel-security controls, credential or disclosure surfaces, or a security-relevant dependency -- require explicit security review before merging (see [Dependency Policy](#dependency-policy) for the full enumeration).
5. Update documentation when behavior changes - see [Documentation](#documentation) for which tier. Add a `CHANGELOG.md` entry when the change is visible to an operator or a reviewer - see [Changelog](#changelog).
6. A maintainer will review and merge. Force-pushes to `main` are not permitted.

### Pull Request Description

Opening a PR populates [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md), whose inline comments explain each section and the writing conventions (ASCII, imperative mood, `##` headings, board-reference verbs). Fill in what applies; delete any optional section with nothing non-obvious to say -- keep small PRs small.

## Dependency Policy

A change requires explicit security review and maintainer approval before merging if it touches any of the following. This list is the trigger; [docs/SECURITY_DESIGN.md](docs/SECURITY_DESIGN.md) is the model behind it, consulted only to decide a case the list does not settle.

- Cryptographic code or its inputs: the PSI protocol, the X25519 key exchange / handshake / key schedule, token generation / rotation / derivation, or canonical encoding.
- The application-layer AEAD: encryption, the nonce / sequence scheme, or the integrity / replay / reordering / gap checks.
- The channel-hardening controls: the frame-size, directory-listing, liveness / timeout, connect-probe, and whole-exchange bounds, the web WebRTC data-channel inbound bound, plus the SFTP crash-safety and authenticated abort-marker controls.
- Credential and secret handling: how the key file, signing identity, or result CSV is written or permissioned; how secrets are stored, transmitted, logged, or referenced (the configuration `@path` resolution).
- Authentication and identity: the auth gate's fail-closed behavior, fingerprint / certificate pinning and verification, or token expiry and `token_max_age_days` enforcement.
- What is disclosed: any change to what is sent on the wire, logged, displayed, or written to disk, or to what the result reveals (cardinality, linkage terms, consent-surfaced fields).
- A security-relevant dependency (see Cryptographic dependencies, the SFTP stack, and the WebRTC stack below).

Modifying an existing control in these areas is in scope exactly as adding one is: a change that weakens or removes a guarantee triggers review no less than a new control does.

PSI-Link is licensed under [Apache 2.0](LICENSE.md); add third-party dependencies conservatively. For every new dependency:

1. Confirm the license permits Apache 2.0 distribution. Copyleft licenses (GPL, AGPL) are not compatible. The [Dependency Review workflow](.github/workflows/dependency_review.yaml) enforces this automatically for the strong-copyleft GPL/AGPL family via its `deny-licenses` blocklist, failing any PR that introduces a dependency under one. That gate is a backstop, not the whole rule: it fails only on a _declared_ denied SPDX id, so a passing check is not proof a dependency is clean -- one that ships no license metadata (or `NOASSERTION`) is reported but does not fail it. This review stays the authority for weak copyleft (LGPL, MPL), whose acceptability is linkage-dependent, and for any dependency whose license the action cannot resolve or that declares none (exempt a mis-flagged dependency with the workflow's `allow-dependencies-licenses` and clear it here).
2. Run `npm audit` and resolve any known vulnerabilities before merging.
3. Prefer packages that are actively maintained and publish a security policy.
4. If the package ships its own `NOTICE` file and is redistributed to end users, fold its attribution into the top-level [`NOTICE`](NOTICE).

**Cryptographic dependencies** - `@openmined/psi.js`, `@noble/curves`, and any AEAD, key-agreement, or key-derivation library - require explicit security review and maintainer approval before merging. These libraries underpin the privacy and integrity guarantees of every exchange. Dependency upgrades driven by security advisories take priority over feature work.

**The SFTP stack (`ssh2` / `ssh2-sftp-client`) and the WebRTC stack (`peerjs` / `peerjs-js-binarypack`)** are reached past their public APIs into internals, so each is exact-pinned (in `apps/cli/package.json` and `apps/web/package.json` respectively). Every bump is a deliberate, security-reviewed edit -- never an `npm audit fix` that slips in unreviewed -- and must re-verify the internal premises first. Why they are pinned, the premises, and the per-stack upgrade checklist: [docs/spec/DEPENDENCY_PINS.md](docs/spec/DEPENDENCY_PINS.md).

Per-dependency licenses are recorded authoritatively in the CycloneDX SBOM attached to each release - every direct and transitive dependency with its license; see [docs/RELEASES.md](docs/RELEASES.md#software-bill-of-materials-sbom). Attributions for redistributed and vendored components are in the top-level [`NOTICE`](NOTICE).

## Export Control

PSI-Link incorporates cryptographic software. Distribution may be subject to U.S. Export Administration Regulations (EAR). Most open-source cryptographic software qualifies for License Exception ENC under ECCN 5D002, but the exception requires a one-time notification to BIS and NSA. This notification is pending and will be completed before the 1.0 release. See [docs/COMPLIANCE.md](docs/COMPLIANCE.md#export-control-ear) for the full regulatory framing.

## Reporting Security Issues

Do not open a public issue for security vulnerabilities. See [SECURITY.md](SECURITY.md) for the private reporting process.

## Reporting Other Issues

Open a [GitHub issue](https://github.com/georgetown-mdi/jspsi/issues). Include the version (Docker image tag or `package.json` version), the operating system, and a minimal reproducing case.
