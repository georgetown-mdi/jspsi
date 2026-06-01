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

### Core library

```sh
npm run build -w packages/core
```

Rebuild after any change to `packages/core`; both applications depend on its compiled output.

### CLI application

```sh
npm run build -w apps/cli
```

Output is written to `apps/cli/dist/`. The Docker image is built separately; see [docs/RELEASES.md](docs/RELEASES.md).

### Web application

```sh
npm run build -w apps/web
```

## Testing

```sh
npm test -w packages/core
npm run test:unit -w apps/cli
npm run test:unit -w apps/web
```

A single test file:

```sh
npx vitest run path/to/file.test.ts
```

### Integration tests

Integration tests must pass before a pull request is merged into `main` or `staging`.

#### CLI application

Integration tests for the CLI require Docker and spin up a local SFTP server:

```sh
docker compose -f apps/cli/test/container/compose.yaml up -d
npm run test:integration -w apps/cli
```

The Docker compose runs an SFTP server under the container name `sftp-1` and image name `atmoz/sftp`.

#### Web application

Web integration tests require the development server to be running:

```sh
npm run dev -w apps/web
```

This starts a foreground web server process which listens on port 3000.

## Code Conventions

- **TypeScript** with strict mode throughout. Avoid `any`; if you must use it, add a comment explaining why.
- **Naming**: `camelCase` in TypeScript; `snake_case` in user-facing JSON and YAML files. Semicolons required.
- **Comments**: write one only when the _why_ is non-obvious — a hidden constraint, subtle invariant, or known limitation. Do not restate what the code does. Multi-line `//` blocks are permitted for genuinely complex runtime constraints that cannot fit on one line.
- **JSDoc**: `/** */` on all exports; `/** @internal */` (with no description) for test-only exports.
- **Validation**: define the TypeScript interface first, then derive the Zod schema with `z.ZodType<Interface>`. Apply `camelizeKeys` before Zod parsing so user-facing YAML/JSON remains `snake_case` while TypeScript sees `camelCase`.
- **Transport branching**: `connection.channel` is the discriminant. Use allowlists (not blocklists) in `exchange.ts` and `protocol.ts` so a new channel is rejected unless explicitly added.
- **New channels**: add a discriminant value and config interface to `packages/core/src/config/connection.ts`, update the `ConnectionConfig` union, then update the guards. See existing `sftp`, `webrtc`, and `filedrop` entries for examples.
- **Security primitives**: extract shared cryptographic helpers as soon as they are correct and tested. Do not defer to a "second caller" rule for security code — silent independent re-implementations are a failure mode.
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

## Dependency Policy

Add third-party dependencies conservatively. For every new dependency:

1. Confirm the license is compatible with Apache 2.0 (see License Compliance below).
2. Run `npm audit` and resolve any known vulnerabilities before merging.
3. Prefer packages that are actively maintained and publish a security policy.

**Cryptographic dependencies** — `@openmined/psi.js`, `@noble/curves`, and any AEAD, PAKE, or key-derivation library — require explicit security review and maintainer approval before merging. These libraries underpin the privacy and integrity guarantees of every exchange. Dependency upgrades driven by security advisories take priority over feature work.

## Open Source License Compliance

PSI-Link is licensed under [Apache 2.0](LICENSE.md). Every dependency must be under a license that permits Apache 2.0 distribution. Copyleft licenses (GPL, AGPL) are not compatible.

Key existing dependencies:

| Dependency                      | License                                | Notes                                                                            |
| ------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------- |
| `@openmined/psi.js`             | Apache 2.0                             | Vendored WASM; wraps Google Private Join and Compute                             |
| Google Private Join and Compute | Apache 2.0                             | Underlying C++ PSI implementation                                                |
| BoringSSL                       | OpenSSL License / SSLeay License / ISC | Used by Private Join and Compute; Google's fork of OpenSSL, no numbered releases |
| `@noble/curves`                 | MIT                                    | Elliptic-curve operations (P-256)                                                |
| PeerJS                          | MIT                                    | Peer coordination in web application                                             |
| `ssh2-sftp-client`              | MIT                                    | SFTP transport in CLI                                                            |

When Apache 2.0 dependencies include their own `NOTICE` file, their attribution must be incorporated into the top-level `NOTICE` file in this repository.

## Export Control

PSI-Link incorporates cryptographic software. Distribution may be subject to U.S. Export Administration Regulations (EAR). Most open-source cryptographic software qualifies for License Exception ENC under ECCN 5D002, but the exception requires a one-time notification to BIS and NSA. This notification is pending and will be completed before the 1.0 release. See [docs/COMPLIANCE.md](docs/COMPLIANCE.md#export-control-ear) for the full regulatory framing.

## Reporting Security Issues

Do not open a public issue for security vulnerabilities. See [SECURITY.md](SECURITY.md) for the private reporting process.

## Reporting Other Issues

Open a [GitHub issue](https://github.com/georgetown-mdi/jspsi/issues). Include the version (Docker image tag or `package.json` version), the operating system, and a minimal reproducing case.
