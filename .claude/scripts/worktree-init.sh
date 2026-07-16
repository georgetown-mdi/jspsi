#!/usr/bin/env bash
# Provision node_modules in a fresh git worktree so build/test work without a full
# `npm install`. Run it once, from inside the worktree, before building or testing:
#
#   bash .claude/scripts/worktree-init.sh
#
# Why this is needed: `isolation:"worktree"` (and `git worktree add`) create a
# worktree with NO node_modules -- deps are gitignored, not copied -- so an isolated
# agent otherwise cannot build or run the suite. A full `npm install` per worktree
# is slow and can hit the protoc-gen-js download flake, so instead we mirror the
# primary tree's already-installed deps by symlink.
#
# The trick: external deps are shared from the primary by absolute symlink, but a
# workspace package's own RELATIVE symlink (e.g. @psilink/core -> ../../packages/core)
# is copied verbatim, so it resolves to the worktree's own packages/core -- the
# worktree builds and tests its own core while sharing every external dep. npm does
# not hoist everything (apps/web keeps its own @mantine), so each workspace's own
# node_modules is mirrored too. Build caches are skipped so the worktree starts cold.
# Idempotent: safe to re-run (it refreshes the core build).
set -euo pipefail
shopt -s dotglob nullglob

WORKTREE="$(git rev-parse --show-toplevel)"
PRIMARY="$(cd "$(dirname "$(git rev-parse --git-common-dir)")" && pwd)"

if [ "$WORKTREE" = "$PRIMARY" ]; then
  echo "worktree-init: this IS the primary tree ($PRIMARY); nothing to provision."
  exit 0
fi

# Mirror one node_modules tree from the primary into the worktree. A symlink (a
# workspace package's relative link) is copied verbatim so it resolves to the
# worktree's own copy; a scope dir (@foo) is recursed one level so its own workspace
# links get the same treatment; every other real dep is shared by absolute symlink.
mirror_node_modules() {
  local src="$1" dest="$2" entry name target
  [ -d "$src" ] || return 0
  mkdir -p "$dest"
  for entry in "$src"/*; do
    name="$(basename "$entry")"
    case "$name" in .vite | .vite-temp | .cache) continue ;; esac
    target="$dest/$name"
    if [ -e "$target" ] || [ -L "$target" ]; then continue; fi
    if [ -L "$entry" ]; then
      cp -P "$entry" "$target"
    elif [[ "$name" == @* ]] && [ -d "$entry" ]; then
      mirror_node_modules "$entry" "$target"
    else
      ln -s "$entry" "$target"
    fi
  done
}

if [ ! -d "$PRIMARY/node_modules" ]; then
  echo "worktree-init: $PRIMARY/node_modules does not exist; run 'npm install' in $PRIMARY first." >&2
  exit 1
fi

mirror_node_modules "$PRIMARY/node_modules" "$WORKTREE/node_modules"
for pkgdir in "$PRIMARY"/apps/*/ "$PRIMARY"/packages/*/; do
  rel="${pkgdir#"$PRIMARY"/}"
  mirror_node_modules "${pkgdir}node_modules" "$WORKTREE/${rel}node_modules"
done

echo "worktree-init: node_modules provisioned; building @psilink/core ..."
npm run build -w packages/core >/dev/null
echo "worktree-init: done. @psilink/core resolves to $WORKTREE/packages/core."
