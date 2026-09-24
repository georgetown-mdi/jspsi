#!/usr/bin/env node
// apps/web build-input check: the web config loads from the file subset the
// image's builder stage copies, run by static_checks.yaml on every PR.
//
// The Dockerfile builder stage copies apps/web's config, src/, server/ and
// public/ and no test tree, and `npm run build -w apps/web` there is the first
// thing that evaluates vite.config.ts against that subset. Vite's config loader
// BUNDLES the config rather than importing it, so it resolves every literal
// specifier the file holds -- inside a dynamic import as much as a static one,
// and whether or not the branch holding it is ever taken. A single import of a
// test-tree module therefore fails the image build with an unresolved import,
// while every local command (dev server, vitest, typecheck, lint) stays green,
// because each of those runs from a tree that has the test files.
//
// So the claim "the config's import graph resolves from what the image copies"
// is driven here instead of asserted: the builder stage's COPY lines are
// replayed into a temporary tree and the real config is loaded there.
//
// Two properties the implementation is built around:
//
//   1. MEASURED, NOT MODELLED. The copy list is read out of the Dockerfile, so
//      the two cannot drift, and the load is Vite's own `loadConfigFromFile`
//      through the Vite the web app resolves. Nothing here parses the config,
//      resolves a specifier, or predicts what the loader would do with one.
//   2. FAILS CLOSED when the replication stopped being a measurement. A check
//      that only loaded the config from a copied tree would pass forever if the
//      replication quietly carried the test tree in, or if the loader stopped
//      resolving relative imports. So a CONTROL config -- one whose only import
//      is a module of apps/web/test -- is loaded in the replicated tree first,
//      and a control that LOADS fails the check rather than licensing the
//      result below it.
//
// WHAT THIS CHECK DOES NOT COVER:
//
//   - The build past the config. It loads the config and stops; it does not
//     bundle the app, so a module under apps/web/src that imported the test
//     tree would not fail here. A full `vite build` is the minutes
//     check:deploy-trigger-graph pays for and the merge path does not have.
//   - The image's own `npm ci`. The replicated tree borrows this checkout's
//     installed dependencies through a symlink, so what it measures is the
//     repository FILE subset, not the installed tree the image resolves bare
//     specifiers from.
//   - COPY shapes past the two the builder stage is written in: a literal path,
//     and a `*` glob in a filename. Anything else -- a flag such as `--from=`, a
//     JSON-array form, a rename onto a file destination -- THROWS rather than
//     being replicated approximately, so a Dockerfile this cannot replay stops
//     the check instead of quietly measuring the wrong tree.
//   - .dockerignore. Its entries keep build outputs and node_modules out of the
//     build context; this check provides node_modules itself and copies from the
//     working tree, where a stray build output under a copied source directory
//     is reachable to the load and would not be in the image.

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CHILD_FLAG,
  LOAD_STATUSES,
  loadConfigInChild,
  runChildLoad,
} from "./lib/configLoadHarness.mjs";

/** The Dockerfile whose builder stage decides what the image build can read. */
export const DOCKERFILE = "Dockerfile";

/** The stage that runs `npm run build -w apps/web`. */
export const BUILDER_STAGE = "builder";

/** The config this check loads, relative to the repository root. */
export const WEB_CONFIG = "apps/web/vite.config.ts";

/** The tree the image does not copy, and the control's import target. */
export const WEB_TEST_TREE = "apps/web/test";

/** The statuses this check reports: the shared vocabulary, plus the three
 * outcomes only the replication has. */
const STATUSES = Object.freeze({
  ...LOAD_STATUSES,
  /** This checkout has no node_modules for the replicated tree to borrow. */
  uninstalled: "uninstalled",
  /** The web test tree holds no module for the control to import. */
  noTestTree: "no-test-tree",
  /** The builder stage copies the test tree, so the subset proves nothing. */
  testTreeCopied: "test-tree-copied",
});

/** The control config written into the replicated tree, named so a stray copy
 * of it is recognizable. */
const CONTROL_CONFIG = "alcove-image-subset-control.config.ts";

/**
 * The COPY instructions of `dockerfileSource`'s builder stage, each as
 * `{ line, sources, destination }` with `line` the 1-based line it starts on.
 *
 * Throws on any COPY shape {@link replicateCopies} cannot replay, so an
 * instruction this check would silently mis-copy stops it instead.
 */
export function builderStageCopies(dockerfileSource) {
  const physical = dockerfileSource.split(/\r?\n/);
  const copies = [];
  let stage;
  let pending = null;

  for (const [index, raw] of physical.entries()) {
    const text = raw.trim();
    if (pending === null && (text === "" || text.startsWith("#"))) continue;
    const continues = text.endsWith("\\");
    const body = continues ? text.slice(0, -1).trim() : text;
    if (pending === null) {
      pending = { line: index + 1, text: body };
    } else {
      pending.text = `${pending.text} ${body}`.trim();
    }
    if (continues) continue;

    const instruction = pending;
    pending = null;
    const from = /^FROM\s+\S+(?:\s+AS\s+(\S+))?\s*$/i.exec(instruction.text);
    if (from) {
      stage = from[1];
      continue;
    }
    if (stage !== BUILDER_STAGE) continue;
    if (!/^COPY\s/i.test(instruction.text)) continue;

    const tokens = instruction.text.split(/\s+/).slice(1);
    const flags = tokens.filter((token) => token.startsWith("--"));
    if (flags.length > 0) {
      throw new Error(
        `${DOCKERFILE}:${instruction.line}: this check replays a COPY from the build context, and this one takes ${flags.join(" ")}. Teach it the shape or take the instruction out of the ${BUILDER_STAGE} stage.`,
      );
    }
    if (tokens.some((token) => token.startsWith("["))) {
      throw new Error(
        `${DOCKERFILE}:${instruction.line}: the JSON-array COPY form is not replayed by this check.`,
      );
    }
    if (tokens.length < 2) {
      throw new Error(
        `${DOCKERFILE}:${instruction.line}: a COPY needs a source and a destination.`,
      );
    }
    copies.push({
      line: instruction.line,
      sources: tokens.slice(0, -1),
      destination: tokens[tokens.length - 1],
    });
  }
  return copies;
}

/**
 * The paths under `root` one COPY source names: the path itself, or every entry
 * a single `*` in its filename matches, sorted. Throws when it names nothing,
 * as the build itself would fail on.
 */
function expandSource(root, source, line) {
  const star = source.indexOf("*");
  if (star === -1) {
    if (!existsSync(resolve(root, source))) {
      throw new Error(
        `${DOCKERFILE}:${line}: COPY names ${source}, which is not in this checkout.`,
      );
    }
    return [source];
  }
  const directory = posix.dirname(source);
  const pattern = posix.basename(source);
  if (
    directory.includes("*") ||
    pattern.indexOf("*") !== pattern.lastIndexOf("*")
  ) {
    throw new Error(
      `${DOCKERFILE}:${line}: this check replays one \`*\` in a filename, and ${source} is not that shape.`,
    );
  }
  const [prefix, suffix] = pattern.split("*");
  const matches = readdirSync(resolve(root, directory))
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith(suffix))
    .sort()
    .map((entry) => posix.join(directory, entry));
  if (matches.length === 0) {
    throw new Error(
      `${DOCKERFILE}:${line}: COPY names ${source}, which matches nothing in this checkout.`,
    );
  }
  return matches;
}

/**
 * Replay `copies` from `root` into `into`, Docker's own destination handling:
 * a directory source lands as the CONTENTS of the destination directory, a file
 * source lands under it by its own name.
 *
 * Returns the repository-relative paths replicated, for the caller to assert
 * against.
 */
export function replicateCopies(root, into, copies) {
  const replicated = [];
  for (const copy of copies) {
    const destination = resolve(
      into,
      copy.destination.replace(/^\.\//, "").replace(/\/$/, ""),
    );
    const namesDirectory = /\/$|^\.$|^\.\/$/.test(copy.destination);
    for (const source of copy.sources.flatMap((one) =>
      expandSource(root, one, copy.line),
    )) {
      const from = resolve(root, source);
      if (statSync(from).isDirectory()) {
        cpSync(from, destination, { recursive: true });
      } else {
        if (!namesDirectory && copy.sources.length === 1) {
          throw new Error(
            `${DOCKERFILE}:${copy.line}: this check replays a COPY into a directory, and this one renames ${source} to ${copy.destination}.`,
          );
        }
        mkdirSync(destination, { recursive: true });
        cpSync(from, join(destination, posix.basename(source)));
      }
      replicated.push(source);
    }
  }
  return replicated;
}

/** The workspace directories the root manifest declares, plus the root itself,
 * as repository-relative paths. */
export function workspaceDirectories(root) {
  const manifest = JSON.parse(
    readFileSync(resolve(root, "package.json"), "utf8"),
  );
  const directories = [""];
  for (const pattern of manifest.workspaces ?? []) {
    if (pattern.endsWith("/*")) {
      const parent = pattern.slice(0, -2);
      for (const entry of readdirSync(resolve(root, parent)).sort()) {
        directories.push(posix.join(parent, entry));
      }
    } else {
      directories.push(pattern);
    }
  }
  return directories;
}

/**
 * Lend the replicated tree this checkout's installed dependencies, one symlink
 * per workspace that has a node_modules of its own. The image installs its own;
 * what this check measures is the file subset around them.
 */
function linkInstalledDependencies(root, into) {
  for (const directory of workspaceDirectories(root)) {
    const source = resolve(root, directory, "node_modules");
    const destination = resolve(into, directory, "node_modules");
    if (!existsSync(source) || !existsSync(dirname(destination))) continue;
    symlinkSync(
      source,
      destination,
      process.platform === "win32" ? "junction" : "dir",
    );
  }
}

/**
 * A module of the repository's web test tree, as a specifier relative to
 * apps/web -- the control's import, and the thing the image build must not
 * need. The first in sorted order, so the control is the same file run to run.
 */
export function firstTestModule(root) {
  const tree = resolve(root, WEB_TEST_TREE);
  if (!existsSync(tree)) return undefined;
  const modules = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name)) modules.push(path);
    }
  };
  walk(tree);
  if (modules.length === 0) return undefined;
  const first = modules.sort()[0];
  return `./${relative(resolve(root, dirname(WEB_CONFIG)), first)
    .split(sep)
    .join("/")}`;
}

/**
 * Write the control config beside `configFile`: a config whose only import is
 * `specifier`. The loader must refuse it, or the replicated tree still holds
 * the test tree and this check measures nothing.
 */
export function writeTestTreeControl(configFile, specifier) {
  const control = join(dirname(configFile), CONTROL_CONFIG);
  writeFileSync(
    control,
    `import "${specifier}";\n\nexport default {};\n`,
    "utf8",
  );
  return control;
}

/**
 * Load `configFile` in a child `node` process, with `root` as the working
 * directory, and report `{ ok, code, output }` (see
 * scripts/lib/configLoadHarness.mjs, which also states what the child
 * environment drops and why). The image build sets no NODE_OPTIONS and no
 * VITEST, and the subset this replicates is measured against that.
 */
export function loadInChildProcess(configFile, root) {
  return loadConfigInChild({
    childModule: import.meta.url,
    args: [configFile],
    cwd: root,
  });
}

/**
 * Replicate the builder stage's file subset, then load the control and the web
 * config in it, and report `{ ok, status, message }`.
 *
 * Statuses: `loads` (ok), `missing`, `uninstalled`, `no-test-tree`,
 * `test-tree-copied`, `control-loaded`, `control-failed-otherwise`, `refused`.
 *
 * `load` is injectable so a test can drive the outcomes without spawning.
 */
export function checkWebConfigImageLoad({
  root,
  load = loadInChildProcess,
} = {}) {
  const configFile = resolve(root, WEB_CONFIG);
  if (!existsSync(configFile)) {
    return {
      ok: false,
      status: STATUSES.missing,
      message: `${WEB_CONFIG} is absent, so there is nothing to load.`,
    };
  }
  if (!existsSync(resolve(root, "node_modules"))) {
    return {
      ok: false,
      status: STATUSES.uninstalled,
      message: `The replicated tree borrows this checkout's node_modules, and there is none. Run \`npm install\`.`,
    };
  }
  const controlImport = firstTestModule(root);
  if (controlImport === undefined) {
    return {
      ok: false,
      status: STATUSES.noTestTree,
      message: `${WEB_TEST_TREE} holds no module, so the control this check is calibrated against cannot be built and the load below it would prove nothing. Re-establish what the control measures, or retire it, in scripts/check-web-config-image-load.mjs.`,
    };
  }

  const copies = builderStageCopies(
    readFileSync(resolve(root, DOCKERFILE), "utf8"),
  );
  const into = mkdtempSync(join(tmpdir(), "web-config-image-subset-"));
  try {
    const replicated = replicateCopies(root, into, copies);
    linkInstalledDependencies(root, into);
    if (!replicated.includes(WEB_CONFIG)) {
      return {
        ok: false,
        status: STATUSES.missing,
        message: `The ${BUILDER_STAGE} stage copies no ${WEB_CONFIG}, so the image build evaluates no config of this app at all.`,
      };
    }
    if (existsSync(resolve(into, WEB_TEST_TREE))) {
      return {
        ok: false,
        status: STATUSES.testTreeCopied,
        message: `The ${BUILDER_STAGE} stage copies ${WEB_TEST_TREE} into the image build, so loading the config from that subset says nothing about whether the config reaches test-tree code. This check fails rather than report a measurement it did not make -- re-establish what it measures, or retire it, in scripts/check-web-config-image-load.mjs.`,
      };
    }

    const replicatedConfig = resolve(into, WEB_CONFIG);
    const control = load(
      writeTestTreeControl(replicatedConfig, controlImport),
      into,
    );
    if (control.ok) {
      return {
        ok: false,
        status: STATUSES.controlLoaded,
        message: `A config importing ${controlImport} loaded from the replicated tree, which holds no ${WEB_TEST_TREE}. The loader is resolving that import from somewhere else, so driving ${WEB_CONFIG} through it would prove nothing. This check fails rather than report a measurement it did not make -- re-establish what it measures, or retire it, in scripts/check-web-config-image-load.mjs.`,
      };
    }
    if (!control.output.includes(controlImport)) {
      return {
        ok: false,
        status: STATUSES.controlFailedOtherwise,
        message: `The control config was refused, but for something other than its ${controlImport} import, so it is not the unresolved-import refusal this check is calibrated against and the result below it would be unsound:\n\n${control.output}`,
      };
    }

    const result = load(replicatedConfig, into);
    if (!result.ok) {
      return {
        ok: false,
        status: STATUSES.refused,
        message: `${WEB_CONFIG} does not load from the file subset the ${DOCKERFILE} ${BUILDER_STAGE} stage copies, so \`npm run build -w apps/web\` fails in the image while every local command stays green. The config loader bundles the config and resolves every literal specifier in it, a dynamic import's included, so a module outside that subset -- the test tree above all -- has to be reached through a path built at runtime rather than named in an import.\n\n${result.output}`,
      };
    }
  } finally {
    rmSync(into, { recursive: true, force: true });
  }

  return {
    ok: true,
    status: STATUSES.loads,
    message: `${WEB_CONFIG} loads from the ${copies.length} COPY instructions the ${DOCKERFILE} ${BUILDER_STAGE} stage runs, with no ${WEB_TEST_TREE} among them.`,
  };
}

/** Load one config through Vite's own loader, resolving Vite from the config
 * being loaded so the copy driven is the one the app would really use. */
async function loadThroughVite(configFile) {
  const require = createRequire(pathToFileURL(configFile));
  const { loadConfigFromFile } = await import(
    pathToFileURL(require.resolve("vite")).href
  );
  await loadConfigFromFile(
    { command: "build", mode: "production" },
    configFile,
    dirname(configFile),
    // Silent: the loader's own "failed to load config from ..." line adds
    // nothing to the error this check reports.
    "silent",
    undefined,
  );
}

// CLI entry: child mode performs one load; otherwise the full check. Neither
// runs on import, so the test can drive the functions above directly.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === CHILD_FLAG) {
    await runChildLoad(
      () => loadThroughVite(process.argv[3]),
      (error) => error?.message ?? String(error),
    );
  } else {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const result = checkWebConfigImageLoad({ root });
    if (!result.ok) {
      console.error(`Web config image load check failed: ${result.message}`);
      process.exit(1);
    }
    console.log(`Web config image load check passed: ${result.message}`);
  }
}
