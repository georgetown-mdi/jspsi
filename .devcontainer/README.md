# Development container

A plain Node 26 container in which an agent (or a developer) can run the whole
psilink workflow -- build, unit tests, lint, typecheck, the web dev server, and
both SFTP integration backends -- with no Docker inside it. It runs as the
non-root `node` user behind an egress firewall, so Claude can run prompt-free
with its writes confined to the container.

## What is inside

- **Node 26** (`node:26-bookworm`), matching the shipped runtime and CI.
- **OpenSSH server and client** plus the baked-in `/run/sshd` directory, so the
  native `sshd` SFTP test backend (`PSILINK_SFTP_BACKEND=native`) spawns without
  root. The in-process backend (the default) needs nothing extra.
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
   registry and `nodejs.org`), GitHub (its published IP ranges), the Anthropic
   API and login, and the VS Code extension CDN. Telemetry and updater hosts are
   absent: the container sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` and
   `DISABLE_AUTOUPDATER`, so Claude makes no such calls.
3. **Command deny-list** (`.claude/settings.json`, checked in): a guardrail that
   holds even with prompts disabled -- it denies `git push`, and through Claude's
   Read/Edit/Write tools it blocks reads and writes of SSH private keys and `.env`
   files and writes to `/etc`. Deny rules are enforced in every permission mode,
   including bypass. It is a floor against the common paths, not an airtight wall:
   an arbitrary shell command (`cp`, `tar`, a script) can still touch those files,
   which is why layer 1 -- the container boundary -- is the real protection. Note
   this file is checked in, so the same deny rules also apply to Claude sessions
   run against this repo *on the host*, where there is no container wall behind them.

`post-create.sh` sets `permissions.defaultMode: bypassPermissions` in the
container's *user* settings only, so sessions inside start prompt-free without
changing how Claude behaves on the host.

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
- **"Pushing is blocked" means literal `git push` plus the absence of
  credentials.** The deny-list blocks `git push`, not every `gh` write path
  (`gh pr create`, `gh api -X POST`, ...). In practice push fails because no push
  credential is mounted, not because every path is denied.
- **DNS egress is permitted** to the container's resolver -- a low-bandwidth
  exfiltration channel an IP allowlist cannot close.
- **A write into the workspace is a write to the host repo.** The workspace bind is
  read-write, so a planted `.git/hooks/*` or edited file persists on the host and
  can run there later. Treat what runs inside as you would any code in the repo.

Closing the first three would need a name-aware egress proxy, which is out of
scope here.

## Prerequisites

- Docker on the host (Docker Desktop on macOS).
- Git identity: VS Code's Dev Containers feature shares the host `~/.gitconfig`
  into the container automatically. With the bare `devcontainer` CLI, set it once
  inside (`git config --global user.name/.email`) if you need to commit; pushing
  is blocked from inside regardless.

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
npm run dev -w apps/web            # web dev server on localhost:3000
```

Pushing is intentionally blocked inside the container; push from the host.
