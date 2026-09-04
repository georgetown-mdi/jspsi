#!/usr/bin/env node
// Deploy-trigger coverage check, run by eb_build_and_test.yaml.
//
// .github/workflows/eb_deploy.yaml redeploys the Elastic Beanstalk environment
// on a push whose changed paths match a hand-written filter. That filter is
// narrower than the trees it names -- most pointedly
// `packages/peerjs-broker/src/contrib/**`, which by design omits the sibling
// `src/standalone.ts` on the assumption that the local `npm start` entry is in no
// deployed import graph. An assumption like that is invisible when it breaks: let
// standalone.ts (or any other unfiltered source) into the deployed server and
// edits to it stop triggering a deploy, production quietly serves the previous
// build, and no run anywhere goes red. So the assumption is encoded here instead of
// asserted in a comment: every repository source the deployed build actually
// reads has to match the filter that redeploys it.
//
// The graph is read out of a real build rather than predicted from the sources.
// Nothing here resolves an import, expands an alias, or models what rolldown,
// Nitro, or the TanStack Start plugin would do with a specifier; the build runs
// and reports what it read, through two complementary halves:
//
//   1. The module ids rolldown resolves in the client and ssr environments,
//      recorded by the plugin apps/web/vite.config.ts installs when this check
//      sets PSILINK_DEPLOY_GRAPH_RECORD. This is the half that sees the signaling
//      broker, which enters through a route module inside the ssr bundle.
//   2. The `sources` of every sourcemap Nitro emits under apps/web/.output. This
//      is the half that sees Nitro's own server pass -- the custom entry and what
//      it pulls in -- which runs outside vite's plugin container and so records
//      nothing in half 1.
//
// Neither half alone covers the deployed server, and REQUIRED_GRAPH_ROOTS below
// fails the check when either stops producing paths, so a half that goes quiet
// cannot be treated as a clean graph.
//
// WHAT THIS CHECK DOES NOT COVER:
//
//   - Filter syntax past two shapes. GitHub's path filters are a glob language;
//     modelling it here would be predicting a tool's parser rather than driving
//     it. compileFilter reads only `prefix/**` and literal paths -- what the
//     deploy filter is written in -- and THROWS on anything else, so a pattern
//     it cannot model fails the check rather than being silently over- or
//     under-matched. Adding a `*` or `!` pattern to the deploy filter means
//     teaching this check the shape, or the check stops the change.
//   - The reverse direction. A filter entry that matches nothing in the graph is
//     not a finding: the filter legitimately covers files no module graph reads
//     (package.json, tsconfig.json, the deploy/aws_eb payload, public assets).
//   - Anything a build does not resolve as a module. A file read at runtime by
//     path, or copied into the artifact by a plugin, is in neither half.
//   - Sourcemap entries naming a path that is not a file in the working tree.
//     Nitro's maps name its rollup inputs, and the ssr chunks it consumes are
//     intermediates that no longer exist on disk (and whose own sources it does
//     not chain). Those names are dropped here -- half 1 is what covers what
//     went into them.
//   - Whether a deploy that IS triggered succeeds. This is about the trigger.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { WORKFLOW_DIR, workflowDocument } from "./lib/workflows.mjs";

/** The workflow whose push filter decides when a deploy runs. */
export const DEPLOY_WORKFLOW = `${WORKFLOW_DIR}/eb_deploy.yaml`;

/** The build output the deployed artifact is packaged from. */
export const BUILD_OUTPUT = "apps/web/.output";

/**
 * The environment variable apps/web/vite.config.ts reads to install its
 * module-id recorder. Named in both places and nowhere else; a rename that
 * misses one side leaves the record empty, which REQUIRED_GRAPH_ROOTS fails on.
 */
export const RECORD_ENV = "PSILINK_DEPLOY_GRAPH_RECORD";

// The build this check measures: the app's own build script, so what runs here
// is what CI and a developer run rather than a bespoke invocation shaped to be
// measurable.
const BUILD_ARGV = ["npm", "run", "build", "-w", "apps/web"];

/** The build invocation, as a contributor would type it. */
export const BUILD_COMMAND = BUILD_ARGV.join(" ");

/**
 * Trees that must each contribute at least one path to the collected graph. A
 * collection half that silently stops producing -- a recorder plugin no longer
 * installed, a Nitro release that stops emitting sourcemaps -- would otherwise
 * leave a shrunken graph that trivially satisfies the filter. Each entry names
 * the half it proves alive.
 */
export const REQUIRED_GRAPH_ROOTS = [
  {
    prefix: "apps/web/src/",
    reason:
      "the application sources, which both halves see; an empty result here means the build itself produced nothing to read",
  },
  {
    prefix: "apps/web/server/",
    reason:
      "the Nitro custom entry, which only the sourcemap half sees -- so this is the entry that fails when apps/web/.output stops carrying maps",
  },
  {
    prefix: "packages/peerjs-broker/src/",
    reason:
      "the signaling broker the deployed server bundles, which only the recorded-module-id half sees -- so this is the entry that fails when the recorder plugin stops being installed, and it is the tree the deploy filter narrows",
  },
];

/**
 * Build products the graph legitimately reaches instead of the sources behind
 * them. Git does not track these, so a push can never include one and the filter
 * cannot usefully name one; what the filter has to name is the tree they are
 * built from. An untracked graph entry under no declared product fails the
 * check rather than being waved through.
 */
export const BUILD_PRODUCTS = [
  {
    product: "packages/core/dist/",
    sources: "packages/core/src/",
    reason:
      "the apps consume @psilink/core from its built dist/ (CONTRIBUTING.md, Building), so the bundlers read the bundle and never the sources it was built from",
  },
];

const WILDCARD_SUFFIX = "/**";
const GLOB_CHARACTERS = /[*?[\]{}!+@()|]/;

/**
 * The `paths` list of the parsed deploy workflow's push trigger, in file order.
 * Throws when the trigger is not shaped the way this check reads it, so a
 * workflow restructured out from under the check fails rather than yielding an
 * empty filter that matches nothing and reports every source as uncovered.
 */
export function readTriggerPaths(workflow) {
  const paths = workflow?.on?.push?.paths;
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error(
      `${DEPLOY_WORKFLOW} declares no on.push.paths list. Either the deploy trigger stopped being path-filtered -- in which case every push deploys and this check is obsolete -- or the workflow was restructured; scripts/check-deploy-trigger-graph.mjs reads that list and has to be updated with it.`,
    );
  }
  return paths.map(String);
}

/**
 * Compile a deploy path filter into `{ patterns, matches }`.
 *
 * Two shapes are read, which is what the deploy filter is written in: a literal
 * path matches itself, and `prefix/**` matches any path under `prefix/`. Every
 * other pattern THROWS, naming itself -- see the header on why this check does
 * not implement the rest of the glob language.
 */
export function compileFilter(patterns) {
  const matchers = patterns.map((pattern) => {
    if (pattern.endsWith(WILDCARD_SUFFIX)) {
      const prefix = pattern.slice(0, -WILDCARD_SUFFIX.length);
      if (prefix.length > 0 && !GLOB_CHARACTERS.test(prefix)) {
        return (file) => file.startsWith(`${prefix}/`);
      }
    } else if (!GLOB_CHARACTERS.test(pattern)) {
      return (file) => file === pattern;
    }
    throw new Error(
      `${DEPLOY_WORKFLOW} carries the path filter "${pattern}", a glob shape scripts/check-deploy-trigger-graph.mjs does not read. It reads a literal path and a trailing "/**" and refuses to guess at the rest, because matching GitHub's filter any other way means predicting its parser rather than reading it. Teach compileFilter the shape, or write the entry as one it reads.`,
    );
  });
  return {
    patterns: [...patterns],
    matches: (file) => matchers.some((matcher) => matcher(file)),
  };
}

/**
 * The file path a recorded rolldown module id refers to, or null for an id that
 * names no file on disk: a virtual module (`\0`-prefixed, the convention
 * rollup and rolldown share) or a bare specifier. A query suffix (`?worker`,
 * `?url`) is stripped -- it selects how a file is loaded, not which file.
 */
export function moduleIdToPath(id) {
  if (typeof id !== "string" || id.startsWith("\0")) return null;
  const withoutQuery = id.split("?")[0];
  if (withoutQuery === "" || !isAbsolute(withoutQuery)) return null;
  return withoutQuery;
}

/**
 * The absolute paths a sourcemap's `sources` name, resolved against the
 * directory holding the map. Entries that name no file are the caller's to drop:
 * this reports what the map says.
 */
export function sourceMapPaths(map, mapDirectory) {
  if (!Array.isArray(map?.sources)) return [];
  return map.sources
    .filter((source) => typeof source === "string" && source.length > 0)
    .map((source) => resolve(mapDirectory, source.split("?")[0]));
}

/**
 * The repository-relative form of an absolute path, or null when it is outside
 * the repository or inside a `node_modules` tree. A dependency is not a
 * repository source: what moves when one changes is package-lock.json, which
 * the deploy filter names.
 */
export function toRepoPath(absolutePath, repoRoot) {
  const rel = relative(repoRoot, absolutePath);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  const segments = rel.split(sep);
  if (segments.includes("node_modules")) return null;
  return segments.join("/");
}

/**
 * Hold a collected graph against a compiled filter, as
 * `{uncovered, undeclared, productGaps}`.
 *
 * `uncovered` are tracked sources the filter does not match -- the finding this
 * check exists for. `undeclared` are untracked graph entries under no
 * BUILD_PRODUCTS prefix. `productGaps` are declared build products whose source
 * tree the filter does not fully cover, which is how the filter losing (say)
 * `packages/core/src/**` is caught even though those sources never appear in
 * the graph themselves.
 */
export function classifyGraph({
  graph,
  filter,
  tracked,
  buildProducts = BUILD_PRODUCTS,
}) {
  const uncovered = [];
  const undeclared = [];
  const reached = new Set();
  for (const file of graph) {
    if (tracked.has(file)) {
      if (!filter.matches(file)) uncovered.push(file);
      continue;
    }
    const product = buildProducts.find((entry) =>
      file.startsWith(entry.product),
    );
    if (product) reached.add(product);
    else undeclared.push(file);
  }
  const productGaps = [];
  for (const product of reached) {
    const sources = [...tracked].filter((file) =>
      file.startsWith(product.sources),
    );
    const missed = sources.filter((file) => !filter.matches(file)).sort();
    if (sources.length === 0 || missed.length > 0) {
      productGaps.push({ product, sourceCount: sources.length, missed });
    }
  }
  return {
    uncovered: uncovered.sort(),
    undeclared: undeclared.sort(),
    productGaps,
  };
}

/** The REQUIRED_GRAPH_ROOTS entries no collected path sits under. */
export function unreachedRoots(graph, roots = REQUIRED_GRAPH_ROOTS) {
  return roots.filter(
    (root) => !graph.some((file) => file.startsWith(root.prefix)),
  );
}

/** Every `*.map` file under `directory`, recursively. */
function sourceMapFiles(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sourceMapFiles(path));
    else if (entry.name.endsWith(".map")) found.push(path);
  }
  return found;
}

/** Run the real build with the recorder pointed at `recordPath`. */
function runBuild(repoRoot, recordPath) {
  const [command, ...args] = BUILD_ARGV;
  execFileSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, [RECORD_ENV]: recordPath },
  });
}

/**
 * Build, then collect the repository sources both halves report, sorted and
 * deduplicated. `build` is injectable so a test can drive collection over a
 * prepared tree without paying for a real build.
 */
export function collectGraph(repoRoot, { build = runBuild } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), "psilink-deploy-graph-"));
  const recordPath = join(scratch, "module-ids.json");
  try {
    build(repoRoot, recordPath);
    if (!existsSync(recordPath)) {
      throw new Error(
        `${BUILD_COMMAND} wrote no module-id record. apps/web/vite.config.ts installs its recorder when ${RECORD_ENV} is set; either that plugin is gone or the build never reached a bundle, and either way the graph this check reads would be missing everything rolldown resolves.`,
      );
    }
    const output = resolve(repoRoot, BUILD_OUTPUT);
    if (!existsSync(output)) {
      throw new Error(
        `${BUILD_COMMAND} left no ${BUILD_OUTPUT}. The deployed artifact is packaged from that directory, so there is no build to read.`,
      );
    }
    const absolute = [
      ...JSON.parse(readFileSync(recordPath, "utf8")).map(moduleIdToPath),
      ...sourceMapFiles(output).flatMap((mapFile) =>
        sourceMapPaths(
          JSON.parse(readFileSync(mapFile, "utf8")),
          resolve(mapFile, ".."),
        ),
      ),
    ];
    const files = new Set();
    for (const path of absolute) {
      if (path === null) continue;
      const repoPath = toRepoPath(path, repoRoot);
      if (repoPath === null) continue;
      const onDisk = resolve(repoRoot, repoPath);
      if (existsSync(onDisk) && statSync(onDisk).isFile()) files.add(repoPath);
    }
    return [...files].sort();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Every path git tracks, as a Set of repository-relative paths. */
export function trackedFiles(repoRoot) {
  return new Set(
    execFileSync("git", ["ls-files", "-z"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\0")
      .filter(Boolean),
  );
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions without paying for a build.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
  const filter = compileFilter(
    readTriggerPaths(workflowDocument(repoRoot, DEPLOY_WORKFLOW)),
  );
  const graph = collectGraph(repoRoot);
  const missingRoots = unreachedRoots(graph);
  if (missingRoots.length > 0) {
    console.error(
      `Deploy trigger coverage check failed: the collected graph (${graph.length} files) reaches none of ${missingRoots.length} tree(s) it must, so it is not a graph of the deployed server:\n`,
    );
    for (const root of missingRoots) {
      console.error(`  ${root.prefix} -- ${root.reason}`);
    }
    console.error(
      "\nOne of the two collection halves stopped producing paths. Fix the collection before reading anything into the filter result: a shrunken graph satisfies the filter for the wrong reason.",
    );
    process.exit(1);
  }
  const { uncovered, undeclared, productGaps } = classifyGraph({
    graph,
    filter,
    tracked: trackedFiles(repoRoot),
  });
  if (uncovered.length + undeclared.length + productGaps.length > 0) {
    console.error("Deploy trigger coverage check failed.\n");
    if (uncovered.length > 0) {
      console.error(
        `${uncovered.length} source(s) the deployed build reads that no ${DEPLOY_WORKFLOW} push filter matches:\n`,
      );
      for (const file of uncovered) console.error(`  ${file}`);
      console.error(
        `\nAn edit to one of these changes the deployed server and triggers no deploy: production would keep serving the previous build with nothing red. Either add the path to that filter, or take the file back out of the deployed import graph.`,
      );
    }
    for (const gap of productGaps) {
      console.error(
        `\nThe build reads ${gap.product.product} (${gap.product.reason}), but ${gap.missed.length} of ${gap.sourceCount} tracked file(s) under ${gap.product.sources} match no push filter:\n`,
      );
      for (const file of gap.missed) console.error(`  ${file}`);
      console.error(
        `\nGit tracks no build product, so a push carries the sources instead; the filter has to name them for a change to redeploy.`,
      );
    }
    if (undeclared.length > 0) {
      console.error(
        `\n${undeclared.length} untracked file(s) in the graph under no declared build product:\n`,
      );
      for (const file of undeclared) console.error(`  ${file}`);
      console.error(
        `\nA push cannot carry an untracked path, so no filter entry can cover one. If it is a build product, declare it in BUILD_PRODUCTS in scripts/check-deploy-trigger-graph.mjs with the tree it is built from; if it should be tracked, commit it.`,
      );
    }
    process.exit(1);
  }
  console.log(
    `Deploy trigger coverage check passed: all ${graph.length} repository sources the deployed build reads match one of ${filter.patterns.length} push filters in ${DEPLOY_WORKFLOW}.`,
  );
}
