---
title: "Contributing to PSI-Link"
---

# Contributing to PSI-Link

Thank you for your interest in contributing. PSI-Link handles personally identifiable information in high-stakes environments; correctness, security, and auditability matter more than velocity. Please read this document before opening a pull request.

## Repository Structure

PSI-Link is organized as an npm workspaces monorepo.

| Path             | Description                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------ |
| `packages/core/` | Shared library: PSI primitive, exchange orchestration, file-sync transport, config schemas |
| `apps/cli/`      | Node.js CLI (`psilink`), built with Rollup, distributed as a Docker image                  |
| `apps/web/`      | TanStack Start (React/SSR) web app with built-in PeerJS peer-coordination server           |
| `docs/`          | Technical and operational documentation                                                    |

## Prerequisites

- **Node.js** 26 or later (npm 10 or later is included)
- **Docker** for CLI integration tests and building the container image

The OpenMined PSI WebAssembly module is vendored at `lib/openmined-psi.js-2.0.6.tgz`. No Emscripten or native toolchain is required to work against it.

## Development Setup

```sh
git clone git@github.com:georgetown-mdi/jspsi.git psilink
cd psilink
npm install
npm run build -w packages/core   # core must be built before the apps
```

No additional environment variables are required for local development. SFTP integration tests read connection parameters from environment variables; see `apps/cli/test/integration/` for the expected names.

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

### Integration tests

Must pass before a PR merges to `main` or `staging`.

CLI (requires Docker; spins up a local SFTP server, image `atmoz/sftp`). The
container is managed automatically -- `test:integration` brings it up before the
suite and tears it down after (a vitest `globalSetup` on the integration
project), generating the host keys, storage dir, and `.env` (all gitignored) on
first run if they are absent. No manual steps are required:

```sh
npm run test:integration -w apps/cli    # auto-manages the SFTP container
```

For a faster inner loop you can keep a warm container running across many runs:
`test:integration` detects an already-running container, reuses it, and leaves
it up rather than tearing it down.

```sh
npm run test:container:up   -w apps/cli    # start (and keep) the SFTP server
npm run test:integration    -w apps/cli    # reuses the running container
npm run test:container:down -w apps/cli    # stop it when done
```

The `:up`/`:down` scripts and the `globalSetup` both wrap `docker compose` with
the `--env-file` and run from the checkout root, so the container always picks
up that checkout's `COMPOSE_PROJECT_NAME` and `SFTP_PORT` (default 2222) --
never run the raw `docker compose` command, which would skip the env file and
default the Compose project name to the directory (`container`), colliding on
the port. The `make-worktree` command gives each worktree a unique project and a
free port, so checkouts can run the container concurrently.

Web (dev server managed automatically -- same pattern as the CLI container):

```sh
npm run test:integration -w apps/web    # auto-starts, waits for, and stops the dev server
```

For a faster inner loop you can keep a warm server running across many runs:
`test:integration` detects an already-running server, reuses it, and leaves it
up rather than stopping it.

```sh
npm run dev           -w apps/web    # start (and keep) the dev server in a terminal
npm run test:integration -w apps/web    # reuses the running server
# stop the dev server in the terminal when done (Ctrl-C)
```

The browser suite -- cross-implementation byte-vector checks, a live PSI
exchange, and React component tests such as the accept consent gate, run in real
Chromium via Playwright -- self-manages the dev server the same way: it stands up
the PeerJS coordination server the exchange needs, reuses a running `npm run
dev`, and otherwise starts and stops its own.

```sh
npm run test:browser -w apps/web    # auto-starts, waits for, and stops the dev server
```

It is not part of CI; run it locally when changing the web PSI exchange, the
cross-implementation vectors, or a web UI component it covers (such as the accept
consent gate).

## Code Conventions

- **TypeScript** with strict mode throughout. Avoid `any`; if you must use it, add a comment explaining why.
- **Naming**: `camelCase` in TypeScript; `snake_case` in user-facing JSON and YAML files. Semicolons required.
- **Comments**: write one only when the _why_ is non-obvious - a hidden constraint, subtle invariant, or known limitation. Do not restate what the code does. Multi-line `//` blocks are permitted for genuinely complex runtime constraints that cannot fit on one line.
- **JSDoc**: `/** */` on all exports; `/** @internal */` (with no description) for test-only exports.
- **Validation**: define the TypeScript interface first, then derive the Zod schema with `z.ZodType<Interface>`. Apply `camelizeKeys` before Zod parsing so user-facing YAML/JSON remains `snake_case` while TypeScript sees `camelCase`.
- **Transport branching**: `connection.channel` is the discriminant. Use allowlists (not blocklists) in `exchange.ts` and `protocol.ts` so a new channel is rejected unless explicitly added.
- **New channels**: add a discriminant value and config interface to `packages/core/src/config/connection.ts`, update the `ConnectionConfig` union, then update the guards. See existing `sftp`, `webrtc`, and `filedrop` entries for examples.
- **Security primitives**: extract shared cryptographic helpers as soon as they are correct and tested. Do not defer to a "second caller" rule for security code - silent independent re-implementations are a failure mode.
- **Windows paths**: support wherever a user can supply a local path. Normalize backslashes on ingestion; use `fileURLToPath` for `file://` URLs.
- **Markdown**: soft line wrapping, single space after periods, ASCII punctuation (`-` not em-dash, `->` not arrow character).

Linting and formatting are enforced by CI. Run locally before pushing:

```sh
npm run typecheck
npm run lint
npm run format
```

## Commit Messages

- Imperative mood, present tense: "Fix key rotation after failed exchange", not "Fixed ..." or "Fixes ...".
- Subject line 50 characters or fewer.
- Include a body for non-trivial commits explaining motivation and context, not just what changed.

## Pull Request Process

1. For significant changes, open a draft issue on the Github project first to align on approach. Bug fixes and documentation improvements do not require a prior issue.
2. Keep pull requests focused - one logical change per PR.
3. Ensure all tests pass and lint is clean before marking the PR ready for review. Include this as a checklist in the PR.
4. Changes to cryptographic code require explicit security review before merging (see Dependency Policy).
5. Update `docs/` when behavior changes. Update `CHANGELOG.md` with a line in the `[Unreleased]` section.
6. A maintainer will review and merge. Force-pushes to `main` are not permitted.

### Pull Request Description

Opening a PR populates [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md), whose inline comments explain each section and the writing conventions (ASCII, imperative mood, `##` headings, board-reference verbs). Fill in what applies; delete any optional section with nothing non-obvious to say -- keep small PRs small.

## Dependency Policy

PSI-Link is licensed under [Apache 2.0](LICENSE.md); add third-party dependencies conservatively. For every new dependency:

1. Confirm the license permits Apache 2.0 distribution. Copyleft licenses (GPL, AGPL) are not compatible.
2. Run `npm audit` and resolve any known vulnerabilities before merging.
3. Prefer packages that are actively maintained and publish a security policy.
4. If the package ships its own `NOTICE` file and is redistributed to end users, fold its attribution into the top-level [`NOTICE`](NOTICE).

**Cryptographic dependencies** - `@openmined/psi.js`, `@noble/curves`, and any AEAD, key-agreement, or key-derivation library - require explicit security review and maintainer approval before merging. These libraries underpin the privacy and integrity guarantees of every exchange. Dependency upgrades driven by security advisories take priority over feature work.

**SFTP stack (`ssh2` / `ssh2-sftp-client`)** - the CLI's SFTP adapter (`apps/cli/src/connection/ssh2SftpAdapter.ts`) deliberately drives `ssh2` internals past the public `ssh2-sftp-client` API, so both packages are exact-pinned in `apps/cli/package.json`: every bump - including a security patch, which is then a deliberate edit rather than an `npm audit fix` that slips in unreviewed - must re-verify that coupling before it merges. Before raising either version, follow the upgrade checklist in [docs/SECURITY_DESIGN.md](docs/SECURITY_DESIGN.md#upgrading-the-sftp-stack-ssh2--ssh2-sftp-client) ("Upgrading the SFTP stack"), which names the internal premises, the source files to re-read, and the contract-assertion test (run in CI by the CLI integration suite) that fails red on a lifecycle change.

Per-dependency licenses are recorded authoritatively in the CycloneDX SBOM attached to each release - every direct and transitive dependency with its license; see [docs/RELEASES.md](docs/RELEASES.md#software-bill-of-materials-sbom). Attributions for redistributed and vendored components are in the top-level [`NOTICE`](NOTICE).

## Export Control

PSI-Link incorporates cryptographic software. Distribution may be subject to U.S. Export Administration Regulations (EAR). Most open-source cryptographic software qualifies for License Exception ENC under ECCN 5D002, but the exception requires a one-time notification to BIS and NSA. This notification is pending and will be completed before the 1.0 release. See [docs/COMPLIANCE.md](docs/COMPLIANCE.md#export-control-ear) for the full regulatory framing.

## Reporting Security Issues

Do not open a public issue for security vulnerabilities. See [SECURITY.md](SECURITY.md) for the private reporting process.

## Reporting Other Issues

Open a [GitHub issue](https://github.com/georgetown-mdi/jspsi/issues). Include the version (Docker image tag or `package.json` version), the operating system, and a minimal reproducing case.
