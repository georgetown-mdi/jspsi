// Where the GitHub Actions tree is read: the two directory paths, the file
// listings, the source reads, the parse, and the `uses:` extraction over a
// parsed document.
//
// Every check and test that reads that tree stands on it, so a change to what
// counts as a workflow file, to the order the tree is read in, or to what a
// parse failure says is one edit here rather than one per reader.
//
// The parse is the `yaml` package's, which reads the YAML 1.2 core schema: the
// `on` key stays the string `on` rather than folding to the boolean a YAML 1.1
// parser produces, so `document.on` reads off a parsed workflow directly.
//
// Nothing here models what GitHub accepts. A document is read as data and the
// `uses:` walk is structural, so a shape this repository does not use is
// neither recognized nor refused; each check states what it reads and what it
// cannot see.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { parse } from "yaml";

/** The workflow directory, repo-relative. */
export const WORKFLOW_DIR = ".github/workflows";

/** The composite-action directory, repo-relative. */
export const ACTION_DIR = ".github/actions";

const WORKFLOW_FILE = /\.ya?ml$/;
const ACTION_FILE = /^action\.ya?ml$/;

const read = (root, path) => readFileSync(resolve(root, path), "utf8");

const entriesOf = (absolute) =>
  existsSync(absolute)
    ? readdirSync(absolute, { withFileTypes: true }).sort((first, second) =>
        first.name < second.name ? -1 : first.name > second.name ? 1 : 0,
      )
    : [];

/**
 * Repo-relative paths of the workflow files under `root`, in name order. The
 * listing is flat: a workflow runs from the directory itself, so a `.yaml`
 * nested below it is some other file and is left alone. A tree with no workflow
 * directory has no workflow files rather than failing to be read.
 */
export function workflowFiles(root) {
  return entriesOf(resolve(root, WORKFLOW_DIR))
    .filter((entry) => !entry.isDirectory() && WORKFLOW_FILE.test(entry.name))
    .map((entry) => `${WORKFLOW_DIR}/${entry.name}`);
}

/**
 * Repo-relative paths of the composite action definitions under `root`, in path
 * order. Each action sits in a directory of its own, so this walk descends;
 * `action.yml` and `action.yaml` are the only two names GitHub loads an action
 * definition from.
 */
export function compositeFiles(root) {
  const files = [];
  const walk = (relative) => {
    for (const entry of entriesOf(resolve(root, relative))) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (ACTION_FILE.test(entry.name)) files.push(path);
    }
  };
  walk(ACTION_DIR);
  return files;
}

/** Every workflow under `root` as `{path, source}`, in path order. */
export function readWorkflows(root) {
  return workflowFiles(root).map((path) => ({
    path,
    source: read(root, path),
  }));
}

/**
 * A YAML source as a document, or an error naming the file it came from. The
 * `yaml` package's own message names no file, and a check reading a tree of
 * them has to say which one it choked on.
 */
export function parseWorkflow(path, source) {
  try {
    return parse(source);
  } catch (cause) {
    throw new Error(`${path}: could not be parsed as YAML`, { cause });
  }
}

/** A workflow read from the tree and parsed, by its repo-relative path. */
export function workflowDocument(root, path) {
  return parseWorkflow(path, read(root, path));
}

// Every `uses:` string a parsed document holds, in document order. The walk is
// structural rather than an enumeration of the shapes GitHub accepts, so a
// step's `uses:`, a job-level reusable-workflow `uses:`, and a composite's
// `runs.steps[].uses` are all collected without naming any of them.
function usesInDocument(document) {
  const found = [];
  const walk = (node) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "uses" && typeof value === "string") found.push(value);
      walk(value);
    }
  };
  walk(document);
  return found;
}

/**
 * Split a `uses:` reference into `{name, ref}`, or null when it names no remote
 * action at all: a `./` local reference or a `docker://` image. A remote
 * reference with no usable ref -- no `@`, a trailing `@`, or a leading `@` --
 * gets a null `ref` and its `name` is the reference as written, so a check can
 * report it against the two legitimate skips.
 */
export function parseActionReference(uses) {
  const reference = uses.trim();
  if (reference.startsWith("./") || reference.startsWith("docker://")) {
    return null;
  }
  const at = reference.lastIndexOf("@");
  if (at <= 0 || at === reference.length - 1) {
    return { name: reference, ref: null };
  }
  return { name: reference.slice(0, at), ref: reference.slice(at + 1) };
}

/**
 * The remote action references one YAML source holds, as `{file, name, ref}`
 * triples. A null `ref` is a reference naming no version; local and docker
 * references do not appear at all.
 */
export function fileReferences(file, source) {
  return usesInDocument(parseWorkflow(file, source)).flatMap((uses) => {
    const reference = parseActionReference(uses);
    return reference === null ? [] : [{ file, ...reference }];
  });
}

/**
 * The remote action references both guarded trees under `root` hold, with
 * repo-relative file paths.
 */
export function treeReferences(root) {
  const referencesIn = (files) =>
    files.flatMap((file) => fileReferences(file, read(root, file)));
  return {
    workflowReferences: referencesIn(workflowFiles(root)),
    actionReferences: referencesIn(compositeFiles(root)),
  };
}
