// The apps import `@psilink/core` from its built `dist/`, never from
// `packages/core/src`, so a run whose dist predates the sources it was built
// from tests yesterday's library and reports failures that belong to the build.
// This is the vitest `globalSetup` that turns that into one named error before a
// single test runs, in place of a suite-wide red no one can attribute.
//
// It is registered at the ROOT `test` block of each app's vitest config, which
// vitest runs once per run rather than per project, so a project added later is
// covered without touching it.
//
// Freshness is an mtime comparison, which reads the filesystem's clock rather
// than the build's inputs: it detects the ordinary staleness (an edited or
// checked-out source newer than the artifact) and cannot detect a dist built
// from a source that was later reverted to identical bytes. A build system's
// content hash would; the cost of one is not worth what it buys over `npm run
// build -w packages/core`.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

/** The rebuild a stale dist needs, as the operator would type it. */
export const CORE_BUILD_COMMAND = "npm run build -w packages/core";

/** Opt-out to run against the dist as it stands. */
export const ALLOW_STALE_ENV = "PSILINK_ALLOW_STALE_CORE_DIST";

/** `packages/core` of the repository this module is checked out in. */
export const CORE_DIR = fileURLToPath(
  new URL("../../packages/core/", import.meta.url),
);

// Sources rollup reads (rollup.config.ts names src/main.ts, src/testing.ts, and
// src/untrustedText.ts as its inputs). package.json is absent by design: npm
// rewrites it during some install flows, which would report staleness the
// build cannot resolve.
const SOURCE_PATHS = ["src", "rollup.config.ts"];

/**
 * Every `./dist/...` path `packages/core/package.json` publishes, which is what
 * an app resolves when it imports the package. Derived from the manifest rather
 * than listed here so a new entry point is covered, and so a leftover artifact
 * of an older build that nothing exports cannot report staleness forever.
 */
export function coreDistEntries(coreDir = CORE_DIR) {
  const manifest = JSON.parse(
    readFileSync(join(coreDir, "package.json"), "utf8"),
  );
  const entries = new Set();
  const walk = (node) => {
    if (typeof node === "string") {
      if (node.startsWith("./dist/")) entries.add(node.slice(2));
      return;
    }
    if (node && typeof node === "object") Object.values(node).forEach(walk);
  };
  walk(manifest.exports);
  return [...entries].sort();
}

// The newest file in a tree, or null where the path does not exist. Returns the
// path alongside the time so the error can name the file that outran the build.
function newestUnder(root, path) {
  let newest = null;
  const visit = (relPath) => {
    let stats;
    try {
      stats = statSync(join(root, relPath));
    } catch {
      return;
    }
    if (stats.isDirectory()) {
      for (const child of readdirSync(join(root, relPath))) {
        visit(join(relPath, child));
      }
      return;
    }
    if (newest === null || stats.mtimeMs > newest.mtimeMs) {
      newest = { path: relPath, mtimeMs: stats.mtimeMs };
    }
  };
  visit(path);
  return newest;
}

/**
 * `null` when the built dist is at least as new as every source it is built
 * from, otherwise what is wrong: `{ kind: "missing", missing }` for an absent
 * artifact, or `{ kind: "stale", source, dist }` naming the newest source and
 * the artifact it outran.
 */
export function describeCoreDistStaleness(coreDir = CORE_DIR) {
  const missing = [];
  let oldestDist = null;
  for (const entry of coreDistEntries(coreDir)) {
    let stats;
    try {
      stats = statSync(join(coreDir, entry));
    } catch {
      missing.push(entry);
      continue;
    }
    if (oldestDist === null || stats.mtimeMs < oldestDist.mtimeMs) {
      oldestDist = { path: entry, mtimeMs: stats.mtimeMs };
    }
  }
  if (missing.length > 0) return { kind: "missing", missing };
  // An exports map with no dist entry at all: nothing to compare, and nothing
  // an app could be importing stale.
  if (oldestDist === null) return null;

  let newestSource = null;
  for (const path of SOURCE_PATHS) {
    const candidate = newestUnder(coreDir, path);
    if (candidate === null) continue;
    if (newestSource === null || candidate.mtimeMs > newestSource.mtimeMs) {
      newestSource = candidate;
    }
  }
  if (newestSource === null || newestSource.mtimeMs <= oldestDist.mtimeMs) {
    return null;
  }
  return { kind: "stale", source: newestSource, dist: oldestDist };
}

const stamp = (mtimeMs) => new Date(mtimeMs).toISOString();

/** The operator-facing error text for a {@link describeCoreDistStaleness} result. */
export function formatCoreDistStaleness(
  staleness,
  coreDir = CORE_DIR,
  cwd = process.cwd(),
) {
  const where = relative(cwd, coreDir) || coreDir;
  const at = (path) => join(where, path);
  const cause =
    staleness.kind === "missing"
      ? `@psilink/core has no built dist: ` +
        `${staleness.missing.map(at).join(", ")} ` +
        `${staleness.missing.length === 1 ? "is" : "are"} missing.`
      : `@psilink/core's built dist is older than its sources: ` +
        `${at(staleness.source.path)} (${stamp(staleness.source.mtimeMs)}) is newer ` +
        `than ${at(staleness.dist.path)} (${stamp(staleness.dist.mtimeMs)}).`;
  return (
    `${cause}\nThe suites import the built package, so this run would report ` +
    `failures that belong to the build rather than to the code under test. ` +
    `Rebuild first:\n\n    ${CORE_BUILD_COMMAND}\n\n` +
    `Set ${ALLOW_STALE_ENV}=1 to run against the dist as it stands.`
  );
}

/**
 * The vitest `globalSetup` entry point: throws before any test runs when the
 * dist the suites import is missing or older than its sources.
 */
export default function requireFreshCoreDist({
  coreDir = CORE_DIR,
  env = process.env,
} = {}) {
  if (env[ALLOW_STALE_ENV] === "1") return;
  const staleness = describeCoreDistStaleness(coreDir);
  if (staleness === null) return;
  throw new Error(formatCoreDistStaleness(staleness, coreDir));
}
