#!/bin/bash
set -euo pipefail

# Runs once on container creation, before the egress firewall is applied (the
# firewall is a postStartCommand), so this install reaches the full network.

# The infra profile puts HTTP(S)_PROXY in containerEnv, but the proxy it names
# is started by a postStartCommand, so nothing is listening on that port while
# this script runs and every fetch below would fail against a closed loopback
# port. Creation is the one moment with no egress lane and no need of one, so
# clear the variables for this script alone. Unset in the default profile, where
# this is a no-op.
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy

# Install workspace dependencies into the node_modules volume (isolated from the
# bind-mounted host tree by devcontainer.json), building any native pieces for
# this Linux container rather than reusing the host's macOS build. `npm ci` is the
# reproducible, lockfile-faithful install for the from-scratch volume.
npm ci

# Build @psilink/core so the apps resolve it immediately: they import it from its
# built dist/, which is gitignored and lives on the bind-mounted tree (not the
# node_modules volume), so a fresh container would otherwise see it unbuilt.
npm run build -w packages/core

# Fetch the Chromium build the web app's browser test suite drives via Playwright.
# Here -- after `npm ci`, so it installs with the exact playwright the lockfile
# just produced (the browser is keyed to a build revision tied to that version, so
# this keeps them matched automatically) -- and before the egress firewall (a
# postStartCommand), so the one-time download from Playwright's CDN reaches the
# network. The shared libraries Chromium links against are baked into the image
# (.devcontainer/Dockerfile); this pulls only the browser binary, so it needs no
# root. Requires playwright >= 1.60 (the version that fixed the Node 26 zip-extract
# hang); the lockfile floor is set accordingly in apps/web/package.json.
npx playwright install chromium

# Write this container's Claude user settings from the tracked template beside
# this script, which is their single source of truth: prompt-free operation
# (`bypassPermissions` -- the container's egress firewall plus the checked-in
# deny-list and protected-branch push hook are the safety floor, and both deny
# rules and PreToolUse hooks apply even in that mode), the session model and
# effort, the editor and TUI preferences, and the statusline, read from the
# workspace bind-mount so the repository carries the one copy.
#
# The copy is wholesale rather than key-by-key: the ~/.claude volume outlives
# nothing but the container it was created for, and a volume seeded once then
# hand-edited drifts from the template with no signal at all. An edit that
# should survive a re-create belongs in the template, in the repository, where
# it is reviewed like any other change.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
mkdir -p "$CONFIG_DIR"
cp "$SCRIPT_DIR/claude-settings.json" "$CONFIG_DIR/settings.json"

# Pre-seed Claude Code's interactive first-run state so sessions in this container
# open at the prompt instead of the theme/welcome onboarding and the per-workspace
# "Do you trust the files in this folder?" dialog. Auth (CLAUDE_CODE_OAUTH_TOKEN or
# a per-container login) is separate and unaffected, and headless `claude -p` skips
# these gates already -- this is for the interactive CLI and the VS Code extension,
# which share this config dir. These keys live in .claude.json and are internal to
# Claude Code (undocumented), captured against 2.1.177 -- re-verify on an upgrade.
# Unlike settings.json above this file is seeded rather than replaced: it is
# Claude Code's own state for this container, so it fills only missing keys and
# refuses to overwrite an unreadable file.
CLAUDE_JSON="$CONFIG_DIR/.claude.json" WORKSPACE="/workspace" node -e '
  const fs = require("fs");
  const path = process.env.CLAUDE_JSON;
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error("refusing to overwrite existing " + path + ": " + err.message);
      process.exit(1);
    }
  }
  if (!state.hasCompletedOnboarding) state.hasCompletedOnboarding = true;
  state.projects = state.projects || {};
  const ws = (state.projects[process.env.WORKSPACE] =
    state.projects[process.env.WORKSPACE] || {});
  if (!ws.hasTrustDialogAccepted) ws.hasTrustDialogAccepted = true;
  if (!ws.hasCompletedProjectOnboarding) ws.hasCompletedProjectOnboarding = true;
  fs.writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
'

# Wire git push (over HTTPS) and the gh CLI to a GitHub token when one is present.
# devcontainer.json loads a repo-root .env into the container via docker
# --env-file; `gh auth setup-git` then registers gh as git's credential helper, so
# both `git push` and `gh pr create` authenticate with no interactive prompt.
# Pushes to staging/main are still refused by the protected-branch hook and,
# server-side, by GitHub branch protection. With no token forwarded, push/PR stay
# unauthenticated -- the prior posture -- so skip rather than failing creation.
if [ -n "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ]; then
  gh auth setup-git || echo "post-create: warning -- 'gh auth setup-git' failed; 'git push' over HTTPS may prompt."
else
  echo "post-create: no GH_TOKEN/GITHUB_TOKEN in env; skipping git credential setup (push/PR unauthenticated)."
fi

echo "post-create complete: dependencies installed; container Claude sessions default to prompt-free."
