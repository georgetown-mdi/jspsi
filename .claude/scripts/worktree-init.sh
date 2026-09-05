#!/usr/bin/env bash
# Place a fresh git worktree on the branching base and provision its node_modules,
# so build/test work without a full `npm install`. Run it once, from inside the
# worktree, before your first edit (the base-ref re-point below only moves a
# tree that holds no work of its own):
#
#   bash .claude/scripts/worktree-init.sh
#
# Why this is needed: `isolation:"worktree"` (and `git worktree add`) create a
# worktree with NO node_modules -- deps are gitignored, not copied -- so an isolated
# agent otherwise cannot build or run the suite. A full `npm install` per worktree
# is slow, so instead we mirror the primary tree's already-installed deps by
# symlink.
#
# Sequencing: a task whose first act moves HEAD -- a rebase, a checkout of another
# branch -- does that move FIRST and runs this script after it. What gets installed
# is the lockfile at HEAD, so an install made before the move is thrown away by it.
#
# The base ref. The agent harness cuts an isolation worktree from the repository's
# default branch while this repo branches from `staging`, so a fresh tree starts
# life behind by however far those two have diverged, and an agent that does not
# think to check builds on months-old code. This script reconciles that before it
# installs anything: it fetches, and re-points a tree that holds nothing to lose
# onto origin/staging. A tree that does hold work is reported and provisioned where
# it stands, never moved -- a branch that fell behind while staging moved is the
# ordinary state of one, so a refusal there would fire on correct branches daily and
# teach agents to skip the script. Set PSILINK_WORKTREE_BASE_REF to work
# deliberately from another base. The check binds only a tree that runs this script.
#
# The mirroring trick: external deps are shared from the primary by absolute
# symlink, but a workspace package's own RELATIVE symlink (e.g. @psilink/core ->
# ../../packages/core) is copied verbatim, so it resolves to the worktree's own
# packages/core -- the worktree builds and tests its own core while sharing every
# external dep. npm does not hoist everything (apps/web keeps its own @mantine), so
# each workspace's own node_modules is mirrored too. Build caches are skipped so the
# worktree starts cold. Idempotent: safe to re-run (it refreshes the core build).
#
# Sharing an install means inheriting its state, so what is mirrored is checked
# against the worktree's own package-lock.json before anything is built: a primary
# that has fallen behind its lockfile otherwise hands every worktree the wrong
# package versions with no signal at all. check-node-modules-drift.mjs runs npm to
# decide that, and this script acts on its verdict rather than building on top of
# it. The check adds about two seconds; a per-worktree install costs minutes, which
# is the whole reason for the mirror.
#
# When the mirror is refused, the fallback is `npm ci` and never `npm install`:
# `npm ci` installs the lockfile's exact pins and cannot write package-lock.json,
# while `npm install` re-resolves against whatever the registry mirror currently
# serves -- against this container's lagging mirror that silently downgrades
# packages and rewrites the lockfile, leaving every worktree agent an unintended
# lockfile diff to notice and hand-revert before committing.
set -euo pipefail
shopt -s dotglob nullglob

DRIFT_CHECK="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/scripts/check-node-modules-drift.mjs"
WORKTREE="$(git rev-parse --show-toplevel)"
PRIMARY="$(cd "$(dirname "$(git rev-parse --git-common-dir)")" && pwd)"
BASE_REF="${PSILINK_WORKTREE_BASE_REF:-origin/staging}"

if [ "$WORKTREE" = "$PRIMARY" ]; then
  echo "worktree-init: this IS the primary tree ($PRIMARY); nothing to provision."
  exit 0
fi

git_here() { git -C "$WORKTREE" "$@"; }

# Everything the tree would lose if its branch were re-pointed: its own commits,
# and anything staged, modified, or untracked (ignored paths, node_modules among
# them, are not work).
tree_holds_work() {
  [ "$(git_here rev-list --count "${1}..HEAD")" -ne 0 ] ||
    [ -n "$(git_here status --porcelain)" ]
}

reconcile_base() {
  local base head behind ref
  echo "worktree-init: fetching origin to place this tree against $BASE_REF ..."
  if ! git_here fetch --quiet origin; then
    echo "worktree-init: 'git fetch origin' failed; reading the $BASE_REF this clone already has, which may be behind origin's." >&2
  fi
  if ! base="$(git_here rev-parse --verify --quiet "${BASE_REF}^{commit}")"; then
    echo "worktree-init: $BASE_REF names no commit in this clone. Fetch it, or set PSILINK_WORKTREE_BASE_REF to a ref this clone has." >&2
    exit 1
  fi

  head="$(git_here rev-parse HEAD)"
  behind="$(git_here rev-list --count "HEAD..${base}")"
  ref="$(git_here symbolic-ref --quiet --short HEAD || echo "detached HEAD")"
  if [ "$behind" -eq 0 ]; then
    if [ "$head" = "$base" ]; then
      echo "worktree-init: $ref is at $BASE_REF ($(git_here rev-parse --short "$base"))."
    else
      echo "worktree-init: $ref is $(git_here rev-list --count "${base}..HEAD") commit(s) ahead of $BASE_REF ($(git_here rev-parse --short "$base")); leaving it where it is."
    fi
    return 0
  fi

  if ! tree_holds_work "$base"; then
    echo "worktree-init: this tree sits at $(git_here rev-parse --short HEAD), $behind commit(s) behind $BASE_REF -- the harness cuts a worktree from the default branch, and this repo branches from staging."
    echo "worktree-init: it holds no commits or edits of its own, so re-pointing $ref onto $BASE_REF. Set PSILINK_WORKTREE_BASE_REF (e.g. to HEAD) to keep another base."
    git_here reset --hard --quiet "$base"
    echo "worktree-init: $ref is now at $(git_here rev-parse --short HEAD)."
    return 0
  fi

  {
    echo "worktree-init: NOT re-pointing $ref. It is $behind commit(s) behind $BASE_REF and holds work of its own, which re-pointing it would move:"
    git_here --no-pager log --oneline "${base}..HEAD" | sed 's/^/  commit /'
    git_here status --porcelain | sed 's/^/  /'
    echo "worktree-init: provisioning it on the base it has. To put that work on $BASE_REF instead, from inside this worktree --"
    echo "  git stash --include-untracked   # only if the listing above shows uncommitted files"
    echo "  git rebase --onto $BASE_REF $(git_here rev-parse --short "$(git_here merge-base HEAD "$base")")"
    echo "  git stash pop"
    echo "worktree-init: a base that is deliberate rather than stale is named by PSILINK_WORKTREE_BASE_REF, which silences this."
  } >&2
}

# Mirror one node_modules tree from the primary into the worktree. A symlink (a
# workspace package's relative link) is copied verbatim so it resolves to the
# worktree's own copy; a scope dir (@foo) and .bin are recursed so their own
# entries get the same treatment -- .bin holds relative shim links, and copying
# them verbatim makes `npm run` resolve binaries through THIS tree's packages
# instead of executing the primary's; every other real dep is shared by absolute
# symlink.
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
    elif [[ "$name" == @* || "$name" == .bin ]] && [ -d "$entry" ]; then
      mirror_node_modules "$entry" "$target"
    else
      ln -s "$entry" "$target"
    fi
  done
}

# Discard the mirror and install this branch's own lockfile. `rm -rf` unlinks a
# symlink rather than descending into it, so the primary's packages are never
# reached through the mirror it is deleting.
install_from_lockfile() {
  local pkgdir saved status=0
  echo "worktree-init: installing this branch's package-lock.json into $WORKTREE with 'npm ci' -- exact pins, no lockfile write, and nothing installed into $PRIMARY."
  rm -rf "$WORKTREE/node_modules"
  for pkgdir in "$WORKTREE"/apps/*/ "$WORKTREE"/packages/*/; do
    rm -rf "${pkgdir}node_modules"
  done

  saved="$(mktemp)"
  cp "$WORKTREE/package-lock.json" "$saved"
  (cd "$WORKTREE" && npm ci --no-audit --no-fund) || status=$?
  if [ "$status" -ne 0 ]; then
    if ! cmp -s "$saved" "$WORKTREE/package-lock.json"; then
      cp "$saved" "$WORKTREE/package-lock.json"
      echo "worktree-init: the failed 'npm ci' had rewritten package-lock.json; restored the committed bytes." >&2
    fi
    rm -f "$saved"
    {
      echo "worktree-init: 'npm ci' failed (exit $status), so this tree has no deps to build or test on."
      echo "worktree-init: a pin the container's registry mirror has not caught up to fails here as a missing version -- that is mirror lag, to be reported as itself. Do NOT reach for 'npm install': it resolves whatever the mirror does hold, downgrading packages and rewriting package-lock.json."
    } >&2
    exit 1
  fi
  if ! cmp -s "$saved" "$WORKTREE/package-lock.json"; then
    cp "$saved" "$WORKTREE/package-lock.json"
    rm -f "$saved"
    echo "worktree-init: 'npm ci' rewrote package-lock.json. Restored the committed bytes and stopped -- the installed tree is not this branch's, and an unintended lockfile diff must not reach a commit." >&2
    exit 1
  fi
  rm -f "$saved"
  echo "worktree-init: npm ci done; these deps are this branch's lockfile, not $PRIMARY's install."
}

reconcile_base

if [ ! -d "$PRIMARY/node_modules" ]; then
  echo "worktree-init: $PRIMARY/node_modules does not exist; run 'npm install' in $PRIMARY first." >&2
  exit 1
fi

mirror_node_modules "$PRIMARY/node_modules" "$WORKTREE/node_modules"
for pkgdir in "$PRIMARY"/apps/*/ "$PRIMARY"/packages/*/; do
  rel="${pkgdir#"$PRIMARY"/}"
  mirror_node_modules "${pkgdir}node_modules" "$WORKTREE/${rel}node_modules"
done

echo "worktree-init: node_modules provisioned; checking it against package-lock.json ..."
check_status=0
node "$DRIFT_CHECK" "$WORKTREE" --shared-from "$PRIMARY" || check_status=$?
if [ "$check_status" -eq 2 ]; then
  echo "worktree-init: the check could not verify the mirrored deps against package-lock.json, so nothing vouches for a build and test run on them." >&2
  install_from_lockfile
elif [ "$check_status" -ne 0 ]; then
  echo "worktree-init: a build and test run against the mirrored deps would not be this branch's." >&2
  install_from_lockfile
fi

echo "worktree-init: building @psilink/core ..."
npm run build -w packages/core >/dev/null
echo "worktree-init: done. @psilink/core resolves to $WORKTREE/packages/core."
