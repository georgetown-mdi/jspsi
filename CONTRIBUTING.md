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
| `docs/`          | Documentation, two tiers: `docs/` overview (conceptual/operational), `docs/spec/` technical |

## Prerequisites

- **Node.js** 26 or later (npm 10 or later is included)
- **Docker** for building the container image

The OpenMined PSI WebAssembly module is vendored at `lib/openmined-psi.js-2.0.6-seclink.1.tgz`. No Emscripten or native toolchain is required to work against it.

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

### Integration tests

Must pass before a PR merges to `main` or `staging`.

CLI. The suite stands up an SFTP server and drives the real SFTP adapter
against it over a loopback socket. It is self-managing -- a vitest `globalSetup`
on the integration project starts the server before the suite and stops it
after -- so no manual steps are required:

```sh
npm run test:integration -w apps/cli
```

By default the server runs in-process (an `ssh2.Server` on an ephemeral
loopback port serving a temporary directory), so each run -- and each worktree
-- is isolated with no shared port or state. Set `PSILINK_SFTP_BACKEND=native`
to run the same suite against a native OpenSSH `sshd` spawned as an
unprivileged child, exercising the adapter against a real server:

```sh
PSILINK_SFTP_BACKEND=native npm run test:integration -w apps/cli
```

The native backend runs hardened configurations real deployments use, selected
by `PSILINK_SFTP_NATIVE_PROFILE` (default `baseline`, the plain forced
`internal-sftp` config); the same conformance suite runs against each:

```sh
PSILINK_SFTP_BACKEND=native PSILINK_SFTP_NATIVE_PROFILE=restricted-crypto npm run test:integration -w apps/cli
```

- `restricted-crypto` -- a locked-down kex/cipher/MAC/host-key/pubkey policy,
  plus a test that a client offering only a key exchange the policy excludes (one
  OpenSSH allows by default) is refused.
- `rate-limited` -- connection and auth rate limits. The suite running under them
  is the coverage; there is no exceed-the-limit test (it would be CI-flaky).
- `allowlist` -- an explicit `user@host` allow matrix, plus a test asserting a
  valid key under a username other than the served user is rejected.
- `chroot` -- `ChrootDirectory` confinement, plus a test that a path outside the
  served root is unreachable from a chrooted session. It needs `sshd` running as
  root over a root-owned jail, so it runs only on Linux as root and is launched
  through a dedicated script that skips cleanly (exit 0, with a message)
  everywhere else:

```sh
# Linux only; skips cleanly elsewhere. The PATH forwarding lets npm and node
# resolve under sudo when secure_path would otherwise drop them (the CI leg uses
# the same form); a plain `sudo npm run ...` works where sudo keeps your PATH.
sudo --preserve-env=PATH env "PATH=$PATH" npm run test:integration:native-chroot -w apps/cli
```

Web (dev server managed automatically -- same pattern as the CLI integration tests):

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

If you are writing a constant value, a byte/wire layout, an HKDF info string or other algorithm step, or a "would only need revisiting if..." design rationale, it belongs in `docs/spec/` - regardless of which doc you currently have open. Overview docs (`docs/`) stay conceptual and operational.

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
- The channel-hardening controls: the frame-size, directory-listing, liveness / timeout, connect-probe, and whole-exchange bounds, plus the SFTP crash-safety and authenticated abort-marker controls.
- Credential and secret handling: how the key file, signing identity, or result CSV is written or permissioned; how secrets are stored, transmitted, logged, or referenced (the configuration `@path` resolution).
- Authentication and identity: the auth gate's fail-closed behavior, fingerprint / certificate pinning and verification, or token expiry and `token_max_age_days` enforcement.
- What is disclosed: any change to what is sent on the wire, logged, displayed, or written to disk, or to what the result reveals (cardinality, linkage terms, consent-surfaced fields).
- A security-relevant dependency (see Cryptographic dependencies and the SFTP stack below).

Modifying an existing control in these areas is in scope exactly as adding one is: a change that weakens or removes a guarantee triggers review no less than a new control does.

PSI-Link is licensed under [Apache 2.0](LICENSE.md); add third-party dependencies conservatively. For every new dependency:

1. Confirm the license permits Apache 2.0 distribution. Copyleft licenses (GPL, AGPL) are not compatible.
2. Run `npm audit` and resolve any known vulnerabilities before merging.
3. Prefer packages that are actively maintained and publish a security policy.
4. If the package ships its own `NOTICE` file and is redistributed to end users, fold its attribution into the top-level [`NOTICE`](NOTICE).

**Cryptographic dependencies** - `@openmined/psi.js`, `@noble/curves`, and any AEAD, key-agreement, or key-derivation library - require explicit security review and maintainer approval before merging. These libraries underpin the privacy and integrity guarantees of every exchange. Dependency upgrades driven by security advisories take priority over feature work.

**SFTP stack (`ssh2` / `ssh2-sftp-client`)** - the CLI's SFTP adapter (`apps/cli/src/connection/ssh2SftpAdapter.ts`) deliberately drives `ssh2` internals past the public `ssh2-sftp-client` API, so both packages are exact-pinned in `apps/cli/package.json`: every bump - including a security patch, which is then a deliberate edit rather than an `npm audit fix` that slips in unreviewed - must re-verify that coupling before it merges. Before raising either version, follow the [Upgrading the SFTP stack](#upgrading-the-sftp-stack-ssh2--ssh2-sftp-client) checklist below, which names the internal premises, the source files to re-read, and the contract-assertion test (run in CI by the CLI integration suite) that fails red on a lifecycle change.

Per-dependency licenses are recorded authoritatively in the CycloneDX SBOM attached to each release - every direct and transitive dependency with its license; see [docs/RELEASES.md](docs/RELEASES.md#software-bill-of-materials-sbom). Attributions for redistributed and vendored components are in the top-level [`NOTICE`](NOTICE).

## Upgrading the SFTP Stack (ssh2 / ssh2-sftp-client)

The channel-security bounds specified in [docs/spec/CHANNEL_SECURITY.md](docs/spec/CHANNEL_SECURITY.md) reach past the public `ssh2-sftp-client` API and drive ssh2 internals directly (`apps/cli/src/connection/ssh2SftpAdapter.ts`), so they rest on premises about ssh2's internal behavior that an upgrade can silently break. Re-verify the following on any `ssh2` or `ssh2-sftp-client` version bump, before the bump merges.

The internal assumptions the adapter relies on:

- ssh2's `Client.sftp()` strips its own setup-time `'error'` listener (and the `'exit'`/`'close'` ones) from the `SFTPWrapper` before handing it back, so after a real connect the wrapper carries zero `'error'` listeners until the adapter attaches its own. The whole crash fix is sound only while this holds; if ssh2 retains its listener the adapter's "no one else guards the wrapper" reasoning is false.
- ssh2 reports end-of-directory from the handle-based `readdir` as an `Error` whose `code` equals `STATUS_CODE.EOF` (numeric `1`), not as an empty success batch -- the EOF contract `list()`'s batch loop terminates on.
- `STATUS_CODE.EOF === 1` and `OPEN_MODE.WRITE | CREAT | EXCL === 0x2A`, the numeric SFTP constants the adapter hard-codes (it does not import them: ssh2 exposes their runtime values only from the internal `lib/protocol/SFTP.js`, not from its package entry point, and `@types/ssh2` types them only as a compile-time `sftp` namespace). These are fixed SFTPv3 wire-protocol values, so they are extremely unlikely to renumber, but confirm them against `STATUS_CODE`/`OPEN_MODE` in the source below if the surrounding code moves.
- `STATUS_CODE.FAILURE === 4` (`SSH_FX_FAILURE`), the third numeric SFTP constant the adapter hard-codes: `rename()` retries a transient server failure only on this status (the source still exists, so a re-issue is safe) and treats every other status as terminal, and `createExclusive` maps it to an `exists()`-disambiguated `EEXIST`. The premise is that ssh2-sftp-client surfaces a server `FAILURE` on its high-level `rename` as numeric `err.code === 4` -- it passes ssh2's raw status through `fmtError` onto `err.code`, the same `4` `createExclusive` reads from the raw `open` callback. If a future version remaps `rename`'s `err.code` to a non-numeric string (e.g. `ERR_GENERIC_CLIENT`) or renumbers `FAILURE`, the retry silently stops firing -- the transient-rename flake returns, with no correctness break; the `ssh2SftpAdapter` unit tests pin the numeric-`4` behavior.
- ssh2-sftp-client stores the raw wrapper on `this.sftp`, assigned once in its `'ready'` handler and otherwise only cleared, with no auto-reconnect that swaps it after `connect()` resolves.
- ssh2-sftp-client exposes the underlying ssh2 `Client` as `this.client`, and ssh2's `Client.setNoDelay(true)` toggles `TCP_NODELAY` on the live socket. `connect()` calls it once after the connection is established to disable Nagle's algorithm -- a per-round-trip latency optimization for the chatty rendezvous protocol (see board item 199674097). Unlike every other premise here this one carries no correctness weight: the call is guarded and non-fatal, so a future version that relocates the `Client` or drops `setNoDelay` makes the adapter log a warning and continue with Nagle enabled (slower, still correct) rather than fail.
- A malformed reply to the in-flight request itself is bounded by the adapter's wall-clock deadline, not by `cleanupRequests`, because ssh2 has already deleted the request from `_requests` by the time `doFatalSFTPError` runs: the `NAME` and `DATA` response handlers delete it unconditionally before the parse/check that calls `doFatalSFTPError`, and the `HANDLE` handler deletes it inside its malformed branch (on a defined request id) immediately before that call. All three leave nothing for `cleanupRequests` to fail. If a future ssh2 instead deleted after the fatal path (or stopped deleting in the `HANDLE` malformed branch), `cleanupRequests` would begin failing in-flight requests too - which would change the mechanism but not break it (the deadline still bounds the operation). The deadline must stay regardless; the `liveness` fault-injection unit test below proves the current ordering.
- ssh2-sftp-client's `put(src, dest)` pipes a non-Buffer `src` into the write stream (`_put`'s else-branch, `rdr.pipe(wtr)`), and that write stream consumes under ack-driven backpressure -- ssh2's `WriteStream._write` calls its stream callback (releasing the next pull) only after the server acknowledges the write. The `put` liveness idle window rests on both: the adapter hands `put` a Readable that streams the payload in `SFTP_PUT_PROGRESS_CHUNK_BYTES` (64 KiB) chunks and resets the window each time a chunk is pulled, so a withheld write ack stalls the pull and trips the window while a slow-but-progressing upload keeps resetting it. It rests further on ssh2's `SFTP.write` chaining a buffer larger than `_maxWriteLen` into multiple WRITE packets and firing the stream callback only after the *last* ack -- which is precisely *why* the source is chunked rather than handed over whole: a single whole-buffer write surfaces no progress until completion, making a large legitimate upload indistinguishable from a stall for its full duration. If a future version buffers a provided stream eagerly instead of piping it under backpressure, the window's progress signal would no longer track the server and the bound would need rework; if it merely acks per-sub-write incrementally, the chunking becomes redundant but harmless. This uses only the public stream interface (it does not drive the raw `SFTPWrapper`), so it adds no new internal coupling beyond these behavioral premises. The `ssh2SftpAdapter` unit tests pin the stall-fires and slow-but-progressing-does-not behaviors and byte-exact upload through the chunked source; the integration suite uploads real payloads through it.

Dependency source files to re-read on an upgrade:

- `node_modules/ssh2/lib/client.js`: `sftp()` and its inner `removeListeners()` / `onReady` -- confirm the setup-time `'error'` listener is still stripped before the wrapper is handed back.
- `node_modules/ssh2/lib/protocol/SFTP.js`: `doFatalSFTPError` (still emits `'error'` on the wrapper, then destroys and calls `cleanupRequests`), the `NAME` and `DATA` handlers (still delete the in-flight request from `_requests` unconditionally before the parse/check that calls `doFatalSFTPError`) and the `HANDLE` handler (still deletes inside its malformed branch, on a defined request id, immediately before that call), so `cleanupRequests` does not fail a reply-to-self in-flight request in any of the three cases; `STATUS_CODE` and `OPEN_MODE` (still the values above), and the handle-path `readdir` EOF contract; and `WriteStream._write` / `SFTP.write` (the stream callback still fires only after the server acks, and an over-`_maxWriteLen` write still chains into multiple packets acked at the end -- the ack-driven backpressure and no-incremental-progress premises the `put` idle window's chunking rests on).
- `node_modules/ssh2-sftp-client/src/index.js`: confirm the wrapper is still reached via `this.sftp` with the lifecycle above, that the underlying ssh2 `Client` is still held on `this.client` (the `setNoDelay` seam), that `rename` still passes the raw numeric status through `fmtError` onto `err.code` (so a server `SSH_FX_FAILURE` surfaces as `err.code === 4`, the premise the rename retry gates on), and that `_put` still pipes a non-Buffer `src` into the write stream (`rdr.pipe(wtr)`) rather than buffering it (the premise the `put` idle window's progress signal rests on).

Then run `npm run test:integration -w apps/cli` against the new version. The contract-assertion tests in `apps/cli/test/integration/sftpConnection.test.ts` pin the zero-listener premise from both sides (a raw ssh2-sftp-client connect leaves zero `'error'` listeners on the wrapper; an adapter connect leaves exactly one), so a lifecycle change fails those tests red rather than regressing the crash guard silently.

## Export Control

PSI-Link incorporates cryptographic software. Distribution may be subject to U.S. Export Administration Regulations (EAR). Most open-source cryptographic software qualifies for License Exception ENC under ECCN 5D002, but the exception requires a one-time notification to BIS and NSA. This notification is pending and will be completed before the 1.0 release. See [docs/COMPLIANCE.md](docs/COMPLIANCE.md#export-control-ear) for the full regulatory framing.

## Reporting Security Issues

Do not open a public issue for security vulnerabilities. See [SECURITY.md](SECURITY.md) for the private reporting process.

## Reporting Other Issues

Open a [GitHub issue](https://github.com/georgetown-mdi/jspsi/issues). Include the version (Docker image tag or `package.json` version), the operating system, and a minimal reproducing case.
