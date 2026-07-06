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
