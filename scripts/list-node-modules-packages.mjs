#!/usr/bin/env node
// Every package a node_modules tree carries, one `name@version` per line, sorted.
//
// The measured half of image_smoke.yaml's production-scope step, which runs this
// over the built image's /app/node_modules and over the tree
// `npm ci --omit=dev --omit=optional -w packages/core -w apps/cli` resolves from
// the committed lockfile on the runner, then diffs the two lists. Both sides run
// the same lister so a difference is a difference in the trees.
//
// It walks directories rather than reading npm's own .package-lock.json, which
// records what npm installed rather than what the tree holds now: a later build
// step that adds to the tree, or a copy that drops one in, is invisible to that
// file and visible to a walk. A directory carrying no readable package.json is
// reported by its path rather than skipped, that being the shape something other
// than npm arrives in.
//
// A symlinked entry -- the workspace links npm writes for the workspaces its
// install names -- is reported from the manifest it resolves to and not
// descended into: its target is a workspace directory outside the tree, whose
// own dependencies are not what this measures, and a link into an ancestor would
// otherwise loop the walk.
//
// The comparison is by package identity and not by position. Where a package
// sits in the tree is the lockfile's business and the freeze test's; what this
// answers is which packages the tree carries.

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

/** Sorted `name@version` lines for every package under a node_modules tree. */
export function listNodeModulesPackages(nodeModulesDirectory) {
  const found = new Set();
  walkLevel(nodeModulesDirectory, nodeModulesDirectory, found);
  return [...found].sort();
}

// One node_modules level: its entries are packages, except for the `@scope`
// directories whose own entries are, and the dotted names npm keeps its
// bookkeeping under (.bin, .package-lock.json, .cache).
function walkLevel(directory, root, found) {
  for (const entry of readEntries(directory)) {
    if (entry.name.startsWith(".")) continue;
    const path = join(directory, entry.name);
    if (entry.name.startsWith("@") && entry.isDirectory()) {
      for (const scoped of readEntries(path)) {
        recordPackage(join(path, scoped.name), root, found, scoped);
      }
      continue;
    }
    recordPackage(path, root, found, entry);
  }
}

function recordPackage(path, root, found, entry) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
  } catch {
    found.add(`${relative(root, path)} (no package.json)`);
    return;
  }
  found.add(`${manifest.name}@${manifest.version}`);
  if (!entry.isSymbolicLink()) {
    walkLevel(join(path, "node_modules"), root, found);
  }
}

function readEntries(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [directory] = process.argv.slice(2);
  if (directory === undefined) {
    console.error(
      "usage: list-node-modules-packages.mjs <node_modules directory>",
    );
    process.exit(2);
  }
  const packages = listNodeModulesPackages(directory);
  if (packages.length === 0) {
    console.error(`${directory} holds no package`);
    process.exit(1);
  }
  console.log(packages.join("\n"));
}
