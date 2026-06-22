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

A standing console sentinel guards the CLI integration suite: it wraps `console`
directly and fails a test file at `afterAll` on any `console.log`/`warn`/`error`
that no allowlist matcher accepts (the inverse of blanket silencing, and the one
check that sees third-party `console.*` which the loglevel-based
`withCapturedLogs` cannot). If your change makes the suite emit new console
output, the fix is to eliminate it at the source -- route it through the logger
or assert it under `withCapturedLogs`; accept it as intended only by adding a
matcher to the allowlist in `apps/cli/test/integration/consoleAllowlist.ts`, a
visible edit a reviewer sees. A matcher that never fires across a run is reported
at teardown so the allowlist cannot accumulate dead entries.

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

It runs in CI as part of the web build-and-test gate (`eb_build_and_test.yaml`),
which provisions Chromium on the runner; run it locally too when changing the web
PSI exchange, the cross-implementation vectors, or a web UI component it covers
(such as the accept consent gate).

## Code Conventions

- **TypeScript** with strict mode throughout. Avoid `any`; if you must use it, add a comment explaining why.
- **Naming**: `camelCase` in TypeScript; `snake_case` in user-facing JSON and YAML files. Semicolons required.
- **Comments**: write one only when the _why_ is non-obvious - a hidden constraint, subtle invariant, or known limitation. Do not restate what the code does. Multi-line `//` blocks are permitted for genuinely complex runtime constraints that cannot fit on one line.
- **Encode runtime invariants as checks, not prose**: a claim that something does not happen at runtime - a line that never fires, an unreachable branch, a callback that never runs - belongs in an executable check that fails when the claim breaks, not a comment or doc note that cannot. Prose asserting a runtime fact rots silently; a check cannot lie. Cautionary example: a note that the ssh2-sftp-client "Global ... listener" console lines were "found NOT to fire" went stale when later host-key work made them fire, with no library bump involved; the CLI integration console sentinel (whose reviewable allowlist is `apps/cli/test/integration/consoleAllowlist.ts`) now enforces that invariant as a check instead. Where the check can only be best-effort - e.g. an async-late settle that a finite `afterAll` cannot wait out - say so: a backstop is not a guarantee, and the executable form must not reintroduce the overclaim it replaced (here the real guarantee is that the adapter routes those lines to the logger at the source, not that the sentinel is certain to catch them late).
- **JSDoc**: `/** */` on all exports; `/** @internal */` (with no description) for test-only exports.
- **Validation**: define the TypeScript interface first, then derive the Zod schema with `z.ZodType<Interface>`. Apply `camelizeKeys` before Zod parsing so user-facing YAML/JSON remains `snake_case` while TypeScript sees `camelCase`.
- **Transport branching**: `connection.channel` is the discriminant. Use allowlists (not blocklists) in `exchange.ts` and `protocol.ts` so a new channel is rejected unless explicitly added.
- **New channels**: add a discriminant value and config interface to `packages/core/src/config/connection.ts`, update the `ConnectionConfig` union, then update the guards. See existing `sftp`, `webrtc`, and `filedrop` entries for examples.
- **Security primitives**: extract shared cryptographic helpers as soon as they are correct and tested. Do not defer to a "second caller" rule for security code - silent independent re-implementations are a failure mode.
- **Sensitive-file parsing**: parse any operator config or credential file (`psilink.yaml`, `.psilink.key`, the signing identity) only through the `apps/cli/src/sensitiveFile.ts` chokepoint, never a raw YAML/JSON parser -- an ESLint rule enforces this (its message names the entry points and the one-line `eslint-disable` opt-out for a non-sensitive parse). Rationale and the leak channels: the module header and `docs/SECURITY_DESIGN.md` (Diagnostics hardening).
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

**SFTP stack (`ssh2` / `ssh2-sftp-client`)** - the CLI's SFTP adapter (`apps/cli/src/connection/ssh2SftpAdapter.ts`) deliberately drives `ssh2` internals past the public `ssh2-sftp-client` API, so both packages are exact-pinned in `apps/cli/package.json`: every bump - including a security patch, which is then a deliberate edit rather than an `npm audit fix` that slips in unreviewed - must re-verify that coupling before it merges. Before raising either version, follow the [Upgrading the SFTP stack](#upgrading-the-sftp-stack-ssh2--ssh2-sftp-client) checklist below, which names the internal premises, the source files to re-read, and the contract-assertion test (run in CI by the CLI integration suite) that fails red on a lifecycle change.

**WebRTC stack (`peerjs` / `peerjs-js-binarypack`)** - the web data-channel inbound bound (`apps/web/src/psi/boundedReassembly.ts`) reaches past the public `DataConnection` API into PeerJS reassembly/unpack internals and parses the `peerjs-js-binarypack` wire format directly, exactly the kind of internal coupling the SFTP stack pins for. Both packages are therefore exact-pinned in `apps/web/package.json` - `peerjs-js-binarypack` is declared there directly (not left a floating transitive of `peerjs`) precisely because the bound parses its wire format, the same reason `ssh2` is pinned directly in `apps/cli/package.json` though it is reached through `ssh2-sftp-client`. Both are pulled out of the routine `non-critical` Dependabot batch into a reviewed `webrtc-stack` group (`.github/dependabot.yml`), so a bump is a deliberate, reviewed edit rather than an `npm audit fix` or grouped minor/patch PR that slips in unreviewed. Before raising either version, follow the [Upgrading the PeerJS stack](#upgrading-the-peerjs-stack-peerjs--peerjs-js-binarypack) checklist below, which names the internal premises, the source files to re-read, and the install-time check and tests that fail loud on a premise change.

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
- A host-key verification rejection (`hostVerifier` calling `verify(false)`, from either `open()` verifier in core's `fileSyncConnection` -- the pinned-key enforce path on a mismatch, or the no-pin fail-closed default) surfaces as an `Error` whose message contains the fragment `Host denied`, with no machine-readable `code` set. `connect()`'s retry predicate matches that fragment to treat the rejection as terminal -- a non-matching (or absent) pin never becomes a matching one, so retrying only re-runs the key exchange against the same untrusted host. If a future version renames the fatal-handshake message (it originates in ssh2's `kex.js` as `Host denied (verification failed)`), the predicate stops firing and a host-key failure is retried `maxReconnectAttempts` times before failing with the same outcome -- slower and noisier, but no security regression, since core's `fileSyncConnection` re-wraps the same rejection into its `SFTP host-key verification failed:` message regardless. Confirm the fragment still appears on the rejection error if either package is bumped.
- The first-use host-key probe (`fileSyncConnection`'s `probeHostKeyFingerprint`) and the `settleVerify` guard around every verifier verdict rest on four ssh2 internal behaviors, all security-relevant. (1) ssh2 invokes the `hostVerifier` at host-key verification and reaches userauth -- credential transmission -- ONLY after `verify(true)`, so `verify(false)` aborts the handshake before any password/private key is sent; this is what lets the probe connect with credentials present in its options yet never present them to an unverified host. (2) Returning `undefined` from the verifier (our `void` async callback) parks the handshake pending the async verdict. (3) ssh2's `readyTimeout` stays armed across that park, so the probe's use of the raw (unbounded) transport is still time-bounded. (4) A late `verify()` against an already-torn-down protocol throws because `doFatalError` nulls `protocol._destruct`; `settleVerify` swallows exactly that throw so a teardown-race refusal cannot become an unhandled rejection -- it never swallows a live verdict. If a future version reached userauth before the verifier, transmitted credentials despite `verify(false)`, stopped arming `readyTimeout` until after verification, or changed teardown so a late `verify()` no longer throws, re-evaluate: the first three are security regressions (credentials to an unverified host, or an unbounded probe), the last only makes `settleVerify`'s guard unnecessary. Also note `keyBlob` is a Buffer slice view with a meaningful `byteOffset`/`byteLength` (ssh2's `bufferSlice`); `hostKeyBlob` carries those through, because a bare `new Uint8Array(keyBlob.buffer)` would hash the whole pooled buffer and compute the wrong fingerprint.
- ssh2-sftp-client's constructor takes the `error`/`end`/`close` event callbacks as its second positional argument and runs them through `globalListener`, which invokes a callback only for an event the high-level client did not itself initiate (its `endCalled` / `*Handled` guard) and performs its own handled-flag bookkeeping and `this.sftp` teardown regardless of the callback body. The adapter passes explicit callbacks there to route those out-of-band ssh2-`Client` events to its project logger -- `error` at error level, the benign first-use-probe / `verify(false)`-rejection `end`/`close` at trace -- instead of the library's default `console.error` / `console.log` (whose bare `Global ... listener` lines otherwise leak past the logger and the suite's log-level controls). The `error` message is server-controlled (ssh2 builds it from the `SSH_MSG_DISCONNECT` description), so it is rendered through `sanitizeErrorForDisplay` -- escaped against log injection and run through the PEM/key redaction backstop -- before it reaches the logger and any `--log-file`; on a bump, confirm no credential can ride a `Client`-level `error` to this sink (today none can). The routing is observational only: it changes where the diagnostic goes, never control flow. If a bump changes the constructor signature, drops the second-argument callbacks, or makes a callback load-bearing (e.g. moves the `this.sftp` clear into the `close` body), re-verify; the worst case is the cosmetic console lines returning, not a correctness break.

Dependency source files to re-read on an upgrade:

- `node_modules/ssh2/lib/client.js`: `sftp()` and its inner `removeListeners()` / `onReady` -- confirm the setup-time `'error'` listener is still stripped before the wrapper is handed back.
- `node_modules/ssh2/lib/protocol/SFTP.js`: `doFatalSFTPError` (still emits `'error'` on the wrapper, then destroys and calls `cleanupRequests`), the `NAME` and `DATA` handlers (still delete the in-flight request from `_requests` unconditionally before the parse/check that calls `doFatalSFTPError`) and the `HANDLE` handler (still deletes inside its malformed branch, on a defined request id, immediately before that call), so `cleanupRequests` does not fail a reply-to-self in-flight request in any of the three cases; `STATUS_CODE` and `OPEN_MODE` (still the values above), and the handle-path `readdir` EOF contract; and `WriteStream._write` / `SFTP.write` (the stream callback still fires only after the server acks, and an over-`_maxWriteLen` write still chains into multiple packets acked at the end -- the ack-driven backpressure and no-incremental-progress premises the `put` idle window's chunking rests on).
- `node_modules/ssh2-sftp-client/src/index.js`: confirm the wrapper is still reached via `this.sftp` with the lifecycle above, that the underlying ssh2 `Client` is still held on `this.client` (the `setNoDelay` seam), that `rename` still passes the raw numeric status through `fmtError` onto `err.code` (so a server `SSH_FX_FAILURE` surfaces as `err.code === 4`, the premise the rename retry gates on), and that `_put` still pipes a non-Buffer `src` into the write stream (`rdr.pipe(wtr)`) rather than buffering it (the premise the `put` idle window's progress signal rests on); and that the constructor still accepts the `error`/`end`/`close` callbacks as its second positional argument, run through `globalListener`, which still does the handled-flag and `this.sftp` bookkeeping itself (the seam the adapter routes off the console).
- `node_modules/ssh2/lib/protocol/kex.js`: confirm a host-denied handshake failure still throws with a message containing `Host denied` (the fragment `connect()`'s terminal-on-host-key-rejection retry predicate matches, since ssh2 sets no `code` on it); confirm the `hostVerifier` is still invoked at host-key verification with `service('ssh-userauth')` reached only afterward via `onHandshakeComplete` (the credential-non-disclosure premise the probe rests on), and that returning `undefined` from the verifier still parks the handshake pending the async verdict.
- `node_modules/ssh2/lib/client.js`: confirm `readyTimeout` is still armed at socket connect and not cleared while an async `hostVerifier` is parked (it bounds the probe's raw, budget-unwrapped transport).
- `node_modules/ssh2/lib/protocol/Protocol.js` / `protocol/utils.js`: confirm `doFatalError` still nulls `protocol._destruct`, so a late `verify()` on an already-torn-down protocol throws -- the only throw `settleVerify` swallows; if teardown stops throwing there, `settleVerify`'s guard becomes unnecessary (not unsafe).

Then run `npm run test:integration -w apps/cli` against the new version. The contract-assertion tests in `apps/cli/test/integration/sftpConnection.test.ts` pin the zero-listener premise from both sides (a raw ssh2-sftp-client connect leaves zero `'error'` listeners on the wrapper; an adapter connect leaves exactly one), so a lifecycle change fails those tests red rather than regressing the crash guard silently.

## Upgrading the PeerJS Stack (peerjs / peerjs-js-binarypack)

The web WebRTC data-channel inbound bound specified in [docs/spec/CHANNEL_SECURITY.md](docs/spec/CHANNEL_SECURITY.md) reaches past the public `DataConnection` API into PeerJS reassembly/unpack internals and parses the `peerjs-js-binarypack` wire format directly (`apps/web/src/psi/boundedReassembly.ts`), so it rests on premises about both packages' internal behavior that an upgrade can silently break. Re-verify the following on any `peerjs` or `peerjs-js-binarypack` version bump, before the bump merges.

The internal assumptions the bound relies on:

- The binary/chunked `DataConnection` class -- the one `peer.connect` and an incoming connection use by default -- exposes `_handleChunk` (reassembling chunk slices keyed by `__peerData` into `_chunkedData`, deleting the entry on completion), `_handleDataMessage` (the sole point each frame is `unpack`ed: an unchunked frame directly, the reassembled buffer via the completion recursion), and `_chunkedData` (the per-id partial store). `assertChunkReassemblySupported` checks all three exist at install time, so a rename or removal fails loud. These three are specific to the binarypack (Binary) serializer class; the Cbor/MsgPack/JSON/None connection classes do not chunk and lack `_chunkedData`/`_handleChunk`, so a default-serializer change to a non-chunking class trips the assert. The residual to re-verify BY HAND, because the assert cannot catch it: a future serializer that also exposes these three names but uses a different (non-binarypack) wire format would pass the assert while the marker scan parses the wrong format -- confirm `peer.connect` still defaults to the binarypack Binary serializer. A marker misparse itself over-charges (rejects, fail-closed) or runs the cursor off the end (delegated to PeerJS, which errors), never under-counting, but the chunk-byte accounting could mismatch, so this is a re-verify premise, not a silent-safe one.
- The chunk envelope shape `_handleChunk` consumes: `__peerData` (the message id shared by every chunk of a frame), `n` (chunk index), `total` (chunk count), `data` (slice bytes). The byte/chunk accounting keys on `__peerData`; a rename collapses every chunk to one in-flight entry -- which over-rejects (fail-safe), not fail-open -- but is unverified by the assert, so confirm the field names on a bump.
- The BinaryPack marker dispatch the scan mirrors (`peerjs-js-binarypack`'s `Unpacker.unpack`): fixint/fixraw/fixstr/fixarray/fixmap and the `0xc0`-`0xdf` markers, maps declaring two child values per pair, the raw-vs-str split at `0xa0`/`0xb0`, the fixed scalar skip widths and the `u16`/`u32` length-prefix widths, and `unpack_string`/`unpack_raw` advancing the buffer cursor by exactly the declared `size` regardless of how the payload decodes. A format change either over-charges (rejecting early, fail-closed) or runs the cursor off the end (treated as malformed and delegated), so it weakens the scan's precision rather than disabling it, but re-verify the marker table on a `peerjs-js-binarypack` bump.
- `unpack`'s past-the-end read returns `0` (a positive fixint) rather than throwing -- the `new Array(N)` zero-fill the scan's "no container declares more elements than the bytes that follow it" check closes -- while the length-prefixed `read()` path (raw/str payloads) throws on underrun, the cursor-underrun-is-malformed path the scan catches and delegates. If a future version throws on the array zero-fill read instead, the bytes-that-follow check becomes belt-and-suspenders (still safe); if the length-prefixed path stops throwing, re-evaluate the delegate-on-underrun reasoning.

Dependency source files to re-read on an upgrade:

- `node_modules/peerjs/dist/bundler.mjs` (the bundled binary/chunked `DataConnection`): confirm `_handleChunk` still reassembles into `_chunkedData` keyed by `__peerData` and recurses into `_handleDataMessage` on completion; that `_handleDataMessage` is still the sole `unpack` point both the unchunked and reassembled paths flow through; that `peer.connect`'s default serializer is still the binarypack Binary class (and that `_chunkedData`/`_handleChunk` remain specific to it); and that the chunk envelope still carries `__peerData`/`n`/`total`/`data`.
- `node_modules/peerjs-js-binarypack/dist/binarypack.mjs` (`Unpacker.unpack`): confirm the marker table above, and that `unpack_string`/`unpack_raw` advance the cursor by exactly the declared `size`.
- `apps/web/src/psi/boundedReassembly.ts`: re-confirm `readValueHeader`/`structureOverBudget` still mirror that marker table and that `assertChunkReassemblySupported` still probes the three internals; update the cost weights only with the security-review judgment noted in the spec.

`assertChunkReassemblySupported` runs at install time on every connection in `openPeerMessageConnection`, and the live browser exchange test (`apps/web/test/browser/invitedPSI.test.ts`, run in CI) installs the guard on a real `DataConnection`, so a renamed or removed internal fails the install loud rather than running with no inbound bound. The unit tests (`apps/web/test/unit/boundedReassembly.test.ts`) pin the marker table, the per-kind cost weights, and the fail-closed bounds. A purely BEHAVIORAL change that keeps the names -- a different chunking serializer, a renamed chunk field, a marker-format change -- is not caught by the assert or the happy-path browser test, so the by-hand premises above must be re-verified against the source files on any bump.

## Export Control

PSI-Link incorporates cryptographic software. Distribution may be subject to U.S. Export Administration Regulations (EAR). Most open-source cryptographic software qualifies for License Exception ENC under ECCN 5D002, but the exception requires a one-time notification to BIS and NSA. This notification is pending and will be completed before the 1.0 release. See [docs/COMPLIANCE.md](docs/COMPLIANCE.md#export-control-ear) for the full regulatory framing.

## Reporting Security Issues

Do not open a public issue for security vulnerabilities. See [SECURITY.md](SECURITY.md) for the private reporting process.

## Reporting Other Issues

Open a [GitHub issue](https://github.com/georgetown-mdi/jspsi/issues). Include the version (Docker image tag or `package.json` version), the operating system, and a minimal reproducing case.
