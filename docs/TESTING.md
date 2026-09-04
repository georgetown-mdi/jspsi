---
title: "Testing Reference"
---

# Testing reference

The commands to run each suite are in
[CONTRIBUTING.md](../CONTRIBUTING.md#testing). This document is the reference
behind them: the integration-test backends and profiles, the console sentinel,
the browser-suite plumbing, where a test goes, where shared test material
lives, and the coverage and mutation-testing rationale.

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
  never answered, transient RENAME failures, capped READDIR batches, a run of
  READDIR batches carrying neither an entry nor end-of-directory (the
  progress-free flood the listing's round-trip cap exists for, and the only
  shape that reaches it), and a NAME reply of a chosen width (the hook the
  pinned stack's reply wall is measured through; see
  [docs/spec/DEPENDENCY_PINS.md](spec/DEPENDENCY_PINS.md#upgrading-the-sftp-stack-ssh2--ssh2-sftp-client)).
- `sessionControls.ts`, the session-lifecycle hub -- lifetime, op-count, and
  idle caps that drop a live session, one-shot drops armed on the Nth further
  operation or on a wall clock, a withheld-close mode that consumes the client's
  FIN and sends nothing back, leaving it in half-close, and a handshake stall
  that accepts the TCP connection and writes nothing past the identification
  string ssh2 has already sent by then, so the key exchange never comes and a
  dial hangs established but never ready. The stalled connections are counted,
  which is how a case knows the stall has reached a dial rather than acting on a
  handshake that then completes, and they can be closed from the server's side,
  which is the only way to end a parked dial with a peer close rather than with a
  teardown the client drove. A live session can also be made to
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

#### What the real-server legs cannot reach

The controls above take the SFTP adapter a long way, but not everywhere. Four
classes of its behaviour are held by the unit suite's hand-modelled
`ssh2-sftp-client` alone, and stay there. Each is a limit of what a server can be
made to do, not a gap waiting for a case, so a plan that decomposes the adapter
has to keep the model for them rather than promise to retire it:

- **The API-drift feature detects.** The adapter reaches through
  `ssh2-sftp-client` to the `ssh2` client, its socket and the raw SFTP session
  (`client._sock.destroy()`, `client.on()`/`once()`/`removeListener()`,
  `client.end()`, `setNoDelay`/`setKeepAlive`, and `sftp.open`/`close`/`opendir`/
  `readdir`), and guards each reach so a version that relocated one degrades with
  a named warning instead of throwing. What those guards test is this process's
  own dependency tree, not anything on the wire, so no server, fault injection or
  hardened profile can make one true while the pinned versions expose everything
  they check. They exist to fire at the next bump, which is exactly the "does the
  API still look like this" question that belongs to a model rather than to a
  measurement.
- **`createExclusive`'s SFTPv4+ `FILE_ALREADY_EXISTS` (status 11) arm.** Driven
  against both backends, an exclusive-create collision reports SFTPv3's
  ambiguous `SSH_FX_FAILURE` (status 4) and nothing else -- the in-process
  `ssh2.Server` double and OpenSSH's `internal-sftp` agree -- which the adapter
  resolves through its own existence check. Reaching the status-11 normalization
  means fabricating a status no server here sends, so it would take a new
  fault injection rather than a new case.
- **`put`/`putOnce`'s string-path and one-shot `ReadableStream` sources.**
  Nothing server-side distinguishes either from the `Buffer` path, and no call
  site in this app hands one: every `FileSyncConnection` put passes a `Buffer` or
  a chunk list. A real-server case would have to call the adapter directly with a
  string or a stream to reach them, which is what the unit suite already does.
- **The inter-attempt dead-session window.** `renameOnce`'s guarded outcome is
  driven at method entry against a real server socket whose SFTP channel has
  been destroyed (`sftpConnection.test.ts`'s "a fatal 'error' on the raw SFTP
  wrapper does not crash and fails terminally"). A fatal session error landing
  in the short window between two attempts of a retried operation is a race no
  server here can be held to, so that window stays the model's ground alone --
  `ssh2SftpAdapter.test.ts`'s "stops retrying when a fatal session error lands
  between attempts".

The CLI's WebRTC transport is a project of its own, `webrtc`, holding the files
under `apps/cli/test/integration/webrtc/`:

```sh
npm run test:integration:webrtc -w apps/cli
```

It is separate because it is transport-agnostic to everything the SFTP suite
sets up -- two loopback werift peers meeting through the vendored broker, with
no SFTP server involved -- while `test:integration` is run repeatedly per pull
request, once per SFTP backend and once per hardened-`sshd` profile. As its own
project it runs exactly once (see `.github/workflows/cli_build_and_test.yaml`,
and the ship-gate step in `release.yaml`), and a new file joins it by being
written in that directory rather than by matching a naming convention. Its
project skips the SFTP `globalSetup` entirely, so no server is started for it.

`broker.test.ts` holds one deliberately slow check -- that a registered CLI peer
is still registered and routable after the broker's silent-socket reap window
has passed, which takes a real 25-second wait. It is kept rather than trimmed:
it is the only place the CLI client's own heartbeat cadence is joined to the
vendored broker's reap window over the real wire, and the two constants live in
different workspaces, so no unit check on either side can stand in for it. It runs in
its own worker process alongside the longer transport file.

Its broker harness is `apps/cli/test/signaling/`. It starts the repository's own
vendored PeerJS broker as a child PROCESS rather than importing it, because a
deployed broker is a service of its own and the CLI's client is measured against
what that service does on the wire; the process entry point it spawns is
`packages/peerjs-broker/src/standalone.ts`, which is why
`.github/workflows/cli_build_and_test.yaml` filters on that workspace as well as
on `apps/cli`. Each file starts a broker of its own. The same measurement
discipline applies here as to the SFTP tree: what the CLI's hand-written
signaling client and PeerJS framing rest on was established by driving the real
broker and the real `peerjs`/`peerjs-js-binarypack` packages, and the premises
that follow are held as checks -- see
[docs/spec/DEPENDENCY_PINS.md](spec/DEPENDENCY_PINS.md#upgrading-the-cli-webrtc-peer-werift).

One premise the live suite cannot hold, and where it lives instead: werift
inlines its ICE candidates in the SDP, so two peers connect on loopback even
when every trickled candidate is discarded. The candidate-queue rule the
transport exists to honour is therefore invisible end to end and would fail only
in the field. It is pinned in `apps/cli/test/unit/webrtcNegotiation.test.ts`,
which drives the negotiation against a scripted broker and peer connection and
asserts the ORDER of what goes on the wire.

#### The one-command acceptance leg

`oneCommandAcceptance.test.ts` drives whole COMMANDS rather than the transport
beneath them: an inviting `psilink invite` mints a webrtc invitation and waits,
and an accepting `psilink accept INVITATION INPUT_FILE OUTPUT_FILE` resolves its
positionals, renders the consent surface, takes its confirmation from stdin,
resolves the connection from the invitation's own endpoint, dials, and runs the
exchange -- with the linkage result asserted on both sides. Both parties are
child processes (`apps/cli/test/cliProcess.ts`), so each run has its own argv,
stdin, stdout, and exit code; an acceptance driven through the exported handler
would have to stub the confirmation prompt, which is the checkpoint the leg
exists to cover. It costs about fifteen seconds, most of it ICE gathering falling
back to host candidates.

The leg needs a `wss://` coordination server. An invitation's connection endpoint
is a credential-free locator carrying no scheme, so an acceptance seeded from one
resolves the coordination server over TLS, and the one-command form has no
configuration file for an operator to set `secure: false` on first. So the leg
puts a TLS terminator (`apps/cli/test/signaling/tlsBrokerFront.ts`) in front of
the same vendored broker every other file here spawns, pipes each stream through
unread, and starts each party with `NODE_EXTRA_CA_CERTS` pointed at the throwaway
certificate -- trusting that one certificate in that one process rather than
disabling verification anywhere. Terminating in front of the broker rather than
inside it keeps the spawned entry point, and every byte the broker sees, the same
as the rest of the project's.

A broker or environment failure stays distinguishable from an exchange failure. A
precondition test ahead of the leg fetches the broker's own 404 through the
front, with the throwaway certificate as its only trusted authority, so a broker
that did not start, a front that is not listening, or a certificate this
environment could not mint fails as itself; past it, a failing leg belongs to the
command path. Each party also carries a hard deadline of its own, so a stalled
run is reported with its exit status and the tail of its diagnostics instead of
running until the framework kills the worker under it.

### The backend-agnostic project

The integration files no SFTP backend differentiates are a third project,
`backend-agnostic`, holding the files under
`apps/cli/test/integration/backendAgnostic/`:

```sh
npm run test:integration:backend-agnostic -w apps/cli
```

Each drives a filedrop directory, a listener it stands up itself, or nothing on
a socket at all, so every backend and hardened profile would reach the same
result for it -- and `test:integration` is run six times per pull request. Like
the WebRTC project it starts no SFTP server, runs exactly once (see
`.github/workflows/cli_build_and_test.yaml`, and the ship-gate step in
`release.yaml`), and a new file joins it by being written in that directory.

The bar for writing a file there is that no leg differentiates what it
EXERCISES, not merely what it asserts. A file that reaches the suite's server at
all -- including incidentally, through a fixture, a control case, or a teardown
-- belongs in `integration`, because moving it takes that exercise off the
native and hardened legs entirely. Where only part of a file clears that bar the
file is split rather than moved whole: `dialPeerIdentification.test.ts` keeps the
dial paths that run over the server, while its two host-key probe entry points,
which dial a peer of their own, are
`backendAgnostic/hostKeyProbePeerIdentification.test.ts`, with the assertions
both halves share in `apps/cli/test/integration/peerIdentification.ts`.

A move trades a recurring per-leg cost for a one-off one, so measure it first: a
case costing milliseconds saves milliseconds five times over and still leaves a
split file to keep in step. Several leg-agnostic cases are deliberately left in
`integration` on that measurement.

A standing console sentinel guards all three CLI integration projects:
it wraps `console` directly and fails a test file at `afterAll` on any
`console.log`/`warn`/`error` that no allowlist matcher accepts (the inverse
of blanket silencing, and the one check that sees third-party `console.*`
which the loglevel-based `withCapturedLogs` cannot). If your change makes
the suite emit new console output, the fix is to eliminate it at the source
-- route it through the logger or assert it under `withCapturedLogs`;
accept it as intended only by adding a matcher to the allowlist in
`apps/cli/test/integration/consoleAllowlist.ts`, a visible edit a reviewer
sees. A matcher that never fires across a run is reported at teardown so the
allowlist cannot accumulate dead entries. That report is advisory (a warning,
never a failure) and is produced by the `integration` project's `globalSetup`,
so it sees only that project's files: a matcher fired solely by a `webrtc` or
`backend-agnostic` file reads as dead there.

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

The dev-server-backed specs (`signalingSurface`, `securityHeaders`) run either
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

## Cross-runtime interop suite

The CLI and the web app share no code but `@psilink/core`, and their own suites
never meet: each drives both sides of an exchange with itself. The `interop`
project is the one place a real `psilink` process and a party assembled from the
web app's own exchange modules complete a live exchange together, in both
invitation directions, over one file-drop directory.

```sh
npm run build -w apps/cli           # the party on the CLI side is the built program
npm run test:interop -w apps/web
```

It lives in `apps/web/test/interop/` because only that workspace may import
`apps/web/src`; the CLI side is a spawned child process, which is how the console
already drives it. The suite skips itself when `apps/cli/dist/` is absent rather
than failing on a tree that has not built it.

Two pieces of the web party are the harness's rather than the app's, and each is
there because the app has no counterpart it could use:

- **The file-drop directory client.** `FileSyncConnection` lives in core but its
  filesystem client (`LocalFSClient`) lives in `apps/cli`, which `apps/web` may
  not import. The harness supplies one scoped to what the file-sync protocol
  calls, not a second copy of the shipped client's hardening.
- **The application-layer AEAD wrap.** A CLI party on a file-sync channel
  requests it unconditionally and `applyEncryption` is the OR of both parties'
  requests, so a web party must apply it for the exchange to start. The web app's
  own handshake driver refuses it -- the app exchanges only over a
  DTLS-confidential WebRTC channel -- so a third test in the suite runs that
  driver against a CLI party and pins the refusal. That test fails the day
  `apps/web` applies the wrap itself, which is when the stand-in should go.

Everything else is each runtime's own: the CLI's argv, configuration, key file,
PSI backend and result CSV; the web app's acceptor assembly, its invitation mint
and inviter spec assembly, and its browser WASM PSI engine.

It runs on both `cli_build_and_test.yaml` and `eb_build_and_test.yaml`. That is
deliberate rather than redundant: the drift it exists to catch can land on either
runtime, and each workflow's path filter sees only its own.

## What a run did not cover

A run that quietly covers less than the suite does is worse than a red one: its
green is read as evidence. Three guards keep the gap visible, each a run-level
vitest option -- read once for a run rather than per project, so a project added
later is covered without registering anything of its own. The dist guard is in
both app configs, the prerequisite guard in `apps/web`'s, and the reporter in
every workspace config and in the root `vitest.config.mts` as well, since
reporters belong to the config that starts a run rather than to a project it
reaches.

### A stale `@psilink/core` dist fails the run

The apps import the built package, never `packages/core/src`, so a run whose
`dist/` is older than the sources it was built from exercises yesterday's
library and reports failures that belong to the build. Before any app suite
runs, the `dist/` entries `packages/core/package.json` publishes are compared
against `packages/core/src` and `rollup.config.ts`; a dist that is missing or
older fails the run, naming the file that outran it and the rebuild:

```sh
npm run build -w packages/core
```

Set `PSILINK_ALLOW_STALE_CORE_DIST=1` to run against the dist as it stands.
`packages/core`'s own suite carries no such guard: `pretest` rebuilds, and those
tests import `src`. A run that selects no app project pays nothing either --
`npm run test:scripts` needs no build and never asks for one.

The comparison is over modification times, so it catches the ordinary staleness
-- an edited source, or a checkout that rewound one -- and not a dist built from
a source since reverted to identical bytes.

### A missing environment prerequisite is named, and fails in CI

Some legs need a tool the repository does not ship. The web signaling suites and
the CLI's live one-command acceptance need a self-signed loopback certificate,
which Node cannot issue, so `@psilink/testkit/loopbackTlsCert` shells out to
`openssl` and those legs skip where it cannot mint one (no `openssl`, or a
LibreSSL one that takes the flags differently).

`apps/web/test/requireTestPrerequisites.ts` declares each such prerequisite and
decides what its absence costs, by where the run happens. On a workstation the
run continues, with the missing prerequisite, the coverage it costs, and how to
supply it named on the console. Under `CI`, the run fails instead: a runner is
provisioned to a spec, so a prerequisite absent there is a defect in the image
or the workflow rather than a property of somebody's laptop. Set
`PSILINK_ALLOW_MISSING_TEST_PREREQUISITES=1` to skip those legs deliberately.

A suite that needs a new prerequisite adds it to `webTestPrerequisites()` beside
the certificate. The CLI states three of its own the same way but per leg, since
the legs that must have them are named individually:
`PSILINK_REQUIRE_WORKER_BUILD=1` on the leg that builds the CLI worker bundle,
`PSILINK_SFTP_CHROOT_REQUIRED=1` on the chroot profile, and the one-command
acceptance leg's own `openssl`, which it mints its TLS front's certificate with.
That leg reads `CI` and the same `PSILINK_ALLOW_MISSING_TEST_PREREQUISITES`
opt-out as the web gate, so an operator whose machine has no `openssl` sets one
variable for both.

### Every skipped test is named

Vitest counts skips (`2 passed | 3 skipped`) but names none of them, so a leg
that starts skipping reads as green with nothing to say which suite went quiet.
The skipped-leg reporter (`scripts/lib/skippedLegReporter.mjs`) ends every run
by listing each skipped test under its project and file, with the reason where a
runtime `ctx.skip(reason)` gave one. `test.todo` is left out, being a
placeholder vitest already reports on its own.

It reports and never fails: which skips are legitimate is a per-suite question
-- the SFTP matrix legs skip the backends they are not running, and the whole
matrix together is the coverage -- so failing on one belongs with whatever
declares the prerequisite, as above.

### A platform gate is a skip, not an early return

A test that cannot run on this host declares that with `test.skipIf` /
`describe.skipIf`, so vitest counts the leg and the reporter above names it. A
body that returns before its first assertion instead -- `if (process.platform
!== "darwin") return;` -- still reports PASSED, so a leg that never ran is
counted as coverage and there is no skip for the reporter to see.

`scripts/platform-gate-skips.test.mjs` (run by `npm run test:scripts`, a CI
static check) is what holds that, reading every test module the checkout carries
rather than a maintained list. It fails on a gate that returns early when the
platform is `linux` or `darwin` -- the hosts the suites are actually run on, CI
being `ubuntu-latest` throughout -- and reports a gate it cannot evaluate rather
than passing it over. Its reach and what it deliberately leaves standing are in
its own header.

## Where a test goes

Four rules cover how a test file is named, how it is grouped internally, when
it splits, and where its helpers live.

### Naming

One test file per source module, named for that module: `fileSyncConnection.ts`
tests live in `fileSyncConnection.test.ts`. A test that is not about one
module -- a cross-cutting property, an end-to-end scenario -- is named for the
property or scenario, states that scope in a one-line file header, and sits
beside the module it exercises rather than in a naming bucket of its own.

A `.unit` / `.integration` / `.browser` suffix is never required to route a
file: the directory it sits in already does. `packages/core/vitest.config.ts`
(its `unit` project, around lines 26-35) and `apps/cli/vitest.config.mts`
route every project by directory alone and define no suffix glob at all.
`apps/web/vite.config.ts` (around lines 195-249) accepts a `*.unit.test.ts` /
`*.integration.test.ts` / `*.browser.test.ts` suffix as an alternate match
alongside its `test/unit/**`, `test/integration/**`, `test/browser/**` globs,
but a file already under one of those directories matches by directory
regardless of the suffix -- `apps/web/test/unit/` carries the suffix on 26 of
its 160 files and omits it on the other 134, and both route identically. Name
a file for its module or scenario, not for its project.

### Grouping

Group related tests with vitest's own `describe`, never with a title prefix
written into a string. `packages/core/test/fileSyncConnection.test.ts` carries
240 test titles that open `"synchronize(): ..."` where a `describe` block was
meant: a title is a `describe` spelled as a string, so it does not nest, does
not collapse in a reporter, and does not survive a rename. A `describe` title
does not repeat the file's own name -- the path already says which module is
under test.

### Size, and when a file splits

A file crossing roughly 1,500 lines is due for a look, not a stop. Nothing
checks the number, so it is a prompt to open the file and ask whether it still
tracks one module, not a gate.

The harder rule: a test file splits when its source module splits.
`apps/cli/test/unit/ssh2SftpAdapter.test.ts` (11,006 lines) covers several
modules' subjects, and `packages/core/test/fileSyncConnection.test.ts` (10,442
lines) is in the same state -- both are cases where the source was split and
the test file was not, so it kept asserting behavior that now lives in several
modules. Left unsplit, a module's tests become unfindable without grep.

### Where helpers live

A helper used by one group of tests moves with that group when the file
splits. A helper used across a workspace's own test tree lives in that
workspace's test tree -- `packages/core/test/utils/`, `apps/cli/test/`,
`apps/web/test/utils/` are the three today. A helper more than one workspace
needs takes one of the two channels documented in
[Shared test material](#shared-test-material) below -- `@psilink/core/testing`
or `@psilink/testkit` -- whose admission rule lives there, not here; see also
[cross-workspace-test-material.md](notes/cross-workspace-test-material.md).

### Directory layout

Test directories mirror the source directories they cover. The vitest project
globs (`test/unit/**` and its equivalents in the other projects) are already
recursive, so grouping a workspace's tests to match its `src/` tree needs no
config change to adopt.

## Shared test material

A helper that only tests use lives in the test tree that uses it --
`packages/core/test/utils/`, `apps/cli/test/`, `apps/web/test/utils/`. It may
import anything the repository declares, root devDependencies (`typescript`)
included, for as long as no workspace outside its own imports it.

A helper that more than one workspace's test tree needs has two channels, and
which one it takes is decided by what it imports, not by what it is about.

`@psilink/core/testing`, whose subjects live in `packages/core/src`, is the
channel for a helper that needs nothing `packages/core` does not already declare
in its own `dependencies`. Everything it holds is built into `dist/testing.*`
and published with `@psilink/core`, so a fixture put there ships to consumers.

`@psilink/testkit` is the channel for a helper that cannot meet that condition:
a private, never-published workspace with no build and no `dist`, whose
`exports` map points at its `./src/*.ts` and which is therefore consumed as raw
TypeScript and typechecked inside each consumer's own program. It may import
anything the repository declares, including a dependency `packages/core` does
not -- which is the whole reason it exists, since core's build resolves its
externals from `dependencies` alone, so an import of anything else either fails
that build or is inlined into the package core publishes.

Its admission rule, which is narrow on purpose: material goes in only when a
second workspace's test tree genuinely needs it AND it cannot take the
`@psilink/core/testing` channel, and it is exported one explicit subpath at a
time. Nothing moves in for tidiness, and the existing `@psilink/core/testing`
subjects stay where they are. Its one subject today is the WebRTC inbound frame
fixture set, which both apps' transports are held to and which is built with the
real `peerjs-js-binarypack` packer (a devDependency of `packages/core`, not a
dependency).

Anything a single workspace needs stays in that workspace's own test tree,
whichever channel it would qualify for. The decision, the alternatives measured
against it, and where each current `@psilink/core/testing` subject stands are in
[cross-workspace-test-material.md](notes/cross-workspace-test-material.md).

### Checked-in vectors

A vector file is shared test DATA rather than a helper, so it takes neither
route above: each one lives in `packages/core/test/vectors/` beside the
generator that produces it, and a suite in any workspace reads it by relative
path -- the Node suites with `node:fs`, the browser suites with Vite's `?raw`.
Nothing about it enters `packages/core/src` or ships in `dist/testing.*`.

The suites assert that the code reproduces the checked-in JSON;
`npm run check:vectors` asserts the other direction on every pull request, so a
failing conformance assertion cannot be silenced by editing the vectors file. It
regenerates each file with its generator and fails on a difference, naming both,
and it classifies every file in the directory -- generated, a verifier
(`verify-native-wire-vectors.mjs`), or hand-authored with no generator
(`canonical-vectors.json` and `psi-prebuild-manifest.json`) -- so a file added
beside the others fails until it is classified rather than passing unchecked.

Two files carry values the check cannot compare, both in
`signed-receipt-vectors.json` and `signing-cert-vectors.json`: the ECDSA
`signature` fields, freshly randomized on every signing run, and
`signatureProducer`, which records the `openssl version` of the host that signed
the checked-in bytes and so reproduces only on a host carrying that same build.
Those are masked by name and by the shape each value takes, the mask fails closed
if it stops matching, and the signatures' validity is asserted by the suites that
verify them. Refreshing any vectors file is running its generator and then
`npm run format`, as each generator's header states.

Reading one from more than one workspace is deliberate, along two axes. A
construction that two applications implement independently is guarded only when
each application's OWN call sites are driven against one pinned answer; a test
that computes both "sides" through a single shared path proves nothing about
either. And a construction that runs on `crypto.subtle` is a different
implementation on each platform, so a Node-only assertion of it leaves the
browser half unmeasured.

`webrtc-interop-vectors.json` -- the CLI-to-web rendezvous, invitation, and
handshake-role contract -- splits both ways:

- `packages/core/test/webrtcInterop.test.ts` for what core alone owns.
- `apps/cli/test/unit/webrtcInterop.test.ts` and
  `apps/cli/test/unit/webrtcDispatch.test.ts` for the CLI's own constructions.
- `apps/web/test/unit/webrtcInterop.test.ts` for the web app's, with each of the
  three flows that read the side-to-role table driven through its own entry
  point as well: the two one-shot flows in
  `apps/web/test/unit/webrtcInteropHooks.test.ts` and the managed re-run in
  `apps/web/test/unit/managedRunDriver.test.ts`. A correct table read on the
  wrong key is the same failure on the wire, and one no web-to-web test can see,
  since a swapped key moves both ends together.
- `apps/web/test/browser/webrtcInterop.test.ts` for the peer-id derivation and
  the invitation checksum in real Chromium.

Each of those projects runs on every pull request that can touch the contract,
so a divergence fails there rather than at first cross-application contact.
`kex-vectors.json` splits on the platform axis alone
(`packages/core/test/kex.test.ts` and `apps/web/test/browser/kex.test.ts`): both
applications drive the key schedule through the same core entry point, so it has
no per-application call sites to guard.

## Verifying Windows owner-only file protections

On Windows the CLI protects its owner-only files with ACLs rather than POSIX mode bits. A nightly `windows-latest` job (`.github/workflows/nightly_platform.yaml`) now runs the CLI unit suite, including this describe's cases, but until that leg has stayed green the checks below remain the procedure to trust. The checks below are a manual procedure to run on a Windows host to confirm the owner-only writers still narrow ACLs correctly after a change to their Windows branch. Run them in PowerShell from a scratch directory on an NTFS volume that carries the usual inheritable ACEs (a subdirectory of the user profile is fine); each check produces an artifact you then inspect. `$me` below is the domain-qualified account the CLI narrows the file to; derive it from `whoami`, the same call the CLI uses to name the grant principal, so the comparison matches the granted identity exactly (domain casing and NetBIOS form included).

```powershell
$me = (whoami)
```

Owner-only artifacts on Windows come from three writers: `writeFileOwnerOnly` (the key file, the config writer, exchange records, and the signing identity), `createOwnerOnlyWriteStream` (the result CSV), and `writeFileAtomic` for a file written with the owner-only mode. Produce one artifact from each by running the operations that use them: an exchange writes the result CSV and rotates the key file, `accept` writes the signing identity, and so on (see [CLI.md](CLI.md)). Each check assumes a file at `$f`.

**A narrowed file grants Modify to the current user only, with no inherited or foreign non-owner ACE.** After a writer creates `$f`, its DACL must grant `Modify` to the current user and to no one else, and must not be inheriting from the parent directory:

```powershell
icacls $f
# Expect one line granting the current user (M); no BUILTIN\Users, no (I)
# inherited entries, no other principal.
(Get-Acl $f).AreAccessRulesProtected   # must be True (inheritance stripped)
(Get-Acl $f).Access | ForEach-Object {
  "{0}  {1}  Inherited={2}" -f $_.IdentityReference, $_.FileSystemRights, $_.IsInherited
}
# Every rule must be IdentityReference = $me, FileSystemRights = Modify,
# Inherited = False. Any other principal, or any Inherited = True rule, fails.
```

This is what `writeFileOwnerOnly`, `writeFileAtomic` (owner-only mode), and `createOwnerOnlyWriteStream` all produce: they run `icacls <file> /inheritance:r /grant:r "$me:(M)"`, which strips inheritance and replaces the DACL with the single owner Modify grant.

**`createOwnerOnlyWriteStream`'s overwrite path drops a pre-existing foreign explicit ACE.** The stream writer unlinks and recreates the destination as a fresh inode before narrowing, so a foreign principal's explicit (non-inherited) grant left on a prior file at that path does not survive the overwrite. Seed such a grant on a stand-in file, overwrite it by writing a result CSV to the same path, and confirm the foreign grant is gone:

```powershell
# Seed a pre-existing file with an explicit grant for another principal
# (Guests is present on a default install; substitute any non-owner account).
"stale" | Out-File -Encoding utf8 $f
icacls $f /grant "Guests:(R)"
icacls $f    # confirm the Guests ACE is present before the overwrite

# Now run an exchange whose result CSV output path is $f, then re-inspect:
icacls $f
# Expect only the current user (M); the Guests ACE must be absent. If it
# survived, the fresh-inode overwrite regressed to an in-place narrow.
```

**The load-time over-permissive check flags a loosened ACL.** On load, before reading an owner-only secret (the key file or the signing identity), the CLI runs `warnIfFileOverPermissive`, which on Windows checks the ACL: first via PowerShell `Get-Acl` with SID translation (both inherited and explicit ACEs; SYSTEM and Administrators are exempt), falling back to `icacls` (explicit non-owner ACEs only) where PowerShell is unavailable. Loosen a correctly-narrowed key file and confirm the next CLI load warns:

```powershell
# Grant another principal read on the key file, defeating owner-only.
icacls .psilink.key /grant "Guests:(R)"
```

Run a command that loads the key file (for example `psilink exchange`) and confirm it logs a warning that the file grants access to other users and should be restricted to owner-only. To confirm the `icacls` fallback tier (used where `Get-Acl` cannot run, such as a Nano Server container or a constrained-language environment), repeat with PowerShell unavailable on `PATH`; the warning must still fire. Restore owner-only afterward:

```powershell
icacls .psilink.key /inheritance:r /grant:r "$me:(M)"
```

A clean load emits no such warning, so absence of the warning after restoring the ACL confirms the check clears a correctly-narrowed file.

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
generated route tree excluded, so the numbers reflect hand-written product code;
the vendored signaling broker is a workspace of its own (`packages/peerjs-broker`)
and runs no coverage, so it sits outside every denominator. The report runs `core` unit, `cli`
unit, integration, webrtc, and backend-agnostic (the SFTP adapter is exercised
only by the integration suite, the WebRTC transport only by the webrtc suite,
and the exchange and zero-setup command handlers only by the backend-agnostic
suite, so dropping any of them would read what it covers as near-uncovered), and
`web` unit plus `web` browser (real Chromium via Playwright). The web
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

## Mutation testing

A nightly leg mutates the three core security-bearing files --
`packages/core/src/auth.ts`, `src/connection/abortMarker.ts`, and
`src/connection/encryptedMessageConnection.ts` -- and re-runs `packages/core`'s
unit tier against every mutant. It measures something the coverage report above
cannot: a line can be executed by a test that passes just as happily when the
line's behavior is changed, and the mutation score counts only the mutants some
test actually distinguishes. That is the gap it exists for -- a
domain-separation label, a fail-closed guard, an error `kind` a caller branches
on, each of them reading as covered while nothing pins it.

```sh
npm run test:mutation
```

The run takes a couple of minutes against an installed tree (`npm ci` plus the
core build). Stryker is deliberately not a repository dependency -- it drags in
a second copy of Vitest and its own TypeScript -- so
`scripts/stryker-security.mjs` installs it into a private prefix under the work
directory: `$RUNNER_TEMP` in CI, the system temp directory locally, and
`PSILINK_STRYKER_WORK_DIR` overrides both. The HTML and JSON reports are written
there too, so nothing lands in the working tree; the nightly workflow
([`.github/workflows/nightly_mutation.yaml`](../.github/workflows/nightly_mutation.yaml))
checks out `staging` explicitly and uploads both as a run artifact.

### The floors

`packages/core/stryker.config.mjs` carries the corpus and each file's committed
floor in one table: the keys are the files to mutate, the values their minimum
mutation score in whole percent. The gate is per file rather than Stryker's
whole-run `thresholds.break`, so a file whose tests were gutted cannot be
carried by the others; the leg fails naming the file, its score, and its floor.

- **Raising a floor.** When tests land that raise a file's score, raise its floor
  to the new score rounded down to a whole percent. The runner prints the value
  to use for each file that has moved above its floor.
- **Never lowering one.** A floor is not lowered to make a red leg green: a drop
  means a test that used to distinguish the mutated behavior no longer does,
  which is the finding the leg exists to report.
- **Widening the corpus.** Adding a fourth file is one line in the table, with
  the floor that file measures when it is added.

Do not chase the score itself. The survivors these floors sit above are error
and log message text and private bookkeeping flags with no external observer,
which a test can only pin by asserting the exact wording -- worth doing where an
operator acts on the text, not as a way to move the number.
