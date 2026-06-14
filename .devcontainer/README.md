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
   where there is no container wall behind them.

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

Closing the first three would need a name-aware egress proxy, which is out of
scope here.

## Prerequisites

- Docker on the host (Docker Desktop on macOS).
- Git identity: VS Code's Dev Containers feature shares the host `~/.gitconfig`
  into the container automatically. With the bare `devcontainer` CLI, set it once
  inside (`git config --global user.name/.email`) if you need to commit.
- Push/PR credentials (optional): to let a session push and open PRs from inside,
  copy `.env.example` to `.env` at the repository root and set `GH_TOKEN` to a
  GitHub PAT. The container loads `.env` via docker `--env-file` (`devcontainer.json`
  `runArgs`) and `post-create.sh` runs `gh auth setup-git`, so both `git push`
  (HTTPS) and `gh pr create` authenticate with no prompt. Use a fine-grained PAT
  scoped to this repo (contents + pull-requests write). `.env` is gitignored.
  `--env-file` is **literal**: write `GH_TOKEN=<value>` unquoted, with no `export`,
  and with no inline `# comment` -- quotes, an `export` prefix, and a trailing
  comment all become part of the token value (a corrupted token then fails only
  later, at push time). `GITHUB_TOKEN` is accepted as an alternative name. With no
  `.env` (an empty one is created automatically so the container always starts),
  push/PR stay unauthenticated.
- Claude credentials (optional): each container's `~/.claude` is a separate
  per-`${devcontainerId}` volume, so by default every container needs its own
  one-time browser `/login` -- friction once several agents run in parallel. To
  reuse one host-side login instead, run `claude setup-token` on the host and
  export the resulting `CLAUDE_CODE_OAUTH_TOKEN` in the shell that launches the
  container; `devcontainer.json` forwards it through `containerEnv` via
  `${localEnv:...}`, so Claude authenticates with no per-container login. The
  token is inference-scoped and draws on your Claude subscription
  (Pro/Max/Team/Enterprise) rather than per-token API billing. Only this one
  credential is forwarded, not `ANTHROPIC_API_KEY`: Claude Code's auth precedence
  lets an API key silently override an OAuth token when both are set, so wiring
  both invites a surprise-billing footgun. Unlike `GH_TOKEN`, the token comes from
  the launching process's *shell environment*, not from `.env` -- so start VS Code
  or the `devcontainer` CLI from a shell where the variable is exported (a
  GUI-launched editor may not inherit it). With no token set the variable forwards
  empty, the passthrough is inactive, and the container still starts with the
  per-container `/login` available as the fallback. No firewall change is needed:
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
npm run dev -w apps/web            # web dev server on localhost:3000
```

With a `GH_TOKEN` set in `.env` (see Prerequisites) a session can push feature
branches and open PRs from inside; pushes to `staging`/`main` are refused by the
push hook and by GitHub branch protection. With no token, push/PR are
unauthenticated and fail.
