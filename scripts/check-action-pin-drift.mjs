#!/usr/bin/env node
// GitHub Action pin drift check, run by static_checks.yaml on every PR.
//
// The `github-actions` Dependabot block in .github/dependabot.yml is configured
// against .github/workflows. The shared CI prologue composite
// (.github/actions/setup/action.yml) pins actions of its own, on a path this
// repo does not rely on being scanned. Coverage reaches it transitively instead:
// every pin a composite carries is identical to a pin a workflow carries, so a
// release or advisory surfacing on the workflow occurrence covers the composite
// one, and the bump that answers it cannot land on the workflow and leave the
// composite behind.
//
// Three rules, over .github/workflows and .github/actions:
//
//   A. An action named in both trees carries the same ref everywhere it appears.
//      A bump applied to some occurrences and not others -- the shape a
//      single-file dependency pull request has -- fails here instead of leaving a
//      silently stale composite.
//   B. A pin under .github/actions names an action some workflow also uses. A
//      composite-only action has no occurrence on the configured path for a
//      release or advisory to surface on, so the check fails closed on it rather
//      than passing a gap.
//   C. Every remote `uses:` reference names a ref. One that names none fixes no
//      version, so nothing here determines which code the step runs and no
//      release or advisory has an occurrence to surface on: neither guarded tree
//      may hold one, and rule A's mirror cannot be satisfied by one. Whether
//      GitHub itself rejects the shape is unverified and the rule does not rest
//      on it -- if GitHub does, this simply never fires.
//
// What this check cannot see:
//   - It compares refs as text. `@v7` agrees with `@v7` whatever the tag resolves
//     to, so a floating major moving under both occurrences, or one spelling
//     denoting different commits in different places, is outside it -- as is
//     whether a ref is a tag, a branch, or a sha.
//   - It says nothing about which paths Dependabot in fact scans. It enforces the
//     mirror invariant this repo relies on, and confirms no tool's coverage.
//   - It reads `uses:` references only. An action reached another way -- a `run:`
//     line that fetches a release, an image named in `container:` or `services:`
//     -- is invisible to it.
//   - Rule A binds only actions appearing in both trees. Two workflows may pin an
//     action no composite uses at differing refs without failing anything here.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

const WORKFLOW_DIR = ".github/workflows";
const ACTION_DIR = ".github/actions";

const WORKFLOW_FILE = /\.ya?ml$/;
const ACTION_FILE = /^action\.ya?ml$/;

/**
 * Every `uses:` string a YAML source carries, in document order. The walk is
 * structural rather than an enumeration of the shapes GitHub accepts, so a step's
 * `uses:`, a job-level reusable-workflow `uses:`, and a composite's
 * `runs.steps[].uses` are all collected without naming any of them.
 */
export function usesValues(source) {
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
  walk(parse(source));
  return found;
}

/**
 * Split a `uses:` reference into `{name, ref}`, or null when it names no remote
 * action at all: a `./` local reference or a `docker://` image. A remote
 * reference carrying no usable ref -- no `@`, a trailing `@`, or a leading `@` --
 * gets a null `ref` and its `name` is the reference as written, so rule C can
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
 * The remote action references one YAML source carries, as `{file, name, ref}`
 * triples. A null `ref` is a reference naming no version; local and docker
 * references do not appear at all.
 */
export function fileReferences(file, source) {
  return usesValues(source).flatMap((uses) => {
    const reference = parseActionReference(uses);
    return reference === null ? [] : [{ file, ...reference }];
  });
}

const isPinned = ({ ref }) => ref !== null;

const byName = (pins) => {
  const groups = new Map();
  for (const pin of pins) {
    const group = groups.get(pin.name);
    if (group) group.push(pin);
    else groups.set(pin.name, [pin]);
  }
  return groups;
};

// "@v7 (a.yaml, b.yaml), @v6 (setup/action.yml)" -- each distinct ref once, with
// every file it came from, so a failure names the files to edit.
function describeRefs(pins) {
  const files = new Map();
  for (const { ref, file } of pins) {
    const seen = files.get(ref);
    if (seen) seen.add(file);
    else files.set(ref, new Set([file]));
  }
  return [...files]
    .map(([ref, from]) => `@${ref} (${[...from].join(", ")})`)
    .join(", ");
}

/**
 * Every way the two trees' references can be out of step, as message strings.
 * Empty means every reference names a ref and each composite pin mirrors a
 * workflow pin exactly.
 */
export function pinViolations(workflowReferences, actionReferences) {
  const violations = [...workflowReferences, ...actionReferences]
    .filter((reference) => !isPinned(reference))
    .map(
      ({ file, name }) =>
        `${name} in ${file} names no ref -- an unpinned remote reference fixes no version, so nothing here determines which code the step runs and no release or advisory has an occurrence to surface on. Write it as owner/action@ref.`,
    );
  const workflowsByName = byName(workflowReferences.filter(isPinned));

  for (const [name, composite] of byName(actionReferences.filter(isPinned))) {
    const workflow = workflowsByName.get(name);
    if (!workflow) {
      violations.push(
        `${name} is pinned only under ${ACTION_DIR}: ${describeRefs(composite)} -- no workflow under ${WORKFLOW_DIR} uses it, and the github-actions Dependabot block is configured against ${WORKFLOW_DIR}, so this pin has no occurrence there for a release or advisory to surface on. Mirror it into a workflow that legitimately uses the action, or extend Dependabot coverage to ${ACTION_DIR} deliberately.`,
      );
      continue;
    }
    const both = [...workflow, ...composite];
    if (new Set(both.map((pin) => pin.ref)).size === 1) continue;
    violations.push(
      `${name} is pinned at differing refs across ${WORKFLOW_DIR} and ${ACTION_DIR}: ${describeRefs(both)} -- a composite pin is tracked only through the workflow pin it mirrors, so bump every occurrence to one ref.`,
    );
  }

  return violations;
}

function yamlFiles(root, dir, matches) {
  const files = [];
  const walk = (relative) => {
    const absolute = resolve(root, relative);
    if (!existsSync(absolute)) return;
    const entries = readdirSync(absolute, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (matches(entry.name)) files.push(path);
    }
  };
  walk(dir);
  return files;
}

function readReferences(root, dir, matches) {
  return yamlFiles(root, dir, matches).flatMap((file) => {
    const source = readFileSync(resolve(root, file), "utf8");
    try {
      return fileReferences(file, source);
    } catch (cause) {
      throw new Error(`${file}: could not be parsed as YAML`, { cause });
    }
  });
}

/**
 * The remote action references both guarded trees carry under `root`, with
 * repo-relative file paths. Workflows are every `.yml`/`.yaml`; composites are
 * every `action.yml`/`action.yaml`, the only two names GitHub loads an action
 * definition from.
 */
export function treeReferences(root) {
  return {
    workflowReferences: readReferences(root, WORKFLOW_DIR, (name) =>
      WORKFLOW_FILE.test(name),
    ),
    actionReferences: readReferences(root, ACTION_DIR, (name) =>
      ACTION_FILE.test(name),
    ),
  };
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions without the process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { workflowReferences, actionReferences } = treeReferences(root);
  if (workflowReferences.length === 0) {
    console.error(
      `${WORKFLOW_DIR}: no action references matched in any workflow -- the extraction rotted; fix scripts/check-action-pin-drift.mjs`,
    );
    process.exit(1);
  }
  const violations = pinViolations(workflowReferences, actionReferences);
  if (violations.length > 0) {
    for (const violation of violations) console.error(violation);
    process.exit(1);
  }
  const plural = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;
  console.log(
    `Action pin drift check passed: ${plural(actionReferences.length, "pin")} under ${ACTION_DIR} checked against ${plural(workflowReferences.length, "pin")} under ${WORKFLOW_DIR}.`,
  );
}
