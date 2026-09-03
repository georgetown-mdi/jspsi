# Development container

A plain Node 26 container in which an agent (or a developer) can run the whole
psilink workflow -- build, unit tests, lint, typecheck, the web dev server, and
both SFTP integration backends -- with no Docker inside it. It runs as the
non-root `node` user behind an egress firewall, so Claude can run prompt-free
with its writes confined to the container.

There are two configurations. This document describes the default one
throughout; the [infrastructure profile](#infrastructure-profile) at the end is
the same container plus the tooling and the second egress lane that AWS,
Cloudflare, Let's Encrypt, and remote-host work need. Everything below applies
to both unless it says otherwise.

## What is inside

- **Node 26** (`node:26-bookworm`), matching the shipped runtime and CI.
- **OpenSSH server and client** plus the baked-in `/run/sshd` directory, so the
  native `sshd` SFTP test backend (`PSILINK_SFTP_BACKEND=native`) spawns without
  root. The in-process backend (the default) needs nothing extra. The hardened
  native profiles (`PSILINK_SFTP_NATIVE_PROFILE`) run too, except `chroot`, which
  needs a root `sshd` the unprivileged container does not provide -- its runner
  skips cleanly (exit 0) here rather than failing.
- **git**, the **GitHub CLI**, and the build toolchain for native npm modules.
- An **egress firewall** (`init-firewall.sh`) applied on start.

## Security model

Three layers, so prompt-free operation inside is safe:

1. **The container is the wall.** The only host filesystem a session can reach is
   the bind-mounted workspace (read-write), plus the named `node_modules` and
   Claude-config volumes; everything else it writes lives in the ephemeral
   container layer and is discarded on rebuild (the named volumes persist). This
   boundary -- not the deny-list below -- is what actually confines writes and
   secret reads.
2. **Egress firewall** (`init-firewall.sh`, run via passwordless sudo on start):
   default-deny outbound (IPv4 and IPv6, failing closed if it cannot build the
   full ruleset), allowing only the hosts a real `npm ci` trace showed (the npm
   registry and `nodejs.org`), GitHub (its published IP ranges, plus the
   `productionresultssa*.blob.core.windows.net` storage shards -- resolved by
   enumeration at start, since GitHub publishes no ranges for them -- that the
   API redirects Actions log bodies and run artifacts to), the Anthropic API and
   login, and the VS Code extension CDN. Telemetry and updater hosts are
   absent: the container sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` and
   `DISABLE_AUTOUPDATER`, so Claude makes no such calls.
3. **Command deny-list and a protected-branch push hook** (`.claude/settings.json`,
   checked in): guardrails that hold even with prompts disabled. Through Claude's
   Read/Edit/Write tools the deny-list blocks reads and writes of SSH private keys
   and `.env` files and writes to `/etc`; a checked-in `PreToolUse` hook
   (`.claude/hooks/block-protected-push.mjs`) blocks a direct `git push` to
   `staging` or `main`. Both deny rules and PreToolUse hooks are enforced in every
   permission mode, including bypass. These are a floor against the common paths,
   not an airtight wall: an arbitrary shell command (`cp`, `tar`, a script) can
   still touch the denied files, and the push hook is best-effort -- it catches a
   direct or accidental push but is bypassable by shell indirection (`sh -c`,
   `eval`, a subshell, `git -c`), so it is fast local feedback, not a security
   boundary. The authoritative wall for `staging`/`main` is GitHub branch
   protection (server-side, no bypass actors); layer 1 -- the container boundary --
   is the real protection for the filesystem. Note this file is checked in, so the
   same rules also apply to Claude sessions run against this repo *on the host*,
   where there is no container wall behind them. It also carries an allow-list --
   which spares a session prompts it would otherwise answer by hand, and never
   overrides a deny -- and the command-sandbox rules that go with it.

`post-create.sh` writes the container's *user* settings wholesale from
`claude-settings.json`, the tracked template beside it: `permissions.defaultMode:
bypassPermissions` so sessions inside start prompt-free, the session model and
effort, the editor and TUI preferences, and the statusline command pointing at
`/workspace/.claude/statusline.mjs` on the bind-mounted workspace. None of this
touches the host's own Claude configuration. The template is the source of truth
for those settings, so a change to make belongs in it: the `~/.claude` volume is
per-`${devcontainerId}` and a hand-edit inside one is replaced the next time a
container is created against it. It also pre-seeds Claude Code's interactive
first-run state -- the onboarding and per-workspace trust prompts, which are
session state and are filled in rather than replaced -- and sets the VS Code
extension's own bypass mode in `devcontainer.json` (the extension does not honor
the CLI's `defaultMode`), so interactive sessions, terminal or extension, start
prompt-free as well. Headless `claude -p` skips these gates either way.

### What it does not protect against

Accepted residuals -- the same posture as the reference Claude Code container. The
firewall and container boundary are guardrails against reaching arbitrary hosts or
the host filesystem, not an airtight seal:

- **Allowlisted hosts are reachable by name on shared infrastructure.** The
  firewall matches destination IPs, so a host sharing a CDN edge with an
  allowlisted name (the npm registry and `nodejs.org` sit on Cloudflare; GitHub
  Pages/`raw`/the API are allowlisted wholesale) can be reached by sending a
  different SNI/Host to that IP. GitHub in particular is a usable exfiltration
  channel via `git`/`gh` whenever a token is present.
- **Actions log storage widens that to shared Azure clusters.** The
  `productionresultssa*` addresses are storage-cluster VIPs rather than addresses
  of GitHub's own, and many shards share one, so unrelated storage accounts --
  including ones an attacker creates -- sit on the same IPs and become reachable
  by the same different-Host trick. Same class as the GitHub channel above, and
  accepted for the same reason: reading a failed job's log is worth it.
- **A provided token grants real GitHub write access.** When `GH_TOKEN` is set in
  `.env` (see Prerequisites), the container can push feature branches and open
  PRs. The push hook refuses `staging`/`main` and branch protection rejects them
  server-side, but any other branch is writable, and -- as the bullet above notes --
  `git`/`gh` over an allowlisted GitHub IP is then a usable exfiltration channel.
  Scope the token narrowly (a fine-grained PAT limited to this repo, contents +
  pull-requests write) so a leak cannot reach other repos. With no token, push/PR
  are unauthenticated and fail.
- **The push hook is not a security boundary.** It blocks direct or accidental
  pushes to `staging`/`main`, but a wrapped command (`sh -c`, `eval`, a subshell,
  `git -c remote.origin.push=...`) bypasses it, and it does not gate `gh` API
  writes (`gh pr merge`, `gh api`) at all. GitHub branch protection enforces
  `staging`/`main` server-side across every path -- that is the wall; the hook is
  fast local feedback for an unattended agent, nothing more.
- **DNS egress is permitted** to the container's resolver -- a low-bandwidth
  exfiltration channel an IP allowlist cannot close.
- **A write into the workspace is a write to the host repo.** The workspace bind is
  read-write, so a planted `.git/hooks/*` or edited file persists on the host and
  can run there later. Treat what runs inside as you would any code in the repo.

Closing the first three would need a name-aware egress proxy. The
[infrastructure profile](#infrastructure-profile) below runs one, but only over
the destinations it adds: those are admitted by hostname, so a host sharing a
CDN edge with an admitted name is not reachable there by sending a different
SNI. It narrows none of the bullets above -- the IP allowlist is unchanged, and
every host it admits is still reached directly and by address -- and it carries
residuals of its own, listed with it.

## Prerequisites

- Docker on the host (Docker Desktop on macOS).
- Git identity: VS Code's Dev Containers feature shares the host `~/.gitconfig`
  into the container automatically. With the bare `devcontainer` CLI, set it once
  inside (`git config --global user.name/.email`) if you need to commit. Run it
  yourself rather than asking a session to: agents are blocked from setting a git
  identity, so that a commit's author is always the one git resolves from config.
- Push/PR credentials (optional): to let a session push and open PRs from inside,
  copy `.env.example` to `.env` at the repository root and set `GH_TOKEN` to a
  GitHub PAT. The container loads `.env` via docker `--env-file` (`devcontainer.json`
  `runArgs`) and `post-create.sh` runs `gh auth setup-git`, so both `git push`
  (HTTPS) and `gh pr create` authenticate with no prompt. Use a fine-grained PAT
  scoped to this repo (contents + pull-requests write); add the organization
  Projects (read and write) permission as well if the session uses the
  `.claude/scripts` board tooling, since those hit the org's GitHub Projects
  v2 API, which the repository contents/pull-requests scopes do not cover.
  `.env` is gitignored.
  `--env-file` is **literal**: write `GH_TOKEN=<value>` unquoted, with no `export`,
  and with no inline `# comment` -- quotes, an `export` prefix, and a trailing
  comment all become part of the token value (a corrupted token then fails only
  later, at push time). `GITHUB_TOKEN` is accepted as an alternative name. With no
  `.env` (an empty one is created automatically so the container always starts),
  push/PR stay unauthenticated.
- Claude credentials (optional): each container's `~/.claude` is a separate
  per-`${devcontainerId}` volume, so by default every container needs its own
  one-time browser `/login` -- friction once several agents run in parallel. To
  reuse one host-side login instead, run `claude setup-token` on the host and add
  the resulting `CLAUDE_CODE_OAUTH_TOKEN=<token>` to `.env` at the repository root
  -- the same gitignored file and `--env-file` path as `GH_TOKEN` above, with the
  same literal rules (unquoted, no `export`, no inline `# comment`). Claude then
  authenticates with no per-container login. The token is inference-scoped and
  draws on your Claude subscription (Pro/Max/Team/Enterprise) rather than per-token
  API billing. Set only this credential, not `ANTHROPIC_API_KEY`: Claude Code's
  auth precedence lets an API key silently override an OAuth token when both are
  present, so setting both invites a surprise-billing footgun. With no token in
  `.env` (an empty one is created automatically so the container always starts),
  Claude falls back to the per-container `/login`. No firewall change is needed:
  the token authenticates against `api.anthropic.com`, already on the egress
  allowlist (`init-firewall.sh`). It is readable by anything running inside the
  container -- the same posture as `GH_TOKEN` -- so use a dedicated token and
  rotate or revoke it through your Claude account if it may be exposed.

## Using it

Open the repository in an editor with dev-container support and reopen in the
container, or use the `devcontainer` CLI. On first creation `post-create.sh` runs
`npm ci` into an isolated `node_modules` volume (kept separate from the
bind-mounted host tree so Linux-built native modules do not collide with the
host's macOS build) and builds `@psilink/core` so the apps resolve it. This runs
*before* the egress firewall (a start step), so the initial install has full
network access; the firewall constrains subsequent sessions.

Inside the container:

```sh
npm run build -w packages/core
npm run test                       # unit tests (core, cli, web)
npm run lint
npm run typecheck
npm run test:integration -w apps/cli                          # in-process SFTP
PSILINK_SFTP_BACKEND=native npm run test:integration -w apps/cli   # native sshd
npm run test:integration:webrtc -w apps/cli                   # loopback WebRTC transport
npm run dev -w apps/web            # web dev server on localhost:3000
```

With a `GH_TOKEN` set in `.env` (see Prerequisites) a session can push feature
branches and open PRs from inside; pushes to `staging`/`main` are refused by the
push hook and by GitHub branch protection. With no token, push/PR are
unauthenticated and fail.

## Infrastructure profile

A second configuration, `.devcontainer/infra/devcontainer.json`, for the work
the default profile cannot do at all: AWS, Cloudflare, Let's Encrypt, a remote
Docker daemon over SSH, and the standards and literature sites. Today that work
is handed to the host, where there is no container wall at all -- this profile
is the alternative to that.

It is the same image and the same egress firewall, with the same mounts plus
one, and it adds:

- **The AWS CLI v2**, at a pinned version, from the official installer archive.
  The two architecture digests in the Dockerfile were taken from archives whose
  detached signatures verified against the AWS CLI Team key
  `FB5D B77F D5C1 18B8 0511  ADA8 A631 0ACC 4672 475C`; the build re-checks the
  digest. AWS publishes no checksum file, so re-verify a version bump the same
  way rather than pasting a digest from the download.
- **The Docker CLIENT only** (`docker-ce-cli`, from Docker's signed apt
  repository), for `docker -H ssh://user@host` against a remote daemon.
- **A second egress lane**: a `tinyproxy` HTTP CONNECT proxy on
  `127.0.0.1:8888`, default-deny, admitting a destination by HOSTNAME.

### Choosing it

The Dev Containers specification reads any `.devcontainer/<name>/devcontainer.json`
as a configuration of its own, so VS Code's "Reopen in Container" offers a
picker once there is more than one: choose `<folder>-infra`. With the bare
`devcontainer` CLI, name it:

```sh
devcontainer up --workspace-folder . --config .devcontainer/infra/devcontainer.json
```

Nothing about the default profile changes by adding it; a session that never
picks it sees the container it saw before.

### Why a second lane rather than a wider allowlist

`init-firewall.sh` matches destination IPs, and an IP allowlist cannot express
AWS: EC2 in us-west-2 alone publishes 169 prefixes, all shared-tenant, so
admitting them admits every other AWS customer's instance. A hostname allowlist
can: `ec2.us-west-2.amazonaws.com` is one name, and
`ec2-1-2-3-4.us-west-2.compute.amazonaws.com` is a different one.

So the firewall is left exactly as the default profile has it, and the proxy is
added beside it. One `iptables` rule connects the two: TCP egress is accepted
for packets owned by the `tinyproxy` uid, ahead of the IP-allowlist match and
the catch-all REJECT. Nothing else in the container gains an inch -- a process
that is not the proxy still reaches only the IP allowlist.

### The two lanes, and which one a request takes

`NO_PROXY` names loopback and the hosts the IP allowlist already admits
(`github.com` and its subdomains, `*.githubusercontent.com`,
`registry.npmjs.org`, `nodejs.org`, `api.anthropic.com`, `claude.ai`,
`console.anthropic.com`). Those go direct, byte-identically to the default
profile; only a NEW destination takes the proxy. Each host is listed in both the
bare (`github.com`) and the dotted (`.github.com`) form, because the clients in
the image resolve `NO_PROXY` in three separate implementations -- libcurl (curl,
and git over HTTPS), Go (gh), and Python (the aws CLI) -- and carrying both
forms means none of them depends on a spelling it may not honor.

`post-create.sh` clears the proxy variables for its own run: creation happens
before either lane exists, so an install that went looking for the proxy would
find a closed port.

SSH is the exception that has to be stated: `/etc/ssh/ssh_config.d/` routes
EVERY SSH destination through the proxy (`ProxyCommand nc -X connect`), because
`ssh` opens a socket the firewall would otherwise reject. `localhost` is exempt,
so the native `sshd` SFTP test backend is untouched. `github.com` is on the
proxy allowlist for this reason as well as being on the IP one.

### The allowlist

`.devcontainer/infra/egress-allowlist`, one pattern per line with the reason for
each group. It is baked into the image at build time, the way `init-firewall.sh`
is, rather than read from the bind-mounted workspace -- so adding a host to it
is a repository change and a rebuild, not an edit a running session can make.

Matching is `fnmatch`, so a pattern without `*` matches that host and nothing
else (`example.com` does not admit `notexample.com`). A `*` is accepted only
inside a pattern's first label; `*`, `*.com`, and anything carrying a character
a hostname cannot hold are rejected, and a rejected pattern refuses the whole
start rather than being skipped.

For a host that should not be a repository change -- a zone name, a particular
instance address -- set `PSILINK_EGRESS_EXTRA_HOSTS` in `.env` to a
comma-separated list. Every entry in it is probed at start and the start fails
if the filter does not actually admit it, so a typo is loud rather than silent.

### Credentials

Put AWS credentials in the repository-root `.env`, the same gitignored file and
`--env-file` path as `GH_TOKEN`, under the same **literal** rules -- unquoted, no
`export`, no inline `# comment`:

```
AWS_ACCESS_KEY_ID=<access key id>
AWS_SECRET_ACCESS_KEY=<secret access key>
AWS_DEFAULT_REGION=us-west-2
```

Two things follow from that, both the same posture as `GH_TOKEN` and
`CLAUDE_CODE_OAUTH_TOKEN`. The credentials are readable by anything running in
the container, so use a dedicated IAM principal scoped to what the work needs
and rotate it if it may be exposed. And the host's own `~/.aws` is deliberately
NOT mounted: an environment credential is the one the container was given, while
a mounted profile directory is whatever the owner's default profile happens to
be, which is usually far more than the task.

An SSH private key for a remote host goes in `.devcontainer/infra/local/`, bind
mounted read-only at `/home/node/infra-local`. The directory is gitignored, and
`.claude/settings.json` denies Claude's Read and Edit tools on it -- a floor
against the common path, not a wall, exactly as the `.env` deny rules are: an
arbitrary shell command still reads it.

### Deliberately absent

**The host's Docker socket.** Mounting it is the usual way to give a container
Docker, and it would delete the container boundary that is layer 1 of the
security model above: the socket is root on the host, so anything that can write
it can start a privileged container and read or write the whole host filesystem.
The client is installed without a daemon instead, for `docker -H
ssh://user@host` against a remote one. `/var/run/docker.sock` does not exist in
the image and nothing here creates it.

### What the second lane does not protect against

On top of the residuals listed for both profiles above:

- **A CONNECT tunnel carries anything.** The proxy sees the hostname and the
  port, then joins two sockets. It does not inspect what flows through, so an
  admitted host on 443 is a channel for whatever an agent wants to send it. The
  allowlist decides who can be talked to, never what is said. `ConnectPort`
  limits tunnels to 443 and 22, which is the whole of the width control.
- **Two admitted namespaces are other people's.**
  `*.s3.us-west-2.amazonaws.com` is any account's bucket and
  `*.execute-api.us-west-2.amazonaws.com` is any account's API Gateway stage.
  They are admitted deliberately -- virtual-hosted-style S3 is how the aws CLI
  addresses a bucket -- and are a channel to storage and to an HTTP endpoint an
  adversary controls. `*.compute.amazonaws.com`, the same shape for EC2
  instances, is NOT admitted, and admitting it would give away the reason this
  profile exists.
- **DNS is still open**, exactly as in the default profile, and now resolves for
  the proxy as well.
- **`PSILINK_EGRESS_EXTRA_HOSTS` is an environment variable**, so it is
  operator convenience rather than a boundary: anything running as `node` can
  re-run the proxy script with a widened list. The container boundary is what
  confines a session; this lane, like the firewall, is a guardrail.
- **The proxy logs refusals, not traffic.** `/var/log/psilink-egress-proxy.log`
  is world-readable and records each filtered host at `Notice` level; a
  successful tunnel is not logged, so the file answers "what was refused", not
  "where did this container go".

### Verify it yourself

Inside the container, after start:

```sh
sudo iptables -S OUTPUT | head -3       # the uid rule sits ahead of everything
cat /etc/psilink-egress-proxy/filter    # the assembled allowlist
curl -x http://127.0.0.1:8888 -sS -o /dev/null -w '%{http_code}\n' \
  https://sts.us-west-2.amazonaws.com/                     # an HTTP status: reached
curl -x http://127.0.0.1:8888 https://example.com/         # 403 from the proxy
curl --noproxy '*' https://sts.us-west-2.amazonaws.com/    # refused by the firewall
curl -x http://127.0.0.1:8888 \
  https://ec2-1-2-3-4.us-west-2.compute.amazonaws.com/     # 403: instances stay out
aws sts get-caller-identity                                # an answer from AWS
ssh -T git@github.com                                      # through the tunnel
docker --version && test ! -e /var/run/docker.sock         # client, no socket
tail /var/log/psilink-egress-proxy.log                     # what was refused
```

Re-running `sudo /usr/local/bin/init-egress-proxy.sh` is safe: it tears down the
previous proxy and rule first, and if anything fails -- an unparseable pattern,
a proxy that will not start, a probe that does not answer as expected -- it
removes both again and exits non-zero, leaving egress exactly what
`init-firewall.sh` left it.
