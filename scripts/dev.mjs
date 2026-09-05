#!/usr/bin/env node
// Root dev loop: keep packages/core's dist in step with its sources for the
// duration of a web dev session.
//
// The apps consume @psilink/core from its built dist/, never from its TypeScript
// sources, so an edit to core is invisible to a running dev server until someone
// remembers `npm run build -w packages/core`. Nothing reports that: the app goes
// on serving the previous build, and the only symptom is behavior that does not
// match the source in front of you. This brings dist up to date, then runs
// core's rollup watcher alongside the web dev server so every later edit
// rebuilds, and takes the whole loop down as soon as either side exits.
//
// Bringing dist up to date BEFORE the dev server starts is the part that
// matters: rollup's watcher rebuilds asynchronously, so a dev server racing it
// would resolve whatever dist happened to be on disk at startup -- the stale
// build this exists to prevent.
//
// Usage: node scripts/dev.mjs [web-script]   (default: dev)

import { spawn } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The workspace whose dev server this loop supervises. */
export const APP_WORKSPACE = "apps/web";

/** The workspace whose build output the app consumes. */
export const CORE_WORKSPACE = "packages/core";

/** The app script run when none is named. */
export const DEFAULT_APP_SCRIPT = "dev";

const ON_WINDOWS = process.platform === "win32";
const NPM = ON_WINDOWS ? "npm.cmd" : "npm";

// Node refuses to spawn a .cmd without a shell, so the Windows npm shim needs
// one. Every argument below is a literal except the app script name, which
// parseAppScript has already matched against the app's own declared scripts.
const SPAWN_OPTIONS = { cwd: repoRoot, stdio: "inherit", shell: ON_WINDOWS };

/**
 * The app script named by `argv`, defaulting to DEFAULT_APP_SCRIPT. Validated
 * against `available` -- the app's own script names -- so a typo answers with the
 * scripts that exist instead of failing several layers down in npm.
 */
export function parseAppScript(argv, available) {
  if (argv.length > 1) {
    throw new Error(`expected at most one script name, got ${argv.length}`);
  }
  const script = argv[0] ?? DEFAULT_APP_SCRIPT;
  if (!available.includes(script)) {
    throw new Error(
      `${APP_WORKSPACE} has no '${script}' script; available: ${available.join(", ")}`,
    );
  }
  return script;
}

/** The script names declared by the app's package.json. */
export function appScriptNames(root = repoRoot) {
  const manifest = JSON.parse(
    readFileSync(resolve(root, APP_WORKSPACE, "package.json"), "utf8"),
  );
  return Object.keys(manifest.scripts ?? {});
}

// The inputs rollup reads for core's build, alongside its src tree.
const CORE_BUILD_FILES = ["package.json", "rollup.config.ts", "tsconfig.json"];

/** The newest mtime among `paths`, skipping any that do not exist. */
function newestMtime(paths) {
  let newest = -Infinity;
  for (const path of paths) {
    try {
      newest = Math.max(newest, statSync(path).mtimeMs);
    } catch {
      continue;
    }
  }
  return newest;
}

/** Every regular file under `dir`, or an empty array when it does not exist. */
function filesUnder(dir) {
  try {
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath ?? dir, entry.name));
  } catch {
    return [];
  }
}

/**
 * Whether core's dist is at least as new as every source its build reads.
 *
 * Only an optimization, and a cheap one by design: a false verdict costs a
 * redundant build, and a true verdict that is wrong is corrected within seconds
 * by the watcher's first pass, which rebuilds unconditionally. What it buys is
 * that the common warm start does not pay a full core build before the dev
 * server comes up.
 */
export function coreBuildIsCurrent(root = repoRoot) {
  const core = resolve(root, CORE_WORKSPACE);
  const dist = filesUnder(join(core, "dist"));
  if (dist.length === 0) return false;

  const sources = [
    ...filesUnder(join(core, "src")),
    ...CORE_BUILD_FILES.map((name) => join(core, name)),
    resolve(root, "tsconfig.base.json"),
    resolve(root, "package-lock.json"),
  ];
  const oldestBuilt = dist.reduce(
    (oldest, path) => Math.min(oldest, statSync(path).mtimeMs),
    Infinity,
  );
  return oldestBuilt >= newestMtime(sources);
}

/**
 * Bring core's dist up to date, then run its watcher and the app's dev server
 * until one of them exits, and resolve to the loop's exit code.
 *
 * `runToCompletion` runs one npm invocation and resolves to its exit code;
 * `startWatcher` starts a long-running one and returns `{ kill, exited }`. They
 * and the currency check are injected so the ordering and the teardown this
 * function owns are exercisable without spawning a dev server.
 */
export async function runDevLoop({
  appScript,
  isCoreBuildCurrent,
  runToCompletion,
  startWatcher,
}) {
  if (!isCoreBuildCurrent()) {
    const built = await runToCompletion(["run", "build", "-w", CORE_WORKSPACE]);
    if (built !== 0) return built;
  }

  const watchers = [
    startWatcher(["run", "dev", "-w", CORE_WORKSPACE]),
    startWatcher(["run", appScript, "-w", APP_WORKSPACE]),
  ];

  const first = await Promise.race(watchers.map((watcher) => watcher.exited));
  for (const watcher of watchers) watcher.kill("SIGTERM");
  await Promise.allSettled(watchers.map((watcher) => watcher.exited));
  return first;
}

function exitCodeOf(child) {
  return new Promise((resolveCode) => {
    child.on("close", (code, signal) => resolveCode(code ?? (signal ? 0 : 1)));
  });
}

function runToCompletion(args) {
  return exitCodeOf(spawn(NPM, args, SPAWN_OPTIONS));
}

function startWatcher(args) {
  const child = spawn(NPM, args, SPAWN_OPTIONS);
  return {
    kill: (signal) => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
      }
    },
    exited: exitCodeOf(child),
  };
}

async function main() {
  let appScript;
  try {
    appScript = parseAppScript(process.argv.slice(2), appScriptNames());
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }

  const live = new Set();
  // A terminal Ctrl-C reaches the children through the shared process group, but
  // a SIGTERM addressed to this process alone would orphan them: rollup's watcher
  // and the dev server would keep the port and the file watches.
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      for (const watcher of live) watcher.kill(signal);
    });
  }

  const code = await runDevLoop({
    appScript,
    isCoreBuildCurrent: () => coreBuildIsCurrent(),
    runToCompletion,
    startWatcher: (args) => {
      const watcher = startWatcher(args);
      live.add(watcher);
      void watcher.exited.then(() => live.delete(watcher));
      return watcher;
    },
  });
  process.exit(code);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
