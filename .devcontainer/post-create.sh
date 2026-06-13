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

# Default this container's Claude sessions to prompt-free. The container's egress
# firewall plus the checked-in command deny-list in .claude/settings.json are the
# safety floor (deny rules are enforced even in bypassPermissions mode), so
# prompts add nothing here. This sets only the CONTAINER's user settings (a
# mounted volume), never the project or host config, so it does not change how
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

echo "post-create complete: dependencies installed; container Claude sessions default to prompt-free."
