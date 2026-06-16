#!/bin/bash
set -euo pipefail

# Runs once on container creation, before the egress firewall is applied (the
# firewall is a postStartCommand), so this install reaches the full network.

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
# Here -- after `npm ci`, so the browser tracks the locked playwright version, and
# before the egress firewall (a postStartCommand), so the one-time CDN download
# reaches the network. The shared libraries Chromium links against are baked into
# the image (.devcontainer/Dockerfile); this pulls only the browser binary, so it
# needs no root. The test:browser run itself is loopback-only (dev server on
# 127.0.0.1), so the firewall does not affect it.
npx playwright install chromium

# Default this container's Claude sessions to prompt-free. The container's egress
# firewall plus the checked-in deny-list and protected-branch push hook in
# .claude/ are the safety floor (both deny rules and PreToolUse hooks apply even in
# bypassPermissions mode), so prompts add nothing here. This sets only the
# CONTAINER's user settings (a mounted volume), never the project or host config,
# so it does not change how
# Claude behaves on the host that shares this repo's .claude/settings.json. It is
# idempotent: it leaves an existing defaultMode untouched.
CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
mkdir -p "$CONFIG_DIR"
SETTINGS="$CONFIG_DIR/settings.json" node -e '
  const fs = require("fs");
  const path = process.env.SETTINGS;
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (err) {
    // A missing file is fine (start fresh); an existing but unreadable or invalid
    // one must not be silently overwritten -- abort and leave it for inspection.
    if (err.code !== "ENOENT") {
      console.error("refusing to overwrite existing " + path + ": " + err.message);
      process.exit(1);
    }
  }
  settings.permissions = settings.permissions || {};
  if (!settings.permissions.defaultMode) {
    settings.permissions.defaultMode = "bypassPermissions";
  }
  fs.writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
'

# Pre-seed Claude Code's interactive first-run state so sessions in this container
# open at the prompt instead of the theme/welcome onboarding and the per-workspace
# "Do you trust the files in this folder?" dialog. Auth (CLAUDE_CODE_OAUTH_TOKEN or
# a per-container login) is separate and unaffected, and headless `claude -p` skips
# these gates already -- this is for the interactive CLI and the VS Code extension,
# which share this config dir. These keys live in .claude.json and are internal to
# Claude Code (undocumented), captured against 2.1.177 -- re-verify on an upgrade.
# Idempotent: fills only missing keys and refuses to overwrite an unreadable file,
# matching the settings.json seeding above.
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
