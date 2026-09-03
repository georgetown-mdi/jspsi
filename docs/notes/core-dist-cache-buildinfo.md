---
title: "Dropping the Restored Core Build's tsconfig.tsbuildinfo"
---

# Core dist cache buildinfo: why a cache hit drops it

_Status: decided and built. This note records the `RollupError` a
`packages/core/dist` cache hit produced, the single condition that flips it,
the alternatives measured and set aside, and the decision taken in
`.github/actions/setup/action.yml`'s restore, restamp, and save steps for the
core build cache. See [docs/notes/README.md](README.md)._

## What was measured

A pull request with a `packages/core/dist` cache hit failed the web suite's
`pretest` build with:

    RollupError: rollup.config.ts (43:29): Expected ',', got ':'

-- rollup parsing raw TypeScript because `@rollup/plugin-typescript` served it
no transpiled config. Reproduced byte-for-byte from a fresh clone: build core,
archive `dist/`, delete it, restamp every tracked file to simulate a fresh
checkout, extract the archive back, then run the build the suite's `pretest`
runs.

The single difference that flips the result is whether
`packages/core/.rollup.cache/` is present. `packages/core/tsconfig.json` sets
`composite: true`, so a build maintains two artifacts that must stay in step:
`dist/tsconfig.tsbuildinfo`, which tells TypeScript "already emitted, skip",
and `.rollup.cache/`, the copy `@rollup/plugin-typescript` serves instead when
TypeScript skips emitting. `.rollup.cache/` is gitignored and was never part of
the cached path, so a fresh checkout has none; a cache **hit** restores the
buildinfo without it, TypeScript decides `rollup.config.ts` is unchanged and
emits nothing, the plugin's cache fallback has nothing to serve, and rollup
reads the raw `.ts` file. A cache **miss** runs a full `npm run build -w
packages/core`, which writes both artifacts together, so the later `pretest`
build is served from `.rollup.cache/` and succeeds -- the asymmetry the
symptom shows only on a hit.

## Mechanism

The restore step's `dist` cache key already hashes `packages/core/src`,
`rollup.config.ts`, and the tsconfig chain, so a hit binds the artifact to its
inputs by content. The buildinfo is the one entry under `dist/` that is state
rather than product: nothing downstream reads it (the apps import the built
`core.esm.js` / `core.cjs` / `index.d.ts`, and the freshness guard in
`docs/TESTING.md` compares source-to-dist mtimes, not the buildinfo), and its
own `include` covers `packages/core/test/**` and `vitest.config.ts`, both
outside the cache key -- so a restored buildinfo can describe a file set the
checkout does not have, independent of the `.rollup.cache/` gap.

## Alternatives considered

- **Cache `.rollup.cache/` alongside `dist/`.** Rejected: its filenames embed
  the build's absolute path, so a runner or a local repro tree at a different
  path reproduces the same `RollupError` against a restored copy of its own
  cache. It also duplicates every emitted file a second time.
- **Restamp differently** (e.g. stamping `dist/` older than sources instead of
  touching every file to now). Rejected: the failure reproduces with and
  without the restamp, and with every source-vs-dist mtime ordering tried --
  restamping addresses the freshness guard and is orthogonal to this failure.
- **Exclude the buildinfo from the cached path list alone, without removing
  it on a hit.** Rejected as the sole fix: an entry already saved under its
  content-derived key is immutable, so an exclusion added going forward does
  not stop a currently-cached entry from continuing to restore the buildinfo
  it was saved with.

## Decision

A cache hit removes the restored `tsconfig.tsbuildinfo` before restamping, and
the cached path list excludes it going forward so a future save stops writing
it -- the removal stays because the exclusion cannot reach an entry already
saved. Both changes are in the restore, restamp, and save steps of
`.github/actions/setup/action.yml`. The cost is that the pretest build under a
dist hit now does a full emit instead of a cache-served one -- the same work a
cache-miss job already pays; the dist restore itself still pays for the rest
of the build.

## What this does not cover

This is scoped to the composite build's own TypeScript emit cache. It does not
change what `packages/core/dist` cache key binds, the freshness guard compared
in `docs/TESTING.md`, or the install-tree cache the same action also restores.
