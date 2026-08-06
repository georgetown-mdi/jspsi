---
title: "Testing Reference"
---

# Testing reference

The commands to run each suite are in
[CONTRIBUTING.md](../CONTRIBUTING.md#testing). This document is the reference
behind them: the integration-test backends and profiles, the console sentinel,
the browser-suite plumbing, and the coverage rationale.

## Integration tests

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

The harness itself is `apps/cli/test/sftpServer/`: `index.ts` selects the backend
from the environment, `inProcessServer.ts` and `nativeSshdServer.ts` implement
the two, `globalSetup.ts` starts and stops the selected one, and `testContext.ts`
hands each test its connection details, per-party credentials, and rendezvous
paths. The in-process backend adds two surfaces a real `sshd` cannot offer:

- Fault injection -- a malformed NAME or DATA packet, a request accepted and
  never answered, transient RENAME failures, capped READDIR batches.
- `sessionControls.ts`, the session-lifecycle hub -- lifetime, op-count, and
  idle caps that drop a live session, one-shot drops armed on the Nth further
  operation or on a wall clock, a withheld-close mode that consumes the client's
  FIN and sends nothing back, leaving it in half-close, and a handshake stall
  that accepts the TCP connection and writes nothing past the identification
  string ssh2 has already sent by then, so the key exchange never comes and a
  dial hangs established but never ready. A live session can also be made to
  VANISH: from that moment the server neither answers nor closes it, so the
  client sees no `end`, no `close` and no further byte, and can learn of it only
  from its own liveness deadline. Unlike the withheld close it fires against a
  session that has asked for nothing, and it composes with the caps, so a server
  can both cap sessions and never close one cleanly. Every vanished session is
  released at teardown -- a socket silenced on both halves cannot answer the
  `end()` the backend's `stop()` uses to close it -- and any release that reaches
  one hands back both halves at once, so no case can measure over a session that
  is half itself again.
- Rename-tear staging, on the same hub. The op-count drops arm a teardown as a
  request is counted and defer it, so whether that request's filesystem work ran
  before the connection went is a race; these cut at a named point inside the
  RENAME handler instead -- before any filesystem work, or from inside the
  `fs.rename` callback with the publish durably in place and the reply never
  written. The landed destination can be removed at the tear (standing in for a
  partner that consumed it), and a STAT/LSTAT of it can be held until it has been
  REMOVEd, which orders a real partner's consume-delete strictly before the
  sender's landed-confirmation probe of the same path.
- Request accounting, on the same hub. A meter counts requests as they arrive
  and replies as they are written, across every session being served at once, so
  a suite driving a concurrent fan reads how deep the client let its request
  pipeline run on the one channel from the end this project owns rather than
  from the client library's internals. A reading carries per-opcode counts and
  the peak simultaneously-unanswered depth. A reply written straight onto the
  channel by a fault injection, and a withheld reply, are never counted as
  answers, so each leaves its request outstanding for the rest of the window.

Adapter behavior against a partner that cuts, stalls, or never closes is
asserted through those controls. A probe that settles a dependency fact belongs
in that tree too: questions about `ssh2` / `ssh2-sftp-client` behavior are
decided by measurement rather than by reading the library, and the probe that
decided one graduates into the suite with the PR relying on the answer, written
as a test driven by this harness -- not left in `scratch/`. The premise is
load-bearing once a change is built on it, and a premise no suite re-checks goes
stale silently at the next pinned bump of either package.

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

Some of these specs drive the built production server at
`apps/web/.output/server/index.mjs`, so run `npm run build -w apps/web` first.
Without that build the project fails at setup, naming the missing path and the
build command, rather than reporting a pass with those specs quietly skipped.

For a deliberate dev-server-only run, set `PSILINK_ALLOW_MISSING_WEB_BUILD=1`:
the built-server specs report as skipped and the run passes. That is the one
opt-out, and it is the only way an absent build is not an error.

```sh
PSILINK_ALLOW_MISSING_WEB_BUILD=1 npm run test:integration -w apps/web
```

The dev-server-backed specs (`backendRemoved`, `securityHeaders`) run either
way. Neither root `npm run test` nor `test:browser` runs this project, so
neither is affected by the build requirement; `test:integration:browser` does
run it, and so needs the build.

For a faster inner loop you can keep a warm server running across many runs:
`test:integration` detects an already-running server, reuses it, and leaves it
up rather than stopping it.

```sh
npm run dev           -w apps/web    # start (and keep) the dev server in a terminal
npm run test:integration -w apps/web    # reuses the running server
# stop the dev server in the terminal when done (Ctrl-C)
```

## Browser suite

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

A change to the web `optimizeDeps` or a worker dependency is verified only
against a cold optimizer cache: remove `apps/web/node_modules/.vite` first -- a
warm cache passes even when the configuration is wrong. Inline vitest projects
do not inherit the root `optimizeDeps`/`resolve` configuration; each project
that needs it carries its own.

## Coverage

Coverage is an informational REPORT to help you and reviewers see which product
paths a change leaves unexercised. It is produced on demand -- it is not part of
`npm test` and does not run in CI.

```sh
npm run coverage                    # all workspaces; writes a report per workspace
npm run coverage -w packages/core   # a single workspace
```

It uses `@vitest/coverage-v8` (first-party Vitest tooling, so no second runner)
and writes a text summary to the terminal plus a browsable HTML report and an
`lcov.info` (for editors/tooling) under each workspace's `coverage/` directory.
The denominator is scoped to product source under each `src/` tree, with the
generated route tree and vendored `apps/web/src/contrib` excluded, so the numbers
reflect hand-written product code. The report runs `core` unit, `cli`
unit and integration (the SFTP adapter is exercised only by the integration
suite), and `web` unit plus `web` browser (real Chromium via Playwright). The web
unit and browser projects run together and their coverage is merged, so the
component, live-exchange, and consent-gate paths exercised only in the browser
are reflected instead of reading as near-zero; running `npm run coverage` for the
web workspace therefore stands up the dev server and Chromium the same way `npm
run test:browser` does. The web black-box integration suite is deliberately
excluded: it fetches a separately-spawned dev-server process and imports no
`src`, so under `--coverage` it measures the empty runner process, not the
server. Capturing that server-entry/route-handler code is feasible -- run the
spawned server under `NODE_V8_COVERAGE` and merge its profile -- but low-value:
it buys a bespoke merge step outside Vitest's model to cover thin server-entry
and route glue whose behavior the integration suite already asserts end-to-end,
so it is out of scope, not a deferred gap.

There is deliberately NO global percentage gate, and adding one is not a missing
piece to be "fixed": a blanket "N% or the build fails" bar rewards vanity tests
that raise the number without raising confidence, so the report informs review
rather than blocking merges. Do not add a `thresholds` line to the Vitest
coverage config. If coverage gating is ever wanted, it is scoped to
`packages/core` and expressed as diff/patch coverage (coverage of the lines a PR
changes), never an absolute whole-repo percentage -- and even that stays opt-in.
